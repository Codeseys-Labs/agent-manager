import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, parse as parsePath } from "node:path";
import { homedir } from "node:os";
import * as TOML from "@iarna/toml";
import {
  ConfigSchema,
  ProjectConfigSchema,
  type Config,
  type ProjectConfig,
} from "./schema";

/** Return the agent-manager config directory. */
export function resolveConfigDir(): string {
  return process.env.AM_CONFIG_DIR ?? join(homedir(), ".config", "agent-manager");
}

/**
 * Walk up from `startDir` looking for `.agent-manager.toml`.
 * Returns the path if found, null otherwise.
 */
export function resolveProjectConfig(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".agent-manager.toml");
    try {
      // Synchronous existence check via Bun.file
      const f = Bun.file(candidate);
      // Bun.file doesn't throw on missing — check size synchronously won't work.
      // Use a simple approach: try require("fs").accessSync
      require("node:fs").accessSync(candidate);
      return candidate;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null; // reached filesystem root
      dir = parent;
    }
  }
}

/** Read and validate a global config file. Throws on missing file or validation error. */
export async function readConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf-8");
  const parsed = TOML.parse(raw);
  return ConfigSchema.parse(parsed);
}

/** Read and validate a project config file. Throws on missing file or validation error. */
export async function readProjectConfig(path: string): Promise<ProjectConfig> {
  const raw = await readFile(path, "utf-8");
  const parsed = TOML.parse(raw);
  return ProjectConfigSchema.parse(parsed);
}

/** Like readConfig but returns null on ENOENT. Rethrows other errors. */
export async function tryReadConfig(path: string): Promise<Config | null> {
  try {
    return await readConfig(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** Like readProjectConfig but returns null on ENOENT. Rethrows other errors. */
export async function tryReadProjectConfig(path: string): Promise<ProjectConfig | null> {
  try {
    return await readProjectConfig(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write a Config to TOML with ordered sections:
 * settings → servers → skills → instructions → profiles → adapters
 */
export async function writeConfig(path: string, config: Config): Promise<void> {
  // Build an ordered object so TOML.stringify preserves section order
  const ordered: Record<string, unknown> = {};

  if (config.settings) ordered.settings = config.settings;
  if (config.servers) ordered.servers = config.servers;
  if (config.skills) ordered.skills = config.skills;
  if (config.instructions) ordered.instructions = config.instructions;
  if (config.profiles) ordered.profiles = config.profiles;
  if (config.adapters) ordered.adapters = config.adapters;

  const toml = TOML.stringify(ordered as any);
  await writeFile(path, toml, "utf-8");
}

/**
 * Merge two configs. `b` has higher precedence than `a`.
 *
 * - Servers/Skills/Instructions: union (spread), same-name key in b wins
 * - Settings: shallow merge, b's keys override a's
 * - Adapters: shallow merge by adapter name
 */
export function mergeConfigs(a: Config, b: Config): Config {
  return {
    settings: a.settings || b.settings
      ? { ...a.settings, ...b.settings }
      : undefined,
    servers: a.servers || b.servers
      ? { ...a.servers, ...b.servers }
      : undefined,
    skills: a.skills || b.skills
      ? { ...a.skills, ...b.skills }
      : undefined,
    instructions: a.instructions || b.instructions
      ? { ...a.instructions, ...b.instructions }
      : undefined,
    profiles: a.profiles || b.profiles
      ? { ...a.profiles, ...b.profiles }
      : undefined,
    adapters: a.adapters || b.adapters
      ? { ...a.adapters, ...b.adapters }
      : undefined,
  };
}

/** Convert a ProjectConfig into a Config shape for merging. */
export function projectToConfig(proj: ProjectConfig): Config {
  return {
    servers: proj.servers,
    skills: proj.skills,
    instructions: proj.instructions,
    adapters: proj.adapters,
  };
}

export interface LoadResolvedConfigOpts {
  /** Directory containing config.toml and config.local.toml */
  configDir?: string;
  /** Name of the main config file (default: "config.toml") */
  configFile?: string;
  /** Absolute path to .agent-manager.toml (or null to skip) */
  projectFile?: string | null;
}

/**
 * Load the fully resolved config:
 * config.toml → merge config.local.toml → merge .agent-manager.toml → merge .agent-manager.local.toml
 */
export async function loadResolvedConfig(opts: LoadResolvedConfigOpts = {}): Promise<Config> {
  const configDir = opts.configDir ?? resolveConfigDir();
  const configFile = opts.configFile ?? "config.toml";

  // 1. Read global config
  let resolved = (await tryReadConfig(join(configDir, configFile))) ?? {};

  // 2. Merge global local overrides
  const localName = configFile.replace(/\.toml$/, ".local.toml");
  const localConfig = await tryReadConfig(join(configDir, localName));
  if (localConfig) {
    resolved = mergeConfigs(resolved, localConfig);
  }

  // 3. Merge project config
  if (opts.projectFile) {
    const projConfig = await tryReadProjectConfig(opts.projectFile);
    if (projConfig) {
      resolved = mergeConfigs(resolved, projectToConfig(projConfig));

      // 4. Merge project local overrides
      const projLocalPath = opts.projectFile.replace(/\.toml$/, ".local.toml");
      const projLocal = await tryReadProjectConfig(projLocalPath);
      if (projLocal) {
        resolved = mergeConfigs(resolved, projectToConfig(projLocal));
      }
    }
  }

  return resolved;
}
