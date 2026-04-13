import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildAgentBriefing, generateWikiPage, identifyGaps } from "../../src/wiki/synthesizer";
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
