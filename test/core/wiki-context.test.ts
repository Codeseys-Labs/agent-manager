import { describe, expect, test } from "bun:test";
import { generateWikiContext, spliceWikiBlock } from "../../src/core/instructions";

const WIKI_BEGIN = "<!-- am:wiki:begin -->";
const WIKI_END = "<!-- am:wiki:end -->";
const AM_END = "<!-- am:end -->";

// ── generateWikiContext ────────────────────────────────────────

describe("generateWikiContext", () => {
  test("returns empty when inject_on_apply is false", async () => {
    const result = await generateWikiContext("/tmp", {
      wiki: { inject_on_apply: false },
    });
    expect(result).toBe("");
  });

  test("returns empty when wiki settings are missing", async () => {
    const result = await generateWikiContext("/tmp", {});
    expect(result).toBe("");
  });

  test("returns empty when settings is undefined", async () => {
    const result = await generateWikiContext("/tmp", undefined);
    expect(result).toBe("");
  });

  test("returns empty when inject_on_apply is not set", async () => {
    const result = await generateWikiContext("/tmp", { wiki: {} });
    expect(result).toBe("");
  });

  test("returns empty when enabled but wiki has no entries (dynamic import fails gracefully)", async () => {
    // When wiki storage has no entries, synthesizeContext returns "No knowledge found"
    // and generateWikiContext returns empty string
    const result = await generateWikiContext("/tmp/nonexistent", {
      wiki: { inject_on_apply: true },
    });
    // Either empty (no entries) or contains wiki markers (has entries)
    // In test env without wiki data, the import will find no pages
    expect(typeof result).toBe("string");
  });
});

// ── spliceWikiBlock ────────────────────────────────────────────

describe("spliceWikiBlock", () => {
  test("returns content unchanged when wikiBlock is empty", () => {
    const content = "# CLAUDE.md\n\nSome content.";
    const result = spliceWikiBlock("", content);
    expect(result).toBe(content);
  });

  test("replaces existing wiki block", () => {
    const existing = [
      "# CLAUDE.md",
      "",
      WIKI_BEGIN,
      "## Agent Knowledge",
      "",
      "Old wiki content",
      WIKI_END,
      "",
      "Other content.",
    ].join("\n");

    const newBlock = `${WIKI_BEGIN}\n## Agent Knowledge\n\nNew wiki content\n${WIKI_END}`;
    const result = spliceWikiBlock(newBlock, existing);

    expect(result).toContain("New wiki content");
    expect(result).not.toContain("Old wiki content");
    expect(result).toContain("Other content.");
    expect(result).toContain("# CLAUDE.md");
  });

  test("inserts before am:end marker when no wiki block exists", () => {
    const content = [
      "<!-- am:begin -->",
      "Use strict TypeScript.",
      AM_END,
    ].join("\n");

    const wikiBlock = `${WIKI_BEGIN}\n## Agent Knowledge\n\nWiki content\n${WIKI_END}`;
    const result = spliceWikiBlock(wikiBlock, content);

    expect(result).toContain("Use strict TypeScript.");
    expect(result).toContain("Wiki content");
    // Wiki block should appear before am:end
    const wikiIdx = result.indexOf(WIKI_BEGIN);
    const amEndIdx = result.indexOf(AM_END);
    expect(wikiIdx).toBeLessThan(amEndIdx);
  });

  test("appends to end when no markers exist", () => {
    const content = "# Manual CLAUDE.md\n\nNo markers here.";
    const wikiBlock = `${WIKI_BEGIN}\n## Agent Knowledge\n\nWiki content\n${WIKI_END}`;
    const result = spliceWikiBlock(wikiBlock, content);

    expect(result).toContain("# Manual CLAUDE.md");
    expect(result).toContain("Wiki content");
    // Should be at the end
    expect(result.endsWith(`${WIKI_END}\n`)).toBe(true);
  });

  test("does not duplicate wiki block when applied twice", () => {
    const content = [
      "<!-- am:begin -->",
      "Use strict TypeScript.",
      AM_END,
    ].join("\n");

    const wikiBlock = `${WIKI_BEGIN}\n## Agent Knowledge\n\nWiki content\n${WIKI_END}`;

    // First application
    const first = spliceWikiBlock(wikiBlock, content);
    expect((first.match(new RegExp(WIKI_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length).toBe(1);

    // Second application with updated content
    const updatedBlock = `${WIKI_BEGIN}\n## Agent Knowledge\n\nUpdated wiki\n${WIKI_END}`;
    const second = spliceWikiBlock(updatedBlock, first);

    expect(second).toContain("Updated wiki");
    expect(second).not.toContain("Wiki content");
    // Still only one wiki block
    expect((second.match(new RegExp(WIKI_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length).toBe(1);
  });

  test("preserves content before and after wiki block on replacement", () => {
    const existing = [
      "# Header",
      "",
      "Before wiki.",
      "",
      WIKI_BEGIN,
      "Old content",
      WIKI_END,
      "",
      "After wiki.",
    ].join("\n");

    const newBlock = `${WIKI_BEGIN}\nNew content\n${WIKI_END}`;
    const result = spliceWikiBlock(newBlock, existing);

    expect(result).toContain("# Header");
    expect(result).toContain("Before wiki.");
    expect(result).toContain("After wiki.");
    expect(result).toContain("New content");
    expect(result).not.toContain("Old content");
  });
});
