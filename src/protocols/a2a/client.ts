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
}

/** Convenience: create a client with default options. */
export function createA2AClient(opts?: A2AClientOptions): A2AClient {
  return new A2AClient(opts);
}
