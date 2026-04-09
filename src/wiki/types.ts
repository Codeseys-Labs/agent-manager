/**
 * Knowledge schema types for the LLM Wiki / Knowledge Synthesis system (ADR-0020).
 *
 * Defines the core data model: knowledge entries, sources, provenance tracking,
 * filters, and the wiki index structure.
 */

// ── Knowledge Entry ─────────────────────────────────────────────

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
