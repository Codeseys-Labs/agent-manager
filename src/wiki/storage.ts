/**
 * Markdown-file-based knowledge storage with MiniSearch BM25 indexing (ADR-0020).
 *
 * Stores wiki pages at ~/.config/agent-manager/wiki/ as individual .md files
 * with YAML frontmatter. Replaces the flat JSON storage.
 *
 * Layout:
 *   wiki/
 *     entities/       — entity pages
 *     concepts/       — concept pages
 *     summaries/      — summary pages
 *     synthesis/      — synthesis pages
 *     decisions/      — decision pages
 *     raw/            — imported raw content
 *     index.json      — serialized MiniSearch index
 *     graph.json      — knowledge graph
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import MiniSearch from "minisearch";
import { resolveConfigDir } from "../core/config";
import type {
  EntityType,
  KnowledgeEntry,
  KnowledgeFilter,
  KnowledgeSource,
  Provenance,
  WikiIndex,
  WikiPage,
  WikiPageType,
} from "./types";

// ── Paths ───────────────────────────────────────────────────────

const PAGE_SUBDIRS: Record<WikiPageType, string> = {
  entity: "entities",
  concept: "concepts",
  summary: "summaries",
  synthesis: "synthesis",
  decision: "decisions",
};

/** Returns the wiki directory path */
export function getWikiDir(): string {
  return join(resolveConfigDir(), "wiki");
}

function searchIndexPath(): string {
  return join(getWikiDir(), "index.json");
}

function pageDir(type: WikiPageType): string {
  return join(getWikiDir(), PAGE_SUBDIRS[type]);
}

function pagePath(slug: string, type: WikiPageType): string {
  return join(pageDir(type), `${slug}.md`);
}

// ── Directory setup ─────────────────────────────────────────────

/** Create wiki subdirectories if missing */
export async function ensureWikiDirs(): Promise<void> {
  const base = getWikiDir();
  await mkdir(base, { recursive: true });
  for (const sub of [...Object.values(PAGE_SUBDIRS), "raw"]) {
    await mkdir(join(base, sub), { recursive: true });
  }
}

// ── YAML Frontmatter parsing (inline, no dependency) ────────────

const FRONTMATTER_DELIM = "---";

/**
 * Parse YAML frontmatter from markdown content.
 * Handles simple key-value pairs and YAML arrays (both inline [...] and block - item).
 */
export function parseFrontmatter(content: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith(FRONTMATTER_DELIM)) {
    return { metadata: {}, body: content };
  }

  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) return { metadata: {}, body: content };

  const rest = trimmed.slice(firstNewline + 1);
  const endIdx = rest.indexOf(`\n${FRONTMATTER_DELIM}`);
  if (endIdx === -1) return { metadata: {}, body: content };

  const yamlBlock = rest.slice(0, endIdx);
  const body = rest.slice(endIdx + 1 + FRONTMATTER_DELIM.length).replace(/^\n/, "");

  const metadata: Record<string, unknown> = {};
  let currentKey = "";
  let collectingArray = false;
  let arrayItems: string[] = [];

  for (const line of yamlBlock.split("\n")) {
    // Block array item: "  - value"
    if (collectingArray && /^\s+-\s+/.test(line)) {
      const val = line.replace(/^\s+-\s+/, "").trim();
      arrayItems.push(unquoteYaml(val));
      continue;
    }

    // If we were collecting array items, flush them
    if (collectingArray) {
      metadata[currentKey] = arrayItems;
      collectingArray = false;
      arrayItems = [];
    }

    // Key-value pair: "key: value"
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (!key) continue;
    currentKey = key;

    // Inline array: [a, b, c]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1);
      if (inner.trim() === "") {
        metadata[key] = [];
      } else {
        metadata[key] = inner.split(",").map((s) => unquoteYaml(s.trim()));
      }
      continue;
    }

    // Empty value — might be followed by block array
    if (rawValue === "") {
      collectingArray = true;
      arrayItems = [];
      continue;
    }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      metadata[key] = Number.parseFloat(rawValue);
      continue;
    }

    // Boolean
    if (rawValue === "true") {
      metadata[key] = true;
      continue;
    }
    if (rawValue === "false") {
      metadata[key] = false;
      continue;
    }

    // String (may be quoted)
    metadata[key] = unquoteYaml(rawValue);
  }

  // Flush trailing array
  if (collectingArray) {
    metadata[currentKey] = arrayItems;
  }

  return { metadata, body };
}

/** Remove surrounding quotes from a YAML string value */
function unquoteYaml(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Serialize metadata and body into a markdown string with YAML frontmatter.
 */
export function serializeFrontmatter(metadata: Record<string, unknown>, body: string): string {
  const lines: string[] = [FRONTMATTER_DELIM];

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${quoteYamlIfNeeded(String(item))}`);
        }
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${quoteYamlIfNeeded(String(value))}`);
    }
  }

  lines.push(FRONTMATTER_DELIM);
  lines.push(body);
  return lines.join("\n");
}

/** Quote a YAML string value if it contains special characters */
function quoteYamlIfNeeded(s: string): string {
  if (/[:#\[\]{},>|&*!%@`]/.test(s) || s.includes("\n") || s.startsWith(" ") || s.endsWith(" ")) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

// ── Page CRUD ───────────────────────────────────────────────────

/** Write a wiki page to disk as a markdown file with frontmatter */
export async function writePage(page: WikiPage): Promise<void> {
  await ensureWikiDirs();

  const metadata: Record<string, unknown> = {
    title: page.title,
    type: page.type,
    slug: page.slug,
    tags: page.tags,
    sources: page.sources,
    backlinks: page.backlinks,
    created: page.created,
    updated: page.updated,
  };
  if (page.confidence !== undefined) {
    metadata.confidence = page.confidence;
  }

  const content = serializeFrontmatter(metadata, page.content);
  const filePath = pagePath(page.slug, page.type);

  // Atomic write
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, filePath);
}

/** Read a wiki page by slug. Searches all type subdirectories. */
export async function readPage(slug: string): Promise<WikiPage | null> {
  for (const type of Object.keys(PAGE_SUBDIRS) as WikiPageType[]) {
    const filePath = pagePath(slug, type);
    try {
      const raw = await readFile(filePath, "utf-8");
      return parseWikiPage(raw, slug);
    } catch (err: any) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
  }
  return null;
}

/** Delete a wiki page by slug. Returns true if found and deleted. */
export async function deletePage(slug: string): Promise<boolean> {
  for (const type of Object.keys(PAGE_SUBDIRS) as WikiPageType[]) {
    const filePath = pagePath(slug, type);
    try {
      await rm(filePath);
      return true;
    } catch (err: any) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
  }
  return false;
}

/** List all wiki pages, optionally filtered by type and/or tag */
export async function listPages(filter?: {
  type?: WikiPageType;
  tag?: string;
}): Promise<WikiPage[]> {
  const pages: WikiPage[] = [];
  const types = filter?.type ? [filter.type] : (Object.keys(PAGE_SUBDIRS) as WikiPageType[]);

  for (const type of types) {
    const dir = pageDir(type);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err: any) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const slug = file.replace(/\.md$/, "");
      try {
        const raw = await readFile(join(dir, file), "utf-8");
        const page = parseWikiPage(raw, slug);
        if (page) {
          if (filter?.tag && !page.tags.includes(filter.tag)) continue;
          pages.push(page);
        }
      } catch {
        // Skip malformed pages
      }
    }
  }

  return pages;
}

/** Parse raw markdown+frontmatter into a WikiPage */
function parseWikiPage(raw: string, fallbackSlug: string): WikiPage | null {
  const { metadata, body } = parseFrontmatter(raw);

  const slug = (metadata.slug as string) ?? fallbackSlug;
  const title = (metadata.title as string) ?? slug;
  const type = (metadata.type as WikiPageType) ?? "entity";
  const tags = Array.isArray(metadata.tags) ? (metadata.tags as string[]) : [];
  const sources = Array.isArray(metadata.sources) ? (metadata.sources as string[]) : [];
  const backlinks = Array.isArray(metadata.backlinks) ? (metadata.backlinks as string[]) : [];
  const created = (metadata.created as string) ?? new Date().toISOString();
  const updated = (metadata.updated as string) ?? created;
  const confidence = typeof metadata.confidence === "number" ? metadata.confidence : undefined;

  return {
    slug,
    title,
    type,
    content: body,
    tags,
    sources,
    backlinks,
    created,
    updated,
    confidence,
  };
}

// ── MiniSearch BM25 ─────────────────────────────────────────────

function createMiniSearchInstance(): MiniSearch<WikiPage> {
  return new MiniSearch<WikiPage>({
    fields: ["title", "content", "tags_joined"],
    storeFields: ["slug", "title", "type", "tags", "created", "updated", "confidence"],
    searchOptions: {
      boost: { title: 2, tags_joined: 1.5 },
      fuzzy: 0.2,
      prefix: true,
    },
    idField: "slug",
    // Extract the tags as a joined string for indexing
    extractField: (doc, fieldName) => {
      if (fieldName === "tags_joined") {
        return (doc as WikiPage).tags.join(" ");
      }
      return (doc as Record<string, unknown>)[fieldName] as string;
    },
  });
}

/** Search wiki pages using BM25 via MiniSearch */
export async function searchPages(
  query: string,
  limit = 20,
): Promise<Array<{ page: WikiPage; score: number }>> {
  if (!query.trim()) return [];

  const index = await loadSearchIndex();
  const allResults = index.search(query);
  const results = allResults.slice(0, limit);

  // Load full pages for each result
  const out: Array<{ page: WikiPage; score: number }> = [];
  for (const result of results) {
    const page = await readPage(result.id as string);
    if (page) {
      out.push({ page, score: result.score });
    }
  }
  return out;
}

/** Rebuild the MiniSearch index from all pages on disk */
export async function rebuildSearchIndex(): Promise<void> {
  const pages = await listPages();
  const index = createMiniSearchInstance();
  index.addAll(pages);
  await saveSearchIndex(index);
}

/** Load the serialized MiniSearch index, or rebuild if missing */
export async function loadSearchIndex(): Promise<MiniSearch<WikiPage>> {
  try {
    const raw = await readFile(searchIndexPath(), "utf-8");
    const data = JSON.parse(raw);
    return MiniSearch.loadJSON<WikiPage>(JSON.stringify(data), {
      fields: ["title", "content", "tags_joined"],
      storeFields: ["slug", "title", "type", "tags", "created", "updated", "confidence"],
      searchOptions: {
        boost: { title: 2, tags_joined: 1.5 },
        fuzzy: 0.2,
        prefix: true,
      },
      idField: "slug",
      extractField: (doc, fieldName) => {
        if (fieldName === "tags_joined") {
          return (doc as WikiPage).tags.join(" ");
        }
        return (doc as Record<string, unknown>)[fieldName] as string;
      },
    });
  } catch {
    // Index doesn't exist or is corrupt — rebuild
    await rebuildSearchIndex();
    // Try loading again after rebuild
    try {
      const raw = await readFile(searchIndexPath(), "utf-8");
      const data = JSON.parse(raw);
      return MiniSearch.loadJSON<WikiPage>(JSON.stringify(data), {
        fields: ["title", "content", "tags_joined"],
        storeFields: ["slug", "title", "type", "tags", "created", "updated", "confidence"],
        searchOptions: {
          boost: { title: 2, tags_joined: 1.5 },
          fuzzy: 0.2,
          prefix: true,
        },
        idField: "slug",
        extractField: (doc, fieldName) => {
          if (fieldName === "tags_joined") {
            return (doc as WikiPage).tags.join(" ");
          }
          return (doc as Record<string, unknown>)[fieldName] as string;
        },
      });
    } catch {
      // Return empty index
      return createMiniSearchInstance();
    }
  }
}

/** Save the MiniSearch index to disk */
export async function saveSearchIndex(index: MiniSearch<WikiPage>): Promise<void> {
  await ensureWikiDirs();
  const data = index.toJSON();
  const filePath = searchIndexPath();
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, filePath);
}

/** Update the search index after adding/modifying a page */
async function updateSearchIndex(page: WikiPage): Promise<void> {
  const index = await loadSearchIndex();
  try {
    index.discard(page.slug);
  } catch {
    // Page wasn't in index yet
  }
  // Need to vacuum after discard to reclaim space
  index.vacuum();
  index.add(page);
  await saveSearchIndex(index);
}

/** Remove a page from the search index */
async function removeFromSearchIndex(slug: string): Promise<void> {
  const index = await loadSearchIndex();
  try {
    index.discard(slug);
    index.vacuum();
    await saveSearchIndex(index);
  } catch {
    // Page wasn't in index
  }
}

// ── Legacy compatibility layer ──────────────────────────────────
// Maps KnowledgeEntry CRUD to wiki pages internally.

/** Convert a KnowledgeEntry to a WikiPage */
function entryToPage(entry: KnowledgeEntry): WikiPage {
  const slug = entry.id;
  const now = new Date().toISOString();
  return {
    slug,
    title: entry.content.split("\n")[0].slice(0, 100) || entry.entity_type,
    type: "entity",
    content: `${entry.content}\n\n${entry.context ? `> Context: ${entry.context}\n` : ""}`,
    tags: [...entry.tags, entry.entity_type],
    sources: entry.source.session_id ? [entry.source.session_id] : [],
    backlinks: entry.references,
    created: entry.extracted_at,
    updated: entry.provenance?.last_modified ?? now,
    confidence: entry.confidence,
  };
}

/** Convert a WikiPage back to a KnowledgeEntry (best-effort) */
function pageToEntry(page: WikiPage): KnowledgeEntry {
  // Extract entity_type from tags (first matching known type)
  const knownTypes: EntityType[] = [
    "fact",
    "procedure",
    "preference",
    "relationship",
    "capability",
  ];
  const entityType: EntityType =
    (page.tags.find((t) => knownTypes.includes(t as EntityType)) as EntityType) ?? "fact";
  const tags = page.tags.filter((t) => !knownTypes.includes(t as EntityType));

  // Split content back into content + context
  const contentParts = page.content.split("\n\n> Context: ");
  const content = contentParts[0].trim();
  const context = contentParts.length > 1 ? contentParts[1].replace(/\n$/, "") : "";

  const now = new Date().toISOString();
  return {
    id: page.slug,
    source: {
      type: page.sources.length > 0 ? "session_harvest" : "manual",
      session_id: page.sources[0],
      timestamp: page.created,
    },
    extracted_at: page.created,
    confidence: page.confidence ?? 0.5,
    entity_type: entityType,
    content,
    context,
    tags,
    references: page.backlinks,
    provenance: {
      created_by: "wiki",
      created_at: page.created,
      last_modified: page.updated,
      modification_history: [{ timestamp: page.created, action: "created", by: "wiki" }],
      verified: false,
    },
  };
}

// ── Legacy CRUD (backward compatible) ───────────────────────────

/** Add a knowledge entry (creates a wiki page internally) */
export async function addEntry(entry: KnowledgeEntry): Promise<void> {
  // Check for duplicate
  const existing = await readPage(entry.id);
  if (existing) {
    throw new Error(`Entry with id "${entry.id}" already exists`);
  }

  const page = entryToPage(entry);
  await writePage(page);
  await updateSearchIndex(page);
}

/** Get a single entry by ID */
export async function getEntry(id: string): Promise<KnowledgeEntry | null> {
  const page = await readPage(id);
  if (!page) return null;
  return pageToEntry(page);
}

/** Update an entry by ID with partial data */
export async function updateEntry(id: string, updates: Partial<KnowledgeEntry>): Promise<void> {
  const page = await readPage(id);
  if (!page) {
    throw new Error(`Entry "${id}" not found`);
  }

  const existing = pageToEntry(page);
  const updated = { ...existing, ...updates, id };
  const updatedPage = entryToPage(updated);

  // Delete old page first (in case type changed)
  await deletePage(id);
  await writePage(updatedPage);
  await updateSearchIndex(updatedPage);
}

/** Delete an entry by ID */
export async function deleteEntry(id: string): Promise<void> {
  const deleted = await deletePage(id);
  if (!deleted) {
    throw new Error(`Entry "${id}" not found`);
  }
  await removeFromSearchIndex(id);
}

/** Query entries using structured filters */
export async function queryEntries(filter: KnowledgeFilter): Promise<KnowledgeEntry[]> {
  const pages = await listPages();
  let entries = pages.map(pageToEntry);

  if (filter.entity_type) {
    entries = entries.filter((e) => e.entity_type === filter.entity_type);
  }

  if (filter.tags && filter.tags.length > 0) {
    const filterTags = new Set(filter.tags);
    entries = entries.filter((e) => e.tags.some((t) => filterTags.has(t)));
  }

  if (filter.agent_id) {
    entries = entries.filter((e) => e.source.agent_id === filter.agent_id);
  }

  if (filter.min_confidence !== undefined) {
    entries = entries.filter((e) => e.confidence >= filter.min_confidence!);
  }

  if (filter.max_confidence !== undefined) {
    entries = entries.filter((e) => e.confidence <= filter.max_confidence!);
  }

  if (filter.after) {
    const afterDate = new Date(filter.after).getTime();
    entries = entries.filter((e) => new Date(e.extracted_at).getTime() >= afterDate);
  }

  if (filter.before) {
    const beforeDate = new Date(filter.before).getTime();
    entries = entries.filter((e) => new Date(e.extracted_at).getTime() <= beforeDate);
  }

  if (filter.query) {
    const q = filter.query.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.content.toLowerCase().includes(q) ||
        e.context.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  return entries;
}

/** Full-text search using MiniSearch BM25 */
export async function searchEntries(query: string): Promise<KnowledgeEntry[]> {
  if (!query.trim()) return [];

  const results = await searchPages(query, 100);
  return results.map((r) => pageToEntry(r.page));
}

/** Rebuild the wiki index from all entries (legacy compat) */
export async function rebuildIndex(): Promise<WikiIndex> {
  const pages = await listPages();
  const entries = pages.map(pageToEntry);

  const tags: Record<string, number> = {};
  const entityTypes: Record<EntityType, number> = {
    fact: 0,
    procedure: 0,
    preference: 0,
    relationship: 0,
    capability: 0,
  };
  const agentIdSet = new Set<string>();

  for (const entry of entries) {
    for (const tag of entry.tags) {
      tags[tag] = (tags[tag] ?? 0) + 1;
    }
    entityTypes[entry.entity_type] = (entityTypes[entry.entity_type] ?? 0) + 1;
    if (entry.source.agent_id) {
      agentIdSet.add(entry.source.agent_id);
    }
  }

  const index: WikiIndex = {
    version: 1,
    entry_count: entries.length,
    last_updated: new Date().toISOString(),
    tags,
    entity_types: entityTypes,
    agent_ids: Array.from(agentIdSet).sort(),
  };

  // Also rebuild the MiniSearch index
  await rebuildSearchIndex();

  return index;
}

/** Get the current wiki index */
export async function getIndex(): Promise<WikiIndex> {
  return rebuildIndex();
}

/** Get all entries */
export async function getAllEntries(): Promise<KnowledgeEntry[]> {
  const pages = await listPages();
  return pages.map(pageToEntry);
}
