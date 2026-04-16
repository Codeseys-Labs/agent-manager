import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import type { ResolvedConfig } from "../../../src/adapters/types";
import {
  type A2AServerOptions,
  type TaskStore,
  createA2ARoutes,
  createTaskStore,
  getAppTaskStore,
} from "../../../src/protocols/a2a/server";

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
});
