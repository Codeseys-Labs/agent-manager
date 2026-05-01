/**
 * Knowledge schema types for the LLM Wiki / Knowledge Synthesis system (ADR-0020).
 *
 * Defines the core data model: knowledge entries, wiki pages (Karpathy llm-wiki pattern),
 * extracted entities from NER, the knowledge graph, filters, and the wiki index structure.
 */

// ── Wiki Page (Karpathy llm-wiki pattern) ───────────────────────

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
  confidence?: number; // 0.0-1.0 for auto-generated pages
  // Persisted in frontmatter so agent-scoped queries (queryEntries
  // filter.agent_id, synthesizeContext agentId) survive the page round-trip.
  // Absent for manually-authored pages. (Added 2026-05-01 for task #31.)
  agent_id?: string;
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
  embeddings?: number[];
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
