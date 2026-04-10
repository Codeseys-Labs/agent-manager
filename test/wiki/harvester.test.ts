import { describe, expect, test } from "bun:test";
import type { Message, Session, ToolCall } from "../../src/core/session";
import { harvestSession, stringSimilarity } from "../../src/wiki/harvester";

// ── Helpers ─────────────────────────────────────────────────────

function makeSession(messages: Message[], adapter = "test-adapter"): Session {
  return {
    id: "session-001",
    adapter,
    messages,
    startedAt: new Date(),
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("wiki/harvester", () => {
  // ── stringSimilarity ────────────────────────────────────────

  describe("stringSimilarity", () => {
    test("returns 1.0 for identical strings", () => {
      const result = stringSimilarity("hello world", "hello world");
      expect(result).toBe(1.0);
    });

    test("returns 0.0 for completely different strings", () => {
      const result = stringSimilarity("apple banana cherry", "xyz uvw rst");
      expect(result).toBe(0.0);
    });

    test("returns >0.8 for near-duplicates", () => {
      // 9 shared tokens out of 10 unique => Jaccard = 9/10 = 0.9
      const a = "the TypeScript project configuration uses strict mode for all source files";
      const b = "the TypeScript project configuration uses strict mode for all test files";
      const result = stringSimilarity(a, b);
      expect(result).toBeGreaterThan(0.8);
    });

    test("returns 1.0 for two empty strings", () => {
      const result = stringSimilarity("", "");
      expect(result).toBe(1.0);
    });

    test("returns 0.0 when one string is empty", () => {
      expect(stringSimilarity("hello", "")).toBe(0.0);
      expect(stringSimilarity("", "hello")).toBe(0.0);
    });

    test("is symmetric", () => {
      const a = "foo bar baz qux";
      const b = "bar baz qux quux";
      expect(stringSimilarity(a, b)).toBe(stringSimilarity(b, a));
    });
  });

  // ── harvestSession ──────────────────────────────────────────

  describe("harvestSession", () => {
    test("extracts entries from a session with tool calls", async () => {
      const messages: Message[] = [
        {
          role: "user",
          content: "Fix the TypeScript error in the build output.",
        },
        {
          role: "assistant",
          content: "I'll look at the error and fix it.",
          toolCalls: [
            {
              name: "bash",
              input: "bun run build",
              output: "error TS2345: Argument of type string is not assignable to parameter",
            },
          ],
        },
        {
          role: "assistant",
          content:
            "The error was in the type assertion. I've fixed it by updating the parameter type.",
        },
      ];

      const session = makeSession(messages);
      const entries = await harvestSession(session);

      expect(entries.length).toBeGreaterThan(0);
      // Should have extracted at least a procedure entry from the tool call
      const hasToolEntry = entries.some(
        (e) => e.entity_type === "procedure" || e.entity_type === "capability",
      );
      expect(hasToolEntry).toBe(true);
    });

    test("handles empty session", async () => {
      const session = makeSession([]);
      const entries = await harvestSession(session);
      expect(entries).toEqual([]);
    });

    test("extracts error-resolution pairs", async () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: "Running the build...",
          toolCalls: [{ name: "bash", input: "bun build", output: "ENOENT: file not found" }],
        },
        {
          role: "assistant",
          content:
            "The error occurred because the file was missing. I created it and the build succeeded.",
        },
      ];

      const session = makeSession(messages);
      const entries = await harvestSession(session);

      // Should extract at least a procedure from the tool call and
      // potentially an error fact or resolution
      expect(entries.length).toBeGreaterThan(0);
    });

    test("extracts user preferences from correction patterns", async () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: "I'll use var declarations for the variables.",
        },
        {
          role: "user",
          content: "No, actually please use const instead of var for all variable declarations.",
        },
      ];

      const session = makeSession(messages);
      const entries = await harvestSession(session);

      const preferences = entries.filter((e) => e.entity_type === "preference");
      expect(preferences.length).toBeGreaterThanOrEqual(1);
    });
  });
});
