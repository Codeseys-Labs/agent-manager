import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { getStatus, pull } from "../core/git";
import { error, info, output } from "../lib/output";

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
      await pull(configDir);
      info(`Pulled from ${status.remotes[0].url}`, opts);
      info("Run `am apply` to regenerate native configs", opts);
      if (args.json) {
        output({ action: "pull", remote: status.remotes[0].url, branch: status.branch }, opts);
      }
    } catch (e: any) {
      error(`Pull failed: ${e?.message ?? "unknown error"}`, opts);
      process.exitCode = 1;
    }
  },
});
