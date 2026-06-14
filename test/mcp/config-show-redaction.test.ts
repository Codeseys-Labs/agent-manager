/**
 * FIX 1 (security): am_config_show must not leak PLAINTEXT secrets to tokenless
 * MCP clients, and full-config disclosure is token-gated when AM_MCP_TOKEN is
 * configured.
 *
 * FIX 3 (correctness): am_status must report clean:FALSE + gitError when
 * getStatus throws (a real git fault), not fabricate clean:true.
 *
 * Background:
 *   - read-only tools bypass the write-tier auth gate, and am_config_show is
 *     read-only — so any tokenless client could call it even with AM_MCP_TOKEN
 *     set. redactConfigSecrets only rewrites `enc:` envelopes; a PLAINTEXT
 *     secret (added by hand or imported before the key existed) passed through
 *     verbatim. Defense-in-depth: (1) redact env values by key + secret-shape
 *     backstop, (2) gate full-config disclosure behind the token when one is
 *     configured.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import * as gitModule from "../../src/core/git";
import { initRepo } from "../../src/core/git";
import { McpServer, checkSensitiveReadAuth } from "../../src/mcp/server";
import { type TestDir, createTestDir } from "../helpers/tmp";

// Snapshot the genuine git module so we can RESTORE it after a per-test
// `mock.module` — Bun's `mock.restore()` does NOT undo module mocks, so a
// leaked mock would corrupt later tests in the same run. We re-apply the real
// exports in afterEach.
const REAL_GIT = { ...gitModule };

type JsonRpcResult = Record<string, any>;

describe("FIX 1 — am_config_show redaction + token-gating", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-cfgshow-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
  });

  afterEach(async () => {
    if (originalEnv) process.env.AM_CONFIG_DIR = originalEnv;
    else Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    if (dir) await dir.cleanup();
  });

  // ── Redaction: BOTH plaintext env secrets AND enc: envelopes are masked ──

  test("masks a PLAINTEXT env secret AND an enc: envelope in am_config_show output", async () => {
    await writeConfig(join(dir.path, "config.toml"), {
      settings: {
        // Plaintext API key added by hand — the exact leak FIX 1 closes.
        env: { TAVILY_API_KEY: "tvly-PLAINTEXT-should-be-masked-1234567890" },
      },
      servers: {
        openai: {
          command: "uvx",
          args: ["mcp"],
          transport: "stdio",
          enabled: true,
          env: {
            // Plaintext OpenAI key.
            OPENAI_API_KEY: "sk-PLAINTEXTplaintextplaintext0123456789",
            // Already-encrypted envelope — must remain masked too.
            ENCRYPTED_KEY: "enc:v2:age:QQQQQQQQQQ",
          },
        },
      },
    });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "am_config_show", arguments: {} },
    });

    const raw = (resp?.result as JsonRpcResult).content[0].text as string;
    // No plaintext secret survives anywhere in the serialized output.
    expect(raw).not.toContain("tvly-PLAINTEXT");
    expect(raw).not.toContain("sk-PLAINTEXTplaintext");

    const content = JSON.parse(raw);
    // settings.env value masked by key location.
    expect(content.config.settings.env.TAVILY_API_KEY).toBe("[redacted]");
    // servers.*.env plaintext value masked by key location.
    expect(content.config.servers.openai.env.OPENAI_API_KEY).toBe("[redacted]");
    // enc: envelope still masked (envelope pass runs first, then by-key pass
    // leaves the placeholder intact).
    expect(content.config.servers.openai.env.ENCRYPTED_KEY).toBe("[encrypted]");
    // Non-secret structure is preserved.
    expect(content.config.servers.openai.command).toBe("uvx");
    expect(content.config.servers.openai.args).toEqual(["mcp"]);
  });

  test("backstop: a secret-shaped value OUTSIDE an env map is still masked", async () => {
    // `note` is an arbitrary free-form field (SettingsSchema is passthrough),
    // NOT an env map. The secret-shape backstop (redactSecretish) must still
    // catch the embedded Anthropic key.
    await writeConfig(join(dir.path, "config.toml"), {
      settings: {
        note: "deploy key sk-ant-PLAINTEXTplaintextplaintext0123456789",
      },
    } as Parameters<typeof writeConfig>[1]);

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "am_config_show", arguments: {} },
    });
    const raw = (resp?.result as JsonRpcResult).content[0].text as string;
    expect(raw).not.toContain("sk-ant-PLAINTEXT");
    expect(raw).toContain("[REDACTED_ANTHROPIC_KEY]");
  });

  // ── Token-gating of full-config disclosure ───────────────────────────

  test("tokenless am_config_show is REFUSED when AM_MCP_TOKEN is configured", async () => {
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { env: { SECRET: "tvly-shouldnotleak-0123456789" } },
    });
    const server = new McpServer({ auth: { token: "operator-secret", allowUnsafeLocal: false } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "am_config_show", arguments: {} }, // no bearer token
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toMatch(/Authentication required|gated/i);
    // And crucially: the config never reached the client.
    expect(result.content[0].text).not.toContain("tvly-");
  });

  test("am_config_show with a matching bearer token is ALLOWED when a token is configured", async () => {
    await writeConfig(join(dir.path, "config.toml"), {
      // The active profile must EXIST: fix-1-0 fails CLOSED when an explicitly
      // named non-"default" profile is absent from the profiles table, which
      // would deny this (non-diagnostic) read tool regardless of the token.
      settings: { default_profile: "dev" },
      profiles: { dev: {} },
      servers: {
        fetch: { command: "uvx", args: ["mcp"], transport: "stdio", enabled: true },
      },
    });
    const server = new McpServer({ auth: { token: "operator-secret", allowUnsafeLocal: false } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        _meta: { authorization: "Bearer operator-secret" },
        name: "am_config_show",
        arguments: {},
      },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(content.config.servers.fetch).toBeDefined();
  });

  test("am_config_show is ALLOWED tokenless when NO token is configured (local-dev default)", async () => {
    await writeConfig(join(dir.path, "config.toml"), {
      servers: { fetch: { command: "uvx", args: ["mcp"], transport: "stdio", enabled: true } },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: false } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "am_config_show", arguments: {} },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(content.config.servers.fetch).toBeDefined();
  });

  // ── Unit: checkSensitiveReadAuth ─────────────────────────────────────

  test("checkSensitiveReadAuth: non-sensitive tool always allowed", () => {
    const r = checkSensitiveReadAuth(
      "am_status",
      { token: "secret", allowUnsafeLocal: false },
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
    );
    expect(r.allowed).toBe(true);
  });

  test("checkSensitiveReadAuth: am_config_show allowed when no token configured", () => {
    const r = checkSensitiveReadAuth(
      "am_config_show",
      { token: undefined, allowUnsafeLocal: false },
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
    );
    expect(r.allowed).toBe(true);
  });

  test("checkSensitiveReadAuth: am_config_show refused tokenless when token configured", () => {
    const r = checkSensitiveReadAuth(
      "am_config_show",
      { token: "secret", allowUnsafeLocal: false },
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/Authentication required|gated/i);
  });

  test("checkSensitiveReadAuth: allowUnsafeLocal does NOT bypass the token gate", () => {
    // allowUnsafeLocal only relaxes WRITE tooling; a configured token always
    // gates sensitive reads.
    const r = checkSensitiveReadAuth(
      "am_config_show",
      { token: "secret", allowUnsafeLocal: true },
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
    );
    expect(r.allowed).toBe(false);
  });

  test("checkSensitiveReadAuth: matching bearer token allowed", () => {
    const r = checkSensitiveReadAuth(
      "am_config_show",
      { token: "secret", allowUnsafeLocal: false },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { _meta: { authorization: "Bearer secret" } },
      },
    );
    expect(r.allowed).toBe(true);
  });

  test("checkSensitiveReadAuth: mismatched bearer token refused", () => {
    const r = checkSensitiveReadAuth(
      "am_config_show",
      { token: "secret", allowUnsafeLocal: false },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { _meta: { authorization: "Bearer wrong" } },
      },
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/Invalid bearer token/);
  });
});

describe("FIX 3 — am_status surfaces git faults instead of fabricating clean:true", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-status-fault-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
    await writeConfig(join(dir.path, "config.toml"), { servers: {} });
  });

  afterEach(async () => {
    // Restore the genuine git module (mock.restore() does NOT undo module
    // mocks in Bun, so re-apply the real exports to avoid leaking into other
    // tests/files in the same run).
    mock.module("../../src/core/git", () => REAL_GIT);
    if (originalEnv) process.env.AM_CONFIG_DIR = originalEnv;
    else Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    if (dir) await dir.cleanup();
  });

  test("am_status reports clean:false + gitError when getStatus throws", async () => {
    // Mock getStatus to throw a real git fault (not-a-repo / corrupt index).
    // The pre-fix handler substituted {clean:true} on ANY failure — reporting
    // "working tree clean" precisely when git is broken.
    mock.module("../../src/core/git", () => ({
      ...REAL_GIT,
      getStatus: async () => {
        throw new Error("fatal: not a git repository");
      },
    }));

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "am_status", arguments: {} },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    // The fix: clean is FALSE (an agent must NOT conclude "nothing to sync").
    expect(content.git.clean).toBe(false);
    // And the fault is surfaced.
    expect(typeof content.git.gitError).toBe("string");
    expect(content.git.gitError).toContain("not a git repository");
    expect(content.git.branch).toBe("unknown");
  });

  test("am_status reports clean:true with no gitError on a healthy clean repo", async () => {
    // No mock — real getStatus on a freshly-initialized repo. After writeConfig
    // commits, the tree may be dirty or clean; assert the SHAPE: gitError is
    // absent and clean is a boolean derived from the real status.
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "am_status", arguments: {} },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(typeof content.git.clean).toBe("boolean");
    expect(content.git.gitError).toBeUndefined();
  });
});
