#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { showGroupedUsage } from "./help";

const main = defineCommand({
  meta: {
    name: "am",
    version: process.env.BUILD_VERSION ?? "0.1.0",
    description:
      "chezmoi for AI agent configs — define once in TOML, sync via git, generate native configs for every tool",
  },
  args: {
    profile: { type: "string", description: "Override active profile" },
    json: { type: "boolean", description: "JSON output for scripting/agents", default: false },
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
    version: () => import("./commands/version").then((m) => m.versionCommand),
    adapter: () => import("./commands/adapter").then((m) => m.adapterCommand),
    "mcp-serve": () => import("./commands/mcp-serve").then((m) => m.mcpServeCommand),
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
  },
});

runMain(main, { showUsage: showGroupedUsage });
