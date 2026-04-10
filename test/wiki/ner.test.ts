import { describe, expect, test } from "bun:test";
import { entityToSlug, extractEntities, generateWikilinks } from "../../src/wiki/ner";

describe("wiki/ner", () => {
  // ── extractEntities ─────────────────────────────────────────

  describe("extractEntities", () => {
    test("extracts file paths from text", () => {
      const text = "Check the file src/adapters/types.ts for the interface definition.";
      const entities = extractEntities(text);
      const filePaths = entities.filter((e) => e.type === "file_path");
      expect(filePaths.length).toBeGreaterThanOrEqual(1);
      expect(filePaths.some((e) => e.text.includes("src/adapters/types.ts"))).toBe(true);
    });

    test("extracts package names (@scope/pkg)", () => {
      const text = "Install @iarna/toml and @clack/prompts for the project.";
      const entities = extractEntities(text);
      const packages = entities.filter((e) => e.type === "package_name");
      expect(packages.length).toBeGreaterThanOrEqual(2);
      expect(packages.some((e) => e.text === "@iarna/toml")).toBe(true);
      expect(packages.some((e) => e.text === "@clack/prompts")).toBe(true);
    });

    test("extracts function names (camelCase with parens)", () => {
      const text = "Call buildResolvedConfig() to merge profiles, then detectAdapter() runs.";
      const entities = extractEntities(text);
      const fns = entities.filter((e) => e.type === "function_name");
      expect(fns.length).toBeGreaterThanOrEqual(2);
      expect(fns.some((e) => e.text.includes("buildResolvedConfig"))).toBe(true);
      expect(fns.some((e) => e.text.includes("detectAdapter"))).toBe(true);
    });

    test("extracts CLI commands (am apply --dry-run)", () => {
      const text = "Run am apply --dry-run to preview changes, then bun test to verify.";
      const entities = extractEntities(text);
      const cmds = entities.filter((e) => e.type === "cli_command");
      expect(cmds.length).toBeGreaterThanOrEqual(1);
      expect(cmds.some((e) => e.text.includes("am apply"))).toBe(true);
    });

    test("extracts URLs", () => {
      const text = "See https://zod.dev/docs for validation and https://bun.sh for runtime.";
      const entities = extractEntities(text);
      const urls = entities.filter((e) => e.type === "url");
      expect(urls.length).toBeGreaterThanOrEqual(2);
      expect(urls.some((e) => e.text.includes("https://zod.dev"))).toBe(true);
      expect(urls.some((e) => e.text.includes("https://bun.sh"))).toBe(true);
    });

    test("extracts known tool names (Claude Code, Cursor, etc.)", () => {
      const text = "We support Claude Code, Cursor, and Kilo Code as IDE adapters.";
      const entities = extractEntities(text);
      const tools = entities.filter((e) => e.type === "tool_name");
      expect(tools.length).toBeGreaterThanOrEqual(3);
      expect(tools.some((e) => e.text === "Claude Code")).toBe(true);
      expect(tools.some((e) => e.text === "Cursor")).toBe(true);
      expect(tools.some((e) => e.text === "Kilo Code")).toBe(true);
    });

    test("returns empty array for empty string", () => {
      const entities = extractEntities("");
      expect(entities).toEqual([]);
    });

    test("deduplicates overlapping spans", () => {
      // The URL contains a file-path-like structure; deduplication should handle it
      const text = "See https://github.com/owner/repo/blob/main/src/index.ts for details.";
      const entities = extractEntities(text);
      // Count how many entities claim the same start position
      const starts = entities.map((e) => e.span[0]);
      const uniqueStarts = new Set(starts);
      // Each unique start should appear at most twice (different types)
      for (const start of uniqueStarts) {
        const atStart = entities.filter((e) => e.span[0] === start);
        // Deduplication should limit overlapping spans
        expect(atStart.length).toBeLessThanOrEqual(3);
      }
    });
  });

  // ── entityToSlug ────────────────────────────────────────────

  describe("entityToSlug", () => {
    test("converts names to URL-safe slugs", () => {
      expect(entityToSlug("Claude Code")).toBe("claude-code");
      expect(entityToSlug("buildResolvedConfig()")).toBe("buildresolvedconfig");
      expect(entityToSlug("@iarna/toml")).toBe("iarna-toml");
      expect(entityToSlug("src/adapters/types.ts")).toBe("src-adapters-types-ts");
      expect(entityToSlug("TypeScript")).toBe("typescript");
    });

    test("strips leading and trailing hyphens", () => {
      expect(entityToSlug("--test--")).toBe("test");
      expect(entityToSlug("@scope/pkg")).toBe("scope-pkg");
    });

    test("lowercases everything", () => {
      expect(entityToSlug("MyComponent")).toBe("mycomponent");
    });
  });

  // ── generateWikilinks ───────────────────────────────────────

  describe("generateWikilinks", () => {
    test("wraps known entities in [[...]]", () => {
      const text = "We use Claude Code for development.";
      const knownSlugs = new Set(["claude-code"]);
      const result = generateWikilinks(text, knownSlugs);
      expect(result).toContain("[[Claude Code]]");
    });

    test("does not wrap unknown entities", () => {
      const text = "We use Cursor for development.";
      const knownSlugs = new Set(["nonexistent-slug"]);
      const result = generateWikilinks(text, knownSlugs);
      expect(result).not.toContain("[[");
    });

    test("returns text unchanged when no known slugs", () => {
      const text = "Some text with Claude Code mentioned.";
      const knownSlugs = new Set<string>();
      const result = generateWikilinks(text, knownSlugs);
      expect(result).toBe(text);
    });

    test("only links first occurrence of each entity", () => {
      const text = "Cursor is great. I love Cursor.";
      const knownSlugs = new Set(["cursor"]);
      const result = generateWikilinks(text, knownSlugs);
      const matches = result.match(/\[\[Cursor\]\]/g);
      expect(matches?.length).toBe(1);
    });
  });
});
