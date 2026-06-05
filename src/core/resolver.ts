import type { Config, McpToolGroup, Profile, Server } from "./schema";

/**
 * ADR-0055: the resolved runtime access Scope for a profile. `tool_groups`
 * (when defined) narrows the global MCP tool-group ceiling; allow/deny adjust
 * at the individual-tool grain. `undefined` for a field means "inherit the
 * ceiling" (no narrowing); an empty `tool_groups` array means "no groups"
 * (deliberately restrictive). See `resolveScopedToolGroups` /
 * `isToolInScope` for how this composes with `settings.mcp_serve.tools`.
 */
export interface ResolvedScope {
  toolGroups?: McpToolGroup[];
  allowTools: string[];
  denyTools: string[];
}

/** A fully resolved profile with all inheritance applied. */
export interface ResolvedProfile {
  name: string;
  servers: string[];
  skills: string[];
  agents: string[];
  instructions: string[];
  env: Record<string, string>;
  adapters: Record<string, unknown>;
  /** ADR-0055 runtime access Scope. Present only when some profile in the
   * inheritance chain declared a `scope` subtable; otherwise undefined, which
   * the gateway treats as "use the global ceiling unchanged". */
  scope?: ResolvedScope;
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
    const profile: Profile | undefined = profiles[current];
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
  // ADR-0055 Scope accumulation. `scopeDeclared` flips true the moment ANY
  // profile in the chain sets a `scope` subtable, so a profile without scope
  // resolves to `scope: undefined` (= global ceiling unchanged). tool_groups is
  // child-wins (last non-undefined in parent→child order); allow/deny union
  // parent-first (matching the array semantics used for servers/skills/etc).
  let scopeDeclared = false;
  let scopeToolGroups: McpToolGroup[] | undefined;
  const scopeAllow: string[] = [];
  const scopeDeny: string[] = [];

  for (const { profile } of chain) {
    if (profile.scope) {
      scopeDeclared = true;
      if (profile.scope.tool_groups !== undefined) {
        scopeToolGroups = [...profile.scope.tool_groups];
      }
      if (profile.scope.allow_tools) {
        for (const t of profile.scope.allow_tools) {
          if (!scopeAllow.includes(t)) scopeAllow.push(t);
        }
      }
      if (profile.scope.deny_tools) {
        for (const t of profile.scope.deny_tools) {
          if (!scopeDeny.includes(t)) scopeDeny.push(t);
        }
      }
    }
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

  const scope: ResolvedScope | undefined = scopeDeclared
    ? { toolGroups: scopeToolGroups, allowTools: scopeAllow, denyTools: scopeDeny }
    : undefined;

  return { name, servers, skills, agents, instructions, env, adapters, scope };
}

/**
 * ADR-0055 Scope composition. Decide whether a single MCP tool is visible/
 * callable under the active profile's resolved Scope, given the GLOBAL ceiling
 * (the groups from `settings.mcp_serve.tools`) and the tool's own group.
 *
 * Composition (deny wins, ceiling never widened):
 *   1. The tool's group MUST be in the global ceiling — Scope can only NARROW,
 *      never widen beyond what the global settings already expose.
 *   2. deny_tools removes the tool outright (highest precedence).
 *   3. allow_tools re-includes a tool whose GROUP was narrowed out by
 *      scope.tool_groups — but still only if its group is within the ceiling
 *      (rule 1 holds: allow cannot escape the global ceiling).
 *   4. Otherwise the tool's group must be in scope.tool_groups (when defined);
 *      if scope.tool_groups is undefined, the group-level filter is the ceiling.
 *
 * `scope` undefined ⇒ no profile narrowing ⇒ visible iff group ∈ ceiling
 * (identical to today's global-only behaviour).
 */
export function isToolInScope(
  toolName: string,
  toolGroup: McpToolGroup,
  ceiling: readonly McpToolGroup[],
  scope: ResolvedScope | undefined,
): boolean {
  // Rule 1: the global ceiling is absolute — a tool whose group is not exposed
  // globally is never in scope, regardless of profile allow lists.
  if (!ceiling.includes(toolGroup)) return false;
  if (!scope) return true; // no profile narrowing → ceiling decides.
  // Rule 2: explicit deny wins over everything below.
  if (scope.denyTools.includes(toolName)) return false;
  // Rule 3: explicit allow re-includes (still within the ceiling per rule 1).
  if (scope.allowTools.includes(toolName)) return true;
  // Rule 4: group-level narrowing (undefined tool_groups = inherit ceiling).
  if (scope.toolGroups === undefined) return true;
  return scope.toolGroups.includes(toolGroup);
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
