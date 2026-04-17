/**
 * Wave 2.B: write-tier auth gate.
 *
 * Problem: `am mcp-serve` exposes write-tier tools (am_apply, am_add_server,
 * etc.) over stdio with no authentication. Any agent plumbed into the server
 * could exfiltrate decrypted secrets.
 *
 * Model (option a): if AM_MCP_TOKEN is set, write-tier calls must include a
 * matching bearer token. Otherwise, the operator must set
 * AM_MCP_ALLOW_UNSAFE_LOCAL=1 (or pass --allow-unsafe-local) to opt in to
 * legacy behaviour. Read-only tools stay unauthenticated.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import { McpServer, checkWriteAuth, loadAuthConfig } from "../../src/mcp/server";
import { type TestDir, createTestDir } from "../helpers/tmp";

type JsonRpcResult = Record<string, any>;

describe("MCP auth gate", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-mcp-auth-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
    await writeConfig(join(dir.path, "config.toml"), { servers: {} });
  });

  afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      process.env.AM_CONFIG_DIR = undefined;
    }
    if (dir) await dir.cleanup();
  });

  // ── loadAuthConfig ─────────────────────────────────────────

  test("loadAuthConfig defaults to locked down (no token, no unsafe-local)", () => {
    const cfg = loadAuthConfig({});
    expect(cfg.token).toBeUndefined();
    expect(cfg.allowUnsafeLocal).toBe(false);
  });

  test("loadAuthConfig reads AM_MCP_TOKEN", () => {
    const cfg = loadAuthConfig({ AM_MCP_TOKEN: "secret" } as any);
    expect(cfg.token).toBe("secret");
  });

  test("loadAuthConfig trims whitespace from token", () => {
    const cfg = loadAuthConfig({ AM_MCP_TOKEN: "  secret  " } as any);
    expect(cfg.token).toBe("secret");
  });

  test("loadAuthConfig reads AM_MCP_ALLOW_UNSAFE_LOCAL=1", () => {
    const cfg = loadAuthConfig({ AM_MCP_ALLOW_UNSAFE_LOCAL: "1" } as any);
    expect(cfg.allowUnsafeLocal).toBe(true);
  });

  test("loadAuthConfig ignores AM_MCP_ALLOW_UNSAFE_LOCAL != '1'", () => {
    expect(loadAuthConfig({ AM_MCP_ALLOW_UNSAFE_LOCAL: "true" } as any).allowUnsafeLocal).toBe(
      false,
    );
    expect(loadAuthConfig({ AM_MCP_ALLOW_UNSAFE_LOCAL: "0" } as any).allowUnsafeLocal).toBe(false);
  });

  // ── checkWriteAuth (unit) ──────────────────────────────────

  test("checkWriteAuth always permits read-only", () => {
    const r = checkWriteAuth(
      "read-only",
      { token: undefined, allowUnsafeLocal: false },
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
    );
    expect(r.allowed).toBe(true);
  });

  test("checkWriteAuth refuses write-local with no token and no unsafe-local", () => {
    const r = checkWriteAuth(
      "write-local",
      { token: undefined, allowUnsafeLocal: false },
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/AM_MCP_TOKEN|unsafe/i);
  });

  test("checkWriteAuth allows write-local when AM_MCP_ALLOW_UNSAFE_LOCAL is on", () => {
    const r = checkWriteAuth(
      "write-local",
      { token: undefined, allowUnsafeLocal: true },
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
    );
    expect(r.allowed).toBe(true);
  });

  test("checkWriteAuth refuses write-local when token configured but none supplied", () => {
    const r = checkWriteAuth(
      "write-local",
      { token: "secret", allowUnsafeLocal: false },
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/Authentication required/);
  });

  test("checkWriteAuth accepts matching bearer token in _meta.authorization", () => {
    const r = checkWriteAuth(
      "write-local",
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

  test("checkWriteAuth accepts bare token in _meta.token", () => {
    const r = checkWriteAuth(
      "write-local",
      { token: "secret", allowUnsafeLocal: false },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { _meta: { token: "secret" } },
      },
    );
    expect(r.allowed).toBe(true);
  });

  test("checkWriteAuth accepts _am_token in arguments", () => {
    const r = checkWriteAuth(
      "write-local",
      { token: "secret", allowUnsafeLocal: false },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { arguments: { _am_token: "secret" } },
      },
    );
    expect(r.allowed).toBe(true);
  });

  test("checkWriteAuth rejects mismatched token", () => {
    const r = checkWriteAuth(
      "write-local",
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

  // ── End-to-end: McpServer ──────────────────────────────────

  test("write tools refuse call when no token and no unsafe-local", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: false } });

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "am_add_server",
        arguments: { name: "x", command: "y" },
      },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    // Could hit either the write-tier gate message or something equivalent.
    expect(content.error).toMatch(/AM_MCP_TOKEN|unsafe|Authentication required/);
  });

  test("write tools allowed when AM_MCP_ALLOW_UNSAFE_LOCAL=1", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "am_add_server",
        arguments: { name: "x", command: "y" },
      },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    // Must not be an auth error. (Could be another error — we only assert auth didn't fire.)
    if (result.isError) {
      const content = JSON.parse(result.content[0].text);
      expect(content.error).not.toMatch(/AM_MCP_TOKEN|Authentication required|Invalid bearer/);
    }
  });

  test("write tools allowed with matching bearer token", async () => {
    const server = new McpServer({ auth: { token: "letmein", allowUnsafeLocal: false } });

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        _meta: { authorization: "Bearer letmein" },
        name: "am_add_server",
        arguments: { name: "with-token", command: "y" },
      },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    if (result.isError) {
      const content = JSON.parse(result.content[0].text);
      expect(content.error).not.toMatch(/AM_MCP_TOKEN|Authentication required|Invalid bearer/);
    } else {
      const content = JSON.parse(result.content[0].text);
      expect(content.action).toBe("add");
    }
  });

  test("write tools refused with wrong bearer token", async () => {
    const server = new McpServer({ auth: { token: "letmein", allowUnsafeLocal: false } });

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        _meta: { authorization: "Bearer wrong" },
        name: "am_add_server",
        arguments: { name: "x", command: "y" },
      },
    });

    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toMatch(/Invalid bearer token/);
  });

  test("read-only tools work without any auth", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: false } });

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "am_list_servers", arguments: {} },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
  });

  test("tools/list hides write tools when no auth configured", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: false } });
    // Enable all groups in config so tier is the only filter
    server.setSettings({
      mcp_serve: { tools: ["core", "registry", "a2a", "wiki", "session", "acp"] },
    });

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/list",
    });

    const tools = (resp?.result as JsonRpcResult).tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    // Read-only tools appear
    expect(names).toContain("am_list_servers");
    expect(names).toContain("am_status");
    // Write-local tools should be filtered out
    expect(names).not.toContain("am_add_server");
    expect(names).not.toContain("am_remove_server");
    expect(names).not.toContain("am_apply");
    // Write-remote tools should be filtered out
    expect(names).not.toContain("am_sync_push");
  });

  test("tools/list shows write tools when token is configured", async () => {
    const server = new McpServer({ auth: { token: "secret", allowUnsafeLocal: false } });
    server.setSettings({
      mcp_serve: { tools: ["core", "registry", "a2a", "wiki", "session", "acp"] },
    });

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
    });

    const tools = (resp?.result as JsonRpcResult).tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain("am_add_server");
    expect(names).toContain("am_apply");
  });

  test("tools/list shows write tools when unsafe-local is enabled", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    server.setSettings({
      mcp_serve: { tools: ["core", "registry", "a2a", "wiki", "session", "acp"] },
    });

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/list",
    });

    const tools = (resp?.result as JsonRpcResult).tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain("am_add_server");
  });
});
