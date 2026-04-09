/**
 * Knowledge graph management (ADR-0020, ADR-0022).
 *
 * Stores the graph as a JSON adjacency list at the resolved wiki directory's graph.json.
 * Nodes correspond to wiki pages, edges represent wikilinks, backlinks, entity mentions,
 * and "related" connections.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { entityToSlug, extractEntities } from "./ner";
import { ensureWikiDirs, resolveWikiDir } from "./storage";
import type { GraphEdge, KnowledgeGraph, WikiPage, WikiPageType } from "./types";

// ── Paths ───────────────────────────────────────────────────────

export function graphPath(wikiDir?: string): string {
  return join(wikiDir ?? resolveWikiDir(), "graph.json");
}

// ── Load / Save ─────────────────────────────────────────────────

/** Load graph from disk or return empty graph */
export async function loadGraph(wikiDir?: string): Promise<KnowledgeGraph> {
  try {
    const raw = await readFile(graphPath(wikiDir), "utf-8");
    return JSON.parse(raw) as KnowledgeGraph;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { nodes: {}, edges: [], updated: new Date().toISOString() };
    }
    throw err;
  }
}

/** Save graph to disk */
export async function saveGraph(graph: KnowledgeGraph, wikiDir?: string): Promise<void> {
  await ensureWikiDirs(wikiDir);
  graph.updated = new Date().toISOString();

  const filePath = graphPath(wikiDir);
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(graph, null, 2), "utf-8");
  await rename(tmp, filePath);
}

// ── Graph Mutation ──────────────────────────────────────────────

/** Add a page to the graph, extracting entities and creating edges */
export async function addPageToGraph(
  page: WikiPage,
  graph: KnowledgeGraph,
): Promise<KnowledgeGraph> {
  // Add or update node
  graph.nodes[page.slug] = {
    slug: page.slug,
    title: page.title,
    type: page.type,
    tags: page.tags,
  };

  // Remove existing outgoing edges from this page
  graph.edges = graph.edges.filter((e) => e.from !== page.slug);

  // Extract [[wikilinks]] from content
  const wikilinkPattern = /\[\[([^\]]+)\]\]/g;
  const wikilinks = new Set<string>();
  for (
    let m = wikilinkPattern.exec(page.content);
    m !== null;
    m = wikilinkPattern.exec(page.content)
  ) {
    const target = entityToSlug(m[1]);
    if (target && target !== page.slug) {
      wikilinks.add(target);
    }
  }

  for (const target of wikilinks) {
    graph.edges.push({
      from: page.slug,
      to: target,
      type: "wikilink",
      weight: 1.0,
    });
  }

  // Extract entities from content and create entity_mention edges
  const entities = extractEntities(page.content);
  const mentionedSlugs = new Set<string>();
  for (const entity of entities) {
    const slug = entityToSlug(entity.text);
    if (slug && slug !== page.slug && !wikilinks.has(slug)) {
      mentionedSlugs.add(slug);
    }
  }

  for (const target of mentionedSlugs) {
    graph.edges.push({
      from: page.slug,
      to: target,
      type: "entity_mention",
      weight: 0.5,
    });
  }

  // Update backlink edges: add backlink edges from all targets back to this page
  for (const target of [...wikilinks, ...mentionedSlugs]) {
    // Only create backlink if target node exists in graph
    if (graph.nodes[target]) {
      // Remove any existing backlink from target to this page
      graph.edges = graph.edges.filter(
        (e) => !(e.from === target && e.to === page.slug && e.type === "backlink"),
      );
      graph.edges.push({
        from: target,
        to: page.slug,
        type: "backlink",
        weight: 0.3,
      });
    }
  }

  return graph;
}

/** Remove a page and its edges from the graph */
export function removePageFromGraph(slug: string, graph: KnowledgeGraph): KnowledgeGraph {
  delete graph.nodes[slug];
  graph.edges = graph.edges.filter((e) => e.from !== slug && e.to !== slug);
  return graph;
}

// ── Graph Queries ───────────────────────────────────────────────

/** Get pages related to a given slug (1-hop neighbors) */
export function getRelatedPages(slug: string, graph: KnowledgeGraph): string[] {
  const neighbors = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.from === slug) {
      neighbors.add(edge.to);
    } else if (edge.to === slug) {
      neighbors.add(edge.from);
    }
  }

  return Array.from(neighbors);
}

/** Find orphan pages (no inbound links) */
export function findOrphans(graph: KnowledgeGraph): string[] {
  const hasInbound = new Set<string>();
  for (const edge of graph.edges) {
    hasInbound.add(edge.to);
  }

  return Object.keys(graph.nodes).filter((slug) => !hasInbound.has(slug));
}

/** Export graph in a format suitable for visualization (nodes + edges) */
export function exportGraphForViz(graph: KnowledgeGraph): {
  nodes: Array<{ id: string; label: string; type: string }>;
  edges: Array<{ source: string; target: string; type: string }>;
} {
  const nodes = Object.values(graph.nodes).map((n) => ({
    id: n.slug,
    label: n.title,
    type: n.type,
  }));

  const edges = graph.edges.map((e) => ({
    source: e.from,
    target: e.to,
    type: e.type,
  }));

  return { nodes, edges };
}
