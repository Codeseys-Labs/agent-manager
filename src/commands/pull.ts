import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { pull, getStatus } from "../core/git";
import { output, info, error } from "../lib/output";

export const pullCommand = defineCommand({
  meta: { name: "pull", description: "Pull config changes from remote and auto-apply" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const configDir = resolveConfigDir();

    const status = await getStatus(configDir);
    if (status.remotes.length === 0) {
      error("No remote configured. Run `am remote add <url>` first.", opts);
      return;
    }

    try {
      await pull(configDir);
      info(`Pulled from ${status.remotes[0].url}`, opts);
      info(`Run \`am apply\` to regenerate native configs`, opts);
      if (args.json) {
        output({ action: "pull", remote: status.remotes[0].url, branch: status.branch }, opts);
      }
    } catch (e: any) {
      error(`Pull failed: ${e?.message ?? "unknown error"}`, opts);
    }
  },
});
