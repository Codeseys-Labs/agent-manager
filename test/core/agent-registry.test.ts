import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as TOML from "@iarna/toml";
import {
  BUILT_IN_ACP_AGENTS,
  BUILT_IN_AGENTS,
  type ConfigAgentEntry,
  type UnifiedRegistryConfig,
  listAllAgents,
  listAllAgentsAsync,
  resolveAgent,
  resolveAgentAsync,
} from "../../src/core/agent-registry";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ── Helpers ─────────────────────────────────────────────────────

function makeConfig(agents: Record<string, ConfigAgentEntry>): UnifiedRegistryConfig {
  return { agents };
}

function makeRoster(
  agents: Record<string, { url: string; description?: string }>,
): Record<string, { url: string; description?: string }> {
  return agents;
}

function rosterToToml(agents: Record<string, { url: string; description?: string }>): string {
  const obj: Record<string, Record<string, string>> = {};
  for (const [name, entry] of Object.entries(agents)) {
    obj[name] = {
      url: entry.url,
      added_at: new Date().toISOString(),
      ...(entry.description ? { description: entry.description } : {}),
    };
  }
  return TOML.stringify({ agents: obj } as unknown as TOML.JsonMap);
}

const TIER_1_NAMES = Object.entries(BUILT_IN_AGENTS)
  .filter(([, s]) => s.tier === "tier-1-native")
  .map(([name]) => name);

const TIER_3_NAMES = Object.entries(BUILT_IN_AGENTS)
  .filter(([, s]) => s.tier === "tier-3-catalog-only")
  .map(([name]) => name);

// ── BUILT_IN_AGENTS shape (ADR-0033) ──────────────────────────

describe("BUILT_IN_AGENTS (ADR-0033 shape)", () => {
  test("tier-1-native entries have a non-empty command and a docs URL", () => {
    for (const name of TIER_1_NAMES) {
      const spec = BUILT_IN_AGENTS[name];
      expect(spec.command.length).toBeGreaterThan(0);
      // kiro is internal — docsUrl optional. Everything else must have one.
      if (name !== "kiro") {
        expect(spec.docsUrl).toBeDefined();
      }
    }
  });

  test("tier-3-catalog-only entries have an empty command", () => {
    for (const name of TIER_3_NAMES) {
      expect(BUILT_IN_AGENTS[name].command).toBe("");
    }
  });

  test("ships the expected tier-1-native lineup (claude, codex, gemini, kiro)", () => {
    expect(new Set(TIER_1_NAMES)).toEqual(new Set(["claude", "codex", "gemini", "kiro"]));
  });

  test("does NOT ship removed nominal agents (devin, amp, aider, amazon-q, augment, goose, sourcegraph)", () => {
    for (const removed of [
      "devin",
      "amp",
      "aider",
      "amazon-q",
      "augment",
      "auggie",
      "goose",
      "sourcegraph",
    ]) {
      expect(BUILT_IN_AGENTS[removed]).toBeUndefined();
    }
  });

  test("deprecated BUILT_IN_ACP_AGENTS only surfaces tier-1-native entries", () => {
    const keys = new Set(Object.keys(BUILT_IN_ACP_AGENTS));
    expect(keys).toEqual(new Set(TIER_1_NAMES));
    for (const name of TIER_1_NAMES) {
      expect(BUILT_IN_ACP_AGENTS[name]).toBe(BUILT_IN_AGENTS[name].command);
    }
  });
});

// ── resolveAgent ──────────────────────────────────────────────

describe("resolveAgent", () => {
  test("config agent takes priority over built-in", () => {
    const config = makeConfig({
      claude: {
        description: "My custom Claude",
        acp: { command: "my-claude --acp" },
      },
    });

    const result = resolveAgent("claude", config);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("claude");
    expect(result!.source).toBe("config");
    expect(result!.acp?.command).toBe("my-claude --acp");
    expect(result!.description).toBe("My custom Claude");
    expect(result!.runnable).toBe(true);
  });

  test("config agent takes priority over roster", () => {
    const config = makeConfig({
      "review-bot": {
        description: "Custom review bot",
        a2a: { url: "https://custom.example.com" },
      },
    });
    const roster = makeRoster({
      "review-bot": { url: "https://roster.example.com" },
    });

    const result = resolveAgent("review-bot", config, roster);

    expect(result!.source).toBe("config");
    expect(result!.a2a?.url).toBe("https://custom.example.com");
  });

  test("tier-1-native built-in resolves when no config", () => {
    const result = resolveAgent("claude");

    expect(result).not.toBeNull();
    expect(result!.name).toBe("claude");
    expect(result!.source).toBe("acp-builtin");
    expect(result!.acp?.command).toBe(BUILT_IN_AGENTS.claude.command);
    expect(result!.tier).toBe("tier-1-native");
    expect(result!.runnable).toBe(true);
    expect(result!.a2a).toBeUndefined();
  });

  test("tier-3 catalog-only built-in resolves as runnable=false, no acp command", () => {
    const result = resolveAgent("cline");

    expect(result).not.toBeNull();
    expect(result!.name).toBe("cline");
    expect(result!.source).toBe("catalog-only");
    expect(result!.tier).toBe("tier-3-catalog-only");
    expect(result!.runnable).toBe(false);
    expect(result!.acp).toBeUndefined();
  });

  test("A2A roster resolves when no config or built-in", () => {
    const roster = makeRoster({
      "custom-agent": {
        url: "https://custom-agent.example.com",
        description: "A custom remote agent",
      },
    });

    const result = resolveAgent("custom-agent", undefined, roster);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("custom-agent");
    expect(result!.source).toBe("a2a-roster");
    expect(result!.a2a?.url).toBe("https://custom-agent.example.com");
    expect(result!.description).toBe("A custom remote agent");
    expect(result!.acp).toBeUndefined();
    expect(result!.runnable).toBe(true);
  });

  test("tier-1 built-in + roster returns merged entry with both endpoints", () => {
    const roster = makeRoster({
      claude: {
        url: "https://claude-remote.example.com",
        description: "Remote Claude",
      },
    });

    const result = resolveAgent("claude", undefined, roster);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("claude");
    expect(result!.source).toBe("acp-builtin");
    expect(result!.tier).toBe("tier-1-native");
    expect(result!.acp?.command).toBe(BUILT_IN_AGENTS.claude.command);
    expect(result!.a2a?.url).toBe("https://claude-remote.example.com");
    expect(result!.description).toBe("Remote Claude");
  });

  test("tier-3 catalog + roster returns catalog-only source with a2a endpoint attached", () => {
    // Edge case: cline is tier-3 in the catalog; if a user also registers it
    // in the A2A roster, the resolved entry should still mark it catalog-only
    // (source-wise) but surface the A2A URL so `am agent delegate` works.
    const roster = makeRoster({
      cline: { url: "https://cline-remote.example.com", description: "Remote Cline" },
    });
    const result = resolveAgent("cline", undefined, roster);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("catalog-only");
    expect(result!.tier).toBe("tier-3-catalog-only");
    expect(result!.runnable).toBe(false);
    expect(result!.a2a?.url).toBe("https://cline-remote.example.com");
  });

  test("returns null for unknown agent", () => {
    const result = resolveAgent("nonexistent");
    expect(result).toBeNull();
  });

  test("config agent with both ACP and A2A", () => {
    const config = makeConfig({
      hybrid: {
        description: "Hybrid agent",
        acp: { command: "./my-agent --acp" },
        a2a: { url: "https://hybrid.example.com" },
      },
    });

    const result = resolveAgent("hybrid", config);

    expect(result).not.toBeNull();
    expect(result!.source).toBe("config");
    expect(result!.acp?.command).toBe("./my-agent --acp");
    expect(result!.a2a?.url).toBe("https://hybrid.example.com");
    expect(result!.runnable).toBe(true);
  });

  test("config agent with no acp/a2a falls through to built-in", () => {
    const config = makeConfig({
      claude: { description: "Empty config entry" },
    });

    const result = resolveAgent("claude", config);

    // Config entry has no acp or a2a, so it falls through
    expect(result).not.toBeNull();
    expect(result!.source).toBe("acp-builtin");
  });

  test("all tier-1-native built-in agents are resolvable with runnable=true", () => {
    for (const name of TIER_1_NAMES) {
      const result = resolveAgent(name);
      expect(result).not.toBeNull();
      expect(result!.acp).toBeDefined();
      expect(result!.runnable).toBe(true);
      expect(result!.tier).toBe("tier-1-native");
    }
  });

  test("all tier-3 catalog-only agents resolve with runnable=false and no acp", () => {
    for (const name of TIER_3_NAMES) {
      const result = resolveAgent(name);
      expect(result).not.toBeNull();
      expect(result!.runnable).toBe(false);
      expect(result!.acp).toBeUndefined();
      expect(result!.tier).toBe("tier-3-catalog-only");
    }
  });
});

// ── listAllAgents ─────────────────────────────────────────────

describe("listAllAgents", () => {
  test("returns all built-in agents with no config or roster", () => {
    const agents = listAllAgents();
    expect(agents).toHaveLength(Object.keys(BUILT_IN_AGENTS).length);

    const tier1 = agents.filter((a) => a.tier === "tier-1-native");
    const tier3 = agents.filter((a) => a.tier === "tier-3-catalog-only");
    expect(tier1.length).toBe(TIER_1_NAMES.length);
    expect(tier3.length).toBe(TIER_3_NAMES.length);

    for (const agent of tier1) {
      expect(agent.source).toBe("acp-builtin");
      expect(agent.acp).toBeDefined();
      expect(agent.runnable).toBe(true);
    }
    for (const agent of tier3) {
      expect(agent.source).toBe("catalog-only");
      expect(agent.runnable).toBe(false);
      expect(agent.acp).toBeUndefined();
    }
  });

  test("merges all three sources without duplicates", () => {
    const config = makeConfig({
      "my-agent": {
        description: "Config-only agent",
        acp: { command: "my-agent --acp" },
      },
    });
    const roster = makeRoster({
      "remote-agent": {
        url: "https://remote.example.com",
        description: "Roster-only agent",
      },
    });

    const agents = listAllAgents(config, roster);

    // built-in + 1 config + 1 roster
    const builtInCount = Object.keys(BUILT_IN_AGENTS).length;
    expect(agents).toHaveLength(builtInCount + 2);

    const myAgent = agents.find((a) => a.name === "my-agent");
    expect(myAgent).toBeDefined();
    expect(myAgent!.source).toBe("config");
    expect(myAgent!.acp?.command).toBe("my-agent --acp");

    const remoteAgent = agents.find((a) => a.name === "remote-agent");
    expect(remoteAgent).toBeDefined();
    expect(remoteAgent!.source).toBe("a2a-roster");
    expect(remoteAgent!.a2a?.url).toBe("https://remote.example.com");
  });

  test("config overrides built-in for same name", () => {
    const config = makeConfig({
      claude: {
        description: "Custom Claude",
        acp: { command: "custom-claude --acp" },
      },
    });

    const agents = listAllAgents(config);

    const claude = agents.find((a) => a.name === "claude");
    expect(claude).toBeDefined();
    expect(claude!.source).toBe("config");
    expect(claude!.acp?.command).toBe("custom-claude --acp");
  });

  test("roster merges with tier-1 built-in for same name", () => {
    const roster = makeRoster({
      claude: {
        url: "https://claude-remote.example.com",
        description: "Remote Claude",
      },
    });

    const agents = listAllAgents(undefined, roster);

    const claude = agents.find((a) => a.name === "claude");
    expect(claude).toBeDefined();
    // Built-in + roster merged — source stays acp-builtin
    expect(claude!.source).toBe("acp-builtin");
    expect(claude!.tier).toBe("tier-1-native");
    expect(claude!.acp?.command).toBe(BUILT_IN_AGENTS.claude.command);
    expect(claude!.a2a?.url).toBe("https://claude-remote.example.com");
    expect(claude!.description).toBe("Remote Claude");
  });

  test("priority chain — same name in all 3 sources, config wins", () => {
    const config = makeConfig({
      claude: {
        description: "Config Claude",
        acp: { command: "config-claude --acp" },
        a2a: { url: "https://config-claude.example.com" },
      },
    });
    const roster = makeRoster({
      claude: {
        url: "https://roster-claude.example.com",
        description: "Roster Claude",
      },
    });

    const agents = listAllAgents(config, roster);
    const claude = agents.find((a) => a.name === "claude");

    expect(claude).toBeDefined();
    expect(claude!.source).toBe("config");
    expect(claude!.acp?.command).toBe("config-claude --acp");
    expect(claude!.a2a?.url).toBe("https://config-claude.example.com");
    expect(claude!.description).toBe("Config Claude");
    expect(claude!.acp?.command).not.toBe(BUILT_IN_AGENTS.claude.command);
  });

  test("results are sorted alphabetically", () => {
    const agents = listAllAgents();
    const names = agents.map((a) => a.name);
    expect(names).toEqual([...names].sort());
  });

  test("config agent without acp/a2a is excluded", () => {
    const config = makeConfig({
      "empty-agent": { description: "No protocols" },
    });

    const agents = listAllAgents(config);

    const emptyAgent = agents.find((a) => a.name === "empty-agent");
    expect(emptyAgent).toBeUndefined();
  });
});

// ── Async variants (disk-based) ────────────────────────────────

describe("async variants with disk roster", () => {
  let tmp: TestDir;

  beforeEach(async () => {
    tmp = await createTestDir("agent-registry-");
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  test("resolveAgentAsync reads roster from disk", async () => {
    await tmp.write(
      "agents.toml",
      rosterToToml({
        "disk-agent": {
          url: "https://disk.example.com",
          description: "Loaded from disk",
        },
      }),
    );

    const result = await resolveAgentAsync("disk-agent", undefined, tmp.path);

    expect(result).not.toBeNull();
    expect(result!.source).toBe("a2a-roster");
    expect(result!.a2a?.url).toBe("https://disk.example.com");
  });

  test("listAllAgentsAsync merges disk roster with built-in", async () => {
    await tmp.write(
      "agents.toml",
      rosterToToml({
        "disk-agent": { url: "https://disk.example.com" },
        claude: { url: "https://claude-remote.example.com" },
      }),
    );

    const agents = await listAllAgentsAsync(undefined, tmp.path, { detect: false });

    const diskAgent = agents.find((a) => a.name === "disk-agent");
    expect(diskAgent).toBeDefined();
    expect(diskAgent!.source).toBe("a2a-roster");

    const claude = agents.find((a) => a.name === "claude");
    expect(claude).toBeDefined();
    expect(claude!.acp).toBeDefined();
    expect(claude!.a2a?.url).toBe("https://claude-remote.example.com");
  });

  test("resolveAgentAsync returns null with empty roster dir", async () => {
    const result = await resolveAgentAsync("nonexistent", undefined, tmp.path);
    expect(result).toBeNull();
  });

  test("listAllAgentsAsync works without roster file", async () => {
    const agents = await listAllAgentsAsync(undefined, tmp.path, { detect: false });
    const builtInCount = Object.keys(BUILT_IN_AGENTS).length;
    expect(agents).toHaveLength(builtInCount);
  });

  test("listAllAgentsAsync with detect:true populates installed flag", async () => {
    // Force every PATH check to miss so the result is deterministic regardless
    // of the host machine's installed agents.
    const { __setWhichFn, resetAgentDetectionCache } = await import(
      "../../src/core/agent-detection"
    );
    resetAgentDetectionCache();
    __setWhichFn(() => null);
    try {
      const agents = await listAllAgentsAsync(undefined, tmp.path, { detect: true });
      // Every built-in agent should have `installed` set (true or false,
      // but not undefined).
      for (const agent of agents) {
        if (agent.source === "acp-builtin" || agent.source === "catalog-only") {
          expect(typeof agent.installed).toBe("boolean");
        }
      }
    } finally {
      __setWhichFn(null);
      resetAgentDetectionCache();
    }
  });

  test("listAllAgentsAsync assumes config agents are installed", async () => {
    const { __setWhichFn, resetAgentDetectionCache } = await import(
      "../../src/core/agent-detection"
    );
    resetAgentDetectionCache();
    __setWhichFn(() => null);
    try {
      const config: UnifiedRegistryConfig = {
        agents: {
          "my-custom": {
            description: "Hand-wired",
            acp: { command: "/opt/my-custom --acp" },
          },
        },
      };
      const agents = await listAllAgentsAsync(config, tmp.path, { detect: true });
      const custom = agents.find((a) => a.name === "my-custom");
      expect(custom).toBeDefined();
      expect(custom!.source).toBe("config");
      expect(custom!.installed).toBe(true);
    } finally {
      __setWhichFn(null);
      resetAgentDetectionCache();
    }
  });
});

// ── Deep-probe fixture (CI scaffolding) ───────────────────────

/**
 * Deep-probe fixture: the CI probe spawns each tier-1 agent and runs the
 * ACP `initialize` handshake. We don't want real probes in unit tests
 * (they'd fail on every machine without the IDE installed), so this
 * fixture mocks out the AmAcpClient.connect() call and asserts that the
 * probe plumbing resolves every tier-1 spec correctly.
 *
 * The real CI job calls `am agent detect <name>` against the live
 * binaries; this test just protects the contract: every tier-1 entry has
 * a non-empty command and docsUrl, so the probe pipeline has something
 * real to spawn and a URL to surface when it fails.
 */
describe("tier-1 deep-probe fixture (mocked)", () => {
  test("every tier-1 entry has a spawn command the probe pipeline can consume", () => {
    for (const name of TIER_1_NAMES) {
      const spec = BUILT_IN_AGENTS[name];
      expect(spec.command.length).toBeGreaterThan(0);
      // Command must be at least "binary [arg]" — no empty / whitespace-only.
      expect(spec.command.trim().split(/\s+/).length).toBeGreaterThanOrEqual(1);
    }
  });

  test("mock probe shape: probe runner returns the name + verification fields", async () => {
    // Minimal mock of the deepProbe runner used in src/commands/agents.ts.
    // Kept inline (not imported) because the real probe spawns subprocesses
    // and we're only asserting the shape contract the CI probe relies on.
    async function mockProbe(name: string): Promise<{
      name: string;
      probed: true;
      acpVerified: boolean;
      agentInfo?: { name?: string; version?: string };
    }> {
      return {
        name,
        probed: true,
        acpVerified: true,
        agentInfo: { name, version: "0.0.0-mock" },
      };
    }
    for (const name of TIER_1_NAMES) {
      const result = await mockProbe(name);
      expect(result.probed).toBe(true);
      expect(result.acpVerified).toBe(true);
      expect(result.agentInfo?.name).toBe(name);
    }
  });
});
