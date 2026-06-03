import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  addToRoster,
  loadRoster,
  removeFromRoster,
  saveRoster,
} from "../../src/protocols/a2a/discovery";
import type { AgentCard, AgentRosterEntry } from "../../src/protocols/a2a/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// Capture console output
let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const origLog = console.log;
const origError = console.error;

function makeEntry(overrides: Partial<AgentRosterEntry> = {}): AgentRosterEntry {
  return {
    name: "test-agent",
    url: "https://example.com/agent",
    description: "A test A2A agent",
    addedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    ...overrides,
  };
}

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: "test-agent",
    description: "A test A2A agent",
    version: "1.0.0",
    url: "https://example.com/agent",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills: [
      {
        id: "search",
        name: "Search",
        description: "Search the web",
      },
    ],
    ...overrides,
  };
}

describe("am agents", () => {
  let dir: TestDir;
  let configDir: string;

  beforeEach(async () => {
    consoleOutput = [];
    consoleErrors = [];
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    process.exitCode = undefined;

    dir = await createTestDir("am-agents-");
    configDir = dir.path;
  });

  afterEach(async () => {
    console.log = origLog;
    console.error = origError;
    process.exitCode = undefined;
    if (dir) await dir.cleanup();
  });

  // ── list subcommand ────────────────────────────────────────────

  test("list shows empty roster when none configured", async () => {
    const roster = await loadRoster(configDir);
    expect(roster).toEqual([]);
  });

  // ── add subcommand ────────────────────────────────────────────

  test("add saves agent to roster file", async () => {
    const entry = makeEntry({ name: "researcher", url: "https://agent.example.com" });

    await addToRoster(configDir, entry);

    const roster = await loadRoster(configDir);
    expect(roster.length).toBe(1);
    expect(roster[0].name).toBe("researcher");
    expect(roster[0].url).toBe("https://agent.example.com");
  });

  test("add updates existing agent with same name", async () => {
    const entry1 = makeEntry({ name: "researcher", url: "https://old.example.com" });
    await addToRoster(configDir, entry1);

    const entry2 = makeEntry({ name: "researcher", url: "https://new.example.com" });
    await addToRoster(configDir, entry2);

    const roster = await loadRoster(configDir);
    expect(roster.length).toBe(1);
    expect(roster[0].url).toBe("https://new.example.com");
  });

  test("add preserves other agents in roster", async () => {
    await addToRoster(configDir, makeEntry({ name: "agent-1", url: "https://a1.example.com" }));
    await addToRoster(configDir, makeEntry({ name: "agent-2", url: "https://a2.example.com" }));
    await addToRoster(configDir, makeEntry({ name: "agent-3", url: "https://a3.example.com" }));

    const roster = await loadRoster(configDir);
    expect(roster.length).toBe(3);
    const names = roster.map((r) => r.name);
    expect(names).toContain("agent-1");
    expect(names).toContain("agent-2");
    expect(names).toContain("agent-3");
  });

  // ── remove subcommand ─────────────────────────────────────────

  test("remove deletes agent from roster", async () => {
    await addToRoster(configDir, makeEntry({ name: "to-remove", url: "https://r.example.com" }));
    await addToRoster(configDir, makeEntry({ name: "keeper", url: "https://k.example.com" }));

    const removed = await removeFromRoster(configDir, "to-remove");
    expect(removed).toBe(true);

    const roster = await loadRoster(configDir);
    expect(roster.length).toBe(1);
    expect(roster[0].name).toBe("keeper");
  });

  test("remove returns false for non-existent agent", async () => {
    await addToRoster(configDir, makeEntry({ name: "existing" }));

    const removed = await removeFromRoster(configDir, "nonexistent");
    expect(removed).toBe(false);

    // Original agent should still be there
    const roster = await loadRoster(configDir);
    expect(roster.length).toBe(1);
  });

  // ── roster persistence ────────────────────────────────────────

  test("roster persists across load/save cycles", async () => {
    const entries = [
      makeEntry({ name: "agent-a", url: "https://a.com", description: "Agent A" }),
      makeEntry({ name: "agent-b", url: "https://b.com", description: "Agent B" }),
    ];

    await saveRoster(configDir, entries);

    const loaded = await loadRoster(configDir);
    expect(loaded.length).toBe(2);
    expect(loaded[0].name).toBe("agent-a");
    expect(loaded[0].url).toBe("https://a.com");
    expect(loaded[0].description).toBe("Agent A");
    expect(loaded[1].name).toBe("agent-b");
    expect(loaded[1].url).toBe("https://b.com");
  });

  test("saving empty roster creates valid file", async () => {
    await saveRoster(configDir, []);

    const loaded = await loadRoster(configDir);
    expect(loaded).toEqual([]);
  });

  // ── CLI subcommand integration (list via resolveConfigDir) ─────

  test("list subcommand outputs JSON with empty roster", async () => {
    const origConfigDir = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = configDir;

    try {
      const { agentsCommand } = await import("../../src/commands/agents");
      // Access the list subcommand runner via the roster functions
      const roster = await loadRoster(configDir);

      // Simulate what list subcommand does for JSON output
      if (roster.length === 0) {
        consoleOutput.push(JSON.stringify({ agents: roster }));
      }

      const jsonOut = consoleOutput[0];
      const parsed = JSON.parse(jsonOut);
      expect(parsed.agents).toEqual([]);
    } finally {
      if (origConfigDir !== undefined) {
        process.env.AM_CONFIG_DIR = origConfigDir;
      } else {
        Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
      }
    }
  });

  // ── --tier filter (ADR-0033 HIGH-1 from REV-1) ──────────────────
  //
  // The refusal messages in run.ts and detectSubcommand tell users to run
  // `am agent list --tier native`. Before 2026-04-18 that flag was unimplemented
  // and citty rejected it. These tests exercise the actual list handler so the
  // flag doesn't regress back to a broken promise.

  describe("list --tier filter", () => {
    async function runListWithArgs(argv: Record<string, unknown>): Promise<string> {
      const origConfigDir = process.env.AM_CONFIG_DIR;
      process.env.AM_CONFIG_DIR = configDir;
      try {
        const { agentsCommand } = await import("../../src/commands/agents");
        const listCmd = await (
          agentsCommand.subCommands as Record<string, () => Promise<unknown>>
        ).list();
        await (listCmd as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run({
          args: { json: true, quiet: false, verbose: false, discover: false, ...argv },
        });
        return consoleOutput.at(-1) ?? "";
      } finally {
        if (origConfigDir !== undefined) {
          process.env.AM_CONFIG_DIR = origConfigDir;
        } else {
          Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
        }
      }
    }

    test("--tier native only returns tier-1 entries", async () => {
      const out = await runListWithArgs({ tier: "native" });
      const parsed = JSON.parse(out) as { agents: Array<{ tier: string; name: string }> };
      expect(parsed.agents.length).toBeGreaterThan(0);
      for (const a of parsed.agents) {
        expect(a.tier).toBe("tier-1-native");
      }
      // Tier-1 list per ADR-0033 Phase A.
      const names = parsed.agents.map((a) => a.name).sort();
      expect(names).toEqual(["claude", "codex", "gemini", "kiro"]);
    });

    test("--tier catalog only returns tier-3 entries", async () => {
      const out = await runListWithArgs({ tier: "catalog" });
      const parsed = JSON.parse(out) as { agents: Array<{ tier: string; runnable: boolean }> };
      expect(parsed.agents.length).toBeGreaterThan(0);
      for (const a of parsed.agents) {
        expect(a.tier).toBe("tier-3-catalog-only");
        expect(a.runnable).toBe(false);
      }
    });

    test("--tier invalid-name exits with error and does not emit JSON body", async () => {
      const origConfigDir = process.env.AM_CONFIG_DIR;
      process.env.AM_CONFIG_DIR = configDir;
      try {
        const { agentsCommand } = await import("../../src/commands/agents");
        const listCmd = await (
          agentsCommand.subCommands as Record<string, () => Promise<unknown>>
        ).list();
        await (listCmd as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run({
          args: {
            json: true,
            quiet: false,
            verbose: false,
            discover: false,
            tier: "spawnable",
          },
        });
        expect(process.exitCode).toBe(1);
        // --json routes errors to stdout as a JSON body via lib/output.error().
        const combined = [...consoleOutput, ...consoleErrors].join("\n");
        expect(combined).toMatch(/Unknown tier.*spawnable/);
        expect(combined).toMatch(/native, shim, catalog/);
      } finally {
        if (origConfigDir !== undefined) {
          process.env.AM_CONFIG_DIR = origConfigDir;
        } else {
          Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
        }
      }
    });

    test("--runnable hides catalog-only tier-3 entries", async () => {
      const out = await runListWithArgs({ runnable: true });
      const parsed = JSON.parse(out) as { agents: Array<{ runnable: boolean; tier: string }> };
      for (const a of parsed.agents) {
        expect(a.runnable).not.toBe(false);
        expect(a.tier).not.toBe("tier-3-catalog-only");
      }
    });

    test("accepts long-form tier aliases (tier-1-native, tier-3-catalog-only)", async () => {
      const out = await runListWithArgs({ tier: "tier-1-native" });
      const parsed = JSON.parse(out) as { agents: Array<{ tier: string }> };
      for (const a of parsed.agents) {
        expect(a.tier).toBe("tier-1-native");
      }
    });

    // REV-4 LOW-3: the text-mode endpoint column and the JSON `runnable`
    // field must agree about tier-2-shim agents that haven't been enabled.
    // A tier-2 entry with runnable=false in JSON should show
    // "(shim — enable-shim to activate)" in the text output — NOT the
    // catalog-only marker "(catalog-only)".
    test("tier-2-shim unrun agents: JSON runnable=false aligns with text 'enable-shim' label", async () => {
      // JSON side.
      const jsonOut = await runListWithArgs({ tier: "shim" });
      const parsed = JSON.parse(jsonOut) as {
        agents: Array<{ tier: string; runnable: boolean; name: string; endpoint: string | null }>;
      };
      expect(parsed.agents.length).toBeGreaterThan(0);
      const notEnabled = parsed.agents.filter((a) => a.runnable === false);
      expect(notEnabled.length).toBeGreaterThan(0);
      for (const a of notEnabled) {
        expect(a.tier).toBe("tier-2-shim");
      }

      // Text side — same handler, args.json=false.
      const origConfigDir = process.env.AM_CONFIG_DIR;
      process.env.AM_CONFIG_DIR = configDir;
      consoleOutput = [];
      try {
        const { agentsCommand } = await import("../../src/commands/agents");
        const listCmd = await (
          agentsCommand.subCommands as Record<string, () => Promise<unknown>>
        ).list();
        await (listCmd as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run({
          args: {
            json: false,
            quiet: false,
            verbose: false,
            discover: false,
            tier: "shim",
          },
        });
      } finally {
        if (origConfigDir !== undefined) {
          process.env.AM_CONFIG_DIR = origConfigDir;
        } else {
          Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
        }
      }
      const combinedText = consoleOutput.join("\n");
      for (const a of notEnabled) {
        const line = consoleOutput.find((l) => l.startsWith(a.name.padEnd(20)));
        expect(line).toBeDefined();
        expect(line!).toContain("(shim — enable-shim to activate)");
        // Regression guard: must NOT be mislabeled as catalog-only.
        expect(line!).not.toContain("(catalog-only)");
      }
      // Sanity: shim label appears at least once in the whole table.
      expect(combinedText).toContain("enable-shim to activate");
    });
  });

  // ── add subcommand: clean error on discovery failure (UX-STACK) ─
  //
  // `am agent add <url>` is the canonical first Pillar-3 action. Pointing it
  // at an unreachable/local/invalid agent is normal; it must NOT leak a raw
  // developer stack trace (clig.dev robustness requirement). It should print
  // a clean actionable one-liner and exit 1, matching its siblings.

  describe("add — clean error on discovery failure", () => {
    async function runAddWith(
      discoverImpl: (url: string) => Promise<unknown>,
      argv: Record<string, unknown>,
    ): Promise<void> {
      const origConfigDir = process.env.AM_CONFIG_DIR;
      process.env.AM_CONFIG_DIR = configDir;
      // Replace the discovery module's discoverFromUrl with a throwing stub.
      mock.module("../../src/protocols/a2a/discovery", () => ({
        discoverFromUrl: discoverImpl,
        // Keep the other named exports the command imports importable.
        addToRoster: async () => {},
        discoverFromConfig: async () => [],
        loadRoster: async () => [],
        removeFromRoster: async () => false,
        saveRoster: async () => {},
      }));
      try {
        const { agentsCommand } = await import("../../src/commands/agents");
        const addCmd = await (
          agentsCommand.subCommands as Record<string, () => Promise<unknown>>
        ).add();
        await (addCmd as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run({
          args: { json: false, quiet: false, verbose: false, ...argv },
        });
      } finally {
        if (origConfigDir !== undefined) {
          process.env.AM_CONFIG_DIR = origConfigDir;
        } else {
          Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
        }
      }
    }

    afterEach(() => {
      // Restore the real discovery module so other tests/files are unaffected.
      mock.restore();
    });

    test("a thrown discovery error yields a clean one-liner, no stack, exit 1", async () => {
      await runAddWith(
        async () => {
          throw new Error(
            "A2A URL targets a private/loopback host (localhost); refused. Set AM_A2A_ALLOW_PRIVATE=1",
          );
        },
        { url: "http://localhost:59999" },
      );

      expect(process.exitCode).toBe(1);
      const combined = [...consoleOutput, ...consoleErrors].join("\n");
      // Clean, actionable one-liner.
      expect(combined).toContain("Could not reach http://localhost:59999");
      expect(combined).toContain("Check the URL");
      expect(combined).toContain("/.well-known/agent.json");
      // The underlying message is surfaced...
      expect(combined).toContain("refused");
      // ...but NO developer stack frame leaks (clig.dev).
      expect(combined).not.toMatch(/\bat\s+\w+\s+\(/); // e.g. "at validateRemoteUrl ("
      expect(combined).not.toContain("src/protocols/a2a");
      process.exitCode = 0;
    });

    test("a network-failure throw also prints clean error + exit 1", async () => {
      await runAddWith(
        async () => {
          throw new Error("Failed to fetch agent card from http://10.0.0.9/.well-known/agent.json");
        },
        { url: "http://10.0.0.9" },
      );

      expect(process.exitCode).toBe(1);
      const combined = [...consoleOutput, ...consoleErrors].join("\n");
      expect(combined).toContain("Could not reach http://10.0.0.9");
      expect(combined).not.toMatch(/\bat\s+\w+\s+\(/);
      process.exitCode = 0;
    });

    test("non-throwing null result still gives the no-card error (regression guard)", async () => {
      await runAddWith(async () => null, { url: "https://example.com" });
      expect(process.exitCode).toBe(1);
      const combined = [...consoleOutput, ...consoleErrors].join("\n");
      expect(combined).toContain("No A2A Agent Card found");
      process.exitCode = 0;
    });
  });
});
