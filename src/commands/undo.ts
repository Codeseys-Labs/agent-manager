import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { log as gitLog, revertHead } from "../core/git";
import { error, info, output } from "../lib/output";

export const undoCommand = defineCommand({
  meta: { name: "undo", description: "Revert the last config change" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();

    // Show what will be reverted
    let entries;
    try {
      entries = await gitLog(configDir, 2);
    } catch {
      error("Cannot read git log. Run `am init` first.", opts);
      process.exitCode = 1;
      return;
    }

    if (entries.length < 2) {
      error("Nothing to undo — only the initial commit exists", opts);
      process.exitCode = 1;
      return;
    }

    const headMsg = entries[0].message;

    try {
      const oid = await revertHead(configDir);
      info(`Reverted: "${headMsg}"`, opts);
      info("Run `am apply` to regenerate native configs", opts);
      if (args.json) {
        output({ action: "undo", reverted: headMsg, oid }, opts);
      }
    } catch (e: any) {
      error(`Undo failed: ${e?.message ?? "unknown error"}`, opts);
      process.exitCode = 1;
    }
  },
});
