import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addToRoster,
  loadRoster,
  removeFromRoster,
  saveRoster,
} from "../../../src/protocols/a2a/discovery";
import type { AgentRosterEntry } from "../../../src/protocols/a2a/types";
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
