/**
 * Wave D (2026-04-17): iter4 fix pass — unified `am_agent_*` MCP tools.
 *
 * Covers:
 *   - am_agent_invoke routes ACP and A2A based on registry resolution.
 *   - am_agent_session_cancel calls the protocol cancel RPC (bug fix vs legacy
 *     am_acp_session_cancel which only rm'd the persisted dir).
 *   - Deprecated aliases (am_run_agent, am_acp_list_agents, am_acp_session_list,
 *     am_acp_session_cancel, am_agent_delegate) still route correctly and emit
 *     a one-time stderr warning per process.
 *   - progressToken emits notifications/progress through the configured sink.
 *   - am_agent_session_list with no agent filter returns all sessions.
 *
 * Design: docs/reviews/2026-04-17-iter4-system-critique/06-acp-a2a-mcp-tools.md
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import {
  McpServer,
  _getActiveSession,
  _registerActiveSession,
  _resetDeprecationWarnings,
  _unregisterActiveSession,
} from "../../src/mcp/server";
import { type TestDir, createTestDir } from "../helpers/tmp";

type JsonRpcResult = Record<string, any>;

describe("Wave D — unified am_agent_* MCP tools", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-wave-d-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
    await writeConfig(join(dir.path, "config.toml"), {
      settings: {
        mcp_serve: {
          allow_push: true,
          tools: ["core", "registry", "a2a", "wiki", "session", "acp"],
        },
      },
    });
    // Seed A2A roster with a mock-a2a agent — this avoids the AgentProfile
    // schema (which requires `name`, prompt, etc.) and is the established path
    // for A2A agents in tests.
    await writeFile(
      join(dir.path, "agents.toml"),
      `[agents.mock-a2a]\nurl = "http://127.0.0.1:1/a2a"\nadded_at = "2026-04-17T00:00:00Z"\n`,
    );
    _resetDeprecationWarnings();
  });

  afterEach(async () => {
    if (originalEnv) process.env.AM_CONFIG_DIR = originalEnv;
    else process.env.AM_CONFIG_DIR = undefined;
    if (dir) await dir.cleanup();
  });

  function makeServer(): McpServer {
    const server = new McpServer();
    server.setAuth({ token: undefined, allowUnsafeLocal: true });
    return server;
  }

  // ── 1a. am_agent_invoke unknown-agent path ───────────────────────
  test("am_agent_invoke surfaces a clear 'Unknown agent' error when resolution fails", async () => {
    const server = makeServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "am_agent_invoke",
        arguments: { agent: "definitely-not-an-agent-zxywv", prompt: "hi" },
      },
    });
    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toMatch(/Unknown agent/i);
  });

  // ── 1b. am_agent_invoke routes to ACP for a built-in agent ───────
  test("am_agent_invoke with a built-in ACP agent routes to the ACP client", async () => {
    // `amazon-q` is in BUILT_IN_ACP_AGENTS and spawns `q chat --acp`.
    // On a machine without that binary, connect() raises a spawn/exec error
    // — but crucially, NOT "Unknown agent". The shape of the error proves the
    // router chose the ACP branch. We also verify the protocol field if we
    // somehow succeed (unlikely in CI).
    const server = makeServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: {
        name: "am_agent_invoke",
        arguments: { agent: "amazon-q", prompt: "hi", timeout: 500 },
      },
    });
    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    if (result.isError) {
      const content = JSON.parse(result.content[0].text);
      expect(content.error).not.toMatch(/Unknown agent/i);
    } else {
      const content = JSON.parse(result.content[0].text);
      expect(content.protocol).toBe("acp");
    }
  });

  // ── 2. am_agent_invoke (A2A) ─────────────────────────────────────
  test("am_agent_invoke with an A2A agent dispatches to A2A client", async () => {
    const server = makeServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "am_agent_invoke",
        arguments: { agent: "mock-a2a", prompt: "hi", timeout: 500 },
      },
    });
    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    // Must surface as an error (connection refused) — but that error is from
    // the A2A path, not "unknown agent". Prove the router chose A2A.
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).not.toMatch(/Unknown agent/i);
  });

  // ── 3. cancel actually cancels (the R6 bug fix) ──────────────────
  test("am_agent_session_cancel calls conn.cancel() on the active ACP client BEFORE rm", async () => {
    // This is the crux test for the bug: legacy am_acp_session_cancel only
    // called rm(). The new handler must call client.cancel(sessionId).
    const sessionId = "am-wave-d-cancel-1";
    const calls: string[] = [];
    const mockClient = {
      async cancel(sid: string) {
        calls.push(`cancel:${sid}`);
      },
      async disconnect() {
        calls.push("disconnect");
      },
    };
    _registerActiveSession(sessionId, {
      kind: "acp",
      agent: "mock-acp",
      client: mockClient,
    });

    // Also create a persisted dir so we can prove rm ran too.
    const sessionDir = join(dir.path, "sessions");
    const live = join(sessionDir, sessionId);
    await mkdir(live, { recursive: true });
    await writeFile(join(live, "state.json"), "{}");

    const server = makeServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "am_agent_session_cancel",
        arguments: { sessionId },
      },
    });
    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    // No error.
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    // Protocol cancel RPC was called.
    expect(calls).toContain(`cancel:${sessionId}`);
    expect(content.cancelled).toBe(true);
    // Persisted dir was removed.
    expect(content.removed).toBe(true);
    let existed = true;
    try {
      await stat(live);
    } catch {
      existed = false;
    }
    expect(existed).toBe(false);
    // Active session entry cleared.
    expect(_getActiveSession(sessionId)).toBeUndefined();
  });

  // ── 4. silent cleanup when connection already gone ───────────────
  test("am_agent_session_cancel removes persisted dir silently when no live client", async () => {
    const sessionId = "am-session_no-live-client";
    const sessionDir = join(dir.path, "sessions");
    const live = join(sessionDir, sessionId);
    await mkdir(live, { recursive: true });
    await writeFile(join(live, "state.json"), "{}");

    const server = makeServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "am_agent_session_cancel",
        arguments: { sessionId },
      },
    });
    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    // No live client: cancelled RPC did not fire…
    expect(content.cancelled).toBe(false);
    // …but the dir was removed.
    expect(content.removed).toBe(true);
  });

  // ── 5. Deprecated alias routing: am_acp_session_cancel → new impl ─
  test("am_acp_session_cancel alias routes through the unified cancel implementation (R6 bug fixed)", async () => {
    // Seed an active session so we can observe that alias routing now calls
    // the protocol cancel RPC. On the OLD behaviour the RPC would NEVER be
    // called; this test would fail.
    const sessionId = "am-legacy_alias-42";
    const calls: string[] = [];
    _registerActiveSession(sessionId, {
      kind: "acp",
      agent: "mock-acp",
      client: {
        async cancel(sid: string) {
          calls.push(`cancel:${sid}`);
        },
        async disconnect() {},
      },
    });
    const sessionDir = join(dir.path, "sessions");
    const live = join(sessionDir, sessionId);
    await mkdir(live, { recursive: true });

    const server = makeServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "am_acp_session_cancel", arguments: { sessionId } },
    });
    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    // The protocol cancel RPC was called. Legacy behaviour never called this.
    expect(calls).toContain(`cancel:${sessionId}`);
    _unregisterActiveSession(sessionId);
  });

  // ── 6. Deprecation warning is emitted once per alias per process ─
  test("deprecated aliases emit exactly one stderr warning per process per name", async () => {
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      _resetDeprecationWarnings();
      const server = makeServer();
      // First call: emits warning.
      await server.handleRequest({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "am_acp_list_agents", arguments: {} },
      });
      // Second call: silent.
      await server.handleRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "am_acp_list_agents", arguments: {} },
      });
      const warnLines = captured
        .join("")
        .split("\n")
        .filter((l) => l.includes('"am_acp_list_agents"'));
      expect(warnLines.length).toBe(1);
      expect(warnLines[0]).toMatch(/DEPRECATED/);
      expect(warnLines[0]).toMatch(/am_agent_list/);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  // ── 7. progressToken emits notifications/progress ────────────────
  test("progressToken on tools/call causes notifications/progress to be emitted via the sink", async () => {
    const server = makeServer();
    const captured: Array<Record<string, unknown>> = [];
    server.setProgressSink((notif) => {
      captured.push(notif as unknown as Record<string, unknown>);
    });
    // We invoke a harmless tool and use ctx.emitProgress indirectly by
    // calling am_agent_invoke with an A2A agent that will fail — but we only
    // check that the sink CAN be invoked via emitProgress. To make this deterministic
    // without a real agent, wire a fake tool via an active-session mock and
    // call am_agent_session_cancel which has ctx, then manually emit.
    //
    // Easier: drive emitProgress directly by calling handleRequest with a
    // progressToken and inspecting that ctx wiring is live — we do this by
    // monkeypatching an existing tool handler briefly.
    const tools = server.getTools();
    const stat = tools.find((t) => t.def.name === "am_status");
    expect(stat).toBeDefined();
    const origHandler = stat!.handler;
    // Test monkeypatch: swap handler to one that emits progress via ctx.
    (stat as unknown as { handler: unknown }).handler = async (
      _args: Record<string, unknown>,
      ctx: { emitProgress: (p: unknown) => void },
    ) => {
      ctx.emitProgress({ progress: 0.5, message: { kind: "test", chunk: "hello" } });
      return { ok: true };
    };
    try {
      const resp = await server.handleRequest({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "am_status",
          arguments: {},
          _meta: { progressToken: "tok-abc" },
        },
      });
      expect(resp).not.toBeNull();
      // Exactly one progress notification was emitted.
      expect(captured.length).toBe(1);
      const notif = captured[0] as {
        jsonrpc: string;
        method: string;
        params: { progressToken: string; message?: unknown };
      };
      expect(notif.jsonrpc).toBe("2.0");
      expect(notif.method).toBe("notifications/progress");
      expect(notif.params.progressToken).toBe("tok-abc");
    } finally {
      (stat as unknown as { handler: unknown }).handler = origHandler;
    }
  });

  // ── 8. no progressToken = no notifications ───────────────────────
  test("absence of progressToken suppresses progress emission (graceful fallback)", async () => {
    const server = makeServer();
    const captured: Array<unknown> = [];
    server.setProgressSink((notif) => {
      captured.push(notif);
    });
    const tools = server.getTools();
    const stat = tools.find((t) => t.def.name === "am_status");
    const origHandler = stat!.handler;
    (stat as unknown as { handler: unknown }).handler = async (
      _args: Record<string, unknown>,
      ctx: { emitProgress: (p: unknown) => void },
    ) => {
      ctx.emitProgress({ progress: 0.5, message: { kind: "test" } });
      return { ok: true };
    };
    try {
      await server.handleRequest({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "am_status", arguments: {} }, // no _meta.progressToken
      });
      expect(captured.length).toBe(0);
    } finally {
      (stat as unknown as { handler: unknown }).handler = origHandler;
    }
  });

  // ── 9. am_agent_session_list with no agent filter returns all ─────
  test("am_agent_session_list with no agent returns sessions across all backends", async () => {
    _registerActiveSession("acp-sess-1", {
      kind: "acp",
      agent: "mock-acp",
      client: { async cancel() {}, async disconnect() {} },
    });
    _registerActiveSession("a2a-sess-1", {
      kind: "a2a",
      agent: "mock-a2a",
      baseUrl: "http://127.0.0.1:1/a2a",
    });
    try {
      const server = makeServer();
      const resp = await server.handleRequest({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "am_agent_session_list", arguments: {} },
      });
      expect(resp).not.toBeNull();
      const result = resp?.result as JsonRpcResult;
      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content[0].text);
      const ids = content.sessions.map((s: { id: string }) => s.id);
      expect(ids).toContain("acp-sess-1");
      expect(ids).toContain("a2a-sess-1");
      const backends = new Set<string>(content.sessions.map((s: { backend: string }) => s.backend));
      expect(backends.has("acp")).toBe(true);
      expect(backends.has("a2a")).toBe(true);
    } finally {
      _unregisterActiveSession("acp-sess-1");
      _unregisterActiveSession("a2a-sess-1");
    }
  });

  // ── 10. am_agent_list returns unified view (not roster-only) ──────
  test("am_agent_list returns the unified registry view including ACP built-ins and config agents", async () => {
    const server = makeServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "am_agent_list", arguments: {} },
    });
    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    const names = content.agents.map((a: { name: string }) => a.name);
    // A2A roster agents appear.
    expect(names).toContain("mock-a2a");
    // ACP built-ins appear too (at least `claude`, `codex`).
    expect(names).toContain("claude");
    expect(names).toContain("codex");
    // The unified view carries a protocol column.
    const mockA2A = content.agents.find((a: { name: string }) => a.name === "mock-a2a");
    expect(mockA2A.protocol).toBe("a2a");
    const claude = content.agents.find((a: { name: string }) => a.name === "claude");
    expect(claude.protocol).toBe("acp");
  });
});
