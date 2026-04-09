import { defineCommand } from "citty";
import { getAdapter, listAdapters } from "../adapters/registry";
import { info, output } from "../lib/output";

const listSubcommand = defineCommand({
  meta: { name: "list", description: "Show all registered adapters" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const names = listAdapters();

    const rows: Array<{
      name: string;
      displayName: string;
      capabilities: string[];
      installed: boolean;
      version?: string;
    }> = [];

    for (const name of names) {
      const adapter = await getAdapter(name);
      if (!adapter) continue;
      const detect = adapter.detect();
      rows.push({
        name: adapter.meta.name,
        displayName: adapter.meta.displayName,
        capabilities: adapter.meta.capabilities,
        installed: detect.installed,
        version: detect.version,
      });
    }

    if (args.json) {
      output({ adapters: rows }, opts);
      return;
    }

    info(
      `${"Name".padEnd(16)} ${"Display Name".padEnd(20)} ${"Capabilities".padEnd(30)} ${"Detected"}`,
      opts,
    );
    info(`${"─".repeat(16)} ${"─".repeat(20)} ${"─".repeat(30)} ${"─".repeat(10)}`, opts);
    for (const r of rows) {
      const detected = r.installed ? (r.version ? `yes (${r.version})` : "yes") : "no";
      info(
        `${r.name.padEnd(16)} ${r.displayName.padEnd(20)} ${r.capabilities.join(", ").padEnd(30)} ${detected}`,
        opts,
      );
    }
    info(`\n${rows.length} adapter(s)`, opts);
  },
});

export const adapterCommand = defineCommand({
  meta: { name: "adapter", description: "Manage adapters" },
  subCommands: {
    list: () => Promise.resolve(listSubcommand),
  },
});
