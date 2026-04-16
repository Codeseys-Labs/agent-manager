/**
 * ACP Agent Registry — resolves agent names to spawn commands.
 *
 * Resolution order:
 *   1. Config overrides ([settings.acp.agents.<name>] in TOML)
 *   2. Built-in registry (known ACP-compatible agents)
 *
 * See ADR-0026 for rationale.
 */

import type { AcpSettings, AgentRegistryEntry } from "./types";

// ── Built-in registry ──────────────────────────────────────────

/** Known ACP-compatible agents and their spawn commands. */
const BUILT_IN_REGISTRY: Record<string, string> = {
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

// ── Resolution ─────────────────────────────────────────────────

/**
 * Resolve an agent name to a spawn command.
 *
 * Checks config overrides first, then the built-in registry.
 * Returns null if the agent is unknown.
 */
export function resolveAgent(name: string, acpSettings?: AcpSettings): AgentRegistryEntry | null {
  // 1. Config override
  const configAgent = acpSettings?.agents?.[name];
  if (configAgent?.command) {
    return { command: configAgent.command, source: "config" };
  }

  // 2. Built-in registry
  const builtIn = BUILT_IN_REGISTRY[name];
  if (builtIn) {
    return { command: builtIn, source: "built-in" };
  }

  return null;
}

/**
 * List all known agents (built-in + config overrides).
 * Config overrides replace built-in entries with the same name.
 */
export function listAgents(acpSettings?: AcpSettings): (AgentRegistryEntry & { name: string })[] {
  const result = new Map<string, AgentRegistryEntry & { name: string }>();

  // Add built-in entries
  for (const [name, command] of Object.entries(BUILT_IN_REGISTRY)) {
    result.set(name, { name, command, source: "built-in" });
  }

  // Override with config entries
  if (acpSettings?.agents) {
    for (const [name, agent] of Object.entries(acpSettings.agents)) {
      if (agent.command) {
        result.set(name, { name, command: agent.command, source: "config" });
      }
    }
  }

  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse a command string into [executable, ...args].
 * Handles simple space-separated commands. Quoted args are not supported.
 */
export function parseCommand(command: string): { executable: string; args: string[] } {
  const parts = command.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Empty agent command");
  }
  return { executable: parts[0], args: parts.slice(1) };
}
