import { defineCommand } from "citty";
import { join } from "node:path";
import { resolveConfigDir, readConfig, writeConfig } from "../core/config";
import { commitAll } from "../core/git";
import { output, info, error } from "../lib/output";
import type { Server } from "../core/schema";

export const addCommand = defineCommand({
  meta: { name: "add", description: "Add a server to the config" },
  args: {
    name: { type: "positional", description: "Server name", required: true },
    command: { type: "string", description: "Command to run", required: true },
    args: { type: "string", description: "Comma-separated args" },
    tags: { type: "string", description: "Comma-separated tags" },
    description: { type: "string", description: "Server description" },
    env: { type: "string", description: "Comma-separated KEY=VALUE pairs" },
    project: { type: "boolean", description: "Add to project config instead of global", default: false },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    let config;
    try {
      config = await readConfig(configPath);
    } catch {
      error("Config not found. Run `am init` first.", opts);
      return;
    }

    const name = args.name;

    // Check for duplicate
    if (config.servers?.[name]) {
      error(`Server "${name}" already exists. Remove it first or use a different name.`, opts);
      return;
    }

    // Build server entry
    const server: Server = {
      command: args.command,
      transport: "stdio",
      enabled: true,
    };
    if (args.args) server.args = args.args.split(",").map((s) => s.trim());
    if (args.tags) server.tags = args.tags.split(",").map((s) => s.trim());
    if (args.description) server.description = args.description;
    if (args.env) {
      server.env = {};
      for (const pair of args.env.split(",")) {
        const [k, ...rest] = pair.split("=");
        if (k && rest.length > 0) server.env[k.trim()] = rest.join("=").trim();
      }
    }

    // Add to config
    if (!config.servers) config.servers = {};
    config.servers[name] = server;

    await writeConfig(configPath, config);

    // Auto-commit
    const tagStr = server.tags?.length ? ` (${server.tags.join(", ")})` : "";
    try {
      await commitAll(configDir, `add server: ${name}${tagStr}`);
    } catch {
      // Nothing to commit is fine (shouldn't happen here but be safe)
    }

    info(`Added server "${name}"`, opts);
    if (args.json) {
      output({ action: "add", server: name, config: server }, opts);
    }
  },
});
