/**
 * Knowledge synthesis engine (ADR-0020, Phase 1).
 *
 * Provides TF-IDF-like relevance scoring, context generation,
 * wiki page generation, gap identification, and agent briefings.
 */

import { queryEntries, searchEntries } from "./storage";
import type { KnowledgeEntry } from "./types";

// ── TF-IDF–like Scoring ─────────────────────────────────────────

/** Tokenize text into lowercase words (alphanumeric, 2+ chars). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
}

/** Build a term frequency map from a list of tokens. */
function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

/**
 * Score an entry against a query using TF-IDF-like overlap scoring.
 * Higher scores indicate more relevance.
 */
function scoreEntry(
  queryTokens: string[],
  entry: KnowledgeEntry,
  idf: Map<string, number>,
): number {
  const entryTokens = new Set(tokenize(`${entry.content} ${entry.context}`));
  let score = 0;

  for (const qt of queryTokens) {
    if (entryTokens.has(qt)) {
      score += idf.get(qt) ?? 1;
    }
  }

  // Boost by confidence
  score *= 0.5 + entry.confidence * 0.5;

  return score;
}

/**
 * Build an IDF (inverse document frequency) map from a set of entries.
 * IDF = log(N / df) where N is total docs and df is docs containing the term.
 */
function buildIdf(entries: KnowledgeEntry[]): Map<string, number> {
  const N = entries.length;
  if (N === 0) return new Map();

  const df = new Map<string, number>();
  for (const entry of entries) {
    const uniqueTokens = new Set(tokenize(`${entry.content} ${entry.context}`));
    for (const token of uniqueTokens) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log(N / freq) + 1);
  }
  return idf;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Retrieve top-K relevant entries for a query and format as a context block.
 * Used to inject relevant knowledge into future agent sessions.
 */
export async function synthesizeContext(
  query: string,
  options?: { agentId?: string; topK?: number },
): Promise<string> {
  const topK = options?.topK ?? 10;

  // Get candidate entries, optionally filtered by agent
  let entries = await searchEntries(query);

  if (options?.agentId) {
    const agentEntries = await queryEntries({ agent_id: options.agentId });
    // Merge: prioritize search results but include agent-specific entries
    const searchIds = new Set(entries.map((e) => e.id));
    const extra = agentEntries.filter((e) => !searchIds.has(e.id));
    entries = [...entries, ...extra];
  }

  if (entries.length === 0) {
    return `No knowledge found for: "${query}"`;
  }

  // Build IDF and score
  const idf = buildIdf(entries);
  const queryTokens = tokenize(query);

  const scored = entries
    .map((entry) => ({
      entry,
      score: scoreEntry(queryTokens, entry, idf),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // Format as context block
  const lines: string[] = [];
  lines.push(`## Relevant Knowledge: "${query}"`);
  lines.push("");

  for (const { entry, score } of scored) {
    const confidenceLabel =
      entry.confidence >= 0.7 ? "high" : entry.confidence >= 0.4 ? "medium" : "low";
    lines.push(`### ${entry.entity_type} (confidence: ${confidenceLabel})`);
    lines.push("");
    lines.push(entry.content);
    if (entry.context) {
      lines.push("");
      lines.push(`> Context: ${entry.context}`);
    }
    if (entry.tags.length > 0) {
      lines.push("");
      lines.push(`Tags: ${entry.tags.join(", ")}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Aggregate knowledge entries into a structured markdown wiki page.
 */
export function generateWikiPage(topic: string, entries: KnowledgeEntry[]): string {
  if (entries.length === 0) {
    return `# ${topic}\n\nNo knowledge entries found for this topic.\n`;
  }

  const lines: string[] = [];
  lines.push(`# ${topic}`);
  lines.push("");
  lines.push(`> Auto-generated wiki page from ${entries.length} knowledge entries.`);
  lines.push(`> Last updated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");

  // Group entries by entity type
  const grouped = new Map<string, KnowledgeEntry[]>();
  for (const entry of entries) {
    const group = grouped.get(entry.entity_type) ?? [];
    group.push(entry);
    grouped.set(entry.entity_type, group);
  }

  // Section order
  const sectionOrder = ["fact", "procedure", "preference", "capability", "relationship"] as const;
  const sectionTitles: Record<string, string> = {
    fact: "Facts",
    procedure: "Procedures",
    preference: "Preferences",
    capability: "Capabilities",
    relationship: "Relationships",
  };

  for (const type of sectionOrder) {
    const group = grouped.get(type);
    if (!group || group.length === 0) continue;

    // Sort by confidence (highest first)
    group.sort((a, b) => b.confidence - a.confidence);

    lines.push(`## ${sectionTitles[type]}`);
    lines.push("");

    for (const entry of group) {
      const confidenceLabel =
        entry.confidence >= 0.7 ? "HIGH" : entry.confidence >= 0.4 ? "MED" : "LOW";
      lines.push(`- **[${confidenceLabel}]** ${entry.content.split("\n")[0]}`);
      if (entry.context) {
        lines.push(`  > ${entry.context.split("\n")[0]}`);
      }
      if (entry.source.session_id) {
        lines.push(`  _Source: ${entry.source.session_id}_`);
      }
      lines.push("");
    }
  }

  // Tags summary
  const allTags = new Set<string>();
  for (const entry of entries) {
    for (const tag of entry.tags) allTags.add(tag);
  }
  if (allTags.size > 0) {
    lines.push("## Tags");
    lines.push("");
    lines.push(Array.from(allTags).sort().join(", "));
    lines.push("");
  }

  // Sources
  const sources = new Set<string>();
  for (const entry of entries) {
    if (entry.source.session_id) sources.add(entry.source.session_id);
  }
  if (sources.size > 0) {
    lines.push("## Sources");
    lines.push("");
    for (const src of sources) {
      lines.push(`- ${src}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Identify knowledge gaps based on existing entries.
 * Looks for areas with low coverage, low confidence, or missing connections.
 */
export function identifyGaps(
  entries: KnowledgeEntry[],
  agentId?: string,
): Array<{ area: string; confidence: number; suggestion: string }> {
  const gaps: Array<{ area: string; confidence: number; suggestion: string }> = [];

  // Filter to agent if specified
  const filtered = agentId ? entries.filter((e) => e.source.agent_id === agentId) : entries;

  if (filtered.length === 0) {
    gaps.push({
      area: "No knowledge entries",
      confidence: 0,
      suggestion: "Run 'am wiki harvest' to extract knowledge from sessions.",
    });
    return gaps;
  }

  // Check entity type distribution
  const typeCounts: Record<string, number> = {};
  for (const entry of filtered) {
    typeCounts[entry.entity_type] = (typeCounts[entry.entity_type] ?? 0) + 1;
  }

  const expectedTypes = ["fact", "procedure", "preference", "capability", "relationship"];
  for (const type of expectedTypes) {
    if (!typeCounts[type] || typeCounts[type] === 0) {
      gaps.push({
        area: `Missing ${type} entries`,
        confidence: 0,
        suggestion: `No ${type} entries found. Consider harvesting more sessions or adding manual entries.`,
      });
    }
  }

  // Check for low-confidence clusters
  const lowConfidence = filtered.filter((e) => e.confidence < 0.4);
  if (lowConfidence.length > filtered.length * 0.5) {
    gaps.push({
      area: "Low overall confidence",
      confidence: lowConfidence.reduce((sum, e) => sum + e.confidence, 0) / lowConfidence.length,
      suggestion:
        "More than half of entries have low confidence. Verify key entries or harvest additional sessions for corroboration.",
    });
  }

  // Check for entries without references (isolated knowledge)
  const unreferenced = filtered.filter((e) => e.references.length === 0);
  if (unreferenced.length > filtered.length * 0.8) {
    gaps.push({
      area: "Isolated entries",
      confidence: 0.3,
      suggestion:
        "Most entries have no cross-references. Consider linking related entries to build a knowledge graph.",
    });
  }

  // Check for stale entries (older than 30 days)
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const stale = filtered.filter((e) => new Date(e.extracted_at).getTime() < thirtyDaysAgo);
  if (stale.length > 0 && stale.length > filtered.length * 0.5) {
    gaps.push({
      area: "Stale knowledge",
      confidence: 0.4,
      suggestion: `${stale.length} entries are older than 30 days. Harvest recent sessions to refresh the knowledge base.`,
    });
  }

  // Check for tags with very few entries
  const tagCounts = new Map<string, number>();
  for (const entry of filtered) {
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const sparseTopics = Array.from(tagCounts.entries())
    .filter(([_, count]) => count === 1)
    .map(([tag]) => tag);
  if (sparseTopics.length > 3) {
    gaps.push({
      area: "Sparse topics",
      confidence: 0.3,
      suggestion: `${sparseTopics.length} topics have only 1 entry each: ${sparseTopics.slice(0, 5).join(", ")}${sparseTopics.length > 5 ? "..." : ""}. These may need more coverage.`,
    });
  }

  return gaps;
}

/**
 * Produce a markdown briefing document for a specific agent.
 * Includes relevant knowledge, capabilities, preferences, and gaps.
 */
export function buildAgentBriefing(entries: KnowledgeEntry[], agentId: string): string {
  const agentEntries = entries.filter((e) => e.source.agent_id === agentId);
  const allEntries = entries; // Keep reference to full set

  const lines: string[] = [];
  lines.push(`# Agent Briefing: ${agentId}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`Total entries from this agent: ${agentEntries.length}`);
  lines.push(`Total knowledge base entries: ${allEntries.length}`);
  lines.push("");

  // High-confidence facts
  const highConfFacts = agentEntries
    .filter((e) => e.entity_type === "fact" && e.confidence >= 0.6)
    .sort((a, b) => b.confidence - a.confidence);

  if (highConfFacts.length > 0) {
    lines.push("## Key Facts");
    lines.push("");
    for (const fact of highConfFacts.slice(0, 10)) {
      lines.push(`- ${fact.content.split("\n")[0]}`);
    }
    lines.push("");
  }

  // Procedures
  const procedures = agentEntries
    .filter((e) => e.entity_type === "procedure")
    .sort((a, b) => b.confidence - a.confidence);

  if (procedures.length > 0) {
    lines.push("## Known Procedures");
    lines.push("");
    for (const proc of procedures.slice(0, 10)) {
      lines.push(`- ${proc.content.split("\n")[0]}`);
    }
    lines.push("");
  }

  // User preferences (from all entries, not just this agent)
  const preferences = allEntries
    .filter((e) => e.entity_type === "preference")
    .sort((a, b) => b.confidence - a.confidence);

  if (preferences.length > 0) {
    lines.push("## User Preferences");
    lines.push("");
    for (const pref of preferences.slice(0, 10)) {
      lines.push(`- ${pref.content.split("\n")[0]}`);
    }
    lines.push("");
  }

  // Capabilities
  const capabilities = agentEntries
    .filter((e) => e.entity_type === "capability")
    .sort((a, b) => b.confidence - a.confidence);

  if (capabilities.length > 0) {
    lines.push("## Capabilities Used");
    lines.push("");
    for (const cap of capabilities.slice(0, 10)) {
      lines.push(`- ${cap.content.split("\n")[0]}`);
    }
    lines.push("");
  }

  // Gaps
  const gaps = identifyGaps(allEntries, agentId);
  if (gaps.length > 0) {
    lines.push("## Knowledge Gaps");
    lines.push("");
    for (const gap of gaps) {
      lines.push(`- **${gap.area}**: ${gap.suggestion}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
