import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import type { ResolvedConfig } from "../../../src/adapters/types";
import {
  type A2AServerOptions,
  TASK_TTL_MS,
  TaskEventEmitter,
  type TaskStore,
  createA2ARoutes,
  createTaskStore,
  getAppTaskStore,
  getAppTaskEventEmitter,
} from "../../../src/protocols/a2a/server";
import type { TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from "../../../src/protocols/a2a/types";

// ── Helpers ─────────────────────────────────────────────────────

function makeResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    servers: {},
    instructions: {},
    skills: {},
    agents: {},
    profile: "default",
    adapters: {},
    ...overrides,
  };
}

function makeApp(
  configOverrides: Partial<ResolvedConfig> = {},
  extraOpts: Partial<A2AServerOptions> = {},
) {
  const config = makeResolvedConfig(configOverrides);
  const options: A2AServerOptions = {
    config,
    cardOptions: { baseUrl: "http://localhost:9090" },
    ...extraOpts,
  };
  return createA2ARoutes(options);
}

function jsonRpcRequest(app: ReturnType<typeof createA2ARoutes>, body: unknown) {
  return app.request("/a2a", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Wait for a task in the store to reach a terminal state. */
async function waitForTask(store: TaskStore, taskId: string, timeoutMs = 2000): Promise<void> {
  const terminal = new Set(["completed", "failed", "canceled"]);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = store.get(taskId);
    if (task && terminal.has(task.status.state)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

// ── Setup / Teardown ────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "am-a2a-server-test-"));
  await mkdir(join(tmpDir, ".agent-manager"), { recursive: true });

  const config = {
    settings: { default_profile: "default" },
    servers: {},
    profiles: { default: { description: "Default profile" } },
  };
  await writeFile(join(tmpDir, "config.toml"), TOML.stringify(config as TOML.JsonMap));
  process.env.AM_CONFIG_DIR = tmpDir;
});

afterAll(async () => {
  process.env.AM_CONFIG_DIR = undefined;
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────

describe("A2A Server", () => {
  // ── Agent Card ──────────────────────────────────────────────

  describe("GET /.well-known/agent.json", () => {
    test("returns valid Agent Card", async () => {
      const app = makeApp();
      const res = await app.request("/.well-known/agent.json");

      expect(res.status).toBe(200);
      const card = await res.json();

      expect(card.name).toBe("agent-manager");
      expect(card.url).toBe("http://localhost:9090");
      expect(card.capabilities).toBeDefined();
      expect(card.skills).toBeDefined();
      expect(Array.isArray(card.skills)).toBe(true);
      expect(card.skills.length).toBeGreaterThanOrEqual(6);
      expect(card.version).toBeTruthy();
    });
  });

  // ── tasks/send ─────────────────────────────────────────────

  describe("POST /a2a — tasks/send", () => {
    test("returns immediately with state working", async () => {
      const app = makeApp();
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "task-001",
          message: {
            role: "user",
            parts: [{ type: "text", text: "status" }],
          },
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        jsonrpc: string;
        id: number;
        result: { id: string; status: { state: string } };
        error?: unknown;
      };

      expect(data.jsonrpc).toBe("2.0");
      expect(data.id).toBe(1);
      expect(data.error).toBeUndefined();
      expect(data.result).toBeDefined();
      expect(data.result.id).toBe("task-001");
      // Immediate response is "working" — handler runs async
      expect(data.result.status.state).toBe("working");
    });

    test("task completes asynchronously after send returns", async () => {
      const app = makeApp();
      const store = getAppTaskStore(app);

      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "task-async-001",
          message: {
            role: "user",
            parts: [{ type: "text", text: "status" }],
          },
        },
      });

      // Wait for async handler to complete
      await waitForTask(store, "task-async-001");

      const task = store.get("task-async-001");
      expect(task).toBeDefined();
      expect(task!.status.state).toBe("completed");
    });

    test("returns error for missing params", async () => {
      const app = makeApp();
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/send",
        params: {},
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { error: { code: number; message: string } };
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32602);
      expect(data.error.message).toContain("id and message required");
    });

    test("records user message in task history", async () => {
      const app = makeApp();
      const store = getAppTaskStore(app);

      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "task-history-test",
          message: {
            role: "user",
            parts: [{ type: "text", text: "config" }],
          },
        },
      });

      await waitForTask(store, "task-history-test");

      const task = store.get("task-history-test");
      expect(task).toBeDefined();
      expect(task!.history).toBeDefined();
      expect(task!.history!.length).toBeGreaterThanOrEqual(2); // user + agent
      expect(task!.history![0].role).toBe("user");
    });

    test("task state transitions to failed on handler error", async () => {
      const store = createTaskStore();
      const app = makeApp(
        {},
        {
          taskStore: store,
          taskHandler: async () => {
            throw new Error("handler boom");
          },
        },
      );

      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "task-fail-001",
          message: {
            role: "user",
            parts: [{ type: "text", text: "crash" }],
          },
        },
      });

      const data = (await res.json()) as {
        result: { id: string; status: { state: string } };
      };
      // Immediate response is "working"
      expect(data.result.status.state).toBe("working");

      // Wait for async handler to fail
      await waitForTask(store, "task-fail-001");

      const task = store.get("task-fail-001");
      expect(task).toBeDefined();
      expect(task!.status.state).toBe("failed");
      expect(task!.status.message!.parts[0]).toEqual(
        expect.objectContaining({ type: "text", text: expect.stringContaining("handler boom") }),
      );
    });
  });

  // ── tasks/get (polling) ────────────────────────────────────

  describe("POST /a2a — tasks/get", () => {
    test("returns working state before handler completes", async () => {
      let resolveHandler!: () => void;
      const handlerPromise = new Promise<void>((r) => {
        resolveHandler = r;
      });

      const store = createTaskStore();
      const app = makeApp(
        {},
        {
          taskStore: store,
          taskHandler: async () => {
            await handlerPromise;
            return {
              message: {
                role: "agent" as const,
                parts: [{ type: "text" as const, text: "done" }],
              },
            };
          },
        },
      );

      // Send task — handler blocks on our promise
      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "task-poll-001",
          message: {
            role: "user",
            parts: [{ type: "text", text: "status" }],
          },
        },
      });

      // Poll while handler is still running
      const pollRes = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/get",
        params: { id: "task-poll-001" },
      });

      const pollData = (await pollRes.json()) as {
        result: { id: string; status: { state: string } };
      };
      expect(pollData.result.status.state).toBe("working");

      // Unblock handler and wait for completion
      resolveHandler();
      await waitForTask(store, "task-poll-001");

      // Poll again — should be completed
      const doneRes = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 3,
        method: "tasks/get",
        params: { id: "task-poll-001" },
      });

      const doneData = (await doneRes.json()) as {
        result: { id: string; status: { state: string } };
      };
      expect(doneData.result.status.state).toBe("completed");
    });

    test("returns error for non-existent task", async () => {
      const app = makeApp();
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 3,
        method: "tasks/get",
        params: { id: "nonexistent-task" },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { error: { code: number; message: string } };
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32001);
      expect(data.error.message).toContain("Task not found");
    });

    test("returns error for missing id param", async () => {
      const app = makeApp();
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 4,
        method: "tasks/get",
        params: {},
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { error: { code: number; message: string } };
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32602);
    });

    test("historyLength=1 returns only the last message", async () => {
      const store = createTaskStore();
      const app = makeApp({}, { taskStore: store });

      // Send 3 messages to the same task
      for (let i = 0; i < 3; i++) {
        await jsonRpcRequest(app, {
          jsonrpc: "2.0",
          id: i + 10,
          method: "tasks/send",
          params: {
            id: "task-history-trim",
            message: {
              role: "user",
              parts: [{ type: "text", text: `message-${i}` }],
            },
          },
        });
      }

      // Wait for all handlers to complete
      await waitForTask(store, "task-history-trim");

      // Verify full history has more than 1 entry
      const task = store.get("task-history-trim");
      expect(task!.history!.length).toBeGreaterThan(1);

      // Query with historyLength=1
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 20,
        method: "tasks/get",
        params: { id: "task-history-trim", historyLength: 1 },
      });

      const data = (await res.json()) as {
        result: { id: string; history: Array<{ role: string; parts: unknown[] }> };
      };
      expect(data.result.history).toHaveLength(1);
    });

    test("historyLength=0 returns no history", async () => {
      const store = createTaskStore();
      const app = makeApp({}, { taskStore: store });

      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 30,
        method: "tasks/send",
        params: {
          id: "task-history-zero",
          message: {
            role: "user",
            parts: [{ type: "text", text: "status" }],
          },
        },
      });

      await waitForTask(store, "task-history-zero");

      // Query with historyLength=0
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 31,
        method: "tasks/get",
        params: { id: "task-history-zero", historyLength: 0 },
      });

      const data = (await res.json()) as {
        result: { id: string; history: unknown[] };
      };
      expect(data.result.history).toHaveLength(0);
    });
  });

  // ── tasks/cancel ───────────────────────────────────────────

  describe("POST /a2a — tasks/cancel", () => {
    test("cancels a working task", async () => {
      let resolveHandler!: () => void;
      const handlerPromise = new Promise<void>((r) => {
        resolveHandler = r;
      });

      const store = createTaskStore();
      const app = makeApp(
        {},
        {
          taskStore: store,
          taskHandler: async () => {
            await handlerPromise;
            return {
              message: {
                role: "agent" as const,
                parts: [{ type: "text" as const, text: "done" }],
              },
            };
          },
        },
      );

      // Send a task — handler will block
      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "task-cancel-working",
          message: {
            role: "user",
            parts: [{ type: "text", text: "status" }],
          },
        },
      });

      // Cancel while still working
      const cancelRes = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/cancel",
        params: { id: "task-cancel-working" },
      });

      expect(cancelRes.status).toBe(200);
      const data = (await cancelRes.json()) as {
        result: { id: string; status: { state: string } };
        error?: unknown;
      };
      expect(data.error).toBeUndefined();
      expect(data.result.status.state).toBe("canceled");

      // Unblock handler so it doesn't leak
      resolveHandler();
    });

    test("cannot cancel a completed task", async () => {
      const store = createTaskStore();
      const app = makeApp({}, { taskStore: store });

      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "task-cancel-completed",
          message: {
            role: "user",
            parts: [{ type: "text", text: "status" }],
          },
        },
      });

      // Wait for default handler to complete
      await waitForTask(store, "task-cancel-completed");

      const cancelRes = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/cancel",
        params: { id: "task-cancel-completed" },
      });

      expect(cancelRes.status).toBe(200);
      const data = (await cancelRes.json()) as { error: { code: number; message: string } };
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32003);
      expect(data.error.message).toContain("Cannot cancel task in state");
    });

    test("cancel while async handler is working, handler completion does not overwrite canceled state", async () => {
      let resolveHandler!: () => void;
      const handlerPromise = new Promise<void>((r) => {
        resolveHandler = r;
      });

      const store = createTaskStore();
      const app = makeApp(
        {},
        {
          taskStore: store,
          taskHandler: async () => {
            await handlerPromise;
            return {
              message: {
                role: "agent" as const,
                parts: [{ type: "text" as const, text: "handler finished" }],
              },
            };
          },
        },
      );

      // Send a task — handler blocks on our promise
      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "task-cancel-guard",
          message: {
            role: "user",
            parts: [{ type: "text", text: "slow work" }],
          },
        },
      });

      // Verify task is working
      const task = store.get("task-cancel-guard");
      expect(task).toBeDefined();
      expect(task!.status.state).toBe("working");

      // Cancel while handler is still running
      const cancelRes = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/cancel",
        params: { id: "task-cancel-guard" },
      });

      const cancelData = (await cancelRes.json()) as {
        result: { status: { state: string } };
      };
      expect(cancelData.result.status.state).toBe("canceled");

      // Now let the handler complete
      resolveHandler();

      // Give the handler's .then() a chance to run
      await new Promise((r) => setTimeout(r, 50));

      // The terminal state guard should prevent overwrite — task stays "canceled"
      const finalTask = store.get("task-cancel-guard");
      expect(finalTask!.status.state).toBe("canceled");
    });

    test("returns error for non-existent task", async () => {
      const app = makeApp();
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 5,
        method: "tasks/cancel",
        params: { id: "nonexistent" },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { error: { code: number; message: string } };
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32001);
    });

    test("returns error for missing id param", async () => {
      const app = makeApp();
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 6,
        method: "tasks/cancel",
        params: {},
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { error: { code: number; message: string } };
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32602);
    });
  });

  // ── Unknown method ─────────────────────────────────────────

  describe("POST /a2a — unknown method", () => {
    test("returns method not found error", async () => {
      const app = makeApp();
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 7,
        method: "tasks/nonexistent",
        params: {},
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { error: { code: number; message: string } };
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32601);
      expect(data.error.message).toContain("Method not found");
    });
  });

  // ── Task store isolation ──────────────────────────────────

  describe("task store isolation", () => {
    test("separate createA2ARoutes calls have independent stores", async () => {
      const app1 = makeApp();
      const app2 = makeApp();
      const store1 = getAppTaskStore(app1);
      const store2 = getAppTaskStore(app2);

      await jsonRpcRequest(app1, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "isolated-task",
          message: {
            role: "user",
            parts: [{ type: "text", text: "status" }],
          },
        },
      });

      await waitForTask(store1, "isolated-task");

      // app1 has the task, app2 does not
      expect(store1.get("isolated-task")).toBeDefined();
      expect(store2.get("isolated-task")).toBeUndefined();

      // Querying from app2 returns not found
      const res = await jsonRpcRequest(app2, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/get",
        params: { id: "isolated-task" },
      });
      const data = (await res.json()) as { error: { code: number } };
      expect(data.error.code).toBe(-32001);
    });
  });

  // ── Task store eviction ────────────────────────────────────

  describe("task store eviction", () => {
    test("completed tasks are cleaned up when store exceeds limit", async () => {
      const store = createTaskStore();
      const app = makeApp({}, { taskStore: store });

      // Create > 1000 completed tasks to trigger eviction
      for (let i = 0; i < 1005; i++) {
        await jsonRpcRequest(app, {
          jsonrpc: "2.0",
          id: i,
          method: "tasks/send",
          params: {
            id: `evict-task-${i}`,
            message: {
              role: "user",
              parts: [{ type: "text", text: "status" }],
            },
          },
        });
      }

      // Wait for all tasks to complete (the last one triggers eviction)
      await waitForTask(store, "evict-task-1004", 10000);

      // After eviction, store should be at or below MAX_TASKS (1000)
      expect(store.size).toBeLessThanOrEqual(1000);
    });
  });

  // ── Malformed JSON-RPC ─────────────────────────────────────

  describe("malformed JSON-RPC", () => {
    test("invalid JSON returns parse error", async () => {
      const app = makeApp();
      const res = await app.request("/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not valid json",
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: { code: number; message: string } };
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32700);
      expect(data.error.message).toContain("Parse error");
    });

    test("missing jsonrpc field returns invalid request error", async () => {
      const app = makeApp();
      const res = await jsonRpcRequest(app, {
        id: 1,
        method: "tasks/send",
        params: {},
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: { code: number; message: string } };
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32600);
      expect(data.error.message).toContain("Invalid JSON-RPC");
    });

    test("missing method field returns invalid request error", async () => {
      const app = makeApp();
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: { code: number; message: string } };
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32600);
    });

    test("wrong jsonrpc version returns invalid request error", async () => {
      const app = makeApp();
      const res = await jsonRpcRequest(app, {
        jsonrpc: "1.0",
        id: 1,
        method: "tasks/send",
        params: {},
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: { code: number; message: string } };
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32600);
    });
  });

  // ── Bearer token auth middleware ───────────────────────────

  describe("bearer token auth", () => {
    test("rejects request without token when auth_token is set", async () => {
      const app = makeApp({}, { auth_token: "secret-token-123" });
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "auth-test-1",
          message: { role: "user", parts: [{ type: "text", text: "status" }] },
        },
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Unauthorized");
    });

    test("rejects request with wrong token", async () => {
      const app = makeApp({}, { auth_token: "secret-token-123" });
      const res = await app.request("/a2a", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/send",
          params: {
            id: "auth-test-2",
            message: { role: "user", parts: [{ type: "text", text: "status" }] },
          },
        }),
      });

      expect(res.status).toBe(401);
    });

    test("allows request with valid token", async () => {
      const app = makeApp({}, { auth_token: "secret-token-123" });
      const res = await app.request("/a2a", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token-123",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/send",
          params: {
            id: "auth-test-3",
            message: { role: "user", parts: [{ type: "text", text: "status" }] },
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: { id: string; status: { state: string } };
        error?: unknown;
      };
      expect(data.error).toBeUndefined();
      expect(data.result.id).toBe("auth-test-3");
    });

    test("allows all requests when no auth_token is configured", async () => {
      const app = makeApp(); // no auth_token
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "auth-test-4",
          message: { role: "user", parts: [{ type: "text", text: "status" }] },
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: { id: string }; error?: unknown };
      expect(data.error).toBeUndefined();
      expect(data.result.id).toBe("auth-test-4");
    });

    test("Agent Card endpoint is public even when auth_token is set", async () => {
      const app = makeApp({}, { auth_token: "secret-token-123" });
      const res = await app.request("/.well-known/agent.json");

      expect(res.status).toBe(200);
      const card = await res.json();
      expect(card.name).toBe("agent-manager");
    });
  });

  // ── TTL-based task eviction ────────────────────────────────

  describe("TTL-based task eviction", () => {
    test("evicts terminal tasks older than TASK_TTL_MS", async () => {
      const store = createTaskStore();
      const app = makeApp({}, { taskStore: store });

      // Create a task and complete it
      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "ttl-old-task",
          message: { role: "user", parts: [{ type: "text", text: "status" }] },
        },
      });
      await waitForTask(store, "ttl-old-task");

      // Verify task exists and is completed
      expect(store.get("ttl-old-task")).toBeDefined();
      expect(store.get("ttl-old-task")!.status.state).toBe("completed");

      // Manually backdate the task's timestamp to exceed TTL
      const task = store.get("ttl-old-task")!;
      task.status.timestamp = new Date(Date.now() - TASK_TTL_MS - 1000).toISOString();

      // Create a new task to trigger eviction (via the .finally() in tasks/send)
      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/send",
        params: {
          id: "ttl-new-task",
          message: { role: "user", parts: [{ type: "text", text: "status" }] },
        },
      });
      await waitForTask(store, "ttl-new-task");

      // The old task should have been evicted by TTL
      expect(store.get("ttl-old-task")).toBeUndefined();
      // The new task should still exist
      expect(store.get("ttl-new-task")).toBeDefined();
    });

    test("does not evict terminal tasks within TTL", async () => {
      const store = createTaskStore();
      const app = makeApp({}, { taskStore: store });

      // Create and complete a task (timestamp is recent)
      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "ttl-recent-task",
          message: { role: "user", parts: [{ type: "text", text: "status" }] },
        },
      });
      await waitForTask(store, "ttl-recent-task");

      // Trigger eviction with another task
      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/send",
        params: {
          id: "ttl-trigger-task",
          message: { role: "user", parts: [{ type: "text", text: "status" }] },
        },
      });
      await waitForTask(store, "ttl-trigger-task");

      // Recent task should still exist
      expect(store.get("ttl-recent-task")).toBeDefined();
    });

    test("does not evict working tasks regardless of age", async () => {
      const store = createTaskStore();

      // Manually insert a "working" task with old timestamp
      store.set("ttl-working-old", {
        id: "ttl-working-old",
        status: {
          state: "working",
          timestamp: new Date(Date.now() - TASK_TTL_MS - 60_000).toISOString(),
        },
        history: [],
        artifacts: [],
      });

      const app = makeApp({}, { taskStore: store });

      // Trigger eviction
      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "ttl-evict-trigger",
          message: { role: "user", parts: [{ type: "text", text: "status" }] },
        },
      });
      await waitForTask(store, "ttl-evict-trigger");

      // Working task should NOT be evicted (not in terminal state)
      expect(store.get("ttl-working-old")).toBeDefined();
    });
  });

  // ── TaskEventEmitter unit tests ───────────────────────────────

  describe("TaskEventEmitter", () => {
    test("emits events to registered listeners", () => {
      const emitter = new TaskEventEmitter();
      const events: unknown[] = [];
      emitter.on("task-1", (evt) => events.push(evt));

      emitter.emit({
        type: "status",
        taskId: "task-1",
        data: { id: "task-1", status: { state: "working", timestamp: new Date().toISOString() }, final: false },
      });

      expect(events).toHaveLength(1);
    });

    test("does not emit to listeners for other tasks", () => {
      const emitter = new TaskEventEmitter();
      const events: unknown[] = [];
      emitter.on("task-1", (evt) => events.push(evt));

      emitter.emit({
        type: "status",
        taskId: "task-2",
        data: { id: "task-2", status: { state: "working", timestamp: new Date().toISOString() }, final: false },
      });

      expect(events).toHaveLength(0);
    });

    test("off removes listener", () => {
      const emitter = new TaskEventEmitter();
      const events: unknown[] = [];
      const listener = (evt: unknown) => events.push(evt);
      emitter.on("task-1", listener);
      emitter.off("task-1", listener);

      emitter.emit({
        type: "status",
        taskId: "task-1",
        data: { id: "task-1", status: { state: "working", timestamp: new Date().toISOString() }, final: false },
      });

      expect(events).toHaveLength(0);
    });

    test("removeAll clears all listeners for a task", () => {
      const emitter = new TaskEventEmitter();
      const events: unknown[] = [];
      emitter.on("task-1", (evt) => events.push(evt));
      emitter.on("task-1", (evt) => events.push(evt));
      emitter.removeAll("task-1");

      emitter.emit({
        type: "status",
        taskId: "task-1",
        data: { id: "task-1", status: { state: "working", timestamp: new Date().toISOString() }, final: false },
      });

      expect(events).toHaveLength(0);
    });
  });

  // ── tasks/sendSubscribe (SSE streaming) ───────────────────────

  describe("POST /a2a — tasks/sendSubscribe", () => {
    /** Helper to parse SSE events from a Response body. */
    async function readSSEEvents(res: Response): Promise<Array<{ event: string; data: unknown }>> {
      const text = await res.text();
      const events: Array<{ event: string; data: unknown }> = [];

      for (const block of text.split("\n\n")) {
        if (!block.trim()) continue;
        let eventType = "message";
        let dataStr = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataStr += line.slice(6);
        }
        if (dataStr) {
          try {
            events.push({ event: eventType, data: JSON.parse(dataStr) });
          } catch {
            // skip malformed
          }
        }
      }

      return events;
    }

    test("returns SSE stream with status updates for a completing task", async () => {
      const store = createTaskStore();
      const app = makeApp({}, { taskStore: store });

      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/sendSubscribe",
        params: {
          id: "stream-task-001",
          message: {
            role: "user",
            parts: [{ type: "text", text: "status" }],
          },
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");

      const events = await readSSEEvents(res);

      // Should have at least 2 status events: initial "working" + final "completed"
      const statusEvents = events.filter((e) => e.event === "status");
      expect(statusEvents.length).toBeGreaterThanOrEqual(2);

      // First event should be working
      const first = statusEvents[0].data as TaskStatusUpdateEvent;
      expect(first.id).toBe("stream-task-001");
      expect(first.status.state).toBe("working");
      expect(first.final).toBe(false);

      // Last event should be completed with final=true
      const last = statusEvents[statusEvents.length - 1].data as TaskStatusUpdateEvent;
      expect(last.status.state).toBe("completed");
      expect(last.final).toBe(true);
    });

    test("returns SSE stream with failed status on handler error", async () => {
      const store = createTaskStore();
      const app = makeApp(
        {},
        {
          taskStore: store,
          taskHandler: async () => {
            throw new Error("stream handler boom");
          },
        },
      );

      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/sendSubscribe",
        params: {
          id: "stream-fail-001",
          message: {
            role: "user",
            parts: [{ type: "text", text: "crash" }],
          },
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");

      const events = await readSSEEvents(res);
      const statusEvents = events.filter((e) => e.event === "status");

      // Last event should be failed
      const last = statusEvents[statusEvents.length - 1].data as TaskStatusUpdateEvent;
      expect(last.status.state).toBe("failed");
      expect(last.final).toBe(true);
    });

    test("emits artifact events when handler produces artifacts", async () => {
      const store = createTaskStore();
      const app = makeApp(
        {},
        {
          taskStore: store,
          taskHandler: async () => ({
            message: {
              role: "agent" as const,
              parts: [{ type: "text" as const, text: "done with artifact" }],
            },
            artifacts: [
              {
                name: "result.json",
                description: "Test artifact",
                parts: [{ type: "data" as const, data: { key: "value" } }],
              },
            ],
          }),
        },
      );

      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/sendSubscribe",
        params: {
          id: "stream-artifact-001",
          message: {
            role: "user",
            parts: [{ type: "text", text: "produce artifact" }],
          },
        },
      });

      const events = await readSSEEvents(res);
      const artifactEvents = events.filter((e) => e.event === "artifact");

      expect(artifactEvents.length).toBeGreaterThanOrEqual(1);
      const artifact = (artifactEvents[0].data as TaskArtifactUpdateEvent).artifact;
      expect(artifact.name).toBe("result.json");
    });

    test("returns JSON-RPC error for missing params", async () => {
      const app = makeApp();
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/sendSubscribe",
        params: {},
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { error: { code: number; message: string } };
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32602);
      expect(data.error.message).toContain("id and message required");
    });

    test("tasks/send still works unchanged (non-streaming path)", async () => {
      const app = makeApp();
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "non-stream-001",
          message: {
            role: "user",
            parts: [{ type: "text", text: "status" }],
          },
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        jsonrpc: string;
        result: { id: string; status: { state: string } };
      };
      expect(data.jsonrpc).toBe("2.0");
      expect(data.result.id).toBe("non-stream-001");
      expect(data.result.status.state).toBe("working");
    });

    test("SSE stream respects bearer token auth", async () => {
      const app = makeApp({}, { auth_token: "secret-token-123" });

      // Without token — should fail
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/sendSubscribe",
        params: {
          id: "stream-auth-001",
          message: { role: "user", parts: [{ type: "text", text: "status" }] },
        },
      });
      expect(res.status).toBe(401);

      // With valid token — should succeed
      const authRes = await app.request("/a2a", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token-123",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tasks/sendSubscribe",
          params: {
            id: "stream-auth-002",
            message: { role: "user", parts: [{ type: "text", text: "status" }] },
          },
        }),
      });
      expect(authRes.status).toBe(200);
      expect(authRes.headers.get("Content-Type")).toBe("text/event-stream");
    });

    test("getAppTaskEventEmitter returns the emitter", () => {
      const app = makeApp();
      const emitter = getAppTaskEventEmitter(app);
      expect(emitter).toBeDefined();
      expect(emitter).toBeInstanceOf(TaskEventEmitter);
    });
  });
});
