/**
 * Snapshot-before-overwrite hook (issue #1 fix, 2026-05-03).
 *
 * `atomicWriteFile{,Sync}` now copies the pre-existing target into
 * $AM_CONFIG_DIR/backups/<sha8>/<timestamp>-<sha8>.bak before the rename
 * lands, whenever (a) AM_APPLY_BACKUP=1 OR options.backup === true, and
 * (b) the target exists, and (c) its current bytes differ from the
 * new-content bytes.
 *
 * What these tests pin:
 *   - Off by default (no env, no options.backup) → no backup written.
 *   - Opt-in via options.backup=true → backup lands at the expected path.
 *   - Identical content → backup is NOT written (no-op dedup).
 *   - manifest.json tracks entries for `am undo`.
 *   - Keep-count prune: 11th write drops the oldest.
 *   - listBackupsForTarget returns exactly the manifest entries.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteFile,
  atomicWriteFileSync,
  listBackupsForTarget,
} from "../../src/core/atomic-write";

let cfgDir: string;
let targetDir: string;
let target: string;

beforeEach(async () => {
  cfgDir = await mkdtemp(join(tmpdir(), "am-backup-cfg-"));
  targetDir = await mkdtemp(join(tmpdir(), "am-backup-target-"));
  target = join(targetDir, "config.json");
  process.env.AM_CONFIG_DIR = cfgDir;
});

afterEach(async () => {
  await rm(cfgDir, { recursive: true, force: true });
  await rm(targetDir, { recursive: true, force: true });
  process.env.AM_APPLY_BACKUP = undefined;
});

describe("atomic-write backup hook", () => {
  test("off by default — no backup when neither env nor option set", async () => {
    await writeFile(target, "v1");
    await atomicWriteFile(target, "v2");
    const backups = await listBackupsForTarget(target);
    expect(backups).toHaveLength(0);
  });

  test("opt-in via options.backup writes a .bak + manifest", async () => {
    await writeFile(target, "original");
    await atomicWriteFile(target, "updated", { backup: true });
    expect(await Bun.file(target).text()).toBe("updated");

    const backups = await listBackupsForTarget(target);
    expect(backups).toHaveLength(1);
    const bakContent = await readFile(backups[0].path, "utf-8");
    expect(bakContent).toBe("original");
    expect(backups[0].target).toBe(target);
    expect(backups[0].sha).toHaveLength(8);
  });

  test("opt-in via AM_APPLY_BACKUP=1 works too", async () => {
    await writeFile(target, "v1");
    process.env.AM_APPLY_BACKUP = "1";
    try {
      await atomicWriteFile(target, "v2");
    } finally {
      process.env.AM_APPLY_BACKUP = undefined;
    }
    const backups = await listBackupsForTarget(target);
    expect(backups).toHaveLength(1);
  });

  test("identical content → NO backup (no-op dedup)", async () => {
    await writeFile(target, "same");
    await atomicWriteFile(target, "same", { backup: true });
    const backups = await listBackupsForTarget(target);
    expect(backups).toHaveLength(0);
  });

  test("missing target → NO backup (nothing to snapshot)", async () => {
    await atomicWriteFile(target, "first write", { backup: true });
    const backups = await listBackupsForTarget(target);
    expect(backups).toHaveLength(0);
  });

  test("prune keeps at most 10 entries — manifest AND on-disk in lockstep (REV-3)", async () => {
    await writeFile(target, "v0");
    for (let i = 1; i <= 12; i++) {
      await atomicWriteFile(target, `v${i}`, { backup: true });
    }
    const backups = await listBackupsForTarget(target);
    // On-disk .bak files are capped...
    const dirContents = fs.readdirSync(join(cfgDir, "backups")).flatMap((k) => {
      const p = join(cfgDir, "backups", k);
      return fs
        .readdirSync(p)
        .filter((f) => f.endsWith(".bak"))
        .map((f) => join(p, f));
    });
    expect(dirContents.length).toBeLessThanOrEqual(10);
    // ...AND the manifest is pruned in lockstep so listBackupsForTarget
    // never returns paths that point at deleted files (REV-3 fix).
    expect(backups.length).toBe(dirContents.length);
    expect(backups.length).toBeLessThanOrEqual(10);
    // Every returned path must actually exist on disk.
    for (const b of backups) {
      expect(fs.existsSync(b.path)).toBe(true);
    }
  });

  test("atomicWriteFileSync also snapshots", () => {
    fs.writeFileSync(target, "sync-v1");
    atomicWriteFileSync(target, "sync-v2", { backup: true });
    const key = require("node:crypto")
      .createHash("sha256")
      .update(target)
      .digest("hex")
      .slice(0, 8);
    const dir = join(cfgDir, "backups", key);
    const bakFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".bak"));
    expect(bakFiles).toHaveLength(1);
    const bakContent = fs.readFileSync(join(dir, bakFiles[0]), "utf-8");
    expect(bakContent).toBe("sync-v1");
  });

  test("listBackupsForTarget returns [] when no history exists", async () => {
    const unknown = await listBackupsForTarget(join(targetDir, "never-written.json"));
    expect(unknown).toEqual([]);
  });
});
