/**
 * shell-wrapper.ts — ACP shim over a non-ACP-native CLI agent.
 *
 * ADR-0033 Phase B. Exposes ACP stdio upstream; spawns a wrapped CLI
 * (aider, amazon-q, cody, ...) downstream on every `session/prompt`.
 *
 * Why a minimal JSON-RPC server rather than the @agentclientprotocol/sdk
 * `AgentSideConnection`:
 *   1. The shim advertises `loadSession: false` and a tiny set of methods.
 *      Carrying the full SDK's request router and Agent interface is ~600 LoC
 *      of dependency for no added correctness.
 *   2. Testing: we want to drive the server in-process without spawning a
 *      subprocess, so a pure class that reads/writes `WritableStream`s is
 *      easier to fuzz than the SDK's event loop.
 *   3. Spec-conformance: the minimal handshake from R-A §1.3 is four methods
 *      (initialize, session/new, session/prompt, session/cancel). The SDK's
 *      job is making those four methods ergonomic to implement — not
 *      providing additional protocol validation we wouldn't get otherwise.
 *
 * Security surface (REV-2 PB-1/PB-3/PB-4):
 *   - PB-1 env scrubbing: uses `sandboxEnv()` for every subprocess.
 *   - PB-3 argv injection: we NEVER interpolate user prompt into argv. The
 *     only supported prompt-delivery modes are:
 *       "stdin"     — feed prompt via proc.stdin (preferred)
 *       "arg-last"  — append prompt as the final argv element
 *       "arg-named" — reserved for future use; currently same as arg-last
 *         (the "named" variant would require a ShimConfig option naming the
 *         flag, which we haven't plumbed through yet).
 *   - PB-4 chunk redaction: NOT the shim's job. The MCP progress-sink applies
 *     redactSecretish before emission (REV-2 HIGH-1 fix in src/mcp/server.ts).
 *     The shim emits raw stdout; the MCP boundary redacts. Each layer owns
 *     one job.
 */

import { randomUUID } from "node:crypto";
import { sandboxEnv } from "./env-sandbox";

// ── Config ─────────────────────────────────────────────────────

/** How the user's prompt text reaches the wrapped CLI. */
export type PromptTemplate = "stdin" | "arg-last" | "arg-named";

/** Which stream the wrapper collects as the agent's response. */
export type ResponseExtractor = "stdout" | "stderr" | "both";

export interface ShimConfig {
  /**
   * argv of the wrapped CLI. First element is the executable; the rest are
   * flags. The user's prompt is NOT interpolated into this array (PB-3).
   */
  command: string[];
  /** How the prompt reaches the CLI. Default: "stdin". */
  promptTemplate?: PromptTemplate;
  /** Where to read the response from. Default: "stdout". */
  responseExtractor?: ResponseExtractor;
  /** Hard kill timeout in ms. Default: 120_000. */
  timeoutMs?: number;
  /**
   * Extra env vars to forward. These overlay the default sandboxEnv
   * allow-list — use this for tool-specific keys the user has explicitly
   * opted in to (e.g. `ANTHROPIC_API_KEY` for aider).
   */
  env?: Record<string, string>;
}

export interface ShimRegistry {
  [agentName: string]: ShimConfig;
}

/**
 * Built-in shim configs for the three initial Phase B agents per ADR-0033.
 * These flags come from R-A §2 (viability matrix, highest-confidence CLIs).
 *
 * Security note: every command here auto-approves actions (`--yes`,
 * `--no-interactive`, `-m`). That's deliberate — tier-2 wrappers inherit the
 * wrapped CLI's trust posture. `am agent enable-shim` surfaces this caveat
 * before the flag flips.
 */
export const BUILT_IN_SHIMS: ShimRegistry = {
  aider: {
    command: ["aider", "--message-file", "-", "--yes", "--no-stream", "--no-pretty"],
    promptTemplate: "stdin",
    responseExtractor: "stdout",
    timeoutMs: 120_000,
  },
  "amazon-q": {
    command: ["q", "chat", "--no-interactive"],
    promptTemplate: "arg-last",
    responseExtractor: "stdout",
    timeoutMs: 120_000,
  },
  cody: {
    command: ["cody", "chat", "-m"],
    promptTemplate: "arg-last",
    responseExtractor: "stdout",
    timeoutMs: 120_000,
  },
};

// ── JSON-RPC I/O ───────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** A handler exposed for testing: given a raw line, emit zero or more frames. */
export type FrameEmitter = (frame: JsonRpcResponse | JsonRpcNotification) => void;

// ── ACP shape — minimal subset (R-A §1.3) ──────────────────────

const PROTOCOL_VERSION = "2025-11-25";

interface SessionState {
  id: string;
  cwd: string;
  /** Current in-flight subprocess, if any (for cancellation). */
  child?: { kill: (signal?: number | NodeJS.Signals) => void };
  cancelled: boolean;
}

// ── ShimAcpServer ──────────────────────────────────────────────

/**
 * Per-process rate limiter for REV-4 MED-3: emit the `arg-named` fallback
 * warning only once per wrapped agent name/command. Using a `Set` (rather
 * than a counter) keeps memory bounded and avoids the usual "log spam from
 * a hot loop" failure mode — we only want operators to see this once per
 * boot so they know to stop writing `arg-named` in their shim configs.
 *
 * Exported so tests can reset state between cases.
 */
export const __argNamedWarnedOnce: Set<string> = new Set();
export function __resetArgNamedWarnedOnceForTests(): void {
  __argNamedWarnedOnce.clear();
}

// ── ShimAcpServer ──────────────────────────────────────────────

/**
 * A minimal ACP agent that proxies every prompt to a wrapped CLI.
 *
 * The server owns only four methods: initialize, session/new, session/prompt,
 * session/cancel. session/load and everything else return -32601 (method not
 * found) or are silently ignored (notifications).
 */
export class ShimAcpServer {
  private sessions = new Map<string, SessionState>();
  private emit: FrameEmitter;
  private shim: ShimConfig;
  /** Tracks active subprocesses for disconnect reaping. */
  private activeChildren = new Set<{ kill: (signal?: number | NodeJS.Signals) => void }>();

  constructor(shim: ShimConfig, emit: FrameEmitter) {
    this.shim = shim;
    this.emit = emit;
  }

  /**
   * Dispatch a single JSON-RPC request/notification. Returns a response
   * for requests (object with an id); returns null for notifications or for
   * requests that have already been responded to via the frame emitter.
   */
  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;
    const isNotification = req.id === undefined || req.id === null;

    try {
      switch (req.method) {
        case "initialize": {
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: {
                loadSession: false,
                promptCapabilities: {
                  image: false,
                  audio: false,
                  embeddedContext: false,
                },
                mcpCapabilities: { http: false, sse: false },
              },
              authMethods: [],
              agentInfo: {
                name: "am-acp-shell",
                title: `ACP Shell (wraps ${this.shim.command[0] ?? "unknown"})`,
                version: "0.1.0",
              },
            },
          };
        }

        case "session/new": {
          if (isNotification) return null;
          const params = (req.params ?? {}) as { cwd?: string };
          const sid = `shell-${randomUUID()}`;
          this.sessions.set(sid, {
            id: sid,
            cwd: params.cwd ?? process.cwd(),
            cancelled: false,
          });
          return { jsonrpc: "2.0", id, result: { sessionId: sid } };
        }

        case "session/load": {
          // Advertised as unsupported (loadSession: false).
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "session/load is not supported by this shim" },
          };
        }

        case "session/prompt": {
          if (isNotification) return null;
          const params = (req.params ?? {}) as {
            sessionId?: string;
            prompt?: Array<{ type?: string; text?: string }>;
          };
          const sid = params.sessionId;
          if (!sid || !this.sessions.has(sid)) {
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "Unknown sessionId" },
            };
          }
          const promptText = (params.prompt ?? [])
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text ?? "")
            .join("");

          const result = await this.runPrompt(sid, promptText);
          return { jsonrpc: "2.0", id, result };
        }

        case "session/cancel": {
          // Notification per spec — no response.
          const params = (req.params ?? {}) as { sessionId?: string };
          const sid = params.sessionId;
          if (sid) {
            const s = this.sessions.get(sid);
            if (s) {
              s.cancelled = true;
              try {
                s.child?.kill("SIGTERM");
              } catch {
                // already dead
              }
            }
          }
          return null;
        }

        default: {
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
        }
      }
    } catch (err: unknown) {
      if (isNotification) return null;
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Internal error: ${message}` },
      };
    }
  }

  /**
   * Execute one prompt turn: build argv, spawn the CLI, collect output,
   * emit exactly one agent_message_chunk, return stopReason.
   */
  private async runPrompt(
    sessionId: string,
    promptText: string,
  ): Promise<{ stopReason: string } | { stopReason: string; error?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { stopReason: "error", error: "unknown session" };

    // Build argv. PB-3: prompt text NEVER goes into argv unless the template
    // explicitly names that mode, and even then it's the FINAL element (no
    // metacharacter substitution, no shell).
    const template = this.shim.promptTemplate ?? "stdin";
    const argv = [...this.shim.command];
    if (template === "arg-last" || template === "arg-named") {
      // REV-4 MED-3: `arg-named` is currently aliased to `arg-last` (same
      // behaviour). Future shims will specialize this to a named flag like
      // `--prompt <text>`. Warn ONCE per wrapped agent so community
      // adapters that wrote `arg-named` expecting distinct semantics know
      // they're getting the arg-last fallback, without log-spamming in
      // hot-loop prompt turns.
      if (template === "arg-named") {
        const warnKey = this.shim.command[0] ?? "<unknown>";
        if (!__argNamedWarnedOnce.has(warnKey)) {
          __argNamedWarnedOnce.add(warnKey);
          console.warn(
            `[am-acp-shell] promptTemplate 'arg-named' is not yet implemented for '${warnKey}', falling back to arg-last`,
          );
        }
      }
      argv.push(promptText);
    }

    const timeoutMs = this.shim.timeoutMs ?? 120_000;

    // Spawn. stdin is piped so we can feed the prompt (when template=stdin),
    // then immediately closed.
    const proc = Bun.spawn(argv, {
      stdin: template === "stdin" ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cwd: session.cwd,
      env: sandboxEnv(this.shim.env),
    });
    session.child = proc as { kill: (s?: number | NodeJS.Signals) => void };
    this.activeChildren.add(session.child);

    try {
      // Feed the prompt via stdin if configured.
      if (template === "stdin") {
        const stdinSink = proc.stdin as unknown as {
          write: (s: string) => number | undefined;
          end?: () => void;
        };
        try {
          stdinSink.write(promptText);
          stdinSink.end?.();
        } catch {
          // If the child already closed its stdin, that's fine — it can still
          // exit with the accumulated input.
        }
      }

      // Arm a timeout. If it fires, SIGTERM then SIGKILL.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 500);
      }, timeoutMs);

      // Drain stdout and stderr in parallel; wait for exit.
      const stdoutText = proc.stdout
        ? new Response(proc.stdout as ReadableStream).text()
        : Promise.resolve("");
      const stderrText = proc.stderr
        ? new Response(proc.stderr as ReadableStream).text()
        : Promise.resolve("");

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const [stdout, stderr] = await Promise.all([stdoutText, stderrText]);

      // Determine the agent's output text according to responseExtractor.
      const extractor = this.shim.responseExtractor ?? "stdout";
      let responseText = "";
      if (extractor === "stdout") responseText = stdout;
      else if (extractor === "stderr") responseText = stderr;
      else responseText = `${stdout}${stderr ? `\n${stderr}` : ""}`;

      // Emit exactly one agent_message_chunk with the response text (R-A §1.3,
      // "zero intermediate updates and one final chunk" is spec-legal).
      this.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: responseText },
          },
        },
      });

      // Decide stopReason.
      if (session.cancelled) return { stopReason: "cancelled" };
      if (timedOut) {
        return { stopReason: "error", error: `timeout after ${timeoutMs}ms (killed)` };
      }
      if (exitCode !== 0) {
        const errSummary = (stderr || stdout || "").trim().slice(0, 500);
        return {
          stopReason: "refusal",
          error: `wrapped command exited ${exitCode}${errSummary ? `: ${errSummary}` : ""}`,
        };
      }
      return { stopReason: "end_turn" };
    } finally {
      this.activeChildren.delete(session.child);
      session.child = undefined;
    }
  }

  /** Reap all children. Called on server shutdown. */
  async shutdown(): Promise<void> {
    for (const child of this.activeChildren) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    this.activeChildren.clear();
  }
}

// ── CLI entry point — `am-acp-shell <agent-name>` ──────────────

/**
 * Serve the shim on process stdio: read newline-delimited JSON-RPC from
 * stdin, dispatch to ShimAcpServer, write responses and notifications to
 * stdout. Runs until stdin EOFs or a fatal error occurs.
 *
 * Exit codes:
 *   0 — clean exit (stdin closed by peer)
 *   2 — unknown agent name (not in BUILT_IN_SHIMS and no custom shim)
 *   3 — invalid shim config
 */
export async function serveShimOnStdio(agentName: string): Promise<number> {
  const shim = BUILT_IN_SHIMS[agentName];
  if (!shim) {
    process.stderr.write(
      `am-acp-shell: unknown agent "${agentName}". Known shims: ${Object.keys(BUILT_IN_SHIMS).join(", ")}\n`,
    );
    return 2;
  }
  return runShimServer(shim);
}

/** Core loop — shared between the CLI entry and tests that want to drive a custom ShimConfig. */
export async function runShimServer(shim: ShimConfig): Promise<number> {
  const emit: FrameEmitter = (frame) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  };
  const server = new ShimAcpServer(shim, emit);

  // Read NDJSON from stdin.
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          await dispatchLine(server, line, emit);
        }
        nl = buffer.indexOf("\n");
      }
    }
  } finally {
    await server.shutdown();
  }
  return 0;
}

/**
 * Parse one NDJSON line, dispatch, and emit the response (if any).
 * Exported so tests can drive the server frame-by-frame without a subprocess.
 */
export async function dispatchLine(
  server: ShimAcpServer,
  line: string,
  emit: FrameEmitter,
): Promise<void> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line);
  } catch {
    // Malformed JSON is logged to stderr so tests can spot it; per JSON-RPC
    // spec a response without a valid id can't be sent.
    process.stderr.write(`am-acp-shell: malformed JSON-RPC: ${line}\n`);
    return;
  }
  const response = await server.handleRequest(req);
  if (response !== null) emit(response);
}
