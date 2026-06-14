/**
 * Apply-backup introspection + retention.
 *
 * Layered on top of the per-write backup hook in `atomic-write.ts` (which
 * already keeps the newest 10 .bak per target dir). This module gives
 * operators visibility (`am doctor`) and proactive sweeps (`am apply`)
 * without coupling to the write path.
 *
 * On-disk layout (mirrors atomic-write.ts):
 *   $AM_CONFIG_DIR/backups/<sha8>/<isobasic-ts>-<sha8>.bak
 *   $AM_CONFIG_DIR/backups/<sha8>/manifest.json   ({ target, entries[] })
 *
 * `entries[]` is append-only and sorted oldest-first.
 */

import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_KEEP_COUNT } from "./atomic-write";

// Single source of truth for the keep-count: the proactive sweep default MUST
// equal atomic-write's per-write prune floor so the two prune windows don't
// diverge (W-l8). Re-exporting the same constant rather than a local `10`.
const DEFAULT_MAX_COUNT = DEFAULT_KEEP_COUNT;
const DEFAULT_MAX_AGE_DAYS = 30;

export interface BackupSummary {
  target: string;
  count: number;
  totalBytes: number;
  oldestTs: string | null;
  newestTs: string | null;
}

interface ManifestEntry {
  name: string;
  sha: string;
  ts: string;
}

interface Manifest {
  target: string;
  entries: ManifestEntry[];
}

function configDirFor(): string {
  return process.env.AM_CONFIG_DIR ?? join(homedir(), ".config", "agent-manager");
}

function backupRootFor(): string {
  return join(configDirFor(), "backups");
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(join(dir, "manifest.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.target === "string" && Array.isArray(parsed.entries)) {
      return parsed as Manifest;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

async function listPerTargetDirs(): Promise<string[]> {
  const root = backupRootFor();
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

/**
 * Walk every per-target dir and emit one BackupSummary per dir. Dirs
 * missing a manifest are silently skipped (stray dirs shouldn't fail
 * enumeration). Bytes are counted from the .bak files actually on disk;
 * a stale manifest entry referencing a deleted .bak does not inflate
 * the byte count.
 */
export async function listAllBackups(): Promise<BackupSummary[]> {
  const dirs = await listPerTargetDirs();
  const summaries: BackupSummary[] = [];
  for (const dir of dirs) {
    const manifest = await readManifest(dir);
    if (!manifest) continue;
    let totalBytes = 0;
    let count = 0;
    let oldestTs: string | null = null;
    let newestTs: string | null = null;
    for (const entry of manifest.entries) {
      try {
        const st = await stat(join(dir, entry.name));
        totalBytes += st.size;
        count += 1;
        if (oldestTs === null || entry.ts < oldestTs) oldestTs = entry.ts;
        if (newestTs === null || entry.ts > newestTs) newestTs = entry.ts;
      } catch {
        // .bak hand-deleted; skip without inflating the summary.
      }
    }
    summaries.push({ target: manifest.target, count, totalBytes, oldestTs, newestTs });
  }
  return summaries;
}

export async function getBackupStats(): Promise<{
  targets: number;
  totalBackups: number;
  totalBytes: number;
}> {
  const all = await listAllBackups();
  let totalBackups = 0;
  let totalBytes = 0;
  for (const s of all) {
    totalBackups += s.count;
    totalBytes += s.totalBytes;
  }
  return { targets: all.length, totalBackups, totalBytes };
}

/**
 * Parse the leading `YYYYMMDDTHHmmssZ` segment of an isobasic timestamp
 * back to an epoch ms. Returns null on malformed input so callers can
 * skip the entry rather than crash.
 */
function parseIsoBasic(ts: string): number | null {
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(ms) ? null : ms;
}

function envMaxCount(): number {
  const raw = process.env.AM_APPLY_BACKUP_MAX;
  if (!raw) return DEFAULT_MAX_COUNT;
  const parsed = Number.parseInt(raw, 10);
  // Negative / unparseable: fall back to the default keep-count.
  if (Number.isNaN(parsed) || parsed < 0) return DEFAULT_MAX_COUNT;
  // A keep-count of 0 must NOT mean keep-all. Downstream `slice(-maxCount)`
  // treats `slice(-0)` as `slice(0)` (the whole array), which would retain
  // every backup forever — the exact opposite of "keep zero" and a silent
  // disk-bloat footgun. Floor to 1 so a 0 still bounds retention (W-l8).
  if (parsed === 0) return 1;
  return parsed;
}

function envMaxAgeDays(): number {
  const raw = process.env.AM_APPLY_BACKUP_MAX_AGE;
  if (!raw) return DEFAULT_MAX_AGE_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return DEFAULT_MAX_AGE_DAYS;
  return parsed;
}

/**
 * Best-effort prune of every per-target dir under $AM_CONFIG_DIR/backups.
 *
 * Strategy per dir:
 *  1. Read manifest (if absent, skip dir entirely — atomic-write owns it).
 *  2. Compute the set of "kept" entries: drop entries older than maxAgeDays
 *     AND keep only the newest maxCount.
 *  3. Delete any .bak file whose manifest entry was dropped OR whose
 *     manifest entry references a missing file.
 *  4. Rewrite manifest.json so entries[] matches the .bak files that
 *     actually remain on disk (heals manifest divergence).
 *
 * Per-file errors are swallowed so one broken target doesn't abort the sweep.
 */
export async function pruneBackups(
  options: { maxAgeDays?: number; maxCount?: number } = {},
): Promise<{ removed: number; freedBytes: number }> {
  const maxAgeDays = options.maxAgeDays ?? envMaxAgeDays();
  // Floor the resolved keep-count at 1: a 0 (or negative) here would make the
  // `slice(-maxCount)` survivor selection below degrade to `slice(0)` —
  // keep-all — instead of pruning. envMaxCount already floors the env path;
  // this guards the explicit `options.maxCount` path too so there is a single
  // invariant: the survivor window is always >= 1 (W-l8).
  const maxCount = Math.max(1, options.maxCount ?? envMaxCount());
  const ageThresholdMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const dirs = await listPerTargetDirs();
  let removed = 0;
  let freedBytes = 0;

  for (const dir of dirs) {
    const manifest = await readManifest(dir);
    if (!manifest) continue;

    // Sort manifest entries oldest-first by timestamp string. The isobasic
    // format sorts lexicographically in chronological order, so a string
    // sort is correct without parsing.
    const sorted = [...manifest.entries].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    // Apply age + count filters to figure out which entries SHOULD survive.
    const surviveByAge = sorted.filter((e) => {
      const ms = parseIsoBasic(e.ts);
      if (ms === null) return true; // Unparseable ts: keep, let count-based prune decide.
      return ms >= ageThresholdMs;
    });
    const survivors = surviveByAge.slice(-maxCount);
    const survivorNames = new Set(survivors.map((e) => e.name));

    // Delete .bak files whose manifest entry didn't survive. Use the
    // manifest as the authoritative source for what to delete — stray
    // .bak files without a manifest entry are left alone (atomic-write
    // never produces them).
    for (const entry of sorted) {
      if (survivorNames.has(entry.name)) continue;
      const filePath = join(dir, entry.name);
      try {
        const st = await stat(filePath);
        await rm(filePath, { force: true });
        freedBytes += st.size;
        removed += 1;
      } catch {
        // File already gone (hand-deleted) or unlink failed. Either way,
        // the entry is dropped from the manifest below.
      }
    }

    // Heal manifest: keep only entries whose .bak file still exists on
    // disk. This handles both the prune we just did and any prior
    // hand-deletion the user performed.
    const healed: ManifestEntry[] = [];
    for (const entry of survivors) {
      try {
        await stat(join(dir, entry.name));
        healed.push(entry);
      } catch {
        // .bak gone — drop the entry.
      }
    }

    if (healed.length !== manifest.entries.length) {
      try {
        await writeManifest(dir, { target: manifest.target, entries: healed });
      } catch {
        // Best-effort: a write failure here is non-fatal for the sweep.
      }
    }
  }

  return { removed, freedBytes };
}
