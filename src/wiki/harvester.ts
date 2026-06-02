/**
 * Session knowledge extractor (ADR-0020).
 *
 * Parses harvested session data and extracts knowledge entries using
 * pattern matching. Produces WikiPage objects for the markdown-file storage.
 * Implements confidence scoring and deduplication via Jaccard similarity.
 */

import type { Message, Session, ToolCall } from "../core/session";
import { type NerOptions, entityToSlug, extractEntities } from "./ner";
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
 *
 * ADR-0054 R2: the "Related entities" section now emits `[[wikilink]]`
 * references instead of a backtick-wrapped bullet list. The old bullet form
 * (`` - `Text` (type) ``) was inert: {@link generateWikilinks} explicitly skips
 * text immediately preceded by a backtick (ner.ts), and {@link addPageToGraph}
 * only mines `[[...]]` patterns — so harvested pages never produced graph edges
 * and stayed orphaned. Emitting `[[entity]]` makes harvested knowledge a
 * structural peer of authored pages: the entries feed wikilink edges, backlinks,
 * and orphan detection from the moment they are written. The `entities`
 * frontmatter field is populated with the same slugs so the ADR-0020 entity
 * index can consume them without re-parsing the body.
 *
 * `opts.ner` carries the resolved catalog entity names (ADR-0054 R3) so the
 * harvested page links the real servers/agents/skills/instructions, not just
 * the static fallback vocabulary.
 */
function entryToWikiPage(entry: KnowledgeEntry, opts?: { ner?: NerOptions }): WikiPage {
  const now = new Date().toISOString();

  // Build markdown content
  const lines: string[] = [];
  lines.push(entry.content);
  if (entry.context) {
    lines.push("");
    lines.push(`> Context: ${entry.context}`);
  }

  // Extract entities from content for auto-linking. Catalog-aware so harvested
  // pages reference the real catalog (ADR-0054 R3), de-duplicated by slug.
  const entities = extractEntities(entry.content, opts?.ner);
  const entitySlugs: string[] = [];
  const seenSlugs = new Set<string>();
  const linkLines: string[] = [];
  for (const ent of entities) {
    const slug = entityToSlug(ent.text);
    // Skip empty and duplicate slugs. (No self-reference guard: the page's own
    // slug is `entry.id`, a UUID, while these are slugified entity *names* — the
    // two can never collide, so a `slug === entry.id` check was always dead.)
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    entitySlugs.push(slug);
    // ADR-0054 R2: emit a real wikilink (NOT a backtick-wrapped bullet) so the
    // graph builder mines it as a wikilink edge.
    linkLines.push(`- [[${ent.text}]] (${ent.type})`);
  }

  if (linkLines.length > 0) {
    lines.push("");
    lines.push("## Related Entities");
    lines.push("");
    lines.push(...linkLines);
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
    ...(entitySlugs.length > 0 ? { entities: entitySlugs } : {}),
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

// ── Optional LLM extraction hook (ADR-0054 R8) ──────────────────

/**
 * Optional, GATED LLM-extraction stage (ADR-0054 R8 / ADR-0010).
 *
 * The regex/pattern extractors above yield shallow knowledge. ADR-0020's
 * Karpathy "LLM-wiki" pattern wants an LLM-synthesis pass on top — but
 * ADR-0010 forbids a required runtime LLM dependency in the single binary. The
 * resolution: this is an *interface*, not an embedded client. agent-manager
 * ships NO implementation; a host that has an LLM configured may inject one.
 *
 * Contract:
 * - It receives the session and the heuristic entries already extracted.
 * - It returns ADDITIONAL `KnowledgeEntry` objects (it must not mutate the
 *   inputs). An empty array is the correct no-op result.
 * - It must be safe to call without network/credentials in the degraded case;
 *   the harvester treats a throw as "no LLM available" and continues with the
 *   heuristic entries (graceful degradation).
 */
export interface LlmExtractor {
  extract(input: {
    session: Session;
    source: KnowledgeSource;
    heuristicEntries: readonly KnowledgeEntry[];
  }): Promise<KnowledgeEntry[]> | KnowledgeEntry[];
}

/**
 * The default extractor: a pure no-op heuristic (ADR-0010 zero-dep default).
 *
 * This is what runs when nobody injects an LLM. It returns no extra entries, so
 * `am wiki harvest` behaves EXACTLY as the pattern-only path did before R8. It
 * exists as a named export so callers/tests can assert the default-off contract
 * and so the gating logic always has a concrete extractor to call.
 */
export const noopLlmExtractor: LlmExtractor = {
  extract() {
    return [];
  },
};

/** Options for {@link harvestSession} (ADR-0054 R8). */
export interface HarvestOptions {
  /**
   * Enable the optional LLM-extraction stage. OFF by default — the heuristic
   * pattern extractors are the only thing that runs unless this is explicitly
   * set true AND an `llmExtractor` is supplied. With no extractor, enabling this
   * is a graceful no-op (it falls back to {@link noopLlmExtractor}).
   */
  llmExtraction?: boolean;
  /**
   * The injected extractor implementation. Absent ⇒ {@link noopLlmExtractor}.
   * Never an embedded client — agent-manager ships no LLM (ADR-0010).
   */
  llmExtractor?: LlmExtractor;
}

// ── Main Harvester ──────────────────────────────────────────────

/**
 * Harvest knowledge entries from a session.
 * Runs all pattern extractors, applies confidence scoring, and deduplicates.
 * Returns KnowledgeEntry objects (the caller writes them via addEntry/writePage).
 *
 * ADR-0054 R8: when `opts.llmExtraction` is explicitly enabled AND an
 * `opts.llmExtractor` is supplied, its additional entries are merged in and
 * de-duplicated alongside the heuristic ones. The default (no opts, or
 * `llmExtraction` unset/false, or no extractor) is unchanged pattern-only
 * behaviour — the local-first/zero-dep default the ADR mandates. A throwing or
 * missing extractor degrades gracefully to the heuristic entries.
 */
export async function harvestSession(
  session: Session,
  opts?: HarvestOptions,
): Promise<KnowledgeEntry[]> {
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

  // ADR-0054 R8: gated, opt-in LLM extraction. Off unless explicitly enabled.
  if (opts?.llmExtraction === true) {
    const extractor = opts.llmExtractor ?? noopLlmExtractor;
    try {
      // Hand the extractor a SHALLOW COPY of the heuristic entries, not the live
      // `rawEntries` array. The interface documents "it must not mutate the
      // inputs"; passing a copy enforces that contract rather than trusting it,
      // so a misbehaving extractor that push()es / splices / index-overwrites
      // the array it is given cannot corrupt the heuristic entries we keep. Only
      // the entries it RETURNS are merged in.
      const extra = await extractor.extract({
        session,
        source,
        heuristicEntries: [...rawEntries],
      });
      if (Array.isArray(extra) && extra.length > 0) {
        rawEntries.push(...extra);
      }
    } catch {
      // Graceful degradation (ADR-0010): no LLM / failed call ⇒ heuristic only.
    }
  }

  const withRepetitionBonus = applyRepetitionBonus(rawEntries);
  const { unique } = await deduplicateEntries(withRepetitionBonus);

  return unique;
}

/**
 * Harvest a session and write results as wiki pages (the "ingest" flow).
 * Returns the created WikiPage slugs.
 *
 * ADR-0054 R3: `opts.catalogEntities` carries the resolved catalog's entity
 * names (servers/agents/skills/instructions). It is forwarded to
 * {@link writePage}'s NER so harvested pages auto-link the real catalog the
 * moment they are written, instead of only the static fallback vocabulary.
 * Resolution lives in the command layer (`am wiki ingest`/`harvest`) so
 * `src/wiki/*` stays decoupled from `src/core/*` per ADR-0010 — the harvester
 * receives the names as a plain string list, never an import of ResolvedConfig.
 *
 * ADR-0054 R8: `opts.llmExtraction` / `opts.llmExtractor` are forwarded to
 * {@link harvestSession}. They are off by default and degrade gracefully — see
 * {@link HarvestOptions}.
 */
export async function harvestSessionAsPages(
  session: Session,
  opts?: { catalogEntities?: Iterable<string>; wikiDir?: string } & HarvestOptions,
): Promise<string[]> {
  const entries = await harvestSession(session, {
    ...(opts?.llmExtraction !== undefined ? { llmExtraction: opts.llmExtraction } : {}),
    ...(opts?.llmExtractor !== undefined ? { llmExtractor: opts.llmExtractor } : {}),
  });
  const slugs: string[] = [];

  const ner: NerOptions | undefined =
    opts?.catalogEntities !== undefined ? { catalogEntities: opts.catalogEntities } : undefined;

  for (const entry of entries) {
    // ADR-0054 R2/R3: render the page's "Related Entities" section as catalog-aware
    // [[wikilinks]] so harvested knowledge participates in the graph from creation.
    const page = entryToWikiPage(entry, ner ? { ner } : undefined);
    await writePage(page, {
      ...(opts?.wikiDir !== undefined ? { wikiDir: opts.wikiDir } : {}),
      ...(ner ? { ner } : {}),
    });
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
