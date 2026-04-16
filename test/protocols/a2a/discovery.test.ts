import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addToRoster,
  discoverFromConfig,
  discoverFromRoster,
  loadRoster,
  removeFromRoster,
  saveRoster,
} from "../../../src/protocols/a2a/discovery";
import type { AgentCard, AgentRosterEntry } from "../../../src/protocols/a2a/types";
import { resolveProjectName } from "../../../src/wiki/storage";
import { type TestDir, createTestDir } from "../../helpers/tmp";

// ── Helpers ─────────────────────────────────────────────────────

function makeEntry(overrides: Partial<AgentRosterEntry> = {}): AgentRosterEntry {
  return {
    name: "test-agent",
    url: "https://example.com/agent",
    description: "A test agent",
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("protocols/a2a/discovery", () => {
  let tmp: TestDir;
  let configDir: string;

  beforeEach(async () => {
    tmp = await createTestDir("a2a-discovery-");
    configDir = tmp.path;
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  // ── loadRoster ──────────────────────────────────────────────

  describe("loadRoster", () => {
    test("returns empty array when no file exists", async () => {
      const roster = await loadRoster(configDir);
      expect(roster).toEqual([]);
    });
  });

  // ── saveRoster + loadRoster roundtrip ───────────────────────

  describe("saveRoster + loadRoster", () => {
    test("roundtrip preserves entries", async () => {
      const entries: AgentRosterEntry[] = [
        makeEntry({ name: "agent-alpha", url: "https://alpha.example.com" }),
        makeEntry({
          name: "agent-beta",
          url: "https://beta.example.com",
          description: "Beta agent",
        }),
      ];

      await saveRoster(configDir, entries);
      const loaded = await loadRoster(configDir);

      expect(loaded).toHaveLength(2);
      expect(loaded[0].name).toBe("agent-alpha");
      expect(loaded[0].url).toBe("https://alpha.example.com");
      expect(loaded[1].name).toBe("agent-beta");
      expect(loaded[1].description).toBe("Beta agent");
    });

    test("roundtrip with empty roster", async () => {
      await saveRoster(configDir, []);
      const loaded = await loadRoster(configDir);
      expect(loaded).toEqual([]);
    });
  });

  // ── addToRoster ─────────────────────────────────────────────

  describe("addToRoster", () => {
    test("adds entry to roster", async () => {
      const entry = makeEntry({ name: "new-agent" });
      await addToRoster(configDir, entry);

      const roster = await loadRoster(configDir);
      expect(roster).toHaveLength(1);
      expect(roster[0].name).toBe("new-agent");
    });

    test("deduplicates by name (updates existing)", async () => {
      const entry1 = makeEntry({ name: "my-agent", url: "https://v1.example.com" });
      const entry2 = makeEntry({ name: "my-agent", url: "https://v2.example.com" });

      await addToRoster(configDir, entry1);
      await addToRoster(configDir, entry2);

      const roster = await loadRoster(configDir);
      expect(roster).toHaveLength(1);
      expect(roster[0].url).toBe("https://v2.example.com");
    });

    test("adds multiple distinct agents", async () => {
      await addToRoster(configDir, makeEntry({ name: "agent-1" }));
      await addToRoster(configDir, makeEntry({ name: "agent-2" }));
      await addToRoster(configDir, makeEntry({ name: "agent-3" }));

      const roster = await loadRoster(configDir);
      expect(roster).toHaveLength(3);
    });
  });

  // ── removeFromRoster ────────────────────────────────────────

  describe("removeFromRoster", () => {
    test("removes agent by name and returns true", async () => {
      await addToRoster(configDir, makeEntry({ name: "to-remove" }));
      await addToRoster(configDir, makeEntry({ name: "to-keep" }));

      const result = await removeFromRoster(configDir, "to-remove");
      expect(result).toBe(true);

      const roster = await loadRoster(configDir);
      expect(roster).toHaveLength(1);
      expect(roster[0].name).toBe("to-keep");
    });

    test("returns false for non-existent name", async () => {
      await addToRoster(configDir, makeEntry({ name: "existing" }));
      const result = await removeFromRoster(configDir, "nonexistent");
      expect(result).toBe(false);

      // Original roster should be unchanged
      const roster = await loadRoster(configDir);
      expect(roster).toHaveLength(1);
    });
  });

  // ── discoverFromRoster ──────────────────────────────────────

  describe("discoverFromRoster", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    const MOCK_CARD: AgentCard = {
      name: "test-agent",
      description: "A test agent",
      version: "1.0.0",
      url: "https://example.com",
      capabilities: { streaming: false },
      skills: [{ id: "s1", name: "Skill", description: "A skill" }],
    };

    function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
      return { ...MOCK_CARD, ...overrides };
    }

    test("returns cards for reachable agents, skips failures", async () => {
      // Write a roster with 3 agents
      const rosterPath = join(configDir, "roster.toml");
      await writeFile(
        rosterPath,
        [
          "[agents.alpha]",
          'url = "https://alpha.example.com"',
          'added_at = "2026-01-01T00:00:00Z"',
          "",
          "[agents.beta]",
          'url = "https://beta.example.com"',
          'added_at = "2026-01-01T00:00:00Z"',
          "",
          "[agents.gamma]",
          'url = "https://gamma.example.com"',
          'added_at = "2026-01-01T00:00:00Z"',
        ].join("\n"),
      );

      // Mock fetch: alpha and beta succeed, gamma fails (network error)
      const alphaCard = makeCard({ name: "alpha", url: "https://alpha.example.com" });
      const betaCard = makeCard({ name: "beta", url: "https://beta.example.com" });

      const mockFetch = mock((url: string) => {
        if (url.includes("alpha.example.com")) {
          return Promise.resolve(new Response(JSON.stringify(alphaCard), { status: 200 }));
        }
        if (url.includes("beta.example.com")) {
          return Promise.resolve(new Response(JSON.stringify(betaCard), { status: 200 }));
        }
        // gamma: network error
        return Promise.reject(new Error("Connection refused"));
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const cards = await discoverFromRoster(rosterPath);

      expect(cards).toHaveLength(2);
      const names = cards.map((c) => c.name).sort();
      expect(names).toEqual(["alpha", "beta"]);
    });

    test("returns empty array for empty roster", async () => {
      const rosterPath = join(configDir, "empty-roster.toml");
      await writeFile(rosterPath, "# empty roster\n");

      const cards = await discoverFromRoster(rosterPath);
      expect(cards).toEqual([]);
    });

    test("returns empty array when roster file does not exist", async () => {
      const cards = await discoverFromRoster(join(configDir, "nonexistent-roster.toml"));
      expect(cards).toEqual([]);
    });
  });

  // ── discoverFromConfig ──────────────────────────────────────

  describe("discoverFromConfig", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    const MOCK_CARD: AgentCard = {
      name: "config-agent",
      description: "Discovered via config",
      version: "1.0.0",
      url: "https://config-agent.example.com",
      capabilities: { streaming: false },
      skills: [{ id: "s1", name: "Skill", description: "A skill" }],
    };

    test("returns cards from discovery_sources in config.toml", async () => {
      // Write a config.toml with discovery_sources
      await tmp.write(
        "config.toml",
        [
          "[settings.a2a]",
          'discovery_sources = ["https://agent-one.example.com", "https://agent-two.example.com"]',
        ].join("\n"),
      );

      const card1: AgentCard = {
        ...MOCK_CARD,
        name: "agent-one",
        url: "https://agent-one.example.com",
      };
      const card2: AgentCard = {
        ...MOCK_CARD,
        name: "agent-two",
        url: "https://agent-two.example.com",
      };

      const mockFetch = mock((url: string) => {
        if (url.includes("agent-one.example.com")) {
          return Promise.resolve(new Response(JSON.stringify(card1), { status: 200 }));
        }
        if (url.includes("agent-two.example.com")) {
          return Promise.resolve(new Response(JSON.stringify(card2), { status: 200 }));
        }
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const cards = await discoverFromConfig(configDir);
      expect(cards).toHaveLength(2);
      const names = cards.map((c) => c.name).sort();
      expect(names).toEqual(["agent-one", "agent-two"]);
    });

    test("returns empty array when no discovery_sources configured", async () => {
      await tmp.write("config.toml", '[settings]\ndefault_profile = "default"\n');

      const cards = await discoverFromConfig(configDir);
      expect(cards).toEqual([]);
    });

    test("returns empty array when config.toml does not exist", async () => {
      // configDir exists but no config.toml
      const cards = await discoverFromConfig(configDir);
      expect(cards).toEqual([]);
    });

    test("skips unreachable discovery sources and returns reachable ones", async () => {
      await tmp.write(
        "config.toml",
        [
          "[settings.a2a]",
          'discovery_sources = ["https://reachable.example.com", "https://down.example.com"]',
        ].join("\n"),
      );

      const reachableCard: AgentCard = {
        ...MOCK_CARD,
        name: "reachable",
        url: "https://reachable.example.com",
      };

      const mockFetch = mock((input: string | Request) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("reachable.example.com")) {
          return Promise.resolve(new Response(JSON.stringify(reachableCard), { status: 200 }));
        }
        // Simulate network error for down.example.com
        return Promise.reject(new Error("Connection refused"));
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const cards = await discoverFromConfig(configDir);
      expect(cards).toHaveLength(1);
      expect(cards[0].name).toBe("reachable");
    });
  });

  // ── resolveProjectName ──────────────────────────────────────

  describe("resolveProjectName", () => {
    test("extracts name from git remote URL (SSH)", async () => {
      const projectDir = join(configDir, "my-project");
      await mkdir(join(projectDir, ".git"), { recursive: true });
      await writeFile(
        join(projectDir, ".git", "config"),
        [
          "[core]",
          "  repositoryformatversion = 0",
          '[remote "origin"]',
          "  url = git@github.com:user/my-awesome-repo.git",
          "  fetch = +refs/heads/*:refs/remotes/origin/*",
        ].join("\n"),
      );

      const name = resolveProjectName(projectDir);
      expect(name).toBe("my-awesome-repo");
    });

    test("extracts name from git remote URL (HTTPS)", async () => {
      const projectDir = join(configDir, "https-project");
      await mkdir(join(projectDir, ".git"), { recursive: true });
      await writeFile(
        join(projectDir, ".git", "config"),
        ['[remote "origin"]', "  url = https://github.com/org/cool-project.git"].join("\n"),
      );

      const name = resolveProjectName(projectDir);
      expect(name).toBe("cool-project");
    });

    test("falls back to directory basename when no git", () => {
      // Use a path that has no .git directory
      const name = resolveProjectName("/some/path/fallback-project");
      expect(name).toBe("fallback-project");
    });

    test("falls back to directory basename when git has no remote", async () => {
      const projectDir = join(configDir, "no-remote");
      await mkdir(join(projectDir, ".git"), { recursive: true });
      await writeFile(
        join(projectDir, ".git", "config"),
        "[core]\n  repositoryformatversion = 0\n",
      );

      const name = resolveProjectName(projectDir);
      expect(name).toBe("no-remote");
    });
  });
});
