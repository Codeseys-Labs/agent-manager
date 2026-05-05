/**
 * CommunityAdapterProxy: implements the Adapter interface by forwarding
 * method calls as JSON-RPC 2.0 over stdio to a child process.
 *
 * The subprocess stays alive for the duration of the am command to avoid
 * repeated startup costs.
 */

import type { Subprocess } from "bun";
import { sandboxEnv } from "../../protocols/acp/env-sandbox";
import type {
  Adapter,
  AdapterMeta,
  AdapterSchema,
  DetectResult,
  DiffResult,
  ExportOptions,
  ExportResult,
  ImportOptions,
  ImportResult,
  ResolvedConfig,
} from "../types.ts";
import type { InitializeResult, JsonRpcRequest, JsonRpcResponse } from "./types.ts";

const PROTOCOL_VERSION = "1.0";
const RPC_TIMEOUT_MS = 30_000;

export class CommunityAdapterProxy implements Adapter {
  private process: Subprocess | null = null;
  private nextId = 1;
  private buffer = "";
  private pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  meta: AdapterMeta;
  schema: AdapterSchema;

  private constructor(
    private command: string,
    private args: string[],
    meta: AdapterMeta,
    schema: AdapterSchema,
    private extraEnv?: Record<string, string>,
  ) {
    this.meta = meta;
    this.schema = schema;
  }

  /**
   * Create and initialize a community adapter proxy.
   * Spawns the subprocess, performs the initialize handshake, and fetches meta + schema.
   *
   * Security (B-03 / REV-2 HIGH-3 propagation): the child env is scrubbed via
   * `sandboxEnv(opts?.env)` so `AM_ENCRYPTION_KEY`, `AM_MCP_TOKEN`, AWS / GitHub /
   * provider tokens, etc. do NOT leak into the community adapter subprocess.
   */
  static async create(
    command: string,
    args: string[] = [],
    opts?: { env?: Record<string, string> },
  ): Promise<CommunityAdapterProxy> {
    const proxy = new CommunityAdapterProxy(command, args, {} as AdapterMeta, {}, opts?.env);
    proxy.spawn();
    await proxy.initialize();
    return proxy;
  }

  private spawn(): void {
    this.process = Bun.spawn([this.command, ...this.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // B-03 fix: scrub parent env. Without this, the child inherited
      // `process.env` wholesale (AM_ENCRYPTION_KEY, AM_MCP_TOKEN, AWS_*,
      // ANTHROPIC_API_KEY, GITHUB_TOKEN, ...). Mirrors AmAcpClient.connect.
      env: sandboxEnv(this.extraEnv),
    });
    this.readLoop();
  }

  private readLoop(): void {
    if (!this.process?.stdout) return;
    const stdout = this.process.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();

    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer += new TextDecoder().decode(value);
          this.processBuffer();
        }
      } catch {
        // Process exited — reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error("Community adapter process exited unexpectedly"));
        }
        this.pendingRequests.clear();
      }
    };
    read();
  }

  private processBuffer(): void {
    // JSON-RPC messages are newline-delimited
    let newlineIdx: number = this.buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const response: JsonRpcResponse = JSON.parse(line);
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          if (response.error) {
            pending.reject(
              new Error(`JSON-RPC error ${response.error.code}: ${response.error.message}`),
            );
          } else {
            pending.resolve(response.result);
          }
        }
      } catch {
        // Ignore malformed lines (could be stderr leaking or adapter debug output)
      }
      newlineIdx = this.buffer.indexOf("\n");
    }
  }

  private async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.process?.stdin) {
      throw new Error("Community adapter process is not running");
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const line = `${JSON.stringify(request)}\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`JSON-RPC call to "${method}" timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      (this.process!.stdin as import("bun").FileSink).write(line);
    });
  }

  private async initialize(): Promise<void> {
    const { AM_VERSION } = await import("../../lib/version");
    const amVersion = AM_VERSION;

    const initResult = (await this.call("adapter/initialize", {
      protocolVersion: PROTOCOL_VERSION,
      amVersion,
    })) as InitializeResult;

    if (!initResult?.protocolVersion) {
      throw new Error("Community adapter did not return a valid initialize response");
    }

    // Fetch meta and schema
    this.meta = (await this.call("adapter/meta", {})) as AdapterMeta;
    if (!this.meta?.name) {
      throw new Error("Community adapter did not return valid metadata");
    }

    // Schema is returned as JSON Schema (not Zod) — store as-is for now.
    // Future: convert JSON Schema to Zod for validation.
    const schemaResult = (await this.call("adapter/schema", {})) as Record<string, unknown>;
    this.schema = schemaResult as unknown as AdapterSchema;
  }

  async detect(): Promise<DetectResult> {
    const result = await this.call("adapter/detect", {});
    return result as DetectResult;
  }

  async import(options: ImportOptions): Promise<ImportResult> {
    const result = await this.call("adapter/import", options as unknown as Record<string, unknown>);
    return result as ImportResult;
  }

  async export(config: ResolvedConfig, options: ExportOptions): Promise<ExportResult> {
    const result = await this.call("adapter/export", { config, options });
    return result as ExportResult;
  }

  async diff(config: ResolvedConfig): Promise<DiffResult> {
    const result = await this.call("adapter/diff", { config });
    return result as DiffResult;
  }

  /** Check if the subprocess is still alive. */
  isAlive(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /** Kill the child process. Called when am exits. */
  kill(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Community adapter proxy was killed"));
    }
    this.pendingRequests.clear();
  }
}
