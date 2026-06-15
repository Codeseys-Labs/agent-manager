import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import * as TOML from "@iarna/toml";
import { ZodError } from "zod";
import { AmError, formatZodError, isNotFound } from "../lib/errors";
import { tomlStringify } from "../lib/toml";
import { atomicWriteFile } from "./atomic-write";
import type {
  ResolvedAgent,
  ResolvedConfig,
  ResolvedInstruction,
  ResolvedServer,
  ResolvedSkill,
} from "./resolved";
import { resolveProfile } from "./resolver";
import { type Config, ConfigSchema, type ProjectConfig, ProjectConfigSchema } from "./schema";

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
      require("node:fs").accessSync(candidate);
      return candidate;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null; // reached filesystem root
      dir = parent;
    }
  }
}

/** Re-exported so config callers can distinguish ENOENT from parse/schema errors. */
export { isNotFound } from "../lib/errors";

/**
 * Is `err` a `@iarna/toml` syntax error?
 *
 * The package does not export its error class, so we match on the `name`
 * property it sets (`TomlError`). The error is a plain `Error` (not a
 * `SyntaxError`), and its `message` already embeds the `row`/`col`/`pos` of
 * the offending byte — so callers can surface that verbatim.
 */
function isTomlError(err: unknown): err is Error {
  return err instanceof Error && err.name === "TomlError";
}

/**
 * Parse + validate already-read TOML bytes into a typed config.
 *
 * Centralizes the TOML-parse → schema-validate pipeline AND the error
 * classification both `readConfig`/`readProjectConfig` need: a TOML syntax
 * error becomes `AmError(CONFIG_PARSE_ERROR)` (carrying the parser's
 * row/col message) and a Zod validation error becomes
 * `AmError(CONFIG_SCHEMA_ERROR)` (carrying the first failing field path).
 *
 * ENOENT is NOT handled here — it originates from `readFile`, never from
 * parse/validate — so the `tryReadConfig` ENOENT→null contract is unchanged.
 */
function parseConfigBytes<T>(
  raw: string,
  path: string,
  schema: { parse: (input: unknown) => T },
): T {
  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch (err: unknown) {
    if (isTomlError(err)) {
      throw new AmError(
        `Config at ${path} is not valid TOML`,
        err.message.trim(),
        "CONFIG_PARSE_ERROR",
      );
    }
    throw err;
  }
  try {
    return schema.parse(parsed);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      const issues = formatZodError(err);
      throw new AmError(
        `Config at ${path} failed validation`,
        issues[0] ?? "schema validation failed",
        "CONFIG_SCHEMA_ERROR",
      );
    }
    throw err;
  }
}

/**
 * Read and validate a global config file.
 *
 * Throws on missing file (ENOENT, surfaced raw so `tryReadConfig` can map it
 * to null), on malformed TOML (`AmError` `CONFIG_PARSE_ERROR`), and on schema
 * violations (`AmError` `CONFIG_SCHEMA_ERROR`).
 */
export async function readConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf-8");
  return parseConfigBytes(raw, path, ConfigSchema);
}

/**
 * Read and validate a project config file. Same error contract as
 * `readConfig` — see its doc comment.
 */
export async function readProjectConfig(path: string): Promise<ProjectConfig> {
  const raw = await readFile(path, "utf-8");
  return parseConfigBytes(raw, path, ProjectConfigSchema);
}

/** Like readConfig but returns null on ENOENT. Rethrows other errors. */
export async function tryReadConfig(path: string): Promise<Config | null> {
  try {
    return await readConfig(path);
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Like readProjectConfig but returns null on ENOENT. Rethrows other errors. */
export async function tryReadProjectConfig(path: string): Promise<ProjectConfig | null> {
  try {
    return await readProjectConfig(path);
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Serialize a Config to TOML with ordered sections:
 * settings → servers → skills → instructions → profiles → adapters
 *
 * Extracted from `writeConfig` so callers that need the rendered bytes
 * WITHOUT writing them to disk (e.g. `am init` folding `config.toml` into its
 * single init commit) share the exact same serialization path.
 */
export function serializeConfig(config: Config): string {
  // Build an ordered object so TOML.stringify preserves section order
  const ordered: Record<string, unknown> = {};

  if (config.settings) ordered.settings = config.settings;
  if (config.servers) ordered.servers = config.servers;
  if (config.skills) ordered.skills = config.skills;
  if (config.agents) ordered.agents = config.agents;
  if (config.instructions) ordered.instructions = config.instructions;
  if (config.commands) ordered.commands = config.commands;
  if (config.profiles) ordered.profiles = config.profiles;
  if (config.adapters) ordered.adapters = config.adapters;

  return tomlStringify(ordered);
}

/**
 * Write a Config to TOML with ordered sections:
 * settings → servers → skills → instructions → profiles → adapters
 */
export async function writeConfig(path: string, config: Config): Promise<void> {
  await atomicWriteFile(path, serializeConfig(config));
}

/**
 * Write a ProjectConfig to TOML with ordered sections:
 * profile → project → servers → instructions → adapters
 */
export async function writeProjectConfig(path: string, config: ProjectConfig): Promise<void> {
  const ordered: Record<string, unknown> = {};

  if (config.profile) ordered.profile = config.profile;
  if (config.project) ordered.project = config.project;
  if (config.servers) ordered.servers = config.servers;
  if (config.skills) ordered.skills = config.skills;
  if (config.agents) ordered.agents = config.agents;
  if (config.instructions) ordered.instructions = config.instructions;
  if (config.commands) ordered.commands = config.commands;
  if (config.env) ordered.env = config.env;
  if (config.adapters) ordered.adapters = config.adapters;

  const toml = tomlStringify(ordered);
  await atomicWriteFile(path, toml);
}

/**
 * Field-level merge of a higher-precedence keyed map (`b`) over a lower one
 * (`a`). For a key present in BOTH maps the two ENTRIES are deep-merged at the
 * field grain (`{ ...a[key], ...b[key] }`) so a higher layer that restates only
 * ONE field of a same-named entry does NOT drop the sibling fields the lower
 * layer set (M12 data-loss). Keys present in only one map pass through; a field
 * `b` sets still wins on conflict.
 *
 * Returns `undefined` when both inputs are absent so the caller can keep the
 * "omit-when-empty" Config shape that serializeConfig / TOML writeback expect.
 *
 * Entry merge is one level deep BY DESIGN: it heals the
 * whole-entry-replacement bug without redefining nested-field semantics (e.g.
 * an entry's own `env` / `adapters` map) that no layer-merge caller relies on.
 */
function mergeKeyedMap<V>(
  a: Record<string, V> | undefined,
  b: Record<string, V> | undefined,
): Record<string, V> | undefined {
  if (!a && !b) return undefined;
  const result: Record<string, V> = { ...a };
  for (const [key, bVal] of Object.entries(b ?? {})) {
    const aVal = result[key];
    result[key] =
      aVal && typeof aVal === "object" && typeof bVal === "object"
        ? ({ ...aVal, ...bVal } as V)
        : bVal;
  }
  return result;
}

/**
 * Servers carry a `transport` discriminant (ADR-0057): a stdio server forbids
 * `url` (StdioServerSchema's `url: z.undefined()`), while a remote one allows
 * it. The field-grain deep-merge in `mergeKeyedMap` is discriminant-BLIND, so a
 * lower remote layer (`{ transport: "sse", url }`) restated as stdio by a higher
 * layer (`{ command, transport: "stdio" }`) leaves a stale `url` on the merged
 * stdio entry — schema-invalid, and `loadResolvedConfig` does NOT re-validate,
 * so a stdio adapter export could leak the dead remote endpoint downstream.
 *
 * This post-merge step mirrors `merge.ts/mergeServers`, which drops `url` once
 * the result resolves to stdio. We apply it ONLY to the servers map: the other
 * keyed maps (skills/agents/instructions/commands/profiles) have no transport
 * discriminant and need no field reconciliation.
 *
 * `transport` is treated as defaulting to "stdio" when absent, matching
 * `ServerSchema`'s preprocess step — an entry that drops transport AND restates
 * no url is already valid, but one that inherits a remote url from the lower
 * layer while resolving to stdio must shed it.
 */
function reconcileServerDiscriminant<V>(
  servers: Record<string, V> | undefined,
): Record<string, V> | undefined {
  if (!servers) return servers;
  const result: Record<string, V> = {};
  for (const [name, srv] of Object.entries(servers)) {
    if (srv && typeof srv === "object") {
      const entry = srv as Record<string, unknown>;
      const transport = entry.transport ?? "stdio";
      if (transport === "stdio" && "url" in entry) {
        const { url: _url, ...rest } = entry;
        result[name] = rest as V;
        continue;
      }
    }
    result[name] = srv;
  }
  return result;
}

/**
 * Merge two configs. `b` has higher precedence than `a`.
 *
 * - Servers/Skills/Instructions/Agents/Commands/Profiles: union of keys;
 *   a same-named entry present in both layers is DEEP-merged at the field grain
 *   (b's fields win, a's untouched fields survive) — see `mergeKeyedMap`.
 * - Servers additionally pass through `reconcileServerDiscriminant`, which sheds
 *   a stale `url` inherited from a remote lower layer when the merged entry
 *   resolves to stdio — without it the merged server is StdioServerSchema-invalid
 *   (seed 1fcc).
 * - Settings: shallow merge, b's keys override a's
 * - Adapters: shallow merge by adapter name
 */
export function mergeConfigs(a: Config, b: Config): Config {
  return {
    settings: a.settings || b.settings ? { ...a.settings, ...b.settings } : undefined,
    servers: reconcileServerDiscriminant(mergeKeyedMap(a.servers, b.servers)),
    skills: mergeKeyedMap(a.skills, b.skills),
    instructions: mergeKeyedMap(a.instructions, b.instructions),
    agents: mergeKeyedMap(a.agents, b.agents),
    commands: mergeKeyedMap(a.commands, b.commands),
    profiles: mergeKeyedMap(a.profiles, b.profiles),
    adapters: a.adapters || b.adapters ? { ...a.adapters, ...b.adapters } : undefined,
  };
}

/** Convert a ProjectConfig into a Config shape for merging. */
export function projectToConfig(proj: ProjectConfig): Config {
  const config: Config = {
    servers: proj.servers,
    skills: proj.skills,
    instructions: proj.instructions,
    agents: proj.agents,
    commands: proj.commands,
    adapters: proj.adapters,
  };

  if (proj.env) {
    if (!config.settings) config.settings = {};
    config.settings.env = { ...config.settings.env, ...proj.env };
  }

  return config;
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

/**
 * Build a ResolvedConfig from a merged Config and profile name.
 *
 * Converts the raw Config servers, instructions, skills, and agents
 * into fully resolved types suitable for adapter export/diff.
 */
export function buildResolvedConfig(
  config: Config,
  profileName: string,
  configDir?: string,
): ResolvedConfig {
  const servers: Record<string, ResolvedServer> = {};
  for (const [name, srv] of Object.entries(config.servers ?? {})) {
    servers[name] = {
      name,
      command: srv.command,
      url: srv.url,
      args: srv.args ?? [],
      env: srv.env ?? {},
      transport: srv.transport ?? "stdio",
      description: srv.description ?? "",
      tags: srv.tags ?? [],
      enabled: srv.enabled ?? true,
      adapters: (srv.adapters as Record<string, Record<string, unknown>>) ?? {},
    };
  }
  // Map instructions
  const instructions: Record<string, ResolvedInstruction> = {};
  for (const [name, instr] of Object.entries(config.instructions ?? {})) {
    let content = instr.content ?? "";
    if (!content && instr.content_file && configDir) {
      try {
        content = readFileSync(join(configDir, instr.content_file), "utf-8");
      } catch {
        // If file cannot be read, leave content empty
      }
    }
    instructions[name] = {
      name,
      content,
      scope: instr.scope ?? "always",
      description: instr.description ?? "",
      globs: instr.globs ?? [],
      targets: instr.targets ?? [],
      adapters: (instr.adapters as Record<string, Record<string, unknown>>) ?? {},
    };
  }

  // Map skills
  const skills: Record<string, ResolvedSkill> = {};
  for (const [name, skill] of Object.entries(config.skills ?? {})) {
    skills[name] = {
      name,
      path: skill.path ?? "",
      description: skill.description ?? "",
      tags: skill.tags ?? [],
      adapters: (skill.adapters as Record<string, Record<string, unknown>>) ?? {},
    };
  }

  // Map agents
  const agents: Record<string, ResolvedAgent> = {};
  for (const [name, agent] of Object.entries(config.agents ?? {})) {
    agents[name] = {
      name,
      description: agent.description ?? "",
      subagent_type: agent.subagent_type ?? "",
      prompt: agent.prompt ?? "",
      prompt_file: agent.prompt_file ?? "",
      model: agent.model ?? "",
      tools: agent.tools ?? [],
      disallowed_tools: agent.disallowed_tools ?? [],
      mcp_servers: agent.mcp_servers ?? [],
      max_turns: agent.max_turns,
      adapters: (agent.adapters as Record<string, Record<string, unknown>>) ?? {},
    };
  }

  const result: ResolvedConfig = {
    servers,
    instructions,
    skills,
    agents,
    profile: profileName,
    adapters: (config.adapters as Record<string, Record<string, unknown>>) ?? {},
    settings: config.settings as Record<string, unknown> | undefined,
  };

  // Apply profile filtering when the named profile exists
  const profile = config.profiles?.[profileName];
  if (profile) {
    const resolved = resolveProfile(profileName, config);

    // Filter servers to only those in the resolved profile
    if (resolved.servers.length > 0) {
      const filteredServers: typeof result.servers = {};
      for (const name of Object.keys(result.servers)) {
        if (resolved.servers.includes(name)) {
          filteredServers[name] = result.servers[name];
        }
      }
      result.servers = filteredServers;
    }

    // Filter instructions if profile specifies them
    if (resolved.instructions.length > 0) {
      const filteredInstructions: typeof result.instructions = {};
      for (const name of Object.keys(result.instructions)) {
        if (resolved.instructions.includes(name)) {
          filteredInstructions[name] = result.instructions[name];
        }
      }
      result.instructions = filteredInstructions;
    }

    // Filter skills if profile specifies them
    if (resolved.skills.length > 0) {
      const filteredSkills: typeof result.skills = {};
      for (const name of Object.keys(result.skills)) {
        if (resolved.skills.includes(name)) {
          filteredSkills[name] = result.skills[name];
        }
      }
      result.skills = filteredSkills;
    }

    // Filter agents if profile specifies them
    if (resolved.agents.length > 0) {
      const filteredAgents: typeof result.agents = {};
      for (const name of Object.keys(result.agents)) {
        if (resolved.agents.includes(name)) {
          filteredAgents[name] = result.agents[name];
        }
      }
      result.agents = filteredAgents;
    }
  }

  return result;
}
