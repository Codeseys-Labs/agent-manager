import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  expectedBetterleaksSha256,
  getBetterleaksPath,
  getBetterleaksVersion,
  isBetterleaksAvailable,
  scanWithBetterleaks,
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
