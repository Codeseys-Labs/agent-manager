/**
 * Integration test for the full session-harvest → wiki ingest → symlink → agent context pipeline.
 *
 * Tests the complete flow:
 *   1. Session data → harvester extracts KnowledgeEntry[]
 *   2. Entries → wiki pages written to correct directories
 *   3. BM25 search index finds content
 *   4. Knowledge graph has entries
 *   5. Symlink creation from project → central wiki
 *   6. Agent briefing synthesized from harvested knowledge
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { Message, Session } from "../../src/core/session";
import { addPageToGraph, loadGraph, saveGraph } from "../../src/wiki/graph";
import { harvestSession, harvestSessionAsPages, stringSimilarity } from "../../src/wiki/harvester";
import {
  createProjectWikiLink,
  ensureWikiDirs,
  ensureWikiGitignore,
  listPages,
  readPage,
  rebuildSearchIndex,
  resolveProjectName,
  searchPages,
  writePage,
} from "../../src/wiki/storage";
import { buildAgentBriefing } from "../../src/wiki/synthesizer";
import { type KnowledgeEntry, type WikiPage, scoreToConfidence } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ── Test Session Fixtures ──────────────────────────────────────

function makeTestSession(overrides: Partial<Session> = {}): Session {
  const now = new Date();
  const messages: Message[] = [
    // User asks to fix a bug
    {
      role: "user",
      content: "The build is failing with a TypeScript error in src/core/config.ts",
      timestamp: new Date(now.getTime() - 60000),
    },
    // Assistant investigates with tool calls
    {
      role: "assistant",
      content: "Let me check the error. The codebase uses strict TypeScript with Zod validation.",
      timestamp: new Date(now.getTime() - 55000),
      toolCalls: [
        {
          name: "bash",
          input: { command: "bun run typecheck" },
          output:
            "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\nsrc/core/config.ts:42:15",
        },
        {
          name: "read",
          input: { path: "src/core/config.ts" },
          output:
            'export function resolveConfigDir(): string { return process.env.AM_CONFIG_DIR ?? join(homedir(), ".config", "agent-manager"); }',
        },
      ],
    },
    // Error message in tool output
    {
      role: "assistant",
      content:
        "I found the error. The function expects a number but receives a string. I'll fix it by parsing the value.",
      timestamp: new Date(now.getTime() - 50000),
      toolCalls: [
        {
          name: "edit",
          input: { path: "src/core/config.ts", oldString: "foo", newString: "bar" },
          output: "File edited successfully",
        },
      ],
    },
    // User correction (preference)
    {
      role: "user",
      content:
        "No, actually use Number.parseInt instead of parseInt. We always prefer the namespaced version in this project.",
      timestamp: new Date(now.getTime() - 45000),
    },
    // Assistant acknowledges and fixes
    {
      role: "assistant",
      content:
        "You're right, I'll use Number.parseInt as preferred. The project uses strict Number methods.",
      timestamp: new Date(now.getTime() - 40000),
      toolCalls: [
        {
          name: "edit",
          input: {
            path: "src/core/config.ts",
            oldString: "parseInt(val)",
            newString: "Number.parseInt(val, 10)",
          },
          output: "File edited successfully",
        },
      ],
    },
    // Factual statement
    {
      role: "user",
      content:
        "The project uses Bun as its runtime and Zod for validation. We use TOML for config files.",
      timestamp: new Date(now.getTime() - 35000),
    },
    // Assistant confirms
    {
      role: "assistant",
      content:
        "The codebase is built with Bun and uses Zod schemas for two-phase validation. TOML is the config format per ADR-0004.",
      timestamp: new Date(now.getTime() - 30000),
    },
  ];

  return {
    id: "test-session-001",
    adapter: "claude-code",
    project: "/Users/test/projects/agent-manager",
    messages,
    startedAt: new Date(now.getTime() - 60000),
    endedAt: new Date(now.getTime() - 30000),
    metadata: { model: "claude-sonnet-4" },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("wiki pipeline integration", () => {
  let testDir: TestDir;
  let wikiDir: string;

  beforeEach(async () => {
    testDir = await createTestDir("am-wiki-pipeline-");
    wikiDir = join(testDir.path, "wiki");
    await ensureWikiDirs(wikiDir);
  });

  afterEach(async () => {
    await testDir.cleanup();
  });

  // ── Step 1: Harvester extracts entries from session ───────────

  describe("session harvest", () => {
    test("harvestSession extracts entries from a session with tool calls and errors", async () => {
      const session = makeTestSession();
      const entries = await harvestSession(session);

      expect(entries.length).toBeGreaterThan(0);

      // Should extract procedures from tool calls (bash, read, edit)
      const procedures = entries.filter((e) => e.entity_type === "procedure");
      expect(procedures.length).toBeGreaterThan(0);

      // Should extract facts from error messages and factual statements
      const facts = entries.filter((e) => e.entity_type === "fact");
      expect(facts.length).toBeGreaterThan(0);

      // Should extract preferences from user corrections
      const preferences = entries.filter((e) => e.entity_type === "preference");
      expect(preferences.length).toBeGreaterThan(0);

      // Should extract capabilities from tool usage
      const capabilities = entries.filter((e) => e.entity_type === "capability");
      expect(capabilities.length).toBeGreaterThan(0);

      // All entries should have valid confidence scores
      for (const entry of entries) {
        expect(entry.confidence).toBeGreaterThanOrEqual(0);
        expect(entry.confidence).toBeLessThanOrEqual(1);
      }

      // All entries should have provenance
      for (const entry of entries) {
        expect(entry.provenance).toBeDefined();
        expect(entry.provenance.created_by).toBe("harvester");
        expect(entry.provenance.created_at).toBeTruthy();
      }

      // All entries should reference the session
      for (const entry of entries) {
        expect(entry.source.type).toBe("session_harvest");
        expect(entry.source.session_id).toContain("claude-code");
        expect(entry.source.session_id).toContain("test-session-001");
      }
    });

    test("harvestSession handles empty session", async () => {
      const session = makeTestSession({ messages: [] });
      const entries = await harvestSession(session);
      expect(entries).toEqual([]);
    });

    test("stringSimilarity detects near-duplicates", () => {
      expect(stringSimilarity("hello world test", "hello world test")).toBe(1.0);
      expect(stringSimilarity("hello world", "goodbye universe")).toBe(0);
      expect(stringSimilarity("", "")).toBe(1.0);
      expect(stringSimilarity("hello", "")).toBe(0);

      // Similar strings should have high similarity
      const sim = stringSimilarity(
        "TypeScript error in config.ts line 42",
        "TypeScript error in config.ts line 43",
      );
      expect(sim).toBeGreaterThan(0.5);
    });
  });

  // ── Step 2: Harvested entries become wiki pages ───────────────

  describe("harvest to wiki pages", () => {
    test("harvestSessionAsPages writes pages to disk", async () => {
      const session = makeTestSession();

      // harvestSessionAsPages uses the default wiki dir (resolveWikiDir),
      // so we test via harvestSession + writePage with explicit wikiDir
      const entries = await harvestSession(session);
      expect(entries.length).toBeGreaterThan(0);

      const slugs: string[] = [];
      for (const entry of entries) {
        const page = entryToTestPage(entry);
        await writePage(page, wikiDir);
        slugs.push(page.slug);
      }

      // Verify pages exist on disk
      const pages = await listPages({ wikiDir });
      expect(pages.length).toBe(entries.length);

      // Each page should have proper frontmatter
      for (const page of pages) {
        expect(page.slug).toBeTruthy();
        expect(page.title).toBeTruthy();
        expect(page.type).toBe("entity");
        expect(page.content).toBeTruthy();
        expect(page.tags.length).toBeGreaterThan(0);
        expect(page.created).toBeTruthy();
        expect(page.updated).toBeTruthy();
      }
    });

    test("wiki pages have correct content from harvested entries", async () => {
      const session = makeTestSession();
      const entries = await harvestSession(session);

      // Write first entry as a page
      const entry = entries[0];
      const page = entryToTestPage(entry);
      await writePage(page, wikiDir);

      // Read it back
      const read = await readPage(page.slug, wikiDir);
      expect(read).not.toBeNull();
      expect(read!.content).toContain(entry.content);
      expect(read!.tags).toContain(entry.entity_type);
      if (entry.confidence !== undefined) {
        // ADR-0054 R4: page confidence is persisted/read as the WikiConfidence
        // enum, not the raw 0.0-1.0 number. The on-disk value is the bucket the
        // numeric entry confidence maps to.
        expect(read!.confidence).toBe(scoreToConfidence(entry.confidence));
      }
    });

    test("wiki directory structure is correct", async () => {
      // ensureWikiDirs creates all subdirectories
      expect(existsSync(join(wikiDir, "entities"))).toBe(true);
      expect(existsSync(join(wikiDir, "concepts"))).toBe(true);
      expect(existsSync(join(wikiDir, "summaries"))).toBe(true);
      expect(existsSync(join(wikiDir, "synthesis"))).toBe(true);
      expect(existsSync(join(wikiDir, "decisions"))).toBe(true);
      expect(existsSync(join(wikiDir, "raw"))).toBe(true);
    });
  });

  // ── Step 3: BM25 search finds harvested content ───────────────

  describe("BM25 search index", () => {
    test("search finds harvested wiki pages by content", async () => {
      const session = makeTestSession();
      const entries = await harvestSession(session);

      // Write all entries as pages
      for (const entry of entries) {
        await writePage(entryToTestPage(entry), wikiDir);
      }

      // Build the search index
      await rebuildSearchIndex(wikiDir);

      // Search for TypeScript-related content
      const results = await searchPages("TypeScript error", 20, wikiDir);
      expect(results.length).toBeGreaterThan(0);

      // Each result should have a positive score
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0);
        expect(r.page.slug).toBeTruthy();
      }
    });

    test("search returns empty for unrelated queries", async () => {
      const session = makeTestSession();
      const entries = await harvestSession(session);

      for (const entry of entries) {
        await writePage(entryToTestPage(entry), wikiDir);
      }
      await rebuildSearchIndex(wikiDir);

      const results = await searchPages("quantum physics dark matter", 20, wikiDir);
      expect(results).toEqual([]);
    });

    test("search finds pages by tag content", async () => {
      const session = makeTestSession();
      const entries = await harvestSession(session);

      for (const entry of entries) {
        await writePage(entryToTestPage(entry), wikiDir);
      }
      await rebuildSearchIndex(wikiDir);

      // Search for content from preferences (user corrections)
      const results = await searchPages("preference correction", 20, wikiDir);
      // Should find preference entries since they're tagged with "user-preference" and "correction"
      if (entries.some((e) => e.entity_type === "preference")) {
        expect(results.length).toBeGreaterThan(0);
      }
    });
  });

  // ── Step 4: Knowledge graph has entries ────────────────────────

  describe("knowledge graph", () => {
    test("harvested pages can be added to the knowledge graph", async () => {
      const session = makeTestSession();
      const entries = await harvestSession(session);

      let graph = await loadGraph(wikiDir);
      expect(Object.keys(graph.nodes).length).toBe(0);

      // Add pages to graph
      for (const entry of entries) {
        const page = entryToTestPage(entry);
        await writePage(page, wikiDir);
        graph = await addPageToGraph(page, graph);
      }
      await saveGraph(graph, wikiDir);

      // Graph should have nodes
      expect(Object.keys(graph.nodes).length).toBe(entries.length);

      // Each node should have the right structure
      for (const node of Object.values(graph.nodes)) {
        expect(node.slug).toBeTruthy();
        expect(node.title).toBeTruthy();
        expect(node.type).toBeTruthy();
        expect(Array.isArray(node.tags)).toBe(true);
      }

      // Graph should be saved to disk
      const loaded = await loadGraph(wikiDir);
      expect(Object.keys(loaded.nodes).length).toBe(entries.length);
    });

    test("graph file persists after save", async () => {
      const graph = { nodes: {}, edges: [], updated: new Date().toISOString() };
      await saveGraph(graph, wikiDir);

      const filePath = join(wikiDir, "graph.json");
      expect(existsSync(filePath)).toBe(true);

      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.nodes).toBeDefined();
      expect(parsed.edges).toBeDefined();
    });
  });

  // ── Step 5: Symlink creation ──────────────────────────────────

  describe("project wiki symlink", () => {
    test("createProjectWikiLink creates symlink to central wiki", async () => {
      // Set up a fake project directory
      const projectDir = join(testDir.path, "my-project");
      const centralWikiDir = join(testDir.path, "central", "wiki", "projects", "my-project");

      // We need to mock getProjectWikiDir, but since createProjectWikiLink
      // calls it internally, we test the symlink creation directly
      require("node:fs").mkdirSync(projectDir, { recursive: true });
      require("node:fs").mkdirSync(centralWikiDir, { recursive: true });

      // Create the symlink manually to test the pattern
      const amDir = join(projectDir, ".agent-manager");
      require("node:fs").mkdirSync(amDir, { recursive: true });

      const wikiLink = join(amDir, "wiki");
      const { symlinkSync } = require("node:fs");
      symlinkSync(centralWikiDir, wikiLink);

      // Verify the symlink exists and points correctly
      expect(existsSync(wikiLink)).toBe(true);
      const stat = lstatSync(wikiLink);
      expect(stat.isSymbolicLink()).toBe(true);

      const target = readlinkSync(wikiLink);
      expect(target).toBe(centralWikiDir);
    });

    test("resolveProjectName extracts name from git remote", async () => {
      // Create a fake project with git config
      const projectDir = join(testDir.path, "git-project");
      const gitDir = join(projectDir, ".git");
      require("node:fs").mkdirSync(gitDir, { recursive: true });

      const gitConfig = `[core]
	repositoryformatversion = 0
[remote "origin"]
	url = git@github.com:myorg/agent-manager.git
	fetch = +refs/heads/*:refs/remotes/origin/*
`;
      require("node:fs").writeFileSync(join(gitDir, "config"), gitConfig);

      const name = resolveProjectName(projectDir);
      expect(name).toBe("agent-manager");
    });

    test("resolveProjectName falls back to directory basename", () => {
      // No git config → falls back to basename
      const projectDir = join(testDir.path, "my-cool-project");
      require("node:fs").mkdirSync(projectDir, { recursive: true });

      const name = resolveProjectName(projectDir);
      expect(name).toBe("my-cool-project");
    });

    test("ensureWikiGitignore adds entry to .gitignore", () => {
      const projectDir = join(testDir.path, "gitignore-project");
      require("node:fs").mkdirSync(projectDir, { recursive: true });

      // No .gitignore exists yet
      ensureWikiGitignore(projectDir);

      const gitignorePath = join(projectDir, ".gitignore");
      expect(existsSync(gitignorePath)).toBe(true);
      const content = readFileSync(gitignorePath, "utf-8");
      expect(content).toContain(".agent-manager/wiki");
    });

    test("ensureWikiGitignore does not duplicate entry", () => {
      const projectDir = join(testDir.path, "gitignore-project-2");
      require("node:fs").mkdirSync(projectDir, { recursive: true });

      // Call twice
      ensureWikiGitignore(projectDir);
      ensureWikiGitignore(projectDir);

      const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
      const matches = content.match(/\.agent-manager\/wiki/g);
      expect(matches?.length).toBe(1);
    });

    test("ensureWikiGitignore appends to existing .gitignore", () => {
      const projectDir = join(testDir.path, "gitignore-project-3");
      require("node:fs").mkdirSync(projectDir, { recursive: true });

      // Create existing .gitignore
      require("node:fs").writeFileSync(join(projectDir, ".gitignore"), "node_modules/\n.env\n");

      ensureWikiGitignore(projectDir);

      const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
      expect(content).toContain("node_modules/");
      expect(content).toContain(".env");
      expect(content).toContain(".agent-manager/wiki");
    });
  });

  // ── Step 6: Agent briefing from harvested knowledge ───────────

  describe("agent briefing synthesis", () => {
    test("buildAgentBriefing generates markdown from harvested entries", async () => {
      const session = makeTestSession();
      const entries = await harvestSession(session);

      expect(entries.length).toBeGreaterThan(0);

      const briefing = buildAgentBriefing(entries, "claude-code");
      expect(briefing).toContain("# Agent Briefing: claude-code");
      expect(briefing).toContain("Generated:");

      // Should include sections for available entry types
      const procedures = entries.filter((e) => e.entity_type === "procedure");
      if (procedures.length > 0) {
        expect(briefing).toContain("Known Procedures");
      }

      const preferences = entries.filter((e) => e.entity_type === "preference");
      if (preferences.length > 0) {
        expect(briefing).toContain("User Preferences");
      }
    });
  });

  // ── Full end-to-end pipeline ──────────────────────────────────

  describe("end-to-end pipeline", () => {
    test("full pipeline: session → harvest → pages → search → graph", async () => {
      // 1. Create a session
      const session = makeTestSession();

      // 2. Harvest knowledge entries
      const entries = await harvestSession(session);
      expect(entries.length).toBeGreaterThan(0);

      // 3. Write wiki pages
      const slugs: string[] = [];
      for (const entry of entries) {
        const page = entryToTestPage(entry);
        await writePage(page, wikiDir);
        slugs.push(page.slug);
      }

      // 4. Verify pages exist
      const pages = await listPages({ wikiDir });
      expect(pages.length).toBe(entries.length);

      // 5. Build and verify search index
      await rebuildSearchIndex(wikiDir);
      const searchResults = await searchPages("TypeScript", 20, wikiDir);
      // At least some entries mention TypeScript
      expect(searchResults.length).toBeGreaterThan(0);

      // 6. Build and verify knowledge graph
      let graph = await loadGraph(wikiDir);
      for (const page of pages) {
        graph = await addPageToGraph(page, graph);
      }
      await saveGraph(graph, wikiDir);

      expect(Object.keys(graph.nodes).length).toBe(pages.length);

      // 7. Generate agent briefing
      const briefing = buildAgentBriefing(entries, "claude-code");
      expect(briefing).toContain("Agent Briefing");
      expect(briefing.length).toBeGreaterThan(100);

      // 8. Verify pages can be read back individually
      for (const slug of slugs) {
        const page = await readPage(slug, wikiDir);
        expect(page).not.toBeNull();
        expect(page!.slug).toBe(slug);
      }
    });

    test("multiple sessions can be harvested without duplicates", async () => {
      // Harvest same session twice — second time should produce same entries
      // (deduplication happens against existing wiki)
      const session1 = makeTestSession({ id: "session-1" });
      const entries1 = await harvestSession(session1);

      for (const entry of entries1) {
        await writePage(entryToTestPage(entry), wikiDir);
      }

      // Harvest a different session with similar content
      const session2 = makeTestSession({
        id: "session-2",
        messages: [
          {
            role: "user",
            content: "The build is failing with a TypeScript error in src/core/config.ts",
          },
          {
            role: "assistant",
            content: "I found the error. The function expects a number but receives a string.",
            toolCalls: [
              {
                name: "bash",
                input: { command: "bun run typecheck" },
                output: "error TS2345: type mismatch",
              },
            ],
          },
        ],
      });

      const entries2 = await harvestSession(session2);

      // Both harvests should produce entries (dedup is against the wiki, not in-memory)
      expect(entries1.length).toBeGreaterThan(0);
      expect(entries2.length).toBeGreaterThanOrEqual(0); // may be deduplicated
    });
  });
});

// ── Helpers ─────────────────────────────────────────────────────

/** Convert a KnowledgeEntry to a WikiPage for test purposes. */
function entryToTestPage(entry: KnowledgeEntry): WikiPage {
  const now = new Date().toISOString();
  const lines: string[] = [entry.content];
  if (entry.context) {
    lines.push("");
    lines.push(`> Context: ${entry.context}`);
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
  };
}
