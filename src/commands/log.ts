import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { log as gitLog, type LogEntry } from "../core/git";
import { output, info, error } from "../lib/output";

/**
 * Format a log entry with a prefix icon based on the commit message:
 * + add, - remove, ↓ import, ↶ revert, ● other
 */
export function formatLogEntry(entry: LogEntry): string {
  const msg = entry.message;
  let prefix = "\u25CF"; // ● default
  if (msg.startsWith("add ")) prefix = "+";
  else if (msg.startsWith("remove ")) prefix = "-";
  else if (msg.startsWith("import")) prefix = "\u2193"; // ↓
  else if (msg.startsWith("revert")) prefix = "\u21B6"; // ↶

  const shortOid = entry.oid.substring(0, 7);
  const date = new Date(entry.author.timestamp * 1000);
  const dateStr = date.toISOString().substring(0, 10);

  return `${prefix} ${shortOid} ${dateStr} ${msg}`;
}

export const logCommand = defineCommand({
  meta: { name: "log", description: "Show config change history" },
  args: {
    count: { type: "string", description: "Number of entries to show", default: "20" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();

    let entries;
    try {
      entries = await gitLog(configDir, parseInt(args.count, 10));
    } catch {
      error("Cannot read git log. Run `am init` first.", opts);
      return;
    }

    if (args.json) {
      output({ log: entries }, opts);
      return;
    }

    if (entries.length === 0) {
      info("No history yet.", opts);
      return;
    }

    for (const entry of entries) {
      info(formatLogEntry(entry), opts);
    }
  },
});
