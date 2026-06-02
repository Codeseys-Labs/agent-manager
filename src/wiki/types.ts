/**
 * Knowledge schema types for the LLM Wiki / Knowledge Synthesis system (ADR-0020).
 *
 * Defines the core data model: knowledge entries, wiki pages (Karpathy llm-wiki pattern),
 * extracted entities from NER, the knowledge graph, filters, and the wiki index structure.
 */

// ── Wiki Page (Karpathy llm-wiki pattern) ───────────────────────

/**
 * Page confidence as the ADR-0020-specified enum. Replaces the previous raw
 * `number` (0.0-1.0) representation (ADR-0054 R4). Legacy numeric values are
 * normalised on read via {@link normalizeConfidence} / scoreToConfidence —
 * never stored as numbers again.
 *
 * Buckets (matches scoreToConfidence): score >= 0.7 → "high",
 * score >= 0.4 → "medium", otherwise → "low".
 */
export type WikiConfidence = "low" | "medium" | "high";

/** Wiki page with YAML frontmatter (Karpathy llm-wiki pattern) */
export interface WikiPage {
  slug: string; // filename without .md extension
  title: string;
  type: WikiPageType;
  content: string; // markdown body (after frontmatter)
  tags: string[];
  sources: string[]; // raw source references
  backlinks: string[]; // slugs of pages linking to this one
  created: string; // ISO8601
  updated: string; // ISO8601
  // ADR-0020 frontmatter schema. The canonical representation is the
  // {@link WikiConfidence} enum (ADR-0054 R4 changed this from a raw 0.0-1.0
  // `number`). `writePage` always serialises the enum and `parseWikiPage`
  // always normalises reads to it (via {@link normalizeConfidence}), so on disk
  // and on every read path this is the enum. The `number` arm is retained ONLY
  // as a transitional input type so pre-R4 producers (the legacy
  // `KnowledgeEntry` CRUD layer, numeric callers) keep compiling — it is
  // normalised away the moment a page is written or read. Prefer the enum.
  confidence?: WikiConfidence | number;
  // ── ADR-0020 §"Frontmatter Schema" fields (added in ADR-0054 R4) ──
  // Cross-reference slugs auto-derived from NER + harvest. Enables the
  // contradiction-handling and entity-index features ADR-0020 specs.
  entities?: string[];
  // Count of corroborating sessions (coverage). Higher → more trustworthy.
  coverage?: number;
  // Slug of the page this one replaces (newer fact supersedes older).
  supersedes?: string;
  // Slug of the page that replaced this one. Set on the stale page so reads
  // can surface "this was superseded by X" instead of deleting history.
  superseded_by?: string;
  // Persisted in frontmatter so agent-scoped queries (queryEntries
  // filter.agent_id, synthesizeContext agentId) survive the page round-trip.
  // Absent for manually-authored pages. (Added 2026-05-01 for task #31.)
  agent_id?: string;
}

// ── Confidence normalisation (ADR-0054 R4 one-time migration) ───

/** Confidence bucket thresholds, shared by score↔enum conversions. */
const CONFIDENCE_HIGH_THRESHOLD = 0.7;
const CONFIDENCE_MEDIUM_THRESHOLD = 0.4;

/**
 * Map a legacy numeric confidence (0.0-1.0) onto the ADR-0020 enum bucket.
 * Out-of-range numbers are clamped by the threshold comparisons.
 */
export function scoreToConfidence(score: number): WikiConfidence {
  if (score >= CONFIDENCE_HIGH_THRESHOLD) return "high";
  if (score >= CONFIDENCE_MEDIUM_THRESHOLD) return "medium";
  return "low";
}

/**
 * Map the ADR-0020 confidence enum back to a representative numeric score, for
 * the legacy `KnowledgeEntry` CRUD layer (which still uses 0.0-1.0) and any
 * numeric ranking. Bucket midpoints, so a round-trip is stable.
 */
export function confidenceToScore(confidence: WikiConfidence): number {
  switch (confidence) {
    case "high":
      return 0.85;
    case "medium":
      return 0.55;
    default:
      return 0.2;
  }
}

/**
 * One-time read-path normalisation for the ADR-0054 R4 schema change. Accepts
 * whatever a page's `confidence` frontmatter currently holds — a number (pre-R4
 * pages), one of the enum strings (post-R4 pages), or undefined — and returns
 * the canonical enum value (or undefined when absent/unrecognised). This keeps
 * existing pages readable without a destructive migration pass.
 */
export function normalizeConfidence(value: unknown): WikiConfidence | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return undefined;
    return scoreToConfidence(value);
  }
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "high" || lower === "medium" || lower === "low") {
      return lower as WikiConfidence;
    }
    // Tolerate a numeric string that slipped into frontmatter.
    const parsed = Number.parseFloat(lower);
    if (!Number.isNaN(parsed)) return scoreToConfidence(parsed);
  }
  return undefined;
}

export type WikiPageType = "entity" | "concept" | "summary" | "synthesis" | "decision";

// ── Named Entity Recognition ────────────────────────────────────

/** Extracted entity from NER pipeline */
export interface ExtractedEntity {
  text: string;
  type: EntityCategory;
  span: [number, number]; // character offsets in source text
}

export type EntityCategory =
  | "file_path"
  | "package_name"
  | "config_key"
  | "cli_command"
  | "function_name"
  | "url"
  | "tool_name"
  | "person"
  | "concept";

// ── Knowledge Graph ─────────────────────────────────────────────

/** Edge in the entity/knowledge graph */
export interface GraphEdge {
  from: string; // slug
  to: string; // slug
  type: "wikilink" | "backlink" | "entity_mention" | "related";
  weight: number; // 0.0-1.0
}

/** The full graph stored as JSON */
export interface KnowledgeGraph {
  nodes: Record<string, { slug: string; title: string; type: WikiPageType; tags: string[] }>;
  edges: GraphEdge[];
  updated: string;
}

// ── Cross-project meta-index (ADR-0054 R5) ──────────────────────
//
// A committed `wiki/meta-index.json` keyed by entity / tag / slug → the list
// of `{project, slug, confidence}` pointers that carry that key, so
// `am wiki search --all-projects` can fan a query across every known project
// wiki plus the global store without opening every page. It is rebuilt on
// `am wiki sync` and on demand (never on every page write — too expensive
// across projects). Like `index.json` / `graph.json`, it is git-diffable JSON
// (ADR-0002), so the web UI can read it the same way.

/** A single pointer into a project (or the global) wiki for a meta-index key. */
export interface MetaIndexEntry {
  /** Project name (under `wiki/projects/<project>/`) or "global". */
  project: string;
  /** Page slug within that wiki tier. */
  slug: string;
  /** Page title, for display without opening the page. */
  title: string;
  /** Page type, for display / filtering. */
  type: WikiPageType;
  /** Normalised confidence (low|medium|high), absent when the page set none. */
  confidence?: WikiConfidence;
}

/**
 * Committed cross-project meta-index. Three keyed maps (slug / tag / entity)
 * each map a normalised key → the pointers that carry it. A page contributes
 * one pointer to its own slug, one per tag, and one per declared `entities`
 * cross-reference. Empty maps are valid (an empty wiki).
 */
export interface MetaIndex {
  /** Schema version, for forward-compat migrations. */
  version: number;
  /** ISO8601 timestamp of the last rebuild. */
  updated: string;
  /** Project names contributing to this index (sorted), excluding "global". */
  projects: string[];
  /** slug → pointers (a slug may exist in more than one project). */
  bySlug: Record<string, MetaIndexEntry[]>;
  /** tag → pointers. */
  byTag: Record<string, MetaIndexEntry[]>;
  /** entity cross-reference slug → pointers. */
  byEntity: Record<string, MetaIndexEntry[]>;
}

// ── Knowledge Entry (legacy, still used by CRUD layer) ──────────

export interface KnowledgeEntry {
  id: string; // UUID v4
  source: KnowledgeSource;
  extracted_at: string; // ISO8601
  confidence: number; // 0.0–1.0
  entity_type: EntityType;
  content: string;
  context: string;
  tags: string[];
  references: string[]; // IDs of related entries
  provenance: Provenance;
}

export type EntityType = "fact" | "procedure" | "preference" | "relationship" | "capability";

// ── Knowledge Source ────────────────────────────────────────────

export interface KnowledgeSource {
  type: "session_harvest" | "manual" | "import" | "inference";
  session_id?: string;
  agent_id?: string;
  file_path?: string;
  timestamp: string; // ISO8601
}

// ── Provenance Tracking ─────────────────────────────────────────

export interface Provenance {
  created_by: string;
  created_at: string; // ISO8601
  last_modified: string; // ISO8601
  modification_history: ModificationRecord[];
  verified: boolean;
  verification_source?: string;
}

export interface ModificationRecord {
  timestamp: string; // ISO8601
  action: "created" | "updated" | "merged" | "verified";
  by: string;
  details?: string;
}

// ── Filters ─────────────────────────────────────────────────────

export interface KnowledgeFilter {
  entity_type?: EntityType;
  tags?: string[];
  agent_id?: string;
  min_confidence?: number;
  max_confidence?: number;
  after?: string; // ISO8601
  before?: string; // ISO8601
  query?: string; // Full-text search
}

// ── Wiki Index ──────────────────────────────────────────────────

export interface WikiIndex {
  version: number;
  entry_count: number;
  last_updated: string; // ISO8601
  tags: Record<string, number>; // tag -> count
  entity_types: Record<EntityType, number>; // type -> count
  agent_ids: string[];
}
