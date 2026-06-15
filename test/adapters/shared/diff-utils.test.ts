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

  test("labels catalog-ahead instructions added-in-config when native file missing", () => {
    const expected: Record<string, ResolvedInstruction> = {
      "ts-rules": makeInstruction({ name: "ts-rules", content: "Use strict TypeScript." }),
      "style-guide": makeInstruction({ name: "style-guide", content: "Follow the style guide." }),
    };

    // Native file does not exist: catalog-ahead FORWARD delta `am apply`
    // resolves by writing the managed block — NOT a local removal.
    // (ws4-drift-relabel-catalog-ahead)
    const changes = compareInstructions(expected, null, "claude-code");

    expect(changes.length).toBe(2);
    const addedInConfig = changes.filter((c) => c.type === "added-in-config");
    expect(addedInConfig.length).toBe(2);
    expect(changes.some((c) => c.type === "removed-locally")).toBe(false);
    const names = addedInConfig.map((c) => c.name);
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

  test("labels catalog-ahead added-in-config when native exists but has no managed block", () => {
    const expected: Record<string, ResolvedInstruction> = {
      "ts-rules": makeInstruction({ name: "ts-rules", content: "Use strict TypeScript." }),
    };

    // Native file exists but has no managed block yet: the catalog's
    // instructions have not been written. Catalog-ahead FORWARD delta `am apply`
    // resolves by inserting the block — NOT a local removal.
    // (ws4-drift-relabel-catalog-ahead)
    const nativeContent = "# Some other content without markers";

    const changes = compareInstructions(expected, nativeContent, "claude-code");

    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe("added-in-config");
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

  // ── CRLF normalization (M13) ──────────────────────────────────
  // Managed blocks are written with \n. On Windows, native files are read with
  // \r\n line endings. Internal \r must be normalized on BOTH sides before
  // comparing, or every multi-line instruction reports permanent false drift.

  test("reports no drift when native uses CRLF and managed block uses LF (M13)", () => {
    const content = "Line one.\nLine two.\nLine three.";
    const expected: Record<string, ResolvedInstruction> = {
      "ts-rules": makeInstruction({ name: "ts-rules", content }),
    };

    // Native file read with Windows CRLF line endings (every internal \n is \r\n),
    // including the marker boundaries the native writer/reader would produce.
    const nativeContent = wrapInMarkers(content).replace(/\n/g, "\r\n");

    const changes = compareInstructions(expected, nativeContent, "claude-code");
    expect(changes).toEqual([]);
  });

  test("reports no drift for lone CR line endings vs LF managed block (M13)", () => {
    const content = "Line one.\nLine two.";
    const expected: Record<string, ResolvedInstruction> = {
      "ts-rules": makeInstruction({ name: "ts-rules", content }),
    };

    // Old Mac-style lone \r line endings should also normalize to \n.
    const nativeContent = wrapInMarkers(content).replace(/\n/g, "\r");

    const changes = compareInstructions(expected, nativeContent, "claude-code");
    expect(changes).toEqual([]);
  });

  test("still detects genuine content drift even with CRLF endings (M13)", () => {
    const expected: Record<string, ResolvedInstruction> = {
      "ts-rules": makeInstruction({
        name: "ts-rules",
        content: "Use strict TypeScript.\nAlways.",
      }),
    };

    // Native has CRLF endings AND genuinely different text — must still drift.
    const nativeContent = wrapInMarkers("Use loose TypeScript.\nNever.").replace(/\n/g, "\r\n");

    const changes = compareInstructions(expected, nativeContent, "claude-code");
    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe("modified");
    expect(changes[0].name).toBe("_managed_block");
  });
});
