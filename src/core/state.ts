import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { tomlStringify } from "../lib/toml";
import { atomicWriteFile } from "./atomic-write";

export const STATE_FILE = ".agent-manager/state.toml";

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

export async function writeActiveProfile(configDir: string, profile: string): Promise<void> {
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
  const toml = tomlStringify(state as Record<string, unknown>);
  await atomicWriteFile(join(configDir, STATE_FILE), toml);
}
