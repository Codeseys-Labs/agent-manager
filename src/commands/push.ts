import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { push, getStatus } from "../core/git";
import { output, info, error } from "../lib/output";

export const pushCommand = defineCommand({
  meta: { name: "push", description: "Push config changes to remote" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();

    // Check for remote
    const status = await getStatus(configDir);
    if (status.remotes.length === 0) {
      error("No remote configured. Run `am remote add <url>` first.", opts);
      return;
    }

    try {
      await push(configDir);
      info(`Pushed to ${status.remotes[0].url}`, opts);
      if (args.json) {
        output({ action: "push", remote: status.remotes[0].url, branch: status.branch }, opts);
      }
    } catch (e: any) {
      error(`Push failed: ${e?.message ?? "unknown error"}`, opts);
    }
  },
});
