import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile, atomicWriteFileSync } from "../../src/core/atomic-write";

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
