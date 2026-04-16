/**
 * CommunityAdapterProxy: implements the Adapter interface by forwarding
 * method calls as JSON-RPC 2.0 over stdio to a child process.
 *
 * The subprocess stays alive for the duration of the am command to avoid
 * repeated startup costs.
 */

import type { Subprocess } from "bun";
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
  ) {
    this.meta = meta;
    this.schema = schema;
  }

  /**
   * Create and initialize a community adapter proxy.
   * Spawns the subprocess, performs the initialize handshake, and fetches meta + schema.
   */
  static async create(command: string, args: string[] = []): Promise<CommunityAdapterProxy> {
    const proxy = new CommunityAdapterProxy(command, args, {} as AdapterMeta, {});
    proxy.spawn();
    await proxy.initialize();
    return proxy;
  }

  private spawn(): void {
    this.process = Bun.spawn([this.command, ...this.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.readLoop();
  }

  private readLoop(): void {
    if (!this.process?.stdout) return;
    const reader = this.process.stdout.getReader();

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
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
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

      this.process!.stdin!.write(line);
    });
  }

  private async initialize(): Promise<void> {
    const amVersion = process.env.BUILD_VERSION ?? "0.1.0";

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

  detect(): DetectResult {
    // detect() in the Adapter interface is synchronous, but community adapters
    // need async IPC. We use a blocking pattern: call detectAsync() separately.
    // For registry enumeration, use detectAsync() instead.
    return { installed: false, paths: {} };
  }

  /** Async version of detect() for community adapters. */
  async detectAsync(projectPath?: string): Promise<DetectResult> {
    const result = await this.call("adapter/detect", { projectPath });
    return result as DetectResult;
  }

  import(options: ImportOptions): ImportResult {
    // Synchronous stub — use importAsync() for actual IPC.
    return { servers: [], instructions: [], skills: [], warnings: [] };
  }

  /** Async version of import() for community adapters. */
  async importAsync(options: ImportOptions): Promise<ImportResult> {
    const result = await this.call("adapter/import", options);
    return result as ImportResult;
  }

  async export(config: ResolvedConfig, options: ExportOptions): Promise<ExportResult> {
    const result = await this.call("adapter/export", { config, options });
    return result as ExportResult;
  }

  diff(config: ResolvedConfig): DiffResult {
    // Synchronous stub — use diffAsync() for actual IPC.
    return { status: "unmanaged", changes: [] };
  }

  /** Async version of diff() for community adapters. */
  async diffAsync(config: ResolvedConfig): Promise<DiffResult> {
    const result = await this.call("adapter/diff", { config });
    return result as DiffResult;
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
