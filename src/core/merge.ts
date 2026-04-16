/**
 * Brownfield import merge engine (ADR-0028).
 *
 * Two-tier identity matching, conflict classification, and field-level
 * merge strategies for importing servers into a pre-populated config.
 */

import type { ImportedServer } from "../adapters/types";
import type { Server } from "./schema";
import { extractServerIdentity } from "../commands/import";

// ── Types ────────────────────────────────────────────────────────────

export type MatchType = "exact" | "fuzzy";
export type FuzzyReason = "command-basename" | "name-match";
export type ConflictClass = "identical" | "compatible" | "conflicting";
export type MergeStrategy = "auto" | "interactive" | "force";

export interface IdentityMatch {
  type: MatchType;
  existingName: string;
  existingServer: Server;
  incomingServer: ImportedServer;
  incomingSource: string;
  identity: string;
  fuzzyReason?: FuzzyReason;
}

export interface FieldDiff {
  field: string;
  existing: unknown;
  incoming: unknown;
  recommendation: "keep-existing" | "keep-incoming" | "merge";
}

export interface ServerConflict {
  match: IdentityMatch;
  classification: ConflictClass;
  diffs: FieldDiff[];
}

export interface MergeResult {
  added: ImportedServer[];
  skipped: IdentityMatch[];
  merged: Array<{ name: string; server: Server; conflict: ServerConflict }>;
  conflicts: ServerConflict[];
}

// ── Identity Matching ────────────────────────────────────────────────

/**
 * Extract the basename from a command string, stripping runner prefixes.
 * "npx" + ["-y", "tavily-mcp@latest"] -> "tavily-mcp"
 * "/usr/local/bin/aws-mcp" -> "aws-mcp"
 */
function commandBasename(command: string, args?: string[]): string {
  const runners = new Set(["npx", "bunx", "uvx", "pipx", "run", "-y"]);
  const parts = [command, ...(args ?? [])];
  let idx = 0;
  while (idx < parts.length && runners.has(parts[idx])) idx++;
  const pkg = parts[idx] ?? command;
  // Strip @version suffix
  const atIdx = pkg.lastIndexOf("@");
  const bare = atIdx > 0 ? pkg.substring(0, atIdx) : pkg;
  // Strip path prefix
  const slashIdx = bare.lastIndexOf("/");
  return slashIdx >= 0 ? bare.substring(slashIdx + 1) : bare;
}

/**
 * Two-tier identity matching (ADR-0028):
 * Tier 1 — exact: canonical package identity from extractServerIdentity
 * Tier 2 — fuzzy: command basename or name match
 */
export function identifyDuplicates(
  existing: Record<string, Server>,
  incoming: ImportedServer[],
  incomingSource = "unknown",
): { matches: IdentityMatch[]; newServers: ImportedServer[] } {
  // Build lookup maps for existing servers
  const exactMap = new Map<string, { name: string; server: Server }>();
  const basenameMap = new Map<string, { name: string; server: Server }>();
  const nameMap = new Map<string, { name: string; server: Server }>();

  for (const [name, srv] of Object.entries(existing)) {
    const identity = extractServerIdentity(srv.command, srv.args);
    exactMap.set(identity, { name, server: srv });
    basenameMap.set(commandBasename(srv.command, srv.args), { name, server: srv });
    nameMap.set(name.toLowerCase(), { name, server: srv });
  }

  const matches: IdentityMatch[] = [];
  const newServers: ImportedServer[] = [];
  const matchedIncoming = new Set<string>();

  for (const srv of incoming) {
    const identity = extractServerIdentity(srv.command, srv.args);

    // Tier 1 — exact identity match
    const exactHit = exactMap.get(identity);
    if (exactHit) {
      matches.push({
        type: "exact",
        existingName: exactHit.name,
        existingServer: exactHit.server,
        incomingServer: srv,
        incomingSource,
        identity,
      });
      matchedIncoming.add(srv.name);
      continue;
    }

    // Tier 2a — command basename match
    const basename = commandBasename(srv.command, srv.args);
    const basenameHit = basenameMap.get(basename);
    if (basenameHit) {
      matches.push({
        type: "fuzzy",
        existingName: basenameHit.name,
        existingServer: basenameHit.server,
        incomingServer: srv,
        incomingSource,
        identity,
        fuzzyReason: "command-basename",
      });
      matchedIncoming.add(srv.name);
      continue;
    }

    // Tier 2b — name match
    const nameHit = nameMap.get(srv.name.toLowerCase());
    if (nameHit) {
      matches.push({
        type: "fuzzy",
        existingName: nameHit.name,
        existingServer: nameHit.server,
        incomingServer: srv,
        incomingSource,
        identity,
        fuzzyReason: "name-match",
      });
      matchedIncoming.add(srv.name);
      continue;
    }

    newServers.push(srv);
  }

  return { matches, newServers };
}

// ── Conflict Classification ──────────────────────────────────────────

function arraysEqual(a?: unknown[], b?: unknown[]): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  return aa.every((v, i) => v === bb[i]);
}

function recordsEqual(
  a?: Record<string, string>,
  b?: Record<string, string>,
): boolean {
  const aa = a ?? {};
  const bb = b ?? {};
  const keysA = Object.keys(aa).sort();
  const keysB = Object.keys(bb).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k, i) => k === keysB[i] && aa[k] === bb[k]);
}

function computeFieldDiffs(existing: Server, incoming: ImportedServer): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  // Command
  if (existing.command !== incoming.command) {
    diffs.push({
      field: "command",
      existing: existing.command,
      incoming: incoming.command,
      recommendation: "keep-existing",
    });
  }

  // Args
  if (!arraysEqual(existing.args, incoming.args)) {
    diffs.push({
      field: "args",
      existing: existing.args,
      incoming: incoming.args,
      recommendation: "merge",
    });
  }

  // Env vars — per-key diffs
  const existingEnv = existing.env ?? {};
  const incomingEnv = incoming.env ?? {};
  const allEnvKeys = new Set([...Object.keys(existingEnv), ...Object.keys(incomingEnv)]);
  for (const key of allEnvKeys) {
    const eVal = existingEnv[key];
    const iVal = incomingEnv[key];
    if (eVal !== iVal) {
      // Preserve encrypted refs
      const isEncrypted = eVal && eVal.startsWith("${") && eVal.endsWith("}");
      diffs.push({
        field: `env.${key}`,
        existing: eVal,
        incoming: iVal,
        recommendation: isEncrypted ? "keep-existing" : (iVal ? "keep-incoming" : "keep-existing"),
      });
    }
  }

  // Tags
  if (!arraysEqual(existing.tags?.slice().sort(), incoming.tags?.slice().sort())) {
    diffs.push({
      field: "tags",
      existing: existing.tags,
      incoming: incoming.tags,
      recommendation: "merge",
    });
  }

  // Description
  if ((existing.description ?? "") !== (incoming.description ?? "")) {
    diffs.push({
      field: "description",
      existing: existing.description,
      incoming: incoming.description,
      recommendation: "merge",
    });
  }

  // Enabled
  const incomingEnabled = incoming.enabled ?? true;
  if (existing.enabled !== incomingEnabled) {
    diffs.push({
      field: "enabled",
      existing: existing.enabled,
      incoming: incomingEnabled,
      recommendation: "keep-existing",
    });
  }

  return diffs;
}

/**
 * Classify identity matches into: identical (skip), compatible (auto-merge),
 * or conflicting (needs resolution).
 *
 * - identical: no field diffs at all
 * - compatible: exact match with only mergeable diffs (env additions, tag unions)
 * - conflicting: fuzzy match, or exact match with command/args divergence
 */
export function classifyConflicts(matches: IdentityMatch[]): ServerConflict[] {
  return matches.map((match) => {
    const diffs = computeFieldDiffs(match.existingServer, match.incomingServer);

    let classification: ConflictClass;
    if (match.type === "fuzzy") {
      // Fuzzy matches are always classified as conflicting (ADR-0028)
      classification = "conflicting";
    } else if (diffs.length === 0) {
      classification = "identical";
    } else {
      // Exact match with diffs — check if all diffs are auto-mergeable
      const hasHardConflict = diffs.some(
        (d) => d.field === "command" || d.field === "enabled",
      );
      classification = hasHardConflict ? "conflicting" : "compatible";
    }

    return { match, classification, diffs };
  });
}

// ── Merge Logic ──────────────────────────────────────────────────────

function unionArgs(existing?: string[], incoming?: string[]): string[] | undefined {
  const e = existing ?? [];
  const i = incoming ?? [];
  if (e.length === 0 && i.length === 0) return undefined;
  const seen = new Set(e);
  const result = [...e];
  for (const arg of i) {
    if (!seen.has(arg)) {
      result.push(arg);
      seen.add(arg);
    }
  }
  return result;
}

function mergeEnv(
  existing?: Record<string, string>,
  incoming?: Record<string, string>,
): Record<string, string> | undefined {
  const e = existing ?? {};
  const i = incoming ?? {};
  if (Object.keys(e).length === 0 && Object.keys(i).length === 0) return undefined;

  const result: Record<string, string> = { ...e };
  for (const [key, val] of Object.entries(i)) {
    const existingVal = result[key];
    // Preserve encrypted refs — never overwrite ${VAR} with a raw value
    if (existingVal && existingVal.startsWith("${") && existingVal.endsWith("}")) {
      continue;
    }
    // Incoming wins on conflict, or adds new keys
    result[key] = val;
  }
  return result;
}

function unionTags(existing?: string[], incoming?: string[]): string[] | undefined {
  const e = existing ?? [];
  const i = incoming ?? [];
  if (e.length === 0 && i.length === 0) return undefined;
  return [...new Set([...e, ...i])];
}

function pickLonger(existing?: string, incoming?: string): string | undefined {
  if (!existing && !incoming) return undefined;
  if (!existing) return incoming;
  if (!incoming) return existing;
  return incoming.length > existing.length ? incoming : existing;
}

/**
 * Merge two server configs using the ADR-0028 field strategies:
 * - command: keep existing
 * - args: union unique
 * - env: merge (incoming wins, preserve encrypted refs)
 * - tags: union
 * - description: keep longer
 * - enabled: keep existing
 * - _registry: preserve existing provenance
 */
export function mergeServers(
  existing: Server,
  incoming: ImportedServer,
  strategy: MergeStrategy = "auto",
): Server {
  if (strategy === "force") {
    return {
      command: incoming.command,
      args: incoming.args,
      env: incoming.env,
      transport: incoming.transport ?? "stdio",
      description: incoming.description,
      tags: incoming.tags,
      enabled: incoming.enabled ?? true,
      _registry: existing._registry,
    };
  }

  return {
    command: existing.command,
    args: unionArgs(existing.args, incoming.args),
    env: mergeEnv(existing.env, incoming.env),
    transport: existing.transport,
    description: pickLonger(existing.description, incoming.description),
    tags: unionTags(existing.tags, incoming.tags),
    enabled: existing.enabled,
    _registry: existing._registry,
    adapters: existing.adapters,
  };
}

/**
 * Run the full merge pipeline for brownfield import:
 *
 * 1. identifyDuplicates — two-tier matching
 * 2. classifyConflicts — identical / compatible / conflicting
 * 3. Apply strategy:
 *    - auto: merge compatible, skip identical, skip fuzzy with warning
 *    - force: incoming wins for all matches
 *    - interactive: returns conflicts for caller to resolve
 */
export function runMergePipeline(
  existing: Record<string, Server>,
  incoming: ImportedServer[],
  strategy: MergeStrategy,
  incomingSource = "unknown",
): MergeResult {
  const { matches, newServers } = identifyDuplicates(existing, incoming, incomingSource);
  const classified = classifyConflicts(matches);

  const result: MergeResult = {
    added: newServers,
    skipped: [],
    merged: [],
    conflicts: [],
  };

  for (const conflict of classified) {
    if (conflict.classification === "identical") {
      result.skipped.push(conflict.match);
      continue;
    }

    if (strategy === "interactive") {
      // Return all non-identical conflicts for caller to handle
      result.conflicts.push(conflict);
      continue;
    }

    if (strategy === "force") {
      const merged = mergeServers(
        conflict.match.existingServer,
        conflict.match.incomingServer,
        "force",
      );
      result.merged.push({
        name: conflict.match.existingName,
        server: merged,
        conflict,
      });
      continue;
    }

    // auto strategy
    if (conflict.match.type === "fuzzy") {
      // Never auto-resolve fuzzy matches — too risky
      result.conflicts.push(conflict);
      continue;
    }

    // Exact match with diffs — auto-merge
    const merged = mergeServers(
      conflict.match.existingServer,
      conflict.match.incomingServer,
      "auto",
    );
    result.merged.push({
      name: conflict.match.existingName,
      server: merged,
      conflict,
    });
  }

  return result;
}
