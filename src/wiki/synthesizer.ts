/**
 * Knowledge synthesis engine (ADR-0020).
 *
 * Uses MiniSearch BM25 for retrieval, wiki page generation with frontmatter,
 * gap identification, and agent briefings.
 */

import { entityToSlug, extractEntities, generateWikilinks } from "./ner";
import { listPages, queryEntries, searchEntries, searchPages } from "./storage";
import type { KnowledgeEntry, WikiPage } from "./types";

// ── Public API ──────────────────────────────────────────────────

/**
 * Retrieve top-K relevant entries for a query and format as a context block.
 * Uses MiniSearch BM25 for retrieval instead of TF-IDF.
 */
export async function synthesizeContext(
  query: string,
  options?: { agentId?: string; topK?: number },
): Promise<string> {
  const topK = options?.topK ?? 10;

  // Use MiniSearch BM25 for primary retrieval
  const searchResults = await searchPages(query, topK * 2);

  // Also get query-matching entries.
  let entries = await searchEntries(query);

  // When agentId is set, reserve a portion of the topK budget for off-query
  // agent-scoped entries so they aren't squeezed out by high-ranking BM25
  // page hits. Default reservation: up to 1/3 of the budget.
  const agentReservedBudget =
    options?.agentId !== undefined ? Math.max(1, Math.floor(topK / 3)) : 0;

  let agentOnlyEntries: KnowledgeEntry[] = [];
  if (options?.agentId) {
    const agentEntries = await queryEntries({ agent_id: options.agentId });
    const searchIds = new Set(entries.map((e) => e.id));
    // Entries scoped to the agent that did NOT match the query — these are
    // the ones that need a reserved budget slot. Query-matching agent
    // entries are already in `entries`.
    agentOnlyEntries = agentEntries.filter((e) => !searchIds.has(e.id));
    // Keep `entries` as the union so downstream rendering can still iterate it.
    entries = [...entries, ...agentOnlyEntries];
  }

  if (entries.length === 0 && searchResults.length === 0) {
    return `No knowledge found for: "${query}"`;
  }

  // Format as context block (using search results for ranking)
  const lines: string[] = [];
  lines.push(`## Relevant Knowledge: "${query}"`);
  lines.push("");

  // Cap BM25 page results so agent-scoped off-query entries have a
  // reserved budget. When agentId is unset, agentReservedBudget is 0
  // and searchResults get the full topK as before.
  const pagesBudget = topK - agentReservedBudget;

  const seen = new Set<string>();
  let count = 0;

  for (const { page, score } of searchResults) {
    if (count >= pagesBudget) break;
    if (seen.has(page.slug)) continue;
    seen.add(page.slug);
    count++;

    const confidenceLabel =
      (page.confidence ?? 0.5) >= 0.7 ? "high" : (page.confidence ?? 0.5) >= 0.4 ? "medium" : "low";
    lines.push(`### ${page.title} (confidence: ${confidenceLabel})`);
    lines.push("");
    // Truncate content for context
    const preview = page.content.slice(0, 500);
    lines.push(preview);
    if (page.tags.length > 0) {
      lines.push("");
      lines.push(`Tags: ${page.tags.join(", ")}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // Iterate entries in the order: agent-only first (so the reserved
  // agentReservedBudget goes to them), then query-matched entries.
  // When agentId is unset, agentOnlyEntries is empty and this iterates
  // entries in their original order.
  const agentOnlyIds = new Set(agentOnlyEntries.map((e) => e.id));
  const orderedEntries = [
    ...entries.filter((e) => agentOnlyIds.has(e.id)),
    ...entries.filter((e) => !agentOnlyIds.has(e.id)),
  ];

  for (const entry of orderedEntries) {
    if (count >= topK) break;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    count++;

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
 * Generate a structured markdown wiki page from knowledge entries.
 * Produces proper markdown with YAML frontmatter structure.
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
 */
export function identifyGaps(
  entries: KnowledgeEntry[],
  agentId?: string,
): Array<{ area: string; confidence: number; suggestion: string }> {
  const gaps: Array<{ area: string; confidence: number; suggestion: string }> = [];

  const filtered = agentId ? entries.filter((e) => e.source.agent_id === agentId) : entries;

  if (filtered.length === 0) {
    gaps.push({
      area: "No knowledge entries",
      confidence: 0,
      suggestion: "Run 'am wiki ingest' to extract knowledge from sessions.",
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
        suggestion: `No ${type} entries found. Consider ingesting more sessions or adding manual entries.`,
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
        "More than half of entries have low confidence. Verify key entries or ingest additional sessions for corroboration.",
    });
  }

  // Check for entries without references (isolated knowledge)
  const unreferenced = filtered.filter((e) => e.references.length === 0);
  if (unreferenced.length > filtered.length * 0.8) {
    gaps.push({
      area: "Isolated entries",
      confidence: 0.3,
      suggestion:
        "Most entries have no cross-references. Consider linking related entries to build the knowledge graph.",
    });
  }

  // Check for stale entries (older than 30 days)
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const stale = filtered.filter((e) => new Date(e.extracted_at).getTime() < thirtyDaysAgo);
  if (stale.length > 0 && stale.length > filtered.length * 0.5) {
    gaps.push({
      area: "Stale knowledge",
      confidence: 0.4,
      suggestion: `${stale.length} entries are older than 30 days. Ingest recent sessions to refresh the knowledge base.`,
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
 */
export function buildAgentBriefing(entries: KnowledgeEntry[], agentId: string): string {
  const agentEntries = entries.filter((e) => e.source.agent_id === agentId);
  const allEntries = entries;

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
