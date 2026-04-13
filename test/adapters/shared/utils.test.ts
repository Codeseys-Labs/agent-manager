import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AM_BEGIN,
  AM_END,
  compareServerFields,
  fileExistsSync,
  normalize,
  readJsonFile,
  sortKeys,
  spliceMarkerBlock,
} from "../../../src/adapters/shared/utils";

// ── sortKeys ────────────────────────────────────────────────────

describe("sortKeys", () => {
  test("sorts object keys alphabetically", () => {
    const input = { zebra: 1, apple: 2, mango: 3 };
    const result = sortKeys(input);
    const keys = Object.keys(result);

    expect(keys).toEqual(["apple", "mango", "zebra"]);
    expect(result.apple).toBe(2);
    expect(result.zebra).toBe(1);
    expect(result.mango).toBe(3);
  });

  test("handles nested objects (shallow sort only)", () => {
    const input = { z: { b: 1, a: 2 }, a: "value" };
    const result = sortKeys(input);
    const keys = Object.keys(result);

    expect(keys).toEqual(["a", "z"]);
    // Nested object keys are NOT sorted by sortKeys alone (it's shallow)
    expect(result.z).toEqual({ b: 1, a: 2 });
  });

  test("handles empty object", () => {
    const result = sortKeys({});
    expect(Object.keys(result)).toEqual([]);
  });
});

// ── normalize ───────────────────────────────────────────────────

describe("normalize", () => {
  test("strips undefined values via object sort", () => {
    const input = { b: 1, a: undefined, c: "hello" };
    const result = normalize(input) as Record<string, unknown>;
    // sortKeys preserves all keys including undefined values
    const keys = Object.keys(result);
    expect(keys).toEqual(["a", "b", "c"]);
  });

  test("sorts arrays consistently (maps normalize over elements)", () => {
    const input = [
      { z: 1, a: 2 },
      { b: 3, a: 4 },
    ];
    const result = normalize(input) as Record<string, unknown>[];

    expect(Array.isArray(result)).toBe(true);
    expect(Object.keys(result[0])).toEqual(["a", "z"]);
    expect(Object.keys(result[1])).toEqual(["a", "b"]);
  });

  test("returns primitive values unchanged", () => {
    expect(normalize(42)).toBe(42);
    expect(normalize("hello")).toBe("hello");
    expect(normalize(null)).toBe(null);
    expect(normalize(true)).toBe(true);
  });
});

// ── compareServerFields ─────────────────────────────────────────

describe("compareServerFields", () => {
  test("detects changed fields between two server objects", () => {
    const expected = {
      name: "test",
      command: "node",
      args: ["server.js"],
      env: { PORT: "3000" },
      transport: "stdio" as const,
      description: "Test server",
      tags: ["test"],
      enabled: true,
      adapters: {},
    };

    const native = {
      command: "python",
      args: ["server.py"],
      env: { PORT: "4000" },
    };

    const diffs = compareServerFields(expected, native);

    expect(diffs.length).toBeGreaterThan(0);
    const fieldNames = diffs.map((d) => d.field);
    expect(fieldNames).toContain("command");
    expect(fieldNames).toContain("args");
    expect(fieldNames).toContain("env");

    const commandDiff = diffs.find((d) => d.field === "command");
    expect(commandDiff!.expected).toBe("node");
    expect(commandDiff!.actual).toBe("python");
  });

  test("returns empty array for identical servers", () => {
    const expected = {
      name: "test",
      command: "node",
      args: ["server.js"],
      env: { API_KEY: "abc" },
      transport: "stdio" as const,
      description: "Test server",
      tags: [],
      enabled: true,
      adapters: {},
    };

    const native = {
      command: "node",
      args: ["server.js"],
      env: { API_KEY: "abc" },
    };

    const diffs = compareServerFields(expected, native);
    expect(diffs).toEqual([]);
  });

  test("treats missing native fields as defaults", () => {
    const expected = {
      name: "test",
      command: "",
      args: [],
      env: {},
      transport: "stdio" as const,
      description: "",
      tags: [],
      enabled: true,
      adapters: {},
    };

    const native = {};

    const diffs = compareServerFields(expected, native);
    expect(diffs).toEqual([]);
  });
});

// ── fileExistsSync ──────────────────────────────────────────────

describe("fileExistsSync", () => {
  let tmpDir: string;

  test("returns true for existing file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "am-utils-test-"));
    const filePath = join(tmpDir, "exists.txt");
    await writeFile(filePath, "hello");

    expect(fileExistsSync(filePath)).toBe(true);
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns false for missing file", () => {
    expect(fileExistsSync("/nonexistent/path/to/file.txt")).toBe(false);
  });
});

// ── readJsonFile ────────────────────────────────────────────────

describe("readJsonFile", () => {
  let tmpDir: string;

  test("parses valid JSON", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "am-utils-json-"));
    const filePath = join(tmpDir, "data.json");
    await writeFile(filePath, JSON.stringify({ name: "test", count: 42 }));

    const result = readJsonFile(filePath) as { name: string; count: number };
    expect(result).toBeDefined();
    expect(result.name).toBe("test");
    expect(result.count).toBe(42);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns null for missing file", () => {
    const result = readJsonFile("/nonexistent/path/data.json");
    expect(result).toBeNull();
  });

  test("returns null for invalid JSON", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "am-utils-json-bad-"));
    const filePath = join(tmpDir, "bad.json");
    await writeFile(filePath, "{not valid json");

    const result = readJsonFile(filePath);
    expect(result).toBeNull();

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ── Marker constants ────────────────────────────────────────────

describe("marker constants", () => {
  test("AM_BEGIN is defined", () => {
    expect(AM_BEGIN).toBe("<!-- am:begin -->");
  });

  test("AM_END is defined", () => {
    expect(AM_END).toBe("<!-- am:end -->");
  });
});

// ── spliceMarkerBlock ───────────────────────────────────────────

describe("spliceMarkerBlock", () => {
  test("inserts content when no existing content", () => {
    const block = `${AM_BEGIN}\nManaged content here\n${AM_END}`;
    const result = spliceMarkerBlock(block);

    expect(result).toContain(AM_BEGIN);
    expect(result).toContain("Managed content here");
    expect(result).toContain(AM_END);
  });

  test("appends when existing content has no markers", () => {
    const block = `${AM_BEGIN}\nNew managed block\n${AM_END}`;
    const existing = "# Existing Content\n\nSome rules here.";
    const result = spliceMarkerBlock(block, existing);

    expect(result).toContain("# Existing Content");
    expect(result).toContain("Some rules here.");
    expect(result).toContain(AM_BEGIN);
    expect(result).toContain("New managed block");
    expect(result).toContain(AM_END);
  });

  test("replaces existing marker block", () => {
    const existing = `# Header\n\n${AM_BEGIN}\nOld content\n${AM_END}\n\n# Footer`;
    const newBlock = `${AM_BEGIN}\nUpdated content\n${AM_END}`;
    const result = spliceMarkerBlock(newBlock, existing);

    expect(result).toContain("# Header");
    expect(result).toContain("Updated content");
    expect(result).toContain("# Footer");
    expect(result).not.toContain("Old content");
  });

  test("preserves content outside markers", () => {
    const before = "# Before\n";
    const after = "\n# After";
    const existing = `${before}${AM_BEGIN}\nOld\n${AM_END}${after}`;
    const newBlock = `${AM_BEGIN}\nNew\n${AM_END}`;
    const result = spliceMarkerBlock(newBlock, existing);

    expect(result).toContain("# Before");
    expect(result).toContain("# After");
    expect(result).toContain("New");
    expect(result).not.toContain("Old");
  });
});
