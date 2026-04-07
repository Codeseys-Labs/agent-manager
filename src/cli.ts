#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "am",
    version: "0.1.0",
    description: "chezmoi for AI agent configs — define once in TOML, sync via git, generate native configs for every tool",
  },
  args: {
    profile: { type: "string", description: "Override active profile" },
    json: { type: "boolean", description: "JSON output for scripting/agents", default: false },
    verbose: { type: "boolean", alias: "v", description: "Increase log verbosity", default: false },
    quiet: { type: "boolean", alias: "q", description: "Suppress non-essential output", default: false },
  },
  subCommands: {
    init: () => import("./commands/init").then((m) => m.initCommand),
    add: () => import("./commands/add").then((m) => m.addCommand),
    list: () => import("./commands/list").then((m) => m.listCommand),
    use: () => import("./commands/use").then((m) => m.useCommand),
    apply: () => import("./commands/apply").then((m) => m.applyCommand),
    status: () => import("./commands/status").then((m) => m.statusCommand),
    import: () => import("./commands/import").then((m) => m.importCommand),
    push: () => import("./commands/push").then((m) => m.pushCommand),
    pull: () => import("./commands/pull").then((m) => m.pullCommand),
    undo: () => import("./commands/undo").then((m) => m.undoCommand),
    log: () => import("./commands/log").then((m) => m.logCommand),
    version: () => import("./commands/version").then((m) => m.versionCommand),
  },
});

runMain(main);
