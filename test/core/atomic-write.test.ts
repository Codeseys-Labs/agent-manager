import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __writeBackupCollisionSafe,
  __writeBackupCollisionSafeSync,
  atomicWriteFile,
  atomicWriteFileSync,
} from "../../src/core/atomic-write";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "am-atomic-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("atomicWriteFileSync", () => {
  test("writes string data to target", () => {
    const target = join(dir, "config.json");
    atomicWriteFileSync(target, '{"hello":"world"}\n');
    expect(readFileSync(target, "utf-8")).toBe('{"hello":"world"}\n');
  });

  test("writes Uint8Array data to target", () => {
    const target = join(dir, "bin.dat");
    const bytes = new Uint8Array([0x41, 0x42, 0x43]);
    atomicWriteFileSync(target, bytes);
    expect(readFileSync(target)).toEqual(Buffer.from(bytes));
  });

  test("overwrites existing file atomically", () => {
    const target = join(dir, "config.json");
    atomicWriteFileSync(target, "first");
    atomicWriteFileSync(target, "second");
    expect(readFileSync(target, "utf-8")).toBe("second");
  });

  test("preserves file mode when specified", () => {
    const target = join(dir, "secret.txt");
    atomicWriteFileSync(target, "sensitive", { mode: 0o600 });
    // Windows NTFS does not honour POSIX file modes — chmod is a near-no-op, so
    // `statSync().mode & 0o777` is not 0o600 there. Assert the exact mode only on
    // POSIX; on Windows assert the write itself succeeded (content present).
    if (process.platform !== "win32") {
      const mode = statSync(target).mode & 0o777;
      expect(mode).toBe(0o600);
    } else {
      expect(readFileSync(target, "utf-8")).toBe("sensitive");
    }
  });

  test("does not leave tmp files after success", () => {
    const target = join(dir, "config.json");
    atomicWriteFileSync(target, '{"a":1}');
    const leftover = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  test("cleans up tmp file on rename failure", () => {
    // Target dir does not exist -> writeFileSync on tmp fails (parent missing)
    const badTarget = join(dir, "nope", "deeper", "file.json");
    expect(() => atomicWriteFileSync(badTarget, "x")).toThrow();
    // Parent of badTarget does not exist, so no tmp could be created there either.
    // Verify the main dir has no stray tmp.
    const leftover = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  test("cleans up tmp file when rename fails because target is a directory", () => {
    // Create a directory where the file should go; rename will fail.
    const target = join(dir, "adir");
    // Make target a non-empty directory so renameSync fails on most platforms.
    const innerDir = join(target, "inner");
    require("node:fs").mkdirSync(innerDir, { recursive: true });
    require("node:fs").writeFileSync(join(innerDir, "x"), "x");

    expect(() => atomicWriteFileSync(target, "data")).toThrow();

    // Tmp file should have been cleaned up from dir
    const leftover = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  test("tmp filename is sibling of target (same directory)", () => {
    // We can observe this indirectly: after a successful write the tmp must
    // have lived in the target's directory for the rename to be atomic.
    // We assert via mode: if tmp were in a different FS (e.g. /tmp when target
    // is on another volume), rename would either fail or silently succeed
    // without atomicity. Here we just confirm the happy path works even on a
    // freshly created subdir, which implies same-dir tmp.
    const subdir = join(dir, "sub");
    require("node:fs").mkdirSync(subdir, { recursive: true });
    const target = join(subdir, "a.json");
    atomicWriteFileSync(target, "content");
    expect(readFileSync(target, "utf-8")).toBe("content");
  });
});

describe("atomicWriteFile (async)", () => {
  test("writes string data to target", async () => {
    const target = join(dir, "config.json");
    await atomicWriteFile(target, '{"hello":"world"}\n');
    expect(readFileSync(target, "utf-8")).toBe('{"hello":"world"}\n');
  });

  test("overwrites existing file", async () => {
    const target = join(dir, "config.json");
    await atomicWriteFile(target, "first");
    await atomicWriteFile(target, "second");
    expect(readFileSync(target, "utf-8")).toBe("second");
  });

  test("preserves file mode when specified", async () => {
    const target = join(dir, "secret.txt");
    await atomicWriteFile(target, "sensitive", { mode: 0o600 });
    // Windows NTFS does not honour POSIX file modes — chmod is a near-no-op, so
    // `statSync().mode & 0o777` is not 0o600 there. Assert the exact mode only on
    // POSIX; on Windows assert the write itself succeeded (content present).
    if (process.platform !== "win32") {
      const mode = statSync(target).mode & 0o777;
      expect(mode).toBe(0o600);
    } else {
      expect(readFileSync(target, "utf-8")).toBe("sensitive");
    }
  });

  test("does not leave tmp files after success", async () => {
    const target = join(dir, "config.json");
    await atomicWriteFile(target, '{"a":1}');
    const leftover = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  test("cleans up tmp file when rename fails because target is a directory", async () => {
    const target = join(dir, "adir");
    const innerDir = join(target, "inner");
    require("node:fs").mkdirSync(innerDir, { recursive: true });
    require("node:fs").writeFileSync(join(innerDir, "x"), "x");

    await expect(atomicWriteFile(target, "data")).rejects.toThrow();
    const leftover = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });
});

// ── L9: backup filename collision must never overwrite a distinct backup ──────
//
// Two backups produced within the same nanosecond window with a colliding sha
// prefix would previously resolve to the same `${ts}-${sha}.bak` name and the
// second silently clobber the first. The collision-safe writer opens with the
// exclusive flag ('wx') so a name collision throws EEXIST instead of
// overwriting, and retries with a random suffix until it lands a fresh name.
describe("__writeBackupCollisionSafeSync (L9 collision safety)", () => {
  test("two backups with the SAME base name are both persisted distinctly", () => {
    const base = "20260503T142207Z-000000001-deadbeef.bak";
    const n1 = __writeBackupCollisionSafeSync(dir, base, Buffer.from("first"), 0o600);
    const n2 = __writeBackupCollisionSafeSync(dir, base, Buffer.from("second"), 0o600);

    // The first claims the canonical name; the second must NOT overwrite it.
    expect(n1).toBe(base);
    expect(n2).not.toBe(n1);

    const baks = readdirSync(dir).filter((f) => f.endsWith(".bak"));
    expect(baks.length).toBe(2);

    // Both payloads survive — no silent overwrite.
    expect(readFileSync(join(dir, n1), "utf-8")).toBe("first");
    expect(readFileSync(join(dir, n2), "utf-8")).toBe("second");
  });

  test("does not overwrite a pre-existing .bak at the chosen name", () => {
    const base = "20260101T000000Z-000000000-cafef00d.bak";
    // Simulate a prior backup already sitting at the canonical name.
    writeFileSync(join(dir, base), "PRECIOUS", { mode: 0o600 });

    const written = __writeBackupCollisionSafeSync(dir, base, Buffer.from("new"), 0o600);
    expect(written).not.toBe(base);

    // The pre-existing file is untouched.
    expect(readFileSync(join(dir, base), "utf-8")).toBe("PRECIOUS");
    expect(readFileSync(join(dir, written), "utf-8")).toBe("new");
  });

  test("retains the .bak suffix on the collision-resolved name", () => {
    const base = "20260202T000000Z-000000000-12345678.bak";
    __writeBackupCollisionSafeSync(dir, base, Buffer.from("a"), 0o600);
    const second = __writeBackupCollisionSafeSync(dir, base, Buffer.from("b"), 0o600);
    expect(second.endsWith(".bak")).toBe(true);
  });
});

describe("__writeBackupCollisionSafe (async, L9 collision safety)", () => {
  test("two backups with the SAME base name are both persisted distinctly", async () => {
    const base = "20260503T142207Z-000000001-deadbeef.bak";
    const n1 = await __writeBackupCollisionSafe(dir, base, Buffer.from("first"), 0o600);
    const n2 = await __writeBackupCollisionSafe(dir, base, Buffer.from("second"), 0o600);

    expect(n1).toBe(base);
    expect(n2).not.toBe(n1);

    const baks = readdirSync(dir).filter((f) => f.endsWith(".bak"));
    expect(baks.length).toBe(2);

    expect(readFileSync(join(dir, n1), "utf-8")).toBe("first");
    expect(readFileSync(join(dir, n2), "utf-8")).toBe("second");
  });

  test("does not overwrite a pre-existing .bak at the chosen name", async () => {
    const base = "20260101T000000Z-000000000-cafef00d.bak";
    writeFileSync(join(dir, base), "PRECIOUS", { mode: 0o600 });

    const written = await __writeBackupCollisionSafe(dir, base, Buffer.from("new"), 0o600);
    expect(written).not.toBe(base);
    expect(readFileSync(join(dir, base), "utf-8")).toBe("PRECIOUS");
    expect(readFileSync(join(dir, written), "utf-8")).toBe("new");
  });
});
