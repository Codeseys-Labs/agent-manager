/**
 * `am secrets migrate` — forward-port legacy `enc:v1:` envelopes to the
 * currently-configured secrets backend (ADR-0042).
 *
 * Flow:
 *   1. Discover TOML config files: the global `config.toml` and any
 *      repo-local `.agent-manager.toml` reachable from `cwd`.
 *   2. Walk every string value. For each `enc:v1:...` envelope:
 *      - decrypt via `AesGcmLegacyBackend` (machine key),
 *      - re-encrypt via the active backend (`age` or same legacy).
 *   3. Write the file back with the new envelopes. A `.bak` copy of
 *      the original is left beside each modified file.
 *
 * Supports `--dry-run` (report planned changes without touching disk)
 * and `--file <path>` to target a specific TOML file.
 *
 * Existing `enc:v1:` envelopes ALWAYS decrypt through the legacy
 * backend regardless of the currently-selected write backend — that's
 * the whole point of the migration tool. New envelopes use whatever
 * `settings.secrets.backend` specifies (default: aes-gcm-legacy, in
 * which case migrate is effectively a no-op unless `--to` is used).
 */

import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import * as TOML from "@iarna/toml";
import { defineCommand } from "citty";
import { atomicWriteFile } from "../core/atomic-write";
import { resolveConfigDir, resolveProjectConfig } from "../core/config";
import {
  AesGcmLegacyBackend,
  type SelectableBackendName,
  getDefaultBackend,
  isLegacyV1Envelope,
  loadKey,
} from "../core/secrets";
import type { SecretsBackend } from "../core/secrets-backend";
import { amError, info, output } from "../lib/output";

interface MigrateStat {
  file: string;
  found: number;
  migrated: number;
  skipped: number;
  backupPath?: string;
}

export const secretsMigrateCommand = defineCommand({
  meta: {
    name: "migrate",
    description:
      "Re-encrypt legacy enc:v1: envelopes in TOML configs using the current secrets backend.",
  },
  args: {
    "dry-run": {
      type: "boolean",
      description: "Report planned changes; do not modify any files.",
      default: false,
    },
    file: {
      type: "string",
      description: "Target a specific TOML file instead of auto-discovering.",
    },
    to: {
      type: "string",
      description:
        "Override the destination backend (`age` or `aes-gcm-legacy`). Defaults to settings.secrets.backend.",
    },
    "no-backup": {
      type: "boolean",
      description: "Do not write a `.bak` copy of each modified file.",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    try {
      const dryRun = args["dry-run"];
      const noBackup = args["no-backup"];
      const override = parseBackendOverride(args.to);

      const configDir = resolveConfigDir();

      // Determine target backend.
      const destBackend = await getDefaultBackend(configDir, {
        ...(override !== undefined && { override }),
      });

      // The legacy backend is always required as the *source* for
      // reading `enc:v1:` envelopes. Resolve the machine key now.
      const legacyKey = await loadKey(configDir);
      if (!legacyKey) {
        // No key at all: there can't be any v1 envelopes to migrate.
        info(
          "No legacy AES-GCM key found — nothing to migrate (enc:v1: envelopes require the machine key).",
          opts,
        );
        if (args.json) output({ action: "migrate", files: [] }, opts);
        return;
      }
      const srcBackend = new AesGcmLegacyBackend(legacyKey);

      // Discover the files to scan.
      const targets = args.file
        ? [resolvePath(args.file)]
        : await discoverTomlFiles(configDir, process.cwd());

      const stats: MigrateStat[] = [];
      for (const file of targets) {
        const stat = await migrateFile(file, srcBackend, destBackend, {
          dryRun,
          noBackup,
        });
        if (stat) stats.push(stat);
      }

      const totalFound = stats.reduce((n, s) => n + s.found, 0);
      const totalMigrated = stats.reduce((n, s) => n + s.migrated, 0);

      if (args.json) {
        output(
          {
            action: "migrate",
            dryRun,
            backend: destBackend.name,
            files: stats,
            totals: { found: totalFound, migrated: totalMigrated },
          },
          opts,
        );
        return;
      }

      if (stats.length === 0) {
        info("No TOML config files found to scan.", opts);
        return;
      }

      for (const s of stats) {
        if (s.found === 0) continue;
        const action = dryRun ? "would migrate" : "migrated";
        info(`${s.file}: ${action} ${s.migrated}/${s.found} envelope(s).`, opts);
        if (s.backupPath) info(`  backup: ${s.backupPath}`, opts);
      }
      info("", opts);
      info(
        `Total: ${totalMigrated}/${totalFound} envelope(s) ${dryRun ? "would be " : ""}migrated to backend "${destBackend.name}".`,
        opts,
      );
    } catch (err) {
      amError(err, opts);
      process.exitCode = 1;
    }
  },
});

function parseBackendOverride(to: string | undefined): SelectableBackendName | undefined {
  if (to === undefined) return undefined;
  if (to === "age" || to === "aes-gcm-legacy") return to;
  throw new Error(
    `--to: expected "age" or "aes-gcm-legacy", got ${JSON.stringify(to)}.`,
  );
}

/**
 * Discover TOML files to scan for enc:v1: envelopes. The global
 * `config.toml` (if present) plus any repo-local `.agent-manager.toml`
 * reachable from `cwd` — matches the files users actually commit
 * secrets to.
 *
 * Silently drops files that don't exist — `migrateFile` already
 * re-reads each path and will surface real errors there.
 */
async function discoverTomlFiles(configDir: string, cwd: string): Promise<string[]> {
  const out = new Set<string>();
  const globalConfig = join(configDir, "config.toml");
  if (await pathExists(globalConfig)) out.add(globalConfig);
  const localConfig = join(configDir, "config.local.toml");
  if (await pathExists(localConfig)) out.add(localConfig);
  const projectConfig = resolveProjectConfig(cwd);
  if (projectConfig) out.add(projectConfig);
  return Array.from(out);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan one TOML file, re-encrypt legacy envelopes, and write the
 * result (unless `dryRun`). Returns a summary even when nothing
 * changed so the caller can surface a report.
 *
 * Preserves the original via `<file>.bak` before the atomic write so
 * users can roll back if the migration misbehaves. Pass `noBackup`
 * to suppress the backup for CI/automated contexts.
 */
async function migrateFile(
  file: string,
  src: SecretsBackend,
  dst: SecretsBackend,
  opts: { dryRun: boolean; noBackup: boolean },
): Promise<MigrateStat | null> {
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
    // Invalid TOML — leave it alone rather than clobber the file.
    return { file, found: 0, migrated: 0, skipped: 0 };
  }

  let found = 0;
  let migrated = 0;
  let skipped = 0;

  async function walk(value: unknown): Promise<unknown> {
    if (typeof value === "string") {
      if (!isLegacyV1Envelope(value)) return value;
      found++;
      try {
        const plaintext = await src.decrypt(value);
        const reencrypted = await dst.encrypt(plaintext);
        migrated++;
        return reencrypted;
      } catch (err) {
        skipped++;
        // Propagate as a non-fatal signal via the returned stat; the
        // original value is preserved so a partial failure never
        // destroys data.
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

  if (found === 0) {
    return { file, found: 0, migrated: 0, skipped: 0 };
  }

  if (opts.dryRun || migrated === 0) {
    return { file, found, migrated, skipped };
  }

  // Serialize and write. `@iarna/toml` is the same library used by
  // `core/config`, so the round-trip matches everything else agent-
  // manager produces on disk.
  const serialized = TOML.stringify(rewritten as TOML.JsonMap);

  let backupPath: string | undefined;
  if (!opts.noBackup) {
    backupPath = `${file}.bak`;
    await atomicWriteFile(backupPath, raw);
  }
  await atomicWriteFile(file, serialized);

  return { file, found, migrated, skipped, backupPath };
}
