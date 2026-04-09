import { describe, expect, test } from "bun:test";
import { getAdapter, listAdapters } from "../../src/adapters/registry";

describe("am adapter list", () => {
  test("lists all registered adapters", () => {
    const names = listAdapters();
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(names).toContain("claude-code");
    expect(names).toContain("cursor");
    expect(names).toContain("windsurf");
    expect(names).toContain("copilot");
    expect(names).toContain("codex-cli");
    expect(names).toContain("forgecode");
    expect(names).toContain("kilo-code");
    expect(names).toContain("kiro");
  });

  test("each adapter can be loaded", async () => {
    const names = listAdapters();
    for (const name of names) {
      const adapter = await getAdapter(name);
      expect(adapter).toBeDefined();
      expect(adapter?.meta.name).toBe(name);
      expect(adapter?.meta.displayName).toBeTruthy();
      expect(Array.isArray(adapter?.meta.capabilities)).toBe(true);
    }
  });

  test("each adapter has required interface methods", async () => {
    const names = listAdapters();
    for (const name of names) {
      const adapter = await getAdapter(name);
      expect(adapter).toBeDefined();
      expect(typeof adapter?.detect).toBe("function");
      expect(typeof adapter?.import).toBe("function");
      expect(typeof adapter?.export).toBe("function");
      expect(typeof adapter?.diff).toBe("function");
    }
  });

  test("detect returns structured result", async () => {
    const adapter = await getAdapter("claude-code");
    expect(adapter).toBeDefined();
    const result = adapter?.detect();
    expect(typeof result.installed).toBe("boolean");
  });

  test("getAdapter returns undefined for unknown adapter", async () => {
    const adapter = await getAdapter("nonexistent-adapter");
    expect(adapter).toBeUndefined();
  });
});
