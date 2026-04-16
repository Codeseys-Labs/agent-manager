/**
 * A2A Server Adapter — expose agent-manager as an A2A-compatible agent.
 *
 * Hono routes:
 *   GET  /.well-known/agent.json  — Agent Card
 *   POST /a2a                     — JSON-RPC 2.0 endpoint
 *
 * Supported methods:
 *   tasks/send   — create/update a task (returns immediately, runs handler async)
 *   tasks/get    — query task status (used for polling)
 *   tasks/cancel — cancel a running task
 */

import { Hono } from "hono";
import type { ResolvedConfig } from "../../adapters/types";
import { type GenerateCardOptions, generateAgentCard } from "./generate-card";
import type {
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  Artifact,
  Message,
  Task,
  TaskCancelParams,
  TaskQueryParams,
  TaskSendParams,
  TaskState,
  TextPart,
} from "./types";

// ── Task store ─────────────────────────────────────────────────

const MAX_TASKS = 1000;

export interface TaskStore {
  get(id: string): Task | undefined;
  set(id: string, task: Task): void;
  delete(id: string): boolean;
  keys(): IterableIterator<string>;
  readonly size: number;
  clear(): void;
  entries(): IterableIterator<[string, Task]>;
}

export function createTaskStore(): TaskStore {
  return new Map<string, Task>();
}

function evictStaleTasks(store: TaskStore): void {
  if (store.size <= MAX_TASKS) return;
  // Remove completed/failed/canceled tasks first (oldest first via Map insertion order)
  for (const [id, task] of store.entries()) {
    if (store.size <= MAX_TASKS * 0.8) break;
    if (
      task.status.state === "completed" ||
      task.status.state === "failed" ||
      task.status.state === "canceled"
    ) {
      store.delete(id);
    }
  }
  // If still over limit, remove oldest regardless of state
  if (store.size > MAX_TASKS) {
    const toRemove = store.size - MAX_TASKS;
    let removed = 0;
    for (const id of store.keys()) {
      if (removed >= toRemove) break;
      store.delete(id);
      removed++;
    }
  }
}

function getOrCreateTask(store: TaskStore, id: string): Task {
  let task = store.get(id);
  if (!task) {
    task = {
      id,
      status: {
        state: "submitted",
        timestamp: new Date().toISOString(),
      },
      history: [],
      artifacts: [],
    };
    store.set(id, task);
  }
  return task;
}

function updateTaskState(task: Task, state: TaskState, agentMessage?: Message): void {
  task.status = {
    state,
    message: agentMessage,
    timestamp: new Date().toISOString(),
  };
  if (agentMessage) {
    task.history = task.history ?? [];
    task.history.push(agentMessage);
  }
}

// ── Task handler — maps A2A tasks to am operations ────────────

/** Handler function type for processing incoming A2A tasks. */
export type TaskHandler = (
  userMessage: Message,
  config: ResolvedConfig,
) => Promise<{ message: Message; artifacts?: Artifact[] }>;

/**
 * Default task handler that routes text commands to am operations.
 *
 * Recognized commands:
 *   "status"  — return am status summary
 *   "config"  — return resolved config summary
 *   "servers" — list MCP servers
 *   "agents"  — list agent profiles
 *   "apply"   — describe what apply would do (read-only)
 *   *         — echo back the message as unsupported
 */
export const defaultTaskHandler: TaskHandler = async (userMessage, config) => {
  const textPart = userMessage.parts.find((p) => p.type === "text") as TextPart | undefined;
  const command = textPart?.text?.trim().toLowerCase() ?? "";

  if (command === "status" || command === "adapter.status") {
    const serverCount = Object.keys(config.servers).length;
    const agentCount = Object.keys(config.agents).length;
    const profile = config.profile;

    return {
      message: {
        role: "agent" as const,
        parts: [
          {
            type: "data" as const,
            data: {
              profile,
              servers: serverCount,
              agents: agentCount,
              adapters: Object.keys(config.adapters),
            },
          },
          {
            type: "text" as const,
            text: `agent-manager status: profile=${profile}, ${serverCount} server(s), ${agentCount} agent(s)`,
          },
        ],
      },
    };
  }

  if (command === "config" || command === "config.read") {
    return {
      message: {
        role: "agent" as const,
        parts: [
          {
            type: "data" as const,
            data: {
              profile: config.profile,
              servers: Object.keys(config.servers),
              agents: Object.keys(config.agents),
              instructions: Object.keys(config.instructions),
              skills: Object.keys(config.skills),
            },
          },
        ],
      },
    };
  }

  if (command === "servers" || command === "registry.search") {
    const servers = Object.entries(config.servers).map(([name, srv]) => ({
      name,
      command: srv.command,
      args: srv.args,
      tags: srv.tags,
      enabled: srv.enabled,
    }));

    return {
      message: {
        role: "agent" as const,
        parts: [{ type: "data" as const, data: { servers } }],
      },
      artifacts: [
        {
          name: "servers.json",
          description: "MCP server definitions",
          parts: [{ type: "data" as const, data: { servers } }],
        },
      ],
    };
  }

  if (command === "agents") {
    const agents = Object.entries(config.agents).map(([name, agent]) => ({
      name,
      description: agent.description,
      model: agent.model,
      tools: agent.tools,
      mcp_servers: agent.mcp_servers,
    }));

    return {
      message: {
        role: "agent" as const,
        parts: [{ type: "data" as const, data: { agents } }],
      },
    };
  }

  if (command === "apply" || command === "adapter.apply") {
    return {
      message: {
        role: "agent" as const,
        parts: [
          {
            type: "text" as const,
            text: "Apply is a write operation. Use the MCP server (`am mcp-serve`) or the CLI (`am apply`) to generate native configs.",
          },
        ],
      },
    };
  }

  if (command === "config.write") {
    return {
      message: {
        role: "agent" as const,
        parts: [
          {
            type: "text" as const,
            text: "Config write is a write operation. Use the MCP server (`am mcp-serve`) or the CLI (`am config edit`) to modify configuration.",
          },
        ],
      },
    };
  }

  if (command === "registry.install") {
    return {
      message: {
        role: "agent" as const,
        parts: [
          {
            type: "text" as const,
            text: "Registry install is a write operation. Use the MCP server (`am mcp-serve`) or the CLI (`am install <package>`) to install from the registry.",
          },
        ],
      },
    };
  }

  // Default: unrecognized command
  return {
    message: {
      role: "agent" as const,
      parts: [
        {
          type: "text" as const,
          text: `Unrecognized command: "${command}". Available: status, config, servers, agents, apply, config.read, config.write, registry.search, registry.install, adapter.apply, adapter.status`,
        },
      ],
    },
  };
};

// ── JSON-RPC handler ───────────────────────────────────────────

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): A2AJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  };
}

function jsonRpcSuccess(id: string | number | null, result: unknown): A2AJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function handleJsonRpc(
  req: A2AJsonRpcRequest,
  config: ResolvedConfig,
  handler: TaskHandler,
  store: TaskStore,
): A2AJsonRpcResponse {
  const { id, method, params } = req;

  switch (method) {
    case "tasks/send": {
      const p = params as unknown as TaskSendParams | undefined;
      if (!p?.id || !p?.message) {
        return jsonRpcError(id, -32602, "Invalid params: id and message required");
      }

      const task = getOrCreateTask(store, p.id);
      // Record the user message
      task.history = task.history ?? [];
      task.history.push(p.message);
      updateTaskState(task, "working");

      // Run handler asynchronously — don't block the response
      const TERMINAL_STATES: TaskState[] = ["completed", "failed", "canceled"];
      handler(p.message, config)
        .then((result) => {
          if (TERMINAL_STATES.includes(task.status.state)) return; // guard: canceled before completion
          task.artifacts = result.artifacts ?? task.artifacts;
          updateTaskState(task, "completed", result.message);
        })
        .catch((err: unknown) => {
          if (TERMINAL_STATES.includes(task.status.state)) return; // guard: canceled before failure
          const message = err instanceof Error ? err.message : String(err);
          updateTaskState(task, "failed", {
            role: "agent",
            parts: [{ type: "text", text: `Task failed: ${message}` }],
          });
        })
        .finally(() => {
          evictStaleTasks(store);
        });

      // Return immediately with state: "working"
      return jsonRpcSuccess(id, task);
    }

    case "tasks/get": {
      const p = params as unknown as TaskQueryParams | undefined;
      if (!p?.id) {
        return jsonRpcError(id, -32602, "Invalid params: id required");
      }

      const task = store.get(p.id);
      if (!task) {
        return jsonRpcError(id, -32001, `Task not found: ${p.id}`);
      }

      // Optionally trim history
      if (p.historyLength != null && task.history) {
        const trimmed = {
          ...task,
          history: p.historyLength === 0 ? [] : task.history.slice(-p.historyLength),
        };
        return jsonRpcSuccess(id, trimmed);
      }

      return jsonRpcSuccess(id, task);
    }

    case "tasks/cancel": {
      const p = params as unknown as TaskCancelParams | undefined;
      if (!p?.id) {
        return jsonRpcError(id, -32602, "Invalid params: id required");
      }

      const task = store.get(p.id);
      if (!task) {
        return jsonRpcError(id, -32001, `Task not found: ${p.id}`);
      }

      if (task.status.state === "completed" || task.status.state === "failed") {
        return jsonRpcError(id, -32003, `Cannot cancel task in state: ${task.status.state}`);
      }

      updateTaskState(task, "canceled", {
        role: "agent",
        parts: [{ type: "text", text: "Task canceled by client." }],
      });

      return jsonRpcSuccess(id, task);
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Hono route factory ──────────────────────────────────────────

export interface A2AServerOptions {
  /** Resolved config to serve. */
  config: ResolvedConfig;
  /** Options for Agent Card generation. */
  cardOptions: GenerateCardOptions;
  /** Optional custom task handler. Defaults to defaultTaskHandler. */
  taskHandler?: TaskHandler;
  /** Optional task store. Each call creates its own store if not provided. */
  taskStore?: TaskStore;
}

/**
 * Create Hono routes for A2A protocol endpoints.
 * Mount the returned Hono app on your main server.
 *
 * Each call gets its own task store (no global singleton).
 *
 * Routes:
 *   GET  /.well-known/agent.json  — A2A Agent Card
 *   POST /a2a                     — A2A JSON-RPC 2.0 endpoint
 */
export function createA2ARoutes(options: A2AServerOptions): Hono {
  const {
    config,
    cardOptions,
    taskHandler = defaultTaskHandler,
    taskStore: externalStore,
  } = options;
  const store = externalStore ?? createTaskStore();
  const a2aApp = new Hono();

  // Agent Card endpoint
  a2aApp.get("/.well-known/agent.json", (c) => {
    const card = generateAgentCard(config, cardOptions);
    return c.json(card);
  });

  // A2A JSON-RPC endpoint
  a2aApp.post("/a2a", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(jsonRpcError(null, -32700, "Parse error: invalid JSON"), 400);
    }

    const req = body as A2AJsonRpcRequest;
    if (!req.jsonrpc || req.jsonrpc !== "2.0" || !req.method) {
      return c.json(jsonRpcError(req?.id ?? null, -32600, "Invalid JSON-RPC request"), 400);
    }

    const response = handleJsonRpc(req, config, taskHandler, store);
    return c.json(response);
  });

  // Expose store for testing
  (a2aApp as Hono & { _taskStore: TaskStore })._taskStore = store;

  return a2aApp;
}

/** Get the task store from a Hono app created by createA2ARoutes. */
export function getAppTaskStore(app: Hono): TaskStore {
  return (app as Hono & { _taskStore: TaskStore })._taskStore;
}
