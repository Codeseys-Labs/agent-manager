import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectedBetterleaksSha256,
  getBetterleaksPath,
  getBetterleaksVersion,
  isBetterleaksAvailable,
  scanWithBetterleaks,
  spawnFailed,
  verifyBetterleaksChecksum,
} from "../../src/core/betterleaks";

describe("betterleaks", () => {
  test("isBetterleaksAvailable returns a boolean", () => {
    const result = isBetterleaksAvailable();
    expect(typeof result).toBe("boolean");
  });

  test("getBetterleaksPath returns string or null", () => {
    const result = getBetterleaksPath();
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("getBetterleaksVersion returns string or null", () => {
    const result = getBetterleaksVersion();
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("scanWithBetterleaks with empty content returns empty array or null", () => {
    const result = scanWithBetterleaks("");
    // Returns null if betterleaks is not installed, empty array if installed
    if (result !== null) {
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    } else {
      expect(result).toBeNull();
    }
  });

  test("scanWithBetterleaks with benign content returns no findings", () => {
    const result = scanWithBetterleaks("hello = world\nfoo = bar");
    if (result !== null) {
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    } else {
      expect(result).toBeNull();
    }
  });

  test("availability and path are consistent", () => {
    const available = isBetterleaksAvailable();
    const path = getBetterleaksPath();
    if (available) {
      expect(path).not.toBeNull();
    }
    if (!path) {
      expect(available).toBe(false);
    }
  });
});

// P2-H: pinned-SHA-256 verification before chmod+exec.
describe("betterleaks checksum verification (P2-H)", () => {
  const ASSET = "betterleaks-test-asset";
  const payload = new TextEncoder().encode("fake-binary-bytes");
  const payloadSha = createHash("sha256").update(payload).digest("hex");
  // Variable-keyed env mutation (biome's noDelete allows a dynamic key).
  function setEnv(name: string, val: string | undefined) {
    if (val === undefined) delete process.env[name];
    else process.env[name] = val;
  }
  const orig: Record<string, string | undefined> = {
    AM_BETTERLEAKS_SHA256: process.env.AM_BETTERLEAKS_SHA256,
    AM_ALLOW_UNVERIFIED_BETTERLEAKS: process.env.AM_ALLOW_UNVERIFIED_BETTERLEAKS,
  };

  beforeEach(() => {
    setEnv("AM_BETTERLEAKS_SHA256", undefined);
    setEnv("AM_ALLOW_UNVERIFIED_BETTERLEAKS", undefined);
  });

  afterEach(() => {
    for (const [name, val] of Object.entries(orig)) setEnv(name, val);
  });

  test("FAILS CLOSED when no pin is available (built-in pins are TODO placeholders)", () => {
    // No env pin, no built-in pin for an unknown asset → must refuse.
    const res = verifyBetterleaksChecksum(payload, ASSET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("No pinned SHA-256");
  });

  test("the shipped built-in pins are empty placeholders → install fails closed by default", () => {
    // Regression guard: until real upstream SHAs are filled in, the default
    // platform asset has no pin, so production install must fail closed.
    expect(expectedBetterleaksSha256()).toBeNull();
  });

  test("matches an operator-supplied env pin", () => {
    process.env.AM_BETTERLEAKS_SHA256 = payloadSha;
    const res = verifyBetterleaksChecksum(payload, ASSET);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sha256).toBe(payloadSha);
  });

  test("rejects a checksum mismatch (tampered/corrupt download)", () => {
    process.env.AM_BETTERLEAKS_SHA256 = "0".repeat(64);
    const res = verifyBetterleaksChecksum(payload, ASSET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("Checksum mismatch");
  });

  test("env pin is case-insensitive", () => {
    process.env.AM_BETTERLEAKS_SHA256 = payloadSha.toUpperCase();
    const res = verifyBetterleaksChecksum(payload, ASSET);
    expect(res.ok).toBe(true);
  });

  test("explicit AM_ALLOW_UNVERIFIED_BETTERLEAKS=1 opt-out bypasses the missing-pin gate", () => {
    process.env.AM_ALLOW_UNVERIFIED_BETTERLEAKS = "1";
    const res = verifyBetterleaksChecksum(payload, ASSET);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sha256).toBe(payloadSha);
  });

  test("opt-out does NOT override a present-but-mismatched pin", () => {
    process.env.AM_ALLOW_UNVERIFIED_BETTERLEAKS = "1";
    process.env.AM_BETTERLEAKS_SHA256 = "0".repeat(64);
    const res = verifyBetterleaksChecksum(payload, ASSET);
    expect(res.ok).toBe(false);
  });
});

// Silent-failure fix: a crashed/timed-out/non-zero betterleaks run must signal
// UNAVAILABLE (null) — NOT a false-clean empty-findings ([]) result. With
// `--exit-code 0` passed, a non-zero status genuinely means the tool failed.
describe("betterleaks scan failure ⇒ null (distinct from clean empty scan)", () => {
  describe("spawnFailed classifier", () => {
    test("clean successful run (status 0, no error/signal) is NOT a failure", () => {
      expect(spawnFailed({ status: 0, signal: null })).toBe(false);
    });

    test("non-zero exit status IS a failure (tool error under --exit-code 0)", () => {
      expect(spawnFailed({ status: 1, signal: null })).toBe(true);
      expect(spawnFailed({ status: 2, signal: null })).toBe(true);
    });

    test("spawn/timeout error IS a failure", () => {
      // Node populates result.error on spawn failure and on timeout.
      expect(spawnFailed({ error: new Error("spawn ENOENT"), status: null })).toBe(true);
      expect(spawnFailed({ error: new Error("ETIMEDOUT") })).toBe(true);
    });

    test("killed by signal IS a failure (timeout SIGTERM / maxBuffer overflow)", () => {
      expect(spawnFailed({ signal: "SIGTERM", status: null })).toBe(true);
      expect(spawnFailed({ signal: "SIGKILL", status: null })).toBe(true);
    });
  });

  describe("scanWithBetterleaks end-to-end against a failing shim binary", () => {
    let tmp: string;
    const origPath = process.env.PATH;

    function installShim(name: string, scriptBody: string) {
      // On Windows the resolver looks for betterleaks.exe; these POSIX shims
      // only exercise the failure path on Unix. The classifier tests above
      // cover the platform-agnostic logic.
      const binPath = join(tmp, name);
      writeFileSync(binPath, scriptBody, { mode: 0o755 });
      chmodSync(binPath, 0o755);
      process.env.PATH = `${tmp}:${origPath}`;
    }

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "am-betterleaks-shim-"));
    });

    afterEach(() => {
      process.env.PATH = origPath;
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });

    // Skip the PATH-shim e2e tests if a real/managed betterleaks resolves
    // first (getBetterleaksPath() checks the managed install dir before PATH).
    // The classifier tests above still lock the platform-agnostic logic.
    function shimWouldResolve(): boolean {
      return getBetterleaksPath() === "betterleaks";
    }

    test("non-zero exit (with empty stdout) returns null, NOT []", () => {
      if (process.platform === "win32") return; // POSIX shim only
      // `version` must exit 0 so getBetterleaksPath() resolves the shim; the
      // real `stdin` scan exits non-zero with empty stdout — the silent-failure
      // case. Before the fix this reported [] (false-clean).
      installShim(
        "betterleaks",
        '#!/bin/sh\nif [ "$1" = "version" ]; then echo "betterleaks 1.1.1"; exit 0; fi\nexit 3\n',
      );
      if (!shimWouldResolve()) return; // a real managed install shadows the shim
      const result = scanWithBetterleaks("token = abc123");
      expect(result).toBeNull();
    });

    test("successful run with empty findings returns [] (genuinely clean, not failure)", () => {
      if (process.platform === "win32") return; // POSIX shim only
      installShim(
        "betterleaks",
        '#!/bin/sh\nif [ "$1" = "version" ]; then echo "betterleaks 1.1.1"; exit 0; fi\necho "[]"; exit 0\n',
      );
      if (!shimWouldResolve()) return; // a real managed install shadows the shim
      const result = scanWithBetterleaks("hello = world");
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    test("clean exit but non-JSON garbage output returns null (not false-clean [])", () => {
      if (process.platform === "win32") return; // POSIX shim only
      installShim(
        "betterleaks",
        '#!/bin/sh\nif [ "$1" = "version" ]; then echo "betterleaks 1.1.1"; exit 0; fi\necho "PANIC: not json"; exit 0\n',
      );
      if (!shimWouldResolve()) return; // a real managed install shadows the shim
      const result = scanWithBetterleaks("token = abc123");
      expect(result).toBeNull();
    });
  });
});
