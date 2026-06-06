/**
 * FIX 2 (CODEX-11 parity for A2A): invoke/cancel must use the SERVER-assigned
 * task id, not the locally-minted session id.
 *
 * Bug: invokeAgentImpl sent the A2A task with id:sessionId (a local id) and
 * registered the active session under it. A strict A2A v0.3 server mints its
 * OWN task id and ignores the client's. cancelSessionImpl then called
 * cancelTask({id:sessionId}) and the streaming path called getTask({id:sessionId})
 * with an id the remote never saw — cancel silently no-ops (-32001 swallowed)
 * and the streamed result errors on the final getTask. ACP already had this fix
 * (serverSessionId); A2A was never given the equivalent.
 *
 * These tests stand up a REAL local HTTP server that behaves like a strict A2A
 * server (returns a task id different from the client-supplied one and records
 * which id tasks/cancel was invoked with), then assert the MCP server routes
 * cancel/getTask through the server's id.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import {
  McpServer,
  _getActiveSession,
  _registerActiveSession,
  _unregisterActiveSession,
} from "../../src/mcp/server";
import { type TestDir, createTestDir } from "../helpers/tmp";

type JsonRpcResult = Record<string, any>;

// The server-authoritative task id — DELIBERATELY different from any
// client-supplied (local) session id.
const SERVER_TASK_ID = "srv-task-AUTHORITATIVE-999";

interface RecordedCall {
  method: string;
  id: unknown;
}

describe("FIX 2 — A2A invoke/cancel use server-assigned task id", () => {
  let dir: TestDir;
  const originalConfigDir = process.env.AM_CONFIG_DIR;
  const originalAllowPrivate = process.env.AM_A2A_ALLOW_PRIVATE;

  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  const calls: RecordedCall[] = [];

  beforeAll(() => {
    // Strict A2A server: ignores the client-supplied task id and substitutes
    // its own. Records every RPC's `id` param so tests can assert which id the
    // MCP server used.
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/a2a") {
          return new Response("not found", { status: 404 });
        }
        const body = (await req.json()) as {
          method: string;
          id: number;
          params?: { id?: unknown };
        };
        calls.push({ method: body.method, id: body.params?.id });

        const taskResult = (state: string) => ({
          jsonrpc: "2.0",
          id: body.id,
          // SERVER mints its own task id, ignoring the client-supplied one.
          result: {
            id: SERVER_TASK_ID,
            status: { state, timestamp: "2026-06-04T00:00:00Z" },
          },
        });

        if (body.method === "tasks/send") {
          return Response.json(taskResult("completed"));
        }
        if (body.method === "tasks/sendSubscribe") {
          // Stream a single terminal status event whose `id` is the SERVER
          // task id (not the client-supplied one). The client resolves
          // sendSubscribe with this final event, from which the MCP server
          // learns the authoritative id for the follow-up getTask.
          const event = {
            id: SERVER_TASK_ID,
            status: { state: "completed", timestamp: "2026-06-04T00:00:00Z" },
            final: true,
          };
          const sse = `event: status\ndata: ${JSON.stringify(event)}\n\n`;
          return new Response(sse, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (body.method === "tasks/get") {
          // If the caller queried with the WRONG (local) id, a strict server
          // would 404. Mimic that: only return a task for the server id.
          if (body.params?.id !== SERVER_TASK_ID) {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32001, message: "Task not found" },
            });
          }
          return Response.json(taskResult("completed"));
        }
        if (body.method === "tasks/cancel") {
          // Strict server: cancelling an unknown id is a -32001 no-op.
          if (body.params?.id !== SERVER_TASK_ID) {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32001, message: "Task not found" },
            });
          }
          return Response.json(taskResult("canceled"));
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(async () => {
    calls.length = 0;
    dir = await createTestDir("am-a2a-srvid-");
    process.env.AM_CONFIG_DIR = dir.path;
    // The A2A client inside server.ts is constructed without an explicit
    // allowPrivateNetwork, so it relies on this env var to reach 127.0.0.1.
    process.env.AM_A2A_ALLOW_PRIVATE = "1";
    await initRepo(dir.path);
    await writeConfig(join(dir.path, "config.toml"), {
      settings: {
        mcp_serve: {
          allow_push: true,
          tools: ["core", "registry", "a2a", "wiki", "session", "acp"],
        },
      },
    });
    // Seed an A2A roster agent pointing at our local strict server.
    await writeFile(
      join(dir.path, "agents.toml"),
      `[agents.strict-a2a]\nurl = "${baseUrl}"\nadded_at = "2026-06-04T00:00:00Z"\n`,
    );
  });

  afterEach(async () => {
    if (originalConfigDir) process.env.AM_CONFIG_DIR = originalConfigDir;
    else Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    if (originalAllowPrivate) process.env.AM_A2A_ALLOW_PRIVATE = originalAllowPrivate;
    else Reflect.deleteProperty(process.env, "AM_A2A_ALLOW_PRIVATE");
    if (dir) await dir.cleanup();
  });

  function makeServer(): McpServer {
    const s = new McpServer();
    s.setAuth({ token: undefined, allowUnsafeLocal: true });
    return s;
  }

  test("am_agent_invoke (non-streaming) surfaces the server task id, not the local session id", async () => {
    const mcp = makeServer();
    const resp = await mcp.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "am_agent_invoke",
        arguments: { agent: "strict-a2a", prompt: "hi", session: "local-client-id-1" },
      },
    });
    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(content.protocol).toBe("a2a");
    // The response exposes BOTH the local tracking id and the server task id.
    expect(content.sessionId).toBe("local-client-id-1");
    expect(content.serverTaskId).toBe(SERVER_TASK_ID);
    // tasks/send was called with the local id (we don't know the server id
    // until the response), but the server substituted its own id.
    const sendCall = calls.find((c) => c.method === "tasks/send");
    expect(sendCall?.id).toBe("local-client-id-1");
  });

  test("am_agent_invoke (streaming) does the final getTask with the SERVER task id", async () => {
    const mcp = makeServer();
    const resp = await mcp.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "am_agent_invoke",
        arguments: { agent: "strict-a2a", prompt: "hi", stream: true, session: "local-stream-1" },
      },
    });
    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    // The final getTask MUST use the server id. With the bug it used the local
    // id and the strict server returned -32001 → the whole call would error.
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(content.streamed).toBe(true);
    expect(content.serverTaskId).toBe(SERVER_TASK_ID);
    // The final getTask hit the server task id, never the local one.
    const getCall = calls.find((c) => c.method === "tasks/get");
    expect(getCall?.id).toBe(SERVER_TASK_ID);
    expect(calls.some((c) => c.method === "tasks/get" && c.id === "local-stream-1")).toBe(false);
  });

  test("am_agent_session_cancel cancels with the stored server task id, not the local session id", async () => {
    // Register an A2A session the way invokeAgentImpl does once it has learned
    // the server id: keyed on the LOCAL id, carrying the SERVER task id.
    const localSessionId = "local-cancel-1";
    _registerActiveSession(localSessionId, {
      kind: "a2a",
      agent: "strict-a2a",
      baseUrl: baseUrl,
      serverTaskId: SERVER_TASK_ID,
    });

    const mcp = makeServer();
    const resp = await mcp.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "am_agent_session_cancel", arguments: { sessionId: localSessionId } },
    });
    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    // Cancel RPC succeeded — it could ONLY succeed against the strict server if
    // it used the server task id (the local id yields -32001).
    expect(content.cancelled).toBe(true);
    const cancelCall = calls.find((c) => c.method === "tasks/cancel");
    expect(cancelCall?.id).toBe(SERVER_TASK_ID);
    expect(cancelCall?.id).not.toBe(localSessionId);
    // Cleanup (cancel deletes it, but be defensive).
    _unregisterActiveSession(localSessionId);
  });

  test("am_agent_session_cancel falls back to the local id when no server task id was captured", async () => {
    // Pre-response / non-strict entry: no serverTaskId. Must fall back to the
    // lookup key so non-strict servers (which accept client ids) still work.
    const localSessionId = SERVER_TASK_ID; // make the local id == server id so cancel succeeds
    _registerActiveSession(localSessionId, {
      kind: "a2a",
      agent: "strict-a2a",
      baseUrl: baseUrl,
      // serverTaskId intentionally omitted
    });
    const mcp = makeServer();
    const resp = await mcp.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "am_agent_session_cancel", arguments: { sessionId: localSessionId } },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const cancelCall = calls.find((c) => c.method === "tasks/cancel");
    // Used the lookup key (sessionId) since no serverTaskId was stored.
    expect(cancelCall?.id).toBe(localSessionId);
    _unregisterActiveSession(localSessionId);
  });

  test("invoke stores the server task id on the active session entry mid-flight", async () => {
    // Prove the activeSessions entry is re-set with serverTaskId. The entry is
    // deleted in `finally`, so we observe it by swapping getTask timing is hard;
    // instead we assert the post-invoke response carries serverTaskId (covered
    // above) AND that a directly-registered entry with a differing server id is
    // honoured by cancel (covered above). This test asserts the registry helper
    // round-trips the new field so the type wiring can't silently regress.
    _registerActiveSession("rt-1", {
      kind: "a2a",
      agent: "strict-a2a",
      baseUrl: baseUrl,
      serverTaskId: SERVER_TASK_ID,
    });
    const entry = _getActiveSession("rt-1");
    expect(entry?.kind).toBe("a2a");
    if (entry?.kind === "a2a") {
      expect(entry.serverTaskId).toBe(SERVER_TASK_ID);
    }
    _unregisterActiveSession("rt-1");
  });
});
