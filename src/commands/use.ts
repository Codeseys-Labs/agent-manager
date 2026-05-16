import { join } from "node:path";
import { defineCommand } from "citty";
import { resolveConfigDir, tryReadConfig } from "../core/config";
import { writeActiveProfile } from "../core/state";
import { AmError, requireConfig } from "../lib/errors";
import { amError, info, output } from "../lib/output";

export {
  STATE_FILE,
  type StateConfig,
  readActiveProfile,
  writeActiveProfile,
} from "../core/state";

export const useCommand = defineCommand({
  meta: { name: "use", description: "Switch active profile" },
  args: {
    profile: { type: "positional", description: "Profile name to activate", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const configDir = resolveConfigDir();
      const configPath = join(configDir, "config.toml");
      const profile = args.profile;

      // Validate config exists
      const config = await tryReadConfig(configPath);
      requireConfig(config);

      // Validate profile exists
      const profiles = config.profiles ?? {};
      const available = Object.keys(profiles);
      if (available.length > 0 && !profiles[profile]) {
        throw new AmError(
          `Profile "${profile}" not found`,
          `Available profiles: ${available.join(", ")}`,
          "PROFILE_NOT_FOUND",
        );
      }

      await writeActiveProfile(configDir, profile);

      info(`Active profile set to "${profile}"`, opts);
      info("Run `am apply` to generate configs for this profile", opts);

      if (args.json) {
        output({ action: "use", profile }, opts);
      }
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});
