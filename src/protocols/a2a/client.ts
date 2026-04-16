/**
 * A2A Client — Discovers agents and delegates tasks via A2A JSON-RPC.
 *
 * Operations:
 *   - discoverAgent(url)  — fetch Agent Card from /.well-known/agent.json
 *   - sendTask(url, params)  — tasks/send JSON-RPC call
 *   - getTask(url, params)   — tasks/get JSON-RPC call
 *   - cancelTask(url, params) — tasks/cancel JSON-RPC call
 */

import type {
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  AgentCard,
  Task,
  TaskCancelParams,
  TaskQueryParams,
  TaskSendParams,
  TaskState,
} from "./types";

// ── Error types ─────────────────────────────────────────────────

export class A2AClientError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown,
  ) {
    super(message);
    this.name = "A2AClientError";
  }
}

// ── Client options ──────────────────────────────────────────────

export interface A2AClientOptions {
  /** Timeout for HTTP requests in milliseconds. Default: 30000 */
  timeout?: number;
  /** Bearer token for authenticated endpoints */
  bearerToken?: string;
  /** API key for authenticated endpoints */
  apiKey?: string;
}

// ── Helpers ─────────────────────────────────────────────────────

let rpcIdCounter = 0;

function nextRpcId(): number {
  return ++rpcIdCounter;
}

function buildAuthHeaders(opts?: A2AClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts?.bearerToken) {
    headers.Authorization = `Bearer ${opts.bearerToken}`;
  } else if (opts?.apiKey) {
    headers["X-API-Key"] = opts.apiKey;
  }
  return headers;
}

/** Normalize a base URL to ensure no trailing slash. */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

// ── Client ──────────────────────────────────────────────────────

export class A2AClient {
  private readonly opts: A2AClientOptions;

  constructor(opts?: A2AClientOptions) {
    this.opts = opts ?? {};
  }

  /**
   * Discover an agent by fetching its Agent Card from /.well-known/agent.json.
   * Returns null if the agent card is not found (404).
   */
  async discoverAgent(baseUrl: string): Promise<AgentCard | null> {
    const url = `${normalizeUrl(baseUrl)}/.well-known/agent.json`;
    const timeout = this.opts.timeout ?? 30_000;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: buildAuthHeaders(this.opts),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new A2AClientError(`Failed to fetch agent card from ${url}: ${message}`);
    }

    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new A2AClientError(
        `Agent card request failed: ${resp.status} ${resp.statusText}`,
        resp.status,
      );
    }

    const card = (await resp.json()) as AgentCard;
    return card;
  }

  /**
   * Send a JSON-RPC call to the A2A endpoint.
   * The endpoint URL should be the A2A JSON-RPC URL (e.g., https://host/a2a).
   */
  private async rpcCall(
    endpointUrl: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<A2AJsonRpcResponse> {
    const timeout = this.opts.timeout ?? 30_000;

    const request: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      id: nextRpcId(),
      method,
      params,
    };

    let resp: Response;
    try {
      resp = await fetch(endpointUrl, {
        method: "POST",
        headers: buildAuthHeaders(this.opts),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new A2AClientError(`A2A RPC call to ${endpointUrl} failed: ${message}`);
    }

    if (!resp.ok) {
      throw new A2AClientError(
        `A2A RPC request failed: ${resp.status} ${resp.statusText}`,
        resp.status,
      );
    }

    const result = (await resp.json()) as A2AJsonRpcResponse;

    if (result.error) {
      throw new A2AClientError(result.error.message, result.error.code, result.error.data);
    }

    return result;
  }

  /**
   * Resolve the A2A JSON-RPC endpoint from a base URL.
   * Convention: base URL + /a2a
   */
  private resolveEndpoint(baseUrl: string): string {
    return `${normalizeUrl(baseUrl)}/a2a`;
  }

  /**
   * Send a task to a remote agent via tasks/send.
   * @param baseUrl The agent's base URL (A2A endpoint resolved as baseUrl/a2a).
   * @param params Task send parameters (id, message, optional metadata).
   * @returns The created or updated Task.
   */
  async sendTask(baseUrl: string, params: TaskSendParams): Promise<Task> {
    const endpoint = this.resolveEndpoint(baseUrl);
    const resp = await this.rpcCall(
      endpoint,
      "tasks/send",
      params as unknown as Record<string, unknown>,
    );
    return resp.result as Task;
  }

  /**
   * Query a task's current state via tasks/get.
   * @param baseUrl The agent's base URL.
   * @param params Task query parameters (id, optional historyLength).
   * @returns The Task with current status.
   */
  async getTask(baseUrl: string, params: TaskQueryParams): Promise<Task> {
    const endpoint = this.resolveEndpoint(baseUrl);
    const resp = await this.rpcCall(
      endpoint,
      "tasks/get",
      params as unknown as Record<string, unknown>,
    );
    return resp.result as Task;
  }

  /**
   * Cancel a running task via tasks/cancel.
   * @param baseUrl The agent's base URL.
   * @param params Task cancel parameters (id).
   * @returns The canceled Task.
   */
  async cancelTask(baseUrl: string, params: TaskCancelParams): Promise<Task> {
    const endpoint = this.resolveEndpoint(baseUrl);
    const resp = await this.rpcCall(
      endpoint,
      "tasks/cancel",
      params as unknown as Record<string, unknown>,
    );
    return resp.result as Task;
  }

  /**
   * Poll a task until it reaches a terminal state (completed, failed, canceled).
   * @param baseUrl The agent's base URL.
   * @param taskId The task ID to poll.
   * @param opts Polling options (interval, max attempts, abort signal).
   * @returns The final Task once it reaches a terminal state.
   */
  async pollTask(baseUrl: string, taskId: string, opts?: PollTaskOptions): Promise<Task> {
    return pollTaskImpl(this, baseUrl, taskId, opts);
  }
}

// ── Poll options ───────────────────────────────────────────────

export interface PollTaskOptions {
  /** Polling interval in milliseconds. Default: 1000 */
  intervalMs?: number;
  /** Maximum number of poll attempts. Default: 60 */
  maxAttempts?: number;
  /** Abort signal to cancel polling. */
  signal?: AbortSignal;
}

/** Terminal task states — polling stops when the task reaches one of these. */
const TERMINAL_STATES = new Set(["completed", "failed", "canceled"]);

/**
 * Poll a task until it reaches a terminal state (completed, failed, canceled).
 * @param baseUrl The agent's base URL.
 * @param taskId The task ID to poll.
 * @param opts Polling options (interval, max attempts, abort signal).
 * @returns The final Task once it reaches a terminal state.
 * @throws A2AClientError if max attempts exceeded or polling is aborted.
 */
async function pollTaskImpl(
  client: A2AClient,
  baseUrl: string,
  taskId: string,
  opts?: PollTaskOptions,
): Promise<Task> {
  const intervalMs = opts?.intervalMs ?? 1000;
  const maxAttempts = opts?.maxAttempts ?? 60;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts?.signal?.aborted) {
      throw new A2AClientError("Polling aborted");
    }

    const task = await client.getTask(baseUrl, { id: taskId });

    if (TERMINAL_STATES.has(task.status.state)) {
      return task;
    }

    // Wait before next poll
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      if (opts?.signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new A2AClientError("Polling aborted"));
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  throw new A2AClientError(`Polling timed out after ${maxAttempts} attempts for task ${taskId}`);
}

/** Convenience: create a client with default options. */
export function createA2AClient(opts?: A2AClientOptions): A2AClient {
  return new A2AClient(opts);
}

/**
 * Send a task and poll until it completes. Convenience wrapper that combines
 * sendTask + pollTask into a single call.
 */
export async function sendAndPoll(
  client: A2AClient,
  baseUrl: string,
  params: TaskSendParams,
  pollOpts?: PollTaskOptions,
): Promise<Task> {
  const task = await client.sendTask(baseUrl, params);
  if (TERMINAL_STATES.has(task.status.state)) {
    return task;
  }
  return pollTaskImpl(client, baseUrl, task.id, pollOpts);
}
