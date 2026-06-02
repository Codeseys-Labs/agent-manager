import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findOrphans, getRelatedPages, graphPath, loadGraph } from "../../src/wiki/graph";
import { deletePage, readPage, searchPages, writePage } from "../../src/wiki/storage";
import type { WikiPage } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ADR-0054 R1: writePage maintains the knowledge graph, wikilink edges, the
// search index, and orphan detection ON the write path (incrementally), so
// derived artifacts stay current instead of going stale between batch rebuilds.

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date().toISOString();
  return {
    slug: "test-page",
    title: "Test Page",
    type: "entity",
    content: "Body content.",
    tags: [],
    sources: [],
    backlinks: [],
    created: now,
    updated: now,
    ...overrides,
  };
}

describe("wiki/storage write path (ADR-0054 R1)", () => {
  let tmp: TestDir;
  let wikiDir: string;

  beforeEach(async () => {
    tmp = await createTestDir("wiki-write-path-");
    wikiDir = join(tmp.path, "wiki");
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  test("writePage folds the page into the graph (node created)", async () => {
    await writePage(makePage({ slug: "alpha", title: "Alpha" }), wikiDir);

    const graph = await loadGraph(wikiDir);
    expect(graph.nodes.alpha).toBeDefined();
    expect(graph.nodes.alpha.title).toBe("Alpha");
  });

  test("writePage writes graph.json to disk incrementally (no manual rebuild)", async () => {
    await writePage(makePage({ slug: "alpha" }), wikiDir);
    // graph.json exists immediately after the write — proves it is on the
    // write path, not deferred to a batch rebuild.
    const raw = await readFile(graphPath(wikiDir), "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.nodes.alpha).toBeDefined();
  });

  test("auto-inserts [[wikilinks]] for existing page slugs and records the edge", async () => {
    // First page exists; its slug becomes link-able.
    await writePage(makePage({ slug: "claude-code", title: "Claude Code" }), wikiDir);
    // Second page mentions "Claude Code" in prose.
    await writePage(
      makePage({
        slug: "setup-notes",
        title: "Setup Notes",
        content: "We configure Claude Code for the team.",
      }),
      wikiDir,
    );

    // The body persisted to disk should now contain the wikilink.
    const persisted = await readPage("setup-notes", wikiDir);
    expect(persisted!.content).toContain("[[Claude Code]]");

    // And the graph should have a wikilink edge setup-notes -> claude-code.
    const graph = await loadGraph(wikiDir);
    const hasEdge = graph.edges.some(
      (e) => e.from === "setup-notes" && e.to === "claude-code" && e.type === "wikilink",
    );
    expect(hasEdge).toBe(true);
  });

  test("backlinks stay current: the linked page gets a backlink edge", async () => {
    await writePage(makePage({ slug: "claude-code", title: "Claude Code" }), wikiDir);
    await writePage(
      makePage({
        slug: "setup-notes",
        content: "We configure Claude Code for the team.",
      }),
      wikiDir,
    );

    const graph = await loadGraph(wikiDir);
    const hasBacklink = graph.edges.some(
      (e) => e.from === "claude-code" && e.to === "setup-notes" && e.type === "backlink",
    );
    expect(hasBacklink).toBe(true);
    // getRelatedPages surfaces the relationship in both directions.
    expect(getRelatedPages("claude-code", graph)).toContain("setup-notes");
  });

  test("orphan detection reflects the live graph", async () => {
    await writePage(makePage({ slug: "claude-code", title: "Claude Code" }), wikiDir);
    await writePage(
      makePage({
        slug: "setup-notes",
        content: "We configure Claude Code for the team.",
      }),
      wikiDir,
    );
    // A page nothing links to and which links to nothing: a true orphan.
    await writePage(
      makePage({ slug: "island", title: "Island", content: "Disconnected note." }),
      wikiDir,
    );

    const graph = await loadGraph(wikiDir);
    const orphans = findOrphans(graph);
    // claude-code has an inbound wikilink edge → not an orphan.
    expect(orphans).not.toContain("claude-code");
    // setup-notes receives a backlink edge from claude-code → not an orphan.
    expect(orphans).not.toContain("setup-notes");
    // island has no inbound edges → orphan, surfaced from the live write-path graph.
    expect(orphans).toContain("island");
  });

  test("search index is updated on write (searchable without manual rebuild)", async () => {
    await writePage(
      makePage({
        slug: "widget-doc",
        title: "Widget Doc",
        content: "Unique searchable content about flux capacitors.",
      }),
      wikiDir,
    );

    const results = await searchPages("flux", 10, wikiDir);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].page.slug).toBe("widget-doc");
  });

  test("maintainDerived:false skips graph + index + wikilink side-effects (write amplification guard)", async () => {
    // Re-resolve a clean dir to assert the batch path writes no graph.
    const batchDir = join(tmp.path, "batch-wiki");
    await writePage(
      makePage({
        slug: "batch-page",
        content: "Mentions Claude Code but maintainDerived is off.",
      }),
      { wikiDir: batchDir, maintainDerived: false },
    );

    // No wikilink inserted into the body.
    const persisted = await readPage("batch-page", batchDir);
    expect(persisted!.content).not.toContain("[[");

    // No graph.json created by the write itself.
    let graphExists = true;
    try {
      await readFile(graphPath(batchDir), "utf-8");
    } catch {
      graphExists = false;
    }
    expect(graphExists).toBe(false);
  });

  test("forwards catalog NER opts so catalog names auto-link on write", async () => {
    // A page named after a catalog server exists.
    await writePage(makePage({ slug: "acme-mcp", title: "Acme MCP" }), {
      wikiDir,
      maintainDerived: false,
    });
    // A second page mentions it; with catalog opts the name is link-worthy.
    await writePage(
      makePage({
        slug: "ops-notes",
        content: "Route everything through acme-mcp for now.",
      }),
      { wikiDir, ner: { catalogEntities: ["acme-mcp"] } },
    );

    const persisted = await readPage("ops-notes", wikiDir);
    expect(persisted!.content).toContain("[[acme-mcp]]");
  });

  test("legacy string second-arg signature still works (backward compat)", async () => {
    await writePage(makePage({ slug: "legacy", title: "Legacy" }), wikiDir);
    const loaded = await readPage("legacy", wikiDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("Legacy");
  });
});

// WIKI-FIX-3 (ADR-0054 R1): the delete path is now symmetric with the write
// path. Before the fix, deletePage only rm'd the .md file; the graph node + its
// edges and the search-index document lingered, so orphan detection, backlinks,
// and search all kept referencing a slug that no longer existed.

describe("wiki/storage delete path liveness (ADR-0054 R1 / WIKI-FIX-3)", () => {
  let tmp: TestDir;
  let wikiDir: string;

  beforeEach(async () => {
    tmp = await createTestDir("wiki-delete-path-");
    wikiDir = join(tmp.path, "wiki");
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  test("deletePage prunes the node + edges from the graph and the search index", async () => {
    // claude-code <- setup-notes (wikilink), claude-code -> setup-notes (backlink)
    await writePage(makePage({ slug: "claude-code", title: "Claude Code" }), wikiDir);
    await writePage(
      makePage({
        slug: "setup-notes",
        title: "Setup Notes",
        content: "We configure Claude Code for the team.",
      }),
      wikiDir,
    );

    // Pre-condition: page is in graph + searchable.
    let graph = await loadGraph(wikiDir);
    expect(graph.nodes["setup-notes"]).toBeDefined();
    expect(
      (await searchPages("configure", 10, wikiDir)).some((r) => r.page.slug === "setup-notes"),
    ).toBe(true);

    const deleted = await deletePage("setup-notes", wikiDir);
    expect(deleted).toBe(true);

    // File gone.
    expect(await readPage("setup-notes", wikiDir)).toBeNull();

    // Graph: node removed AND no edge references the deleted slug (orphans /
    // backlinks must not point at a ghost).
    graph = await loadGraph(wikiDir);
    expect(graph.nodes["setup-notes"]).toBeUndefined();
    const danglingEdges = graph.edges.filter(
      (e) => e.from === "setup-notes" || e.to === "setup-notes",
    );
    expect(danglingEdges).toEqual([]);
    // The backlink claude-code -> setup-notes is gone, so claude-code no longer
    // surfaces the deleted page as related.
    expect(getRelatedPages("claude-code", graph)).not.toContain("setup-notes");

    // Search: the deleted slug is no longer returned.
    const results = await searchPages("configure", 10, wikiDir);
    expect(results.some((r) => r.page.slug === "setup-notes")).toBe(false);
  });

  test("orphan detection no longer reports the deleted page", async () => {
    await writePage(
      makePage({ slug: "island", title: "Island", content: "Disconnected note." }),
      wikiDir,
    );
    let graph = await loadGraph(wikiDir);
    expect(findOrphans(graph)).toContain("island");

    await deletePage("island", wikiDir);

    graph = await loadGraph(wikiDir);
    // The slug must not survive in the orphan list — its node is gone entirely.
    expect(findOrphans(graph)).not.toContain("island");
    expect(graph.nodes.island).toBeUndefined();
  });

  test("maintainDerived:false leaves graph + index untouched (batch-path guard)", async () => {
    await writePage(makePage({ slug: "keep-graph", title: "Keep Graph" }), wikiDir);

    // Delete only the file; the batch caller owns derived maintenance.
    const deleted = await deletePage("keep-graph", { wikiDir, maintainDerived: false });
    expect(deleted).toBe(true);

    // File gone, but the graph node is still present (not pruned).
    expect(await readPage("keep-graph", wikiDir)).toBeNull();
    const graph = await loadGraph(wikiDir);
    expect(graph.nodes["keep-graph"]).toBeDefined();
  });

  test("deleting a missing slug returns false and does not touch derived state", async () => {
    await writePage(makePage({ slug: "present", title: "Present" }), wikiDir);
    const before = await loadGraph(wikiDir);

    const deleted = await deletePage("ghost", wikiDir);
    expect(deleted).toBe(false);

    const after = await loadGraph(wikiDir);
    expect(Object.keys(after.nodes).sort()).toEqual(Object.keys(before.nodes).sort());
    expect(after.nodes.present).toBeDefined();
  });
});
