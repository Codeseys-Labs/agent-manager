/**
 * Shared helpers for rewrapping every `enc:v2:age:...` envelope found
 * in the local config TOML files. Both `am secrets rewrap` and the
 * post-action step of `am secrets rotate [--finalize]` /
 * `am secrets revoke <fp>` reuse this — the operations differ only in
 * what they do to the *recipient set* (rewrap leaves it alone; rotate
 * adds the new recipient; revoke drops one). The actual envelope-walk
 * logic is identical.
 *
 * Extracted from the original `src/commands/secrets-rotate.ts` per
 * ADR-0051 §"Phase 1" so the rewrap pipeline is reusable across all
 * four verbs without circular imports.
 */

import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import * as TOML from "@iarna/toml";
import { atomicWriteFile } from "../core/atomic-write";
import { resolveProjectConfig } from "../core/config";
import type { AgeSecretsBackend } from "../core/secrets-age";

export const AGE_ENVELOPE_PREFIX = "enc:v2:age:";

export interface RewrapStat {
  file: string;
  found: number;
  rewrapped: number;
  skipped: number;
  backupPath?: string;
}

export interface RewrapOpts {
  dryRun: boolean;
  noBackup: boolean;
}

/**
 * Walk a TOML file, rewrapping every age envelope to the current
 * recipient set, and atomically write the result back.
 *
 * `null` return means the file did not exist (caller decides whether
 * that is an error).
 */
export async function rewrapTomlFile(
  file: string,
  backend: AgeSecretsBackend,
  opts: RewrapOpts,
): Promise<RewrapStat | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch {
    return { file, found: 0, rewrapped: 0, skipped: 0 };
  }

  let found = 0;
  let rewrapped = 0;
  let skipped = 0;

  async function walk(value: unknown): Promise<unknown> {
    if (typeof value === "string") {
      if (!value.startsWith(AGE_ENVELOPE_PREFIX)) return value;
      found++;
      try {
        const next = await backend.rewrap(value);
        if (next !== value) rewrapped++;
        return next;
      } catch {
        skipped++;
        return value;
      }
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const v of value) out.push(await walk(v));
      return out;
    }
    if (value !== null && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = await walk(v);
      return out;
    }
    return value;
  }

  const rewritten = (await walk(parsed)) as Record<string, unknown>;

  if (found === 0) return { file, found: 0, rewrapped: 0, skipped: 0 };

  if (opts.dryRun || rewrapped === 0) {
    return { file, found, rewrapped, skipped };
  }

  const serialized = TOML.stringify(rewritten as TOML.JsonMap);

  let backupPath: string | undefined;
  if (!opts.noBackup) {
    backupPath = `${file}.bak`;
    await atomicWriteFile(backupPath, raw);
  }
  await atomicWriteFile(file, serialized);

  return { file, found, rewrapped, skipped, backupPath };
}

/**
 * Discover the candidate TOML config files for a rewrap pass. Mirrors
 * the original behaviour of `secrets rotate`: global config, machine
 * override, and the project config nearest the cwd.
 */
export async function discoverTomlFiles(configDir: string, cwd: string): Promise<string[]> {
  const out = new Set<string>();
  const { stat } = await import("node:fs/promises");
  async function exists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }
  const globalConfig = join(configDir, "config.toml");
  if (await exists(globalConfig)) out.add(globalConfig);
  const localConfig = join(configDir, "config.local.toml");
  if (await exists(localConfig)) out.add(localConfig);
  const projectConfig = resolveProjectConfig(cwd);
  if (projectConfig) out.add(projectConfig);
  return Array.from(out);
}

/** Resolve a single user-supplied --file argument. */
export function resolveSingleFile(file: string): string {
  return resolvePath(file);
}

/**
 * Run the rewrap walk over a list of files and return the per-file
 * stats. The caller decides how to render them (text or JSON).
 */
export async function rewrapMany(
  targets: readonly string[],
  backend: AgeSecretsBackend,
  opts: RewrapOpts,
): Promise<RewrapStat[]> {
  const stats: RewrapStat[] = [];
  for (const file of targets) {
    const stat = await rewrapTomlFile(file, backend, opts);
    if (stat) stats.push(stat);
  }
  return stats;
}

/** Read settings.secrets.rotation.grace_period_days, defaulting to 14. */
export function readGracePeriodDays(config: unknown): number {
  const days = (
    config as { settings?: { secrets?: { rotation?: { grace_period_days?: unknown } } } }
  )?.settings?.secrets?.rotation?.grace_period_days;
  if (typeof days === "number" && Number.isInteger(days) && days >= 0 && days <= 365) {
    return days;
  }
  return 14;
}
