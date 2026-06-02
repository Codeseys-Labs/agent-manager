/**
 * ADR-0054 R8 (wiring) — `am wiki ingest` / `am wiki harvest` enumerate across
 * the TOP harvest adapters via the SHARED `src/wiki/sessions.ts` module, not a
 * private claude-code-only loop.
 *
 * These drive the real citty subcommands (same harness as wiki-wave-c) and
 * inject a fake `AdapterSource` through the `__setSweepSourceForTests` seam so
 * the enumeration is hermetic and deterministic — no real session files, and no
 * process-global `mock.module` (which leaks across Bun test files). The proof:
 *  - with NO --adapter filter, sessions from MULTIPLE top-6 adapters are
 *    harvested (the pre-R8 gap was that only claude-code ever fed the wiki);
 *  - a --adapter filter scopes enumeration to one tool;
 *  - the shared module's skip-broken-reader behaviour is honoured end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Adapter } from "../../src/adapters/types";
import {
  __setLlmExtractorForTests,
  __setSweepSourceForTests,
  wikiCommand,
} from "../../src/commands/wiki";
import type { Session, SessionReader, SessionSummary } from "../../src/core/session";
import type { LlmExtractor } from "../../src/wiki/harvester";
import type { AdapterSource } from "../../src/wiki/sessions";
import { TOP_HARVEST_ADAPTERS } from "../../src/wiki/sessions";
import { listPages } from "../../src/wiki/storage";
import type { KnowledgeEntry } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ── citty introspection ─────────────────────────────────────────

type SubcommandRunner = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> };

async function runSub(name: string, args: Record<string, unknown>): Promise<void> {
  const subs = (wikiCommand as unknown as { subCommands: Record<string, () => Promise<unknown>> })
    .subCommands;
  const cmd = (await subs[name]()) as SubcommandRunner;
  await cmd.run({ args });
}

// ── Console capture ─────────────────────────────────────────────

let stdoutLines: string[] = [];
const origLog = console.log;
function captureConsole() {
  stdoutLines = [];
  console.log = (...chunks: unknown[]) => {
    stdoutLines.push(chunks.map(String).join(" "));
  };
}
function restoreConsole() {
  console.log = origLog;
}

// ── Fake adapter source ─────────────────────────────────────────

function makeSummary(id: string, adapter: string): SessionSummary {
  return { id, adapter, messageCount: 2, startedAt: new Date("2026-06-01T00:00:00Z") };
}

function makeReader(adapter: string, opts: { listThrows?: boolean } = {}): SessionReader {
  return {
    hasSessionStorage: () => true,
    async listSessions(): Promise<SessionSummary[]> {
      if (opts.listThrows) throw new Error("list failed");
      return [makeSummary(`${adapter}-s1`, adapter)];
    },
    async loadSession(id: string): Promise<Session | null> {
      return {
        id,
        adapter,
        // A user message that the heuristic fact-extractor will turn into a page,
        // tagged with the adapter so we can assert per-adapter provenance.
        messages: [
          {
            role: "user",
            content: `The ${adapter} project is built with Bun and uses src as the entry point.`,
          },
        ],
        startedAt: new Date(),
      };
    },
  };
}

function makeAdapter(name: string, reader?: SessionReader): Adapter {
  return {
    meta: { name, displayName: name, version: "0.0.0", capabilities: [] },
    detect: () => ({ installed: false, paths: {} }),
    import: () => ({ servers: [], instructions: [], skills: [], warnings: [] }),
    export: () => ({ files: [], warnings: [] }),
    diff: () => ({ status: "unmanaged", changes: [] }),
    ...(reader ? { sessionReader: reader } : {}),
  };
}

function makeSource(adapters: Record<string, Adapter>): AdapterSource {
  return {
    listAdapters: () => Object.keys(adapters),
    getAdapter: async (name: string) => adapters[name],
  };
}

describe("ADR-0054 R8 wiring — ingest/harvest enumerate via the shared sessions module", () => {
  let configHome: TestDir;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    configHome = await createTestDir("r8-wire-cfg-");
    savedEnv = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = configHome.path;
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    __setSweepSourceForTests(null);
    __setLlmExtractorForTests(null);
    restoreConsole();
    process.exitCode = 0;
    if (savedEnv === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = savedEnv;
    }
    await configHome.cleanup();
  });

  test("ingest (no --adapter) harvests sessions from MULTIPLE top-6 adapters", async () => {
    // Three of the top-6 adapters expose a reader; the pre-R8 inline loop would
    // only ever have reached claude-code in practice.
    const adapters: Record<string, Adapter> = {
      "claude-code": makeAdapter("claude-code", makeReader("claude-code")),
      "codex-cli": makeAdapter("codex-cli", makeReader("codex-cli")),
      cursor: makeAdapter("cursor", makeReader("cursor")),
    };
    __setSweepSourceForTests(makeSource(adapters));

    await runSub("ingest", {
      session: undefined,
      json: true,
      quiet: false,
      verbose: false,
      adapter: undefined,
      limit: "10",
      "llm-extract": false,
      global: false,
    });

    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload.action).toBe("ingest");
    // One session per adapter → three sessions enumerated across the top-6.
    expect(payload.sessions_processed).toBe(3);
    expect(payload.pages_created).toBeGreaterThanOrEqual(3);

    // Each adapter's session contributed a page carrying that adapter's source
    // (proves cross-adapter enumeration, not a single-tool sweep).
    const pages = await listPages();
    const sources = pages.flatMap((p) => p.sources);
    expect(sources.some((s) => s.startsWith("claude-code:"))).toBe(true);
    expect(sources.some((s) => s.startsWith("codex-cli:"))).toBe(true);
    expect(sources.some((s) => s.startsWith("cursor:"))).toBe(true);
  });

  test("ingest --adapter scopes enumeration to a single tool", async () => {
    const adapters: Record<string, Adapter> = {
      "claude-code": makeAdapter("claude-code", makeReader("claude-code")),
      "codex-cli": makeAdapter("codex-cli", makeReader("codex-cli")),
    };
    __setSweepSourceForTests(makeSource(adapters));

    await runSub("ingest", {
      session: undefined,
      json: true,
      quiet: false,
      verbose: false,
      adapter: "codex-cli",
      limit: "10",
      "llm-extract": false,
      global: false,
    });

    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload.sessions_processed).toBe(1);

    const pages = await listPages();
    const sources = pages.flatMap((p) => p.sources);
    expect(sources.some((s) => s.startsWith("codex-cli:"))).toBe(true);
    expect(sources.some((s) => s.startsWith("claude-code:"))).toBe(false);
  });

  test("harvest (no --adapter) enumerates the top adapters and a broken reader does not abort", async () => {
    const adapters: Record<string, Adapter> = {
      // claude-code's listSessions throws — the shared module skips it.
      "claude-code": makeAdapter("claude-code", makeReader("claude-code", { listThrows: true })),
      "codex-cli": makeAdapter("codex-cli", makeReader("codex-cli")),
      cursor: makeAdapter("cursor", makeReader("cursor")),
    };
    __setSweepSourceForTests(makeSource(adapters));

    await runSub("harvest", {
      session: undefined,
      json: true,
      quiet: false,
      verbose: false,
      adapter: undefined,
      limit: "10",
      "llm-extract": false,
      global: false,
    });

    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload.action).toBe("harvest");
    // claude-code threw and was skipped; codex-cli + cursor still enumerated.
    expect(payload.sessions_processed).toBe(2);
    expect(payload.entries_added).toBeGreaterThanOrEqual(1);
  });

  test("the default enumeration order follows TOP_HARVEST_ADAPTERS priority", async () => {
    // Build every top-6 adapter with a reader; ingest with limit 1 must pick the
    // highest-priority adapter (claude-code) first.
    const adapters: Record<string, Adapter> = {};
    for (const name of TOP_HARVEST_ADAPTERS) {
      adapters[name] = makeAdapter(name, makeReader(name));
    }
    __setSweepSourceForTests(makeSource(adapters));

    await runSub("ingest", {
      session: undefined,
      json: true,
      quiet: false,
      verbose: false,
      adapter: undefined,
      limit: "1",
      "llm-extract": false,
      global: false,
    });

    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload.sessions_processed).toBe(1);
    const pages = await listPages();
    const sources = pages.flatMap((p) => p.sources);
    // All summaries share the same startedAt, so priority order (claude-code
    // first) decides the single session the cap admits.
    expect(sources.every((s) => s.startsWith("claude-code:"))).toBe(true);
  });

  // ── R8 LLM-surface: --llm-extract flips the gate (no real LLM) ──────

  function makeLlmEntry(content: string): KnowledgeEntry {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      source: { type: "session_harvest", timestamp: now },
      extracted_at: now,
      confidence: 0.9,
      entity_type: "fact",
      content,
      context: "",
      tags: ["llm-synthesized"],
      references: [],
      provenance: {
        created_by: "test-llm",
        created_at: now,
        last_modified: now,
        modification_history: [],
        verified: false,
      },
    };
  }

  test("--llm-extract flips llmExtraction on (injected extractor runs) — no real LLM", async () => {
    const adapters: Record<string, Adapter> = {
      "claude-code": makeAdapter("claude-code", makeReader("claude-code")),
    };
    __setSweepSourceForTests(makeSource(adapters));

    let called = false;
    const extractor: LlmExtractor = {
      extract() {
        called = true;
        // A pure interface call — no network, no credentials (ADR-0010).
        return [makeLlmEntry("synthesized insight from the harvest flag path")];
      },
    };
    __setLlmExtractorForTests(extractor);

    await runSub("harvest", {
      session: undefined,
      json: true,
      quiet: false,
      verbose: false,
      adapter: undefined,
      limit: "10",
      "llm-extract": true,
      global: false,
    });

    // The gate opened: the injected extractor was invoked by harvestSession.
    expect(called).toBe(true);
    // Its synthesized entry was persisted as a page (the flag's effect is real).
    const pages = await listPages();
    expect(
      pages.some((p) => p.content.includes("synthesized insight from the harvest flag path")),
    ).toBe(true);
  });

  test("WITHOUT --llm-extract the gate stays closed (injected extractor is never called)", async () => {
    const adapters: Record<string, Adapter> = {
      "claude-code": makeAdapter("claude-code", makeReader("claude-code")),
    };
    __setSweepSourceForTests(makeSource(adapters));

    let called = false;
    __setLlmExtractorForTests({
      extract() {
        called = true;
        return [makeLlmEntry("must not appear")];
      },
    });

    await runSub("ingest", {
      session: undefined,
      json: true,
      quiet: false,
      verbose: false,
      adapter: undefined,
      limit: "10",
      "llm-extract": false,
      global: false,
    });

    // Default-off: the gate never opens, so the extractor is never consulted.
    expect(called).toBe(false);
    const pages = await listPages();
    expect(pages.some((p) => p.content.includes("must not appear"))).toBe(false);
  });
});
