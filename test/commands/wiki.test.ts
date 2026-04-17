import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  listSubcommand,
  pathSubcommand,
  searchSubcommand,
  showSubcommand,
} from "../../src/commands/wiki";
import {
  deletePage,
  ensureWikiDirs,
  getAllEntries,
  listPages,
  readPage,
  rebuildSearchIndex,
  resolveWikiDir,
  searchPages,
  writePage,
} from "../../src/wiki/storage";
import type { WikiPage } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// Capture console output (commands emit via info/output)
let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const origLog = console.log;
const origError = console.error;
const origConfigDir = process.env.AM_CONFIG_DIR;

function captureConsole(): void {
  consoleOutput = [];
  consoleErrors = [];
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
}

function restoreConsole(): void {
  console.log = origLog;
  console.error = origError;
}

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

// ── Storage-level tests (pre-existing, unchanged coverage) ──────

describe("am wiki: storage primitives", () => {
  let dir: TestDir;
  let wikiDir: string;

  beforeEach(async () => {
    dir = await createTestDir("am-wiki-");
    wikiDir = join(dir.path, "wiki");
    await ensureWikiDirs(wikiDir);
  });

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("ensureWikiDirs creates the expected subdirectory layout", () => {
    expect(existsSync(join(wikiDir, "entities"))).toBe(true);
    expect(existsSync(join(wikiDir, "concepts"))).toBe(true);
    expect(existsSync(join(wikiDir, "summaries"))).toBe(true);
    expect(existsSync(join(wikiDir, "synthesis"))).toBe(true);
    expect(existsSync(join(wikiDir, "decisions"))).toBe(true);
    expect(existsSync(join(wikiDir, "raw"))).toBe(true);
  });

  test("writePage + readPage roundtrip preserves frontmatter", async () => {
    const page = makePage({ slug: "rt", type: "concept", title: "Round Trip" });
    await writePage(page, wikiDir);
    const back = await readPage("rt", wikiDir);
    expect(back).not.toBeNull();
    expect(back!.slug).toBe("rt");
    expect(back!.title).toBe("Round Trip");
    expect(back!.type).toBe("concept");
  });
});

// ── Command-level tests (am wiki list/show/search/path) ─────────

describe("am wiki: list/show/search/path commands", () => {
  let dir: TestDir;
  let configDir: string;
  let wikiDir: string;

  beforeEach(async () => {
    dir = await createTestDir("am-wiki-cmd-");
    configDir = dir.path;
    // Point resolveConfigDir (and therefore the global wiki) at our tmpdir.
    process.env.AM_CONFIG_DIR = configDir;
    wikiDir = resolveWikiDir({ global: true });
    await ensureWikiDirs(wikiDir);
    captureConsole();
    process.exitCode = undefined;
  });

  afterEach(async () => {
    restoreConsole();
    process.exitCode = undefined;
    // Restore AM_CONFIG_DIR to its original value (or clear it).
    // We can't assign `undefined` because Node coerces it to the string
    // "undefined", which would leak into other tests resolving configDir.
    if (origConfigDir === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = origConfigDir;
    }
    if (dir) await dir.cleanup();
  });

  async function seed(): Promise<void> {
    await writePage(
      makePage({
        slug: "typescript-patterns",
        type: "entity",
        title: "TypeScript Design Patterns",
        content: "TypeScript singleton pattern implementation guide.",
        tags: ["typescript", "design-patterns"],
        updated: "2026-04-10T00:00:00.000Z",
      }),
      wikiDir,
    );
    await writePage(
      makePage({
        slug: "ts-generics",
        type: "concept",
        title: "TypeScript Generics",
        content: "Using generics in TypeScript for type-safe code.",
        tags: ["typescript", "generics"],
        updated: "2026-04-15T00:00:00.000Z",
      }),
      wikiDir,
    );
    await writePage(
      makePage({
        slug: "python-guide",
        type: "entity",
        title: "Python Guide",
        content: "Python programming basics.",
        tags: ["python"],
        updated: "2026-04-05T00:00:00.000Z",
      }),
      wikiDir,
    );
    await rebuildSearchIndex(wikiDir);
  }

  // list ───────────────────────────────────────────────────────────

  test("list emits a JSON payload with all seeded pages sorted by updated desc", async () => {
    await seed();
    await listSubcommand.run!({
      args: { json: true, global: true, quiet: false, verbose: false, all: false, limit: "20" },
      cmd: listSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.total).toBe(3);
    expect(payload.pages.length).toBe(3);
    // Most recently updated first
    expect(payload.pages[0].slug).toBe("ts-generics");
    expect(payload.pages[2].slug).toBe("python-guide");
  });

  test("list respects --limit and reports the truncated count in JSON", async () => {
    await seed();
    await listSubcommand.run!({
      args: { json: true, global: true, quiet: false, verbose: false, all: false, limit: "2" },
      cmd: listSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.total).toBe(3);
    expect(payload.shown).toBe(2);
    expect(payload.pages.length).toBe(2);
  });

  test("list on an empty wiki prints a helpful hint", async () => {
    await listSubcommand.run!({
      args: { json: false, global: true, quiet: false, verbose: false, all: false, limit: "20" },
      cmd: listSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const joined = consoleOutput.join("\n");
    expect(joined).toContain("No wiki pages found");
    expect(joined).toContain("am wiki ingest");
  });

  test("list --all ignores --limit", async () => {
    await seed();
    await listSubcommand.run!({
      args: { json: true, global: true, quiet: false, verbose: false, all: true, limit: "1" },
      cmd: listSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.shown).toBe(3);
  });

  // show ───────────────────────────────────────────────────────────

  test("show prints a page by slug in JSON mode", async () => {
    await seed();
    await showSubcommand.run!({
      args: {
        slug: "ts-generics",
        json: true,
        global: true,
        quiet: false,
        verbose: false,
      },
      cmd: showSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.slug).toBe("ts-generics");
    expect(payload.title).toBe("TypeScript Generics");
    expect(payload.type).toBe("concept");
  });

  test("show exits with code 1 and a clear error when the id is unknown", async () => {
    await seed();
    await showSubcommand.run!({
      args: {
        slug: "does-not-exist",
        json: false,
        global: true,
        quiet: false,
        verbose: false,
      },
      cmd: showSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    expect(process.exitCode).toBe(1);
    const errs = consoleErrors.join("\n");
    expect(errs).toContain("does-not-exist");
    expect(errs.toLowerCase()).toContain("not found");
  });

  // search ─────────────────────────────────────────────────────────

  test("search returns ranked matches in JSON", async () => {
    await seed();
    await searchSubcommand.run!({
      args: {
        query: "TypeScript",
        json: true,
        global: true,
        quiet: false,
        verbose: false,
        limit: "10",
      },
      cmd: searchSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.query).toBe("TypeScript");
    const slugs = payload.results.map((r: { slug: string }) => r.slug);
    expect(slugs).toContain("typescript-patterns");
    expect(slugs).toContain("ts-generics");
    expect(payload.total).toBeGreaterThanOrEqual(2);
  });

  test("search with no matches prints a 'No pages match' line in text mode", async () => {
    await seed();
    await searchSubcommand.run!({
      args: {
        query: "zzz-nonexistent-query-xyz",
        json: false,
        global: true,
        quiet: false,
        verbose: false,
        limit: "10",
      },
      cmd: searchSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const joined = consoleOutput.join("\n");
    expect(joined).toContain("No pages match");
  });

  test("search with no matches returns total: 0 in JSON mode", async () => {
    await seed();
    await searchSubcommand.run!({
      args: {
        query: "zzz-nonexistent-query-xyz",
        json: true,
        global: true,
        quiet: false,
        verbose: false,
        limit: "10",
      },
      cmd: searchSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.total).toBe(0);
    expect(payload.results).toEqual([]);
  });

  // path ───────────────────────────────────────────────────────────

  test("path prints the global wiki directory as a bare line for shell use", async () => {
    await pathSubcommand.run!({
      args: { json: false, global: true, quiet: false, verbose: false },
      cmd: pathSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    // One line of output, equal to the resolved wiki path — no prefix.
    expect(consoleOutput.length).toBe(1);
    expect(consoleOutput[0]).toBe(wikiDir);
  });

  test("path --json emits structured output including the global flag", async () => {
    await pathSubcommand.run!({
      args: { json: true, global: true, quiet: false, verbose: false },
      cmd: pathSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.path).toBe(wikiDir);
    expect(payload.global).toBe(true);
  });
});
