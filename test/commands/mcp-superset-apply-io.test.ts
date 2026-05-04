/**
 * `am mcp-superset apply` IO-level tests (FINAL-REV-3, 2026-05-03-D).
 *
 * The first wave of tests (test/commands/mcp-superset.test.ts) pinned only
 * the pure-function contract (classifyServer + buildSupersetReport). The
 * adversarial reviewer flagged that writeProjectWithSuperset + the actual
 * apply subcommand had ZERO coverage — a silent regression in the merge
 * semantics would not be caught.
 *
 * These tests round-trip through the real filesystem:
 *   - writeProjectWithSuperset merges new servers into an existing
 *     .mcp.json without clobbering unknown top-level fields
 *   - absent project file → the function treats it as empty and writes
 *     the full merged result
 *   - refused entries (class=refuse, action=refuse) are NEVER written
 *     even though they appear in the entries[] array
 *   - identical-content re-apply is a no-op (returns 0, file unchanged)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSupersetReport, writeProjectWithSuperset } from "../../src/commands/mcp-superset";

let dir: string;
let projectPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "am-sup-io-"));
  projectPath = join(dir, ".mcp.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeProjectWithSuperset — IO round-trip", () => {
  test("merges new server into existing project without clobbering unknown top-level fields", async () => {
    // Seed project with an unrelated field the user might have.
    await writeFile(
      projectPath,
      JSON.stringify({
        mcpServers: { existing: { command: "npx", args: ["existing"] } },
        customField: 42,
      }),
    );

    const globalMap = {
      existing: { command: "npx", args: ["existing"] },
      new_one: { command: "bunx", args: ["-y", "@new/mcp"] },
    };
    const project = { existing: { command: "npx", args: ["existing"] } };
    const report = buildSupersetReport(globalMap, project, {
      globalSource: "g",
      projectTarget: projectPath,
      command: "mcp superset apply",
    });

    const added = await writeProjectWithSuperset(projectPath, report.entries, globalMap);
    expect(added).toBe(1);

    const after = JSON.parse(await readFile(projectPath, "utf-8"));
    // New server landed.
    expect(after.mcpServers.new_one.command).toBe("bunx");
    // Unknown top-level field preserved.
    expect(after.customField).toBe(42);
    // Existing server unchanged.
    expect(after.mcpServers.existing.command).toBe("npx");
  });

  test("refused entries are NEVER written to project even though they appear in entries[]", async () => {
    const globalMap = {
      safe: { command: "bunx", args: ["safe"] },
      leak: {
        type: "http",
        url: "https://mcp.example/?api_key=abcdefghijklmnop1234567890",
      },
    };
    const project = {};
    const report = buildSupersetReport(globalMap, project, {
      globalSource: "g",
      projectTarget: projectPath,
      command: "mcp superset apply",
    });

    await writeProjectWithSuperset(projectPath, report.entries, globalMap);

    const after = JSON.parse(await readFile(projectPath, "utf-8"));
    // Safe server present.
    expect(after.mcpServers.safe).toBeDefined();
    // Refused server NOT in project.
    expect(after.mcpServers.leak).toBeUndefined();
  });

  test("identical re-apply is a no-op (nothing to add)", async () => {
    await writeFile(
      projectPath,
      JSON.stringify({ mcpServers: { foo: { command: "bunx", args: ["foo"] } } }, null, 2),
    );

    const globalMap = { foo: { command: "bunx", args: ["foo"] } };
    const project = globalMap;
    const report = buildSupersetReport(globalMap, project, {
      globalSource: "g",
      projectTarget: projectPath,
      command: "mcp superset apply",
    });

    const added = await writeProjectWithSuperset(projectPath, report.entries, globalMap);
    expect(added).toBe(0);
  });

  test("absent project file is treated as {} and the full set lands", async () => {
    // projectPath deliberately does NOT exist.
    const globalMap = {
      a: { command: "bunx", args: ["a"] },
      b: { command: "bunx", args: ["b"] },
    };
    const report = buildSupersetReport(
      globalMap,
      {},
      {
        globalSource: "g",
        projectTarget: projectPath,
        command: "mcp superset apply",
      },
    );

    const added = await writeProjectWithSuperset(projectPath, report.entries, globalMap);
    expect(added).toBe(2);
    const after = JSON.parse(await readFile(projectPath, "utf-8"));
    expect(Object.keys(after.mcpServers).sort()).toEqual(["a", "b"]);
  });

  test("never writes the raw credential into rewritePreview (FINAL-REV-1)", async () => {
    // This is a unit-level check on the remediation hint; IO is incidental.
    const globalMap = {
      tavily: {
        type: "http",
        url: "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-RAWCREDENTIALVALUE1234567890",
      },
    };
    const report = buildSupersetReport(
      globalMap,
      {},
      {
        globalSource: "g",
        projectTarget: projectPath,
        command: "mcp superset check",
      },
    );

    const entry = report.entries.find((e) => e.name === "tavily");
    expect(entry).toBeDefined();
    expect(entry?.remediation?.rewritePreview).toBeDefined();
    // The raw credential MUST NOT survive into the preview.
    expect(entry?.remediation?.rewritePreview).not.toContain("tvly-RAWCREDENTIALVALUE1234567890");
    // The placeholder SHOULD appear.
    expect(entry?.remediation?.rewritePreview).toContain("${");
  });
});
