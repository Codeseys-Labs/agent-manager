/**
 * Grouped help output for the root `am` command (ADR-0029).
 *
 * Commands are organized by category following the gh CLI pattern.
 * Hidden aliases (e.g. "agents") are omitted from help but still route.
 */
import { showUsage as cittyShowUsage } from "citty";

export const COMMAND_GROUPS: ReadonlyArray<{
  heading: string;
  commands: ReadonlyArray<[name: string, description: string]>;
}> = [
  {
    heading: "Config commands",
    commands: [
      ["init", "Initialize agent-manager config"],
      ["add", "Add an entity (server, instruction, skill, agent)"],
      ["list", "List entities (servers, instructions, skills, agents, profiles)"],
      ["use", "Switch active profile"],
      ["apply", "Generate native IDE configs from catalog"],
      ["status", "Check drift between catalog and IDE configs"],
      ["config", "Show or edit config"],
      ["profile", "Manage profiles"],
    ],
  },
  {
    heading: "Git commands",
    commands: [
      ["push", "Push config to remote"],
      ["pull", "Pull config from remote"],
      ["undo", "Revert last config change"],
      ["log", "Show config change history"],
    ],
  },
  {
    heading: "Registry commands",
    commands: [
      ["search", "Search MCP package registry"],
      ["install", "Install package from registry"],
      ["uninstall", "Remove installed package"],
      ["update", "Check for package updates"],
    ],
  },
  {
    heading: "Marketplace commands",
    commands: [["marketplace", "Manage git-based plugin marketplaces"]],
  },
  {
    heading: "Agent commands",
    commands: [
      ["agent", "Manage A2A agent roster"],
      ["run", "Run ACP agent with a prompt"],
      ["flow", "Run multi-step ACP workflows"],
    ],
  },
  {
    heading: "Wiki commands",
    commands: [
      ["wiki list", "List recent wiki entries"],
      ["wiki show", "Display a wiki entry by slug"],
      ["wiki search", "Full-text search across wiki entries"],
      ["wiki sync", "Push/pull the global wiki via git"],
      ["wiki path", "Print the local wiki directory path"],
    ],
  },
  {
    heading: "Tool commands",
    commands: [
      ["import", "Import from IDE native configs"],
      ["adapter", "Manage IDE adapters"],
      ["doctor", "Health check"],
      ["secret", "Manage secrets and encryption"],
      ["secrets", "Backend-level secrets ops (migrate, rewrap, rotate, revoke)"],
      ["pair", "Cross-device key handoff (ADR-0047)"],
      ["session", "Browse coding sessions"],
      ["version", "Show version"],
    ],
  },
  {
    heading: "Interface commands",
    commands: [
      ["mcp-serve", "Start MCP server"],
      ["mcp-superset", "Enforce project .mcp.json is a superset of global config"],
      ["tui", "Terminal dashboard"],
      ["serve", "Start web server"],
      ["completion", "Generate shell completions"],
    ],
  },
];

/** Render grouped help text for the root command. */
export function renderGroupedHelp(version: string): string {
  const lines: string[] = [];
  lines.push(`agent-manager (am) — the control plane for AI agents  v${version}`);
  lines.push("");

  for (const group of COMMAND_GROUPS) {
    lines.push(`${group.heading}:`);
    for (const [name, desc] of group.commands) {
      lines.push(`  ${name.padEnd(14)}${desc}`);
    }
    lines.push("");
  }

  lines.push("Global flags:");
  lines.push("  --profile     Override active profile");
  lines.push("  --json        JSON output for scripting/agents");
  lines.push("  -v, --verbose Increase log verbosity");
  lines.push("  -q, --quiet   Suppress non-essential output");
  lines.push("");
  lines.push("Run `am <command> --help` for more information about a command.");

  return lines.join("\n");
}

/**
 * Custom showUsage that prints grouped output for the root command
 * and falls back to citty's default for subcommand help.
 */
export async function showGroupedUsage(cmd: any, parent?: any): Promise<void> {
  // If there's a parent, this is a subcommand — use citty's default
  if (parent) {
    return cittyShowUsage(cmd, parent);
  }

  // Root command — check if this is actually a resolved subcommand
  // by seeing if it has the same name as our main command
  const meta = typeof cmd.meta === "function" ? await cmd.meta() : cmd.meta;
  if (meta?.name !== "am") {
    return cittyShowUsage(cmd, parent);
  }

  const { AM_VERSION } = await import("./lib/version");
  const version = meta?.version ?? AM_VERSION;
  console.log(renderGroupedHelp(version));
}
