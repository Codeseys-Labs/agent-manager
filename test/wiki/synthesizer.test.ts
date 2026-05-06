import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildAgentBriefing,
  generateWikiPage,
  identifyGaps,
  synthesizeContext,
} from "../../src/wiki/synthesizer";
import type { KnowledgeEntry } from "../../src/wiki/types";

// ── Helpers ─────────────────────────────────────────────────────

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = new Date().toISOString();
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    source: {
      type: "session_harvest",
      session_id: "session-001",
      agent_id: "agent-1",
      timestamp: now,
    },
    extracted_at: now,
    confidence: 0.8,
    entity_type: "fact",
    content: "TypeScript strict mode is enabled.",
    context: "Found in tsconfig.json analysis.",
    tags: ["typescript", "config"],
    references: [],
    provenance: {
      created_by: "harvester",
      created_at: now,
      last_modified: now,
      modification_history: [{ timestamp: now, action: "created", by: "harvester" }],
      verified: false,
    },
    ...overrides,
  };
}

function makeEntrySet(): KnowledgeEntry[] {
  const now = new Date().toISOString();
  return [
    makeEntry({
      id: "fact-1",
      entity_type: "fact",
      content: "Project uses Bun runtime.",
      confidence: 0.9,
      tags: ["bun", "runtime"],
    }),
    makeEntry({
      id: "proc-1",
      entity_type: "procedure",
      content: "Run bun test to execute tests.",
      confidence: 0.85,
      tags: ["testing"],
    }),
    makeEntry({
      id: "pref-1",
      entity_type: "preference",
      content: "User prefers strict TypeScript.",
      confidence: 0.7,
      tags: ["typescript"],
      source: {
        type: "session_harvest",
        session_id: "session-002",
        agent_id: "agent-2",
        timestamp: now,
      },
    }),
    makeEntry({
      id: "cap-1",
      entity_type: "capability",
      content: "Agent can manage MCP servers.",
      confidence: 0.75,
      tags: ["mcp"],
    }),
    makeEntry({
      id: "rel-1",
      entity_type: "relationship",
      content: "Bun runtime relates to TypeScript config.",
      confidence: 0.6,
      tags: ["bun", "typescript"],
      references: ["fact-1"],
    }),
  ];
}

// ── generateWikiPage ────────────────────────────────────────────

describe("generateWikiPage", () => {
  test("produces markdown with title and entry count", () => {
    const entries = makeEntrySet();
    const page = generateWikiPage("TypeScript Configuration", entries);

    expect(page).toContain("# TypeScript Configuration");
    expect(page).toContain(`${entries.length} knowledge entries`);
  });

  test("groups entries by entity type with correct section headers", () => {
    const entries = makeEntrySet();
    const page = generateWikiPage("Project Overview", entries);

    expect(page).toContain("## Facts");
    expect(page).toContain("## Procedures");
    expect(page).toContain("## Preferences");
    expect(page).toContain("## Capabilities");
    expect(page).toContain("## Relationships");
  });

  test("sorts entries by confidence within sections", () => {
    const entries = [
      makeEntry({ entity_type: "fact", content: "Low confidence fact.", confidence: 0.2 }),
      makeEntry({ entity_type: "fact", content: "High confidence fact.", confidence: 0.95 }),
      makeEntry({ entity_type: "fact", content: "Medium confidence fact.", confidence: 0.5 }),
    ];

    const page = generateWikiPage("Test", entries);
    const highIdx = page.indexOf("High confidence fact");
    const medIdx = page.indexOf("Medium confidence fact");
    const lowIdx = page.indexOf("Low confidence fact");

    // Higher confidence should appear first
    expect(highIdx).toBeLessThan(medIdx);
    expect(medIdx).toBeLessThan(lowIdx);
  });

  test("includes confidence labels (HIGH/MED/LOW)", () => {
    const entries = [
      makeEntry({ content: "High conf item.", confidence: 0.9 }),
      makeEntry({ content: "Med conf item.", confidence: 0.5 }),
      makeEntry({ content: "Low conf item.", confidence: 0.2 }),
    ];

    const page = generateWikiPage("Labels", entries);

    expect(page).toContain("[HIGH]");
    expect(page).toContain("[MED]");
    expect(page).toContain("[LOW]");
  });

  test("includes tags summary section", () => {
    const entries = [
      makeEntry({ tags: ["typescript", "config"] }),
      makeEntry({ tags: ["bun", "runtime"] }),
    ];

    const page = generateWikiPage("Tags", entries);
    expect(page).toContain("## Tags");
    expect(page).toContain("bun");
    expect(page).toContain("typescript");
  });

  test("includes sources section with session IDs", () => {
    const entries = [
      makeEntry({
        source: {
          type: "session_harvest",
          session_id: "sess-abc",
          timestamp: new Date().toISOString(),
        },
      }),
    ];

    const page = generateWikiPage("Sources", entries);
    expect(page).toContain("## Sources");
    expect(page).toContain("sess-abc");
  });

  test("handles empty entries gracefully", () => {
    const page = generateWikiPage("Empty Topic", []);

    expect(page).toContain("# Empty Topic");
    expect(page).toContain("No knowledge entries found");
  });

  test("includes context lines when present", () => {
    const entries = [
      makeEntry({
        content: "Main content here.",
        context: "This came from analyzing tsconfig.json.",
      }),
    ];

    const page = generateWikiPage("Context", entries);
    expect(page).toContain("This came from analyzing tsconfig.json");
  });
});

// ── identifyGaps ────────────────────────────────────────────────

describe("identifyGaps", () => {
  test("returns gap for empty entries", () => {
    const gaps = identifyGaps([]);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].area).toBe("No knowledge entries");
    expect(gaps[0].confidence).toBe(0);
    expect(gaps[0].suggestion).toContain("am wiki ingest");
  });

  test("returns gaps for missing entity types", () => {
    // Only provide "fact" entries — missing procedure, preference, capability, relationship
    const entries = [makeEntry({ entity_type: "fact" })];

    const gaps = identifyGaps(entries);
    const gapAreas = gaps.map((g) => g.area);

    expect(gapAreas).toContain("Missing procedure entries");
    expect(gapAreas).toContain("Missing preference entries");
    expect(gapAreas).toContain("Missing capability entries");
    expect(gapAreas).toContain("Missing relationship entries");
  });

  test("no missing type gaps when all types present", () => {
    const entries = makeEntrySet(); // has all 5 types

    const gaps = identifyGaps(entries);
    const missingTypeGaps = gaps.filter((g) => g.area.startsWith("Missing"));

    expect(missingTypeGaps).toHaveLength(0);
  });

  test("detects low overall confidence", () => {
    // Create entries where >50% have low confidence
    const entries = [
      makeEntry({ confidence: 0.1 }),
      makeEntry({ confidence: 0.2 }),
      makeEntry({ confidence: 0.15 }),
      makeEntry({ confidence: 0.9 }), // one high
    ];

    const gaps = identifyGaps(entries);
    const lowConfGap = gaps.find((g) => g.area === "Low overall confidence");

    expect(lowConfGap).toBeDefined();
    expect(lowConfGap!.suggestion).toContain("low confidence");
  });

  test("detects isolated entries (no cross-references)", () => {
    // >80% entries with no references
    const entries = [
      makeEntry({ references: [] }),
      makeEntry({ references: [] }),
      makeEntry({ references: [] }),
      makeEntry({ references: [] }),
      makeEntry({ references: [] }),
    ];

    const gaps = identifyGaps(entries);
    const isolatedGap = gaps.find((g) => g.area === "Isolated entries");

    expect(isolatedGap).toBeDefined();
    expect(isolatedGap!.suggestion).toContain("cross-references");
  });

  test("filters by agentId", () => {
    const entries = [
      makeEntry({
        entity_type: "fact",
        source: {
          type: "session_harvest",
          agent_id: "agent-A",
          timestamp: new Date().toISOString(),
        },
      }),
      makeEntry({
        entity_type: "procedure",
        source: {
          type: "session_harvest",
          agent_id: "agent-B",
          timestamp: new Date().toISOString(),
        },
      }),
    ];

    // agent-A only has "fact" — should flag missing other types
    const gaps = identifyGaps(entries, "agent-A");
    const missingProc = gaps.find((g) => g.area === "Missing procedure entries");
    expect(missingProc).toBeDefined();
  });

  test("detects stale knowledge (>30 days old)", () => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();

    const entries = [makeEntry({ extracted_at: oldDate }), makeEntry({ extracted_at: oldDate })];

    const gaps = identifyGaps(entries);
    const staleGap = gaps.find((g) => g.area === "Stale knowledge");

    expect(staleGap).toBeDefined();
    expect(staleGap!.suggestion).toContain("older than 30 days");
  });

  test("detects sparse topics (many tags with only 1 entry each)", () => {
    // Need >3 tags with exactly 1 entry each
    const entries = [
      makeEntry({ tags: ["alpha"] }),
      makeEntry({ tags: ["beta"] }),
      makeEntry({ tags: ["gamma"] }),
      makeEntry({ tags: ["delta"] }),
    ];

    const gaps = identifyGaps(entries);
    const sparseGap = gaps.find((g) => g.area === "Sparse topics");

    expect(sparseGap).toBeDefined();
    expect(sparseGap!.suggestion).toContain("topics have only 1 entry");
  });
});

// ── buildAgentBriefing ──────────────────────────────────────────

describe("buildAgentBriefing", () => {
  test("produces markdown briefing with agent ID in title", () => {
    const entries = makeEntrySet();
    const briefing = buildAgentBriefing(entries, "agent-1");

    expect(briefing).toContain("# Agent Briefing: agent-1");
    expect(briefing).toContain("Generated:");
  });

  test("includes key facts section for high-confidence facts", () => {
    const entries = [
      makeEntry({
        entity_type: "fact",
        content: "Bun is the runtime.",
        confidence: 0.9,
        source: {
          type: "session_harvest",
          agent_id: "agent-1",
          timestamp: new Date().toISOString(),
        },
      }),
    ];

    const briefing = buildAgentBriefing(entries, "agent-1");
    expect(briefing).toContain("## Key Facts");
    expect(briefing).toContain("Bun is the runtime");
  });

  test("includes procedures section", () => {
    const entries = [
      makeEntry({
        entity_type: "procedure",
        content: "Run bun test to execute tests.",
        confidence: 0.85,
        source: {
          type: "session_harvest",
          agent_id: "agent-1",
          timestamp: new Date().toISOString(),
        },
      }),
    ];

    const briefing = buildAgentBriefing(entries, "agent-1");
    expect(briefing).toContain("## Known Procedures");
    expect(briefing).toContain("Run bun test");
  });

  test("includes user preferences from ALL entries (not just agent-specific)", () => {
    const entries = [
      makeEntry({
        entity_type: "preference",
        content: "User prefers strict TypeScript.",
        confidence: 0.8,
        source: {
          type: "session_harvest",
          agent_id: "agent-OTHER",
          timestamp: new Date().toISOString(),
        },
      }),
    ];

    // Briefing is for agent-1, but preferences come from all entries
    const briefing = buildAgentBriefing(entries, "agent-1");
    expect(briefing).toContain("## User Preferences");
    expect(briefing).toContain("strict TypeScript");
  });

  test("includes capabilities section", () => {
    const entries = [
      makeEntry({
        entity_type: "capability",
        content: "Can manage MCP servers.",
        confidence: 0.75,
        source: {
          type: "session_harvest",
          agent_id: "agent-1",
          timestamp: new Date().toISOString(),
        },
      }),
    ];

    const briefing = buildAgentBriefing(entries, "agent-1");
    expect(briefing).toContain("## Capabilities Used");
  });

  test("includes knowledge gaps section", () => {
    // Only one fact for agent-1 — should have gaps for missing types
    const entries = [
      makeEntry({
        entity_type: "fact",
        content: "A single fact.",
        source: {
          type: "session_harvest",
          agent_id: "agent-1",
          timestamp: new Date().toISOString(),
        },
      }),
    ];

    const briefing = buildAgentBriefing(entries, "agent-1");
    expect(briefing).toContain("## Knowledge Gaps");
  });

  test("reports entry counts in header", () => {
    const entries = makeEntrySet();
    const briefing = buildAgentBriefing(entries, "agent-1");

    expect(briefing).toContain("Total knowledge base entries:");
    expect(briefing).toContain("Total entries from this agent:");
  });

  test("handles empty entries for agent", () => {
    const entries = makeEntrySet();
    const briefing = buildAgentBriefing(entries, "non-existent-agent");

    // Should still generate, but with 0 agent-specific entries
    expect(briefing).toContain("# Agent Briefing: non-existent-agent");
    expect(briefing).toContain("Total entries from this agent: 0");
  });

  test("excludes low-confidence facts from Key Facts section", () => {
    const entries = [
      makeEntry({
        entity_type: "fact",
        content: "Low confidence fact.",
        confidence: 0.3, // below 0.6 threshold
        source: {
          type: "session_harvest",
          agent_id: "agent-1",
          timestamp: new Date().toISOString(),
        },
      }),
    ];

    const briefing = buildAgentBriefing(entries, "agent-1");
    // Should NOT contain "Key Facts" because all facts are below threshold
    expect(briefing).not.toContain("## Key Facts");
  });
});

// ── synthesizeContext (MiniSearch I/O path) ────────────────────────
//
// synthesizeContext is the function behind the am_wiki_synthesize MCP tool.
// It reads real wiki storage (MiniSearch-indexed pages + knowledge entries)
// and the existing test suite didn't exercise it — only the pure in-memory
// helpers were covered. These tests lock in:
//   (1) happy path — queries return ranked pages
//   (2) empty-wiki fallback — the caller gets an explicit "no knowledge" string
//   (3) agentId scope — entries scoped to an agent are merged with dedup

describe("synthesizeContext — I/O path through MiniSearch", () => {
  const originalEnv = process.env.AM_CONFIG_DIR;
  let tmpDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    tmpDir = await mkdtemp(join(tmpdir(), "am-synth-ctx-"));
    process.env.AM_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    if (originalEnv === undefined) process.env.AM_CONFIG_DIR = undefined;
    else process.env.AM_CONFIG_DIR = originalEnv;
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("returns 'No knowledge found' when the wiki is empty", async () => {
    const out = await synthesizeContext("any query at all");
    expect(out).toContain('No knowledge found for: "any query at all"');
  });

  test("returns ranked pages for a matching query (happy path)", async () => {
    const { writePage, addEntry, rebuildSearchIndex } = await import("../../src/wiki/storage");
    const now = new Date().toISOString();
    await writePage({
      title: "MCP Security Hardening",
      slug: "mcp-security",
      type: "concept",
      content: "Notes on MCP gateway security: bearer auth, env sandboxing, progress redaction.",
      tags: ["mcp", "security"],
      sources: [],
      backlinks: [],
      confidence: 0.85,
      created: now,
      updated: now,
    });
    await writePage({
      title: "Unrelated Topic",
      slug: "unrelated",
      type: "concept",
      content: "This page is about gardening and has nothing to do with the query.",
      tags: ["gardening"],
      sources: [],
      backlinks: [],
      confidence: 0.5,
      created: now,
      updated: now,
    });
    // Rebuild the search index so searchPages can find the newly-written pages.
    await rebuildSearchIndex();

    const out = await synthesizeContext("MCP security");

    expect(out).toContain('## Relevant Knowledge: "MCP security"');
    expect(out).toContain("MCP Security Hardening");
    // Confidence label should be rendered (0.85 → "high")
    expect(out).toContain("confidence: high");
    // Truncation guard: don't assert the full content is present — just
    // that the preview includes something substantive.
    expect(out).toContain("bearer auth");
  });

  test("agentId filter surfaces off-query agent-scoped entries via reserved budget", async () => {
    // Fixed in 2026-05-01 deep-work-loop. Two bugs were stacked:
    //   (1) entryToPage/pageToEntry dropped source.agent_id on the round-trip
    //       through page storage — fixed by adding agent_id to WikiPage +
    //       frontmatter + parseWikiPage.
    //   (2) synthesizeContext gave BM25 searchResults the full topK budget,
    //       so agent-scoped off-query entries were squeezed out even when
    //       queryEntries returned them — fixed by reserving topK/3 slots
    //       (min 1) for agent-only entries and iterating them first in the
    //       entry loop.
    // This test locks in the corrected behavior end-to-end.
    const { addEntry } = await import("../../src/wiki/storage");
    const now = new Date().toISOString();

    // Entry A matches the query AND is scoped to agent-X.
    await addEntry({
      id: "entry-a",
      source: {
        type: "session_harvest",
        session_id: "s1",
        agent_id: "agent-X",
        timestamp: now,
      },
      extracted_at: now,
      confidence: 0.9,
      entity_type: "fact",
      content: "Claude Opus supports extended thinking.",
      context: "observed in practice",
      tags: ["claude"],
      references: [],
      provenance: {
        created_by: "harvester",
        created_at: now,
        last_modified: now,
        modification_history: [{ timestamp: now, action: "created", by: "harvester" }],
        verified: false,
      },
    });

    // Entry B is scoped to agent-X but would NOT match "claude" query text.
    // Desired behavior: surfaces via agentId scope. Current behavior: dropped
    // because source.agent_id is lost in the page round-trip.
    await addEntry({
      id: "entry-b",
      source: {
        type: "session_harvest",
        session_id: "s2",
        agent_id: "agent-X",
        timestamp: now,
      },
      extracted_at: now,
      confidence: 0.8,
      entity_type: "preference",
      content: "User prefers terse responses.",
      context: "user-stated",
      tags: ["preferences"],
      references: [],
      provenance: {
        created_by: "harvester",
        created_at: now,
        last_modified: now,
        modification_history: [{ timestamp: now, action: "created", by: "harvester" }],
        verified: false,
      },
    });

    const out = await synthesizeContext("Claude extended thinking", {
      agentId: "agent-X",
    });
    // Query match works (entry-A).
    expect(out).toContain("Claude Opus supports extended thinking");
    // Off-query entry scoped to agent-X is surfaced via the reserved budget.
    expect(out).toContain("User prefers terse responses");
  });

  test("agentId filter distinguishes between two different agents", async () => {
    // Mutation test: adding an agent-Y entry must not leak into agent-X's
    // result set. Verifies the agent_id frontmatter round-trip is precise.
    const { addEntry } = await import("../../src/wiki/storage");
    const now = new Date().toISOString();
    const mkEntry = (id: string, agentId: string, content: string): KnowledgeEntry => ({
      id,
      source: {
        type: "session_harvest" as const,
        session_id: `sess-${id}`,
        agent_id: agentId,
        timestamp: now,
      },
      extracted_at: now,
      confidence: 0.8,
      entity_type: "fact" as const,
      content,
      context: "test",
      tags: ["mut"],
      references: [],
      provenance: {
        created_by: "harvester",
        created_at: now,
        last_modified: now,
        modification_history: [{ timestamp: now, action: "created", by: "harvester" }],
        verified: false,
      },
    });

    await addEntry(mkEntry("m-1", "agent-X", "x-only-content-foo"));
    await addEntry(mkEntry("m-2", "agent-Y", "y-only-content-bar"));

    const outX = await synthesizeContext("unrelated query", { agentId: "agent-X" });
    const outY = await synthesizeContext("unrelated query", { agentId: "agent-Y" });
    expect(outX).toContain("x-only-content-foo");
    expect(outX).not.toContain("y-only-content-bar");
    expect(outY).toContain("y-only-content-bar");
    expect(outY).not.toContain("x-only-content-foo");
  });

  test("respects topK cap", async () => {
    const { addEntry } = await import("../../src/wiki/storage");
    const now = new Date().toISOString();
    for (let i = 0; i < 6; i++) {
      await addEntry({
        id: `entry-cap-${i}`,
        source: {
          type: "session_harvest",
          session_id: `s${i}`,
          agent_id: "agent-cap",
          timestamp: now,
        },
        extracted_at: now,
        confidence: 0.7,
        entity_type: "fact",
        content: `Fact number ${i} about the test topic alpha-beta-gamma.`,
        context: "test",
        tags: ["cap"],
        references: [],
        provenance: {
          created_by: "harvester",
          created_at: now,
          last_modified: now,
          modification_history: [{ timestamp: now, action: "created", by: "harvester" }],
          verified: false,
        },
      });
    }

    const out = await synthesizeContext("alpha-beta-gamma topic", { topK: 3 });
    // Count how many "### " section headers appear — that's the synthesized
    // entry count. Must be > 0 (results actually surfaced) AND <= topK (cap
    // respected). Prior version asserted only <=3, which passed vacuously on
    // zero-result outputs (CODEX-6 fix 2026-05-02).
    const headers = (out.match(/^### /gm) ?? []).length;
    expect(headers).toBeGreaterThan(0);
    expect(headers).toBeLessThanOrEqual(3);
  });
});
