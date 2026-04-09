/**
 * JSON-based knowledge storage with atomic writes (ADR-0020, Phase 1).
 *
 * Stores knowledge entries at ~/.config/agent-manager/wiki/knowledge.json
 * with an index at ~/.config/agent-manager/wiki/index.json.
 * Uses write-to-temp-then-rename for atomic file operations.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveConfigDir } from "../core/config";
import type { EntityType, KnowledgeEntry, KnowledgeFilter, WikiIndex } from "./types";

// ── Paths ───────────────────────────────────────────────────────

function wikiDir(): string {
  return join(resolveConfigDir(), "wiki");
}

function knowledgePath(): string {
  return join(wikiDir(), "knowledge.json");
}

function indexPath(): string {
  return join(wikiDir(), "index.json");
}

// ── Atomic File Operations ──────────────────────────────────────

async function ensureWikiDir(): Promise<void> {
  await mkdir(wikiDir(), { recursive: true });
}

/** Write JSON atomically: write to .tmp file, then rename over target. */
async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, path);
}

// ── Internal Loaders ────────────────────────────────────────────

async function loadEntries(): Promise<KnowledgeEntry[]> {
  try {
    const raw = await readFile(knowledgePath(), "utf-8");
    return JSON.parse(raw) as KnowledgeEntry[];
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

async function saveEntries(entries: KnowledgeEntry[]): Promise<void> {
  await ensureWikiDir();
  await atomicWriteJson(knowledgePath(), entries);
}

async function loadIndex(): Promise<WikiIndex> {
  try {
    const raw = await readFile(indexPath(), "utf-8");
    return JSON.parse(raw) as WikiIndex;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return emptyIndex();
    }
    throw err;
  }
}

async function saveIndex(index: WikiIndex): Promise<void> {
  await ensureWikiDir();
  await atomicWriteJson(indexPath(), index);
}

function emptyIndex(): WikiIndex {
  return {
    version: 1,
    entry_count: 0,
    last_updated: new Date().toISOString(),
    tags: {},
    entity_types: { fact: 0, procedure: 0, preference: 0, relationship: 0, capability: 0 },
    agent_ids: [],
  };
}

// ── CRUD Operations ─────────────────────────────────────────────

/** Add a knowledge entry and update the index. */
export async function addEntry(entry: KnowledgeEntry): Promise<void> {
  const entries = await loadEntries();

  // Check for duplicate ID
  if (entries.some((e) => e.id === entry.id)) {
    throw new Error(`Entry with id "${entry.id}" already exists`);
  }

  entries.push(entry);
  await saveEntries(entries);
  await rebuildIndex();
}

/** Get a single entry by ID. */
export async function getEntry(id: string): Promise<KnowledgeEntry | null> {
  const entries = await loadEntries();
  return entries.find((e) => e.id === id) ?? null;
}

/** Update an entry by ID with partial data. */
export async function updateEntry(id: string, updates: Partial<KnowledgeEntry>): Promise<void> {
  const entries = await loadEntries();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) {
    throw new Error(`Entry "${id}" not found`);
  }

  // Merge updates, preserving the ID
  entries[idx] = { ...entries[idx], ...updates, id };
  await saveEntries(entries);
  await rebuildIndex();
}

/** Delete an entry by ID. */
export async function deleteEntry(id: string): Promise<void> {
  const entries = await loadEntries();
  const filtered = entries.filter((e) => e.id !== id);
  if (filtered.length === entries.length) {
    throw new Error(`Entry "${id}" not found`);
  }

  await saveEntries(filtered);
  await rebuildIndex();
}

// ── Query & Search ──────────────────────────────────────────────

/** Query entries using structured filters. */
export async function queryEntries(filter: KnowledgeFilter): Promise<KnowledgeEntry[]> {
  let entries = await loadEntries();

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

/**
 * Full-text search over content + context using tokenized matching.
 * Tokenizes the query into words, then scores entries by the fraction
 * of query tokens found in the entry's content or context.
 * Returns entries sorted by relevance (highest first).
 */
export async function searchEntries(query: string): Promise<KnowledgeEntry[]> {
  const entries = await loadEntries();
  if (entries.length === 0 || !query.trim()) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return [];

  const scored = entries
    .map((entry) => {
      const contentTokens = tokenize(`${entry.content} ${entry.context}`);
      let matchCount = 0;
      for (const qt of queryTokens) {
        if (contentTokens.has(qt)) matchCount++;
      }
      const score = matchCount / queryTokens.size;
      return { entry, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((s) => s.entry);
}

/** Tokenize a string into a set of lowercase words (alphanumeric, 2+ chars). */
function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
  return new Set(words);
}

// ── Index Management ────────────────────────────────────────────

/** Rebuild the wiki index from all entries. */
export async function rebuildIndex(): Promise<WikiIndex> {
  const entries = await loadEntries();

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
    // Count tags
    for (const tag of entry.tags) {
      tags[tag] = (tags[tag] ?? 0) + 1;
    }

    // Count entity types
    entityTypes[entry.entity_type] = (entityTypes[entry.entity_type] ?? 0) + 1;

    // Collect agent IDs
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

  await saveIndex(index);
  return index;
}

/** Get the current wiki index (read-only, no rebuild). */
export async function getIndex(): Promise<WikiIndex> {
  return loadIndex();
}

/** Get all entries (for export). */
export async function getAllEntries(): Promise<KnowledgeEntry[]> {
  return loadEntries();
}
