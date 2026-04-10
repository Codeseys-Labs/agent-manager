import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  addPageToGraph,
  exportGraphForViz,
  findOrphans,
  getRelatedPages,
  loadGraph,
  removePageFromGraph,
  saveGraph,
} from "../../src/wiki/graph";
import type { KnowledgeGraph, WikiPage } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ── Helpers ─────────────────────────────────────────────────────

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date().toISOString();
  return {
    slug: "test-page",
    title: "Test Page",
    type: "entity",
    content: "Some content about testing.",
    tags: ["test"],
    sources: [],
    backlinks: [],
    created: now,
    updated: now,
    ...overrides,
  };
}

function emptyGraph(): KnowledgeGraph {
  return { nodes: {}, edges: [], updated: new Date().toISOString() };
}

// ── Tests ───────────────────────────────────────────────────────

describe("wiki/graph", () => {
  let tmp: TestDir;
  let wikiDir: string;

  beforeEach(async () => {
    tmp = await createTestDir("wiki-graph-");
    wikiDir = join(tmp.path, "wiki");
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  // ── loadGraph ───────────────────────────────────────────────

  describe("loadGraph", () => {
    test("returns empty graph when no file exists", async () => {
      const graph = await loadGraph(wikiDir);
      expect(graph.nodes).toEqual({});
      expect(graph.edges).toEqual([]);
      expect(graph.updated).toBeDefined();
    });
  });

  // ── saveGraph + loadGraph roundtrip ─────────────────────────

  describe("saveGraph + loadGraph", () => {
    test("roundtrip preserves data", async () => {
      const graph: KnowledgeGraph = {
        nodes: {
          "page-a": { slug: "page-a", title: "Page A", type: "entity", tags: ["test"] },
          "page-b": { slug: "page-b", title: "Page B", type: "concept", tags: [] },
        },
        edges: [{ from: "page-a", to: "page-b", type: "wikilink", weight: 1.0 }],
        updated: new Date().toISOString(),
      };

      await saveGraph(graph, wikiDir);
      const loaded = await loadGraph(wikiDir);

      expect(Object.keys(loaded.nodes)).toEqual(["page-a", "page-b"]);
      expect(loaded.nodes["page-a"].title).toBe("Page A");
      expect(loaded.nodes["page-b"].type).toBe("concept");
      expect(loaded.edges.length).toBe(1);
      expect(loaded.edges[0].from).toBe("page-a");
      expect(loaded.edges[0].to).toBe("page-b");
      expect(loaded.edges[0].type).toBe("wikilink");
    });
  });

  // ── addPageToGraph ──────────────────────────────────────────

  describe("addPageToGraph", () => {
    test("creates node and edges from wikilinks", async () => {
      const graph = emptyGraph();

      // Add a target node first so backlinks can be created
      graph.nodes["other-topic"] = {
        slug: "other-topic",
        title: "Other Topic",
        type: "entity",
        tags: [],
      };

      const page = makePage({
        slug: "my-page",
        title: "My Page",
        content: "This links to [[Other Topic]] in the content.",
      });

      const updated = await addPageToGraph(page, graph);

      expect(updated.nodes["my-page"]).toBeDefined();
      expect(updated.nodes["my-page"].title).toBe("My Page");

      // Should have an outgoing wikilink edge
      const wikilinkEdges = updated.edges.filter(
        (e) => e.from === "my-page" && e.type === "wikilink",
      );
      expect(wikilinkEdges.length).toBeGreaterThanOrEqual(1);
      expect(wikilinkEdges[0].to).toBe("other-topic");
    });

    test("creates node with tags", async () => {
      const graph = emptyGraph();
      const page = makePage({
        slug: "tagged-page",
        title: "Tagged Page",
        tags: ["alpha", "beta"],
      });

      const updated = await addPageToGraph(page, graph);
      expect(updated.nodes["tagged-page"].tags).toEqual(["alpha", "beta"]);
    });
  });

  // ── removePageFromGraph ─────────────────────────────────────

  describe("removePageFromGraph", () => {
    test("cleans up node and all edges", () => {
      const graph: KnowledgeGraph = {
        nodes: {
          "page-a": { slug: "page-a", title: "A", type: "entity", tags: [] },
          "page-b": { slug: "page-b", title: "B", type: "entity", tags: [] },
          "page-c": { slug: "page-c", title: "C", type: "entity", tags: [] },
        },
        edges: [
          { from: "page-a", to: "page-b", type: "wikilink", weight: 1.0 },
          { from: "page-b", to: "page-c", type: "wikilink", weight: 1.0 },
          { from: "page-c", to: "page-a", type: "backlink", weight: 0.3 },
        ],
        updated: new Date().toISOString(),
      };

      const updated = removePageFromGraph("page-b", graph);
      expect(updated.nodes["page-b"]).toBeUndefined();
      // No edges should reference page-b
      expect(updated.edges.every((e) => e.from !== "page-b" && e.to !== "page-b")).toBe(true);
      // Remaining edges should be only the c->a edge
      expect(updated.edges.length).toBe(1);
      expect(updated.edges[0].from).toBe("page-c");
      expect(updated.edges[0].to).toBe("page-a");
    });
  });

  // ── getRelatedPages ─────────────────────────────────────────

  describe("getRelatedPages", () => {
    test("returns neighbors (both directions)", () => {
      const graph: KnowledgeGraph = {
        nodes: {
          a: { slug: "a", title: "A", type: "entity", tags: [] },
          b: { slug: "b", title: "B", type: "entity", tags: [] },
          c: { slug: "c", title: "C", type: "entity", tags: [] },
          d: { slug: "d", title: "D", type: "entity", tags: [] },
        },
        edges: [
          { from: "a", to: "b", type: "wikilink", weight: 1.0 },
          { from: "c", to: "a", type: "backlink", weight: 0.3 },
        ],
        updated: new Date().toISOString(),
      };

      const related = getRelatedPages("a", graph);
      expect(related).toContain("b");
      expect(related).toContain("c");
      expect(related).not.toContain("d");
      expect(related).not.toContain("a");
    });

    test("returns empty array for isolated node", () => {
      const graph: KnowledgeGraph = {
        nodes: {
          solo: { slug: "solo", title: "Solo", type: "entity", tags: [] },
        },
        edges: [],
        updated: new Date().toISOString(),
      };

      const related = getRelatedPages("solo", graph);
      expect(related).toEqual([]);
    });
  });

  // ── findOrphans ─────────────────────────────────────────────

  describe("findOrphans", () => {
    test("identifies nodes with no inbound edges", () => {
      const graph: KnowledgeGraph = {
        nodes: {
          root: { slug: "root", title: "Root", type: "entity", tags: [] },
          linked: { slug: "linked", title: "Linked", type: "entity", tags: [] },
          orphan: { slug: "orphan", title: "Orphan", type: "entity", tags: [] },
        },
        edges: [{ from: "root", to: "linked", type: "wikilink", weight: 1.0 }],
        updated: new Date().toISOString(),
      };

      const orphans = findOrphans(graph);
      expect(orphans).toContain("root");
      expect(orphans).toContain("orphan");
      expect(orphans).not.toContain("linked");
    });

    test("returns all nodes when no edges exist", () => {
      const graph: KnowledgeGraph = {
        nodes: {
          a: { slug: "a", title: "A", type: "entity", tags: [] },
          b: { slug: "b", title: "B", type: "entity", tags: [] },
        },
        edges: [],
        updated: new Date().toISOString(),
      };

      const orphans = findOrphans(graph);
      expect(orphans.sort()).toEqual(["a", "b"]);
    });
  });

  // ── exportGraphForViz ───────────────────────────────────────

  describe("exportGraphForViz", () => {
    test("returns correct format with nodes and edges", () => {
      const graph: KnowledgeGraph = {
        nodes: {
          a: { slug: "a", title: "Page A", type: "entity", tags: [] },
          b: { slug: "b", title: "Page B", type: "concept", tags: [] },
        },
        edges: [{ from: "a", to: "b", type: "wikilink", weight: 1.0 }],
        updated: new Date().toISOString(),
      };

      const viz = exportGraphForViz(graph);

      expect(viz.nodes).toHaveLength(2);
      expect(viz.nodes[0]).toEqual({ id: "a", label: "Page A", type: "entity" });
      expect(viz.nodes[1]).toEqual({ id: "b", label: "Page B", type: "concept" });

      expect(viz.edges).toHaveLength(1);
      expect(viz.edges[0]).toEqual({ source: "a", target: "b", type: "wikilink" });
    });

    test("returns empty arrays for empty graph", () => {
      const graph = emptyGraph();
      const viz = exportGraphForViz(graph);
      expect(viz.nodes).toEqual([]);
      expect(viz.edges).toEqual([]);
    });
  });
});
