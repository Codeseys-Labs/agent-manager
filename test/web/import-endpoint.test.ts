/**
 * Coverage: POST /api/import/:adapter (src/web/server.ts).
 *
 * This endpoint was previously untested. It:
 *   1. resolves an adapter via `getAdapter(name)` (404 if unknown),
 *   2. calls `adapter.import({})`,
 *   3. inside `withConfig`, copies each imported server into config.servers,
 *   4. scans every imported server for inline secrets and, for each hit,
 *      substitutes `${VAR}` into the server env + stores an `enc:` envelope in
 *      `config.settings.env[VAR]` (lazily generating the master key if absent),
 *   5. commits with `import from <adapter>` ONLY when at least one server was
 *      imported (`changed: serverNames.length > 0`) — a zero-server import is
 *      the `changed:false` no-commit path.
 *
 * We drive the endpoint with a STUB adapter installed via `mock.module` on the
 * adapter registry. Per the Bun caveat (`mock.restore()` does NOT undo
 * `mock.module()`), we snapshot the real registry in beforeAll and re-install
 * it after each test so the stub never leaks into later test files.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";

let tmpDir: string;
let keyPath: string;
let authToken: string;
const originalConfigDir = process.env.AM_CONFIG_DIR;
const originalKeyPath = process.env.AM_KEY_PATH;
const originalEncKey = process.env.AM_ENCRYPTION_KEY;
const originalBackend = process.env.AM_SECRETS_BACKEND;

// Snapshot the genuine registry module up front. Bun's `mock.restore()` does
// NOT undo `mock.module()`, so we explicitly re-install the real exports after
// each test (and in afterAll) or the stubbed `getAdapter` leaks into every
// later-loaded test file in the same process.
let REAL_REGISTRY: Record<string, unknown> | undefined;

/** Build a stub adapter whose import() returns a fixed ImportResult-ish shape. */
function makeStubAdapter(name: string, importResult: unknown) {
  return {
    meta: { name, displayName: name, version: "0.0.0", capabilities: ["mcp"] },
    detect: () => ({ installed: true, paths: {} }),
    import: async () => importResult,
    export: () => ({ files: [], warnings: [] }),
    diff: () => ({ status: "in-sync", changes: [] }),
  };
}

/** Read the current HEAD commit count via the real git module. */
async function commitCount(dir: string): Promise<number> {
  const git = await import("../../src/core/git");
  const log = await git.log(dir);
  return log.length;
}

/** Read + parse the on-disk config.toml. */
async function readConfigToml(): Promise<TOML.JsonMap> {
  const raw = await readFile(join(tmpDir, "config.toml"), "utf-8");
  return TOML.parse(raw);
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "am-web-import-"));
  keyPath = join(tmpDir, "key-data", "key");
  REAL_REGISTRY = { ...(await import("../../src/adapters/registry")) };

  const { initRepo } = await import("../../src/core/git");
  await initRepo(tmpDir);

  await writeFile(
    join(tmpDir, "config.toml"),
    TOML.stringify({
      settings: { default_profile: "default" },
      servers: {},
      profiles: { default: { description: "Default profile" } },
    } as TOML.JsonMap),
  );

  process.env.AM_CONFIG_DIR = tmpDir;
  // Redirect the master key to a temp path and ensure no env-key short-circuit,
  // so the lazy file-generation branch is exercised and the real OS key dir is
  // never touched.
  process.env.AM_KEY_PATH = keyPath;
  Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");
  Reflect.deleteProperty(process.env, "AM_SECRETS_BACKEND");

  const { ensureAuthToken } = await import("../../src/web/server");
  authToken = ensureAuthToken(tmpDir);
});

afterEach(() => {
  mock.restore();
  // `mock.restore()` does NOT undo `mock.module()`; re-install the real
  // registry so the stubbed getAdapter does not leak to later test files.
  if (REAL_REGISTRY) mock.module("../../src/adapters/registry", () => REAL_REGISTRY);
});

afterAll(async () => {
  if (REAL_REGISTRY) mock.module("../../src/adapters/registry", () => REAL_REGISTRY);
  if (originalConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
  else process.env.AM_CONFIG_DIR = originalConfigDir;
  if (originalKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
  else process.env.AM_KEY_PATH = originalKeyPath;
  if (originalEncKey === undefined) Reflect.deleteProperty(process.env, "AM_ENCRYPTION_KEY");
  else process.env.AM_ENCRYPTION_KEY = originalEncKey;
  if (originalBackend === undefined) Reflect.deleteProperty(process.env, "AM_SECRETS_BACKEND");
  else process.env.AM_SECRETS_BACKEND = originalBackend;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("POST /api/import/:adapter", () => {
  it("returns 404 for an unknown adapter", async () => {
    const realRegistry = await import("../../src/adapters/registry");
    mock.module("../../src/adapters/registry", () => ({
      ...realRegistry,
      getAdapter: async () => undefined,
    }));
    const { createApp } = await import("../../src/web/server");
    const app = await createApp();

    const res = await app.request("/api/import/does-not-exist", {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("not found");
  });

  it("imports servers into config and produces a commit", async () => {
    const before = await commitCount(tmpDir);

    const realRegistry = await import("../../src/adapters/registry");
    mock.module("../../src/adapters/registry", () => ({
      ...realRegistry,
      // The handler iterates `Object.entries(imported.servers)` and reads
      // `srv.command` etc., so we hand it an object keyed by server name.
      getAdapter: async (name: string) =>
        makeStubAdapter(name, {
          servers: {
            "import-fetch": {
              command: "uvx",
              args: ["mcp-server-fetch"],
              env: {},
              transport: "stdio",
              description: "Imported fetch",
              tags: ["web"],
              enabled: true,
            },
          },
          instructions: [],
          skills: [],
          warnings: [],
        }),
    }));
    const { createApp } = await import("../../src/web/server");
    const app = await createApp();

    const res = await app.request("/api/import/claude-code", {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { action: string; adapter: string; servers: string[] };
    expect(data.action).toBe("import");
    expect(data.adapter).toBe("claude-code");
    expect(data.servers).toContain("import-fetch");

    // Landed in config.toml.
    const cfg = (await readConfigToml()) as {
      servers?: Record<string, { command?: string }>;
    };
    expect(cfg.servers?.["import-fetch"]).toBeDefined();
    expect(cfg.servers?.["import-fetch"].command).toBe("uvx");

    // A commit was produced (changed:true path).
    const after = await commitCount(tmpDir);
    expect(after).toBe(before + 1);

    // Cleanup so subsequent tests start from a known server set.
    const { withConfig } = await import("../../src/core/controller");
    await withConfig(tmpDir, async (config) => {
      if (config?.servers) {
        const { "import-fetch": _removed, ...rest } = config.servers;
        config.servers = rest;
      }
      return { result: undefined, commitMessage: "test cleanup", changed: true };
    });
  });

  it("does NOT commit on a zero-server import (changed:false path)", async () => {
    const before = await commitCount(tmpDir);

    const realRegistry = await import("../../src/adapters/registry");
    mock.module("../../src/adapters/registry", () => ({
      ...realRegistry,
      // Empty servers map → serverNames.length === 0 → changed:false → no commit.
      getAdapter: async (name: string) =>
        makeStubAdapter(name, { servers: {}, instructions: [], skills: [], warnings: [] }),
    }));
    const { createApp } = await import("../../src/web/server");
    const app = await createApp();

    const res = await app.request("/api/import/claude-code", {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { action: string; servers: string[] };
    expect(data.action).toBe("import");
    expect(data.servers).toEqual([]);

    // No commit was produced.
    const after = await commitCount(tmpDir);
    expect(after).toBe(before);
  });

  it("scans + encrypts an inline secret in an imported server", async () => {
    // No key should exist yet — the import path must lazily generate one.
    const keyExistedBefore = await readFile(keyPath, "utf-8").then(
      () => true,
      () => false,
    );
    expect(keyExistedBefore).toBe(false);

    const secretValue = "sk-proj-ABCDEF0123456789abcdef0123456789RealisticLooking";

    const realRegistry = await import("../../src/adapters/registry");
    mock.module("../../src/adapters/registry", () => ({
      ...realRegistry,
      getAdapter: async (name: string) =>
        makeStubAdapter(name, {
          servers: {
            "secret-srv": {
              command: "node",
              args: ["server.js"],
              // OPENAI_API_KEY matches the tier-1 key-name patterns
              // (/openai/i and /api[_-]?key/i), so detection is deterministic
              // regardless of whether betterleaks (tier 2) is installed.
              env: { OPENAI_API_KEY: secretValue },
              transport: "stdio",
              enabled: true,
            },
          },
          instructions: [],
          skills: [],
          warnings: [],
        }),
    }));
    const { createApp } = await import("../../src/web/server");
    const app = await createApp();

    const res = await app.request("/api/import/claude-code", {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);

    const cfg = (await readConfigToml()) as {
      settings?: { env?: Record<string, string> };
      servers?: Record<string, { env?: Record<string, string> }>;
    };

    // The server env value was replaced by the ${VAR} reference — the suggested
    // env var name for a key-name hit is the original key name (OPENAI_API_KEY).
    expect(cfg.servers?.["secret-srv"]?.env?.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");

    // The plaintext secret was moved into settings.env as an `enc:` envelope.
    const stored = cfg.settings?.env?.OPENAI_API_KEY ?? "";
    expect(stored.startsWith("enc:")).toBe(true);
    expect(stored).not.toContain(secretValue);

    // The full serialized config contains no plaintext secret anywhere.
    expect(JSON.stringify(cfg)).not.toContain(secretValue);

    // The master key was lazily generated at AM_KEY_PATH.
    const keyExistsAfter = await readFile(keyPath, "utf-8").then(
      () => true,
      () => false,
    );
    expect(keyExistsAfter).toBe(true);

    // Round-trip: the stored envelope decrypts back to the original plaintext.
    const { loadKey, decryptValue } = await import("../../src/core/secrets");
    const key = await loadKey(tmpDir);
    expect(key).not.toBeNull();
    if (key) {
      const decrypted = await decryptValue(stored, key);
      expect(decrypted).toBe(secretValue);
    }
  });
});
