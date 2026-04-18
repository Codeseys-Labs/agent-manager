import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AGENT_ADAPTER_MAP,
  AGENT_BINARIES,
  __setWhichFn,
  detectAgentByPath,
  detectAgentsViaAdapters,
  detectAllAgents,
  resetAgentDetectionCache,
} from "../../src/core/agent-detection";
import { BUILT_IN_AGENTS } from "../../src/core/agent-registry";

// ── Test-only helpers ──────────────────────────────────────────

/** Build a `which` mock that returns a resolved path for the listed names only. */
function mockWhich(hits: Record<string, string>): (name: string) => string | null {
  return (name: string) => hits[name] ?? null;
}

describe("agent-detection", () => {
  beforeEach(() => {
    resetAgentDetectionCache();
  });

  afterEach(() => {
    // Restore the real Bun.which for downstream tests.
    __setWhichFn(null);
    resetAgentDetectionCache();
  });

  // ── Tier 1: detectAgentByPath ───────────────────────────────

  test("detectAgentByPath returns installed=true when binary is on PATH", () => {
    __setWhichFn(mockWhich({ claude: "/usr/local/bin/claude" }));

    const result = detectAgentByPath("claude");
    expect(result.installed).toBe(true);
    expect(result.source).toBe("path");
    expect(result.binary).toBe("/usr/local/bin/claude");
  });

  test("detectAgentByPath returns installed=false when binary is missing", () => {
    __setWhichFn(mockWhich({}));

    const result = detectAgentByPath("gemini");
    expect(result.installed).toBe(false);
    expect(result.source).toBe("none");
    expect(result.binary).toBeUndefined();
  });

  test("detectAgentByPath returns installed=false for unknown agent name", () => {
    __setWhichFn(mockWhich({ claude: "/bin/claude" })); // irrelevant — unknown name still misses

    const result = detectAgentByPath("nonexistent-agent");
    expect(result.installed).toBe(false);
    expect(result.source).toBe("none");
  });

  test("detectAgentByPath uses the binary name from AGENT_BINARIES (not agent name)", () => {
    // 'kiro' maps to the 'kiro-cli-chat' binary
    __setWhichFn(mockWhich({ "kiro-cli-chat": "/opt/bin/kiro-cli-chat" }));

    const result = detectAgentByPath("kiro");
    expect(result.installed).toBe(true);
    expect(result.binary).toBe("/opt/bin/kiro-cli-chat");
    expect(AGENT_BINARIES.kiro).toBe("kiro-cli-chat");
  });

  test("detectAgentByPath returns installed=false for tier-3 catalog-only agents (no PATH binary)", () => {
    // tier-3 agents (e.g. cline) have no entry in AGENT_BINARIES — the
    // adapter's detect() is the only valid signal. PATH must never report
    // them as installed.
    __setWhichFn(mockWhich({ cline: "/fake/cline" })); // even if PATH hit, AGENT_BINARIES has no mapping

    const result = detectAgentByPath("cline");
    expect(result.installed).toBe(false);
    expect(result.source).toBe("none");
    expect(result.tier).toBe("tier-3-catalog-only");
  });

  test("detectAgentByPath surfaces tier metadata for tier-1 entries", () => {
    __setWhichFn(mockWhich({ claude: "/bin/claude" }));
    const result = detectAgentByPath("claude");
    expect(result.tier).toBe("tier-1-native");
  });

  test("detectAgentByPath caches results within a single process", () => {
    let calls = 0;
    __setWhichFn((name: string) => {
      calls += 1;
      return name === "claude" ? "/bin/claude" : null;
    });

    const a = detectAgentByPath("claude");
    const b = detectAgentByPath("claude");
    expect(a.installed).toBe(true);
    expect(b.installed).toBe(true);
    // __setWhichFn resets the cache, so the first call counts; the second is cached.
    expect(calls).toBe(1);
  });

  test("resetAgentDetectionCache invalidates prior results", () => {
    __setWhichFn(mockWhich({ claude: "/bin/claude" }));
    expect(detectAgentByPath("claude").installed).toBe(true);

    // Swap which implementation to a miss; setter resets cache automatically.
    __setWhichFn(mockWhich({}));
    expect(detectAgentByPath("claude").installed).toBe(false);

    // Explicit reset path also clears everything.
    __setWhichFn(mockWhich({ claude: "/bin/claude" }));
    resetAgentDetectionCache();
    expect(detectAgentByPath("claude").installed).toBe(true);
  });

  // ── Tier 2: detectAgentsViaAdapters ─────────────────────────

  test("detectAgentsViaAdapters returns a result for every mapped agent", async () => {
    __setWhichFn(mockWhich({}));
    const result = await detectAgentsViaAdapters();
    for (const name of Object.keys(AGENT_ADAPTER_MAP)) {
      expect(result[name]).toBeDefined();
      expect(typeof result[name].installed).toBe("boolean");
    }
  });

  // ── detectAllAgents (combined) ──────────────────────────────

  test("detectAllAgents returns an entry for every built-in agent", async () => {
    __setWhichFn(mockWhich({}));
    const result = await detectAllAgents();
    for (const name of Object.keys(BUILT_IN_AGENTS)) {
      expect(result[name]).toBeDefined();
      expect(typeof result[name].installed).toBe("boolean");
      expect(["path", "adapter", "none"]).toContain(result[name].source);
    }
  });

  test("detectAllAgents prefers PATH hit over adapter signal", async () => {
    __setWhichFn(mockWhich({ claude: "/usr/local/bin/claude" }));
    const result = await detectAllAgents();
    expect(result.claude.installed).toBe(true);
    expect(result.claude.source).toBe("path");
    expect(result.claude.binary).toBe("/usr/local/bin/claude");
  });

  test("detectAllAgents reports not-installed when neither signal fires", async () => {
    __setWhichFn(mockWhich({}));
    const result = await detectAllAgents();
    // `windsurf` is tier-3 with an adapter mapping; in CI the adapter will
    // report installed=false, and there's no PATH binary mapped — so the
    // combined detector must report not-installed.
    expect(result.windsurf.installed).toBe(false);
    expect(result.windsurf.source).toBe("none");
  });

  test("detectAllAgents caches the full map across calls", async () => {
    __setWhichFn(mockWhich({ claude: "/bin/claude" }));
    const a = await detectAllAgents();
    const b = await detectAllAgents();
    // Same object reference — cache is shared.
    expect(a).toBe(b);
  });

  test("detectAllAgents reports tier metadata on every entry", async () => {
    __setWhichFn(mockWhich({}));
    const result = await detectAllAgents();
    for (const [name, spec] of Object.entries(BUILT_IN_AGENTS)) {
      expect(result[name].tier).toBe(spec.tier);
    }
  });
});
