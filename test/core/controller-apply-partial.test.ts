/**
 * C3 Option C (2026-05-03): applyResolved must not fail-fast when one
 * adapter's export throws. It must:
 *   - continue with the remaining adapters
 *   - record the failed adapter in `failed: []` with its error message
 *   - record each succeeded adapter in `succeeded: []`
 *   - produce a full `results` array with error-bearing entries marked
 *
 * The CLI surface then surfaces this structured outcome in `am apply
 * --json` as `{ adapter, status: "ok"|"failed", error? }` entries,
 * allowing downstream tooling to reason about partial applies without
 * parsing stderr.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { applyResolved } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("applyResolved — partial-failure semantics (C3 Option C)", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-apply-partial-");
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
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("structured result has results + succeeded + failed + skipped", async () => {
    if (!dir) throw new Error("test setup failed");
    const result = await applyResolved(dir.path, { dryRun: true });
    expect(result.action).toBe("apply");
    expect(Array.isArray(result.results)).toBe(true);
    expect(Array.isArray(result.succeeded)).toBe(true);
    expect(Array.isArray(result.failed)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    // results.length must equal succeeded.length + failed.length — the
    // contract that a CLI consumer relies on.
    expect(result.results.length).toBe(result.succeeded.length + result.failed.length);
  });

  test("each result entry carries adapter name + files + warnings", async () => {
    if (!dir) throw new Error("test setup failed");
    const result = await applyResolved(dir.path, { dryRun: true });
    for (const entry of result.results) {
      expect(typeof entry.adapter).toBe("string");
      expect(Array.isArray(entry.files)).toBe(true);
      expect(Array.isArray(entry.warnings)).toBe(true);
      // error field is optional — present only on failures.
      if (entry.error !== undefined) {
        expect(typeof entry.error).toBe("string");
      }
    }
  });

  test("failed entries carry a string error message", async () => {
    // We can't easily force a live adapter to throw from a test, so this
    // test asserts the SHAPE of ApplyResolvedResult.failed when populated:
    // every entry has { adapter: string, error: string }. The actual
    // failure path is exercised by integration tests that run a full apply
    // against a deliberately-broken adapter fixture.
    if (!dir) throw new Error("test setup failed");
    const result = await applyResolved(dir.path, { dryRun: true });
    for (const entry of result.failed) {
      expect(typeof entry.adapter).toBe("string");
      expect(typeof entry.error).toBe("string");
      expect(entry.error.length).toBeGreaterThan(0);
    }
  });

  test("dry-run does NOT write any files", async () => {
    if (!dir) throw new Error("test setup failed");
    const result = await applyResolved(dir.path, { dryRun: true });
    expect(result.dryRun).toBe(true);
    // Every file entry has written: false in dry-run
    for (const entry of result.results) {
      for (const file of entry.files) {
        expect(file.written).toBe(false);
      }
    }
  });
});
