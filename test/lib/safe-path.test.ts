import { describe, expect, test } from "bun:test";
import { join, sep } from "node:path";
import {
  UnsafePathSegmentError,
  assertSafePathSegment,
  isUnsafePathSegment,
  sanitizePathSegment,
} from "../../src/lib/safe-path";

describe("lib/safe-path", () => {
  describe("isUnsafePathSegment", () => {
    test("flags traversal, separators, null bytes, and dot tokens", () => {
      expect(isUnsafePathSegment("../escape")).toBe(true);
      expect(isUnsafePathSegment("..")).toBe(true);
      expect(isUnsafePathSegment(".")).toBe(true);
      expect(isUnsafePathSegment("...")).toBe(true);
      expect(isUnsafePathSegment("a/b")).toBe(true);
      expect(isUnsafePathSegment("a\\b")).toBe(true);
      expect(isUnsafePathSegment("/abs")).toBe(true);
      expect(isUnsafePathSegment("a\0b")).toBe(true);
      expect(isUnsafePathSegment("")).toBe(true);
    });

    test("accepts ordinary names", () => {
      expect(isUnsafePathSegment("my-rule")).toBe(false);
      expect(isUnsafePathSegment("rule_v2.md")).toBe(false);
      expect(isUnsafePathSegment("Server1")).toBe(false);
    });
  });

  describe("sanitizePathSegment", () => {
    test("contains a traversal name so it cannot escape its directory", () => {
      const cleaned = sanitizePathSegment("../../evil");
      expect(isUnsafePathSegment(cleaned)).toBe(false);
      expect(cleaned).not.toContain("/");
      expect(cleaned).not.toContain("..");
      // Joining the cleaned segment under a base must stay inside the base.
      // join() emits the native separator (`\` on Windows), so build the
      // expected base prefix with `sep` for a separator-agnostic assertion.
      const base = join("/tmp", "target");
      const result = join(base, `${cleaned}.md`);
      expect(result.startsWith(`${base}${sep}`)).toBe(true);
    });

    test("strips path separators and shell metacharacters", () => {
      expect(sanitizePathSegment("a/b/c")).toBe("a-b-c");
      expect(sanitizePathSegment("a\\b")).toBe("a-b");
      expect(sanitizePathSegment("name with spaces")).toBe("name-with-spaces");
      expect(sanitizePathSegment("rm -rf $HOME")).not.toContain("$");
    });

    test("collapses leading dots so hidden/traversal names are neutralized", () => {
      expect(sanitizePathSegment("..")).not.toBe("..");
      expect(sanitizePathSegment(".hidden")).toBe("hidden");
      expect(sanitizePathSegment("...")).toBe("unnamed");
    });

    test("returns the fallback for empty or fully-stripped input", () => {
      expect(sanitizePathSegment("")).toBe("unnamed");
      expect(sanitizePathSegment("///")).toBe("unnamed");
      expect(sanitizePathSegment("", "fallback")).toBe("fallback");
    });

    test("removes the null byte", () => {
      const cleaned = sanitizePathSegment("a\0b");
      expect(cleaned).not.toContain("\0");
      expect(isUnsafePathSegment(cleaned)).toBe(false);
    });

    test("preserves legitimate names unchanged", () => {
      expect(sanitizePathSegment("my-instruction")).toBe("my-instruction");
      expect(sanitizePathSegment("rule_v2")).toBe("rule_v2");
    });

    test("never produces a '..' token even for adversarial dotted input", () => {
      for (const evil of ["../../evil", "..\\..\\evil", "a/../../b", "....//....//x"]) {
        const cleaned = sanitizePathSegment(evil);
        expect(cleaned).not.toContain("..");
        expect(cleaned).not.toContain("/");
        expect(cleaned).not.toContain("\\");
      }
    });
  });

  describe("assertSafePathSegment", () => {
    test("throws on traversal and separators", () => {
      expect(() => assertSafePathSegment("../escape")).toThrow(UnsafePathSegmentError);
      expect(() => assertSafePathSegment("a/b")).toThrow(UnsafePathSegmentError);
      expect(() => assertSafePathSegment("a\\b")).toThrow(UnsafePathSegmentError);
      expect(() => assertSafePathSegment("..")).toThrow(UnsafePathSegmentError);
      expect(() => assertSafePathSegment("a\0b")).toThrow(UnsafePathSegmentError);
      expect(() => assertSafePathSegment("")).toThrow(UnsafePathSegmentError);
    });

    test("returns valid names unchanged", () => {
      expect(assertSafePathSegment("good-name")).toBe("good-name");
    });
  });
});
