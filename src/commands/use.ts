import { defineCommand } from "citty";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import * as TOML from "@iarna/toml";
import { resolveConfigDir, readConfig } from "../core/config";
import { output, info, error } from "../lib/output";
import { AmError } from "../lib/errors";

const STATE_FILE = ".agent-manager/state.toml";

export interface StateConfig {
  active_profile?: string;
  last_apply?: string;
}

export async function readActiveProfile(configDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(configDir, STATE_FILE), "utf-8");
    const parsed = TOML.parse(raw) as StateConfig;
    return parsed.active_profile ?? null;
  } catch {
    return null;
  }
}

export async function writeActiveProfile(
  configDir: string,
  profile: string,
): Promise<void> {
  const stateDir = join(configDir, ".agent-manager");
  await mkdir(stateDir, { recursive: true });

  let state: StateConfig = {};
  try {
    const raw = await readFile(join(configDir, STATE_FILE), "utf-8");
    state = TOML.parse(raw) as StateConfig;
  } catch {
    // No existing state — start fresh
  }

  state.active_profile = profile;
  const toml = TOML.stringify(state as any);
  await writeFile(join(configDir, STATE_FILE), toml, "utf-8");
}

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
    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");
    const profile = args.profile;

    // Validate config exists
    let config;
    try {
      config = await readConfig(configPath);
    } catch {
      error("Config not found. Run `am init` first.", opts);
      process.exitCode = 1;
      return;
    }

    // Validate profile exists
    const profiles = config.profiles ?? {};
    const available = Object.keys(profiles);
    if (available.length > 0 && !profiles[profile]) {
      const suggestion = `Available profiles: ${available.join(", ")}`;
      if (args.json) {
        console.error(JSON.stringify({ error: `Profile "${profile}" not found`, suggestion }));
      } else {
        console.error(`error: Profile "${profile}" not found`);
        console.error(`  available: ${available.join(", ")}`);
      }
      process.exitCode = 1;
      return;
    }

    await writeActiveProfile(configDir, profile);

    info(`Active profile set to "${profile}"`, opts);
    info(`Run \`am apply\` to generate configs for this profile`, opts);

    if (args.json) {
      output({ action: "use", profile }, opts);
    }
  },
});
