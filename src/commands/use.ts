import { defineCommand } from "citty";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import * as TOML from "@iarna/toml";
import { resolveConfigDir } from "../core/config";
import { output, info, error } from "../lib/output";

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
    const profile = args.profile;

    await writeActiveProfile(configDir, profile);

    info(`Active profile set to "${profile}"`, opts);
    info(`Run \`am apply\` to generate configs for this profile`, opts);

    if (args.json) {
      output({ action: "use", profile }, opts);
    }
  },
});
