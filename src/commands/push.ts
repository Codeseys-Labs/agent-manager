import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { getStatus, push } from "../core/git";
import { error, info, output } from "../lib/output";

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

    let status;
    try {
      status = await getStatus(configDir);
    } catch {
      error("Config not found. Run `am init` first.", opts);
      process.exitCode = 1;
      return;
    }

    if (status.remotes.length === 0) {
      if (args.json) {
        console.error(
          JSON.stringify({
            error: "No remote configured",
            suggestion: "Add a remote URL to your config repo",
          }),
        );
      } else {
        console.error("error: No remote configured");
        console.error("  suggestion: Add a remote URL to your config repo");
      }
      process.exitCode = 1;
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
      process.exitCode = 1;
    }
  },
});
