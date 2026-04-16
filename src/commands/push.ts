import { defineCommand } from "citty";
import { resolveConfigDir } from "../core/config";
import { getStatus, push } from "../core/git";
import { loadKey } from "../core/secrets";
import { AmError } from "../lib/errors";
import { amError, info, output } from "../lib/output";
import { detectPlatform } from "../platforms/registry";

export const pushCommand = defineCommand({
  meta: { name: "push", description: "Push config changes to remote" },
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

      await push(configDir);
      info(`Pushed to ${status.remotes[0].url}`, opts);

      // Offer to store encryption key in platform secrets (first push only)
      const remoteUrl = status.remotes[0].url;
      const platform = detectPlatform(remoteUrl);
      if (platform.storeKey) {
        const key = await loadKey(configDir);
        if (key) {
          try {
            const raw = await crypto.subtle.exportKey("raw", key);
            const b64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
            await platform.storeKey(remoteUrl, b64);
            info(`Encryption key stored in ${platform.meta.displayName} secrets`, opts);
          } catch {
            // Non-fatal — platform CLI may not be installed or authenticated
          }
        }
      }

      if (args.json) {
        output({ action: "push", remote: remoteUrl, branch: status.branch }, opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
