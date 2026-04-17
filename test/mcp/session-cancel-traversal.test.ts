/**
 * Wave 2.B: path traversal guard for am_acp_session_cancel.
 *
 * The sessionId argument is joined onto the session directory and passed to
 * `rm({ recursive: true })`. Without a guard, an attacker could pass
 * "../../../../tmp/x" and the server would happily delete files outside the
 * session dir. This test freezes the guard behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import { McpServer, resolveSessionPathSafely } from "../../src/mcp/server";
import { type TestDir, createTestDir } from "../helpers/tmp";

type JsonRpcResult = Record<string, any>;

describe("am_acp_session_cancel path traversal", () => {
  let dir: TestDir;
  let outsideDir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-mcp-traversal-");
    outsideDir = await createTestDir("am-mcp-outside-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
    await writeConfig(join(dir.path, "config.toml"), {
      // Enable write-remote opt-in so we reach the handler, not the permission wall.
      settings: {
        mcp_serve: {
          allow_push: true,
          tools: ["core", "registry", "a2a", "wiki", "session", "acp"],
        },
      },
    });
  });

  afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      process.env.AM_CONFIG_DIR = undefined;
    }
    if (dir) await dir.cleanup();
    if (outsideDir) await outsideDir.cleanup();
  });

  function makeServer(): McpServer {
    const server = new McpServer();
    server.setAuth({ token: undefined, allowUnsafeLocal: true });
    return server;
  }

  test("resolveSessionPathSafely rejects ../ traversal", () => {
    expect(() => resolveSessionPathSafely("/tmp/sessions", "../../etc/passwd")).toThrow();
  });

  test("resolveSessionPathSafely rejects absolute paths", () => {
    expect(() => resolveSessionPathSafely("/tmp/sessions", "/etc/passwd")).toThrow();
  });

  test("resolveSessionPathSafely rejects separators", () => {
    expect(() => resolveSessionPathSafely("/tmp/sessions", "a/b")).toThrow();
    expect(() => resolveSessionPathSafely("/tmp/sessions", "a\\b")).toThrow();
  });

  test("resolveSessionPathSafely rejects null byte", () => {
    expect(() => resolveSessionPathSafely("/tmp/sessions", "abc\0def")).toThrow();
  });

  test("resolveSessionPathSafely rejects empty", () => {
    expect(() => resolveSessionPathSafely("/tmp/sessions", "")).toThrow();
  });

  test("resolveSessionPathSafely rejects dot-dot substring", () => {
    expect(() => resolveSessionPathSafely("/tmp/sessions", "a..b")).toThrow();
  });

  test("resolveSessionPathSafely accepts a valid id", () => {
    const p = resolveSessionPathSafely("/tmp/sessions", "am-abc123_xyz");
    expect(p.endsWith("am-abc123_xyz")).toBe(true);
  });

  test("handler refuses to delete files outside sessionDir on traversal", async () => {
    const sessionDir = join(dir.path, "sessions");
    await mkdir(sessionDir, { recursive: true });

    // Create a victim file outside the session dir.
    const victim = join(outsideDir.path, "victim.txt");
    await writeFile(victim, "sensitive");

    // Compute a traversal payload that would cross from sessionDir up to outsideDir.
    // e.g., sessionDir is /var/…/sessions and outsideDir is /var/…/outside.
    // Traversal: ../outside/victim.txt. Even if it "worked", the guard blocks it.
    const traversalPayloads = [
      "../../victim.txt",
      "../../../../tmp/x",
      `../${outsideDir.path.split("/").filter(Boolean).slice(-1)[0]}/victim.txt`,
      "/etc/passwd",
      "a/b",
      "..",
      ".",
    ];

    const server = makeServer();

    for (const sessionId of traversalPayloads) {
      const resp = await server.handleRequest({
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 10000),
        method: "tools/call",
        params: { name: "am_acp_session_cancel", arguments: { sessionId } },
      });
      expect(resp).not.toBeNull();
      const result = resp?.result as JsonRpcResult;
      expect(result.isError).toBe(true);
      const content = JSON.parse(result.content[0].text);
      // Either the zod regex fires (Invalid arguments) or the handler guard fires
      // (Invalid sessionId). Both are acceptable — the point is we never touched fs.
      expect(
        /Invalid (arguments|sessionId)/.test(content.error) || /not found/i.test(content.error),
      ).toBe(true);
    }

    // Victim must still exist, untouched.
    const s = await stat(victim);
    expect(s.isFile()).toBe(true);
  });

  test("handler accepts valid sessionId and reports not-found (no session present)", async () => {
    const server = makeServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 200,
      method: "tools/call",
      params: { name: "am_acp_session_cancel", arguments: { sessionId: "am-valid_id-1" } },
    });
    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toMatch(/not found/i);
  });

  test("handler deletes a real session dir when sessionId is valid", async () => {
    const sessionDir = join(dir.path, "sessions");
    const victimSession = join(sessionDir, "am-session_abc123");
    await mkdir(victimSession, { recursive: true });
    await writeFile(join(victimSession, "state.json"), "{}");

    const server = makeServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: {
        name: "am_acp_session_cancel",
        arguments: { sessionId: "am-session_abc123" },
      },
    });
    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(content.action).toBe("cancel");
    expect(content.status).toBe("cancelled");

    // Session directory should be gone.
    const remaining = await readdir(sessionDir);
    expect(remaining).not.toContain("am-session_abc123");
  });
});
