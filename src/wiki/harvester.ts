/**
 * Session knowledge extractor (ADR-0020).
 *
 * Parses harvested session data and extracts knowledge entries using
 * pattern matching. Produces WikiPage objects for the markdown-file storage.
 * Implements confidence scoring and deduplication via Jaccard similarity.
 */

import type { Message, Session, ToolCall } from "../core/session";
import { entityToSlug, extractEntities } from "./ner";
import { getAllEntries, listPages, readPage, writePage } from "./storage";
import type { EntityType, KnowledgeEntry, KnowledgeSource, Provenance, WikiPage } from "./types";

// ── String Similarity ───────────────────────────────────────────

/**
 * Compute Jaccard similarity between two strings based on word tokens.
 * Returns a value between 0.0 (no overlap) and 1.0 (identical token sets).
 */
export function stringSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

  let intersectionSize = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersectionSize++;
  }

  const unionSize = new Set([...tokensA, ...tokensB]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/** Tokenize a string into a set of lowercase words (alphanumeric, 2+ chars). */
function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
  return new Set(words);
}

// ── Entry Factory ───────────────────────────────────────────────

function makeEntry(
  entityType: EntityType,
  content: string,
  context: string,
  tags: string[],
  source: KnowledgeSource,
  confidence: number,
): KnowledgeEntry {
  const now = new Date().toISOString();
  const provenance: Provenance = {
    created_by: "harvester",
    created_at: now,
    last_modified: now,
    modification_history: [
      {
        timestamp: now,
        action: "created",
        by: "harvester",
        details: `Extracted from session ${source.session_id ?? "unknown"}`,
      },
    ],
    verified: false,
  };

  return {
    id: crypto.randomUUID(),
    source,
    extracted_at: now,
    confidence: Math.min(1.0, Math.max(0.0, confidence)),
    entity_type: entityType,
    content,
    context,
    tags,
    references: [],
    provenance,
  };
}

// ── WikiPage Factory ────────────────────────────────────────────

/**
 * Convert a KnowledgeEntry to a WikiPage for markdown-file storage.
 */
function entryToWikiPage(entry: KnowledgeEntry): WikiPage {
  const now = new Date().toISOString();

  // Build markdown content
  const lines: string[] = [];
  lines.push(entry.content);
  if (entry.context) {
    lines.push("");
    lines.push(`> Context: ${entry.context}`);
  }

  // Extract entities from content for auto-linking
  const entities = extractEntities(entry.content);
  if (entities.length > 0) {
    lines.push("");
    lines.push("## Extracted Entities");
    lines.push("");
    for (const ent of entities) {
      lines.push(`- \`${ent.text}\` (${ent.type})`);
    }
  }

  return {
    slug: entry.id,
    title: entry.content.split("\n")[0].slice(0, 100) || entry.entity_type,
    type: "entity",
    content: lines.join("\n"),
    tags: [...entry.tags, entry.entity_type],
    sources: entry.source.session_id ? [entry.source.session_id] : [],
    backlinks: entry.references,
    created: entry.extracted_at,
    updated: now,
    confidence: entry.confidence,
  };
}

// ── Pattern Extractors ──────────────────────────────────────────

/**
 * Extract procedure entries from commands run and their outcomes.
 */
function extractProcedures(messages: Message[], source: KnowledgeSource): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];

  for (const msg of messages) {
    if (!msg.toolCalls) continue;

    for (const tc of msg.toolCalls) {
      const isCommand = /^(bash|exec|shell|run|terminal|command)/i.test(tc.name);
      const isFileOp = /^(write|read|edit|create|delete|glob|grep)/i.test(tc.name);

      if (isCommand || isFileOp) {
        const inputStr = typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? "");
        const outputStr = tc.output ?? "";
        const content = `Command: ${tc.name}\nInput: ${inputStr.slice(0, 500)}`;
        const context = outputStr.slice(0, 500);

        entries.push(makeEntry("procedure", content, context, ["command", tc.name], source, 0.5));
      }
    }
  }

  return entries;
}

/**
 * Extract error/resolution pairs.
 */
function extractErrorResolutions(messages: Message[], source: KnowledgeSource): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const errorPatterns =
    /\b(error|exception|failed|failure|traceback|panic|fatal|ENOENT|EACCES|EPERM)\b/i;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!errorPatterns.test(msg.content)) continue;

    const errorSnippet = msg.content.slice(0, 300);
    entries.push(
      makeEntry(
        "fact",
        `Error encountered: ${errorSnippet}`,
        `Role: ${msg.role}, position: message ${i + 1}`,
        ["error"],
        source,
        0.5,
      ),
    );

    // Look for resolution in subsequent assistant messages (within 5 messages)
    for (let j = i + 1; j < Math.min(i + 6, messages.length); j++) {
      const next = messages[j];
      if (next.role === "assistant" && next.content.length > 20) {
        const resolutionSnippet = next.content.slice(0, 500);
        entries.push(
          makeEntry(
            "procedure",
            `Resolution for: ${errorSnippet}\n\nFix: ${resolutionSnippet}`,
            `Error at message ${i + 1}, resolution at message ${j + 1}`,
            ["error-resolution", "troubleshooting"],
            source,
            0.6,
          ),
        );
        break;
      }
    }
  }

  return entries;
}

/**
 * Extract user preferences from correction patterns.
 */
function extractPreferences(messages: Message[], source: KnowledgeSource): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const correctionPatterns =
    /\b(no,|actually|instead|don't|do not|prefer|rather|always|never|please use|use .+ instead)\b/i;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (!correctionPatterns.test(msg.content)) continue;

    let context = "";
    if (i > 0 && messages[i - 1].role === "assistant") {
      context = `In response to: ${messages[i - 1].content.slice(0, 200)}`;
    }

    entries.push(
      makeEntry(
        "preference",
        msg.content.slice(0, 500),
        context,
        ["user-preference", "correction"],
        source,
        0.7,
      ),
    );
  }

  return entries;
}

/**
 * Extract capability entries from tool calls and their results.
 */
function extractCapabilities(messages: Message[], source: KnowledgeSource): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const toolUsage = new Map<string, { count: number; lastInput: unknown; lastOutput: string }>();

  for (const msg of messages) {
    if (!msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      const existing = toolUsage.get(tc.name);
      if (existing) {
        existing.count++;
        existing.lastInput = tc.input;
        existing.lastOutput = tc.output ?? "";
      } else {
        toolUsage.set(tc.name, {
          count: 1,
          lastInput: tc.input,
          lastOutput: tc.output ?? "",
        });
      }
    }
  }

  for (const [name, usage] of toolUsage) {
    entries.push(
      makeEntry(
        "capability",
        `Tool: ${name} (used ${usage.count} time${usage.count > 1 ? "s" : ""})`,
        `Last input: ${JSON.stringify(usage.lastInput ?? "").slice(0, 200)}`,
        ["tool-usage", name],
        source,
        0.5 + Math.min(0.3, usage.count * 0.05),
      ),
    );
  }

  return entries;
}

/**
 * Extract explicit factual statements.
 */
function extractFacts(messages: Message[], source: KnowledgeSource): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const factPatterns =
    /\b(the .+ (is|are|uses|requires|depends on)|we use|this project|the codebase|the architecture|the stack|built with|written in)\b/i;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    if (msg.content.length < 20 || msg.content.length > 2000) continue;
    if (!factPatterns.test(msg.content)) continue;
    if (msg.content.trim().endsWith("?")) continue;

    const confidence = msg.role === "user" ? 0.7 : 0.5;

    entries.push(
      makeEntry(
        "fact",
        msg.content.slice(0, 500),
        `Stated by ${msg.role} at message ${i + 1}`,
        ["factual-statement"],
        source,
        confidence,
      ),
    );
  }

  return entries;
}

// ── Deduplication ───────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.8;

/**
 * Deduplicate new entries against existing wiki pages.
 */
async function deduplicateEntries(newEntries: KnowledgeEntry[]): Promise<{
  unique: KnowledgeEntry[];
  merged: Array<{ newEntry: KnowledgeEntry; existingId: string }>;
}> {
  const existing = await getAllEntries();
  const unique: KnowledgeEntry[] = [];
  const merged: Array<{ newEntry: KnowledgeEntry; existingId: string }> = [];

  for (const entry of newEntries) {
    let bestMatch: { id: string; similarity: number } | null = null;

    for (const ex of existing) {
      if (ex.entity_type !== entry.entity_type) continue;
      const sim = stringSimilarity(entry.content, ex.content);
      if (sim > SIMILARITY_THRESHOLD && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { id: ex.id, similarity: sim };
      }
    }

    for (const u of unique) {
      if (u.entity_type !== entry.entity_type) continue;
      const sim = stringSimilarity(entry.content, u.content);
      if (sim > SIMILARITY_THRESHOLD && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { id: u.id, similarity: sim };
      }
    }

    if (bestMatch) {
      merged.push({ newEntry: entry, existingId: bestMatch.id });
    } else {
      unique.push(entry);
    }
  }

  return { unique, merged };
}

// ── Main Harvester ──────────────────────────────────────────────

/**
 * Harvest knowledge entries from a session.
 * Runs all pattern extractors, applies confidence scoring, and deduplicates.
 * Returns KnowledgeEntry objects (the caller writes them via addEntry/writePage).
 */
export async function harvestSession(session: Session): Promise<KnowledgeEntry[]> {
  const source: KnowledgeSource = {
    type: "session_harvest",
    session_id: `${session.adapter}:${session.id}`,
    agent_id: session.adapter,
    timestamp: new Date().toISOString(),
  };

  const rawEntries: KnowledgeEntry[] = [
    ...extractProcedures(session.messages, source),
    ...extractErrorResolutions(session.messages, source),
    ...extractPreferences(session.messages, source),
    ...extractCapabilities(session.messages, source),
    ...extractFacts(session.messages, source),
  ];

  const withRepetitionBonus = applyRepetitionBonus(rawEntries);
  const { unique } = await deduplicateEntries(withRepetitionBonus);

  return unique;
}

/**
 * Harvest a session and write results as wiki pages (the "ingest" flow).
 * Returns the created WikiPage slugs.
 */
export async function harvestSessionAsPages(session: Session): Promise<string[]> {
  const entries = await harvestSession(session);
  const slugs: string[] = [];

  for (const entry of entries) {
    const page = entryToWikiPage(entry);
    await writePage(page);
    slugs.push(page.slug);
  }

  return slugs;
}

/**
 * Boost confidence for entries repeated within the same batch.
 */
function applyRepetitionBonus(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  return entries.map((entry, i) => {
    let repetitionCount = 0;
    for (let j = 0; j < entries.length; j++) {
      if (i === j) continue;
      if (entry.entity_type !== entries[j].entity_type) continue;
      const sim = stringSimilarity(entry.content, entries[j].content);
      if (sim > 0.5) repetitionCount++;
    }

    if (repetitionCount > 0) {
      return {
        ...entry,
        confidence: Math.min(1.0, entry.confidence + repetitionCount * 0.1),
      };
    }
    return entry;
  });
}
