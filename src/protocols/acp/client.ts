/**
 * ACP Client — Drives ACP-compatible coding agents over JSON-RPC stdio.
 *
 * Wraps the official @agentclientprotocol/sdk to provide:
 *   - connect(command)     — spawn agent subprocess, negotiate capabilities
 *   - newSession(cwd)      — create a session
 *   - prompt(sessionId, parts) — send prompt, collect streaming updates
 *   - cancel(sessionId)    — cooperative cancellation
 *   - loadSession(sessionId) — resume existing session
 *   - disconnect()         — clean shutdown
 *
 * See ADR-0026 Phase 1.
 */

import {
  type McpServer as AcpMcpServer,
  type Client,
  ClientSideConnection,
  type ContentBlock,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  PROTOCOL_VERSION,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type ToolCall,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

import path from "node:path";
import { parseCommand, resolveAgent } from "./registry";
import type {
  AcpConnection,
  ConnectOptions,
  NewSessionOptions,
  PromptPart,
  PromptResult,
  SessionUpdateHandler,
} from "./types";
import type { AcpSettings } from "./types";

/** Permission policy for ACP permission requests. */
export type PermissionPolicy = "auto-approve" | "deny";

// ── Error types ────────────────────────────────────────────────

export class AcpClientError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "AcpClientError";
  }
}

// ── Client ─────────────────────────────────────────────────────

export class AmAcpClient {
  private connection: ClientSideConnection | null = null;
  private subprocess: { kill(): void } | null = null;
  private connInfo: AcpConnection | null = null;
  private updateHandler: SessionUpdateHandler | null = null;
  private permissionPolicy: PermissionPolicy = "auto-approve";
  private allowedPaths: string[] = [];

  /**
   * Set a handler for session update notifications.
   * Called for every update during prompt execution (text chunks, tool calls, plans, etc.).
   */
  onSessionUpdate(handler: SessionUpdateHandler): void {
    this.updateHandler = handler;
  }

  /**
   * Set the permission policy for ACP permission requests.
   * "auto-approve" (default): auto-approve all permission requests (headless mode).
   * "deny": reject all permission requests (--no-auto-approve flag).
   */
  setPermissionPolicy(policy: PermissionPolicy): void {
    this.permissionPolicy = policy;
  }

  /**
   * Set the allowed filesystem paths for readTextFile/writeTextFile.
   * When non-empty, file operations are restricted to these directories.
   * Default: [] (unrestricted — for backwards compatibility; callers should set [cwd]).
   */
  setAllowedPaths(paths: string[]): void {
    this.allowedPaths = paths;
  }

  /**
   * Connect to an ACP agent by spawning it as a subprocess.
   *
   * @param agentCommand - Full command to spawn (e.g., "npx -y @agentclientprotocol/claude-agent-acp@latest")
   * @param opts - Connection options (timeout, env, extra args)
   * @returns Connection info with agent capabilities
   */
  async connect(agentCommand: string, opts?: ConnectOptions): Promise<AcpConnection> {
    if (this.connection) {
      throw new AcpClientError("Already connected. Call disconnect() first.", "ALREADY_CONNECTED");
    }

    const { executable, args } = parseCommand(agentCommand);
    const extraArgs = opts?.args ?? [];

    const proc = Bun.spawn([executable, ...args, ...extraArgs], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, ...opts?.env },
    });

    this.subprocess = proc;

    // Build the NDJSON stream from the subprocess stdio
    const stream = ndJsonStream(
      proc.stdin as unknown as WritableStream<Uint8Array>,
      proc.stdout as unknown as ReadableStream<Uint8Array>,
    );

    // Create the client-side connection
    const updateHandler = this.updateHandler;
    const policy = this.permissionPolicy;
    // MEDIUM-3: pass allowed paths for file operation restrictions
    const paths = [...this.allowedPaths, ...(opts?.allowedPaths ?? [])];
    this.connection = new ClientSideConnection(
      (_agent) => createClientHandler(updateHandler, policy, paths),
      stream,
    );

    // Initialize the connection (negotiate capabilities)
    const initTimeout = opts?.initTimeout ?? 30_000;
    const initResponse = await Promise.race([
      this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "agent-manager", version: "0.1.0" },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      }),
      timeoutPromise<Awaited<ReturnType<ClientSideConnection["initialize"]>>>(
        initTimeout,
        "Agent initialization timed out",
      ),
    ]);

    this.connInfo = {
      agentInfo: initResponse.agentInfo,
      capabilities: initResponse.agentCapabilities,
      signal: this.connection.signal,
      closed: this.connection.closed,
    };

    return this.connInfo;
  }

  /**
   * Connect to an agent by name, resolving the command from the registry.
   *
   * @param agentName - Agent name (e.g., "claude", "codex")
   * @param acpSettings - ACP settings from config (for overrides)
   * @param opts - Connection options
   */
  async connectByName(
    agentName: string,
    acpSettings?: AcpSettings,
    opts?: ConnectOptions,
  ): Promise<AcpConnection> {
    const entry = resolveAgent(agentName, acpSettings);
    if (!entry) {
      throw new AcpClientError(
        `Unknown agent "${agentName}". Use "am agents list" to see available agents.`,
        "AGENT_NOT_FOUND",
      );
    }
    return this.connect(entry.command, opts);
  }

  /**
   * Create a new ACP session.
   *
   * @returns The session ID
   */
  async newSession(opts: NewSessionOptions): Promise<string> {
    const conn = this.requireConnection();
    const response = await conn.newSession({
      cwd: opts.cwd,
      mcpServers: opts.mcpServers ?? [],
      additionalDirectories: opts.additionalDirectories,
    });
    return response.sessionId;
  }

  /**
   * Send a prompt to a session and collect the result.
   *
   * Session updates (text chunks, tool calls, plans) are emitted via the
   * onSessionUpdate handler during execution. The final result aggregates
   * the text output and tool calls.
   */
  async prompt(sessionId: string, parts: PromptPart[]): Promise<PromptResult> {
    const conn = this.requireConnection();
    this.resetCollected(); // Clear accumulated state from previous prompts

    // Convert PromptParts to ContentBlocks
    const contentBlocks: ContentBlock[] = parts.map((p) => ({
      type: "text" as const,
      text: p.text,
    }));

    const response = await conn.prompt({
      sessionId,
      prompt: contentBlocks,
    });

    // The text and tool calls are collected by the update handler;
    // we return a summary from the response.
    return {
      stopReason: response.stopReason,
      text: this.collectedText,
      toolCalls: [...this.collectedToolCalls],
      usage: response.usage,
    };
  }

  /**
   * Cancel an in-progress prompt in a session.
   */
  async cancel(sessionId: string): Promise<void> {
    const conn = this.requireConnection();
    await conn.cancel({ sessionId });
  }

  /**
   * Load (resume) an existing session.
   */
  async loadSession(sessionId: string, opts: NewSessionOptions): Promise<void> {
    const conn = this.requireConnection();
    await conn.loadSession({
      sessionId,
      cwd: opts.cwd,
      mcpServers: opts.mcpServers ?? [],
      additionalDirectories: opts.additionalDirectories,
    });
  }

  /**
   * List sessions (if the agent supports it).
   */
  async listSessions(cwd?: string) {
    const conn = this.requireConnection();
    return conn.listSessions({ cwd });
  }

  /**
   * Disconnect from the agent, killing the subprocess.
   */
  async disconnect(): Promise<void> {
    if (this.subprocess) {
      this.subprocess.kill();
      this.subprocess = null;
    }
    this.connection = null;
    this.connInfo = null;
    this.resetCollected();
  }

  /** Whether the client is currently connected to an agent. */
  get connected(): boolean {
    return this.connection !== null && !this.connection.signal.aborted;
  }

  /** Get the current connection info, or null if not connected. */
  get connectionInfo(): AcpConnection | null {
    return this.connInfo;
  }

  // ── Internal ─────────────────────────────────────────────────

  private collectedText = "";
  private collectedToolCalls: ToolCall[] = [];

  private resetCollected(): void {
    this.collectedText = "";
    this.collectedToolCalls = [];
  }

  private requireConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new AcpClientError("Not connected. Call connect() first.", "NOT_CONNECTED");
    }
    return this.connection;
  }

  /** Called by the Client handler when a session update arrives. */
  _handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;

    // Collect text from agent message chunks
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text") {
        this.collectedText += update.content.text;
      }
    }

    // Collect tool calls
    if (update.sessionUpdate === "tool_call") {
      this.collectedToolCalls.push(update as ToolCall);
    }

    // Forward to user handler
    this.updateHandler?.(update);
  }
}

// ── Path validation (MEDIUM-3 hardening) ────────────────────────

/**
 * Check whether a requested path is within any of the allowed directories.
 * Uses path.resolve() to normalize traversal sequences before comparison.
 */
export function isPathAllowed(requestedPath: string, allowedPaths: string[]): boolean {
  const resolved = path.resolve(requestedPath);
  return allowedPaths.some((allowed) => {
    const resolvedAllowed = path.resolve(allowed);
    return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + path.sep);
  });
}

// ── Client handler (agent-to-client callbacks) ─────────────────

/**
 * Create a Client handler that processes incoming agent requests.
 * This is the "client side" of the ACP protocol — the agent calls
 * these methods to request permission, read/write files, etc.
 */
function createClientHandler(
  updateHandler: SessionUpdateHandler | null,
  permissionPolicy: PermissionPolicy = "auto-approve",
  allowedPaths: string[] = [],
): Client {
  return {
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      if (permissionPolicy === "deny") {
        // HIGH-1 fix: reject all permission requests when --no-auto-approve is set.
        const denyOption = params.options.find(
          (o) => o.kind === "reject_once" || o.kind === "reject_always",
        );
        if (denyOption) {
          return { outcome: { outcome: "selected", optionId: denyOption.optionId } };
        }
        // If no deny option exists, use the first option (safest available).
        return { outcome: { outcome: "selected", optionId: params.options[0].optionId } };
      }
      // Auto-approve all permissions in headless mode (default).
      const allowOption = params.options.find((o) => o.kind === "allow_once");
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOption?.optionId ?? params.options[0].optionId,
        },
      };
    },

    async sessionUpdate(params: SessionNotification): Promise<void> {
      // Session updates are handled by the AmAcpClient instance.
      // This handler is set up by the connection factory; we invoke the
      // update handler directly since we can't reference the client instance here.
      // The updateHandler was captured in the closure.
      updateHandler?.(params.update);
    },

    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      // MEDIUM-3: restrict file reads to allowed paths
      if (allowedPaths.length > 0 && !isPathAllowed(params.path, allowedPaths)) {
        throw new AcpClientError(
          `Path "${params.path}" is outside the allowed directories`,
          "PATH_NOT_ALLOWED",
        );
      }
      try {
        const content = await Bun.file(params.path).text();
        return { content };
      } catch {
        return { content: "" };
      }
    },

    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      // MEDIUM-3: restrict file writes to allowed paths
      if (allowedPaths.length > 0 && !isPathAllowed(params.path, allowedPaths)) {
        throw new AcpClientError(
          `Path "${params.path}" is outside the allowed directories`,
          "PATH_NOT_ALLOWED",
        );
      }
      await Bun.write(params.path, params.content);
      return {};
    },

    async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
      // Headless terminal support: spawn the command directly (no shell).
      // HIGH-2 fix: avoid sh -c to prevent shell metacharacter injection.
      const { executable, args } = parseCommand(params.command);
      const proc = Bun.spawn([executable, ...args], {
        cwd: params.cwd ?? undefined,
        env: params.env ? Object.fromEntries(params.env.map((e) => [e.name, e.value])) : undefined,
        stdout: "pipe",
        stderr: "pipe",
      });
      const terminalId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      terminalStore.set(terminalId, proc);
      return { terminalId };
    },

    async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
      const proc = terminalStore.get(params.terminalId);
      if (!proc) {
        return { output: "", exitStatus: { exitCode: -1 }, truncated: false };
      }
      // Read whatever is available
      const output = proc.stdout ? await new Response(proc.stdout as ReadableStream).text() : "";
      return { output, truncated: false };
    },

    async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
      const proc = terminalStore.get(params.terminalId);
      if (proc) {
        proc.kill();
        terminalStore.delete(params.terminalId);
      }
      return {};
    },

    async waitForTerminalExit(
      params: WaitForTerminalExitRequest,
    ): Promise<WaitForTerminalExitResponse> {
      const proc = terminalStore.get(params.terminalId);
      if (!proc) {
        return { exitCode: -1 };
      }
      const exitCode = await proc.exited;
      return { exitCode };
    },

    async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
      const proc = terminalStore.get(params.terminalId);
      if (proc) {
        proc.kill();
      }
      return {};
    },
  };
}

// Simple in-memory terminal store for headless operation
const terminalStore = new Map<string, ReturnType<typeof Bun.spawn>>();

// ── Helpers ────────────────────────────────────────────────────

function timeoutPromise<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new AcpClientError(message, "TIMEOUT")), ms);
  });
}

/** Convenience: create a client instance. */
export function createAcpClient(): AmAcpClient {
  return new AmAcpClient();
}
