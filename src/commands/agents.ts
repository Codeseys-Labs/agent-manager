/**
 * CLI: am agent — Manage A2A agent discovery, delegation, and roster.
 *
 * Subcommands:
 *   am agent list                        — list all discovered A2A agents
 *   am agent add <url> [--name alias]    — add agent by fetching its Agent Card
 *   am agent remove <name>               — remove from roster
 *   am agent ping <name>                 — verify reachable, show capabilities, update lastSeen
 *   am agent delegate <name> <task>      — send task, show response
 *   am agent delegate --url <url> <task> — one-off delegation without roster
 *   am agent cancel <name> <taskId>      — cancel a running task
 */

import { join } from "node:path";
import { defineCommand } from "citty";
import {
  AGENT_BINARIES,
  type AgentDetection,
  detectAgentByPath,
  detectAllAgents,
} from "../core/agent-detection";
import { BUILT_IN_ACP_AGENTS, listAllAgentsAsync } from "../core/agent-registry";
import type { UnifiedRegistryConfig } from "../core/agent-registry";
import { resolveConfigDir, tryReadConfig } from "../core/config";
import { error, info, output } from "../lib/output";
import { A2AClient } from "../protocols/a2a/client";
import {
  addToRoster,
  discoverFromConfig,
  discoverFromUrl,
  loadRoster,
  removeFromRoster,
  saveRoster,
} from "../protocols/a2a/discovery";
import type { AgentRosterEntry } from "../protocols/a2a/types";
import { AmAcpClient } from "../protocols/acp/client";

// ── Subcommands ─────────────────────────────────────────────────

const listSubcommand = defineCommand({
  meta: { name: "list", description: "List all agents (config, ACP built-in, A2A roster)" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    discover: {
      type: "boolean",
      description: "Also fetch agents from settings.a2a.discovery_sources",
      default: false,
    },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();
    const config = await tryReadConfig(join(configDir, "config.toml"));
    const registryConfig = config as UnifiedRegistryConfig | undefined;
    const agents = await listAllAgentsAsync(registryConfig, configDir);

    // Fetch discovered agents from config discovery_sources
    let discovered: { name: string; url: string; description: string }[] = [];
    if (args.discover) {
      const cards = await discoverFromConfig(configDir);
      const agentNames = new Set(agents.map((a) => a.name));
      discovered = cards
        .filter((c) => !agentNames.has(c.name))
        .map((c) => ({ name: c.name, url: c.url, description: c.description }));
    }

    if (args.json) {
      // Derive the protocol field explicitly for JSON consumers — the text
      // table does the same derivation inline (line below), so both formats
      // now agree. Fixes iter4 smoke Bug 4.
      const agentsWithProtocol = agents.map((agent) => ({
        ...agent,
        protocol: agent.acp && agent.a2a ? "ACP/A2A" : agent.acp ? "ACP" : "A2A",
        endpoint: agent.acp?.command ?? agent.a2a?.url ?? null,
      }));
      output({ agents: agentsWithProtocol, ...(args.discover ? { discovered } : {}) }, opts);
      return;
    }

    if (agents.length === 0 && discovered.length === 0) {
      info("No agents registered. Use `am agent add <url>` to add one.", opts);
      return;
    }

    info(
      `${"Name".padEnd(20)} ${"Protocol".padEnd(10)} ${"Source".padEnd(14)} ${"Installed".padEnd(12)} Endpoint`,
      opts,
    );
    info(
      `${"\u2500".repeat(20)} ${"\u2500".repeat(10)} ${"\u2500".repeat(14)} ${"\u2500".repeat(12)} ${"\u2500".repeat(40)}`,
      opts,
    );
    for (const agent of agents) {
      const protocol = agent.acp && agent.a2a ? "ACP/A2A" : agent.acp ? "ACP" : "A2A";
      const endpoint = agent.acp?.command ?? agent.a2a?.url ?? "\u2014";
      let installed: string;
      if (agent.installed === true) {
        installed = agent.version ? `yes (v${agent.version})` : "yes";
      } else if (agent.installed === false) {
        installed = "no";
      } else {
        installed = "\u2014";
      }
      info(
        `${agent.name.padEnd(20)} ${protocol.padEnd(10)} ${agent.source.padEnd(14)} ${installed.padEnd(12)} ${endpoint}`,
        opts,
      );
    }
    for (const agent of discovered) {
      info(
        `${agent.name.padEnd(20)} ${"A2A".padEnd(10)} ${"[discovered]".padEnd(14)} ${"\u2014".padEnd(12)} ${agent.url}`,
        opts,
      );
    }
    info(`\n${agents.length} registered, ${discovered.length} discovered`, opts);
  },
});

const addSubcommand = defineCommand({
  meta: { name: "add", description: "Add an A2A agent by URL" },
  args: {
    url: { type: "positional", description: "Agent base URL", required: true },
    name: { type: "string", description: "Override the Agent Card name for the roster key" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const url = args.url as string;

    info(`Discovering agent at ${url}...`, opts);

    const card = await discoverFromUrl(url);
    if (!card) {
      error(`No A2A Agent Card found at ${url}/.well-known/agent.json`, opts);
      process.exitCode = 1;
      return;
    }

    const rosterName = (args.name as string) || card.name;
    const configDir = resolveConfigDir();
    const entry: AgentRosterEntry = {
      name: rosterName,
      url: card.url || url,
      description: card.description,
      addedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      card,
    };

    await addToRoster(configDir, entry);

    if (args.json) {
      output({ action: "add", agent: entry, card }, opts);
      return;
    }

    info(`Added agent: ${rosterName}`, opts);
    if (rosterName !== card.name) {
      info(`  Card name: ${card.name}`, opts);
    }
    info(`  URL: ${entry.url}`, opts);
    info(`  Description: ${card.description}`, opts);
    info(`  Skills: ${card.skills.map((s) => s.id).join(", ")}`, opts);
    info(
      `  Capabilities: streaming=${card.capabilities.streaming ?? false}, pushNotifications=${card.capabilities.pushNotifications ?? false}`,
      opts,
    );
  },
});

const removeSubcommand = defineCommand({
  meta: { name: "remove", description: "Remove an A2A agent from the roster" },
  args: {
    name: { type: "positional", description: "Agent name", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const name = args.name as string;
    const configDir = resolveConfigDir();

    const removed = await removeFromRoster(configDir, name);

    if (args.json) {
      output({ action: "remove", name, removed }, opts);
      return;
    }

    if (removed) {
      info(`Removed agent: ${name}`, opts);
    } else {
      error(`Agent "${name}" not found in roster.`, opts);
      process.exitCode = 1;
    }
  },
});

const pingSubcommand = defineCommand({
  meta: { name: "ping", description: "Verify an A2A agent is reachable" },
  args: {
    name: { type: "positional", description: "Agent name", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const name = args.name as string;
    const configDir = resolveConfigDir();
    const roster = await loadRoster(configDir);
    const entry = roster.find((r) => r.name === name);

    if (!entry) {
      error(
        `Agent "${name}" not found in roster. Use \`am agent list\` to see registered agents.`,
        opts,
      );
      process.exitCode = 1;
      return;
    }

    info(`Pinging ${entry.url}...`, opts);

    const start = Date.now();
    const card = await discoverFromUrl(entry.url);
    const elapsed = Date.now() - start;

    if (!card) {
      if (args.json) {
        output({ name, url: entry.url, reachable: false, elapsed }, opts);
      } else {
        error(`Agent "${name}" is unreachable (no Agent Card at ${entry.url}).`, opts);
      }
      process.exitCode = 1;
      return;
    }

    // Update lastSeen in the roster after successful ping
    entry.lastSeen = new Date().toISOString();
    const fullRoster = await loadRoster(configDir);
    const idx = fullRoster.findIndex((r) => r.name === name);
    if (idx >= 0) {
      fullRoster[idx].lastSeen = entry.lastSeen;
      await saveRoster(configDir, fullRoster);
    }

    if (args.json) {
      output(
        {
          name,
          url: entry.url,
          reachable: true,
          elapsed,
          card,
        },
        opts,
      );
      return;
    }

    info(`Agent "${name}" is reachable (${elapsed}ms)`, opts);
    info(`  Version: ${card.version}`, opts);
    info(`  Skills: ${card.skills.length}`, opts);
    for (const skill of card.skills) {
      info(`    - ${skill.id}: ${skill.description}`, opts);
    }
    info("  Capabilities:", opts);
    info(`    streaming: ${card.capabilities.streaming ?? false}`, opts);
    info(`    pushNotifications: ${card.capabilities.pushNotifications ?? false}`, opts);
    info(`    stateTransitionHistory: ${card.capabilities.stateTransitionHistory ?? false}`, opts);
  },
});

const delegateSubcommand = defineCommand({
  meta: { name: "delegate", description: "Send a task to an A2A agent" },
  args: {
    name: { type: "positional", description: "Agent name (optional if --url is provided)" },
    task: { type: "positional", description: "Task message to send", required: true },
    url: { type: "string", description: "Agent URL for one-off delegation (skips roster lookup)" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const directUrl = args.url as string | undefined;
    const name = args.name as string | undefined;
    const taskText = args.task as string;

    let agentUrl: string;
    let agentName: string;

    if (directUrl) {
      // One-off delegation via --url — discover the card but don't add to roster
      info(`Discovering agent at ${directUrl}...`, opts);
      const card = await discoverFromUrl(directUrl);
      if (!card) {
        error(`No A2A Agent Card found at ${directUrl}/.well-known/agent.json`, opts);
        process.exitCode = 1;
        return;
      }
      agentUrl = card.url || directUrl;
      agentName = name || card.name;
    } else if (name) {
      // Roster-based delegation
      const configDir = resolveConfigDir();
      const roster = await loadRoster(configDir);
      const entry = roster.find((r) => r.name === name);

      if (!entry) {
        error(
          `Agent "${name}" not found in roster. Use \`am agent list\` to see registered agents, or use --url for one-off delegation.`,
          opts,
        );
        process.exitCode = 1;
        return;
      }
      agentUrl = entry.url;
      agentName = name;
    } else {
      error("Either provide an agent name or use --url for one-off delegation.", opts);
      process.exitCode = 1;
      return;
    }

    info(`Delegating to ${agentName} (${agentUrl})...`, opts);

    const client = new A2AClient({ timeout: 60_000 });
    const taskId = `am-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const result = await client.sendTask(agentUrl, {
        id: taskId,
        message: {
          role: "user",
          parts: [{ type: "text", text: taskText }],
        },
      });

      if (args.json) {
        output({ action: "delegate", agent: agentName, task: result }, opts);
        return;
      }

      info(`Task ${result.id}: ${result.status.state}`, opts);

      // Print agent response
      const lastMessage = result.status.message;
      if (lastMessage) {
        for (const part of lastMessage.parts) {
          if (part.type === "text") {
            info(`  ${part.text}`, opts);
          } else if (part.type === "data") {
            info(`  ${JSON.stringify(part.data, null, 2)}`, opts);
          }
        }
      }

      // Print artifacts
      if (result.artifacts && result.artifacts.length > 0) {
        info("\nArtifacts:", opts);
        for (const artifact of result.artifacts) {
          info(
            `  - ${artifact.name}${artifact.description ? `: ${artifact.description}` : ""}`,
            opts,
          );
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Delegation failed: ${message}`, opts);
      process.exitCode = 1;
    }
  },
});

const cancelSubcommand = defineCommand({
  meta: { name: "cancel", description: "Cancel a running task on an A2A agent" },
  args: {
    name: { type: "positional", description: "Agent name", required: true },
    taskId: { type: "positional", description: "Task ID to cancel", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const name = args.name as string;
    const taskId = args.taskId as string;
    const configDir = resolveConfigDir();
    const roster = await loadRoster(configDir);
    const entry = roster.find((r) => r.name === name);

    if (!entry) {
      error(
        `Agent "${name}" not found in roster. Use \`am agent list\` to see registered agents.`,
        opts,
      );
      process.exitCode = 1;
      return;
    }

    const client = new A2AClient({ timeout: 30_000 });

    try {
      const result = await client.cancelTask(entry.url, { id: taskId });

      if (args.json) {
        output({ action: "cancel", agent: name, task: result }, opts);
        return;
      }

      info(`Task ${result.id}: ${result.status.state}`, opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Cancel failed: ${message}`, opts);
      process.exitCode = 1;
    }
  },
});

// ── detect subcommand ──────────────────────────────────────────

/**
 * Deep-probe a single ACP agent by spawning its runtime, running the ACP
 * `initialize` handshake, and reporting the negotiated agentInfo. Returns
 * structured data usable by both the text and JSON renderers.
 */
async function deepProbe(
  name: string,
  command: string,
  timeoutMs: number,
): Promise<{
  name: string;
  probed: true;
  acpVerified: boolean;
  agentInfo?: { name?: string; version?: string };
  error?: string;
}> {
  const client = new AmAcpClient();
  try {
    const conn = await client.connect(command, { initTimeout: timeoutMs });
    await client.disconnect();
    return {
      name,
      probed: true,
      acpVerified: true,
      agentInfo: conn.agentInfo ?? undefined,
    };
  } catch (err: unknown) {
    // Best-effort cleanup — connect() already kills on failure, but guard here too.
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
    return {
      name,
      probed: true,
      acpVerified: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const detectSubcommand = defineCommand({
  meta: {
    name: "detect",
    description: "Detect which ACP agents are installed locally (deep probe when name given)",
  },
  args: {
    name: { type: "positional", description: "Agent name to deep-probe (optional)" },
    timeout: {
      type: "string",
      description: "Deep-probe timeout in ms (default 8000)",
      default: "8000",
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const name = args.name as string | undefined;
    const timeoutMs = Math.max(1, Number.parseInt(String(args.timeout), 10) || 8000);

    // Case A: single agent — deep probe.
    if (name) {
      const command = BUILT_IN_ACP_AGENTS[name];
      if (!command) {
        error(`Unknown built-in ACP agent: ${name}`, opts);
        process.exitCode = 1;
        return;
      }
      const cheap = detectAgentByPath(name);
      const probe = await deepProbe(name, command, timeoutMs);

      if (args.json) {
        output({ name, cheap, deep: probe }, opts);
        return;
      }

      info(`Agent: ${name}`, opts);
      info(`  PATH binary: ${AGENT_BINARIES[name] ?? "(none mapped)"}`, opts);
      info(`  PATH check: ${cheap.installed ? `found at ${cheap.binary}` : "not found"}`, opts);
      info(`  ACP command: ${command}`, opts);
      if (probe.acpVerified) {
        info("  ACP handshake: verified", opts);
        if (probe.agentInfo?.name) info(`    agent name: ${probe.agentInfo.name}`, opts);
        if (probe.agentInfo?.version) info(`    agent version: ${probe.agentInfo.version}`, opts);
      } else {
        info(`  ACP handshake: failed (${probe.error ?? "unknown error"})`, opts);
      }
      return;
    }

    // Case B: no name — cheap scan of every built-in.
    const detections = await detectAllAgents();

    if (args.json) {
      output({ agents: detections }, opts);
      return;
    }

    info(
      `${"Name".padEnd(20)} ${"Installed".padEnd(12)} ${"Source".padEnd(10)} ${"Binary".padEnd(12)} Path/Notes`,
      opts,
    );
    info(
      `${"\u2500".repeat(20)} ${"\u2500".repeat(12)} ${"\u2500".repeat(10)} ${"\u2500".repeat(12)} ${"\u2500".repeat(40)}`,
      opts,
    );

    const names = Object.keys(BUILT_IN_ACP_AGENTS).sort();
    let installedCount = 0;
    for (const agentName of names) {
      const d: AgentDetection = detections[agentName] ?? { installed: false, source: "none" };
      if (d.installed) installedCount += 1;
      const installed = d.installed ? (d.version ? `yes (v${d.version})` : "yes") : "no";
      const binary = AGENT_BINARIES[agentName] ?? "\u2014";
      const notes = d.binary ?? (d.adapterDetected ? "(adapter host detected)" : "");
      info(
        `${agentName.padEnd(20)} ${installed.padEnd(12)} ${d.source.padEnd(10)} ${binary.padEnd(12)} ${notes}`,
        opts,
      );
    }
    info(`\n${installedCount} of ${names.length} built-in ACP agents installed.`, opts);
  },
});

// ── Main Command ────────────────────────────────────────────────

export const agentsCommand = defineCommand({
  meta: { name: "agent", description: "Manage A2A agent discovery and delegation" },
  subCommands: {
    list: () => Promise.resolve(listSubcommand),
    add: () => Promise.resolve(addSubcommand),
    remove: () => Promise.resolve(removeSubcommand),
    ping: () => Promise.resolve(pingSubcommand),
    detect: () => Promise.resolve(detectSubcommand),
    delegate: () => Promise.resolve(delegateSubcommand),
    cancel: () => Promise.resolve(cancelSubcommand),
  },
});
