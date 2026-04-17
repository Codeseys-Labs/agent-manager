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

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineCommand } from "citty";
import { getAdapter, listAdapters } from "../adapters/registry";
import { resolveProjectConfig } from "../core/config";
import { getStatus, pull as gitPull, push as gitPush } from "../core/git";
import { errorCode, errorMessage } from "../lib/errors";
import { error, info, output, parsePositiveInt, warn } from "../lib/output";
import { exportGraphForViz, findOrphans, loadGraph } from "../wiki/graph";
import { harvestSession, harvestSessionAsPages } from "../wiki/harvester";
import {
  addEntry,
  createProjectWikiLink,
  deleteEntry,
  deletePage,
  ensureWikiDirs,
  ensureWikiGitignore,
  getAllEntries,
  getEntry,
  getIndex,
  getProjectWikiDir,
  listPages,
  readPage,
  rebuildSearchIndex,
  resolveProjectName,
  resolveWikiDir,
  searchEntries,
  searchPages,
  writePage,
} from "../wiki/storage";
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

const briefingSubcommand = defineCommand({
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

    const entries = await getAllEntries();
    const briefing = buildAgentBriefing(entries, agentId);

    if (args.json) {
      output({ agent_id: agentId, briefing }, opts);
    } else {
      info(briefing, opts);
    }
  },
});

const exportSubcommand = defineCommand({
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

    const entries = await getAllEntries();
    const index = await getIndex();

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

const lintSubcommand = defineCommand({
  meta: { name: "lint", description: "Check for orphans, stale pages, broken links" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    global: { type: "boolean", description: "Use global wiki", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };

    const pages = await listPages();
    const graph = await loadGraph();

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

const graphSubcommand = defineCommand({
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
    const graph = await loadGraph();

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

// TODO(ADR-0031/M4 follow-up): wiki sync is currently a thin wrapper around
// isomorphic-git push/pull on the global wiki root. Project wiki sync is out
// of scope for M4 because the central store is symlinked per ADR-0022 and the
// authoritative repo lives in the config dir. A richer sync (commit unstaged
// wiki edits, conflict resolution, per-project remotes) is left for M5.
export const syncSubcommand = defineCommand({
  meta: { name: "sync", description: "Push/pull the global wiki via git" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    direction: {
      type: "string",
      description: "push | pull | both",
      default: "both",
    },
    remote: { type: "string", description: "Git remote name", default: "origin" },
    branch: { type: "string", description: "Git branch name (default: current)" },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const wikiDir = resolveWikiDir({ global: true });
    const direction = (args.direction as string).toLowerCase();

    if (!["push", "pull", "both"].includes(direction)) {
      error(`Invalid --direction "${direction}". Expected: push | pull | both.`, opts);
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

    if (!status.clean && (direction === "pull" || direction === "both")) {
      warn(
        `Wiki working tree has ${status.dirty.length} uncommitted change(s); pulling anyway (isomorphic-git will refuse on conflict).`,
        opts,
      );
    }

    const remote = args.remote as string;
    const branch = args.branch as string | undefined;
    const actions: Array<{ action: "pull" | "push"; ok: boolean; error?: string }> = [];

    if (direction === "pull" || direction === "both") {
      try {
        await gitPull(wikiDir, remote, branch);
        actions.push({ action: "pull", ok: true });
        info(`Pulled wiki from ${remote}`, opts);
      } catch (err: unknown) {
        const msg = errorMessage(err) ?? "pull failed";
        actions.push({ action: "pull", ok: false, error: msg });
        error(`Pull failed: ${msg}`, opts);
        process.exitCode = 1;
        if (direction === "pull") {
          if (args.json) output({ action: "sync", wikiDir, remote, results: actions }, opts);
          return;
        }
      }
    }

    if (direction === "push" || direction === "both") {
      try {
        await gitPush(wikiDir, remote, branch);
        actions.push({ action: "push", ok: true });
        info(`Pushed wiki to ${remote}`, opts);
      } catch (err: unknown) {
        const msg = errorMessage(err) ?? "push failed";
        actions.push({ action: "push", ok: false, error: msg });
        error(`Push failed: ${msg}`, opts);
        process.exitCode = 1;
      }
    }

    if (args.json) {
      output({ action: "sync", wikiDir, remote, branch: status.branch, results: actions }, opts);
    }
  },
});

// ── Init Subcommand (ADR-0022) ──────────────────────────────────

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
    const projectName = args.project ?? resolveProjectName(projectDir);
    const projectWikiDir = getProjectWikiDir(projectName);

    await ensureWikiDirs(projectWikiDir);
    createProjectWikiLink(projectDir, projectName);
    ensureWikiGitignore(projectDir);

    if (args.json) {
      output(
        {
          action: "init",
          scope: "project",
          project: projectName,
          central: projectWikiDir,
          symlink: join(projectDir, ".agent-manager", "wiki"),
        },
        opts,
      );
    } else {
      info(`Project wiki "${projectName}" initialized`, opts);
      info(`  Central: ${projectWikiDir}`, opts);
      info(`  Symlink: ${join(projectDir, ".agent-manager", "wiki")}`, opts);
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
    path: () => Promise.resolve(pathSubcommand),
    // Authoring / maintenance
    init: () => Promise.resolve(initSubcommand),
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
