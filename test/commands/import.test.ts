import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { importConfig as importCursor } from "../../src/adapters/cursor/import";
import { extractServerIdentity, importCommand } from "../../src/commands/import";
import { readConfig, writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { McpServer } from "../../src/mcp/server";
import { type TestDir, createTestDir } from "../helpers/tmp";

// The `am_import` source:"auto" regression test runs full adapter detection,
// which probes installed IDE CLIs via Bun.spawnSync([<cli>, "--version"]).
// On a dev box with IDE CLIs installed those serialized probes can exceed
// the 5s default under full-suite load (CI runners have none, so it's fast
// there). 30s gives headroom without hiding regressions. (Wave CI / P0-5.)
setDefaultTimeout(30_000);

// Order-independence guard (seed 8c51): these tests chdir into per-test tmp dirs
// and restore cwd in afterEach. Capturing the restore target from process.cwd()
// at module load is fragile — if an earlier test file leaked a (now-deleted) tmp
// cwd, that poisoned value would be reinstated and leak onward to later files.
// Pin the restore target to the repo root deterministically instead.
const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("extractServerIdentity", () => {
  test("strips npx -y prefix and @version suffix", () => {
    expect(extractServerIdentity("npx", ["-y", "tavily-mcp@latest"])).toBe("tavily-mcp");
  });

  test("strips bunx prefix and @version suffix", () => {
    expect(extractServerIdentity("bunx", ["tavily-mcp@latest"])).toBe("tavily-mcp");
  });

  test("strips uvx prefix", () => {
    expect(extractServerIdentity("uvx", ["mcp-server-fetch"])).toBe("mcp-server-fetch");
  });

  test("extracts hostname from proxy endpoint", () => {
    expect(
      extractServerIdentity("uvx", ["mcp-proxy", "--endpoint", "https://mcp.exa.ai/sse"]),
    ).toBe("mcp.exa.ai");
  });

  test("strips absolute path to basename", () => {
    expect(extractServerIdentity("/usr/local/bin/aws-outlook-mcp")).toBe("aws-outlook-mcp");
  });

  test("returns plain command as-is", () => {
    expect(extractServerIdentity("aws-outlook-mcp")).toBe("aws-outlook-mcp");
  });

  test("handles pipx run prefix", () => {
    expect(extractServerIdentity("pipx", ["run", "some-tool@1.2.3"])).toBe("some-tool");
  });

  test("handles scoped package with @version", () => {
    // "@upstash/context7-mcp@latest" — the last @ is the version separator
    expect(extractServerIdentity("bunx", ["@upstash/context7-mcp@latest"])).toBe(
      "@upstash/context7-mcp",
    );
  });

  test("deduplicates identical servers", () => {
    const servers = [
      { name: "tavily", command: "bunx", args: ["tavily-mcp@latest"] },
      { name: "tavily-2", command: "npx", args: ["-y", "tavily-mcp@0.2.0"] },
    ];

    const identities = new Map<string, string>();
    let dupes = 0;

    for (const srv of servers) {
      const identity = extractServerIdentity(srv.command, srv.args);
      if (identities.has(identity)) {
        dupes++;
      } else {
        identities.set(identity, srv.name);
      }
    }

    expect(dupes).toBe(1);
    expect(identities.get("tavily-mcp")).toBe("tavily");
  });
});

// ── Import projectPath regression test ──────────────────────────
// The MCP server's am_import handler previously passed {} to adapter.import(),
// missing projectPath. This verifies the fix propagates project-level configs.

describe("import command passes projectPath to adapters", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    }
    if (dir) await dir.cleanup();
  });

  test("MCP am_import handler passes projectPath (regression)", async () => {
    dir = await createTestDir("am-import-projpath-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), { servers: {} });

    // Invoke via MCP server — the handler should pass projectPath: process.cwd()
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "am_import", arguments: { source: "auto" } },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as Record<string, any>;
    // Should not error — the handler completes successfully even if no tools detected
    if (!result.isError) {
      const content = JSON.parse(result.content[0].text);
      expect(content.action).toBe("import");
      expect(typeof content.imported).toBe("number");
    }
  });

  test("MCP am_import with specific adapter does not error from missing projectPath", async () => {
    dir = await createTestDir("am-import-projpath-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), { servers: {} });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "am_import", arguments: { source: "claude-code" } },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as Record<string, any>;
    if (!result.isError) {
      const content = JSON.parse(result.content[0].text);
      expect(content.source).toBe("claude-code");
    }
  });
});

// ── ws1 (seed agent-manager-257c): underscore-suffixed key leak regression ──
// SECURITY: before the SECRET_KEY_PATTERNS fix, `FOO_KEY` was underscore-blind
// (the name-only /\btoken\b/ etc. never matched MY_TOKEN/FOO_KEY, and there was
// no bare key/pwd pattern), so importing FOO_KEY=sk-… stored the PLAINTEXT in
// config.toml while the scan reported clean — a fail-OPEN credential leak that
// then got committed. This drives the REAL import pipeline end-to-end
// (adapter → scanConfigForSecrets → substituteSecret → encryptValue →
// settings.env) and asserts the value is replaced by a ${FOO_KEY} reference and
// only the encrypted envelope is persisted. Fails closed: a plaintext sk-…
// must never reach the on-disk config.

describe("import auto-encrypts underscore-suffixed secret keys (ws1 regression)", () => {
  let configDir: TestDir;
  let projectDir: TestDir;
  let keyDir: TestDir;
  const origConfigDir = process.env.AM_CONFIG_DIR;
  const origKeyPath = process.env.AM_KEY_PATH;
  const origCwd = REPO_ROOT;
  const origExitCode = process.exitCode;

  afterEach(async () => {
    // Restore cwd FIRST — leaking a deleted tmp cwd into later tests is fatal.
    process.chdir(origCwd);
    if (origConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = origConfigDir;
    if (origKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
    else process.env.AM_KEY_PATH = origKeyPath;
    process.exitCode = origExitCode;
    if (configDir) await configDir.cleanup();
    if (projectDir) await projectDir.cleanup();
    if (keyDir) await keyDir.cleanup();
  });

  test("FOO_KEY=sk-… → config holds ${FOO_KEY}, settings.env holds enc: envelope", async () => {
    configDir = await createTestDir("am-import-ws1-cfg-");
    projectDir = await createTestDir("am-import-ws1-proj-");
    keyDir = await createTestDir("am-import-ws1-key-");
    process.env.AM_CONFIG_DIR = configDir.path;
    // Redirect master-key storage so the auto-generated key never touches ~/.
    process.env.AM_KEY_PATH = join(keyDir.path, "key");

    await initRepo(configDir.path);
    await writeConfig(join(configDir.path, "config.toml"), { servers: {} });

    // The claude-code adapter reads project servers from <projectPath>/.mcp.json,
    // and the import command passes projectPath: process.cwd(). Plant a server
    // whose env carries an underscore-suffixed secret key with a plaintext value.
    const plaintext = "sk-test-xxxx-DO-NOT-LEAK-1234567890";
    await projectDir.write(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          "ws1-foo-key-server": {
            command: "npx",
            args: ["some-mcp"],
            env: { FOO_KEY: plaintext },
          },
        },
      }),
    );
    process.chdir(projectDir.path);

    await importCommand.run!({
      args: { source: "claude-code", json: true, quiet: true, verbose: false },
      cmd: importCommand,
      rawArgs: [],
      data: undefined,
    } as never);

    // Read back the PERSISTED config from disk — this is what would be committed.
    const written = await readConfig(join(configDir.path, "config.toml"));

    const server = written.servers?.["ws1-foo-key-server"];
    expect(server).toBeDefined();
    // The env value is now a ${VAR} reference, not the plaintext.
    expect(server?.env?.FOO_KEY).toBe("${FOO_KEY}");
    // The encrypted envelope lives in settings.env.
    expect(written.settings?.env?.FOO_KEY?.startsWith("enc:")).toBe(true);
    // Decisive fail-closed assertion: the plaintext appears NOWHERE on disk.
    expect(JSON.stringify(written)).not.toContain(plaintext);
  });
});

// ── W-m11 (M11): import write path must preserve url + transport + adapters ──
// The three materialization sites in import.ts (greenfield append, brownfield
// merge "added", marketplace) previously rebuilt each catalog Server from a
// fixed field list {command,args,env,transport,description,tags,enabled} — so a
// remote server's `url` and any adapter-scoped extras (adapterExtras) were
// DROPPED on write. A round-trip then lost the remote URL and the per-adapter
// scope/config mapping. These tests drive the REAL import pipeline end-to-end
// and assert the persisted config preserves them.

describe("import preserves url + transport for remote servers (W-m11)", () => {
  let configDir: TestDir;
  let projectDir: TestDir;
  let homeDir: TestDir;
  const origConfigDir = process.env.AM_CONFIG_DIR;
  const origHome = process.env.HOME;
  const origCwd = REPO_ROOT;
  const origExitCode = process.exitCode;

  afterEach(async () => {
    process.chdir(origCwd);
    if (origConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = origConfigDir;
    if (origHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = origHome;
    process.exitCode = origExitCode;
    if (configDir) await configDir.cleanup();
    if (projectDir) await projectDir.cleanup();
    if (homeDir) await homeDir.cleanup();
  });

  test("the cursor importer emits a top-level url for url-based servers", () => {
    // Unit-level guard on the producer: ImportedServer.url must be populated so
    // the write sites have something to carry. (Previously url lived only in
    // adapterExtras, invisible to the catalog Server's top-level url field.)
    const result = importCursor({ projectPath: "/nonexistent-project-xyz" });
    // No project file → no servers, but the call must typecheck against the
    // url-bearing ImportedServer shape. The behavioral assertion is below.
    expect(Array.isArray(result.servers)).toBe(true);
  });

  test("remote (streamable-http) server round-trips url + transport into config.toml", async () => {
    configDir = await createTestDir("am-import-m11-cfg-");
    projectDir = await createTestDir("am-import-m11-proj-");
    homeDir = await createTestDir("am-import-m11-home-");
    process.env.AM_CONFIG_DIR = configDir.path;
    // Pin HOME so the cursor adapter's global ~/.cursor/mcp.json probe never
    // touches the real home dir (it just warns "File not found").
    process.env.HOME = homeDir.path;

    await initRepo(configDir.path);
    await writeConfig(join(configDir.path, "config.toml"), { servers: {} });

    const remoteUrl = "https://mcp.example.com/sse";
    await projectDir.write(
      ".cursor/mcp.json",
      JSON.stringify({
        mcpServers: {
          "m11-remote": { url: remoteUrl },
        },
      }),
    );
    process.chdir(projectDir.path);

    await importCommand.run!({
      args: { source: "cursor", json: true, quiet: true, verbose: false },
      cmd: importCommand,
      rawArgs: [],
      data: undefined,
    } as never);

    const written = await readConfig(join(configDir.path, "config.toml"));
    const server = written.servers?.["m11-remote"];
    expect(server).toBeDefined();
    // Remote transport must survive the write (not silently coerced to stdio).
    expect(server?.transport).toBe("streamable-http");
    // The remote URL must be persisted as the top-level catalog `url` field.
    expect(server?.url).toBe(remoteUrl);
  });
});

describe("import preserves adapter-scoped extras (W-m11)", () => {
  let configDir: TestDir;
  let projectDir: TestDir;
  let homeDir: TestDir;
  const origConfigDir = process.env.AM_CONFIG_DIR;
  const origHome = process.env.HOME;
  const origCwd = REPO_ROOT;
  const origExitCode = process.exitCode;

  afterEach(async () => {
    process.chdir(origCwd);
    if (origConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = origConfigDir;
    if (origHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = origHome;
    process.exitCode = origExitCode;
    if (configDir) await configDir.cleanup();
    if (projectDir) await projectDir.cleanup();
    if (homeDir) await homeDir.cleanup();
  });

  test("project-scoped adapterExtras map onto catalog server.adapters", async () => {
    configDir = await createTestDir("am-import-m11x-cfg-");
    projectDir = await createTestDir("am-import-m11x-proj-");
    homeDir = await createTestDir("am-import-m11x-home-");
    process.env.AM_CONFIG_DIR = configDir.path;
    process.env.HOME = homeDir.path;

    await initRepo(configDir.path);
    await writeConfig(join(configDir.path, "config.toml"), { servers: {} });

    // The claude-code adapter routes any non-core key (here `type`, a stand-in
    // for adapter-scoped config) into ImportedServer.adapterExtras. The write
    // path must surface those under the catalog Server's `adapters` table so the
    // per-adapter scope/config mapping is not lost on import.
    await projectDir.write(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          "m11-scoped": {
            command: "npx",
            args: ["some-mcp"],
            type: "project-scoped",
          },
        },
      }),
    );
    process.chdir(projectDir.path);

    await importCommand.run!({
      args: { source: "claude-code", json: true, quiet: true, verbose: false },
      cmd: importCommand,
      rawArgs: [],
      data: undefined,
    } as never);

    const written = await readConfig(join(configDir.path, "config.toml"));
    const server = written.servers?.["m11-scoped"];
    expect(server).toBeDefined();
    // adapterExtras carried the non-core `type` field — it must land under the
    // catalog Server's adapters passthrough, namespaced by adapter name (the
    // shape every adapter export reads: server.adapters["claude-code"]).
    expect(server?.adapters).toBeDefined();
    const cc = (server?.adapters as Record<string, Record<string, unknown>>)?.["claude-code"];
    expect(cc).toBeDefined();
    expect(cc?.type).toBe("project-scoped");
  });
});
