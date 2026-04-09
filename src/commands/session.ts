import { defineCommand } from "citty";
import { getAdapter, listAdapters } from "../adapters/registry";
import {
  type SessionFilter,
  type SessionSummary,
  filterMessages,
  formatJson,
  formatMarkdown,
} from "../core/session";
import { error, info, output } from "../lib/output";

// ── Helpers ──────────────────────────────────────────────────────

async function getSessionAdapters(adapterFilter?: string) {
  const names = adapterFilter ? [adapterFilter] : listAdapters();
  const adapters: Array<{
    name: string;
    reader: NonNullable<Awaited<ReturnType<typeof getAdapter>>>["sessionReader"];
  }> = [];

  for (const name of names) {
    const adapter = await getAdapter(name);
    if (adapter?.sessionReader) {
      adapters.push({ name, reader: adapter.sessionReader });
    }
  }
  return adapters;
}

// ── Subcommands ──────────────────────────────────────────────────

const listSubcommand = defineCommand({
  meta: { name: "list", description: "List sessions across all tools" },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    adapter: { type: "string", description: "Filter to one adapter" },
    sort: {
      type: "string",
      description: "Sort by: date (default) or tokens",
      default: "date",
    },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };

    const adapters = await getSessionAdapters(args.adapter);
    if (adapters.length === 0) {
      if (args.adapter) {
        error(`Adapter "${args.adapter}" not found or has no session reader.`, opts);
      } else {
        error("No adapters with session reading capability found.", opts);
      }
      process.exitCode = 1;
      return;
    }

    const allSessions: SessionSummary[] = [];
    for (const { reader } of adapters) {
      if (!reader) continue;
      const sessions = await reader.listSessions();
      allSessions.push(...sessions);
    }

    // Sort
    if (args.sort === "tokens") {
      allSessions.sort((a, b) => (b.estimatedTokens ?? 0) - (a.estimatedTokens ?? 0));
    } else {
      allSessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    }

    if (args.json) {
      output(
        {
          sessions: allSessions.map((s) => ({
            ...s,
            startedAt: s.startedAt.toISOString(),
            endedAt: s.endedAt?.toISOString() ?? null,
          })),
        },
        opts,
      );
      return;
    }

    if (allSessions.length === 0) {
      info("No sessions found.", opts);
      return;
    }

    info(
      `${"ID".padEnd(30)} ${"Tool".padEnd(14)} ${"Project".padEnd(24)} ${"Msgs".padEnd(6)} ${"Date"}`,
      opts,
    );
    info(
      `${"─".repeat(30)} ${"─".repeat(14)} ${"─".repeat(24)} ${"─".repeat(6)} ${"─".repeat(20)}`,
      opts,
    );
    for (const s of allSessions) {
      const id = `${s.adapter}:${s.id}`;
      const project = s.project ?? "—";
      const date = s.startedAt.toISOString().slice(0, 16).replace("T", " ");
      info(
        `${id.padEnd(30)} ${s.adapter.padEnd(14)} ${project.padEnd(24)} ${String(s.messageCount).padEnd(6)} ${date}`,
        opts,
      );
    }
    info(`\n${allSessions.length} session(s)`, opts);
  },
});

const exportSubcommand = defineCommand({
  meta: { name: "export", description: "Export a session" },
  args: {
    id: { type: "positional", description: "Session ID (adapter:session-id)", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    role: { type: "string", description: "Filter to role: user, assistant, system, tool" },
    "no-tools": { type: "boolean", description: "Strip tool messages", default: false },
    "no-system": { type: "boolean", description: "Strip system messages", default: false },
    format: {
      type: "string",
      description: "Output format: md (default), json, raw",
      default: "md",
    },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const idStr = args.id as string;

    // Parse adapter:session-id
    const colonIdx = idStr.indexOf(":");
    if (colonIdx < 1) {
      error("Invalid session ID format. Expected: adapter:session-id", opts);
      process.exitCode = 1;
      return;
    }
    const adapterName = idStr.slice(0, colonIdx);
    const sessionId = idStr.slice(colonIdx + 1);

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

    // Build filter
    const filter: SessionFilter = {};
    if (args.role) {
      filter.roles = [
        args.role as SessionFilter["roles"] extends (infer T)[] | undefined ? T : never,
      ];
    }
    if (args["no-tools"]) filter.noTools = true;
    if (args["no-system"]) filter.noSystem = true;

    const fmt = args.format;
    if (fmt === "json") {
      console.log(JSON.stringify(formatJson(session, filter), null, 2));
    } else if (fmt === "raw") {
      const messages = filter ? filterMessages(session.messages, filter) : session.messages;
      for (const m of messages) {
        console.log(m.content);
      }
    } else {
      console.log(formatMarkdown(session, filter));
    }
  },
});

const searchSubcommand = defineCommand({
  meta: { name: "search", description: "Search across sessions" },
  args: {
    query: { type: "positional", description: "Search query", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
    role: { type: "string", description: "Filter to role: user, assistant, system, tool" },
    adapter: { type: "string", description: "Filter to one adapter" },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const query = args.query as string;

    const adapters = await getSessionAdapters(args.adapter);
    if (adapters.length === 0) {
      error("No adapters with session reading capability found.", opts);
      process.exitCode = 1;
      return;
    }

    const filter: SessionFilter = { query };
    if (args.role) {
      filter.roles = [
        args.role as SessionFilter["roles"] extends (infer T)[] | undefined ? T : never,
      ];
    }

    const results: Array<{
      sessionId: string;
      adapter: string;
      project?: string;
      matchCount: number;
      snippets: string[];
    }> = [];

    for (const { reader } of adapters) {
      if (!reader) continue;
      const summaries = await reader.listSessions();
      for (const summary of summaries) {
        const session = await reader.loadSession(summary.id);
        if (!session) continue;

        const matches = filterMessages(session.messages, filter);
        if (matches.length > 0) {
          const snippets = matches.slice(0, 3).map((m) => {
            const content = m.content;
            const idx = content.toLowerCase().indexOf(query.toLowerCase());
            const start = Math.max(0, idx - 40);
            const end = Math.min(content.length, idx + query.length + 40);
            return (
              (start > 0 ? "..." : "") +
              content.slice(start, end) +
              (end < content.length ? "..." : "")
            );
          });

          results.push({
            sessionId: `${summary.adapter}:${summary.id}`,
            adapter: summary.adapter,
            project: summary.project,
            matchCount: matches.length,
            snippets,
          });
        }
      }
    }

    if (args.json) {
      output({ query, results }, opts);
      return;
    }

    if (results.length === 0) {
      info(`No sessions match "${query}".`, opts);
      return;
    }

    for (const r of results) {
      info(`\n${r.sessionId}`, opts);
      if (r.project) info(`  Project: ${r.project}`, opts);
      info(`  ${r.matchCount} matching message(s)`, opts);
      for (const snippet of r.snippets) {
        info(`    > ${snippet}`, opts);
      }
    }
    info(`\n${results.length} session(s) matched "${query}"`, opts);
  },
});

// ── Main Command ─────────────────────────────────────────────────

export const sessionCommand = defineCommand({
  meta: { name: "session", description: "Browse and export tool sessions" },
  subCommands: {
    list: () => Promise.resolve(listSubcommand),
    export: () => Promise.resolve(exportSubcommand),
    search: () => Promise.resolve(searchSubcommand),
  },
});
