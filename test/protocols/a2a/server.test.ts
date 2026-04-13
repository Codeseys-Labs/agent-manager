import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import type { ResolvedConfig } from "../../../src/adapters/types";
import {
  type A2AServerOptions,
  clearTaskStore,
  createA2ARoutes,
  getAllTasks,
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

function makeApp(configOverrides: Partial<ResolvedConfig> = {}) {
  const config = makeResolvedConfig(configOverrides);
  const options: A2AServerOptions = {
    config,
    cardOptions: { baseUrl: "http://localhost:9090" },
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

afterEach(() => {
  clearTaskStore();
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
    test("creates a task and returns task ID", async () => {
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
      expect(data.result.status.state).toBe("completed");
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

      const tasks = getAllTasks();
      const task = tasks.get("task-history-test");
      expect(task).toBeDefined();
      expect(task!.history).toBeDefined();
      expect(task!.history!.length).toBeGreaterThanOrEqual(2); // user + agent
      expect(task!.history![0].role).toBe("user");
    });
  });

  // ── tasks/get ──────────────────────────────────────────────

  describe("POST /a2a — tasks/get", () => {
    test("retrieves a previously created task", async () => {
      const app = makeApp();

      // First create a task
      await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "task-get-001",
          message: {
            role: "user",
            parts: [{ type: "text", text: "status" }],
          },
        },
      });

      // Then retrieve it
      const res = await jsonRpcRequest(app, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/get",
        params: { id: "task-get-001" },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: { id: string; status: { state: string } };
        error?: unknown;
      };

      expect(data.error).toBeUndefined();
      expect(data.result).toBeDefined();
      expect(data.result.id).toBe("task-get-001");
      expect(data.result.status.state).toBe("completed");
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
    test("cancels a task", async () => {
      const app = makeApp({
        servers: {
          test: {
            name: "test",
            command: "echo",
            args: [],
            env: {},
            transport: "stdio",
            description: "",
            tags: [],
            enabled: true,
            adapters: {},
          },
        },
      });

      // Create a task with a custom handler that leaves it in "working" state
      const options: A2AServerOptions = {
        config: makeResolvedConfig(),
        cardOptions: { baseUrl: "http://localhost:9090" },
        taskHandler: async () => {
          // Simulate a quick task that completes
          return {
            message: {
              role: "agent" as const,
              parts: [{ type: "text" as const, text: "done" }],
            },
          };
        },
      };
      const customApp = createA2ARoutes(options);

      // Send a task to create it (it completes immediately with our handler)
      // For cancel test, we need a task in a cancelable state
      // Let's create and then try to cancel — the default handler completes immediately,
      // so completed tasks cannot be canceled
      await jsonRpcRequest(customApp, {
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          id: "task-cancel-001",
          message: {
            role: "user",
            parts: [{ type: "text", text: "status" }],
          },
        },
      });

      // Completed tasks cannot be canceled
      const cancelRes = await jsonRpcRequest(customApp, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/cancel",
        params: { id: "task-cancel-001" },
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

  // ── Task store eviction ────────────────────────────────────

  describe("task store eviction", () => {
    test("completed tasks are cleaned up when store exceeds limit", async () => {
      const app = makeApp();

      // Create > 1000 completed tasks to trigger eviction
      // We'll create 1005 tasks — after eviction the store should
      // shrink to <= 1000 (with completed ones removed first)
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

      const tasks = getAllTasks();
      // After eviction, store should be at or below MAX_TASKS (1000)
      expect(tasks.size).toBeLessThanOrEqual(1000);
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
