/**
 * CLI: am run — Drive ACP-compatible coding agents headlessly.
 *
 * Usage:
 *   am run claude "fix the failing tests"          — one-shot: spawn, prompt, wait, exit
 *   am run codex "add error handling to api.ts"    — different agent, same interface
 *   am run --session backend claude "continue"     — named session (resume previous work)
 *   am run --cwd /path/to/project claude "refactor" — override working directory
 *
 * Subcommands (for live ACP session management):
 *   am run session list                            — list active ACP sessions
 *   am run session cancel <sessionId>              — cancel active session
 *
 * Note: `am run agents` is DEPRECATED — use `am agent list` (ADR-0031 M2).
 * Note: `am run session` manages LIVE ACP sessions (via JSON-RPC to the agent
 *       subprocess). For cross-tool transcript browsing (read-only disk harvest
 *       of Claude Code, Codex, etc.), use `am session` instead. Different
 *       concepts, intentionally kept separate.
 *
 * See ADR-0026 Phase 2, ADR-0031 Pillar 3.
 */

import { join } from "node:path";
import { defineCommand } from "citty";
import {
  type UnifiedRegistryConfig,
  listAllAgentsAsync,
  resolveAgentAsync,
} from "../core/agent-registry";
import { resolveConfigDir } from "../core/config";
import { tryReadConfig } from "../core/config";
import { debug, error, info, output, parsePositiveInt, warn } from "../lib/output";
import { AcpClientError, AmAcpClient, createAcpClient } from "../protocols/acp/client";
import type { SessionUpdate } from "../protocols/acp/types";

// ── Helpers ────────────────────────────────────────────────────

/** Load unified registry config and config dir for agent resolution. */
async function loadRegistryContext(): Promise<{
  registryConfig: UnifiedRegistryConfig | undefined;
  configDir: string;
}> {
  const configDir = resolveConfigDir();
  const config = await tryReadConfig(join(configDir, "config.toml"));
  // Build UnifiedRegistryConfig from [agents.*] entries that have acp/a2a sub-sections
  // The TOML config's agents section may have entries with acp/a2a sub-tables
  const registryConfig = config as UnifiedRegistryConfig | undefined;
  return { registryConfig, configDir };
}

/** Format a session update for human-readable output. */
function formatUpdate(update: SessionUpdate, opts: { verbose?: boolean }): string | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") return update.content.text;
      return null;
    case "agent_thought_chunk":
      if (opts.verbose && update.content.type === "text")
        return `[thinking] ${update.content.text}`;
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

// ── Core run logic ────────────────────────────────────────────

interface RunAgentArgs {
  agent: string;
  prompt: string;
  session?: string;
  cwd?: string;
  timeout?: string;
  noAutoApprove: boolean;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
}

async function runAgent(args: RunAgentArgs): Promise<void> {
  const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
  const agentName = args.agent;
  const promptText = args.prompt;
  const sessionName = args.session;
  const cwd = args.cwd || process.cwd();
  const timeoutSecs = parsePositiveInt(args.timeout, "timeout", 300);

  const { registryConfig, configDir } = await loadRegistryContext();

  // Resolve the agent via unified registry
  const entry = await resolveAgentAsync(agentName, registryConfig, configDir);
  if (!entry) {
    error(`Unknown agent "${agentName}". Run \`am agent list\` to list available agents.`, opts);
    process.exitCode = 1;
    return;
  }

  // ADR-0033: tier-3 catalog-only agents cannot be spawned. Give the user
  // a concrete next step rather than "no ACP endpoint".
  if (entry.runnable === false) {
    error(
      `"${agentName}" is a catalog-only integration. am writes its config via \`am apply\` but cannot spawn it. Use it from its native UI (e.g., the ${agentName} VSCode extension). For a runnable alternative, see \`am agent list --tier native\`.`,
      opts,
    );
    process.exitCode = 1;
    return;
  }

  if (!entry.acp) {
    error(
      `Unknown agent "${agentName}" or no ACP (local) endpoint. Run \`am agent list\` to list available agents.`,
      opts,
    );
    process.exitCode = 1;
    return;
  }

  debug(`Resolved agent: ${agentName} -> ${entry.acp.command} (${entry.source})`, opts);

  const client = createAcpClient();

  // HIGH-1 fix: when --no-auto-approve is set, deny all permission requests
  if (args.noAutoApprove) {
    client.setPermissionPolicy("deny");
  }

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
    const conn = await client.connect(entry.acp.command, {
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
}

// ── Subcommand: am run agents (DEPRECATED alias) ───────────────
//
// Deprecation (ADR-0031 M2): this subcommand duplicated `am agent list`.
// The canonical surface is `am agent list` under the `agent` group
// (ADR-0029). This alias forwards to the same unified registry listing
// and prints a deprecation notice on stderr. Scheduled for removal at
// agent-manager 0.6.0 (two minor versions after introduction).

const agentsSubcommand = defineCommand({
  meta: {
    name: "agents",
    description: "DEPRECATED: use `am agent list` instead (same output, canonical surface)",
  },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    warn("`am run agents` is deprecated — use `am agent list` (same output).", opts);
    const { registryConfig, configDir } = await loadRegistryContext();
    const agents = await listAllAgentsAsync(registryConfig, configDir);

    if (args.json) {
      output({ agents, deprecated: "Use `am agent list` instead." }, opts);
      return;
    }

    info(`${"Name".padEnd(20)} ${"Protocol".padEnd(12)} ${"Source".padEnd(14)} Endpoint`, opts);
    info(`${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(14)} ${"─".repeat(44)}`, opts);
    for (const agent of agents) {
      const protocol = agent.acp && agent.a2a ? "ACP/A2A" : agent.acp ? "ACP" : "A2A";
      const endpoint = agent.acp?.command ?? agent.a2a?.url ?? "—";
      info(
        `${agent.name.padEnd(20)} ${protocol.padEnd(12)} ${agent.source.padEnd(14)} ${endpoint}`,
        opts,
      );
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
    const { registryConfig, configDir } = await loadRegistryContext();
    const entry = await resolveAgentAsync(agentName, registryConfig, configDir);

    if (!entry || !entry.acp) {
      error(`Unknown agent "${agentName}" or no ACP endpoint.`, opts);
      process.exitCode = 1;
      return;
    }

    const client = createAcpClient();
    try {
      await client.connect(entry.acp.command, { initTimeout: 30_000 });
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
    const { registryConfig, configDir } = await loadRegistryContext();
    const entry = await resolveAgentAsync(agentName, registryConfig, configDir);

    if (!entry || !entry.acp) {
      error(`Unknown agent "${agentName}" or no ACP endpoint.`, opts);
      process.exitCode = 1;
      return;
    }

    const client = createAcpClient();
    try {
      await client.connect(entry.acp.command, { initTimeout: 30_000 });
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
  meta: {
    name: "session",
    description: "Manage LIVE ACP agent sessions (for transcript browsing, see `am session`)",
  },
  subCommands: {
    list: () => Promise.resolve(sessionListSubcommand),
    cancel: () => Promise.resolve(sessionCancelSubcommand),
  },
});

/**
 * Iter4 Wave A: `am acp` top-level namespace for ACP-specific live-session
 * management. Moved out from under `am run` because the `run` root has
 * positional args (`<agent> <prompt>`) and citty treated subcommands as a
 * higher-precedence lookup, making `am run claude "..."` unreachable.
 *
 * Today only `session` lives here. Future: `am acp detect`, `am acp probe`.
 */
export const acpCommand = defineCommand({
  meta: {
    name: "acp",
    description: "ACP protocol operations (live sessions, agent probing)",
  },
  subCommands: {
    session: () => Promise.resolve(sessionSubcommand),
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
    "no-auto-approve": {
      type: "boolean",
      description: "Deny all permission requests from the agent (default: auto-approve)",
      default: false,
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
  // Iter4 Wave A: removed conflicting `agents` and `session` subcommands.
  // citty was routing the first positional through subCommand lookup, making
  // `am run claude "hello"` unreachable. `agents` deprecation is complete —
  // use `am agent list`. Live sessions live under `am acp session` (new
  // top-level namespace) via the exported sessionSubcommand below.
  async run({ args }) {
    // The main `am run <agent> <prompt>` form
    const promptText = args.prompt as string | undefined;
    if (!promptText) {
      error(
        'Usage: am run <agent> "<prompt>". ' +
          "For agent discovery use `am agent list`. " +
          "For live sessions use `am acp session list/cancel`.",
        {
          json: args.json,
          quiet: args.quiet,
        },
      );
      process.exitCode = 1;
      return;
    }

    await runAgent({
      agent: args.agent as string,
      prompt: promptText,
      session: args.session as string | undefined,
      cwd: args.cwd as string | undefined,
      timeout: args.timeout as string | undefined,
      noAutoApprove: ((args as Record<string, unknown>)["no-auto-approve"] as boolean) ?? false,
      json: args.json,
      quiet: args.quiet,
      verbose: args.verbose,
    });
  },
});
