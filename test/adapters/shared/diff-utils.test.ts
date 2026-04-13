import { describe, expect, test } from "bun:test";
import { compareInstructions } from "../../../src/adapters/shared/diff-utils";
import { AM_BEGIN, AM_END } from "../../../src/adapters/shared/utils";
import type { ResolvedInstruction } from "../../../src/adapters/types";

// ── Helpers ─────────────────────────────────────────────────────

function makeInstruction(overrides: Partial<ResolvedInstruction> = {}): ResolvedInstruction {
  return {
    name: "test-instruction",
    content: "Default instruction content.",
    scope: "always",
    globs: [],
    description: "A test instruction",
    targets: [],
    adapters: {},
    ...overrides,
  };
}

function wrapInMarkers(content: string): string {
  return `${AM_BEGIN}\n${content}\n${AM_END}`;
}

// ── Tests ───────────────────────────────────────────────────────

describe("compareInstructions", () => {
  test("detects added instructions (present in native but not expected)", () => {
    // No expected instructions, but native file has a managed block
    const expected: Record<string, ResolvedInstruction> = {};
    const nativeContent = wrapInMarkers("Some stale managed content");

    const changes = compareInstructions(expected, nativeContent, "claude-code");

    expect(changes.length).toBeGreaterThan(0);
    const addedLocally = changes.filter((c) => c.type === "added-locally");
    expect(addedLocally.length).toBe(1);
    expect(addedLocally[0].name).toBe("_managed_block");
  });

  test("detects removed instructions (expected but native file missing)", () => {
    const expected: Record<string, ResolvedInstruction> = {
      "ts-rules": makeInstruction({ name: "ts-rules", content: "Use strict TypeScript." }),
      "style-guide": makeInstruction({ name: "style-guide", content: "Follow the style guide." }),
    };

    // Native file does not exist
    const changes = compareInstructions(expected, null, "claude-code");

    expect(changes.length).toBe(2);
    const removedLocally = changes.filter((c) => c.type === "removed-locally");
    expect(removedLocally.length).toBe(2);
    const names = removedLocally.map((c) => c.name);
    expect(names).toContain("ts-rules");
    expect(names).toContain("style-guide");
  });

  test("detects changed instruction content", () => {
    const expected: Record<string, ResolvedInstruction> = {
      "ts-rules": makeInstruction({ name: "ts-rules", content: "Use strict TypeScript." }),
    };

    // Native file has markers but different content
    const nativeContent = wrapInMarkers("Use loose TypeScript.");

    const changes = compareInstructions(expected, nativeContent, "claude-code");

    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe("modified");
    expect(changes[0].name).toBe("_managed_block");
    expect(changes[0].details).toBeDefined();
    expect(changes[0].details![0].field).toBe("content");
  });

  test("returns empty for matching instructions", () => {
    const content = "Use strict TypeScript.";
    const expected: Record<string, ResolvedInstruction> = {
      "ts-rules": makeInstruction({ name: "ts-rules", content }),
    };

    // Native file has markers with matching content
    const nativeContent = wrapInMarkers(content);

    const changes = compareInstructions(expected, nativeContent, "claude-code");
    expect(changes).toEqual([]);
  });

  test("detects removed when native exists but has no managed block", () => {
    const expected: Record<string, ResolvedInstruction> = {
      "ts-rules": makeInstruction({ name: "ts-rules", content: "Use strict TypeScript." }),
    };

    // Native file exists but has no markers
    const nativeContent = "# Some other content without markers";

    const changes = compareInstructions(expected, nativeContent, "claude-code");

    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe("removed-locally");
    expect(changes[0].name).toBe("ts-rules");
  });

  test("returns empty when no expected and no native", () => {
    const expected: Record<string, ResolvedInstruction> = {};
    const changes = compareInstructions(expected, null, "claude-code");
    expect(changes).toEqual([]);
  });

  test("returns empty when no expected and native has no managed block", () => {
    const expected: Record<string, ResolvedInstruction> = {};
    const nativeContent = "# Just a plain file with no markers";

    const changes = compareInstructions(expected, nativeContent, "claude-code");
    expect(changes).toEqual([]);
  });

  test("concatenates multiple expected instructions for comparison", () => {
    const expected: Record<string, ResolvedInstruction> = {
      rule1: makeInstruction({ name: "rule1", content: "Rule one." }),
      rule2: makeInstruction({ name: "rule2", content: "Rule two." }),
    };

    // Native has both rules concatenated
    const nativeContent = wrapInMarkers("Rule one.\n\nRule two.");

    const changes = compareInstructions(expected, nativeContent, "claude-code");
    expect(changes).toEqual([]);
  });
});
