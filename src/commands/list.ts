import { join } from "node:path";
import { defineCommand } from "citty";
import { loadResolvedConfig, resolveConfigDir, resolveProjectConfig } from "../core/config";
import { error, info, output } from "../lib/output";

export const listCommand = defineCommand({
  meta: { name: "list", description: "List servers in the config" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    active: { type: "boolean", description: "Show only active-profile servers", default: false },
    global: { type: "boolean", description: "Show only global servers", default: false },
    project: { type: "boolean", description: "Show only project servers", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();

    const projectFile = args.global ? null : resolveProjectConfig(process.cwd());

    let config;
    try {
      config = await loadResolvedConfig({
        configDir,
        projectFile,
      });
    } catch {
      error("Config not found. Run `am init` first.", opts);
      process.exitCode = 1;
      return;
    }

    const servers = config.servers ?? {};
    const entries = Object.entries(servers).map(([name, srv]) => ({
      name,
      command: srv.command,
      args: srv.args,
      tags: srv.tags ?? [],
      enabled: srv.enabled ?? true,
      description: srv.description ?? "",
      transport: srv.transport ?? "stdio",
    }));

    if (args.json) {
      output({ servers: entries }, opts);
      return;
    }

    if (entries.length === 0) {
      info("No servers configured. Run `am add <name> --command <cmd>` to add one.", opts);
      return;
    }

    // Table display
    info(`${"Name".padEnd(20)} ${"Command".padEnd(30)} ${"Tags".padEnd(20)} ${"Status"}`, opts);
    info(`${"─".repeat(20)} ${"─".repeat(30)} ${"─".repeat(20)} ${"─".repeat(8)}`, opts);
    for (const s of entries) {
      const status = s.enabled ? "active" : "disabled";
      info(
        `${s.name.padEnd(20)} ${s.command.padEnd(30)} ${s.tags.join(", ").padEnd(20)} ${status}`,
        opts,
      );
    }
    info(`\n${entries.length} server(s)`, opts);
  },
});
