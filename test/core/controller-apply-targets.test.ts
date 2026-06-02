/**
 * P1-B: `applyResolved` supports an explicit `targets[]` selection (per-target
 * opt-in) on top of the singular `target`. The CLI's interactive selection and
 * the `--targets a,b` flag both pass this list; the controller resolves only
 * the named adapters, de-duped and trimmed, and throws on an unknown name —
 * mirroring the single-`target` path.
 *
 * The controller MUST stay I/O-free (ADR-0040): it only resolves the named
 * adapters and runs export()/diff(); it never prompts.
 *
 * Adapters are injected via the `__setAdapterResolverForTests` seam? No — the
 * seam intentionally ignores the target list (it returns a fixed set). To
 * exercise the REAL target-resolution branch we use actual registered adapter
 * names and let `getAdapter` resolve them. Detection is bypassed because
 * explicit targets skip `getDetectedAdapters()`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { listAdapters } from "../../src/adapters/registry";
import { writeConfig } from "../../src/core/config";
import { applyResolved } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("applyResolved — explicit targets[] (P1-B)", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-apply-targets-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
      },
    });
  });

  afterEach(async () => {
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("targets resolves exactly the named adapters (dry-run, no host detection)", async () => {
    if (!dir) throw new Error("setup failed");
    // Use real adapter names so getAdapter resolves them; dry-run keeps it
    // safe (no native files written) and bypasses host IDE detection.
    const names = ["claude-code", "cursor"].filter((n) => listAdapters().includes(n));
    expect(names.length).toBe(2);

    const result = await applyResolved(dir.path, { dryRun: true, targets: names });
    const applied = result.results.map((r) => r.adapter).sort();
    expect(applied).toEqual([...names].sort());
  });

  test("duplicate names in targets resolve once", async () => {
    if (!dir) throw new Error("setup failed");
    const result = await applyResolved(dir.path, {
      dryRun: true,
      targets: ["claude-code", "claude-code"],
    });
    expect(result.results.map((r) => r.adapter)).toEqual(["claude-code"]);
  });

  test("blank / whitespace-only target names are dropped", async () => {
    if (!dir) throw new Error("setup failed");
    const result = await applyResolved(dir.path, {
      dryRun: true,
      targets: ["  ", "claude-code", ""],
    });
    expect(result.results.map((r) => r.adapter)).toEqual(["claude-code"]);
  });

  test("singular target and targets[] union together (de-duped)", async () => {
    if (!dir) throw new Error("setup failed");
    const result = await applyResolved(dir.path, {
      dryRun: true,
      target: "claude-code",
      targets: ["cursor", "claude-code"],
    });
    expect(result.results.map((r) => r.adapter).sort()).toEqual(["claude-code", "cursor"]);
  });

  test("an unknown target name throws (mirrors the single-target path)", async () => {
    if (!dir) throw new Error("setup failed");
    await expect(
      applyResolved(dir.path, { dryRun: true, targets: ["claude-code", "not-a-real-adapter"] }),
    ).rejects.toThrow(/not found/);
  });
});
