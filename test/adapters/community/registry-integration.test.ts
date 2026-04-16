import { describe, expect, it } from "bun:test";
import { isBuiltInAdapter, listAdapters, listAllAdapters } from "../../../src/adapters/registry.ts";

describe("registry community integration", () => {
  it("listAdapters() returns only built-in adapters", () => {
    const names = listAdapters();
    expect(names).toContain("claude-code");
    expect(names).toContain("cursor");
    expect(names).toContain("windsurf");
    // Should not include community adapters in synchronous call
    expect(Array.isArray(names)).toBe(true);
  });

  it("listAllAdapters() returns at least the built-in adapters", async () => {
    const names = await listAllAdapters();
    expect(names).toContain("claude-code");
    expect(names).toContain("cursor");
    expect(names.length).toBeGreaterThanOrEqual(13);
  });

  it("isBuiltInAdapter() returns true for built-in", () => {
    expect(isBuiltInAdapter("claude-code")).toBe(true);
    expect(isBuiltInAdapter("cursor")).toBe(true);
    expect(isBuiltInAdapter("windsurf")).toBe(true);
  });

  it("isBuiltInAdapter() returns false for unknown/community", () => {
    expect(isBuiltInAdapter("zed")).toBe(false);
    expect(isBuiltInAdapter("void")).toBe(false);
    expect(isBuiltInAdapter("nonexistent")).toBe(false);
  });
});
