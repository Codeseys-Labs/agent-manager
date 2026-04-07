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
    version: () => import("./commands/version").then((m) => m.versionCommand),
  },
});

runMain(main);
