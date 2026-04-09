/**
 * CLI commands for the LLM Wiki / Knowledge Synthesis system (ADR-0020).
 *
 * Subcommands:
 *   am wiki search <query>           — search knowledge base
 *   am wiki add                      — interactive manual entry
 *   am wiki show <id>                — display full entry
 *   am wiki delete <id>              — remove with confirmation
 *   am wiki harvest [--session <id>] — extract from sessions
 *   am wiki synthesize <query>       — generate context block
 *   am wiki briefing <agent-id>      — generate agent briefing
 *   am wiki export [--format]        — export full knowledge base
 *   am wiki import <file>            — import entries
 */

import { readFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { getAdapter, listAdapters } from "../adapters/registry";
import { error, info, output } from "../lib/output";
import { harvestSession } from "../wiki/harvester";
import {
  addEntry,
  deleteEntry,
  getAllEntries,
  getEntry,
  getIndex,
  searchEntries,
} from "../wiki/storage";
import { buildAgentBriefing, generateWikiPage, synthesizeContext } from "../wiki/synthesizer";
import type { EntityType, KnowledgeEntry, KnowledgeSource, Provenance } from "../wiki/types";

// ── Subcommands ─────────────────────────────────────────────────

const searchSubcommand = defineCommand({
  meta: { name: "search", description: "Search the knowledge base" },
  args: {
    query: { type: "positional", description: "Search query", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    limit: { type: "string", description: "Max results", default: "20" },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const query = args.query as string;
    const limit = Number.parseInt(args.limit, 10) || 20;

    const entries = await searchEntries(query);
    const limited = entries.slice(0, limit);

    if (args.json) {
      output({ query, results: limited, total: entries.length }, opts);
      return;
    }

    if (limited.length === 0) {
      info(`No entries match "${query}".`, opts);
      return;
    }

    info(`${"ID".padEnd(38)} ${"Type".padEnd(14)} ${"Conf".padEnd(6)} ${"Content"}`, opts);
    info(`${"─".repeat(38)} ${"─".repeat(14)} ${"─".repeat(6)} ${"─".repeat(40)}`, opts);

    for (const entry of limited) {
      const contentPreview = entry.content.split("\n")[0].slice(0, 60);
      info(
        `${entry.id.padEnd(38)} ${entry.entity_type.padEnd(14)} ${entry.confidence.toFixed(2).padEnd(6)} ${contentPreview}`,
        opts,
      );
    }

    info(`\n${entries.length} result(s) for "${query}"`, opts);
  },
});

const addSubcommand = defineCommand({
  meta: { name: "add", description: "Add a manual knowledge entry" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
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

const showSubcommand = defineCommand({
  meta: { name: "show", description: "Display a knowledge entry" },
  args: {
    id: { type: "positional", description: "Entry ID", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const id = args.id as string;

    const entry = await getEntry(id);
    if (!entry) {
      error(`Entry "${id}" not found.`, opts);
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
    if (entry.references.length > 0) {
      info("", opts);
      info("References:", opts);
      for (const ref of entry.references) {
        info(`  - ${ref}`, opts);
      }
    }
  },
});

const deleteSubcommand = defineCommand({
  meta: { name: "delete", description: "Delete a knowledge entry" },
  args: {
    id: { type: "positional", description: "Entry ID", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    force: { type: "boolean", alias: "f", description: "Skip confirmation", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const id = args.id as string;

    const entry = await getEntry(id);
    if (!entry) {
      error(`Entry "${id}" not found.`, opts);
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

    await deleteEntry(id);

    if (args.json) {
      output({ action: "delete", id }, opts);
    } else {
      info(`Deleted entry ${id}`, opts);
    }
  },
});

const harvestSubcommand = defineCommand({
  meta: { name: "harvest", description: "Extract knowledge from sessions" },
  args: {
    session: { type: "string", description: "Specific session ID (adapter:session-id)" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    adapter: { type: "string", description: "Filter to one adapter" },
    limit: { type: "string", description: "Max sessions to process", default: "10" },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const maxSessions = Number.parseInt(args.limit, 10) || 10;

    // If a specific session is given, harvest just that one
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

    // Harvest from all sessions (or filtered by adapter)
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

      // Sort by most recent first, limit
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
    agent: { type: "string", description: "Filter to agent ID" },
    "top-k": { type: "string", description: "Number of entries to include", default: "10" },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const query = args.query as string;
    const topK = Number.parseInt(args["top-k"], 10) || 10;

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
      // Group by tags and generate wiki pages
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
      // JSON export
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
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const filePath = args.file as string;

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err: any) {
      error(`Cannot read file: ${filePath} (${err?.code ?? err?.message})`, opts);
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

    // Accept either { entries: [...] } or a raw array
    let entries: KnowledgeEntry[];
    if (Array.isArray(data)) {
      entries = data as KnowledgeEntry[];
    } else if (
      data &&
      typeof data === "object" &&
      "entries" in data &&
      Array.isArray((data as any).entries)
    ) {
      entries = (data as any).entries as KnowledgeEntry[];
    } else {
      error("Expected a JSON array of entries or an object with an 'entries' array.", opts);
      process.exitCode = 1;
      return;
    }

    let imported = 0;
    let skipped = 0;

    for (const entry of entries) {
      // Assign new ID if missing
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

    if (args.json) {
      output({ action: "import", file: filePath, imported, skipped }, opts);
    } else {
      info(`Imported ${imported} entries (${skipped} skipped) from ${filePath}`, opts);
    }
  },
});

// ── Main Command ────────────────────────────────────────────────

export const wikiCommand = defineCommand({
  meta: { name: "wiki", description: "LLM Wiki — knowledge synthesis from agent sessions" },
  subCommands: {
    search: () => Promise.resolve(searchSubcommand),
    add: () => Promise.resolve(addSubcommand),
    show: () => Promise.resolve(showSubcommand),
    delete: () => Promise.resolve(deleteSubcommand),
    harvest: () => Promise.resolve(harvestSubcommand),
    synthesize: () => Promise.resolve(synthesizeSubcommand),
    briefing: () => Promise.resolve(briefingSubcommand),
    export: () => Promise.resolve(exportSubcommand),
    import: () => Promise.resolve(importSubcommand),
  },
});
