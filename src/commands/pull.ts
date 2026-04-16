import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { getStatus, pull } from "../core/git";
import { AmError } from "../lib/errors";
import { amError, info, output } from "../lib/output";

export const pullCommand = defineCommand({
  meta: { name: "pull", description: "Pull config changes from the remote git repository" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();

      let status;
      try {
        status = await getStatus(configDir);
      } catch {
        throw new AmError(
          "Config not found",
          "Run `am init` to initialize agent-manager",
          "CONFIG_NOT_FOUND",
        );
      }

      if (status.remotes.length === 0) {
        throw new AmError(
          "No remote configured",
          "Add a remote URL to your config repo",
          "NO_REMOTE",
        );
      }

      await pull(configDir);
      info(`Pulled from ${status.remotes[0].url}`, opts);
      info("Run `am apply` to regenerate native configs", opts);
      if (args.json) {
        output({ action: "pull", remote: status.remotes[0].url, branch: status.branch }, opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
