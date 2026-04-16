/**
 * A2A Server Adapter — expose agent-manager as an A2A-compatible agent.
 *
 * Hono routes:
 *   GET  /.well-known/agent.json  — Agent Card
 *   POST /a2a                     — JSON-RPC 2.0 endpoint
 *
 * Supported methods:
 *   tasks/send          — create/update a task (returns immediately, runs handler async)
 *   tasks/sendSubscribe — create/update a task, returns SSE stream of status updates
 *   tasks/get           — query task status (used for polling)
 *   tasks/cancel        — cancel a running task
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
  TaskArtifactUpdateEvent,
  TaskCancelParams,
  TaskQueryParams,
  TaskSendParams,
  TaskState,
  TaskStatusUpdateEvent,
  TextPart,
} from "./types";

// ── Task store ─────────────────────────────────────────────────

const MAX_TASKS = 1000;
/** Tasks in terminal state older than this are eligible for TTL eviction. */
export const TASK_TTL_MS = 3_600_000; // 1 hour

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

// ── Task event emitter ────────────────────────────────────────

export type TaskEventType = "status" | "artifact";

export interface TaskEvent {
  type: TaskEventType;
  taskId: string;
  data: TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
}

export type TaskEventListener = (event: TaskEvent) => void;

/**
 * Simple event emitter for task state changes. Listeners subscribe per-task
 * and receive status/artifact events as they happen.
 */
export class TaskEventEmitter {
  private listeners = new Map<string, Set<TaskEventListener>>();

  on(taskId: string, listener: TaskEventListener): void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
  }

  off(taskId: string, listener: TaskEventListener): void {
    const set = this.listeners.get(taskId);
    if (set) {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(taskId);
    }
  }

  emit(event: TaskEvent): void {
    const set = this.listeners.get(event.taskId);
    if (set) {
      for (const listener of set) {
        listener(event);
      }
    }
  }

  /** Remove all listeners for a task (used after stream closes). */
  removeAll(taskId: string): void {
    this.listeners.delete(taskId);
  }
}

function isTerminalState(state: TaskState): boolean {
  return state === "completed" || state === "failed" || state === "canceled";
}

function evictStaleTasks(store: TaskStore): void {
  const now = Date.now();

  // Phase 1: TTL — remove terminal tasks older than TASK_TTL_MS regardless of store size
  for (const [id, task] of store.entries()) {
    if (isTerminalState(task.status.state)) {
      const taskTime = new Date(task.status.timestamp).getTime();
      if (now - taskTime >= TASK_TTL_MS) {
        store.delete(id);
      }
    }
  }

  // Phase 2: capacity — only if still over MAX_TASKS after TTL cleanup
  if (store.size <= MAX_TASKS) return;

  // Remove remaining terminal tasks first (oldest first via Map insertion order)
  for (const [id, task] of store.entries()) {
    if (store.size <= MAX_TASKS * 0.8) break;
    if (isTerminalState(task.status.state)) {
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

function updateTaskState(
  task: Task,
  state: TaskState,
  agentMessage?: Message,
  emitter?: TaskEventEmitter,
): void {
  task.status = {
    state,
    message: agentMessage,
    timestamp: new Date().toISOString(),
  };
  if (agentMessage) {
    task.history = task.history ?? [];
    task.history.push(agentMessage);
  }
  if (emitter) {
    emitter.emit({
      type: "status",
      taskId: task.id,
      data: {
        id: task.id,
        status: task.status,
        final: isTerminalState(state),
      } satisfies TaskStatusUpdateEvent,
    });
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

/**
 * Start a task: record user message, set state to working, run handler async.
 * Shared by both tasks/send and tasks/sendSubscribe.
 */
function startTask(
  store: TaskStore,
  params: TaskSendParams,
  config: ResolvedConfig,
  handler: TaskHandler,
  emitter: TaskEventEmitter,
): Task {
  const task = getOrCreateTask(store, params.id);
  task.history = task.history ?? [];
  task.history.push(params.message);
  updateTaskState(task, "working", undefined, emitter);

  const TERMINAL_STATES: TaskState[] = ["completed", "failed", "canceled"];
  handler(params.message, config)
    .then((result) => {
      if (TERMINAL_STATES.includes(task.status.state)) return;
      if (result.artifacts) {
        task.artifacts = result.artifacts;
        for (const artifact of result.artifacts) {
          emitter.emit({
            type: "artifact",
            taskId: task.id,
            data: { id: task.id, artifact } satisfies TaskArtifactUpdateEvent,
          });
        }
      }
      updateTaskState(task, "completed", result.message, emitter);
    })
    .catch((err: unknown) => {
      if (TERMINAL_STATES.includes(task.status.state)) return;
      const message = err instanceof Error ? err.message : String(err);
      updateTaskState(task, "failed", {
        role: "agent",
        parts: [{ type: "text", text: `Task failed: ${message}` }],
      }, emitter);
    })
    .finally(() => {
      evictStaleTasks(store);
    });

  return task;
}

function handleJsonRpc(
  req: A2AJsonRpcRequest,
  config: ResolvedConfig,
  handler: TaskHandler,
  store: TaskStore,
  emitter: TaskEventEmitter,
): A2AJsonRpcResponse {
  const { id, method, params } = req;

  switch (method) {
    case "tasks/send": {
      const p = params as unknown as TaskSendParams | undefined;
      if (!p?.id || !p?.message) {
        return jsonRpcError(id, -32602, "Invalid params: id and message required");
      }

      const task = startTask(store, p, config, handler, emitter);

      // Return immediately with state: "working"
      return jsonRpcSuccess(id, task);
    }

    case "tasks/get": {
      const p = params as unknown as TaskQueryParams | undefined;
      if (!p?.id) {
        return jsonRpcError(id, -32602, "Invalid params: id required");
      }

      // Opportunistic eviction on read when store is large
      if (store.size > MAX_TASKS * 0.5) {
        evictStaleTasks(store);
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
      }, emitter);

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
  /** Optional event emitter. Each call creates its own emitter if not provided. */
  taskEventEmitter?: TaskEventEmitter;
  /** Optional bearer token for auth. When set, POST /a2a requires Authorization: Bearer <token>. */
  auth_token?: string;
  /**
   * Enable the A2A-ACP bridge (ADR-0026 Phase 4).
   * When true, incoming messages matching "run <agent>: <prompt>" or data parts
   * with {agent, prompt} are routed to a local ACP agent. Non-matching messages
   * fall through to the default (or custom) task handler.
   */
  enableBridge?: boolean;
  /** Bridge configuration (cwd, timeout, ACP settings). Only used when enableBridge is true. */
  bridgeConfig?: import("../bridge").BridgeConfig;
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
    taskStore: externalStore,
    taskEventEmitter: externalEmitter,
    auth_token,
    enableBridge,
    bridgeConfig,
  } = options;

  // Determine effective task handler: bridge wraps the base handler when enabled
  let taskHandler = options.taskHandler ?? defaultTaskHandler;
  if (enableBridge) {
    const { createBridgedTaskHandler } = require("../bridge") as typeof import("../bridge");
    taskHandler = createBridgedTaskHandler(taskHandler, bridgeConfig);
  }
  const store = externalStore ?? createTaskStore();
  const emitter = externalEmitter ?? new TaskEventEmitter();
  const a2aApp = new Hono();

  // Agent Card endpoint — public by design (A2A spec)
  a2aApp.get("/.well-known/agent.json", (c) => {
    const card = generateAgentCard(config, cardOptions);
    return c.json(card);
  });

  // Bearer token auth middleware for POST /a2a
  if (auth_token) {
    a2aApp.use("/a2a", async (c, next) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader || authHeader !== `Bearer ${auth_token}`) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      await next();
    });
  }

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

    // tasks/sendSubscribe returns an SSE stream instead of a JSON-RPC response
    if (req.method === "tasks/sendSubscribe") {
      const p = req.params as unknown as TaskSendParams | undefined;
      if (!p?.id || !p?.message) {
        return c.json(
          jsonRpcError(req.id, -32602, "Invalid params: id and message required"),
          200,
        );
      }

      const task = startTask(store, p, config, taskHandler, emitter);

      // If the task already completed synchronously (very fast handler), return JSON
      if (isTerminalState(task.status.state)) {
        return c.json(jsonRpcSuccess(req.id, task));
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const send = (event: string, data: unknown) => {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          };

          // Send initial status
          send("status", {
            id: task.id,
            status: task.status,
            final: false,
          } satisfies TaskStatusUpdateEvent);

          const listener: TaskEventListener = (evt) => {
            if (evt.type === "status") {
              send("status", evt.data);
              if ((evt.data as TaskStatusUpdateEvent).final) {
                emitter.off(task.id, listener);
                controller.close();
              }
            } else if (evt.type === "artifact") {
              send("artifact", evt.data);
            }
          };

          emitter.on(task.id, listener);

          // Clean up if the client disconnects
          c.req.raw.signal.addEventListener("abort", () => {
            emitter.off(task.id, listener);
            try {
              controller.close();
            } catch {
              // Stream may already be closed
            }
          });
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const response = handleJsonRpc(req, config, taskHandler, store, emitter);
    return c.json(response);
  });

  // Expose store and emitter for testing
  (a2aApp as Hono & { _taskStore: TaskStore; _taskEventEmitter: TaskEventEmitter })._taskStore =
    store;
  (
    a2aApp as Hono & { _taskStore: TaskStore; _taskEventEmitter: TaskEventEmitter }
  )._taskEventEmitter = emitter;

  return a2aApp;
}

/** Get the task store from a Hono app created by createA2ARoutes. */
export function getAppTaskStore(app: Hono): TaskStore {
  return (app as Hono & { _taskStore: TaskStore })._taskStore;
}

/** Get the event emitter from a Hono app created by createA2ARoutes. */
export function getAppTaskEventEmitter(app: Hono): TaskEventEmitter {
  return (app as Hono & { _taskEventEmitter: TaskEventEmitter })._taskEventEmitter;
}
