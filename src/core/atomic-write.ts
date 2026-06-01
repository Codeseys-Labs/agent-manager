/**
 * Atomic file writes.
 *
 * Direct `writeFileSync(target, ...)` leaves `target` empty or truncated if
 * the process is killed mid-write (SIGTERM, crash, power loss). For user
 * configs like `~/.claude.json` that the IDE re-reads and re-writes, a
 * corrupt write can drop sibling fields that were not even part of what
 * agent-manager intended to modify.
 *
 * The fix: write to a sibling tmp file in the same directory, fsync, then
 * rename over the target. POSIX `rename(2)` within the same filesystem is
 * atomic — either the old contents are visible or the new contents are,
 * never a half-written file. Node's `renameSync` maps to the same syscall.
 *
 * The tmp file MUST be in the same directory as the target so the rename
 * stays within one filesystem (cross-filesystem rename degrades to
 * copy+delete, which is not atomic).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

interface AtomicWriteOptions {
  /** File mode (e.g. 0o600). Applied to the tmp file before rename. */
  mode?: number;
  /**
   * When the target file already exists and its current content differs
   * from `data`, copy the existing file into
   * `$AM_CONFIG_DIR/backups/<sha8>/` before the atomic rename lands.
   * Enables `am undo` recovery of third-party-IDE edits that were about
   * to be overwritten. Default: read from AM_APPLY_BACKUP env var
   * (opt-in; off by default for now to avoid disk-use surprises until
   * the retention sweep is wired into `am doctor`).
   *
   * Issue #1 (2026-04-15 claude.json wipe) motivated this hook.
   */
  backup?: boolean;
}

// ── Backup hook (issue #1) ───────────────────────────────────────────────────

const DEFAULT_KEEP_COUNT = 10;

function configDirFor(): string {
  return process.env.AM_CONFIG_DIR ?? join(homedir(), ".config", "agent-manager");
}

function backupRootFor(): string {
  return join(configDirFor(), "backups");
}

/**
 * Target paths vary across adapters and filesystems — hash the absolute
 * target path to get a stable directory key.
 */
function targetKey(target: string): string {
  return createHash("sha256").update(target).digest("hex").slice(0, 8);
}

/**
 * 20260503T142207Z-NNNNNNNNN formatted ISO-basic-UTC + process.hrtime
 * tail — NTFS-safe (no `:`) AND monotonic within a single process even
 * when multiple backups land in the same millisecond. Without the
 * monotonic tail, identical-timestamp .bak filenames would sort by hash
 * (not by insertion), causing the manifest prune and on-disk prune to
 * diverge (REV-3 follow-up).
 */
function isoBasic(d = new Date()): string {
  const ts = d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const hr = process.hrtime.bigint().toString().padStart(19, "0").slice(-9);
  return `${ts}-${hr}`;
}

interface BackupMeta {
  target: string;
  timestamp: string;
  sha: string;
  path: string;
}

function backupEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.AM_APPLY_BACKUP === "1" || process.env.AM_APPLY_BACKUP === "true";
}

/**
 * Copy the current contents of `target` into the per-target backup dir,
 * provided (a) backups are enabled, (b) the target exists, and (c) its
 * current sha256 differs from the hash of `data` (no point backing up
 * identical content).
 */
async function maybeBackup(target: string, data: string | Uint8Array): Promise<BackupMeta | null> {
  if (!existsSync(target)) return null;
  let current: Buffer;
  try {
    current = await readFile(target);
  } catch {
    return null;
  }
  const newBytes = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
  if (current.equals(newBytes)) return null;
  const key = targetKey(target);
  const dir = join(backupRootFor(), key);
  await mkdir(dir, { recursive: true });
  const sha = createHash("sha256").update(current).digest("hex").slice(0, 8);
  const ts = isoBasic();
  const name = `${ts}-${sha}.bak`;
  const path = join(dir, name);
  await writeFile(path, current, { mode: 0o600 });
  // Persist a pointer manifest so `am undo` can list backups by target.
  const manifestPath = join(dir, "manifest.json");
  let manifest: { target: string; entries: Array<{ name: string; sha: string; ts: string }> } = {
    target,
    entries: [],
  };
  try {
    const existing = JSON.parse(await readFile(manifestPath, "utf-8"));
    if (existing && Array.isArray(existing.entries)) manifest = existing;
    manifest.target = target; // refresh in case the user moved it
  } catch {
    // first write
  }
  manifest.entries.push({ name, sha, ts });
  // REV-3 (2026-05-03): prune the manifest alongside the .bak files so
  // listBackupsForTarget never returns paths pointing to deleted files.
  // Prune by INSERTION ORDER (the manifest is append-ordered) and delete
  // exactly the .bak files that fall out of the keep-window. The older
  // approach re-sorted on-disk filenames lexically, which only matches
  // insertion order if `<ts>-<hr>` sorts identically to insertion — true on
  // POSIX but NOT guaranteed on Windows where the hrtime tail can wrap a
  // 1e9-ns boundary between two same-millisecond writes. Driving on-disk
  // deletion straight from the dropped manifest entries makes manifest and
  // disk lockstep on every platform.
  let dropped: Array<{ name: string }> = [];
  if (manifest.entries.length > DEFAULT_KEEP_COUNT) {
    dropped = manifest.entries.slice(0, manifest.entries.length - DEFAULT_KEEP_COUNT);
    manifest.entries = manifest.entries.slice(-DEFAULT_KEEP_COUNT);
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  for (const d of dropped) {
    try {
      await unlink(join(dir, d.name));
    } catch {
      // best-effort: file may already be gone
    }
  }
  return { target, timestamp: ts, sha, path };
}

function maybeBackupSync(target: string, data: string | Uint8Array): BackupMeta | null {
  if (!existsSync(target)) return null;
  let current: Buffer;
  try {
    current = readFileSync(target);
  } catch {
    return null;
  }
  const newBytes = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
  if (current.equals(newBytes)) return null;
  const key = targetKey(target);
  const dir = join(backupRootFor(), key);
  // Using sync fs here — atomicWriteFileSync is typically called from CLI
  // paths where a sync fs call is fine.
  const fsSync = require("node:fs") as typeof import("node:fs");
  fsSync.mkdirSync(dir, { recursive: true });
  const sha = createHash("sha256").update(current).digest("hex").slice(0, 8);
  const ts = isoBasic();
  const name = `${ts}-${sha}.bak`;
  const path = join(dir, name);
  fsSync.writeFileSync(path, current, { mode: 0o600 });
  const manifestPath = join(dir, "manifest.json");
  let manifest: { target: string; entries: Array<{ name: string; sha: string; ts: string }> } = {
    target,
    entries: [],
  };
  try {
    const existing = JSON.parse(fsSync.readFileSync(manifestPath, "utf-8"));
    if (existing && Array.isArray(existing.entries)) manifest = existing;
    manifest.target = target;
  } catch {
    // first write
  }
  manifest.entries.push({ name, sha, ts });
  // REV-3 (2026-05-03): prune the manifest alongside .bak files so
  // listBackupsForTarget never returns paths pointing to deleted files.
  // Prune by INSERTION ORDER and delete exactly the dropped entries' files —
  // see maybeBackup for why re-sorting filenames lexically diverges on
  // Windows (hrtime-tail wrap across a 1e9-ns boundary).
  let dropped: Array<{ name: string }> = [];
  if (manifest.entries.length > DEFAULT_KEEP_COUNT) {
    dropped = manifest.entries.slice(0, manifest.entries.length - DEFAULT_KEEP_COUNT);
    manifest.entries = manifest.entries.slice(-DEFAULT_KEEP_COUNT);
  }
  fsSync.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  for (const d of dropped) {
    try {
      fsSync.unlinkSync(join(dir, d.name));
    } catch {
      // best-effort: file may already be gone
    }
  }
  return { target, timestamp: ts, sha, path };
}

/**
 * Enumerate backups for a given target. Used by `am undo` / doctor to
 * surface the rollback options.
 */
export async function listBackupsForTarget(target: string): Promise<BackupMeta[]> {
  const dir = join(backupRootFor(), targetKey(target));
  try {
    const manifestPath = join(dir, "manifest.json");
    const parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      target: string;
      entries: Array<{ name: string; sha: string; ts: string }>;
    };
    return parsed.entries.map((e) => ({
      target: parsed.target,
      timestamp: e.ts,
      sha: e.sha,
      path: join(dir, e.name),
    }));
  } catch {
    return [];
  }
}

// Used by tests to ensure `stat` above isn't tree-shaken if unused.
void stat;

/** Generate a tmp filename in the same directory as `target`. */
function tmpPathFor(target: string): string {
  const dir = dirname(target);
  const base = basename(target);
  const suffix = randomBytes(6).toString("hex");
  return join(dir, `.${base}.${suffix}.tmp`);
}

/**
 * Resolve the "effective target" for an atomic write.
 *
 * Wave B (2026-04-16): previously, `renameSync(tmp, target)` where `target`
 * was a symlink would *replace the symlink itself* with a regular file,
 * silently breaking dotfile-repo workflows (e.g. `~/.claude.json` →
 * `~/dotfiles/claude.json`).
 *
 * Fix: `lstat` the target first. If it's a symlink, resolve to the real
 * path and perform the atomic write against that path — the symlink stays
 * intact and the real file is updated atomically.
 *
 * Returns the path the atomic write should target. Non-existent paths and
 * regular files fall through unchanged.
 */
function resolveEffectiveTargetSync(target: string): string {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(target);
  } catch {
    // Target doesn't exist yet — write to it as-is.
    return target;
  }
  if (st.isSymbolicLink()) {
    try {
      // realpathSync follows the symlink chain to the canonical path.
      return realpathSync(target);
    } catch {
      // Dangling symlink: leave as-is; rename will replace it. (Rare.)
      return target;
    }
  }
  return target;
}

async function resolveEffectiveTarget(target: string): Promise<string> {
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink()) {
      try {
        return await realpath(target);
      } catch {
        return target;
      }
    }
  } catch {
    // Target doesn't exist — proceed as-is.
  }
  return target;
}

/**
 * Atomically write `data` to `target`:
 *  1. Write to a sibling tmp file in the same directory.
 *  2. fsync the tmp file so contents hit disk.
 *  3. rename the tmp file over `target` (atomic within a filesystem).
 *
 * On error the tmp file is unlinked (best-effort) and the error is rethrown.
 *
 * NOTE: We intentionally do NOT fsync the directory here. Node does not expose
 * directory fsync portably, and the rename itself is metadata-journaled on
 * APFS/ext4/etc. The weaker guarantee is: after this function returns
 * successfully, a subsequent `readFileSync(target)` in the same process sees
 * the new bytes and no concurrent reader sees a truncated file. Survival
 * across a hard power cut without directory fsync is filesystem-dependent
 * (APFS and modern ext4 with data=ordered are fine for user config files).
 */
export function atomicWriteFileSync(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  // Resolve symlinks to the real target so we rename into the dotfile repo
  // (or wherever the symlink points) instead of replacing the symlink.
  const effectiveTarget = resolveEffectiveTargetSync(target);
  const tmp = tmpPathFor(effectiveTarget);
  let fd: number | null = null;

  // Issue #1: snapshot the existing target BEFORE we rename over it. Gated
  // on AM_APPLY_BACKUP until doctor-driven pruning lands; opt-in keeps
  // disk-use surprises at bay.
  if (backupEnabled(options.backup)) {
    try {
      maybeBackupSync(effectiveTarget, data);
    } catch {
      // best-effort: never block a legitimate write because backup failed
    }
  }

  try {
    writeFileSync(tmp, data, options.mode !== undefined ? { mode: options.mode } : undefined);

    // fsync: open, fsync, close. This guarantees the data is durable before
    // we rename over the target — otherwise a crash between write and rename
    // could leave an empty target (rename succeeded, data not yet flushed).
    //
    // The handle MUST be opened with write access ("r+", not "r"): on Windows
    // FlushFileBuffers requires a write-capable handle, so fsync of a
    // read-only fd returns EPERM ("operation not permitted, fsync"). POSIX
    // permits fsync on a read-only fd, which is why the read-only variant
    // passed on Linux/macOS but hard-failed every Windows CI leg. "r+" keeps
    // the existing tmp content and merely grants the write bit.
    fd = openSync(tmp, "r+");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    renameSync(tmp, effectiveTarget);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // fd may already be closed
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may not exist if writeFileSync itself failed
    }
    throw err;
  }
}

/**
 * Async variant of {@link atomicWriteFileSync}. Same semantics, using
 * node:fs/promises so it can be awaited without blocking the event loop.
 */
export async function atomicWriteFile(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  // See resolveEffectiveTargetSync: preserve symlinks by writing into the
  // real file's directory.
  const effectiveTarget = await resolveEffectiveTarget(target);
  const tmp = tmpPathFor(effectiveTarget);

  // Issue #1: snapshot-before-overwrite (async path).
  if (backupEnabled(options.backup)) {
    try {
      await maybeBackup(effectiveTarget, data);
    } catch {
      // best-effort
    }
  }

  try {
    await writeFile(tmp, data, options.mode !== undefined ? { mode: options.mode } : undefined);

    // "r+" (read+write) is required for Windows FlushFileBuffers — fsync of a
    // read-only handle returns EPERM there. See atomicWriteFileSync above.
    const handle = await open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tmp, effectiveTarget);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // tmp may not exist
    }
    throw err;
  }
}
