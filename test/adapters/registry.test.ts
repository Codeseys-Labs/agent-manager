import { describe, expect, it } from "bun:test";
import { getAdapter, getDetectedAdapters, listAdapters } from "../../src/adapters/registry.ts";
import type {
  Adapter,
  AdapterMeta,
  Capability,
  DetectResult,
  DiffChange,
  DiffResult,
  ExportOptions,
  ExportResult,
  ImportOptions,
  ImportResult,
  ImportedInstruction,
  ImportedServer,
  ImportedSkill,
  ResolvedConfig,
  ResolvedInstruction,
  ResolvedServer,
  ResolvedSkill,
  WrittenFile,
} from "../../src/adapters/types.ts";

// ── Capability type ──────────────────────────────────────────────

describe("Capability type", () => {
  it("includes all 10 values", () => {
    const all: Capability[] = [
      "mcp",
      "instructions",
      "permissions",
      "models",
      "skills",
      "plugins",
      "agents",
      "hooks",
      "modes",
      "marketplace",
    ];
    expect(all).toHaveLength(10);
  });
});

// ── DetectResult shape ───────────────────────────────────────────

describe("DetectResult", () => {
  it("has required installed and paths fields", () => {
    const result: DetectResult = { installed: true, paths: { global: "/foo" } };
    expect(result.installed).toBe(true);
    expect(result.paths).toEqual({ global: "/foo" });
  });

  it("supports optional version field", () => {
    const result: DetectResult = {
      installed: true,
      version: "1.2.3",
      paths: {},
    };
    expect(result.version).toBe("1.2.3");
  });

  it("works with installed = false and empty paths", () => {
    const result: DetectResult = { installed: false, paths: {} };
    expect(result.installed).toBe(false);
    expect(result.paths).toEqual({});
  });
});

// ── DiffChange shape ─────────────────────────────────────────────

describe("DiffChange", () => {
  it("has entity, name, and type fields", () => {
    const change: DiffChange = {
      entity: "server",
      name: "tavily",
      type: "modified",
    };
    expect(change.entity).toBe("server");
    expect(change.name).toBe("tavily");
    expect(change.type).toBe("modified");
  });

  it("supports optional details field", () => {
    const change: DiffChange = {
      entity: "instruction",
      name: "ts-rules",
      type: "added-locally",
      details: [{ field: "content", expected: "old", actual: "new" }],
    };
    expect(change.details).toHaveLength(1);
    expect(change.details?.[0].field).toBe("content");
  });

  it("supports all entity types", () => {
    const entities: DiffChange["entity"][] = ["server", "instruction", "skill", "agent", "setting"];
    expect(entities).toHaveLength(5);
  });

  it("supports all change types", () => {
    const types: DiffChange["type"][] = [
      "added-locally",
      "removed-locally",
      "modified",
      "added-in-config",
    ];
    expect(types).toHaveLength(4);
  });
});

// ── DiffResult shape ─────────────────────────────────────────────

describe("DiffResult", () => {
  it("has status and changes fields", () => {
    const result: DiffResult = { status: "in-sync", changes: [] };
    expect(result.status).toBe("in-sync");
    expect(result.changes).toEqual([]);
  });

  it("supports all status values", () => {
    const statuses: DiffResult["status"][] = ["in-sync", "drifted", "unmanaged"];
    expect(statuses).toHaveLength(3);
  });
});

// ── Registry: listAdapters ───────────────────────────────────────

describe("listAdapters()", () => {
  it("returns an array", () => {
    const result = listAdapters();
    expect(Array.isArray(result)).toBe(true);
  });

  it("includes 'claude-code'", () => {
    const result = listAdapters();
    expect(result).toContain("claude-code");
  });
});

// ── Registry: getAdapter ─────────────────────────────────────────

describe("getAdapter()", () => {
  it("returns adapter with correct meta for 'claude-code'", async () => {
    const adapter = await getAdapter("claude-code");
    expect(adapter).toBeDefined();
    expect(adapter?.meta.name).toBe("claude-code");
    expect(adapter?.meta.displayName).toBe("Claude Code");
    expect(typeof adapter?.meta.version).toBe("string");
    expect(Array.isArray(adapter?.meta.capabilities)).toBe(true);
    expect(adapter?.meta.capabilities).toContain("mcp");
    expect(adapter?.meta.capabilities).toContain("instructions");
  });

  it("returns undefined for nonexistent adapter", async () => {
    const adapter = await getAdapter("nonexistent");
    expect(adapter).toBeUndefined();
  });

  it("adapter has required interface methods", async () => {
    const adapter = await getAdapter("claude-code");
    expect(adapter).toBeDefined();
    expect(typeof adapter?.detect).toBe("function");
    expect(typeof adapter?.import).toBe("function");
    expect(typeof adapter?.export).toBe("function");
    expect(typeof adapter?.diff).toBe("function");
  });
});

// ── Registry: getDetectedAdapters ────────────────────────────────

describe("getDetectedAdapters()", () => {
  // Timeouts raised from bun:test's default 5s to 30s per test. Under
  // full-suite load (183+ files executing in parallel), getDetectedAdapters
  // exceeds 5s on WSL2 + loaded CI runners — surfaced by the Codex final
  // signoff review of commit 69cdb10 as a flake. The detection calls are
  // filesystem-bound; 30s is a safe ceiling that won't mask a real
  // regression (detection should complete in well under 1s on a healthy
  // host).
  it("returns an array of adapters", async () => {
    const detected = await getDetectedAdapters();
    expect(Array.isArray(detected)).toBe(true);
  }, 30_000);

  it("only includes adapters where detect() returns installed: true", async () => {
    const detected = await getDetectedAdapters();
    for (const adapter of detected) {
      const result = adapter.detect();
      expect(result.installed).toBe(true);
    }
  }, 30_000);
});
