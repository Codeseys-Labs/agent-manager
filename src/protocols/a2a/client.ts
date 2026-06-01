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
  TaskArtifactUpdateEvent,
  TaskCancelParams,
  TaskQueryParams,
  TaskSendParams,
  TaskState,
  TaskStatusUpdateEvent,
} from "./types";
import { AgentCardSchema, validateRemoteUrl } from "./url-guard";
import { A2A_PROTOCOL_VERSION, A2A_VERSION_HEADER } from "./version";

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
  /**
   * SEC-3: allow A2A requests to private/loopback/link-local hosts. Defaults
   * to the `AM_A2A_ALLOW_PRIVATE` env var (off). Intended for local
   * development against `http://localhost:...` agents only.
   */
  allowPrivateNetwork?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────

let rpcIdCounter = 0;

function nextRpcId(): number {
  return ++rpcIdCounter;
}

function buildAuthHeaders(opts?: A2AClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Wave C: send A2A-Version on every request per v0.3 MUST. Servers
    // that ignore the header are unaffected; conformant servers use it
    // to version-gate semantics.
    [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
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
   * Discover an agent by fetching its Agent Card.
   *
   * Wave C: most A2A peers in the wild still serve the legacy
   * `/.well-known/agent.json`. v0.3 standardized the canonical URL at
   * `/.well-known/agent-card.json` but requires servers to keep the
   * legacy path for backward compatibility. We probe legacy first (best
   * compatibility with deployed peers) then fall back to the canonical
   * path. Returns null when both 404.
   */
  async discoverAgent(baseUrl: string): Promise<AgentCard | null> {
    // SEC-3: reject non-http(s) schemes and (unless opted in) private/internal
    // targets before issuing any request.
    validateRemoteUrl(baseUrl, { allowPrivateNetwork: this.opts.allowPrivateNetwork });
    const base = normalizeUrl(baseUrl);
    const candidates = [`${base}/.well-known/agent.json`, `${base}/.well-known/agent-card.json`];
    const timeout = this.opts.timeout ?? 30_000;

    let lastError: A2AClientError | null = null;
    for (const url of candidates) {
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "GET",
          headers: buildAuthHeaders(this.opts),
          signal: AbortSignal.timeout(timeout),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = new A2AClientError(`Failed to fetch agent card from ${url}: ${message}`);
        continue;
      }

      if (resp.status === 404) continue;
      if (!resp.ok) {
        lastError = new A2AClientError(
          `Agent card request failed: ${resp.status} ${resp.statusText}`,
          resp.status,
        );
        continue;
      }

      // SEC-3: the card is untrusted remote JSON — validate its shape before
      // returning it to callers that index into required fields.
      const card = AgentCardSchema.parse(await resp.json()) as AgentCard;
      return card;
    }

    // Both paths 404'd → agent simply not found. Otherwise propagate the
    // last transport/HTTP error so the caller can distinguish "no agent"
    // from "network failure".
    if (lastError) throw lastError;
    return null;
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
    // SEC-3: gate every task RPC behind the SSRF guard.
    validateRemoteUrl(baseUrl, { allowPrivateNetwork: this.opts.allowPrivateNetwork });
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

  /**
   * Send a task and subscribe to real-time SSE updates via tasks/sendSubscribe.
   * The returned promise resolves when the stream closes (task reaches terminal state).
   *
   * @param baseUrl The agent's base URL.
   * @param params Task send parameters (id, message, optional metadata).
   * @param callbacks Callbacks for status and artifact updates.
   * @returns The final TaskStatusUpdateEvent when the stream closes.
   */
  async sendSubscribe(
    baseUrl: string,
    params: TaskSendParams,
    callbacks: SubscribeCallbacks,
  ): Promise<TaskStatusUpdateEvent> {
    const endpoint = this.resolveEndpoint(baseUrl);
    const timeout = this.opts.timeout ?? 30_000;

    const request: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      id: nextRpcId(),
      method: "tasks/sendSubscribe",
      params: params as unknown as Record<string, unknown>,
    };

    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: buildAuthHeaders(this.opts),
        body: JSON.stringify(request),
        signal: callbacks.signal ?? AbortSignal.timeout(timeout),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new A2AClientError(`A2A sendSubscribe to ${endpoint} failed: ${message}`);
    }

    if (!resp.ok) {
      throw new A2AClientError(
        `A2A sendSubscribe request failed: ${resp.status} ${resp.statusText}`,
        resp.status,
      );
    }

    const contentType = resp.headers.get("Content-Type") ?? "";

    // If the server returned JSON instead of SSE (e.g., task already terminal), parse it
    if (contentType.includes("application/json")) {
      const json = (await resp.json()) as A2AJsonRpcResponse;
      if (json.error) {
        throw new A2AClientError(json.error.message, json.error.code, json.error.data);
      }
      const task = json.result as Task;
      const finalEvent: TaskStatusUpdateEvent = {
        id: task.id,
        status: task.status,
        final: true,
      };
      callbacks.onStatus?.(finalEvent);
      return finalEvent;
    }

    // Parse the SSE stream
    return parseSSEStream(resp, callbacks);
  }
}

// ── Subscribe callbacks ───────────────────────────────────────

export interface SubscribeCallbacks {
  /** Called for each status update event. */
  onStatus?: (event: TaskStatusUpdateEvent) => void;
  /** Called for each artifact event. */
  onArtifact?: (event: TaskArtifactUpdateEvent) => void;
  /** Abort signal to cancel the subscription. */
  signal?: AbortSignal;
}

/**
 * Parse an SSE response body and dispatch events to callbacks.
 * Returns the final TaskStatusUpdateEvent when the stream closes.
 */
async function parseSSEStream(
  resp: Response,
  callbacks: SubscribeCallbacks,
): Promise<TaskStatusUpdateEvent> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastStatusEvent: TaskStatusUpdateEvent | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE messages (delimited by double newlines)
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!; // Keep incomplete message in buffer

      for (const part of parts) {
        if (!part.trim()) continue;

        let eventType = "message";
        let dataStr = "";

        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            dataStr += line.slice(6);
          }
        }

        if (!dataStr) continue;

        try {
          const data = JSON.parse(dataStr);

          if (eventType === "status") {
            const statusEvent = data as TaskStatusUpdateEvent;
            lastStatusEvent = statusEvent;
            callbacks.onStatus?.(statusEvent);
            if (statusEvent.final) {
              reader.cancel();
              return statusEvent;
            }
          } else if (eventType === "artifact") {
            callbacks.onArtifact?.(data as TaskArtifactUpdateEvent);
          }
        } catch {
          // Skip malformed JSON in SSE data
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new A2AClientError("Subscription aborted");
    }
    throw err;
  }

  if (lastStatusEvent) return lastStatusEvent;
  throw new A2AClientError("SSE stream ended without a final status event");
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
