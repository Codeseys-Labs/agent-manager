import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createProjectWikiLink,
  deletePage,
  ensureWikiDirs,
  getProjectWikiDir,
  listPages,
  parseFrontmatter,
  readPage,
  rebuildSearchIndex,
  resolveProjectName,
  searchPages,
  serializeFrontmatter,
  wikiLinkMatchesTarget,
  writePage,
} from "../../src/wiki/storage";
import type { WikiPage } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ── Helpers ─────────────────────────────────────────────────────

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date().toISOString();
  return {
    slug: "test-page",
    title: "Test Page",
    type: "entity",
    content: "This is a test page about TypeScript configuration.",
    tags: ["test", "typescript"],
    sources: ["session-123"],
    backlinks: ["other-page"],
    created: now,
    updated: now,
    confidence: 0.85,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("wiki/storage", () => {
  let tmp: TestDir;
  let wikiDir: string;

  beforeEach(async () => {
    tmp = await createTestDir("wiki-storage-");
    wikiDir = join(tmp.path, "wiki");
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  // ── ensureWikiDirs ──────────────────────────────────────────

  describe("ensureWikiDirs", () => {
    test("creates all subdirectories", async () => {
      await ensureWikiDirs(wikiDir);

      for (const sub of ["entities", "concepts", "summaries", "synthesis", "decisions", "raw"]) {
        const exists = await Bun.file(join(wikiDir, sub)).exists();
        // Check directory existence via readdir
        const stat = await Bun.file(join(wikiDir, sub, ".")).exists();
        // Use a more reliable directory existence check
        try {
          const { readdir } = await import("node:fs/promises");
          await readdir(join(wikiDir, sub));
        } catch {
          throw new Error(`Subdirectory '${sub}' was not created`);
        }
      }
    });
  });

  // ── writePage + readPage roundtrip ──────────────────────────

  describe("writePage + readPage", () => {
    test("roundtrip preserves all fields", async () => {
      const page = makePage();
      await writePage(page, wikiDir);
      const loaded = await readPage("test-page", wikiDir);

      expect(loaded).not.toBeNull();
      expect(loaded!.slug).toBe(page.slug);
      expect(loaded!.title).toBe(page.title);
      expect(loaded!.type).toBe(page.type);
      expect(loaded!.content).toBe(page.content);
      expect(loaded!.tags).toEqual(page.tags);
      expect(loaded!.sources).toEqual(page.sources);
      expect(loaded!.backlinks).toEqual(page.backlinks);
      expect(loaded!.created).toBe(page.created);
      expect(loaded!.updated).toBe(page.updated);
      // ADR-0054 R4: confidence is now the low|medium|high enum. A legacy
      // numeric input (0.85) is normalised to its bucket ("high") on write and
      // reads back as the enum, never as the original number.
      expect(loaded!.confidence).toBe("high");
    });

    test("roundtrip works for pages with empty arrays", async () => {
      const page = makePage({ tags: [], sources: [], backlinks: [] });
      await writePage(page, wikiDir);
      const loaded = await readPage("test-page", wikiDir);

      expect(loaded).not.toBeNull();
      expect(loaded!.tags).toEqual([]);
      expect(loaded!.sources).toEqual([]);
      expect(loaded!.backlinks).toEqual([]);
    });

    test("roundtrip works for pages without confidence", async () => {
      const page = makePage({ confidence: undefined });
      await writePage(page, wikiDir);
      const loaded = await readPage("test-page", wikiDir);

      expect(loaded).not.toBeNull();
      expect(loaded!.confidence).toBeUndefined();
    });
  });

  // ── readPage non-existent ───────────────────────────────────

  describe("readPage", () => {
    test("returns null for non-existent slug", async () => {
      await ensureWikiDirs(wikiDir);
      const result = await readPage("does-not-exist", wikiDir);
      expect(result).toBeNull();
    });
  });

  // ── deletePage ──────────────────────────────────────────────

  describe("deletePage", () => {
    test("removes file and returns true", async () => {
      const page = makePage();
      await writePage(page, wikiDir);
      const result = await deletePage("test-page", wikiDir);
      expect(result).toBe(true);

      const loaded = await readPage("test-page", wikiDir);
      expect(loaded).toBeNull();
    });

    test("returns false for missing slug", async () => {
      await ensureWikiDirs(wikiDir);
      const result = await deletePage("nonexistent", wikiDir);
      expect(result).toBe(false);
    });
  });

  // ── listPages ───────────────────────────────────────────────

  describe("listPages", () => {
    test("returns all pages", async () => {
      await writePage(makePage({ slug: "page-a", title: "Page A" }), wikiDir);
      await writePage(makePage({ slug: "page-b", title: "Page B", type: "concept" }), wikiDir);
      await writePage(makePage({ slug: "page-c", title: "Page C", type: "summary" }), wikiDir);

      const pages = await listPages({ wikiDir });
      expect(pages.length).toBe(3);
      const slugs = pages.map((p) => p.slug).sort();
      expect(slugs).toEqual(["page-a", "page-b", "page-c"]);
    });

    test("filter by type works", async () => {
      await writePage(makePage({ slug: "entity-1", type: "entity" }), wikiDir);
      await writePage(makePage({ slug: "concept-1", type: "concept" }), wikiDir);
      await writePage(makePage({ slug: "entity-2", type: "entity" }), wikiDir);

      const entities = await listPages({ type: "entity", wikiDir });
      expect(entities.length).toBe(2);
      expect(entities.every((p) => p.type === "entity")).toBe(true);
    });

    test("returns empty array when no pages exist", async () => {
      await ensureWikiDirs(wikiDir);
      const pages = await listPages({ wikiDir });
      expect(pages).toEqual([]);
    });
  });

  // ── searchPages ─────────────────────────────────────────────

  describe("searchPages", () => {
    test("returns results ranked by BM25 relevance", async () => {
      await writePage(
        makePage({
          slug: "ts-config",
          title: "TypeScript Configuration",
          content: "TypeScript compiler options and tsconfig.json settings for the project.",
          tags: ["typescript", "config"],
        }),
        wikiDir,
      );
      await writePage(
        makePage({
          slug: "python-setup",
          title: "Python Setup",
          content: "How to set up Python virtual environments and pip.",
          tags: ["python", "setup"],
        }),
        wikiDir,
      );
      await writePage(
        makePage({
          slug: "ts-patterns",
          title: "TypeScript Patterns",
          content: "Common TypeScript design patterns and best practices.",
          tags: ["typescript", "patterns"],
        }),
        wikiDir,
      );

      await rebuildSearchIndex(wikiDir);
      const results = await searchPages("TypeScript", 10, wikiDir);

      expect(results.length).toBeGreaterThanOrEqual(1);
      // TypeScript pages should rank higher
      const slugs = results.map((r) => r.page.slug);
      expect(slugs).toContain("ts-config");
      expect(slugs).toContain("ts-patterns");
      // Score should be positive
      expect(results[0].score).toBeGreaterThan(0);
    });

    test("returns empty for empty query", async () => {
      const results = await searchPages("", 10, wikiDir);
      expect(results).toEqual([]);
    });
  });

  // ── rebuildSearchIndex ──────────────────────────────────────

  describe("rebuildSearchIndex", () => {
    test("rebuilds from disk", async () => {
      await writePage(
        makePage({
          slug: "index-test",
          title: "Index Test",
          content: "Unique searchable content about widgets.",
        }),
        wikiDir,
      );

      await rebuildSearchIndex(wikiDir);
      const results = await searchPages("widgets", 10, wikiDir);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].page.slug).toBe("index-test");
    });
  });

  // ── createProjectWikiLink (symlink system) ──────────────────

  describe("createProjectWikiLink", () => {
    test("creates symlink from project dir to central wiki", async () => {
      const { lstatSync, readlinkSync, existsSync, mkdirSync } = await import("node:fs");

      // Set AM_CONFIG_DIR so getProjectWikiDir resolves to our tmp
      const origEnv = process.env.AM_CONFIG_DIR;
      process.env.AM_CONFIG_DIR = tmp.path;
      try {
        const projectDir = join(tmp.path, "my-project");
        mkdirSync(projectDir, { recursive: true });

        createProjectWikiLink(projectDir, "my-project");

        const wikiLink = join(projectDir, ".agent-manager", "wiki");
        expect(existsSync(wikiLink)).toBe(true);

        const stat = lstatSync(wikiLink);
        expect(stat.isSymbolicLink()).toBe(true);

        const target = readlinkSync(wikiLink);
        expect(target).toBe(getProjectWikiDir("my-project"));
      } finally {
        process.env.AM_CONFIG_DIR = origEnv;
      }
    });

    test("idempotent — calling twice does not error", async () => {
      const { existsSync, mkdirSync } = await import("node:fs");

      const origEnv = process.env.AM_CONFIG_DIR;
      process.env.AM_CONFIG_DIR = tmp.path;
      try {
        const projectDir = join(tmp.path, "idempotent-proj");
        mkdirSync(projectDir, { recursive: true });

        createProjectWikiLink(projectDir, "idempotent-proj");
        createProjectWikiLink(projectDir, "idempotent-proj"); // second call

        const wikiLink = join(projectDir, ".agent-manager", "wiki");
        expect(existsSync(wikiLink)).toBe(true);
      } finally {
        process.env.AM_CONFIG_DIR = origEnv;
      }
    });

    // L10: the second call must short-circuit (not tear down + recreate) when
    // the link is already correct. Verify by capturing the link inode before
    // the second call and asserting it is unchanged afterward — a recreate
    // would change it.
    test("idempotent call does not recreate an already-correct link", async () => {
      const { existsSync, mkdirSync, lstatSync } = await import("node:fs");

      const origEnv = process.env.AM_CONFIG_DIR;
      process.env.AM_CONFIG_DIR = tmp.path;
      try {
        const projectDir = join(tmp.path, "no-churn-proj");
        mkdirSync(projectDir, { recursive: true });

        createProjectWikiLink(projectDir, "no-churn-proj");
        const wikiLink = join(projectDir, ".agent-manager", "wiki");
        expect(existsSync(wikiLink)).toBe(true);
        const inoBefore = lstatSync(wikiLink).ino;

        createProjectWikiLink(projectDir, "no-churn-proj"); // second call
        const inoAfter = lstatSync(wikiLink).ino;
        // On POSIX a recreated symlink gets a fresh inode; an unchanged link
        // keeps the same one. (On win32 ino is 0/unstable — see the
        // win32-guarded test below for the real-path no-op assertion.)
        if (process.platform !== "win32") {
          expect(inoAfter).toBe(inoBefore);
        }
      } finally {
        process.env.AM_CONFIG_DIR = origEnv;
      }
    });
  });

  // ── wikiLinkMatchesTarget (L10 — Windows junction fast-path) ──
  //
  // The fast-path that short-circuits createProjectWikiLink must fire when the
  // link is already correct. On win32 the link is a junction whose readlink
  // target is a fully-resolved (`\\?\`-prefixed, re-cased) path that never
  // string-equals the join()-built target — so the comparison must go through
  // realpathSync on BOTH sides on win32, while POSIX keeps plain string
  // equality. `platform` is injectable so the win32 branch is exercised here on
  // a POSIX host.

  describe("wikiLinkMatchesTarget", () => {
    test("POSIX: true when the symlink target string-equals the target", async () => {
      const { symlinkSync, mkdirSync } = await import("node:fs");

      const target = join(tmp.path, "central-wiki");
      mkdirSync(target, { recursive: true });
      const link = join(tmp.path, "link-correct");
      symlinkSync(target, link);

      expect(wikiLinkMatchesTarget(link, target, "linux")).toBe(true);
    });

    test("POSIX: false when the symlink points elsewhere", async () => {
      const { symlinkSync, mkdirSync } = await import("node:fs");

      const target = join(tmp.path, "central-wiki-2");
      const other = join(tmp.path, "some-other-dir");
      mkdirSync(target, { recursive: true });
      mkdirSync(other, { recursive: true });
      const link = join(tmp.path, "link-wrong");
      symlinkSync(other, link);

      expect(wikiLinkMatchesTarget(link, target, "linux")).toBe(false);
    });

    test("POSIX: false when the path is a plain directory, not a link", async () => {
      const { mkdirSync } = await import("node:fs");

      const target = join(tmp.path, "central-wiki-3");
      const plainDir = join(tmp.path, "plain-dir");
      mkdirSync(target, { recursive: true });
      mkdirSync(plainDir, { recursive: true });

      expect(wikiLinkMatchesTarget(plainDir, target, "linux")).toBe(false);
    });

    test("false when the link does not exist", async () => {
      const missing = join(tmp.path, "does-not-exist");
      const target = join(tmp.path, "central-wiki-4");
      expect(wikiLinkMatchesTarget(missing, target, "linux")).toBe(false);
      expect(wikiLinkMatchesTarget(missing, target, "win32")).toBe(false);
    });

    test("win32 branch: matches via realpath even when the readlink target string differs", async () => {
      // This is the core L10 regression. Simulate the Windows junction reality
      // on a POSIX host: the link's readlink target is NOT byte-equal to the
      // join()-built `target` we pass in (here: the same dir reached via a
      // trailing separator), yet realpathSync resolves both to the same inode.
      // Plain string equality (the old code) would FAIL this; the win32 realpath
      // comparison must PASS it.
      const { symlinkSync, mkdirSync } = await import("node:fs");
      const { sep } = await import("node:path");

      const target = join(tmp.path, "central-wiki-win");
      mkdirSync(target, { recursive: true });

      const link = join(tmp.path, "link-win");
      // Point the link at a string that resolves to `target` but is not byte
      // equal to it — mirrors a junction's normalised readlink output. A raw
      // trailing separator survives readlink verbatim (join() would strip it).
      const nonNormalizedTarget = `${target}${sep}`;
      symlinkSync(nonNormalizedTarget, link);

      // Sanity: the raw readlink target differs from `target` (so the POSIX
      // string-equality path would reject it)…
      const { readlinkSync } = await import("node:fs");
      expect(readlinkSync(link)).not.toBe(target);
      expect(wikiLinkMatchesTarget(link, target, "linux")).toBe(false);

      // …but the win32 realpath-based comparison treats it as already-correct.
      expect(wikiLinkMatchesTarget(link, target, "win32")).toBe(true);
    });

    test("win32 branch: false when the link resolves to a different inode", async () => {
      const { symlinkSync, mkdirSync } = await import("node:fs");

      const target = join(tmp.path, "central-wiki-win-2");
      const other = join(tmp.path, "other-win-2");
      mkdirSync(target, { recursive: true });
      mkdirSync(other, { recursive: true });

      const link = join(tmp.path, "link-win-2");
      symlinkSync(other, link);

      expect(wikiLinkMatchesTarget(link, target, "win32")).toBe(false);
    });
  });

  // ── resolveProjectName ──────────────────────────────────────

  describe("resolveProjectName", () => {
    test("falls back to directory basename when no git", () => {
      const name = resolveProjectName(join(tmp.path, "my-cool-app"));
      expect(name).toBe("my-cool-app");
    });
  });

  // ── parseFrontmatter + serializeFrontmatter roundtrip ───────

  describe("parseFrontmatter + serializeFrontmatter", () => {
    test("roundtrip preserves metadata and body", () => {
      const metadata = {
        title: "My Page",
        type: "entity",
        slug: "my-page",
        tags: ["alpha", "beta"],
        confidence: 0.9,
        enabled: true,
      };
      const body = "This is the body content.\n\nWith multiple paragraphs.";

      const serialized = serializeFrontmatter(metadata, body);
      const parsed = parseFrontmatter(serialized);

      expect(parsed.metadata.title).toBe("My Page");
      expect(parsed.metadata.type).toBe("entity");
      expect(parsed.metadata.slug).toBe("my-page");
      expect(parsed.metadata.tags).toEqual(["alpha", "beta"]);
      expect(parsed.metadata.confidence).toBe(0.9);
      expect(parsed.metadata.enabled).toBe(true);
      expect(parsed.body).toBe(body);
    });

    test("parseFrontmatter returns empty metadata for content without frontmatter", () => {
      const content = "Just plain content with no frontmatter.";
      const parsed = parseFrontmatter(content);
      expect(parsed.metadata).toEqual({});
      expect(parsed.body).toBe(content);
    });

    test("handles empty arrays", () => {
      const metadata = { tags: [] as string[] };
      const body = "Content here.";
      const serialized = serializeFrontmatter(metadata, body);
      const parsed = parseFrontmatter(serialized);
      expect(parsed.metadata.tags).toEqual([]);
    });
  });
});
