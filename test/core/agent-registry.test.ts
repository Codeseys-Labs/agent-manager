import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as TOML from "@iarna/toml";
import {
  BUILT_IN_ACP_AGENTS,
  type ConfigAgentEntry,
  type UnifiedAgent,
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

  test("ACP built-in resolves when no config", () => {
    const result = resolveAgent("claude");

    expect(result).not.toBeNull();
    expect(result!.name).toBe("claude");
    expect(result!.source).toBe("acp-builtin");
    expect(result!.acp?.command).toBe(BUILT_IN_ACP_AGENTS.claude);
    expect(result!.a2a).toBeUndefined();
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
  });

  test("agent with both protocols returns both entries", () => {
    // "claude" is in the built-in registry, and also in the roster
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
    expect(result!.acp?.command).toBe(BUILT_IN_ACP_AGENTS.claude);
    expect(result!.a2a?.url).toBe("https://claude-remote.example.com");
    expect(result!.description).toBe("Remote Claude");
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

  test("all 16 built-in agents are resolvable", () => {
    for (const name of Object.keys(BUILT_IN_ACP_AGENTS)) {
      const result = resolveAgent(name);
      expect(result).not.toBeNull();
      expect(result!.acp).toBeDefined();
    }
  });
});

// ── listAllAgents ─────────────────────────────────────────────

describe("listAllAgents", () => {
  test("returns all 16 built-in agents with no config or roster", () => {
    const agents = listAllAgents();
    const builtInCount = Object.keys(BUILT_IN_ACP_AGENTS).length;
    expect(agents).toHaveLength(builtInCount);
    for (const agent of agents) {
      expect(agent.source).toBe("acp-builtin");
      expect(agent.acp).toBeDefined();
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

    // 16 built-in + 1 config + 1 roster
    const builtInCount = Object.keys(BUILT_IN_ACP_AGENTS).length;
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

  test("roster merges with built-in for same name", () => {
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
    expect(claude!.acp?.command).toBe(BUILT_IN_ACP_AGENTS.claude);
    expect(claude!.a2a?.url).toBe("https://claude-remote.example.com");
    expect(claude!.description).toBe("Remote Claude");
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

    const agents = await listAllAgentsAsync(undefined, tmp.path);

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
    const agents = await listAllAgentsAsync(undefined, tmp.path);
    const builtInCount = Object.keys(BUILT_IN_ACP_AGENTS).length;
    expect(agents).toHaveLength(builtInCount);
  });
});
