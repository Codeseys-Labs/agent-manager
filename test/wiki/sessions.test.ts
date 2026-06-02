import { describe, expect, test } from "bun:test";
import type { Adapter } from "../../src/adapters/types";
import type { Session, SessionReader, SessionSummary } from "../../src/core/session";
import {
  type AdapterSource,
  type EnumeratedSession,
  TOP_HARVEST_ADAPTERS,
  enumerateSessions,
  loadEnumeratedSession,
} from "../../src/wiki/sessions";

// ADR-0054 R8: the harvester enumerates sessions across the top-6 adapters via
// the EXISTING SessionReader interface (it never reimplements readers). These
// tests inject a fake adapter source so the enumeration logic is exercised
// hermetically — no filesystem, no real adapters.

// ── Fakes ───────────────────────────────────────────────────────

function makeSummary(id: string, adapter: string): SessionSummary {
  return {
    id,
    adapter,
    messageCount: 1,
    startedAt: new Date("2026-06-01T00:00:00Z"),
  };
}

interface FakeReaderOpts {
  hasStorage?: boolean;
  sessions?: SessionSummary[];
  listThrows?: boolean;
  loadThrows?: boolean;
  hasStorageThrows?: boolean;
  loadResult?: Session | null;
}

function makeReader(adapter: string, opts: FakeReaderOpts = {}): SessionReader {
  return {
    hasSessionStorage(): boolean {
      if (opts.hasStorageThrows) throw new Error("storage probe failed");
      return opts.hasStorage ?? true;
    },
    async listSessions(): Promise<SessionSummary[]> {
      if (opts.listThrows) throw new Error("list failed");
      return opts.sessions ?? [makeSummary(`${adapter}-s1`, adapter)];
    },
    async loadSession(id: string): Promise<Session | null> {
      if (opts.loadThrows) throw new Error("load failed");
      if (opts.loadResult !== undefined) return opts.loadResult;
      return {
        id,
        adapter,
        messages: [{ role: "user", content: "hi" }],
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

// ── Tests ───────────────────────────────────────────────────────

describe("wiki/sessions enumeration (ADR-0054 R8)", () => {
  test("TOP_HARVEST_ADAPTERS leads with claude-code and has six entries", () => {
    expect(TOP_HARVEST_ADAPTERS[0]).toBe("claude-code");
    expect(TOP_HARVEST_ADAPTERS.length).toBe(6);
    // No duplicates.
    expect(new Set(TOP_HARVEST_ADAPTERS).size).toBe(TOP_HARVEST_ADAPTERS.length);
  });

  test("default scope enumerates across the top-6 adapters", async () => {
    const adapters: Record<string, Adapter> = {};
    for (const name of TOP_HARVEST_ADAPTERS) {
      adapters[name] = makeAdapter(name, makeReader(name));
    }
    const result = await enumerateSessions({ source: makeSource(adapters) });

    // One session per adapter → six summaries, in priority order.
    expect(result.length).toBe(6);
    expect(result.map((r) => r.adapter)).toEqual([...TOP_HARVEST_ADAPTERS]);
    // Adapter field on the summary is normalised to the enumerating adapter.
    expect(result.every((r) => r.summary.adapter === r.adapter)).toBe(true);
  });

  test("skips adapters with no session reader", async () => {
    const adapters: Record<string, Adapter> = {
      "claude-code": makeAdapter("claude-code", makeReader("claude-code")),
      "codex-cli": makeAdapter("codex-cli"), // no reader
    };
    const result = await enumerateSessions({
      adapters: ["claude-code", "codex-cli"],
      source: makeSource(adapters),
    });
    expect(result.map((r) => r.adapter)).toEqual(["claude-code"]);
  });

  test("skips adapters whose storage is absent", async () => {
    const adapters: Record<string, Adapter> = {
      "claude-code": makeAdapter("claude-code", makeReader("claude-code", { hasStorage: false })),
      cursor: makeAdapter("cursor", makeReader("cursor", { hasStorage: true })),
    };
    const result = await enumerateSessions({
      adapters: ["claude-code", "cursor"],
      source: makeSource(adapters),
    });
    expect(result.map((r) => r.adapter)).toEqual(["cursor"]);
  });

  test("a throwing listSessions does not abort the sweep", async () => {
    const adapters: Record<string, Adapter> = {
      "claude-code": makeAdapter("claude-code", makeReader("claude-code", { listThrows: true })),
      cursor: makeAdapter("cursor", makeReader("cursor")),
    };
    const result = await enumerateSessions({
      adapters: ["claude-code", "cursor"],
      source: makeSource(adapters),
    });
    // claude-code threw and was skipped; cursor still enumerated.
    expect(result.map((r) => r.adapter)).toEqual(["cursor"]);
  });

  test("a throwing hasSessionStorage does not abort the sweep", async () => {
    const adapters: Record<string, Adapter> = {
      "claude-code": makeAdapter(
        "claude-code",
        makeReader("claude-code", { hasStorageThrows: true }),
      ),
      cursor: makeAdapter("cursor", makeReader("cursor")),
    };
    const result = await enumerateSessions({
      adapters: ["claude-code", "cursor"],
      source: makeSource(adapters),
    });
    expect(result.map((r) => r.adapter)).toEqual(["cursor"]);
  });

  test("limit caps total summaries in priority order", async () => {
    const adapters: Record<string, Adapter> = {
      "claude-code": makeAdapter(
        "claude-code",
        makeReader("claude-code", {
          sessions: [makeSummary("c1", "claude-code"), makeSummary("c2", "claude-code")],
        }),
      ),
      cursor: makeAdapter(
        "cursor",
        makeReader("cursor", { sessions: [makeSummary("u1", "cursor")] }),
      ),
    };
    const result = await enumerateSessions({
      adapters: ["claude-code", "cursor"],
      limit: 2,
      source: makeSource(adapters),
    });
    // Cap honoured; both come from the higher-priority adapter.
    expect(result.length).toBe(2);
    expect(result.every((r) => r.adapter === "claude-code")).toBe(true);
  });

  test("all:true enumerates every adapter that exposes a reader (registry order)", async () => {
    const adapters: Record<string, Adapter> = {
      "claude-code": makeAdapter("claude-code", makeReader("claude-code")),
      forgecode: makeAdapter("forgecode"), // no reader → excluded
      "roo-code": makeAdapter("roo-code", makeReader("roo-code")), // reader, NOT in top-6
    };
    const result = await enumerateSessions({ all: true, source: makeSource(adapters) });
    expect(result.map((r) => r.adapter).sort()).toEqual(["claude-code", "roo-code"]);
  });

  test("loadEnumeratedSession routes through the right adapter reader", async () => {
    const adapters: Record<string, Adapter> = {
      cursor: makeAdapter("cursor", makeReader("cursor")),
    };
    const enumerated: EnumeratedSession = {
      adapter: "cursor",
      summary: makeSummary("cursor-x", "cursor"),
    };
    const session = await loadEnumeratedSession(enumerated, makeSource(adapters));
    expect(session).not.toBeNull();
    expect(session!.adapter).toBe("cursor");
    expect(session!.id).toBe("cursor-x");
  });

  test("loadEnumeratedSession returns null when the reader load throws (no abort)", async () => {
    const adapters: Record<string, Adapter> = {
      cursor: makeAdapter("cursor", makeReader("cursor", { loadThrows: true })),
    };
    const enumerated: EnumeratedSession = {
      adapter: "cursor",
      summary: makeSummary("cursor-x", "cursor"),
    };
    const session = await loadEnumeratedSession(enumerated, makeSource(adapters));
    expect(session).toBeNull();
  });

  test("loadEnumeratedSession returns null for an adapter with no reader", async () => {
    const adapters: Record<string, Adapter> = { codex: makeAdapter("codex") };
    const enumerated: EnumeratedSession = {
      adapter: "codex",
      summary: makeSummary("x", "codex"),
    };
    expect(await loadEnumeratedSession(enumerated, makeSource(adapters))).toBeNull();
  });
});
