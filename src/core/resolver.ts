import type { Config, Profile, Server } from "./schema";

/** A fully resolved profile with all inheritance applied. */
export interface ResolvedProfile {
  name: string;
  servers: string[];
  skills: string[];
  agents: string[];
  instructions: string[];
  env: Record<string, string>;
  adapters: Record<string, unknown>;
}

/** A server entry resolved from the catalog. */
export interface ActiveServer {
  name: string;
  server: Server;
}

/**
 * Walk the inheritance chain for a profile and produce a flattened result.
 *
 * - Arrays (servers, skills, instructions, server_tags): union, parent first
 * - Tables (env, adapters): shallow merge, child wins
 * - Circular inheritance throws
 * - Unknown profile name throws
 */
export function resolveProfile(name: string, config: Config): ResolvedProfile {
  const profiles = config.profiles ?? {};

  // Build the inheritance chain (child → parent → grandparent …)
  const chain: { name: string; profile: Profile }[] = [];
  const seen = new Set<string>();
  let current: string | undefined = name;

  while (current) {
    if (seen.has(current)) {
      throw new Error(`Circular inheritance detected: ${[...seen, current].join(" -> ")}`);
    }
    const profile = profiles[current];
    if (!profile) {
      throw new Error(`Unknown profile: "${current}"`);
    }
    seen.add(current);
    chain.push({ name: current, profile });
    current = profile.inherits;
  }

  // Reverse so we apply parent-first, child-last (child wins for tables)
  chain.reverse();

  const servers: string[] = [];
  const skills: string[] = [];
  const agents: string[] = [];
  const instructions: string[] = [];
  const serverTags: string[] = [];
  let env: Record<string, string> = {};
  let adapters: Record<string, unknown> = {};

  for (const { profile } of chain) {
    if (profile.servers) {
      for (const s of profile.servers) {
        if (!servers.includes(s)) servers.push(s);
      }
    }
    if (profile.skills) {
      for (const s of profile.skills) {
        if (!skills.includes(s)) skills.push(s);
      }
    }
    if (profile.agents) {
      for (const a of profile.agents) {
        if (!agents.includes(a)) agents.push(a);
      }
    }
    if (profile.instructions) {
      for (const i of profile.instructions) {
        if (!instructions.includes(i)) instructions.push(i);
      }
    }
    if (profile.server_tags) {
      for (const t of profile.server_tags) {
        if (!serverTags.includes(t)) serverTags.push(t);
      }
    }
    if (profile.env) {
      env = { ...env, ...profile.env };
    }
    if (profile.adapters) {
      adapters = { ...adapters, ...profile.adapters };
    }
  }

  // Resolve server_tags into additional server names
  const tagServers = resolveServerTags(serverTags, config);
  for (const s of tagServers) {
    if (!servers.includes(s)) servers.push(s);
  }

  return { name, servers, skills, agents, instructions, env, adapters };
}

/**
 * Find server names whose tags overlap with the requested tags.
 * Skips servers with `enabled = false`.
 */
export function resolveServerTags(tags: string[], config: Config): string[] {
  if (tags.length === 0) return [];

  const catalog = config.servers ?? {};
  const tagSet = new Set(tags);
  const result: string[] = [];

  for (const [name, server] of Object.entries(catalog)) {
    if (!server.enabled) continue;
    if (!server.tags) continue;
    if (server.tags.some((t) => tagSet.has(t))) {
      result.push(name);
    }
  }

  return result;
}

/**
 * Return full Server objects for each server name in the resolved profile.
 * Silently skips names not found in the catalog.
 */
export function resolveActiveServers(resolved: ResolvedProfile, config: Config): ActiveServer[] {
  const catalog = config.servers ?? {};
  const result: ActiveServer[] = [];

  for (const name of resolved.servers) {
    const server = catalog[name];
    if (server) {
      result.push({ name, server });
    }
  }

  return result;
}
