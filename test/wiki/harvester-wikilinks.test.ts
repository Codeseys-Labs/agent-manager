import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Message, Session } from "../../src/core/session";
import { addPageToGraph, loadGraph } from "../../src/wiki/graph";
import { harvestSessionAsPages } from "../../src/wiki/harvester";
import { readPage } from "../../src/wiki/storage";
import type { KnowledgeGraph } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ADR-0054 R2: the harvester must emit `[[wikilink]]` references (not an inert
// backtick-wrapped bullet list) so harvested knowledge participates in the
// knowledge graph exactly like authored pages.

function makeSession(messages: Message[], adapter = "claude-code"): Session {
  return {
    id: "wikilink-session",
    adapter,
    messages,
    startedAt: new Date(),
  };
}

describe("wiki/harvester wikilink emission (ADR-0054 R2)", () => {
  let tmp: TestDir;
  let wikiDir: string;
  let origConfigDir: string | undefined;

  beforeEach(async () => {
    tmp = await createTestDir("wiki-harvest-links-");
    // Point the resolved (default) wiki dir at our tmp so the harvester's
    // dedup pass (getAllEntries → resolveWikiDir) is hermetic, and write into
    // the matching global wiki dir.
    origConfigDir = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = tmp.path;
    wikiDir = join(tmp.path, "wiki", "global");
  });

  afterEach(async () => {
    // Reflect.deleteProperty genuinely UNSETS (not `= undefined`, which coerces
    // to the string "undefined" and poisons the shared process env on Windows)
    // and is lint-clean (Biome's noDelete forbids the delete operator).
    if (origConfigDir === undefined) {
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    } else {
      process.env.AM_CONFIG_DIR = origConfigDir;
    }
    await tmp.cleanup();
  });

  test("harvested page body emits [[wikilinks]], not a backtick bullet list", async () => {
    // A fact mentioning a path + a tool name + a function — all NER-catchable.
    const messages: Message[] = [
      {
        role: "user",
        content:
          "This project is built with Bun and the config lives in src/adapters/types.ts; we call buildResolvedConfig() to assemble it.",
      },
    ];

    const slugs = await harvestSessionAsPages(makeSession(messages), { wikiDir });
    expect(slugs.length).toBeGreaterThan(0);

    // At least one harvested page must carry a real wikilink in its body and
    // must NOT regress to the old backtick-wrapped bullet form.
    let sawWikilink = false;
    let sawBacktickEntityBullet = false;
    for (const slug of slugs) {
      const page = await readPage(slug, wikiDir);
      expect(page).not.toBeNull();
      const body = page!.content;
      if (/\[\[[^\]]+\]\]/.test(body)) sawWikilink = true;
      // Old inert form: "- `Something` (type)"
      if (/^- `[^`]+` \(/m.test(body)) sawBacktickEntityBullet = true;
    }
    expect(sawWikilink).toBe(true);
    expect(sawBacktickEntityBullet).toBe(false);
  });

  test("harvested wikilinks link to known catalog entity slugs", async () => {
    // The catalog exposes a server named "acme-mcp". A session that mentions it
    // should produce a page that wikilinks the catalog slug.
    const messages: Message[] = [
      {
        role: "user",
        content: "This project uses acme-mcp for the staging environment.",
      },
    ];

    const slugs = await harvestSessionAsPages(makeSession(messages), {
      wikiDir,
      catalogEntities: ["acme-mcp"],
    });
    expect(slugs.length).toBeGreaterThan(0);

    let linkedCatalogEntity = false;
    for (const slug of slugs) {
      const page = await readPage(slug, wikiDir);
      if (page?.content.includes("[[acme-mcp]]")) linkedCatalogEntity = true;
    }
    expect(linkedCatalogEntity).toBe(true);
  });

  test("harvested page participates in the graph (produces wikilink edges)", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "The build is configured in src/adapters/types.ts using Bun.",
      },
    ];

    const slugs = await harvestSessionAsPages(makeSession(messages), { wikiDir });
    expect(slugs.length).toBeGreaterThan(0);

    // writePage folds each page into the live graph on the write path. Because
    // the body now contains [[...]] references, addPageToGraph mines them as
    // wikilink edges (it only parses the [[...]] pattern, never backticks).
    const graph = await loadGraph(wikiDir);
    const wikilinkEdges = graph.edges.filter((e) => e.type === "wikilink");
    expect(wikilinkEdges.length).toBeGreaterThan(0);
    // Every wikilink edge must originate from a harvested page slug.
    const harvested = new Set(slugs);
    expect(wikilinkEdges.every((e) => harvested.has(e.from))).toBe(true);
  });

  test("entities slug list is persisted to frontmatter for the entity index", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "This project is built with Bun and the config lives in src/adapters/types.ts.",
      },
    ];

    const slugs = await harvestSessionAsPages(makeSession(messages), { wikiDir });
    let sawEntities = false;
    for (const slug of slugs) {
      const page = await readPage(slug, wikiDir);
      if (page?.entities && page.entities.length > 0) {
        sawEntities = true;
        // The persisted entity slugs must match what addPageToGraph would mine.
        expect(page.entities.every((s) => typeof s === "string" && s.length > 0)).toBe(true);
      }
    }
    expect(sawEntities).toBe(true);
  });

  test("graph builder mines the harvested [[wikilinks]] (round-trip)", async () => {
    // Direct round-trip: a harvested page body with [[X]] yields a graph edge to X.
    const messages: Message[] = [
      { role: "user", content: "This project uses src/adapters/registry.ts for adapter lookup." },
    ];
    const slugs = await harvestSessionAsPages(makeSession(messages), { wikiDir });
    const page = await readPage(slugs[0], wikiDir);
    expect(page).not.toBeNull();

    // Feed the exact persisted page into a fresh graph and confirm edges form.
    const graph: KnowledgeGraph = { nodes: {}, edges: [], updated: new Date().toISOString() };
    await addPageToGraph(page!, graph);
    const fromThisPage = graph.edges.filter((e) => e.from === page!.slug);
    // If the body has any [[link]], there must be at least one wikilink edge.
    if (/\[\[[^\]]+\]\]/.test(page!.content)) {
      expect(fromThisPage.some((e) => e.type === "wikilink")).toBe(true);
    }
  });
});
