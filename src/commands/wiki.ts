/**
 * CLI commands for the LLM Wiki / Knowledge Synthesis system (ADR-0020, ADR-0031 pillar 5).
 *
 * Primary navigation subcommands (promoted under ADR-0031):
 *   am wiki list                     — list recent wiki entries
 *   am wiki show <slug>              — display a wiki page by slug
 *   am wiki search <query>           — BM25 search via MiniSearch
 *   am wiki sync                     — push/pull the wiki via git
 *   am wiki path                     — print the local wiki directory path
 *
 * Authoring / maintenance:
 *   am wiki add                      — add a wiki page (manual entry)
 *   am wiki delete <slug>            — remove a page with confirmation
 *   am wiki ingest [--session <id>]  — create wiki pages from sessions
 *   am wiki synthesize <query>       — generate context block
 *   am wiki briefing <agent-id>      — generate agent briefing
 *   am wiki export [--format]        — export full knowledge base
 *   am wiki import <file>            — import entries from file
 *   am wiki lint                     — check for orphans, stale pages, broken links
 *   am wiki graph                    — export knowledge graph as JSON
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineCommand } from "citty";
import { getAdapter, listAdapters } from "../adapters/registry";
import { resolveProjectConfig } from "../core/config";
import { getStatus } from "../core/git";
import { errorCode, errorMessage } from "../lib/errors";
import { error, info, output, parsePositiveInt, warn } from "../lib/output";
import { WIKI_AGENTS_MD_TEMPLATE } from "../wiki/agents-md-template";
import { exportGraphForViz, findOrphans, loadGraph } from "../wiki/graph";
import { harvestSession, harvestSessionAsPages } from "../wiki/harvester";
import {
  type ResolveChoice,
  type ResolveIo,
  readConflictSidecar,
  resolveConflicts,
} from "../wiki/resolve";
import {
  LEGACY_WIKI_PROJECT_DIRNAME,
  WIKI_PROJECT_DIRNAME,
  addEntry,
  deleteEntry,
  deletePage,
  detectLegacyWikiLayout,
  ensureWikiDirs,
  getAllEntries,
  getEntry,
  getIndex,
  getProjectWikiDir,
  listPages,
  materialiseProject,
  parseFrontmatter,
  pushToGlobal,
  readPage,
  rebuildSearchIndex,
  resolveProjectName,
  resolveWikiDir,
  searchEntries,
  searchPages,
  writePage,
} from "../wiki/storage";
import { type Direction, syncWiki } from "../wiki/sync";
import { buildAgentBriefing, generateWikiPage, synthesizeContext } from "../wiki/synthesizer";
import type {
  EntityType,
  KnowledgeEntry,
  KnowledgeSource,
  Provenance,
  WikiPage,
} from "../wiki/types";

// ── Subcommands ─────────────────────────────────────────────────

export const searchSubcommand = defineCommand({
  meta: { name: "search", description: "Search the wiki (BM25 via MiniSearch)" },
  args: {
    query: { type: "positional", description: "Search query", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    limit: { type: "string", description: "Max results", default: "20" },
    global: { type: "boolean", description: "Use global wiki", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const query = args.query as string;
    const limit = parsePositiveInt(args.limit, "limit", 20);
    const wikiDir = args.global ? resolveWikiDir({ global: true }) : undefined;

    const results = await searchPages(query, limit, wikiDir);

    if (args.json) {
      output(
        {
          query,
          results: results.map((r) => ({
            slug: r.page.slug,
            title: r.page.title,
            score: r.score,
            type: r.page.type,
            tags: r.page.tags,
          })),
          total: results.length,
        },
        opts,
      );
      return;
    }

    if (results.length === 0) {
      info(`No pages match "${query}".`, opts);
      return;
    }

    info(`${"Slug".padEnd(40)} ${"Type".padEnd(12)} ${"Score".padEnd(8)} ${"Title"}`, opts);
    info(`${"─".repeat(40)} ${"─".repeat(12)} ${"─".repeat(8)} ${"─".repeat(40)}`, opts);

    for (const { page, score } of results) {
      const titlePreview = page.title.slice(0, 50);
      info(
        `${page.slug.padEnd(40)} ${page.type.padEnd(12)} ${score.toFixed(2).padEnd(8)} ${titlePreview}`,
        opts,
      );
    }

    info(`\n${results.length} result(s) for "${query}"`, opts);
  },
});

const addSubcommand = defineCommand({
  meta: { name: "add", description: "Add a wiki page or knowledge entry" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    global: { type: "boolean", description: "Use global wiki", default: false },
    type: {
      type: "string",
      description: "Entity type: fact, procedure, preference, relationship, capability",
      required: true,
    },
    content: { type: "string", description: "Entry content", required: true },
    context: { type: "string", description: "Entry context", default: "" },
    tags: { type: "string", description: "Comma-separated tags", default: "" },
    confidence: { type: "string", description: "Confidence score 0.0-1.0", default: "0.7" },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };

    const validTypes: EntityType[] = [
      "fact",
      "procedure",
      "preference",
      "relationship",
      "capability",
    ];
    const entityType = args.type as EntityType;
    if (!validTypes.includes(entityType)) {
      error(`Invalid entity type: "${args.type}". Must be one of: ${validTypes.join(", ")}`, opts);
      process.exitCode = 1;
      return;
    }

    const confidence = Number.parseFloat(args.confidence);
    if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
      error("Confidence must be a number between 0.0 and 1.0", opts);
      process.exitCode = 1;
      return;
    }

    const now = new Date().toISOString();
    const source: KnowledgeSource = {
      type: "manual",
      timestamp: now,
    };
    const provenance: Provenance = {
      created_by: "user",
      created_at: now,
      last_modified: now,
      modification_history: [
        { timestamp: now, action: "created", by: "user", details: "Manual entry via CLI" },
      ],
      verified: true,
      verification_source: "user",
    };

    const entry: KnowledgeEntry = {
      id: crypto.randomUUID(),
      source,
      extracted_at: now,
      confidence,
      entity_type: entityType,
      content: args.content,
      context: args.context,
      tags: args.tags
        ? args.tags
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
        : [],
      references: [],
      provenance,
    };

    await addEntry(entry);

    if (args.json) {
      output({ action: "add", entry }, opts);
    } else {
      info(`Added entry ${entry.id} (${entityType})`, opts);
    }
  },
});

export const showSubcommand = defineCommand({
  meta: { name: "show", description: "Display a wiki page by slug" },
  args: {
    slug: { type: "positional", description: "Page slug", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    global: { type: "boolean", description: "Use global wiki", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const slug = args.slug as string;
    const wikiDir = args.global ? resolveWikiDir({ global: true }) : undefined;

    // Try reading as a wiki page first, fall back to legacy entry by ID
    const page = await readPage(slug, wikiDir);
    if (page) {
      if (args.json) {
        output(page, opts);
        return;
      }

      info(`Slug:       ${page.slug}`, opts);
      info(`Title:      ${page.title}`, opts);
      info(`Type:       ${page.type}`, opts);
      info(`Created:    ${page.created}`, opts);
      info(`Updated:    ${page.updated}`, opts);
      info(`Tags:       ${page.tags.join(", ") || "(none)"}`, opts);
      if (page.confidence !== undefined) {
        info(`Confidence: ${page.confidence.toFixed(2)}`, opts);
      }
      if (page.sources.length > 0) {
        info(`Sources:    ${page.sources.join(", ")}`, opts);
      }
      if (page.backlinks.length > 0) {
        info(`Backlinks:  ${page.backlinks.join(", ")}`, opts);
      }
      info("", opts);
      info("Content:", opts);
      info(page.content, opts);
      return;
    }

    // Fall back to legacy entry lookup by ID
    const entry = await getEntry(slug);
    if (!entry) {
      error(`Page or entry "${slug}" not found.`, opts);
      process.exitCode = 1;
      return;
    }

    if (args.json) {
      output(entry, opts);
      return;
    }

    info(`ID:         ${entry.id}`, opts);
    info(`Type:       ${entry.entity_type}`, opts);
    info(`Confidence: ${entry.confidence.toFixed(2)}`, opts);
    info(`Extracted:  ${entry.extracted_at}`, opts);
    info(
      `Source:     ${entry.source.type}${entry.source.session_id ? ` (${entry.source.session_id})` : ""}`,
      opts,
    );
    info(`Tags:       ${entry.tags.join(", ") || "(none)"}`, opts);
    info(`Verified:   ${entry.provenance.verified ? "yes" : "no"}`, opts);
    info("", opts);
    info("Content:", opts);
    info(entry.content, opts);
    if (entry.context) {
      info("", opts);
      info("Context:", opts);
      info(entry.context, opts);
    }
  },
});

const deleteSubcommand = defineCommand({
  meta: { name: "delete", description: "Delete a wiki page by slug" },
  args: {
    slug: { type: "positional", description: "Page slug or entry ID", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    force: { type: "boolean", alias: "f", description: "Skip confirmation", default: false },
    global: { type: "boolean", description: "Use global wiki", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const slug = args.slug as string;
    const wikiDir = args.global ? resolveWikiDir({ global: true }) : undefined;

    // Try as wiki page first
    const page = await readPage(slug, wikiDir);
    if (page) {
      if (!args.force && !args.json) {
        info(`About to delete: ${page.type} - ${page.title.slice(0, 60)}`, opts);
        info("Use --force to confirm deletion.", opts);
        return;
      }

      await deletePage(slug, wikiDir);

      if (args.json) {
        output({ action: "delete", slug }, opts);
      } else {
        info(`Deleted page ${slug}`, opts);
      }
      return;
    }

    // Fall back to legacy entry
    const entry = await getEntry(slug);
    if (!entry) {
      error(`Page or entry "${slug}" not found.`, opts);
      process.exitCode = 1;
      return;
    }

    if (!args.force && !args.json) {
      info(
        `About to delete: ${entry.entity_type} - ${entry.content.split("\n")[0].slice(0, 60)}`,
        opts,
      );
      info("Use --force to confirm deletion.", opts);
      return;
    }

    await deleteEntry(slug);

    if (args.json) {
      output({ action: "delete", slug }, opts);
    } else {
      info(`Deleted entry ${slug}`, opts);
    }
  },
});

const ingestSubcommand = defineCommand({
  meta: { name: "ingest", description: "Create wiki pages from agent sessions" },
  args: {
    session: { type: "string", description: "Specific session ID (adapter:session-id)" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    adapter: { type: "string", description: "Filter to one adapter" },
    limit: { type: "string", description: "Max sessions to process", default: "10" },
    global: { type: "boolean", description: "Use global wiki", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const maxSessions = parsePositiveInt(args.limit, "limit", 10);

    if (args.session) {
      const colonIdx = (args.session as string).indexOf(":");
      if (colonIdx < 1) {
        error("Invalid session ID format. Expected: adapter:session-id", opts);
        process.exitCode = 1;
        return;
      }
      const adapterName = (args.session as string).slice(0, colonIdx);
      const sessionId = (args.session as string).slice(colonIdx + 1);

      const adapter = await getAdapter(adapterName);
      if (!adapter?.sessionReader) {
        error(`Adapter "${adapterName}" not found or has no session reader.`, opts);
        process.exitCode = 1;
        return;
      }

      const session = await adapter.sessionReader.loadSession(sessionId);
      if (!session) {
        error(`Session "${sessionId}" not found in ${adapterName}.`, opts);
        process.exitCode = 1;
        return;
      }

      const slugs = await harvestSessionAsPages(session);
      await rebuildSearchIndex();

      if (args.json) {
        output(
          { action: "ingest", session: args.session, pages_created: slugs.length, slugs },
          opts,
        );
      } else {
        info(`Ingested ${slugs.length} wiki pages from ${args.session}`, opts);
      }
      return;
    }

    // Ingest from all sessions (or filtered by adapter)
    const adapterNames = args.adapter ? [args.adapter as string] : listAdapters();
    let totalPages = 0;
    let totalSessions = 0;

    for (const name of adapterNames) {
      const adapter = await getAdapter(name);
      if (!adapter?.sessionReader) continue;
      if (!adapter.sessionReader.hasSessionStorage()) continue;

      let summaries;
      try {
        summaries = await adapter.sessionReader.listSessions();
      } catch {
        continue;
      }

      summaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      const toProcess = summaries.slice(0, maxSessions - totalSessions);

      for (const summary of toProcess) {
        if (totalSessions >= maxSessions) break;

        let session;
        try {
          session = await adapter.sessionReader.loadSession(summary.id);
        } catch {
          continue;
        }
        if (!session) continue;

        const slugs = await harvestSessionAsPages(session);
        totalPages += slugs.length;
        totalSessions++;

        if (!args.json && !args.quiet) {
          info(`  ${name}:${summary.id} → ${slugs.length} pages`, opts);
        }
      }
    }

    await rebuildSearchIndex();

    if (args.json) {
      output(
        { action: "ingest", sessions_processed: totalSessions, pages_created: totalPages },
        opts,
      );
    } else {
      info(`\nIngested ${totalPages} wiki pages from ${totalSessions} session(s)`, opts);
    }
  },
});

// harvest produces legacy KnowledgeEntry objects via harvestSession(),
// while ingest produces WikiPage objects via harvestSessionAsPages().
// Similar arg parsing but different data pipelines — not worth extracting shared code.
const harvestSubcommand = defineCommand({
  meta: { name: "harvest", description: "Extract knowledge from sessions (alias for ingest)" },
  args: {
    session: { type: "string", description: "Specific session ID (adapter:session-id)" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    adapter: { type: "string", description: "Filter to one adapter" },
    limit: { type: "string", description: "Max sessions to process", default: "10" },
    global: { type: "boolean", description: "Use global wiki", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const maxSessions = parsePositiveInt(args.limit, "limit", 10);

    if (args.session) {
      const colonIdx = (args.session as string).indexOf(":");
      if (colonIdx < 1) {
        error("Invalid session ID format. Expected: adapter:session-id", opts);
        process.exitCode = 1;
        return;
      }
      const adapterName = (args.session as string).slice(0, colonIdx);
      const sessionId = (args.session as string).slice(colonIdx + 1);

      const adapter = await getAdapter(adapterName);
      if (!adapter?.sessionReader) {
        error(`Adapter "${adapterName}" not found or has no session reader.`, opts);
        process.exitCode = 1;
        return;
      }

      const session = await adapter.sessionReader.loadSession(sessionId);
      if (!session) {
        error(`Session "${sessionId}" not found in ${adapterName}.`, opts);
        process.exitCode = 1;
        return;
      }

      const entries = await harvestSession(session);
      for (const entry of entries) {
        await addEntry(entry);
      }

      if (args.json) {
        output({ action: "harvest", session: args.session, entries_added: entries.length }, opts);
      } else {
        info(`Harvested ${entries.length} entries from ${args.session}`, opts);
      }
      return;
    }

    const adapterNames = args.adapter ? [args.adapter as string] : listAdapters();
    let totalEntries = 0;
    let totalSessions = 0;

    for (const name of adapterNames) {
      const adapter = await getAdapter(name);
      if (!adapter?.sessionReader) continue;
      if (!adapter.sessionReader.hasSessionStorage()) continue;

      let summaries;
      try {
        summaries = await adapter.sessionReader.listSessions();
      } catch {
        continue;
      }

      summaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      const toProcess = summaries.slice(0, maxSessions - totalSessions);

      for (const summary of toProcess) {
        if (totalSessions >= maxSessions) break;

        let session;
        try {
          session = await adapter.sessionReader.loadSession(summary.id);
        } catch {
          continue;
        }
        if (!session) continue;

        const entries = await harvestSession(session);
        for (const entry of entries) {
          try {
            await addEntry(entry);
            totalEntries++;
          } catch {
            // Skip duplicate entries
          }
        }
        totalSessions++;

        if (!args.json && !args.quiet) {
          info(`  ${name}:${summary.id} → ${entries.length} entries`, opts);
        }
      }
    }

    if (args.json) {
      output(
        { action: "harvest", sessions_processed: totalSessions, entries_added: totalEntries },
        opts,
      );
    } else {
      info(`\nHarvested ${totalEntries} entries from ${totalSessions} session(s)`, opts);
    }
  },
});

const synthesizeSubcommand = defineCommand({
  meta: { name: "synthesize", description: "Generate context block from knowledge" },
  args: {
    query: { type: "positional", description: "Topic or question", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    global: { type: "boolean", description: "Use global wiki", default: false },
    agent: { type: "string", description: "Filter to agent ID" },
    "top-k": { type: "string", description: "Number of entries to include", default: "10" },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const query = args.query as string;
    const topK = parsePositiveInt(args["top-k"], "top-k", 10);

    const context = await synthesizeContext(query, {
      agentId: args.agent as string | undefined,
      topK,
    });

    if (args.json) {
      output({ query, context }, opts);
    } else {
      info(context, opts);
    }
  },
});

export const briefingSubcommand = defineCommand({
  meta: { name: "briefing", description: "Generate agent briefing" },
  args: {
    "agent-id": { type: "positional", description: "Agent/adapter ID", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    global: { type: "boolean", description: "Use global wiki", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const agentId = args["agent-id"] as string;
    // QW-followup: thread --global so the briefing reads the global store
    // instead of silently ignoring the declared flag (matches lint/graph).
    const wikiDir = args.global ? resolveWikiDir({ global: true }) : undefined;

    const entries = await getAllEntries(wikiDir);
    const briefing = buildAgentBriefing(entries, agentId);

    if (args.json) {
      output({ agent_id: agentId, briefing }, opts);
    } else {
      info(briefing, opts);
    }
  },
});

export const exportSubcommand = defineCommand({
  meta: { name: "export", description: "Export the knowledge base" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    global: { type: "boolean", description: "Use global wiki", default: false },
    format: {
      type: "string",
      description: "Export format: json or markdown",
      default: "json",
    },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const fmt = args.format as string;
    // QW-followup: thread --global so export reads the global store instead of
    // silently ignoring the declared flag (matches lint/graph/briefing).
    const wikiDir = args.global ? resolveWikiDir({ global: true }) : undefined;

    const entries = await getAllEntries(wikiDir);
    const index = await getIndex(wikiDir);

    if (fmt === "markdown") {
      const tagGroups = new Map<string, KnowledgeEntry[]>();
      for (const entry of entries) {
        if (entry.tags.length === 0) {
          const group = tagGroups.get("untagged") ?? [];
          group.push(entry);
          tagGroups.set("untagged", group);
        } else {
          for (const tag of entry.tags) {
            const group = tagGroups.get(tag) ?? [];
            group.push(entry);
            tagGroups.set(tag, group);
          }
        }
      }

      const lines: string[] = [];
      lines.push("# Knowledge Base Export");
      lines.push("");
      lines.push(`Entries: ${index.entry_count}`);
      lines.push(`Last updated: ${index.last_updated}`);
      lines.push("");

      for (const [tag, group] of tagGroups) {
        lines.push(generateWikiPage(tag, group));
        lines.push("");
        lines.push("---");
        lines.push("");
      }

      info(lines.join("\n"), opts);
    } else {
      const data = { index, entries };
      output(data, opts);
    }
  },
});

const importSubcommand = defineCommand({
  meta: { name: "import", description: "Import knowledge entries from file" },
  args: {
    file: { type: "positional", description: "JSON file to import", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    global: { type: "boolean", description: "Use global wiki", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const filePath = args.file as string;

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      error(`Cannot read file: ${filePath} (${errorCode(err) ?? errorMessage(err)})`, opts);
      process.exitCode = 1;
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      error("File is not valid JSON.", opts);
      process.exitCode = 1;
      return;
    }

    let entries: KnowledgeEntry[];
    if (Array.isArray(data)) {
      entries = data as KnowledgeEntry[];
    } else if (
      data &&
      typeof data === "object" &&
      "entries" in data &&
      Array.isArray((data as Record<string, unknown>).entries)
    ) {
      entries = (data as Record<string, unknown>).entries as KnowledgeEntry[];
    } else {
      error("Expected a JSON array of entries or an object with an 'entries' array.", opts);
      process.exitCode = 1;
      return;
    }

    let imported = 0;
    let skipped = 0;

    for (const entry of entries) {
      if (!entry.id) {
        entry.id = crypto.randomUUID();
      }

      try {
        await addEntry(entry);
        imported++;
      } catch {
        skipped++;
      }
    }

    await rebuildSearchIndex();

    if (args.json) {
      output({ action: "import", file: filePath, imported, skipped }, opts);
    } else {
      info(`Imported ${imported} entries (${skipped} skipped) from ${filePath}`, opts);
    }
  },
});

export const lintSubcommand = defineCommand({
  meta: { name: "lint", description: "Check for orphans, stale pages, broken links" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    global: { type: "boolean", description: "Use global wiki", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const wikiDir = args.global ? resolveWikiDir({ global: true }) : undefined;

    const pages = await listPages({ wikiDir });
    const graph = await loadGraph(wikiDir);

    // Find orphans (no inbound links)
    const orphans = findOrphans(graph);

    // Find stale pages (older than 30 days)
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const stalePages = pages.filter((p) => new Date(p.updated).getTime() < thirtyDaysAgo);

    // Find broken backlinks (backlinks pointing to non-existent pages)
    const allSlugs = new Set(pages.map((p) => p.slug));
    const brokenLinks: Array<{ page: string; target: string }> = [];
    for (const page of pages) {
      for (const backlink of page.backlinks) {
        if (!allSlugs.has(backlink)) {
          brokenLinks.push({ page: page.slug, target: backlink });
        }
      }
    }

    // Find pages with low confidence
    const lowConfidence = pages.filter((p) => p.confidence !== undefined && p.confidence < 0.3);

    const issues = {
      orphans: orphans.length,
      stale: stalePages.length,
      broken_links: brokenLinks.length,
      low_confidence: lowConfidence.length,
      total_pages: pages.length,
    };

    if (args.json) {
      output(
        {
          ...issues,
          orphan_slugs: orphans,
          stale_slugs: stalePages.map((p) => p.slug),
          broken_link_details: brokenLinks,
          low_confidence_slugs: lowConfidence.map((p) => p.slug),
        },
        opts,
      );
      return;
    }

    info(`Wiki Lint Report (${pages.length} pages)`, opts);
    info("─".repeat(50), opts);

    if (orphans.length > 0) {
      info(`\nOrphans (${orphans.length}):`, opts);
      for (const slug of orphans.slice(0, 10)) {
        info(`  - ${slug}`, opts);
      }
      if (orphans.length > 10) info(`  ... and ${orphans.length - 10} more`, opts);
    }

    if (stalePages.length > 0) {
      info(`\nStale pages (${stalePages.length}, >30 days old):`, opts);
      for (const page of stalePages.slice(0, 10)) {
        info(`  - ${page.slug} (updated: ${page.updated.slice(0, 10)})`, opts);
      }
      if (stalePages.length > 10) info(`  ... and ${stalePages.length - 10} more`, opts);
    }

    if (brokenLinks.length > 0) {
      info(`\nBroken links (${brokenLinks.length}):`, opts);
      for (const link of brokenLinks.slice(0, 10)) {
        info(`  - ${link.page} → ${link.target} (not found)`, opts);
      }
      if (brokenLinks.length > 10) info(`  ... and ${brokenLinks.length - 10} more`, opts);
    }

    if (lowConfidence.length > 0) {
      info(`\nLow confidence (${lowConfidence.length}, <0.3):`, opts);
      for (const page of lowConfidence.slice(0, 10)) {
        info(`  - ${page.slug} (confidence: ${page.confidence?.toFixed(2)})`, opts);
      }
      if (lowConfidence.length > 10) info(`  ... and ${lowConfidence.length - 10} more`, opts);
    }

    if (
      orphans.length === 0 &&
      stalePages.length === 0 &&
      brokenLinks.length === 0 &&
      lowConfidence.length === 0
    ) {
      info("\nNo issues found.", opts);
    }
  },
});

export const graphSubcommand = defineCommand({
  meta: { name: "graph", description: "Export knowledge graph as JSON" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    global: { type: "boolean", description: "Use global wiki", default: false },
    format: {
      type: "string",
      description: "Format: raw (full graph) or viz (nodes+edges for visualization)",
      default: "viz",
    },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const wikiDir = args.global ? resolveWikiDir({ global: true }) : undefined;
    const graph = await loadGraph(wikiDir);

    if (args.format === "raw") {
      output(graph, opts);
      return;
    }

    // viz format
    const vizData = exportGraphForViz(graph);

    if (args.json) {
      output(vizData, opts);
      return;
    }

    info(`Knowledge Graph: ${vizData.nodes.length} nodes, ${vizData.edges.length} edges`, opts);
    info("", opts);

    if (vizData.nodes.length > 0) {
      info("Nodes:", opts);
      for (const node of vizData.nodes.slice(0, 20)) {
        info(`  ${node.id} (${node.type}): ${node.label}`, opts);
      }
      if (vizData.nodes.length > 20) {
        info(`  ... and ${vizData.nodes.length - 20} more`, opts);
      }
    }

    if (vizData.edges.length > 0) {
      info("\nEdges:", opts);
      for (const edge of vizData.edges.slice(0, 20)) {
        info(`  ${edge.source} → ${edge.target} (${edge.type})`, opts);
      }
      if (vizData.edges.length > 20) {
        info(`  ... and ${vizData.edges.length - 20} more`, opts);
      }
    }
  },
});

// ── list / sync / path (ADR-0031 pillar-5 promotion) ────────────

export const listSubcommand = defineCommand({
  meta: { name: "list", description: "List wiki entries (most recent first)" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    global: { type: "boolean", description: "Use global wiki", default: false },
    all: {
      type: "boolean",
      description: "List every page (default: 20 most recent)",
      default: false,
    },
    limit: {
      type: "string",
      description: "Max results (default 20, ignored with --all)",
      default: "20",
    },
    type: {
      type: "string",
      description: "Filter by page type (entity|concept|summary|synthesis|decision)",
    },
    tag: { type: "string", description: "Filter by tag" },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const wikiDir = args.global ? resolveWikiDir({ global: true }) : undefined;

    const filter: Parameters<typeof listPages>[0] = { wikiDir };
    if (args.type) {
      filter.type = args.type as (typeof filter)["type"];
    }
    if (args.tag) filter.tag = args.tag as string;

    const all = await listPages(filter);

    // Sort by updated desc (most recent first)
    all.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));

    const limit = args.all ? all.length : parsePositiveInt(args.limit, "limit", 20);
    const pages = all.slice(0, limit);

    if (args.json) {
      output(
        {
          total: all.length,
          shown: pages.length,
          pages: pages.map((p) => ({
            slug: p.slug,
            title: p.title,
            type: p.type,
            tags: p.tags,
            updated: p.updated,
          })),
        },
        opts,
      );
      return;
    }

    if (pages.length === 0) {
      info("No wiki pages found. Try `am wiki ingest` or `am wiki add`.", opts);
      return;
    }

    info(`${"Slug".padEnd(40)} ${"Type".padEnd(10)} ${"Updated".padEnd(10)} ${"Title"}`, opts);
    info(`${"─".repeat(40)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(40)}`, opts);
    for (const page of pages) {
      info(
        `${page.slug.padEnd(40)} ${page.type.padEnd(10)} ${page.updated.slice(0, 10).padEnd(10)} ${page.title.slice(0, 50)}`,
        opts,
      );
    }
    if (all.length > pages.length) {
      info(`\nShowing ${pages.length} of ${all.length}. Use --all to show every page.`, opts);
    } else {
      info(`\n${pages.length} page(s).`, opts);
    }
  },
});

export const pathSubcommand = defineCommand({
  meta: { name: "path", description: "Print the local wiki directory path" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    global: { type: "boolean", description: "Print the global wiki path", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const wikiDir = resolveWikiDir({ global: args.global });
    if (args.json) {
      output({ path: wikiDir, global: args.global }, opts);
    } else {
      // Print the raw path to stdout (no prefix), so shells can:
      //   cd "$(am wiki path)"
      //   $EDITOR "$(am wiki path)"
      console.log(wikiDir);
    }
  },
});

// M5.2 (2026-05-03): correctness-first sync pipeline. Replaces the thin
// push/pull wrapper with auto-commit + fast-forward-only pull + rollback via
// `softResetHead` on divergence + wiki-conflict.json sidecar for `am wiki
// resolve` (M5.3). See `src/wiki/sync.ts` and `docs/plans/wiki-sync-m5.md`.
//
// Backward-compat: the existing `--direction push|pull|both --remote --branch`
// flags are preserved. `--auto-commit` is opt-out by default (per plan risks §)
// and can be disabled with `--no-auto-commit`. `--allow-dirty` preserves the
// old warn-and-proceed semantics. The strict-secret-scan heuristic is gated
// behind `--strict-secret-scan` until BetterLeaks text-mode lands (follow-up
// #5 in wiki-sync-m5.md).
export const syncSubcommand = defineCommand({
  meta: { name: "sync", description: "Push/pull the global wiki via git (M5.2 FF-only)" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    direction: {
      type: "string",
      description: "push | pull | both | commit-and-sync",
      default: "both",
    },
    remote: { type: "string", description: "Git remote name", default: "origin" },
    branch: { type: "string", description: "Git branch name (default: current)" },
    "auto-commit": {
      type: "boolean",
      description: "Auto-commit wiki edits older than --debounce seconds before pulling",
      default: true,
    },
    "allow-dirty": {
      type: "boolean",
      description: "Skip auto-commit + proceed with a dirty tree (old behavior)",
      default: false,
    },
    debounce: {
      type: "string",
      description: "Seconds a file must sit un-edited before auto-commit picks it up",
      default: "60",
    },
    "strict-secret-scan": {
      type: "boolean",
      description:
        "Run tier-1 text secret scan on files before auto-commit (opt-in; may have false positives)",
      default: false,
    },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const wikiDir = resolveWikiDir({ global: true });
    const direction = (args.direction as string).toLowerCase();

    if (!["push", "pull", "both", "commit-and-sync"].includes(direction)) {
      error(
        `Invalid --direction "${direction}". Expected: push | pull | both | commit-and-sync.`,
        opts,
      );
      process.exitCode = 1;
      return;
    }

    let status;
    try {
      status = await getStatus(wikiDir);
    } catch {
      error(
        `Wiki directory is not a git repo: ${wikiDir}. Initialize it with \`git init\` and add a remote before syncing.`,
        opts,
      );
      process.exitCode = 1;
      return;
    }

    if (status.remotes.length === 0) {
      error(
        `No git remote configured in ${wikiDir}. Add one with \`git -C ${wikiDir} remote add origin <url>\`.`,
        opts,
      );
      process.exitCode = 1;
      return;
    }

    const debounceSeconds = parsePositiveInt(String(args.debounce ?? "60"), "debounce", 60);
    const autoCommit = args["auto-commit"] as boolean;
    const allowDirty = args["allow-dirty"] as boolean;

    try {
      const result = await syncWiki(wikiDir, {
        direction: direction as Direction,
        remote: args.remote as string,
        branch: args.branch as string | undefined,
        autoCommit,
        allowDirty,
        debounceSeconds,
        strictSecretScan: args["strict-secret-scan"] as boolean,
      });

      // Human-readable action summary (skipped in --json and --quiet).
      for (const a of result.actions) {
        if (!a.ok) {
          error(`${a.action}: ${a.error ?? "failed"}`, opts);
          process.exitCode = 1;
        } else if (a.detail) {
          info(`${a.action}: ${a.detail}`, opts);
        } else {
          info(`${a.action}: ok`, opts);
        }
      }

      if (result.sidecarWritten) {
        warn(
          `Divergence recorded in ${result.sidecarWritten}. Run \`am wiki resolve\` to pick per-file.`,
          opts,
        );
      }

      if (args.json) {
        output(
          {
            action: "sync",
            wikiDir,
            remote: result.remote,
            branch: result.branch,
            results: result.actions,
            sidecarWritten: result.sidecarWritten,
          },
          opts,
        );
      }
    } catch (err: unknown) {
      const msg = errorMessage(err) ?? "sync failed";
      error(msg, opts);
      process.exitCode = 1;
      if (args.json) {
        output({ action: "sync", wikiDir, error: msg }, opts);
      }
    }
  },
});

// ── Resolve Subcommand (M5.3-lite, 2026-05-03-E) ──────────────────

const resolveSubcommand = defineCommand({
  meta: {
    name: "resolve",
    description:
      "Resolve a wiki sync conflict from wiki-conflict.json (per-file pick: keep-local / take-remote / edit)",
  },
  args: {
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    strategy: {
      type: "string",
      description:
        "Non-interactive choice applied to every file: keep-local | take-remote | skip (no default)",
    },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const wikiDir = resolveWikiDir({ global: true });

    const sidecar = await readConflictSidecar(wikiDir);
    if (!sidecar) {
      error(
        "No wiki-conflict.json in the global wiki — nothing to resolve. Run `am wiki sync` first if divergence is expected.",
        opts,
      );
      process.exitCode = 1;
      return;
    }

    // Build the IO handler. When --strategy is given, short-circuit
    // the prompt; otherwise use @clack/prompts select.
    const strategyFlag = args.strategy as string | undefined;

    // Validate --strategy up front so a bad value fails before any IO,
    // and so the error path doesn't depend on a file being present.
    if (strategyFlag && !["keep-local", "take-remote", "skip"].includes(strategyFlag)) {
      error(
        `Invalid --strategy "${strategyFlag}". Expected: keep-local | take-remote | skip`,
        opts,
      );
      process.exitCode = 1;
      return;
    }

    // UX-2: never hang on an interactive prompt in non-interactive contexts.
    // The per-file picker requires a TTY (and human text output); when running
    // under --json or without a TTY, demand an explicit --strategy instead of
    // blocking forever on @clack/prompts.select.
    const interactive = !args.json && Boolean(process.stdin.isTTY);
    if (!strategyFlag && !interactive) {
      error(
        "am wiki resolve needs a choice in non-interactive mode. Re-run with --strategy keep-local | take-remote | skip (no TTY / --json detected).",
        opts,
      );
      process.exitCode = 1;
      return;
    }

    const io: ResolveIo = {
      async pickChoice(file) {
        if (strategyFlag) {
          return strategyFlag as ResolveChoice;
        }
        const clack = await import("@clack/prompts");
        const chosen = await clack.select({
          message: `Resolve: ${file}`,
          options: [
            { value: "keep-local", label: "keep local (your version)" },
            { value: "take-remote", label: "take remote (their version)" },
            { value: "edit", label: "open in $EDITOR" },
            { value: "skip", label: "skip (resolve later)" },
          ],
        });
        if (clack.isCancel(chosen)) return "skip";
        return chosen as ResolveChoice;
      },
      async openEditor(absPath) {
        // REV-M53-4 (2026-05-03-E): many editors require flags, e.g.
        // EDITOR="code --wait" or EDITOR="vim -f". Passing the whole
        // string as argv[0] fails with ENOENT. Split on whitespace so
        // EDITOR-style env vars work.
        const editorRaw = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
        const parts = editorRaw.trim().split(/\s+/);
        const bin = parts[0];
        const editorArgs = parts.slice(1);
        const proc = Bun.spawn([bin, ...editorArgs, absPath], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        await proc.exited;
      },
      info(msg) {
        info(msg, opts);
      },
    };

    try {
      const result = await resolveConflicts(wikiDir, io);
      if (args.json) {
        output(
          {
            action: "resolve",
            wikiDir,
            sidecarPath: result.sidecarPath,
            sidecarCleared: result.sidecarCleared,
            commitOid: result.commitOid,
            resolvedFiles: result.resolvedFiles,
          },
          opts,
        );
      } else {
        for (const f of result.resolvedFiles) {
          info(`  ${f.choice.padEnd(12)} ${f.file}`, opts);
        }
        if (result.commitOid) {
          info(`Committed resolution: ${result.commitOid.slice(0, 8)}`, opts);
        }
        if (!result.sidecarCleared) {
          warn(
            "Sidecar NOT cleared — some files were skipped. Re-run `am wiki resolve` when ready.",
            opts,
          );
          process.exitCode = 1;
        } else {
          info("Sidecar cleared; conflict resolved.", opts);
        }
      }
    } catch (err) {
      const msg = errorMessage(err) ?? "resolve failed";
      error(msg, opts);
      process.exitCode = 1;
    }
  },
});

// ── ADR-0044: two-tier copy materialisation ────────────────────────
//
// `am wiki init`, `migrate`, `publish`, `pull` are the four subcommands
// that implement the ADR-0044 two-tier model. Per ADR-0044 §1-§3:
//   - Project wiki lives at `<projectDir>/.am-wiki/` (a COPY of the
//     global project store, not a symlink).
//   - `init` creates `.am-wiki/` and materialises the current global
//     store into it. Legacy `.agent-manager/wiki/` layouts get a
//     deprecation warning pointing at `am wiki migrate`.
//   - `migrate` rewrites a legacy project to the new `.am-wiki/` layout
//     (backing up any real directory contents to
//     `.agent-manager/wiki.backup-YYYYMMDD/`).
//   - `publish <slug>` promotes a local entry up to the global store
//     via `pushToGlobal` (inverse of materialisation).
//   - `pull` is OPT-IN: it overwrites local `.am-wiki/` entries with
//     the current global content. Never invoked by default.

/**
 * Append `.am-wiki/` to the project's `.gitignore` if not already
 * present (ADR-0044 §4). Best-effort; silent on IO errors so init
 * never fails just because .gitignore is unusual. If `.gitignore`
 * already has the legacy `.agent-manager/wiki` entry, it's preserved
 * (migrate is the command that cleans that up).
 */
function ensureAmWikiGitignore(projectDir: string): void {
  const gitignorePath = join(projectDir, ".gitignore");
  const entry = ".am-wiki/";
  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      if (
        content.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === ".am-wiki")
      ) {
        return;
      }
      const separator = content.endsWith("\n") ? "" : "\n";
      appendFileSync(gitignorePath, `${separator}${entry}\n`);
    } else {
      writeFileSync(gitignorePath, `${entry}\n`);
    }
  } catch {
    /* best effort */
  }
}

/**
 * Remove a line matching `.agent-manager/wiki` (legacy ADR-0022 ignore)
 * and add `.am-wiki/` if missing. Used by `am wiki migrate`.
 */
function rewriteGitignoreForMigration(projectDir: string): void {
  const gitignorePath = join(projectDir, ".gitignore");
  const newEntry = ".am-wiki/";
  const legacyEntries = new Set([".agent-manager/wiki", ".agent-manager/wiki/"]);
  try {
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, `${newEntry}\n`);
      return;
    }
    const original = readFileSync(gitignorePath, "utf-8");
    const lines = original.split(/\r?\n/);
    const filtered = lines.filter((line) => !legacyEntries.has(line.trim()));
    const hasNew = filtered.some((line) => line.trim() === newEntry || line.trim() === ".am-wiki");
    if (!hasNew) {
      // Drop trailing empty line(s) if any, then append cleanly.
      while (filtered.length > 0 && filtered[filtered.length - 1] === "") {
        filtered.pop();
      }
      filtered.push(newEntry);
    }
    writeFileSync(gitignorePath, `${filtered.join("\n")}\n`);
  } catch {
    /* best effort */
  }
}

/** ISO date stamp (YYYYMMDD) for migrate's backup dir name. */
function todayStamp(): string {
  // Full ISO timestamp YYYYMMDD-HHMMSS to avoid same-day backup collisions
  // when a user re-runs `am wiki migrate` after recreating a legacy layout.
  // Example: 20260505-143022
  const iso = new Date().toISOString(); // "2026-05-06T02:33:14.123Z"
  const date = iso.slice(0, 10).replace(/-/g, ""); // "20260506"
  const time = iso.slice(11, 19).replace(/:/g, ""); // "023314"
  return `${date}-${time}`;
}

/**
 * ADR-0044 task 5 — fresh-init `.am-wiki/` for the current project.
 * Replaces the ADR-0022 symlink-init behaviour. Legacy layouts are
 * detected and a deprecation warning is emitted pointing at the
 * `am wiki migrate` command (no silent rewrite).
 */
const initSubcommand = defineCommand({
  meta: { name: "init", description: "Initialize wiki for current project" },
  args: {
    project: { type: "string", description: "Explicit project name" },
    global: { type: "boolean", description: "Initialize global wiki only", default: false },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };

    if (args.global) {
      const wikiDir = resolveWikiDir({ global: true });
      await ensureWikiDirs(wikiDir);
      if (args.json) {
        output({ action: "init", scope: "global", wikiDir }, opts);
      } else {
        info(`Global wiki initialized at ${wikiDir}`, opts);
      }
      return;
    }

    // Project wiki
    const projectFile = resolveProjectConfig(process.cwd());
    if (!projectFile) {
      error(
        "Not in a project directory (no .agent-manager.toml found). Use --global for the global wiki.",
        opts,
      );
      process.exitCode = 1;
      return;
    }

    const projectDir = dirname(projectFile);
    const layout = detectLegacyWikiLayout(projectDir);

    // Legacy-only: deprecation warning, no rewrite.
    if (layout.hasLegacy && !layout.hasNew) {
      const msg =
        "Legacy wiki layout detected at .agent-manager/wiki/. Run `am wiki migrate` to upgrade to the ADR-0044 `.am-wiki/` layout.";
      warn(msg, opts);
      if (args.json) {
        output(
          {
            action: "init",
            scope: "project",
            status: "legacy-detected",
            legacyPath: layout.legacyPath,
            newPath: layout.newPath,
          },
          opts,
        );
      }
      return;
    }

    // New layout already present: idempotent no-op.
    if (layout.hasNew) {
      if (args.json) {
        output(
          {
            action: "init",
            scope: "project",
            status: "already-initialized",
            projectWikiDir: layout.newPath,
          },
          opts,
        );
      } else {
        info(`Project wiki already initialized at ${layout.newPath}`, opts);
      }
      return;
    }

    // Fresh init.
    const projectName = args.project ?? resolveProjectName(projectDir);
    const projectStoreDir = getProjectWikiDir(projectName);
    await ensureWikiDirs(projectStoreDir);

    mkdirSync(layout.newPath, { recursive: true });

    const result = await materialiseProject(projectDir, "all", { projectName });

    const agentsMdPath = join(layout.newPath, "AGENTS.md");
    if (!existsSync(agentsMdPath)) {
      writeFileSync(agentsMdPath, WIKI_AGENTS_MD_TEMPLATE, "utf-8");
    }

    ensureAmWikiGitignore(projectDir);

    if (args.json) {
      output(
        {
          action: "init",
          scope: "project",
          project: projectName,
          projectStoreDir,
          projectWikiDir: layout.newPath,
          materialised: result.copied.length,
        },
        opts,
      );
    } else {
      info(`Project wiki "${projectName}" initialized`, opts);
      info(`  Local:   ${layout.newPath}`, opts);
      info(`  Store:   ${projectStoreDir}`, opts);
      info(`  Materialised ${result.copied.length} entries`, opts);
    }
  },
});

/**
 * ADR-0044 task 6 — rewrite a legacy `.agent-manager/wiki/` project to
 * the new `.am-wiki/` layout. Backs up any real legacy directory to
 * `.agent-manager/wiki.backup-YYYYMMDD/`; symlinks are unlinked (the
 * target is the global store, which stays put).
 */
const migrateSubcommand = defineCommand({
  meta: {
    name: "migrate",
    description: "Migrate a legacy .agent-manager/wiki/ project to .am-wiki/ (ADR-0044)",
  },
  args: {
    "dry-run": { type: "boolean", description: "Plan only, no filesystem changes", default: false },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const dryRun = args["dry-run"] as boolean;

    const projectFile = resolveProjectConfig(process.cwd());
    if (!projectFile) {
      error("Not in a project directory (no .agent-manager.toml found).", opts);
      process.exitCode = 1;
      return;
    }

    const projectDir = dirname(projectFile);
    const layout = detectLegacyWikiLayout(projectDir);

    // Neither layout present.
    if (!layout.hasLegacy && !layout.hasNew) {
      if (args.json) {
        output({ action: "migrate", status: "nothing-to-migrate", projectDir }, opts);
      } else {
        info("Nothing to migrate; run `am wiki init` to start.", opts);
      }
      return;
    }

    // Both layouts present — ambiguous.
    if (layout.hasLegacy && layout.hasNew) {
      error(
        "Both `.agent-manager/wiki/` and `.am-wiki/` exist; resolve manually before re-running migrate.",
        opts,
      );
      process.exitCode = 1;
      return;
    }

    // New-only: already migrated.
    if (!layout.hasLegacy && layout.hasNew) {
      if (args.json) {
        output({ action: "migrate", status: "already-migrated", newPath: layout.newPath }, opts);
      } else {
        info("Already migrated.", opts);
      }
      return;
    }

    // Only legacy present — real migration.
    const stamp = todayStamp();
    const backupPath = join(projectDir, ".agent-manager", `wiki.backup-${stamp}`);

    // Detect symlink vs real directory.
    let isSymlink = false;
    try {
      isSymlink = lstatSync(layout.legacyPath).isSymbolicLink();
    } catch {
      /* ignore */
    }

    if (dryRun) {
      const plan = isSymlink
        ? `Would unlink symlink ${layout.legacyPath} and materialise global store into ${layout.newPath}.`
        : `Would rename ${layout.legacyPath} -> ${backupPath} and materialise global store into ${layout.newPath}.`;
      if (args.json) {
        output(
          {
            action: "migrate",
            status: "dry-run",
            projectDir,
            legacyPath: layout.legacyPath,
            backupPath: isSymlink ? null : backupPath,
            newPath: layout.newPath,
            isSymlink,
            dryRun: true,
          },
          opts,
        );
      } else {
        info(plan, opts);
      }
      return;
    }

    // Execute.
    let effectiveBackup: string | null = null;
    if (isSymlink) {
      try {
        unlinkSync(layout.legacyPath);
      } catch (err) {
        error(`Failed to unlink legacy symlink: ${errorMessage(err) ?? String(err)}`, opts);
        process.exitCode = 1;
        return;
      }
    } else {
      try {
        mkdirSync(dirname(backupPath), { recursive: true });
        renameSync(layout.legacyPath, backupPath);
        effectiveBackup = backupPath;
      } catch (err) {
        error(`Failed to back up legacy wiki dir: ${errorMessage(err) ?? String(err)}`, opts);
        process.exitCode = 1;
        return;
      }
    }

    // Ensure global project store exists, then materialise.
    const projectName = resolveProjectName(projectDir);
    const projectStoreDir = getProjectWikiDir(projectName);
    await ensureWikiDirs(projectStoreDir);

    mkdirSync(layout.newPath, { recursive: true });
    const result = await materialiseProject(projectDir, "all");

    const agentsMdPath = join(layout.newPath, "AGENTS.md");
    if (!existsSync(agentsMdPath)) {
      writeFileSync(agentsMdPath, WIKI_AGENTS_MD_TEMPLATE, "utf-8");
    }

    rewriteGitignoreForMigration(projectDir);

    if (args.json) {
      output(
        {
          action: "migrate",
          status: "migrated",
          projectDir,
          legacyPath: layout.legacyPath,
          backupPath: effectiveBackup,
          newPath: layout.newPath,
          materialised: result.copied.length,
          dryRun: false,
        },
        opts,
      );
    } else {
      if (isSymlink) {
        info(`Removed legacy symlink ${layout.legacyPath}`, opts);
      } else {
        info(`Backed up legacy dir -> ${backupPath}`, opts);
      }
      info(`Materialised ${result.copied.length} entries into ${layout.newPath}`, opts);
    }
  },
});

/**
 * ADR-0044 task 7 — promote a project-local `.am-wiki/` entry to the
 * global project store. Thin wrapper around `pushToGlobal`, with
 * `--auto` discovery (scans frontmatter for `promote: true`) and
 * `--force` passthrough for conflict resolution.
 */
const publishSubcommand = defineCommand({
  meta: { name: "publish", description: "Publish a local .am-wiki/ entry to the global store" },
  args: {
    slug: { type: "positional", description: "Slug to publish", required: false },
    auto: {
      type: "boolean",
      description: "Scan .am-wiki/ for entries with `promote: true` in frontmatter",
      default: false,
    },
    force: {
      type: "boolean",
      description: "Overwrite a differing global entry",
      default: false,
    },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const slugArg = (args.slug as string | undefined) ?? undefined;

    if (args.auto && slugArg) {
      error("Use either --auto or <slug>, not both.", opts);
      process.exitCode = 1;
      return;
    }
    if (!args.auto && !slugArg) {
      error("Specify either --auto or <slug>.", opts);
      process.exitCode = 1;
      return;
    }

    const projectFile = resolveProjectConfig(process.cwd());
    if (!projectFile) {
      error("Not in a project directory (no .agent-manager.toml found).", opts);
      process.exitCode = 1;
      return;
    }
    const projectDir = dirname(projectFile);
    const amWikiDir = join(projectDir, WIKI_PROJECT_DIRNAME);
    if (!existsSync(amWikiDir)) {
      error("No .am-wiki/ directory; run `am wiki init` first.", opts);
      process.exitCode = 1;
      return;
    }

    // Resolve the target slug list.
    let targets: string[];
    if (args.auto) {
      targets = discoverPromoteSlugs(amWikiDir);
      if (targets.length === 0) {
        if (args.json) {
          output({ action: "publish", published: [], conflicts: [] }, opts);
        } else {
          info("No entries with `promote: true` found.", opts);
        }
        return;
      }
    } else {
      targets = [slugArg!];
    }

    const published: string[] = [];
    const conflicts: string[] = [];
    for (const slug of targets) {
      try {
        const result = await pushToGlobal(projectDir, slug, { force: args.force });
        if (result.conflict) {
          conflicts.push(slug);
        } else {
          published.push(slug);
        }
      } catch (err) {
        error(`Failed to publish ${slug}: ${errorMessage(err) ?? String(err)}`, opts);
        process.exitCode = 1;
        return;
      }
    }

    if (args.json) {
      output({ action: "publish", published, conflicts }, opts);
    } else {
      for (const slug of published) {
        info(`Published: ${slug}`, opts);
      }
      for (const slug of conflicts) {
        error(
          `Conflict: ${slug} exists in global store with different content. Re-run with --force to overwrite.`,
          opts,
        );
      }
      info(`Summary: ${published.length} published, ${conflicts.length} conflict(s).`, opts);
    }

    if (conflicts.length > 0) {
      process.exitCode = 1;
    }
  },
});

/**
 * Walk `.am-wiki/` subdirectories and return slugs of `.md` files whose
 * parsed frontmatter contains a truthy `promote` flag.
 */
function discoverPromoteSlugs(amWikiDir: string): string[] {
  const out: string[] = [];
  let subdirs: string[];
  try {
    subdirs = readdirSync(amWikiDir, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => ent.name);
  } catch {
    return out;
  }
  for (const subdir of subdirs) {
    const subdirPath = join(amWikiDir, subdir);
    let files: string[];
    try {
      files = readdirSync(subdirPath).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const fullPath = join(subdirPath, file);
      let raw: string;
      try {
        raw = readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }
      const { metadata } = parseFrontmatter(raw);
      if (isTruthyPromoteValue(metadata.promote)) {
        out.push(file.slice(0, -3));
      }
    }
  }
  out.sort();
  return out;
}

function isTruthyPromoteValue(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const normalized = stripYamlInlineComment(value).trim().toLowerCase();
  return normalized === "true" || normalized === "yes";
}

function stripYamlInlineComment(value: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i);
    }
  }
  return value;
}

/**
 * ADR-0044 task 8 — OPT-IN pull: overwrite local `.am-wiki/` entries
 * with the current global content. Never invoked automatically.
 * Default behaviour is destructive ("global wins"); users who want a
 * conflict UI should build one on top of `materialiseProject`.
 */
const pullSubcommand = defineCommand({
  meta: {
    name: "pull",
    description: "Pull global-store entries into local .am-wiki/ (opt-in, global wins)",
  },
  args: {
    slug: { type: "positional", description: "Slug to pull", required: false },
    all: { type: "boolean", description: "Pull every entry", default: false },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const slugArg = (args.slug as string | undefined) ?? undefined;

    if (args.all && slugArg) {
      error("Use either --all or <slug>, not both.", opts);
      process.exitCode = 1;
      return;
    }
    if (!args.all && !slugArg) {
      error("Specify either --all or <slug>.", opts);
      process.exitCode = 1;
      return;
    }

    const projectFile = resolveProjectConfig(process.cwd());
    if (!projectFile) {
      error("Not in a project directory (no .agent-manager.toml found).", opts);
      process.exitCode = 1;
      return;
    }
    const projectDir = dirname(projectFile);

    // Detect whether `.am-wiki/` exists pre-pull. If absent and we end up
    // creating it via materialiseProject, also seed AGENTS.md and gitignore so
    // the layout matches `am wiki init` (ADR-0044 §6 invariants).
    const newPath = join(projectDir, WIKI_PROJECT_DIRNAME);
    const preExists = existsSync(newPath);

    const result = await materialiseProject(projectDir, args.all ? "all" : [slugArg!]);

    if (!preExists && existsSync(newPath)) {
      const agentsMdPath = join(newPath, "AGENTS.md");
      if (!existsSync(agentsMdPath)) {
        writeFileSync(agentsMdPath, WIKI_AGENTS_MD_TEMPLATE, "utf-8");
      }
      ensureAmWikiGitignore(projectDir);
    }

    if (args.json) {
      output({ action: "pull", copied: result.copied, skipped: result.skipped }, opts);
    } else {
      for (const slug of result.copied) {
        info(`Pulled: ${slug}`, opts);
      }
      info(`Summary: ${result.copied.length} copied, ${result.skipped.length} skipped.`, opts);
    }
  },
});

// ── Main Command ────────────────────────────────────────────────

export const wikiCommand = defineCommand({
  meta: { name: "wiki", description: "LLM Wiki — knowledge synthesis from agent sessions" },
  subCommands: {
    // Primary navigation (ADR-0031 pillar 5)
    list: () => Promise.resolve(listSubcommand),
    show: () => Promise.resolve(showSubcommand),
    search: () => Promise.resolve(searchSubcommand),
    sync: () => Promise.resolve(syncSubcommand),
    resolve: () => Promise.resolve(resolveSubcommand),
    path: () => Promise.resolve(pathSubcommand),
    // Authoring / maintenance
    init: () => Promise.resolve(initSubcommand),
    migrate: () => Promise.resolve(migrateSubcommand),
    publish: () => Promise.resolve(publishSubcommand),
    pull: () => Promise.resolve(pullSubcommand),
    add: () => Promise.resolve(addSubcommand),
    delete: () => Promise.resolve(deleteSubcommand),
    ingest: () => Promise.resolve(ingestSubcommand),
    harvest: () => Promise.resolve(harvestSubcommand),
    synthesize: () => Promise.resolve(synthesizeSubcommand),
    briefing: () => Promise.resolve(briefingSubcommand),
    export: () => Promise.resolve(exportSubcommand),
    import: () => Promise.resolve(importSubcommand),
    lint: () => Promise.resolve(lintSubcommand),
    graph: () => Promise.resolve(graphSubcommand),
  },
});
