/**
 * Unified Agent Registry — merges config, ACP built-in, and A2A roster agents.
 *
 * Resolution order (highest wins):
 *   1. Config agents ([agents.<name>.acp] / [agents.<name>.a2a] in TOML)
 *   2. ACP built-in registry (16 known agents)
 *   3. A2A roster (agents.toml in config directory)
 *
 * See ADR-0030 for rationale.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { isNotFound } from "../lib/errors";

// ── Types ──────────────────────────────────────────────────────

export interface UnifiedAgent {
  name: string;
  description?: string;
  source: "config" | "acp-builtin" | "a2a-roster";
  acp?: { command: string };
  a2a?: { url: string };
  /** True if the agent's runtime is actually available locally (PATH or paired adapter). */
  installed?: boolean;
  /** Tool version if cheaply derivable. */
  version?: string;
}

/** Shape of [agents.<name>] in config TOML for the unified registry. */
export interface ConfigAgentEntry {
  description?: string;
  acp?: { command: string };
  a2a?: { url: string };
}

/** Shape of the config TOML relevant to the unified registry. */
export interface UnifiedRegistryConfig {
  agents?: Record<string, ConfigAgentEntry>;
}

// ── Built-in ACP registry ──────────────────────────────────────

/** Known ACP-compatible agents and their spawn commands. */
export const BUILT_IN_ACP_AGENTS: Record<string, string> = {
  claude: "npx -y @agentclientprotocol/claude-agent-acp@latest",
  codex: "npx @zed-industries/codex-acp@latest",
  gemini: "gemini --acp",
  cursor: "cursor-agent acp",
  copilot: "copilot --acp --stdio",
  kiro: "kiro-cli-chat acp",
  aider: "aider --acp",
  "amazon-q": "q chat --acp",
  amp: "amp --acp",
  augment: "augment-cli --acp",
  cline: "cline --acp",
  "roo-code": "roo --acp",
  goose: "goose --acp",
  windsurf: "windsurf-cli --acp",
  devin: "devin --acp",
  sourcegraph: "cody --acp",
};

// ── A2A roster reading ─────────────────────────────────────────

interface RosterToml {
  agents?: Record<
    string,
    {
      url: string;
      description?: string;
      added_at: string;
      last_seen?: string;
    }
  >;
}

async function readRoster(
  configDir: string,
): Promise<Record<string, { url: string; description?: string }>> {
  const rosterPath = join(configDir, "agents.toml");
  let raw: string;
  try {
    raw = await readFile(rosterPath, "utf-8");
  } catch (err: unknown) {
    if (isNotFound(err)) return {};
    throw err;
  }

  const parsed = TOML.parse(raw) as unknown as RosterToml;
  const agents = parsed.agents ?? {};
  const result: Record<string, { url: string; description?: string }> = {};
  for (const [name, entry] of Object.entries(agents)) {
    result[name] = { url: entry.url, description: entry.description };
  }
  return result;
}

// ── Resolution ─────────────────────────────────────────────────

/**
 * Resolve an agent name to a UnifiedAgent entry.
 *
 * Resolution order:
 *   1. Config agents (from the parsed config object)
 *   2. ACP built-in registry
 *   3. A2A roster (agents.toml)
 *
 * For sources 2+3, entries are merged: if the same name appears in both
 * the ACP built-in registry and the A2A roster, the result has both
 * acp and a2a fields.
 *
 * Config agents take full priority — when a name appears in config,
 * built-in and roster entries for that name are ignored.
 */
export function resolveAgent(
  name: string,
  config?: UnifiedRegistryConfig,
  rosterAgents?: Record<string, { url: string; description?: string }>,
): UnifiedAgent | null {
  // 1. Config override
  const configAgent = config?.agents?.[name];
  if (configAgent && (configAgent.acp || configAgent.a2a)) {
    return {
      name,
      description: configAgent.description,
      source: "config",
      ...(configAgent.acp ? { acp: { command: configAgent.acp.command } } : {}),
      ...(configAgent.a2a ? { a2a: { url: configAgent.a2a.url } } : {}),
    };
  }

  // 2+3. Merge built-in ACP + A2A roster
  const builtInCommand = BUILT_IN_ACP_AGENTS[name];
  const rosterEntry = rosterAgents?.[name];

  if (builtInCommand && rosterEntry) {
    // Both sources — return merged entry, source is acp-builtin (primary)
    return {
      name,
      description: rosterEntry.description,
      source: "acp-builtin",
      acp: { command: builtInCommand },
      a2a: { url: rosterEntry.url },
    };
  }

  if (builtInCommand) {
    return {
      name,
      source: "acp-builtin",
      acp: { command: builtInCommand },
    };
  }

  if (rosterEntry) {
    return {
      name,
      description: rosterEntry.description,
      source: "a2a-roster",
      a2a: { url: rosterEntry.url },
    };
  }

  return null;
}

/**
 * Async variant of resolveAgent that reads the A2A roster from disk.
 * Use this when you don't already have roster data loaded.
 */
export async function resolveAgentAsync(
  name: string,
  config?: UnifiedRegistryConfig,
  configDir?: string,
): Promise<UnifiedAgent | null> {
  const rosterAgents = configDir ? await readRoster(configDir) : undefined;
  return resolveAgent(name, config, rosterAgents);
}

/**
 * List all agents across all three sources, merged without duplicates.
 *
 * Config agents take priority over built-in and roster entries.
 * Built-in and roster entries for the same name are merged into one entry.
 */
export function listAllAgents(
  config?: UnifiedRegistryConfig,
  rosterAgents?: Record<string, { url: string; description?: string }>,
): UnifiedAgent[] {
  const result = new Map<string, UnifiedAgent>();

  // 1. Built-in ACP agents (lowest priority, added first)
  for (const [name, command] of Object.entries(BUILT_IN_ACP_AGENTS)) {
    result.set(name, {
      name,
      source: "acp-builtin",
      acp: { command },
    });
  }

  // 2. A2A roster agents — merge with existing built-in entries
  if (rosterAgents) {
    for (const [name, entry] of Object.entries(rosterAgents)) {
      const existing = result.get(name);
      if (existing) {
        // Merge: add A2A to existing ACP built-in
        existing.a2a = { url: entry.url };
        if (entry.description) existing.description = entry.description;
      } else {
        result.set(name, {
          name,
          description: entry.description,
          source: "a2a-roster",
          a2a: { url: entry.url },
        });
      }
    }
  }

  // 3. Config agents (highest priority, override everything)
  if (config?.agents) {
    for (const [name, agent] of Object.entries(config.agents)) {
      if (!agent.acp && !agent.a2a) continue;
      result.set(name, {
        name,
        description: agent.description,
        source: "config",
        ...(agent.acp ? { acp: { command: agent.acp.command } } : {}),
        ...(agent.a2a ? { a2a: { url: agent.a2a.url } } : {}),
      });
    }
  }

  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Options controlling `listAllAgentsAsync` behaviour.
 */
export interface ListAllAgentsAsyncOptions {
  /**
   * When true, populate `installed` / `version` on each returned agent by
   * running the cheap agent-detection pipeline. Config-source agents are
   * assumed installed (the user declared them). Default: true.
   * Disable via `detect: false` on hot paths that must avoid even cheap I/O.
   */
  detect?: boolean;
}

/**
 * Async variant of listAllAgents that reads the A2A roster from disk and —
 * unless explicitly disabled — fills in `installed` / `version` on each
 * agent using `detectAllAgents()`.
 */
export async function listAllAgentsAsync(
  config?: UnifiedRegistryConfig,
  configDir?: string,
  options?: ListAllAgentsAsyncOptions,
): Promise<UnifiedAgent[]> {
  const rosterAgents = configDir ? await readRoster(configDir) : undefined;
  const agents = listAllAgents(config, rosterAgents);

  const detect = options?.detect !== false;
  if (!detect) return agents;

  // Populate installed/version fields. Lazy import to avoid a cycle between
  // core/agent-registry and core/agent-detection (the latter imports
  // BUILT_IN_ACP_AGENTS from here).
  const { detectAllAgents } = await import("./agent-detection");
  const detections = await detectAllAgents();

  return agents.map((agent) => {
    // Config-source agents: user-declared commands/URLs — assume installed.
    if (agent.source === "config") {
      return { ...agent, installed: true };
    }
    const detection = detections[agent.name];
    if (!detection) {
      // A2A-only roster entries or unknown agents — leave `installed`
      // unset, the caller can treat as "unknown" or probe via HTTP ping.
      return agent;
    }
    return {
      ...agent,
      installed: detection.installed,
      ...(detection.version ? { version: detection.version } : {}),
    };
  });
}
