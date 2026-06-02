import { describe, expect, test } from "bun:test";
import {
  type WikiConfidence,
  confidenceToScore,
  normalizeConfidence,
  scoreToConfidence,
} from "../../src/wiki/types";

// ADR-0054 R4: confidence moved from a raw 0.0-1.0 number to the ADR-0020
// enum (low|medium|high). These tests pin the bucket thresholds and the
// one-time read-path normalisation that keeps pre-R4 pages readable.

describe("wiki/types confidence (ADR-0054 R4)", () => {
  describe("scoreToConfidence", () => {
    test("maps high scores to 'high' (>= 0.7)", () => {
      expect(scoreToConfidence(0.7)).toBe("high");
      expect(scoreToConfidence(0.85)).toBe("high");
      expect(scoreToConfidence(1.0)).toBe("high");
    });

    test("maps mid scores to 'medium' (>= 0.4, < 0.7)", () => {
      expect(scoreToConfidence(0.4)).toBe("medium");
      expect(scoreToConfidence(0.55)).toBe("medium");
      expect(scoreToConfidence(0.69)).toBe("medium");
    });

    test("maps low scores to 'low' (< 0.4)", () => {
      expect(scoreToConfidence(0)).toBe("low");
      expect(scoreToConfidence(0.2)).toBe("low");
      expect(scoreToConfidence(0.39)).toBe("low");
    });
  });

  describe("confidenceToScore", () => {
    test("maps each enum value to a representative numeric score", () => {
      expect(confidenceToScore("high")).toBeGreaterThanOrEqual(0.7);
      expect(confidenceToScore("medium")).toBeGreaterThanOrEqual(0.4);
      expect(confidenceToScore("medium")).toBeLessThan(0.7);
      expect(confidenceToScore("low")).toBeLessThan(0.4);
    });

    test("score → enum → score is bucket-stable (round-trip)", () => {
      for (const c of ["low", "medium", "high"] as WikiConfidence[]) {
        expect(scoreToConfidence(confidenceToScore(c))).toBe(c);
      }
    });
  });

  describe("normalizeConfidence (one-time migration)", () => {
    test("passes through valid enum strings", () => {
      expect(normalizeConfidence("high")).toBe("high");
      expect(normalizeConfidence("medium")).toBe("medium");
      expect(normalizeConfidence("low")).toBe("low");
    });

    test("is case-insensitive and trims whitespace", () => {
      expect(normalizeConfidence("HIGH")).toBe("high");
      expect(normalizeConfidence("  Medium  ")).toBe("medium");
    });

    test("normalises legacy numeric confidence to the enum bucket", () => {
      expect(normalizeConfidence(0.85)).toBe("high");
      expect(normalizeConfidence(0.5)).toBe("medium");
      expect(normalizeConfidence(0.1)).toBe("low");
    });

    test("tolerates a numeric string that slipped into frontmatter", () => {
      expect(normalizeConfidence("0.9")).toBe("high");
      expect(normalizeConfidence("0.45")).toBe("medium");
    });

    test("returns undefined for absent / unrecognised values", () => {
      expect(normalizeConfidence(undefined)).toBeUndefined();
      expect(normalizeConfidence(null)).toBeUndefined();
      expect(normalizeConfidence("")).toBeUndefined();
      expect(normalizeConfidence("not-a-level")).toBeUndefined();
      expect(normalizeConfidence(Number.NaN)).toBeUndefined();
      expect(normalizeConfidence({})).toBeUndefined();
    });
  });
});
