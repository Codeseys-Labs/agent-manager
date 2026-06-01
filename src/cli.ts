#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { showGroupedUsage } from "./help";
import { resolveParentHelp } from "./lib/parent-help";
import { AM_VERSION } from "./lib/version";

const main = defineCommand({
  meta: {
    name: "am",
    version: AM_VERSION,
    description:
      "The control plane for your AI agents — catalog + git sync, MCP gateway, ACP/A2A router, marketplace, LLM-wiki, three UIs",
  },
  // Global flags are also accepted as args on every subcommand (each command
  // re-declares json/quiet/verbose, and profile-aware commands accept
  // --profile). Per citty's per-level parsing, place a flag AFTER the command
  // it should affect — e.g. `am wiki list --json`, not `am --json wiki list`.
  args: {
    profile: {
      type: "string",
      description: "Override active profile (place after the command: `am list --profile work`)",
    },
    json: {
      type: "boolean",
      description: "JSON output for scripting/agents (place after the command)",
      default: false,
    },
    verbose: { type: "boolean", alias: "v", description: "Increase log verbosity", default: false },
    quiet: {
      type: "boolean",
      alias: "q",
      description: "Suppress non-essential output",
      default: false,
    },
  },
  subCommands: {
    init: () => import("./commands/init").then((m) => m.initCommand),
    setup: () => import("./commands/setup").then((m) => m.setupCommand),
    add: () => import("./commands/add").then((m) => m.addCommand),
    list: () => import("./commands/list").then((m) => m.listCommand),
    use: () => import("./commands/use").then((m) => m.useCommand),
    apply: () => import("./commands/apply").then((m) => m.applyCommand),
    status: () => import("./commands/status").then((m) => m.statusCommand),
    config: () => import("./commands/config").then((m) => m.configCommand),
    profile: () => import("./commands/profile").then((m) => m.profileCommand),
    doctor: () => import("./commands/doctor").then((m) => m.doctorCommand),
    import: () => import("./commands/import").then((m) => m.importCommand),
    push: () => import("./commands/push").then((m) => m.pushCommand),
    pull: () => import("./commands/pull").then((m) => m.pullCommand),
    undo: () => import("./commands/undo").then((m) => m.undoCommand),
    log: () => import("./commands/log").then((m) => m.logCommand),
    secret: () => import("./commands/secret").then((m) => m.secretCommand),
    secrets: () => import("./commands/secrets").then((m) => m.secretsCommand),
    version: () => import("./commands/version").then((m) => m.versionCommand),
    adapter: () => import("./commands/adapter").then((m) => m.adapterCommand),
    "mcp-serve": () => import("./commands/mcp-serve").then((m) => m.mcpServeCommand),
    "mcp-superset": () => import("./commands/mcp-superset").then((m) => m.mcpSupersetCommand),
    serve: () => import("./commands/serve").then((m) => m.serveCommand),
    tui: () => import("./commands/tui").then((m) => m.tuiCommand),
    session: () => import("./commands/session").then((m) => m.sessionCommand),
    search: () => import("./commands/search").then((m) => m.searchCommand),
    install: () => import("./commands/install").then((m) => m.installCommand),
    uninstall: () => import("./commands/uninstall").then((m) => m.uninstallCommand),
    update: () => import("./commands/update").then((m) => m.updateCommand),
    wiki: () => import("./commands/wiki").then((m) => m.wikiCommand),
    agent: () => import("./commands/agents").then((m) => m.agentsCommand),
    agents: () => import("./commands/agents").then((m) => m.agentsCommand),
    run: () => import("./commands/run").then((m) => m.runCommand),
    acp: () => import("./commands/run").then((m) => m.acpCommand),
    flow: () => import("./commands/flow").then((m) => m.flowCommand),
    completion: () => import("./commands/completion").then((m) => m.completionCommand),
    marketplace: () => import("./commands/marketplace").then((m) => m.marketplaceCommand),
    pair: () => import("./commands/pair").then((m) => m.pairCommand),
  },
});

/**
 * UX-1: parent commands (those with `subCommands` but no `run`) print help and
 * exit 0 when invoked with no subcommand — standard CLI behavior (git, gh,
 * docker, cargo) — instead of citty's default "No command specified." + exit 1.
 * `--help`/`-h` and real subcommands fall through to citty unchanged.
 */
async function start(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const parentHelp = await resolveParentHelp(main, rawArgs);
  if (parentHelp) {
    await showGroupedUsage(parentHelp.cmd, parentHelp.parent);
    process.exit(0);
  }
  await runMain(main, { showUsage: showGroupedUsage });
}

start();
