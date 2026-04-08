import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveInstructionContent,
  filterByTarget,
  generateClaudeMd,
  generateAgentsMd,
  generateCursorMdc,
  generateWindsurfRule,
  generateCopilotInstruction,
  generateKiroSteering,
} from "../../src/core/instructions";
import type { ResolvedInstruction } from "../../src/adapters/types";

// ── Helpers ─────────────────────────────────────────────────────

function makeInstruction(
  overrides: Partial<ResolvedInstruction> = {},
): ResolvedInstruction {
  return {
    name: "test-rule",
    content: "Use strict TypeScript.",
    scope: "always",
    globs: [],
    description: "Test rule",
    targets: [],
    adapters: {},
    ...overrides,
  };
}

// ── resolveInstructionContent ───────────────────────────────────

describe("resolveInstructionContent", () => {
  test("returns inline content directly", () => {
    const result = resolveInstructionContent(
      { content: "Use strict TypeScript." },
      "/unused",
    );
    expect(result).toBe("Use strict TypeScript.");
  });

  test("reads content_file relative to configDir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "am-test-"));
    writeFileSync(join(tmp, "rule.md"), "No any types allowed.");
    const result = resolveInstructionContent(
      { content_file: "rule.md" },
      tmp,
    );
    expect(result).toBe("No any types allowed.");
  });

  test("reads content_file from nested path", () => {
    const tmp = mkdtempSync(join(tmpdir(), "am-test-"));
    const { mkdirSync } = require("node:fs");
    mkdirSync(join(tmp, "instructions"), { recursive: true });
    writeFileSync(
      join(tmp, "instructions", "code-review.md"),
      "Review all PRs.",
    );
    const result = resolveInstructionContent(
      { content_file: "instructions/code-review.md" },
      tmp,
    );
    expect(result).toBe("Review all PRs.");
  });

  test("throws on missing content_file", () => {
    expect(() =>
      resolveInstructionContent(
        { content_file: "nonexistent.md" },
        "/tmp/nowhere",
      ),
    ).toThrow();
  });

  test("throws when neither content nor content_file provided", () => {
    expect(() => resolveInstructionContent({}, "/tmp")).toThrow(
      "Instruction must have either content or content_file",
    );
  });
});

// ── filterByTarget ──────────────────────────────────────────────

describe("filterByTarget", () => {
  test("includes instructions with matching target", () => {
    const instructions = {
      rule1: makeInstruction({ targets: ["claude-code", "cursor"] }),
      rule2: makeInstruction({ targets: ["windsurf"] }),
    };
    const result = filterByTarget(instructions, "claude-code");
    expect(Object.keys(result)).toEqual(["rule1"]);
  });

  test("includes instructions with no targets (empty array means all)", () => {
    const instructions = {
      universal: makeInstruction({ targets: [] }),
      specific: makeInstruction({ targets: ["cursor"] }),
    };
    const result = filterByTarget(instructions, "claude-code");
    expect(Object.keys(result)).toEqual(["universal"]);
  });

  test("returns empty when nothing matches", () => {
    const instructions = {
      rule1: makeInstruction({ targets: ["cursor"] }),
    };
    const result = filterByTarget(instructions, "windsurf");
    expect(Object.keys(result)).toEqual([]);
  });

  test("returns all when all match", () => {
    const instructions = {
      a: makeInstruction({ targets: [] }),
      b: makeInstruction({ targets: ["claude-code"] }),
    };
    const result = filterByTarget(instructions, "claude-code");
    expect(Object.keys(result)).toEqual(["a", "b"]);
  });
});

// ── generateClaudeMd ────────────────────────────────────────────

describe("generateClaudeMd", () => {
  test("generates content with am markers for single instruction", () => {
    const instructions = {
      rule1: makeInstruction({ content: "Use strict TS." }),
    };
    const result = generateClaudeMd(instructions);
    expect(result).toContain("<!-- am:begin -->");
    expect(result).toContain("Use strict TS.");
    expect(result).toContain("<!-- am:end -->");
  });

  test("concatenates multiple instructions", () => {
    const instructions = {
      rule1: makeInstruction({ content: "Rule one." }),
      rule2: makeInstruction({ content: "Rule two." }),
    };
    const result = generateClaudeMd(instructions);
    expect(result).toContain("Rule one.");
    expect(result).toContain("Rule two.");
    // Both in a single managed block
    const beginCount = (result.match(/<!-- am:begin -->/g) || []).length;
    expect(beginCount).toBe(1);
  });

  test("preserves existing content outside markers", () => {
    const existing =
      "# My Project\n\nHand-written rules.\n\n<!-- am:begin -->\nOld managed.\n<!-- am:end -->\n\nMore hand-written.";
    const instructions = {
      rule1: makeInstruction({ content: "New managed." }),
    };
    const result = generateClaudeMd(instructions, existing);
    expect(result).toContain("# My Project");
    expect(result).toContain("Hand-written rules.");
    expect(result).toContain("More hand-written.");
    expect(result).toContain("New managed.");
    expect(result).not.toContain("Old managed.");
  });

  test("appends markers to existing content without markers", () => {
    const existing = "# My Project\n\nExisting content.";
    const instructions = {
      rule1: makeInstruction({ content: "New rule." }),
    };
    const result = generateClaudeMd(instructions, existing);
    expect(result).toContain("# My Project");
    expect(result).toContain("Existing content.");
    expect(result).toContain("<!-- am:begin -->");
    expect(result).toContain("New rule.");
  });

  test("returns existing content unchanged when no instructions", () => {
    const existing = "# My Project";
    const result = generateClaudeMd({}, existing);
    expect(result).toBe("# My Project");
  });

  test("returns empty string when no instructions and no existing", () => {
    const result = generateClaudeMd({});
    expect(result).toBe("");
  });
});

// ── generateAgentsMd ────────────────────────────────────────────

describe("generateAgentsMd", () => {
  test("generates content with am markers", () => {
    const instructions = {
      rule1: makeInstruction({ content: "Agent rule." }),
    };
    const result = generateAgentsMd(instructions);
    expect(result).toContain("<!-- am:begin -->");
    expect(result).toContain("Agent rule.");
    expect(result).toContain("<!-- am:end -->");
  });

  test("preserves existing content outside markers", () => {
    const existing =
      "# Agents\n\n<!-- am:begin -->\nOld.\n<!-- am:end -->\n\nManual section.";
    const instructions = {
      rule1: makeInstruction({ content: "Updated." }),
    };
    const result = generateAgentsMd(instructions, existing);
    expect(result).toContain("# Agents");
    expect(result).toContain("Manual section.");
    expect(result).toContain("Updated.");
    expect(result).not.toContain("Old.");
  });

  test("concatenates multiple instructions", () => {
    const instructions = {
      a: makeInstruction({ content: "First." }),
      b: makeInstruction({ content: "Second." }),
    };
    const result = generateAgentsMd(instructions);
    expect(result).toContain("First.");
    expect(result).toContain("Second.");
  });
});

// ── generateCursorMdc ───────────────────────────────────────────

describe("generateCursorMdc", () => {
  test("always scope sets alwaysApply: true", () => {
    const instr = makeInstruction({ scope: "always" });
    const result = generateCursorMdc(instr);
    expect(result).toContain("alwaysApply: true");
    expect(result).toContain("Use strict TypeScript.");
    // Has YAML frontmatter delimiters
    expect(result.startsWith("---\n")).toBe(true);
  });

  test("glob scope sets alwaysApply: false and includes globs", () => {
    const instr = makeInstruction({
      scope: "glob",
      globs: ["**/*.ts", "**/*.tsx"],
    });
    const result = generateCursorMdc(instr);
    expect(result).toContain("alwaysApply: false");
    expect(result).toContain('globs: ["**/*.ts", "**/*.tsx"]');
  });

  test("includes description in frontmatter", () => {
    const instr = makeInstruction({ description: "TypeScript conventions" });
    const result = generateCursorMdc(instr);
    expect(result).toContain('description: "TypeScript conventions"');
  });

  test("agent-decision scope sets alwaysApply: false", () => {
    const instr = makeInstruction({ scope: "agent-decision" });
    const result = generateCursorMdc(instr);
    expect(result).toContain("alwaysApply: false");
  });

  test("manual scope sets alwaysApply: false", () => {
    const instr = makeInstruction({ scope: "manual" });
    const result = generateCursorMdc(instr);
    expect(result).toContain("alwaysApply: false");
  });

  test("no globs omits globs field", () => {
    const instr = makeInstruction({ scope: "always", globs: [] });
    const result = generateCursorMdc(instr);
    expect(result).not.toContain("globs:");
  });
});

// ── generateWindsurfRule ────────────────────────────────────────

describe("generateWindsurfRule", () => {
  test("always scope maps to trigger: always_on", () => {
    const instr = makeInstruction({ scope: "always" });
    const result = generateWindsurfRule(instr);
    expect(result).toContain("trigger: always_on");
    expect(result).toContain("Use strict TypeScript.");
  });

  test("glob scope maps to trigger: glob with globs", () => {
    const instr = makeInstruction({
      scope: "glob",
      globs: ["**/*.ts", "**/*.tsx"],
    });
    const result = generateWindsurfRule(instr);
    expect(result).toContain("trigger: glob");
    expect(result).toContain('globs: "**/*.ts,**/*.tsx"');
  });

  test("agent-decision scope maps to trigger: model_decision", () => {
    const instr = makeInstruction({ scope: "agent-decision" });
    const result = generateWindsurfRule(instr);
    expect(result).toContain("trigger: model_decision");
  });

  test("manual scope maps to trigger: manual", () => {
    const instr = makeInstruction({ scope: "manual" });
    const result = generateWindsurfRule(instr);
    expect(result).toContain("trigger: manual");
  });

  test("always scope does not include globs field", () => {
    const instr = makeInstruction({ scope: "always" });
    const result = generateWindsurfRule(instr);
    expect(result).not.toContain("globs:");
  });
});

// ── generateCopilotInstruction ──────────────────────────────────

describe("generateCopilotInstruction", () => {
  test("always scope produces plain content (for copilot-instructions.md)", () => {
    const instr = makeInstruction({ scope: "always" });
    const result = generateCopilotInstruction(instr);
    expect(result).toBe("Use strict TypeScript.\n");
    expect(result).not.toContain("---");
  });

  test("glob scope produces frontmatter with applyTo", () => {
    const instr = makeInstruction({
      scope: "glob",
      globs: ["**/*.ts", "**/*.tsx"],
    });
    const result = generateCopilotInstruction(instr);
    expect(result).toContain('applyTo: "**/*.ts,**/*.tsx"');
    expect(result).toContain("Use strict TypeScript.");
    expect(result.startsWith("---\n")).toBe(true);
  });

  test("agent-decision scope produces plain content", () => {
    const instr = makeInstruction({ scope: "agent-decision" });
    const result = generateCopilotInstruction(instr);
    expect(result).toBe("Use strict TypeScript.\n");
  });

  test("glob scope with empty globs produces plain content", () => {
    const instr = makeInstruction({ scope: "glob", globs: [] });
    const result = generateCopilotInstruction(instr);
    expect(result).toBe("Use strict TypeScript.\n");
  });
});

// ── generateKiroSteering ────────────────────────────────────────

describe("generateKiroSteering", () => {
  test("new file generates frontmatter with inclusion mode", () => {
    const instr = makeInstruction({
      scope: "always",
      description: "TS rules",
    });
    const result = generateKiroSteering(instr);
    expect(result).toContain("inclusion: always");
    expect(result).toContain('description: "TS rules"');
    expect(result).toContain("<!-- am:begin -->");
    expect(result).toContain("Use strict TypeScript.");
    expect(result).toContain("<!-- am:end -->");
  });

  test("agent-decision scope maps to inclusion: auto", () => {
    const instr = makeInstruction({ scope: "agent-decision" });
    const result = generateKiroSteering(instr);
    expect(result).toContain("inclusion: auto");
  });

  test("glob scope maps to inclusion: fileMatch", () => {
    const instr = makeInstruction({ scope: "glob" });
    const result = generateKiroSteering(instr);
    expect(result).toContain("inclusion: fileMatch");
  });

  test("manual scope maps to inclusion: manual", () => {
    const instr = makeInstruction({ scope: "manual" });
    const result = generateKiroSteering(instr);
    expect(result).toContain("inclusion: manual");
  });

  test("preserves existing content outside markers", () => {
    const existing =
      "---\ninclusion: always\n---\n\n<!-- am:begin -->\nOld content.\n<!-- am:end -->\n\nHand-written notes.";
    const instr = makeInstruction({ content: "New content." });
    const result = generateKiroSteering(instr, existing);
    expect(result).toContain("inclusion: always");
    expect(result).toContain("Hand-written notes.");
    expect(result).toContain("New content.");
    expect(result).not.toContain("Old content.");
  });

  test("appends markers to existing content without markers", () => {
    const existing = "---\ninclusion: always\n---\n\nSome manual content.";
    const instr = makeInstruction({ content: "Managed." });
    const result = generateKiroSteering(instr, existing);
    expect(result).toContain("Some manual content.");
    expect(result).toContain("<!-- am:begin -->");
    expect(result).toContain("Managed.");
  });
});
