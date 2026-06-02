import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  briefingSubcommand,
  exportSubcommand,
  graphSubcommand,
  lintSubcommand,
  listSubcommand,
  pathSubcommand,
  searchSubcommand,
  showSubcommand,
} from "../../src/commands/wiki";
import { addPageToGraph, loadGraph, saveGraph } from "../../src/wiki/graph";
import {
  WIKI_PROJECT_DIRNAME,
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

// ── BUG-1 regression: `am wiki lint/graph --global` must read the GLOBAL wiki ──
//
// Previously lint/graph called listPages()/loadGraph() with no wikiDir, so the
// declared `--global` flag was silently ignored: both subcommands always read
// whatever resolveWikiDir() picked (a project `.am-wiki/` when one exists). We
// set cwd to a temp project with an EMPTY `.am-wiki/` and seed pages + a graph
// ONLY in the global store. With --global threaded, both commands must report
// the global content; pre-fix they reported the empty project wiki (0 pages,
// 0 nodes).

describe("am wiki: --global threading for lint/graph (BUG-1 regression)", () => {
  let dir: TestDir;
  let configDir: string;
  let globalWikiDir: string;
  let projectDir: string;
  const origCwd = process.cwd();

  beforeEach(async () => {
    dir = await createTestDir("am-wiki-global-");
    configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;

    // Global wiki gets real content.
    globalWikiDir = resolveWikiDir({ global: true });
    await ensureWikiDirs(globalWikiDir);

    // A sibling project dir with .agent-manager.toml + an EMPTY .am-wiki/, so
    // the non-global resolveWikiDir() points at an empty project wiki.
    projectDir = join(dir.path, "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, ".agent-manager.toml"), "[settings]\n", "utf-8");
    const projectWiki = join(projectDir, WIKI_PROJECT_DIRNAME);
    await ensureWikiDirs(projectWiki);
    process.chdir(projectDir);

    captureConsole();
    process.exitCode = undefined;
  });

  afterEach(async () => {
    restoreConsole();
    process.chdir(origCwd);
    process.exitCode = undefined;
    if (origConfigDir === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = origConfigDir;
    }
    if (dir) await dir.cleanup();
  });

  async function seedGlobal(): Promise<void> {
    const page = makePage({
      slug: "global-only-page",
      type: "entity",
      title: "Global Only",
      content: "Lives in the global store, not the project wiki.",
      tags: ["global"],
    });
    await writePage(page, globalWikiDir);
    // Persist a graph in the global store so `graph` has nodes to report.
    const graph = await loadGraph(globalWikiDir);
    await addPageToGraph(page, graph);
    await saveGraph(graph, globalWikiDir);
  }

  test("lint --global reports pages from the global store, not the empty project wiki", async () => {
    await seedGlobal();
    await lintSubcommand.run!({
      args: { json: true, global: true, quiet: false, verbose: false },
      cmd: lintSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.total_pages).toBe(1);
  });

  test("lint without --global sees the empty project wiki (proves the flag matters)", async () => {
    await seedGlobal();
    await lintSubcommand.run!({
      args: { json: true, global: false, quiet: false, verbose: false },
      cmd: lintSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.total_pages).toBe(0);
  });

  test("graph --global reports nodes from the global store, not the empty project wiki", async () => {
    await seedGlobal();
    await graphSubcommand.run!({
      args: { json: true, global: true, quiet: false, verbose: false, format: "viz" },
      cmd: graphSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.nodes.length).toBe(1);
    expect(payload.nodes[0].id).toBe("global-only-page");
  });

  test("graph without --global sees the empty project wiki (proves the flag matters)", async () => {
    await seedGlobal();
    await graphSubcommand.run!({
      args: { json: true, global: false, quiet: false, verbose: false, format: "viz" },
      cmd: graphSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.nodes.length).toBe(0);
  });
});

// ── QW-followup: extend --global threading to briefing/export ──────────
//
// `briefing` and `export` read entries via getAllEntries()/getIndex(), both of
// which accept a wikiDir. Before this fix they were called with no wikiDir, so
// the declared `--global` flag was silently ignored — exactly the BUG-1 shape
// already fixed for lint/graph. Same regression harness: seed pages ONLY in the
// global store while cwd is a project with an EMPTY .am-wiki/, then assert that
// --global reads the global content and the un-flagged call sees the empty
// project wiki.
//
// NOTE: `synthesize`, `add`, `import`, `ingest`, and `harvest` also declare
// `--global` but cannot be threaded here without a change to src/wiki/* —
// their storage entry points (synthesizeContext, addEntry, harvestSessionAsPages)
// do not yet accept a wikiDir. Those are out of scope for this wave (storage
// layer is owned elsewhere); only the fully-threadable subcommands are wired.

describe("am wiki: --global threading for briefing/export (QW-followup)", () => {
  let dir: TestDir;
  let configDir: string;
  let globalWikiDir: string;
  let projectDir: string;
  const origCwd = process.cwd();

  beforeEach(async () => {
    dir = await createTestDir("am-wiki-global-be-");
    configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;

    globalWikiDir = resolveWikiDir({ global: true });
    await ensureWikiDirs(globalWikiDir);

    projectDir = join(dir.path, "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, ".agent-manager.toml"), "[settings]\n", "utf-8");
    const projectWiki = join(projectDir, WIKI_PROJECT_DIRNAME);
    await ensureWikiDirs(projectWiki);
    process.chdir(projectDir);

    captureConsole();
    process.exitCode = undefined;
  });

  afterEach(async () => {
    restoreConsole();
    process.chdir(origCwd);
    process.exitCode = undefined;
    if (origConfigDir === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = origConfigDir;
    }
    if (dir) await dir.cleanup();
  });

  async function seedGlobalEntry(): Promise<void> {
    // entryToPage stores the entity_type as a tag, so an "entity"-type page
    // tagged "fact" round-trips back to a fact KnowledgeEntry for the agent
    // briefing / export readers. agent_id steers buildAgentBriefing.
    await writePage(
      makePage({
        slug: "global-fact",
        type: "entity",
        title: "A global fact",
        content: "The deployment target is us-east-1.",
        tags: ["fact", "infra"],
        agent_id: "researcher",
      }),
      globalWikiDir,
    );
  }

  test("export --global reports the global index entry_count, not the empty project wiki", async () => {
    await seedGlobalEntry();
    await exportSubcommand.run!({
      args: { json: true, global: true, quiet: false, verbose: false, format: "json" },
      cmd: exportSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.index.entry_count).toBe(1);
    expect(payload.entries.length).toBe(1);
  });

  test("export without --global sees the empty project wiki (proves the flag matters)", async () => {
    await seedGlobalEntry();
    await exportSubcommand.run!({
      args: { json: true, global: false, quiet: false, verbose: false, format: "json" },
      cmd: exportSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.index.entry_count).toBe(0);
    expect(payload.entries.length).toBe(0);
  });

  test("briefing --global includes the global agent entry, not the empty project wiki", async () => {
    await seedGlobalEntry();
    await briefingSubcommand.run!({
      args: { "agent-id": "researcher", json: true, global: true, quiet: false, verbose: false },
      cmd: briefingSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.agent_id).toBe("researcher");
    expect(payload.briefing).toContain("us-east-1");
  });

  test("briefing without --global sees the empty project wiki (proves the flag matters)", async () => {
    await seedGlobalEntry();
    await briefingSubcommand.run!({
      args: { "agent-id": "researcher", json: true, global: false, quiet: false, verbose: false },
      cmd: briefingSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.briefing).not.toContain("us-east-1");
  });
});

// ── WIKI-FIX-1 regression: `am wiki lint` low-confidence detection ──
//
// ADR-0054 R4 changed page.confidence from a raw 0.0-1.0 number to the
// WikiConfidence enum. The old lint used a numeric `p.confidence < 0.3`
// comparison which, against an enum string, is always false — so the
// low_confidence count was permanently 0 and the human path called
// `.toFixed(2)` on a string (would throw). This was uncovered, which is why it
// slipped review. These tests pin the enum-aware behaviour on both output paths.

describe("am wiki lint: low-confidence detection (WIKI-FIX-1)", () => {
  let dir: TestDir;
  let configDir: string;
  let wikiDir: string;

  beforeEach(async () => {
    dir = await createTestDir("am-wiki-lint-lowconf-");
    configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    wikiDir = resolveWikiDir({ global: true });
    await ensureWikiDirs(wikiDir);
    captureConsole();
    process.exitCode = undefined;
  });

  afterEach(async () => {
    restoreConsole();
    process.exitCode = undefined;
    if (origConfigDir === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = origConfigDir;
    }
    if (dir) await dir.cleanup();
  });

  async function seedConfidence(): Promise<void> {
    // Enum confidence (post-R4): one "low", one "high".
    await writePage(
      makePage({
        slug: "shaky-fact",
        title: "Shaky Fact",
        content: "An unverified, low-confidence claim.",
        confidence: "low",
      }),
      wikiDir,
    );
    await writePage(
      makePage({
        slug: "solid-fact",
        title: "Solid Fact",
        content: "A corroborated, high-confidence claim.",
        confidence: "high",
      }),
      wikiDir,
    );
    await rebuildSearchIndex(wikiDir);
  }

  test("JSON: flags only the 'low' enum page (numeric < 0.3 used to flag none)", async () => {
    await seedConfidence();
    await lintSubcommand.run!({
      args: { json: true, global: true, quiet: false, verbose: false },
      cmd: lintSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.low_confidence).toBe(1);
    expect(payload.low_confidence_slugs).toEqual(["shaky-fact"]);
  });

  test("legacy numeric confidence is normalised to the enum bucket before flagging", async () => {
    // A pre-R4 page that stored a raw number below the low threshold (< 0.4).
    await writePage(
      makePage({
        slug: "legacy-low",
        title: "Legacy Low",
        content: "Stored a numeric 0.2 confidence on disk (pre-R4).",
        confidence: 0.2,
      }),
      wikiDir,
    );
    await rebuildSearchIndex(wikiDir);

    await lintSubcommand.run!({
      args: { json: true, global: true, quiet: false, verbose: false },
      cmd: lintSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.low_confidence).toBe(1);
    expect(payload.low_confidence_slugs).toEqual(["legacy-low"]);
  });

  test("a literal numeric `confidence` ON DISK is read-path normalised to the 'low' bucket", async () => {
    // The sibling `legacy-low` test seeds via writePage(), which normalises the
    // numeric to the enum *before* serialising — so the bytes that hit disk are
    // already `confidence: low`, never a bare number. That path therefore can't
    // exercise parseWikiPage()'s read-path migration (normalizeConfidence at
    // src/wiki/storage.ts parseWikiPage). Here we hand-author the .md frontmatter
    // with a literal `confidence: 0.2` (a bare YAML number, the pre-R4 on-disk
    // shape) and write it directly with fs — bypassing writePage entirely — to
    // lock the contract that a literal on-disk numeric below the 0.4 medium
    // threshold is bucketed to "low" on read and flagged by lint.
    const rawFrontmatter = [
      "---",
      "title: On-Disk Numeric",
      "type: entity",
      "slug: ondisk-numeric",
      "tags: []",
      "sources: []",
      "backlinks: []",
      "created: 2026-04-01T00:00:00.000Z",
      "updated: 2026-04-01T00:00:00.000Z",
      "confidence: 0.2",
      "---",
      "A pre-R4 page whose frontmatter stores a bare numeric confidence.",
      "",
    ].join("\n");
    // Entity pages live under the `entities/` subdir (PAGE_SUBDIRS). Write the
    // file directly so the on-disk bytes literally contain `confidence: 0.2`.
    writeFileSync(join(wikiDir, "entities", "ondisk-numeric.md"), rawFrontmatter, "utf-8");
    await rebuildSearchIndex(wikiDir);

    await lintSubcommand.run!({
      args: { json: true, global: true, quiet: false, verbose: false },
      cmd: lintSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.low_confidence).toBe(1);
    expect(payload.low_confidence_slugs).toEqual(["ondisk-numeric"]);
  });

  test("human output displays the enum string (never calls .toFixed on a string)", async () => {
    await seedConfidence();
    await lintSubcommand.run!({
      args: { json: false, global: true, quiet: false, verbose: false },
      cmd: lintSubcommand,
      rawArgs: [],
      data: undefined,
    } as any);
    const joined = consoleOutput.join("\n");
    // The report mentions the low-confidence slug and prints the enum label,
    // not a numeric .toFixed() value (which would have thrown).
    expect(joined).toContain("Low confidence (1");
    expect(joined).toContain("shaky-fact (confidence: low)");
    expect(consoleErrors.join("\n")).not.toMatch(/toFixed|TypeError/);
  });
});
