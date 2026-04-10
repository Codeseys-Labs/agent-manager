/**
 * A2A Server Adapter — expose agent-manager as an A2A-compatible agent.
 *
 * Hono routes:
 *   GET  /.well-known/agent.json  — Agent Card
 *   POST /a2a                     — JSON-RPC 2.0 endpoint
 *
 * Supported methods:
 *   tasks/send   — create/update a task (maps to am operations)
 *   tasks/get    — query task status
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

// ── In-memory task store ────────────────────────────────────────

const taskStore = new Map<string, Task>();
const MAX_TASKS = 1000;

function evictStaleTasks(): void {
  if (taskStore.size <= MAX_TASKS) return;
  // Remove completed/failed/canceled tasks first (oldest first via Map insertion order)
  for (const [id, task] of taskStore) {
    if (taskStore.size <= MAX_TASKS * 0.8) break;
    if (
      task.status.state === "completed" ||
      task.status.state === "failed" ||
      task.status.state === "canceled"
    ) {
      taskStore.delete(id);
    }
  }
  // If still over limit, remove oldest regardless of state
  if (taskStore.size > MAX_TASKS) {
    const toRemove = taskStore.size - MAX_TASKS;
    let removed = 0;
    for (const id of taskStore.keys()) {
      if (removed >= toRemove) break;
      taskStore.delete(id);
      removed++;
    }
  }
}

function getOrCreateTask(id: string): Task {
  let task = taskStore.get(id);
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
    taskStore.set(id, task);
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

  // Default: unrecognized command
  return {
    message: {
      role: "agent" as const,
      parts: [
        {
          type: "text" as const,
          text: `Unrecognized command: "${command}". Available: status, config, servers, agents, apply`,
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

async function handleJsonRpc(
  req: A2AJsonRpcRequest,
  config: ResolvedConfig,
  handler: TaskHandler,
): Promise<A2AJsonRpcResponse> {
  const { id, method, params } = req;

  switch (method) {
    case "tasks/send": {
      const p = params as unknown as TaskSendParams | undefined;
      if (!p?.id || !p?.message) {
        return jsonRpcError(id, -32602, "Invalid params: id and message required");
      }

      const task = getOrCreateTask(p.id);
      // Record the user message
      task.history = task.history ?? [];
      task.history.push(p.message);
      updateTaskState(task, "working");

      try {
        const result = await handler(p.message, config);
        task.artifacts = result.artifacts ?? task.artifacts;
        updateTaskState(task, "completed", result.message);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        updateTaskState(task, "failed", {
          role: "agent",
          parts: [{ type: "text", text: `Task failed: ${message}` }],
        });
      }

      evictStaleTasks();
      return jsonRpcSuccess(id, task);
    }

    case "tasks/get": {
      const p = params as unknown as TaskQueryParams | undefined;
      if (!p?.id) {
        return jsonRpcError(id, -32602, "Invalid params: id required");
      }

      const task = taskStore.get(p.id);
      if (!task) {
        return jsonRpcError(id, -32001, `Task not found: ${p.id}`);
      }

      // Optionally trim history
      if (p.historyLength != null && task.history) {
        const trimmed = { ...task, history: task.history.slice(-p.historyLength) };
        return jsonRpcSuccess(id, trimmed);
      }

      return jsonRpcSuccess(id, task);
    }

    case "tasks/cancel": {
      const p = params as unknown as TaskCancelParams | undefined;
      if (!p?.id) {
        return jsonRpcError(id, -32602, "Invalid params: id required");
      }

      const task = taskStore.get(p.id);
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
}

/**
 * Create Hono routes for A2A protocol endpoints.
 * Mount the returned Hono app on your main server.
 *
 * Routes:
 *   GET  /.well-known/agent.json  — A2A Agent Card
 *   POST /a2a                     — A2A JSON-RPC 2.0 endpoint
 */
export function createA2ARoutes(options: A2AServerOptions): Hono {
  const { config, cardOptions, taskHandler = defaultTaskHandler } = options;
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

    const response = await handleJsonRpc(req, config, taskHandler);
    return c.json(response);
  });

  return a2aApp;
}

/** Clear the in-memory task store. Useful for testing. */
export function clearTaskStore(): void {
  taskStore.clear();
}

/** Get all tasks. Useful for debugging/testing. */
export function getAllTasks(): Map<string, Task> {
  return new Map(taskStore);
}
