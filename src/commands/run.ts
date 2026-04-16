/**
 * CLI: am run — Drive ACP-compatible coding agents headlessly.
 *
 * Usage:
 *   am run claude "fix the failing tests"          — one-shot: spawn, prompt, wait, exit
 *   am run codex "add error handling to api.ts"    — different agent, same interface
 *   am run --session backend claude "continue"     — named session (resume previous work)
 *   am run --cwd /path/to/project claude "refactor" — override working directory
 *
 * Subcommands (for session management):
 *   am run session list                            — list active ACP sessions
 *   am run session cancel <sessionId>              — cancel active session
 *
 * See ADR-0026 Phase 2.
 */

import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { tryReadConfig } from "../core/config";
import { join } from "node:path";
import { debug, error, info, output } from "../lib/output";
import { AmAcpClient, AcpClientError, createAcpClient } from "../protocols/acp/client";
import { listAgents, resolveAgent } from "../protocols/acp/registry";
import type { AcpSettings, SessionUpdate } from "../protocols/acp/types";

// ── Helpers ────────────────────────────────────────────────────

/** Load ACP settings from the global config. */
async function loadAcpSettings(): Promise<AcpSettings | undefined> {
  const configDir = resolveConfigDir();
  const config = await tryReadConfig(join(configDir, "config.toml"));
  return config?.settings?.acp as AcpSettings | undefined;
}

/** Format a session update for human-readable output. */
function formatUpdate(update: SessionUpdate, opts: { verbose?: boolean }): string | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") return update.content.text;
      return null;
    case "agent_thought_chunk":
      if (opts.verbose && update.content.type === "text") return `[thinking] ${update.content.text}`;
      return null;
    case "tool_call":
      return `[tool] ${update.title}`;
    case "tool_call_update":
      if (update.status === "completed") return `[tool] ${update.title ?? "tool"} done`;
      if (update.status === "failed") return `[tool] ${update.title ?? "tool"} failed`;
      return null;
    case "plan":
      return `[plan] ${update.entries.length} step(s)`;
    case "usage_update":
      if (opts.verbose) return `[usage] ${update.used}/${update.size} tokens`;
      return null;
    default:
      return null;
  }
}

// ── Main run command ───────────────────────────────────────────

const runMainCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run an ACP-compatible coding agent",
  },
  args: {
    agent: {
      type: "positional",
      description: "Agent name (e.g., claude, codex, gemini) or full command",
      required: true,
    },
    prompt: {
      type: "positional",
      description: "Prompt to send to the agent",
      required: true,
    },
    session: {
      type: "string",
      alias: "s",
      description: "Named session ID (resume or create)",
    },
    cwd: {
      type: "string",
      description: "Working directory for the agent session",
    },
    timeout: {
      type: "string",
      description: "Timeout in seconds for the agent response (default: 300)",
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", description: "Suppress progress output", default: false },
    verbose: {
      type: "boolean",
      alias: "v",
      description: "Show thinking and usage details",
      default: false,
    },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const agentName = args.agent as string;
    const promptText = args.prompt as string;
    const sessionName = args.session as string | undefined;
    const cwd = (args.cwd as string) || process.cwd();
    const timeoutSecs = Number.parseInt(args.timeout as string) || 300;

    const acpSettings = await loadAcpSettings();

    // Resolve the agent command
    const entry = resolveAgent(agentName, acpSettings);
    if (!entry) {
      error(
        `Unknown agent "${agentName}". Run \`am run agents\` to list available agents.`,
        opts,
      );
      process.exitCode = 1;
      return;
    }

    debug(`Resolved agent: ${agentName} -> ${entry.command} (${entry.source})`, opts);

    const client = createAcpClient();

    // Accumulate text for streaming output (non-JSON mode)
    if (!args.json && !args.quiet) {
      client.onSessionUpdate((update: SessionUpdate) => {
        const text = formatUpdate(update, { verbose: args.verbose });
        if (text !== null) {
          // For agent text, write without newline to stream
          if (update.sessionUpdate === "agent_message_chunk") {
            process.stdout.write(text);
          } else {
            console.log(text);
          }
        }
      });
    }

    try {
      // 1. Connect
      info(`Connecting to ${agentName}...`, opts);
      const conn = await client.connect(entry.command, {
        initTimeout: 30_000,
      });
      debug(
        `Connected: ${conn.agentInfo?.name ?? "unknown"} v${conn.agentInfo?.version ?? "?"}`,
        opts,
      );

      // 2. Create or load session
      let sessionId: string;
      if (sessionName) {
        // Try to load existing session first
        try {
          await client.loadSession(sessionName, { cwd });
          sessionId = sessionName;
          debug(`Loaded session: ${sessionId}`, opts);
        } catch {
          // Session doesn't exist — create new with the given name
          sessionId = await client.newSession({ cwd });
          debug(`Created new session: ${sessionId} (named: ${sessionName})`, opts);
        }
      } else {
        sessionId = await client.newSession({ cwd });
        debug(`Created session: ${sessionId}`, opts);
      }

      // 3. Send prompt with timeout
      info("", opts); // blank line before agent output
      const result = await Promise.race([
        client.prompt(sessionId, [{ type: "text", text: promptText }]),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new AcpClientError("Prompt timed out", "TIMEOUT")),
            timeoutSecs * 1000,
          ),
        ),
      ]);

      // Ensure newline after streamed text
      if (!args.json && !args.quiet) {
        process.stdout.write("\n");
      }

      // 4. Output result
      if (args.json) {
        output(
          {
            agent: agentName,
            sessionId,
            stopReason: result.stopReason,
            text: result.text,
            toolCalls: result.toolCalls.map((tc) => ({
              id: tc.toolCallId,
              title: tc.title,
              status: tc.status,
              kind: tc.kind,
            })),
            usage: result.usage ?? null,
          },
          opts,
        );
      } else {
        if (result.toolCalls.length > 0) {
          info(`\n${result.toolCalls.length} tool call(s)`, opts);
        }
        info(`\nStop reason: ${result.stopReason}`, opts);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Agent run failed: ${message}`, opts);
      process.exitCode = 1;
    } finally {
      await client.disconnect();
    }
  },
});

// ── Subcommand: am run agents ──────────────────────────────────

const agentsSubcommand = defineCommand({
  meta: { name: "agents", description: "List available ACP agents" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const acpSettings = await loadAcpSettings();
    const agents = listAgents(acpSettings);

    if (args.json) {
      output({ agents }, opts);
      return;
    }

    info(`${"Name".padEnd(20)} ${"Source".padEnd(10)} Command`, opts);
    info(`${"─".repeat(20)} ${"─".repeat(10)} ${"─".repeat(50)}`, opts);
    for (const agent of agents) {
      info(`${agent.name.padEnd(20)} ${agent.source.padEnd(10)} ${agent.command}`, opts);
    }
    info(`\n${agents.length} agent(s) available`, opts);
  },
});

// ── Subcommand: am run session list/cancel ─────────────────────

const sessionListSubcommand = defineCommand({
  meta: { name: "list", description: "List active ACP sessions for an agent" },
  args: {
    agent: { type: "positional", description: "Agent name", required: true },
    cwd: { type: "string", description: "Filter by working directory" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const agentName = args.agent as string;
    const acpSettings = await loadAcpSettings();
    const entry = resolveAgent(agentName, acpSettings);

    if (!entry) {
      error(`Unknown agent "${agentName}".`, opts);
      process.exitCode = 1;
      return;
    }

    const client = createAcpClient();
    try {
      await client.connect(entry.command, { initTimeout: 30_000 });
      const response = await client.listSessions(args.cwd as string | undefined);

      if (args.json) {
        output({ agent: agentName, sessions: response.sessions }, opts);
        return;
      }

      if (response.sessions.length === 0) {
        info("No active sessions.", opts);
        return;
      }

      info(`${"Session ID".padEnd(40)} ${"CWD".padEnd(30)} ${"Updated"}`, opts);
      info(`${"─".repeat(40)} ${"─".repeat(30)} ${"─".repeat(20)}`, opts);
      for (const s of response.sessions) {
        const updated = s.updatedAt ? s.updatedAt.slice(0, 16).replace("T", " ") : "—";
        info(`${s.sessionId.padEnd(40)} ${s.cwd.padEnd(30)} ${updated}`, opts);
      }
      info(`\n${response.sessions.length} session(s)`, opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Failed to list sessions: ${message}`, opts);
      process.exitCode = 1;
    } finally {
      await client.disconnect();
    }
  },
});

const sessionCancelSubcommand = defineCommand({
  meta: { name: "cancel", description: "Cancel an active ACP session" },
  args: {
    agent: { type: "positional", description: "Agent name", required: true },
    sessionId: { type: "positional", description: "Session ID to cancel", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const agentName = args.agent as string;
    const sessionId = args.sessionId as string;
    const acpSettings = await loadAcpSettings();
    const entry = resolveAgent(agentName, acpSettings);

    if (!entry) {
      error(`Unknown agent "${agentName}".`, opts);
      process.exitCode = 1;
      return;
    }

    const client = createAcpClient();
    try {
      await client.connect(entry.command, { initTimeout: 30_000 });
      await client.cancel(sessionId);

      if (args.json) {
        output({ action: "cancel", agent: agentName, sessionId }, opts);
      } else {
        info(`Cancelled session ${sessionId} on ${agentName}.`, opts);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Failed to cancel session: ${message}`, opts);
      process.exitCode = 1;
    } finally {
      await client.disconnect();
    }
  },
});

const sessionSubcommand = defineCommand({
  meta: { name: "session", description: "Manage ACP agent sessions" },
  subCommands: {
    list: () => Promise.resolve(sessionListSubcommand),
    cancel: () => Promise.resolve(sessionCancelSubcommand),
  },
});

// ── Export top-level command ────────────────────────────────────

export const runCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run an ACP-compatible coding agent or manage sessions",
  },
  args: {
    agent: {
      type: "positional",
      description: "Agent name (e.g., claude, codex, gemini) or full command",
      required: true,
    },
    prompt: {
      type: "positional",
      description: "Prompt to send to the agent",
    },
    session: {
      type: "string",
      alias: "s",
      description: "Named session ID (resume or create)",
    },
    cwd: {
      type: "string",
      description: "Working directory for the agent session",
    },
    timeout: {
      type: "string",
      description: "Timeout in seconds for the agent response (default: 300)",
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", description: "Suppress progress output", default: false },
    verbose: {
      type: "boolean",
      alias: "v",
      description: "Show thinking and usage details",
      default: false,
    },
  },
  subCommands: {
    agents: () => Promise.resolve(agentsSubcommand),
    session: () => Promise.resolve(sessionSubcommand),
  },
  async run({ args }) {
    // If we reach here, it's the main `am run <agent> <prompt>` form
    const promptText = args.prompt as string | undefined;
    if (!promptText) {
      error(
        'Usage: am run <agent> "<prompt>" or am run agents|session',
        { json: args.json, quiet: args.quiet },
      );
      process.exitCode = 1;
      return;
    }

    // Delegate to the main run logic
    await runMainCommand.run!({ args: args as any });
  },
});
