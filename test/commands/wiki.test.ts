import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  deletePage,
  ensureWikiDirs,
  getAllEntries,
  listPages,
  readPage,
  rebuildSearchIndex,
  searchPages,
  writePage,
} from "../../src/wiki/storage";
import type { WikiPage } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// Capture console output
let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const origLog = console.log;
const origError = console.error;

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date().toISOString();
  return {
    slug: "test-page",
    title: "Test Page",
    type: "entity",
    content: "This is test content about TypeScript patterns.",
    tags: ["test", "typescript"],
    sources: [],
    backlinks: [],
    created: now,
    updated: now,
    confidence: 0.8,
    ...overrides,
  };
}

describe("am wiki", () => {
  let dir: TestDir;
  let wikiDir: string;

  beforeEach(async () => {
    consoleOutput = [];
    consoleErrors = [];
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    process.exitCode = undefined;

    dir = await createTestDir("am-wiki-");
    wikiDir = join(dir.path, "wiki");
    await ensureWikiDirs(wikiDir);
  });

  afterEach(async () => {
    console.log = origLog;
    console.error = origError;
    process.exitCode = undefined;
    if (dir) await dir.cleanup();
  });

  // ── init subcommand ────────────────────────────────────────────

  test("init creates wiki directory structure", async () => {
    const newWikiDir = join(dir.path, "new-wiki");
    await ensureWikiDirs(newWikiDir);

    // Check subdirectories exist (use existsSync since Bun.file doesn't work for dirs)
    expect(existsSync(join(dir.path, "new-wiki", "entities"))).toBe(true);
    expect(existsSync(join(dir.path, "new-wiki", "concepts"))).toBe(true);
    expect(existsSync(join(dir.path, "new-wiki", "summaries"))).toBe(true);
    expect(existsSync(join(dir.path, "new-wiki", "synthesis"))).toBe(true);
    expect(existsSync(join(dir.path, "new-wiki", "decisions"))).toBe(true);
    expect(existsSync(join(dir.path, "new-wiki", "raw"))).toBe(true);
  });

  // ── add / write page ──────────────────────────────────────────

  test("add creates a wiki page file", async () => {
    const page = makePage({ slug: "my-fact", type: "entity", title: "My Fact" });
    await writePage(page, wikiDir);

    // Page should exist on disk
    const filePath = join(wikiDir, "entities", "my-fact.md");
    const content = await Bun.file(filePath).text();
    expect(content).toContain("title: My Fact");
    expect(content).toContain("type: entity");
    expect(content).toContain("slug: my-fact");
    expect(content).toContain("This is test content");
  });

  // ── show / read page ──────────────────────────────────────────

  test("show reads and returns a page", async () => {
    const page = makePage({
      slug: "show-test",
      type: "concept",
      title: "Concept Page",
      content: "Some content about concepts.",
    });
    await writePage(page, wikiDir);

    const result = await readPage("show-test", wikiDir);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("show-test");
    expect(result!.title).toBe("Concept Page");
    expect(result!.type).toBe("concept");
    expect(result!.content).toContain("Some content about concepts");
    expect(result!.tags).toEqual(["test", "typescript"]);
  });

  test("show returns null for non-existent page", async () => {
    const result = await readPage("does-not-exist", wikiDir);
    expect(result).toBeNull();
  });

  // ── delete subcommand ─────────────────────────────────────────

  test("delete removes a page", async () => {
    const page = makePage({ slug: "delete-me", type: "entity" });
    await writePage(page, wikiDir);

    // Verify it exists
    const before = await readPage("delete-me", wikiDir);
    expect(before).not.toBeNull();

    // Delete it
    const deleted = await deletePage("delete-me", wikiDir);
    expect(deleted).toBe(true);

    // Verify it's gone
    const after = await readPage("delete-me", wikiDir);
    expect(after).toBeNull();
  });

  test("delete returns false for non-existent page", async () => {
    const deleted = await deletePage("nonexistent", wikiDir);
    expect(deleted).toBe(false);
  });

  // ── search subcommand ─────────────────────────────────────────

  test("search returns results from MiniSearch", async () => {
    // Add several pages
    const page1 = makePage({
      slug: "typescript-patterns",
      type: "entity",
      title: "TypeScript Design Patterns",
      content: "TypeScript singleton pattern implementation guide.",
      tags: ["typescript", "design-patterns"],
    });
    const page2 = makePage({
      slug: "python-guide",
      type: "entity",
      title: "Python Guide",
      content: "Python programming basics.",
      tags: ["python"],
    });
    const page3 = makePage({
      slug: "ts-generics",
      type: "concept",
      title: "TypeScript Generics",
      content: "Using generics in TypeScript for type-safe code.",
      tags: ["typescript", "generics"],
    });

    await writePage(page1, wikiDir);
    await writePage(page2, wikiDir);
    await writePage(page3, wikiDir);

    // Rebuild the search index
    await rebuildSearchIndex(wikiDir);

    // Search for TypeScript
    const results = await searchPages("TypeScript", 10, wikiDir);
    expect(results.length).toBeGreaterThanOrEqual(2);

    const slugs = results.map((r) => r.page.slug);
    expect(slugs).toContain("typescript-patterns");
    expect(slugs).toContain("ts-generics");

    // Each result should have a score
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });

  test("search returns empty for no matches", async () => {
    await rebuildSearchIndex(wikiDir);
    const results = await searchPages("zzz-nonexistent-query", 10, wikiDir);
    expect(results).toEqual([]);
  });

  // ── export subcommand ─────────────────────────────────────────

  test("export returns all pages as data", async () => {
    const page1 = makePage({ slug: "export-1", type: "entity", title: "Export One" });
    const page2 = makePage({ slug: "export-2", type: "concept", title: "Export Two" });

    await writePage(page1, wikiDir);
    await writePage(page2, wikiDir);

    const pages = await listPages({ wikiDir });
    expect(pages.length).toBe(2);

    const slugs = pages.map((p) => p.slug);
    expect(slugs).toContain("export-1");
    expect(slugs).toContain("export-2");
  });

  // ── roundtrip: write, read, list, delete ──────────────────────

  test("full page lifecycle: write, read, list, delete", async () => {
    const page = makePage({
      slug: "lifecycle-test",
      type: "decision",
      title: "Architecture Decision",
      content: "We decided to use Bun for the runtime.",
      tags: ["architecture", "bun"],
    });

    // Write
    await writePage(page, wikiDir);

    // Read
    const read = await readPage("lifecycle-test", wikiDir);
    expect(read).not.toBeNull();
    expect(read!.title).toBe("Architecture Decision");

    // List
    const pages = await listPages({ wikiDir });
    expect(pages.some((p) => p.slug === "lifecycle-test")).toBe(true);

    // Delete
    await deletePage("lifecycle-test", wikiDir);
    const afterDelete = await readPage("lifecycle-test", wikiDir);
    expect(afterDelete).toBeNull();
  });

  test("pages can be filtered by type", async () => {
    await writePage(makePage({ slug: "entity-1", type: "entity", title: "E1" }), wikiDir);
    await writePage(makePage({ slug: "concept-1", type: "concept", title: "C1" }), wikiDir);
    await writePage(makePage({ slug: "entity-2", type: "entity", title: "E2" }), wikiDir);

    const entities = await listPages({ type: "entity", wikiDir });
    expect(entities.length).toBe(2);
    expect(entities.every((p) => p.type === "entity")).toBe(true);

    const concepts = await listPages({ type: "concept", wikiDir });
    expect(concepts.length).toBe(1);
    expect(concepts[0].slug).toBe("concept-1");
  });
});
