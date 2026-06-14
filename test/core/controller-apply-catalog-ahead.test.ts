/**
 * ws4-drift-relabel-catalog-ahead: a catalog-ahead delta (the normal state
 * right after `am add server`) must NOT trip the fail-closed drift gate.
 *
 * Before this fix, every adapter labeled an `expected`-not-in-`allNative`
 * server `removed-locally`, so `diff()` returned `status: "drifted"` and the
 * controller gate (`!dryRun && !force && status === "drifted" && changes > 0`)
 * SKIPPED the adapter on a bare `am apply` — forcing the user to `--force` a
 * server they had just added. Worse, dry-run did NOT skip, so
 * `apply --dry-run` reported "would write" while live `apply` refused.
 *
 * The fix relabels that branch `added-in-config` and changes the gate to skip
 * only when at least one change is REAL drift (added-locally / removed-locally
 * / modified). A delta whose changes are ALL `added-in-config` is a benign
 * forward delta the apply resolves by writing.
 *
 * These tests inject fake adapters via the controller's own
 * `__setAdapterResolverForTests` seam (cleared per-test in finally). We do NOT
 * use `mock.module(...)`: Bun's `mock.module` is process-global, leaks into
 * other parallel test files, and is NOT undone by `mock.restore()`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  Adapter,
  DiffChange,
  DiffResult,
  ExportResult,
  ResolvedConfig,
} from "../../src/adapters/types";
import { writeConfig } from "../../src/core/config";
import { __setAdapterResolverForTests, applyResolved } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import { type TestDir, createTestDir } from "../helpers/tmp";

// Records whether export() ran — proves the gate let the write through (true)
// vs. skipped it (false). Reset per test.
let exportCalled = false;

/** Build a fake adapter whose diff() returns the supplied changes. */
function makeFakeAdapter(name: string, changes: DiffChange[]): Adapter {
  return {
    meta: { name, displayName: name, version: "0.0.0", capabilities: [] },
    detect() {
      return { installed: true, paths: {} };
    },
    import() {
      return { servers: [], instructions: [], skills: [], warnings: [] };
    },
    export(_config: ResolvedConfig, _options): ExportResult {
      exportCalled = true;
      return {
        files: [{ path: `/tmp/${name}.json`, content: "{}", written: true }],
        warnings: [],
      };
    },
    diff(): DiffResult {
      // Mirror real adapters: any non-empty change set yields status "drifted".
      return { status: changes.length === 0 ? "in-sync" : "drifted", changes };
    },
  };
}

const catalogAheadChange: DiffChange = {
  entity: "server",
  name: "fetch",
  type: "added-in-config",
};

const realDriftChange: DiffChange = {
  entity: "server",
  name: "tavily",
  type: "modified",
  details: [{ field: "command", expected: "uvx", actual: "npx" }],
};

describe("applyResolved — catalog-ahead delta is benign (ws4)", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    exportCalled = false;
    dir = await createTestDir("am-catalog-ahead-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: {
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          transport: "stdio",
          enabled: true,
        },
      },
    });
  });

  afterEach(async () => {
    __setAdapterResolverForTests(null);
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("--diff live, no --force: a catalog-ahead-only delta WRITES (gate does not trip)", async () => {
    if (!dir) throw new Error("test setup failed");
    __setAdapterResolverForTests(async () => [
      makeFakeAdapter("catalog-ahead-fake", [catalogAheadChange]),
    ]);

    const result = await applyResolved(dir.path, { diff: true });

    // The load-bearing assertion: export() ran — the user did NOT need --force
    // for a server they just added.
    expect(exportCalled).toBe(true);
    expect(result.succeeded).toContain("catalog-ahead-fake");
    expect(result.skipped).not.toContain("catalog-ahead-fake");
  });

  test("--diff dry-run AGREES with live: catalog-ahead proceeds in both", async () => {
    if (!dir) throw new Error("test setup failed");
    __setAdapterResolverForTests(async () => [
      makeFakeAdapter("catalog-ahead-fake", [catalogAheadChange]),
    ]);

    // dry-run preview proceeds...
    exportCalled = false;
    const dry = await applyResolved(dir.path, { diff: true, dryRun: true });
    expect(dry.succeeded).toContain("catalog-ahead-fake");
    expect(dry.skipped).not.toContain("catalog-ahead-fake");

    // ...and live apply (no --force) makes the SAME decision (proceed).
    exportCalled = false;
    const live = await applyResolved(dir.path, { diff: true });
    expect(live.succeeded).toContain("catalog-ahead-fake");
    expect(live.skipped).not.toContain("catalog-ahead-fake");
    // Both surfaces agree on the outcome for this adapter.
    expect(live.skipped).toEqual(dry.skipped);
  });

  test("control: a delta containing REAL drift still trips the gate (skipped without --force)", async () => {
    if (!dir) throw new Error("test setup failed");
    __setAdapterResolverForTests(async () => [
      makeFakeAdapter("mixed-fake", [catalogAheadChange, realDriftChange]),
    ]);

    const result = await applyResolved(dir.path, { diff: true });

    // A `modified` change is genuine native-side drift — the gate must still
    // refuse to overwrite it without --force, even though the delta ALSO has a
    // benign added-in-config change.
    expect(exportCalled).toBe(false);
    expect(result.skipped).toContain("mixed-fake");
    expect(result.succeeded).not.toContain("mixed-fake");
    const entry = result.results.find((r) => r.adapter === "mixed-fake");
    expect(entry?.warnings.join(" ")).toContain("drift detected");
  });

  // ws4-6fd2: the drift-gate refusal must offer the SAFE, non-destructive
  // remedy (`am import <tool>` folds the native drift back into the catalog)
  // ALONGSIDE the destructive `--force` overwrite.
  test("drift refusal names both `am import <tool>` and --force remedies", async () => {
    if (!dir) throw new Error("test setup failed");
    __setAdapterResolverForTests(async () => [
      makeFakeAdapter("mixed-fake", [catalogAheadChange, realDriftChange]),
    ]);

    const result = await applyResolved(dir.path, { diff: true });
    const warning =
      result.results.find((r) => r.adapter === "mixed-fake")?.warnings.join(" ") ?? "";

    // Safe remedy first, names the specific adapter.
    expect(warning).toContain("am import mixed-fake");
    // Destructive remedy still offered.
    expect(warning).toContain("--force");
  });

  test("real-drift delta with --force writes (caller opted in)", async () => {
    if (!dir) throw new Error("test setup failed");
    __setAdapterResolverForTests(async () => [
      makeFakeAdapter("mixed-fake", [catalogAheadChange, realDriftChange]),
    ]);

    const result = await applyResolved(dir.path, { diff: true, force: true });

    expect(exportCalled).toBe(true);
    expect(result.succeeded).toContain("mixed-fake");
    expect(result.skipped).not.toContain("mixed-fake");
  });
});
