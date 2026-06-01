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
import { sandboxEnv } from "./env-sandbox";
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
  private subprocess: {
    kill(signal?: number | NodeJS.Signals): void;
    exited?: Promise<number>;
  } | null = null;
  private connInfo: AcpConnection | null = null;
  private updateHandler: SessionUpdateHandler | null = null;
  // Secure-by-default (2026-05-02 adversarial-review fix):
  // Class default flipped from "auto-approve" to "deny" so callers that
  // forget to configure the policy fail closed. Any caller that genuinely
  // needs headless auto-approve (am run, am flow, am_run_agent MCP tool)
  // must explicitly call setPermissionPolicy("auto-approve"). The bridge
  // was already forcing "deny" at connect time (HIGH-2), so this class
  // default aligns with the bridge's A2A-facing posture.
  private permissionPolicy: PermissionPolicy = "deny";
  private allowedPaths: string[] = [];
  // HIGH-3 fix: per-instance terminal store so terminals don't leak across
  // clients (previously this was a module-level Map shared by every instance).
  private terminalStore = new Map<string, ReturnType<typeof Bun.spawn>>();
  // HIGH-3 fix: cache drained stdout per terminal since the underlying
  // ReadableStream can only be consumed once.
  private terminalOutputCache = new Map<string, string>();

  /**
   * Set a handler for session update notifications.
   * Called for every update during prompt execution (text chunks, tool calls, plans, etc.).
   */
  onSessionUpdate(handler: SessionUpdateHandler): void {
    this.updateHandler = handler;
  }

  /**
   * Set the permission policy for ACP permission requests.
   * "deny" (default, 2026-05-02 secure-by-default flip): reject all permission
   *         requests — safe default for any caller that doesn't explicitly
   *         opt into auto-approve.
   * "auto-approve": auto-approve all permission requests; appropriate for
   *         headless mode (am run, am flow, am_run_agent MCP tool) where the
   *         caller has already decided it trusts the agent.
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

    // HIGH-3 fix (REV-2 / ADR-0033 Phase B): scrub parent env before spawn.
    // Previously passed `{ ...process.env, ...opts?.env }` which leaked
    // AM_MCP_TOKEN, AM_ENCRYPTION_KEY, AWS creds, bearer tokens, etc. into
    // the agent subprocess. sandboxEnv() keeps only PATH/HOME/LANG/etc. and
    // overlays caller-supplied env on top.
    const proc = Bun.spawn([executable, ...args, ...extraArgs], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: sandboxEnv(opts?.env),
    });

    this.subprocess = proc as typeof this.subprocess;

    // Bun.spawn's `proc.stdin` is a FileSink, NOT a web-standard
    // WritableStream. The previous `as unknown as WritableStream<Uint8Array>`
    // cast compiled fine but blew up at runtime the moment ndJsonStream
    // (or anything else in @agentclientprotocol/sdk) called `.getWriter()`.
    // Wrap it in a real WritableStream so the SDK's web-stream path works.
    const stdinSink = proc.stdin as unknown as {
      write: (chunk: Uint8Array | string) => number | undefined;
      flush?: () => void;
      end?: () => void;
    };
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        stdinSink.write(chunk);
        stdinSink.flush?.();
      },
      close() {
        stdinSink.end?.();
      },
      abort() {
        try {
          stdinSink.end?.();
        } catch {
          // best-effort
        }
      },
    });

    // Build the NDJSON stream from the subprocess stdio
    const stream = ndJsonStream(writable, proc.stdout as ReadableStream<Uint8Array>);

    // Create the client-side connection
    const policy = this.permissionPolicy;
    // MEDIUM-3: pass allowed paths for file operation restrictions
    const paths = [...this.allowedPaths, ...(opts?.allowedPaths ?? [])];
    // CODEX-14 wiring: route ACP session updates through _handleSessionUpdate
    // (which accumulates collectedText/collectedToolCalls AND forwards to
    // the user's updateHandler). Previously createClientHandler received
    // only the user handler, bypassing aggregation. A prior iteration of
    // this fix called `_handleSessionUpdate` then also called the user
    // handler, which double-fired every update — final Codex signoff
    // caught that. `_handleSessionUpdate` at line ~437 already forwards
    // via `this.updateHandler?.(update)`, so we only need to hook in there.
    const composedHandler: SessionUpdateHandler = (update) => {
      this._handleSessionUpdate({ sessionId: "", update } as SessionNotification);
    };
    this.connection = new ClientSideConnection(
      (_agent) =>
        createClientHandler(
          composedHandler,
          policy,
          paths,
          this.terminalStore,
          this.terminalOutputCache,
        ),
      stream,
    );

    // Initialize the connection (negotiate capabilities).
    // CRITICAL-1 fix: wrap the initialize race in try/catch and forcibly kill
    // the subprocess if it throws or times out, otherwise orphaned agent
    // processes accumulate indefinitely.
    //
    // BUG fix (Wave QW): the timeout's setTimeout was never cleared, so a
    // successful initialize() left a 10s timer pending and kept the event
    // loop alive (`am run` hung at exit). The timeout helper now returns a
    // handle; we clearTimeout in the finally below regardless of outcome.
    const initTimeout = opts?.initTimeout ?? 10_000;
    const timeout = timeoutPromise<Awaited<ReturnType<ClientSideConnection["initialize"]>>>(
      initTimeout,
      "Agent initialization timed out",
    );
    try {
      const initResponse = await Promise.race([
        this.connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "agent-manager", version: "0.1.0" },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
        }),
        timeout.promise,
      ]);

      this.connInfo = {
        agentInfo: initResponse.agentInfo,
        capabilities: initResponse.agentCapabilities,
        signal: this.connection.signal,
        closed: this.connection.closed,
      };
      return this.connInfo;
    } catch (err) {
      await this.killSubprocess();
      this.connection = null;
      this.connInfo = null;
      throw err;
    } finally {
      timeout.clear();
    }
  }

  /**
   * Forcibly terminate the subprocess: SIGTERM first, wait up to 2s, then
   * SIGKILL as fallback. Safe to call when already dead or never spawned.
   */
  private async killSubprocess(gracePeriodMs = 2000): Promise<void> {
    const proc = this.subprocess;
    if (!proc) return;
    this.subprocess = null;

    try {
      proc.kill("SIGTERM");
    } catch {
      // already dead or platform quirk — move on to SIGKILL attempt below
    }

    const exited = proc.exited;
    if (exited && typeof (exited as Promise<number>).then === "function") {
      const timer = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), gracePeriodMs),
      );
      const outcome = await Promise.race([exited.then(() => "exited" as const), timer]);
      if (outcome === "timeout") {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
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
   * Disconnect from the agent, killing the subprocess and any terminals it
   * spawned. Safe to call multiple times.
   */
  async disconnect(): Promise<void> {
    // Reap any terminals spawned by the agent before the main process dies.
    for (const [id, proc] of this.terminalStore) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      this.terminalStore.delete(id);
    }
    this.terminalOutputCache.clear();

    await this.killSubprocess();
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
 *
 * Exported (2026-05-02) so tests can drive `requestPermission` directly
 * and assert the deny-policy bypass fix without standing up a full ACP
 * subprocess handshake.
 */
export function createClientHandler(
  updateHandler: SessionUpdateHandler | null,
  permissionPolicy: PermissionPolicy = "deny",
  allowedPaths: string[] = [],
  terminalStore: Map<string, ReturnType<typeof Bun.spawn>> = new Map(),
  terminalOutputCache: Map<string, string> = new Map(),
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
        // Defense-in-depth (2026-05-02 adversarial-review fix): if the agent
        // omits a reject option, the deny policy is NOT satisfied by falling
        // through to options[0] — that could be `allow_always`, letting a
        // malicious agent trivially bypass the A2A-facing deny default.
        // Return `cancelled` (well-formed per ACP spec) rather than selecting
        // an option we can't prove is safe.
        return { outcome: { outcome: "cancelled" } };
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
      // HIGH-3 fix (REV-2 / ADR-0033 Phase B): scrub env before spawn. When
      // params.env is undefined we used to inherit the full parent env (the
      // exfiltration vector described in REV-2 — an agent asking
      // `createTerminal({ command: "printenv" })` could dump every secret).
      // Now we pass the scrubbed default env; if the agent supplied explicit
      // env vars, those overlay on top via sandboxEnv's `extra` param.
      const { executable, args } = parseCommand(params.command);
      const explicitEnv = params.env
        ? Object.fromEntries(params.env.map((e) => [e.name, e.value]))
        : undefined;
      const proc = Bun.spawn([executable, ...args], {
        cwd: params.cwd ?? undefined,
        env: sandboxEnv(explicitEnv),
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
      // HIGH-3 fix: `new Response(stream).text()` locks the underlying
      // ReadableStream and can only be consumed once; a second call would
      // throw. Drain on first read, cache the buffer, return it every time.
      let output = terminalOutputCache.get(params.terminalId);
      if (output === undefined) {
        output = proc.stdout ? await new Response(proc.stdout as ReadableStream).text() : "";
        terminalOutputCache.set(params.terminalId, output);
      }
      return { output, truncated: false };
    },

    async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
      const proc = terminalStore.get(params.terminalId);
      if (proc) {
        proc.kill();
        terminalStore.delete(params.terminalId);
        terminalOutputCache.delete(params.terminalId);
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

// ── Helpers ────────────────────────────────────────────────────

/**
 * A rejecting timeout whose timer can be cleared by the caller. Returning the
 * handle (rather than a bare Promise) lets the `connect()` race cancel the
 * pending `setTimeout` once `initialize()` resolves — otherwise the timer
 * keeps the event loop alive for the full `ms` window after a successful init.
 */
export function timeoutPromise<T>(
  ms: number,
  message: string,
): { promise: Promise<T>; clear: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((_, reject) => {
    handle = setTimeout(() => reject(new AcpClientError(message, "TIMEOUT")), ms);
  });
  return {
    promise,
    clear() {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}

/** Convenience: create a client instance. */
export function createAcpClient(): AmAcpClient {
  return new AmAcpClient();
}
