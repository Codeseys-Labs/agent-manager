/**
 * SEC-4 regression: the apply drift-gate must fail CLOSED when an adapter's
 * `diff()` throws.
 *
 * Before this fix, `applyResolved` treated a thrown `diff()` as best-effort
 * and fell through to `export()` — silently OVERWRITING a native config whose
 * drift state could not be confirmed (fail-open). That is the same class of
 * bug as the 2026-04-15 `~/.claude.json` wipe: a write proceeding on an
 * unverified assumption that the target is clean.
 *
 * The corrected behavior: in `--diff` LIVE mode WITHOUT `--force`, a thrown
 * `diff()` means "drift unknown" → skip the adapter (no write) and surface a
 * warning. In dry-run (nothing is written anyway) and with `--force` (the
 * caller explicitly opted into overwriting) the legacy fall-through to
 * `export()` is preserved.
 *
 * The throwing adapter is injected via the controller's own
 * `__setAdapterResolverForTests` seam (cleared per-test in finally). We do NOT
 * use `mock.module("../../src/adapters/registry", ...)` here: Bun's
 * `mock.module` is process-global, leaks into other parallel test files, and
 * is NOT undone by `mock.restore()` — that pollutes the shared registry.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Adapter, ExportResult, ResolvedConfig } from "../../src/adapters/types";
import { writeConfig } from "../../src/core/config";
import { __setAdapterResolverForTests, applyResolved } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import { type TestDir, createTestDir } from "../helpers/tmp";

// Records whether export() ran — proves the gate skipped (false) vs.
// overwrote (true). Reset per test.
let exportCalled = false;

/** Adapter whose diff() always throws; export() flips `exportCalled`. */
const throwingDiffAdapter: Adapter = {
  meta: {
    name: "throwing-fake",
    displayName: "Throwing Fake",
    version: "0.0.0",
    capabilities: [],
  },
  detect() {
    return { installed: true, paths: {} };
  },
  import() {
    return { servers: [], instructions: [], skills: [], warnings: [] };
  },
  export(_config: ResolvedConfig, _options): ExportResult {
    exportCalled = true;
    return {
      files: [{ path: "/tmp/throwing-fake.json", content: "{}", written: true }],
      warnings: [],
    };
  },
  diff() {
    throw new Error("simulated diff() failure");
  },
};

describe("applyResolved — diff() throws → fail closed (SEC-4)", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    exportCalled = false;
    // Inject the throwing adapter for every code path (target and non-target).
    __setAdapterResolverForTests(async () => [throwingDiffAdapter]);
    dir = await createTestDir("am-diff-throws-");
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
    // Always clear the seam so other test files see the real registry.
    __setAdapterResolverForTests(null);
    if (originalEnv === undefined) process.env.AM_CONFIG_DIR = undefined;
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("--diff live, no --force: a throwing diff() SKIPS the adapter (no overwrite) and warns", async () => {
    if (!dir) throw new Error("test setup failed");
    const result = await applyResolved(dir.path, { diff: true });

    // The load-bearing assertion: export() must NOT have run. The gate
    // refused to overwrite a config whose drift state it could not confirm.
    expect(exportCalled).toBe(false);

    // The adapter is reported as skipped, not succeeded, not failed.
    expect(result.skipped).toContain("throwing-fake");
    expect(result.succeeded).not.toContain("throwing-fake");
    expect(result.failed.map((f) => f.adapter)).not.toContain("throwing-fake");

    // A clear warning surfaces the diff failure and the --force escape hatch.
    const entry = result.results.find((r) => r.adapter === "throwing-fake");
    expect(entry).toBeDefined();
    expect(entry?.files).toEqual([]);
    expect(entry?.warnings.length).toBeGreaterThan(0);
    const warning = entry?.warnings.join(" ") ?? "";
    expect(warning).toContain("drift check failed");
    expect(warning).toContain("simulated diff() failure");
    expect(warning).toContain("--force");
  });

  test("--diff live, no --force, target=throwing-fake: single-adapter path also fails closed", async () => {
    if (!dir) throw new Error("test setup failed");
    const result = await applyResolved(dir.path, { diff: true, target: "throwing-fake" });

    expect(exportCalled).toBe(false);
    expect(result.skipped).toContain("throwing-fake");
    const entry = result.results.find((r) => r.adapter === "throwing-fake");
    expect(entry?.warnings.join(" ")).toContain("drift check failed");
  });

  test("--diff with --force: throwing diff() still allows export (caller opted in)", async () => {
    if (!dir) throw new Error("test setup failed");
    const result = await applyResolved(dir.path, { diff: true, force: true });

    // --force is an explicit opt-in to overwrite; the gate must not block it.
    expect(exportCalled).toBe(true);
    expect(result.succeeded).toContain("throwing-fake");
    expect(result.skipped).not.toContain("throwing-fake");
  });

  test("--diff in dry-run: throwing diff() falls through to (no-op) export, not skipped", async () => {
    if (!dir) throw new Error("test setup failed");
    const result = await applyResolved(dir.path, { diff: true, dryRun: true });

    // Dry-run writes nothing regardless, so the live gate doesn't apply —
    // the adapter is processed (export called) rather than skipped.
    expect(exportCalled).toBe(true);
    expect(result.skipped).not.toContain("throwing-fake");
    expect(result.succeeded).toContain("throwing-fake");
  });

  test("without --diff: throwing diff() is never called; export proceeds (legacy behavior preserved)", async () => {
    if (!dir) throw new Error("test setup failed");
    const result = await applyResolved(dir.path, {});

    // No --diff means diff() is not invoked at all — the adapter exports
    // exactly as before this fix.
    expect(exportCalled).toBe(true);
    expect(result.succeeded).toContain("throwing-fake");
    expect(result.skipped).not.toContain("throwing-fake");
  });
});
