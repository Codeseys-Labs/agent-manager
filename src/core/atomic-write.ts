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

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

interface AtomicWriteOptions {
  /** File mode (e.g. 0o600). Applied to the tmp file before rename. */
  mode?: number;
}

/** Generate a tmp filename in the same directory as `target`. */
function tmpPathFor(target: string): string {
  const dir = dirname(target);
  const base = basename(target);
  const suffix = randomBytes(6).toString("hex");
  return join(dir, `.${base}.${suffix}.tmp`);
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
  const tmp = tmpPathFor(target);
  let fd: number | null = null;

  try {
    writeFileSync(tmp, data, options.mode !== undefined ? { mode: options.mode } : undefined);

    // fsync: open, fsync, close. This guarantees the data is durable before
    // we rename over the target — otherwise a crash between write and rename
    // could leave an empty target (rename succeeded, data not yet flushed).
    fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    renameSync(tmp, target);
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
  const tmp = tmpPathFor(target);

  try {
    await writeFile(tmp, data, options.mode !== undefined ? { mode: options.mode } : undefined);

    const handle = await open(tmp, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tmp, target);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // tmp may not exist
    }
    throw err;
  }
}
