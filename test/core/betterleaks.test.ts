import { describe, expect, test } from "bun:test";
import {
  getBetterleaksPath,
  getBetterleaksVersion,
  isBetterleaksAvailable,
  scanWithBetterleaks,
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
