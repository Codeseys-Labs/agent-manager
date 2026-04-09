/**
 * Session knowledge extractor (ADR-0020, Phase 1).
 *
 * Parses harvested session data and extracts knowledge entries using
 * pattern matching. Implements confidence scoring and deduplication
 * via Jaccard similarity on word tokens.
 */

import type { Message, Session, ToolCall } from "../core/session";
import { getAllEntries } from "./storage";
import type { EntityType, KnowledgeEntry, KnowledgeSource, Provenance } from "./types";

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

// ── Pattern Extractors ──────────────────────────────────────────

/**
 * Extract procedure entries from commands run and their outcomes.
 * Looks for tool calls with command-like names (bash, exec, shell, run)
 * and pairs them with the output/result.
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
 * Looks for messages containing error indicators followed by resolution messages.
 */
function extractErrorResolutions(messages: Message[], source: KnowledgeSource): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const errorPatterns =
    /\b(error|exception|failed|failure|traceback|panic|fatal|ENOENT|EACCES|EPERM)\b/i;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!errorPatterns.test(msg.content)) continue;

    // Extract the error itself as a fact
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
 * Detects user messages that override or correct assistant suggestions.
 */
function extractPreferences(messages: Message[], source: KnowledgeSource): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const correctionPatterns =
    /\b(no,|actually|instead|don't|do not|prefer|rather|always|never|please use|use .+ instead)\b/i;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (!correctionPatterns.test(msg.content)) continue;

    // Get preceding assistant message for context
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
        0.7, // Higher confidence — explicit user statement
      ),
    );
  }

  return entries;
}

/**
 * Extract capability entries from tool calls and their results.
 * Records what tools were available and used successfully.
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
        0.5 + Math.min(0.3, usage.count * 0.05), // More usage = higher confidence
      ),
    );
  }

  return entries;
}

/**
 * Extract explicit factual statements.
 * Looks for definitive user or assistant statements about the project/codebase.
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

    // Skip if this looks like a question
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
 * Deduplicate new entries against existing ones.
 * Entries with >0.8 Jaccard similarity to an existing entry are merged
 * (confidence is increased) rather than added as new.
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

    // Check against existing entries
    for (const ex of existing) {
      if (ex.entity_type !== entry.entity_type) continue;
      const sim = stringSimilarity(entry.content, ex.content);
      if (sim > SIMILARITY_THRESHOLD && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { id: ex.id, similarity: sim };
      }
    }

    // Also check against already-accepted new entries
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
 */
export async function harvestSession(session: Session): Promise<KnowledgeEntry[]> {
  const source: KnowledgeSource = {
    type: "session_harvest",
    session_id: `${session.adapter}:${session.id}`,
    agent_id: session.adapter,
    timestamp: new Date().toISOString(),
  };

  // Run all extractors
  const rawEntries: KnowledgeEntry[] = [
    ...extractProcedures(session.messages, source),
    ...extractErrorResolutions(session.messages, source),
    ...extractPreferences(session.messages, source),
    ...extractCapabilities(session.messages, source),
    ...extractFacts(session.messages, source),
  ];

  // Apply repetition bonus: if the same concept appears multiple times
  // in the raw entries, boost confidence
  const withRepetitionBonus = applyRepetitionBonus(rawEntries);

  // Deduplicate against existing knowledge base
  const { unique } = await deduplicateEntries(withRepetitionBonus);

  return unique;
}

/**
 * Boost confidence for entries whose content is similar to other entries
 * in the same batch (indicates repetition/reinforcement within the session).
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
