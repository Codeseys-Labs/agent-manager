/**
 * apply-backup module — list/stats/prune over $AM_CONFIG_DIR/backups/.
 *
 * Layered on top of atomic-write.ts's per-write backup primitive (which
 * already prunes to DEFAULT_KEEP_COUNT=10 each write). This module exists
 * so `am doctor` can surface state and `am apply` can sweep proactively
 * by age/count.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackupSummary,
  getBackupStats,
  listAllBackups,
  pruneBackups,
} from "../../src/core/apply-backup";

let cfgDir: string;

function targetKey(target: string): string {
  return createHash("sha256").update(target).digest("hex").slice(0, 8);
}

function isoBasic(d: Date, monotonic = "000000001"): string {
  const ts = d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${ts}-${monotonic}`;
}

interface SeedEntry {
  ts: Date;
  content: string;
  /** Optional override for monotonic suffix to force ordering. */
  monotonic?: string;
}

/**
 * Seed `cfgDir/backups/<sha8>/` with .bak files + manifest.json
 * mirroring the on-disk layout written by atomic-write.ts.
 */
async function seedTarget(target: string, entries: SeedEntry[]): Promise<string> {
  const key = targetKey(target);
  const dir = join(cfgDir, "backups", key);
  await mkdir(dir, { recursive: true });
  const manifestEntries: Array<{ name: string; sha: string; ts: string }> = [];
  for (const [i, entry] of entries.entries()) {
    const sha = createHash("sha256").update(entry.content).digest("hex").slice(0, 8);
    const ts = isoBasic(entry.ts, entry.monotonic ?? String(i + 1).padStart(9, "0"));
    const name = `${ts}-${sha}.bak`;
    const filePath = join(dir, name);
    await writeFile(filePath, entry.content);
    // Backdate mtime/atime to match the timestamp so age-based prune sees
    // the right age regardless of the actual write moment.
    await utimes(filePath, entry.ts, entry.ts);
    manifestEntries.push({ name, sha, ts });
  }
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify({ target, entries: manifestEntries }, null, 2)}\n`,
  );
  return dir;
}

beforeEach(async () => {
  cfgDir = await mkdtemp(join(tmpdir(), "am-apply-backup-test-"));
  process.env.AM_CONFIG_DIR = cfgDir;
  process.env.AM_APPLY_BACKUP_MAX = undefined;
});

afterEach(async () => {
  await rm(cfgDir, { recursive: true, force: true });
  process.env.AM_CONFIG_DIR = undefined;
  process.env.AM_APPLY_BACKUP_MAX = undefined;
});

describe("listAllBackups", () => {
  test("returns [] when backups root missing", async () => {
    const result = await listAllBackups();
    expect(result).toEqual([]);
  });

  test("returns [] when backups root is empty", async () => {
    await mkdir(join(cfgDir, "backups"), { recursive: true });
    const result = await listAllBackups();
    expect(result).toEqual([]);
  });

  test("returns one summary per target dir containing a manifest", async () => {
    const t1 = "/abs/path/to/config-a.json";
    const t2 = "/abs/path/to/config-b.json";
    await seedTarget(t1, [
      { ts: new Date("2026-04-01T00:00:00Z"), content: "a-old" },
      { ts: new Date("2026-04-10T00:00:00Z"), content: "a-new" },
    ]);
    await seedTarget(t2, [{ ts: new Date("2026-04-05T00:00:00Z"), content: "b-only" }]);

    const result = await listAllBackups();
    expect(result).toHaveLength(2);
    const byTarget: Record<string, BackupSummary> = {};
    for (const s of result) byTarget[s.target] = s;
    expect(byTarget[t1].count).toBe(2);
    expect(byTarget[t1].totalBytes).toBe(Buffer.byteLength("a-old") + Buffer.byteLength("a-new"));
    expect(byTarget[t1].oldestTs).toBe("20260401T000000Z-000000001");
    expect(byTarget[t1].newestTs).toBe("20260410T000000Z-000000002");
    expect(byTarget[t2].count).toBe(1);
    expect(byTarget[t2].totalBytes).toBe(Buffer.byteLength("b-only"));
  });

  test("skips directories without a manifest", async () => {
    // Stray dir under backups/ shouldn't blow up enumeration.
    await mkdir(join(cfgDir, "backups", "deadbeef"), { recursive: true });
    await writeFile(join(cfgDir, "backups", "deadbeef", "stray.txt"), "noise");

    const result = await listAllBackups();
    expect(result).toEqual([]);
  });
});

describe("getBackupStats", () => {
  test("returns zeros when backups root missing", async () => {
    const stats = await getBackupStats();
    expect(stats).toEqual({ targets: 0, totalBackups: 0, totalBytes: 0 });
  });

  test("aggregates counts + bytes across multiple targets", async () => {
    await seedTarget("/x/a.json", [
      { ts: new Date("2026-01-01T00:00:00Z"), content: "111" },
      { ts: new Date("2026-01-02T00:00:00Z"), content: "2222" },
    ]);
    await seedTarget("/x/b.json", [{ ts: new Date("2026-01-03T00:00:00Z"), content: "55555" }]);

    const stats = await getBackupStats();
    expect(stats.targets).toBe(2);
    expect(stats.totalBackups).toBe(3);
    expect(stats.totalBytes).toBe(3 + 4 + 5);
  });
});

describe("pruneBackups", () => {
  test("with maxCount: 2 keeps newest 2 .bak files per target dir AND rewrites manifest", async () => {
    const target = "/some/config.json";
    const now = Date.now();
    const dir = await seedTarget(target, [
      { ts: new Date(now - 4 * 60 * 60 * 1000), content: "v1" },
      { ts: new Date(now - 3 * 60 * 60 * 1000), content: "v2" },
      { ts: new Date(now - 2 * 60 * 60 * 1000), content: "v3" },
      { ts: new Date(now - 1 * 60 * 60 * 1000), content: "v4" },
    ]);

    const result = await pruneBackups({ maxCount: 2 });
    expect(result.removed).toBe(2);
    expect(result.freedBytes).toBe(Buffer.byteLength("v1") + Buffer.byteLength("v2"));

    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith(".bak"));
    expect(remaining).toHaveLength(2);

    const manifest = JSON.parse(fs.readFileSync(join(dir, "manifest.json"), "utf-8"));
    expect(manifest.entries).toHaveLength(2);
    const entryNames = manifest.entries.map((e: { name: string }) => e.name).sort();
    expect(entryNames).toEqual(remaining.sort());
  });

  test("with maxAgeDays: 7 removes .bak files older than 7 days", async () => {
    const now = Date.now();
    const target = "/some/config.json";
    const dir = await seedTarget(target, [
      { ts: new Date(now - 30 * 24 * 60 * 60 * 1000), content: "old1" },
      { ts: new Date(now - 10 * 24 * 60 * 60 * 1000), content: "old2" },
      { ts: new Date(now - 3 * 24 * 60 * 60 * 1000), content: "fresh1" },
      { ts: new Date(now - 1 * 24 * 60 * 60 * 1000), content: "fresh2" },
    ]);

    const result = await pruneBackups({ maxAgeDays: 7 });
    expect(result.removed).toBe(2);

    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith(".bak"));
    expect(remaining).toHaveLength(2);

    const manifest = JSON.parse(fs.readFileSync(join(dir, "manifest.json"), "utf-8"));
    expect(manifest.entries).toHaveLength(2);
  });

  test("honours AM_APPLY_BACKUP_MAX env var when no maxCount passed", async () => {
    const target = "/some/config.json";
    const now = Date.now();
    const dir = await seedTarget(target, [
      { ts: new Date(now - 5 * 60 * 60 * 1000), content: "v1" },
      { ts: new Date(now - 4 * 60 * 60 * 1000), content: "v2" },
      { ts: new Date(now - 3 * 60 * 60 * 1000), content: "v3" },
      { ts: new Date(now - 2 * 60 * 60 * 1000), content: "v4" },
      { ts: new Date(now - 1 * 60 * 60 * 1000), content: "v5" },
    ]);

    process.env.AM_APPLY_BACKUP_MAX = "3";
    try {
      const result = await pruneBackups();
      expect(result.removed).toBe(2);
    } finally {
      process.env.AM_APPLY_BACKUP_MAX = undefined;
    }

    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith(".bak"));
    expect(remaining).toHaveLength(3);
  });

  test("default maxCount is 10 when no env var and no option", async () => {
    const target = "/some/config.json";
    const now = Date.now();
    const seedEntries: SeedEntry[] = [];
    for (let i = 1; i <= 15; i++) {
      seedEntries.push({
        ts: new Date(now - (16 - i) * 60 * 60 * 1000),
        content: `v${i}`,
      });
    }
    const dir = await seedTarget(target, seedEntries);

    const result = await pruneBackups();
    expect(result.removed).toBe(5);

    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith(".bak"));
    expect(remaining).toHaveLength(10);
  });

  test("returns { removed, freedBytes } accurately", async () => {
    const target = "/some/config.json";
    const now = Date.now();
    await seedTarget(target, [
      { ts: new Date(now - 3 * 60 * 60 * 1000), content: "abc" },
      { ts: new Date(now - 2 * 60 * 60 * 1000), content: "defgh" },
      { ts: new Date(now - 1 * 60 * 60 * 1000), content: "newest" },
    ]);

    const result = await pruneBackups({ maxCount: 1 });
    expect(result.removed).toBe(2);
    expect(result.freedBytes).toBe(Buffer.byteLength("abc") + Buffer.byteLength("defgh"));
  });

  test("manifest divergence: hand-deleted .bak is healed without crashing", async () => {
    const target = "/some/config.json";
    const now = Date.now();
    const dir = await seedTarget(target, [
      { ts: new Date(now - 3 * 60 * 60 * 1000), content: "v1" },
      { ts: new Date(now - 2 * 60 * 60 * 1000), content: "v2" },
      { ts: new Date(now - 1 * 60 * 60 * 1000), content: "v3" },
    ]);

    // Hand-delete one .bak — manifest still references it.
    const bakFiles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".bak"))
      .sort();
    fs.unlinkSync(join(dir, bakFiles[0]));

    // Should not throw. Should resync manifest to remaining files.
    const result = await pruneBackups({ maxCount: 10 });
    expect(typeof result.removed).toBe("number");

    const manifest = JSON.parse(fs.readFileSync(join(dir, "manifest.json"), "utf-8"));
    const remainingFiles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".bak"))
      .sort();
    const manifestNames = manifest.entries.map((e: { name: string }) => e.name).sort();
    expect(manifestNames).toEqual(remainingFiles);
  });

  test("returns { removed: 0, freedBytes: 0 } when backups root missing", async () => {
    const result = await pruneBackups({ maxCount: 1 });
    expect(result).toEqual({ removed: 0, freedBytes: 0 });
  });
});
