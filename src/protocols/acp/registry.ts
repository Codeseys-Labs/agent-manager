/**
 * ACP Agent Registry — resolves agent names to spawn commands.
 *
 * Resolution order:
 *   1. Config overrides ([settings.acp.agents.<name>] in TOML)
 *   2. Built-in registry (known ACP-compatible agents)
 *
 * See ADR-0026 for rationale.
 */

import { BUILT_IN_ACP_AGENTS } from "../../core/agent-registry";
import type { AcpSettings, AgentRegistryEntry } from "./types";

// Canonical ACP built-in list lives in src/core/agent-registry.ts per ADR-0030.
// This file keeps the thin protocol-local lookup/tokenizer API; the dict is
// imported to avoid drift.
const BUILT_IN_REGISTRY = BUILT_IN_ACP_AGENTS;

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
 *
 * Shell-style tokenizer: splits on whitespace while respecting single and
 * double quotes. Escape characters (`\`) work inside double quotes and in
 * unquoted regions; inside single quotes everything is literal.
 *
 * Intentionally does NOT expand shell metacharacters (`&&`, `|`, `;`, `$(...)`,
 * globs, env vars). Those survive as literal tokens so callers passing the
 * result to `Bun.spawn([...])` won't trigger shell interpretation.
 *
 * Throws on empty input or an unterminated quoted string.
 */
export function parseCommand(command: string): { executable: string; args: string[] } {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false; // distinguishes "" from "no token yet"

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === "\\" && i + 1 < command.length) {
        const next = command[i + 1];
        // In POSIX double-quotes, backslash only escapes " \ $ ` and newline.
        // For any other char, the backslash is preserved literally.
        if (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n") {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
      continue;
    }

    // Unquoted
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      current += command[i + 1];
      hasToken = true;
      i++;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }

  if (inSingle || inDouble) {
    throw new Error("Unterminated quoted string in agent command");
  }
  if (hasToken) tokens.push(current);

  if (tokens.length === 0) {
    throw new Error("Empty agent command");
  }
  return { executable: tokens[0], args: tokens.slice(1) };
}
