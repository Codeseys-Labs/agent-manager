import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import type { ServerListResponse, ServerResponse } from "../../src/registry/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const origLog = console.log;
const origError = console.error;
const origFetch = globalThis.fetch;

// Build a v0 ServerResponse. `am install <short-name>` resolves through the
// search route, so a list envelope wrapping this is the fetch body.
function makeServer(overrides: Partial<ServerResponse["server"]> = {}): ServerResponse {
  return {
    server: {
      name: "io.github.tester/test-mcp",
      description: "A test MCP server",
      version: "1.0.0",
      packages: [
        {
          registryType: "npm",
          identifier: "test-mcp",
          version: "1.0.0",
          transport: { type: "stdio" },
        },
      ],
      ...overrides,
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        publishedAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-06-01T00:00:00Z",
        isLatest: true,
      },
    },
  };
}

function makeList(server: ServerResponse): ServerListResponse {
  return { servers: [server], metadata: { count: 1 } };
}

function mockFetchResponse(data: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("am install", () => {
  let dir: TestDir;
  let origConfigDir: string | undefined;

  beforeEach(async () => {
    consoleOutput = [];
    consoleErrors = [];
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    process.exitCode = undefined;
    origConfigDir = process.env.AM_CONFIG_DIR;
  });

  afterEach(async () => {
    console.log = origLog;
    console.error = origError;
    globalThis.fetch = origFetch;
    process.exitCode = undefined;
    if (origConfigDir !== undefined) {
      process.env.AM_CONFIG_DIR = origConfigDir;
    } else {
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    }
    if (dir) await dir.cleanup();
  });

  test("installs a package: creates server entry with _registry provenance", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = { settings: { default_profile: "default" }, servers: {} };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    const server = makeServer({
      name: "io.github.tavily/tavily-mcp",
      version: "1.2.0",
      packages: [
        {
          registryType: "npm",
          identifier: "tavily-mcp",
          version: "1.2.0",
          transport: { type: "stdio" },
        },
      ],
    });
    mockFetchResponse(makeList(server));

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "tavily-mcp",
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    // Server is keyed by the remapped (reverse-DNS) name from the v0 wire shape.
    const key = "io.github.tavily/tavily-mcp";
    const updated = await readConfig(configPath);
    expect(updated.servers?.[key]).toBeDefined();
    // npm registryType → npx launcher, identifier pinned to version.
    expect(updated.servers?.[key].command).toBe("npx");
    expect(updated.servers?.[key].args).toEqual(["tavily-mcp@1.2.0"]);
    expect(updated.servers?.[key]._registry).toBeDefined();
    expect(updated.servers?.[key]._registry!.package).toBe(key);
    expect(updated.servers?.[key]._registry!.version).toBe("1.2.0");
    expect(updated.servers?.[key]._registry!.source).toBe("mcp-registry");
  });

  // R4-MED2 (carried to v0 remap): a stdio package must never produce a
  // schema-invalid stdio+url server. The remap only sets `url` for non-stdio
  // transports, so a stdio package round-trips through readConfig (the Wave-3
  // ServerSchema superRefine rejects stdio+url).
  test("stdio package persists a schema-valid server with no url", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), { servers: {} });

    const server = makeServer({
      name: "io.github.local/urlonly-mcp",
      packages: [
        {
          registryType: "npm",
          identifier: "urlonly-mcp",
          version: "1.0.0",
          transport: { type: "stdio" },
        },
      ],
    });
    mockFetchResponse(makeList(server));

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "urlonly-mcp",
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    // The config must still PARSE (no stdio+url superRefine rejection).
    const updated = await readConfig(join(configDir, "config.toml"));
    const srv = updated.servers?.["io.github.local/urlonly-mcp"];
    expect(srv).toBeDefined();
    expect(srv?.transport).toBe("stdio");
    // url must NOT have been set on a stdio server.
    expect(srv?.url).toBeUndefined();
  });

  // R4-MED2 positive guard: a remote-only server (remotes[], no packages) STILL
  // gets its url set — the remap must synthesize a schema-valid remote server.
  test("remote-only server (remotes[]) keeps its url and remote transport", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), { servers: {} });

    const server = makeServer({
      name: "io.github.remote/remote-mcp",
      packages: undefined,
      remotes: [{ type: "streamable-http", url: "https://remote.example.com/mcp" }],
    });
    mockFetchResponse(makeList(server));

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "remote-mcp",
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    const srv = updated.servers?.["io.github.remote/remote-mcp"];
    expect(srv).toBeDefined();
    expect(srv?.transport).toBe("streamable-http");
    expect(srv?.url).toBe("https://remote.example.com/mcp");
    // Command synthesized from the url (am stores the url in command for remotes).
    expect(srv?.command).toBe("https://remote.example.com/mcp");
  });

  test("detects existing server and skips without --yes", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        "io.github.tester/test-mcp": {
          command: "npx",
          args: ["test-mcp@0.9.0"],
          transport: "stdio",
          enabled: true,
        },
      },
    };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    mockFetchResponse(makeList(makeServer()));

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "test-mcp",
        "dry-run": false,
        yes: false,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    const jsonOut = consoleOutput.find((l) => l.includes('"action"'));
    expect(jsonOut).toBeDefined();
    const parsed = JSON.parse(jsonOut!);
    expect(parsed.results[0].action).toBe("skipped");
    expect(parsed.results[0].reason).toBe("already exists");
  });

  test("--dry-run doesn't write config", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = { servers: {} };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    mockFetchResponse(makeList(makeServer({ name: "io.github.local/dry-run-pkg" })));

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "dry-run-pkg",
        "dry-run": true,
        yes: true,
        "no-cache": true,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("[dry-run]");

    const updated = await readConfig(configPath);
    expect(updated.servers?.["io.github.local/dry-run-pkg"]).toBeUndefined();
  });

  test("handles registry 404 (package not found)", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = { servers: {} };
    await writeConfig(join(configDir, "config.toml"), config);

    // Return 404 from registry
    globalThis.fetch = (async () =>
      new Response("Not Found", { status: 404 })) as unknown as typeof fetch;

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "nonexistent-pkg",
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toContain("not found");
    // BUG-3 regression: a not-found package must set a non-zero exit code so
    // `am install bogus` fails loudly for callers and CI (was exit 0).
    expect(process.exitCode).toBe(1);
  });

  test("returns the JSON failure result for a not-found package", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    await writeConfig(join(configDir, "config.toml"), { servers: {} });

    // 200 OK but null body — the registry's "package does not exist" shape.
    mockFetchResponse(null);

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "ghost-pkg",
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    expect(process.exitCode).toBe(1);
    const jsonOut = consoleOutput.find((l) => l.includes('"action"'));
    expect(jsonOut).toBeDefined();
    const parsed = JSON.parse(jsonOut!);
    expect(parsed.results[0].action).toBe("failed");
    expect(parsed.results[0].reason).toBe("not found");
  });

  test("a registry fetch error (HTTP 500) sets a non-zero exit code", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    await writeConfig(join(configDir, "config.toml"), { servers: {} });

    // Non-404 error response — getPackage() throws a RegistryError, exercising
    // install's per-package fetch-fail branch (distinct from the 404 path).
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", { status: 500 })) as unknown as typeof fetch;

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "boom-pkg",
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    expect(process.exitCode).toBe(1);
    const jsonOut = consoleOutput.find((l) => l.includes('"action"'));
    expect(jsonOut).toBeDefined();
    const parsed = JSON.parse(jsonOut!);
    expect(parsed.results[0].action).toBe("failed");
  });

  test("sets placeholder env vars for required env in non-interactive mode", async () => {
    dir = await createTestDir("am-install-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);

    const config: Config = { servers: {} };
    const configPath = join(configDir, "config.toml");
    await writeConfig(configPath, config);

    // CRITICAL: the live wire field is `isRequired`. A SECRET, required var must
    // be remapped to required=true so install does NOT silently treat it as
    // optional (the bug this workstream fixes). The optional var with a default
    // is carried through.
    const server = makeServer({
      name: "io.github.acme/env-mcp",
      packages: [
        {
          registryType: "npm",
          identifier: "env-mcp",
          version: "1.0.0",
          transport: { type: "stdio" },
          environmentVariables: [
            { name: "API_KEY", description: "The API key", isRequired: true, isSecret: true },
            { name: "REGION", description: "AWS region", isRequired: false, default: "us-east-1" },
          ],
        },
      ],
    });
    mockFetchResponse(makeList(server));

    const { installCommand } = await import("../../src/commands/install");
    await installCommand.run!({
      args: {
        packages: "env-mcp",
        "dry-run": false,
        yes: true,
        "no-cache": true,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: installCommand as any,
    });

    const updated = await readConfig(configPath);
    const persisted = updated.servers?.["io.github.acme/env-mcp"];
    expect(persisted).toBeDefined();
    // required=true (from isRequired) → non-interactive placeholder is set.
    expect(persisted!.env?.API_KEY).toBe("${API_KEY}");
    // optional with default → default value carried through.
    expect(persisted!.env?.REGION).toBe("us-east-1");
  });
});
