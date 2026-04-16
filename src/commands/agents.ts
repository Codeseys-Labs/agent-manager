/**
 * CLI: am agents — Manage A2A agent discovery, delegation, and roster.
 *
 * Subcommands:
 *   am agents list                        — list all discovered A2A agents
 *   am agents add <url> [--name alias]    — add agent by fetching its Agent Card
 *   am agents remove <name>               — remove from roster
 *   am agents ping <name>                 — verify reachable, show capabilities, update lastSeen
 *   am agents delegate <name> <task>      — send task, show response
 *   am agents delegate --url <url> <task> — one-off delegation without roster
 *   am agents cancel <name> <taskId>      — cancel a running task
 */

import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
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

// ── Subcommands ─────────────────────────────────────────────────

const listSubcommand = defineCommand({
  meta: { name: "list", description: "List all discovered A2A agents" },
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
    const roster = await loadRoster(configDir);

    // Fetch discovered agents from config discovery_sources
    let discovered: { name: string; url: string; description: string }[] = [];
    if (args.discover) {
      const cards = await discoverFromConfig(configDir);
      const rosterNames = new Set(roster.map((r) => r.name));
      discovered = cards
        .filter((c) => !rosterNames.has(c.name))
        .map((c) => ({ name: c.name, url: c.url, description: c.description }));
    }

    if (args.json) {
      output({ agents: roster, ...(args.discover ? { discovered } : {}) }, opts);
      return;
    }

    if (roster.length === 0 && discovered.length === 0) {
      info("No agents registered. Use `am agents add <url>` to add one.", opts);
      return;
    }

    info(`${"Name".padEnd(24)} ${"URL".padEnd(40)} ${"Source"}`, opts);
    info(`${"\u2500".repeat(24)} ${"\u2500".repeat(40)} ${"\u2500".repeat(20)}`, opts);
    for (const agent of roster) {
      const added = agent.addedAt.slice(0, 16).replace("T", " ");
      info(`${agent.name.padEnd(24)} ${agent.url.padEnd(40)} ${added}`, opts);
    }
    for (const agent of discovered) {
      info(`${agent.name.padEnd(24)} ${agent.url.padEnd(40)} [discovered]`, opts);
    }
    info(`\n${roster.length} registered, ${discovered.length} discovered`, opts);
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
        `Agent "${name}" not found in roster. Use \`am agents list\` to see registered agents.`,
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
          `Agent "${name}" not found in roster. Use \`am agents list\` to see registered agents, or use --url for one-off delegation.`,
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
        `Agent "${name}" not found in roster. Use \`am agents list\` to see registered agents.`,
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

// ── Main Command ────────────────────────────────────────────────

export const agentsCommand = defineCommand({
  meta: { name: "agents", description: "Manage A2A agent discovery and delegation" },
  subCommands: {
    list: () => Promise.resolve(listSubcommand),
    add: () => Promise.resolve(addSubcommand),
    remove: () => Promise.resolve(removeSubcommand),
    ping: () => Promise.resolve(pingSubcommand),
    delegate: () => Promise.resolve(delegateSubcommand),
    cancel: () => Promise.resolve(cancelSubcommand),
  },
});
