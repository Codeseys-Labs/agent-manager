/**
 * Hardening regression test — constantTimeEq must use a timing-safe path.
 *
 * The iter1 implementation short-circuited on length mismatch, leaking
 * token length via observable latency. The fix in Wave B hashes both
 * inputs with SHA-256 first, then calls crypto.timingSafeEqual on the
 * 32-byte digests — identical work regardless of input length or prefix.
 *
 * This test guards the CONTRACT: if a future refactor goes back to
 * `a === b` or any string compare that short-circuits, the test fails.
 */
import { describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { constantTimeEq } from "../../src/mcp/server";

describe("constantTimeEq: timing-safe contract", () => {
  test("calls crypto.createHash for BOTH operands", () => {
    const hashSpy = spyOn(crypto, "createHash");
    hashSpy.mockClear();
    try {
      constantTimeEq("alpha", "beta");
      // Must be called at least twice — once per operand — so that the
      // inputs are hashed to fixed-length digests before comparison.
      expect(hashSpy).toHaveBeenCalledTimes(2);
      // Each call must use sha256.
      for (const call of hashSpy.mock.calls) {
        expect(call[0]).toBe("sha256");
      }
    } finally {
      hashSpy.mockRestore();
    }
  });

  test("calls crypto.timingSafeEqual on the hashed digests", () => {
    const tseSpy = spyOn(crypto, "timingSafeEqual");
    tseSpy.mockClear();
    try {
      constantTimeEq("alpha", "beta");
      expect(tseSpy).toHaveBeenCalledTimes(1);
      // Both args must be 32-byte buffers (sha256 digest size).
      const [a, b] = tseSpy.mock.calls[0] as [Buffer, Buffer];
      expect(a.length).toBe(32);
      expect(b.length).toBe(32);
    } finally {
      tseSpy.mockRestore();
    }
  });

  test("returns true for equal strings", () => {
    expect(constantTimeEq("same-token", "same-token")).toBe(true);
  });

  test("returns false for inequal strings of equal length", () => {
    expect(constantTimeEq("token-a", "token-b")).toBe(false);
  });

  test("returns false for inequal strings of different length", () => {
    // The fix MUST NOT short-circuit on length difference.
    expect(constantTimeEq("short", "a-much-longer-token-value")).toBe(false);
  });

  test("returns false for empty string vs nonempty", () => {
    expect(constantTimeEq("", "something")).toBe(false);
  });

  test("returns true for two empty strings", () => {
    expect(constantTimeEq("", "")).toBe(true);
  });
});
