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
import { BUILT_IN_ACP_AGENTS } from "../../src/core/agent-registry";

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
    __setWhichFn(mockWhich({ aider: "/usr/local/bin/aider" }));

    const result = detectAgentByPath("aider");
    expect(result.installed).toBe(true);
    expect(result.source).toBe("path");
    expect(result.binary).toBe("/usr/local/bin/aider");
  });

  test("detectAgentByPath returns installed=false when binary is missing", () => {
    __setWhichFn(mockWhich({}));

    const result = detectAgentByPath("goose");
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
    // 'amazon-q' maps to the 'q' binary
    __setWhichFn(mockWhich({ q: "/opt/bin/q" }));

    const result = detectAgentByPath("amazon-q");
    expect(result.installed).toBe(true);
    expect(result.binary).toBe("/opt/bin/q");
    expect(AGENT_BINARIES["amazon-q"]).toBe("q");
  });

  test("detectAgentByPath caches results within a single process", () => {
    let calls = 0;
    __setWhichFn((name: string) => {
      calls += 1;
      return name === "aider" ? "/bin/aider" : null;
    });

    const a = detectAgentByPath("aider");
    const b = detectAgentByPath("aider");
    expect(a.installed).toBe(true);
    expect(b.installed).toBe(true);
    // __setWhichFn resets the cache, so the first call counts; the second is cached.
    expect(calls).toBe(1);
  });

  test("resetAgentDetectionCache invalidates prior results", () => {
    __setWhichFn(mockWhich({ aider: "/bin/aider" }));
    expect(detectAgentByPath("aider").installed).toBe(true);

    // Swap which implementation to a miss; setter resets cache automatically.
    __setWhichFn(mockWhich({}));
    expect(detectAgentByPath("aider").installed).toBe(false);

    // Explicit reset path also clears everything.
    __setWhichFn(mockWhich({ aider: "/bin/aider" }));
    resetAgentDetectionCache();
    expect(detectAgentByPath("aider").installed).toBe(true);
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

  test("detectAllAgents returns an entry for every built-in ACP agent", async () => {
    __setWhichFn(mockWhich({}));
    const result = await detectAllAgents();
    for (const name of Object.keys(BUILT_IN_ACP_AGENTS)) {
      expect(result[name]).toBeDefined();
      expect(typeof result[name].installed).toBe("boolean");
      expect(["path", "adapter", "none"]).toContain(result[name].source);
    }
  });

  test("detectAllAgents prefers PATH hit over adapter signal", async () => {
    // Aider has no adapter, so PATH is the only signal. Happy PATH hit:
    __setWhichFn(mockWhich({ aider: "/usr/local/bin/aider" }));
    const result = await detectAllAgents();
    expect(result.aider.installed).toBe(true);
    expect(result.aider.source).toBe("path");
    expect(result.aider.binary).toBe("/usr/local/bin/aider");
  });

  test("detectAllAgents reports not-installed when neither signal fires", async () => {
    __setWhichFn(mockWhich({}));
    const result = await detectAllAgents();
    // 'devin' has no adapter mapping, so with no PATH hit it must be not-installed.
    expect(result.devin.installed).toBe(false);
    expect(result.devin.source).toBe("none");
  });

  test("detectAllAgents caches the full map across calls", async () => {
    __setWhichFn(mockWhich({ aider: "/bin/aider" }));
    const a = await detectAllAgents();
    const b = await detectAllAgents();
    // Same object reference — cache is shared.
    expect(a).toBe(b);
  });
});
