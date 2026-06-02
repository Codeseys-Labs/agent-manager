/**
 * SEC-4c regression: the TUI apply button must inherit the CLI's fail-closed
 * drift gate.
 *
 * Before this fix, `handleApply` called `applyResolved(configDir)` with NO
 * diff/force options, so a single button press silently OVERWROTE a drifted
 * native config — the exact overwrite class SEC-4b closed on the MCP and web
 * surfaces (the 2026-04-15 `~/.claude.json` wipe lineage). The TUI apply path
 * now derives `diff` from the SHARED APPLY_SAFE_DEFAULTS and SKIPS a drifted
 * (or unreadable-drift) adapter, surfacing the skipped list to the user and
 * offering an explicit force re-apply (the `F` key → force=true).
 *
 * We exercise the extracted `runTuiApply` — the literal function the TUI's
 * apply keybinding calls — so this proves the real call path gates, not a
 * parallel reimplementation. Adapters are injected via the controller's
 * `__setAdapterResolverForTests` seam (cleared in afterEach) — NOT
 * `mock.module`, which is process-global in Bun and leaks across files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import type { Adapter, DiffResult, ExportResult, ResolvedConfig } from "../../src/adapters/types";
import { __setAdapterResolverForTests } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import { runTuiApply } from "../../src/tui/index.tsx";

let exportCalled = false;

function baseAdapter(name: string): Omit<Adapter, "diff"> {
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
      return { files: [{ path: `/tmp/${name}.json`, content: "{}", written: true }], warnings: [] };
    },
  };
}

function driftedAdapter(name: string): Adapter {
  return {
    ...baseAdapter(name),
    diff(): DiffResult {
      return {
        status: "drifted",
        changes: [{ entity: "server", name: "fetch", type: "modified" }],
      };
    },
  };
}

function throwingAdapter(name: string): Adapter {
  return {
    ...baseAdapter(name),
    diff(): DiffResult {
      throw new Error("simulated diff() failure");
    },
  };
}

function cleanAdapter(name: string): Adapter {
  return {
    ...baseAdapter(name),
    diff(): DiffResult {
      return { status: "in-sync", changes: [] };
    },
  };
}

describe("TUI apply button — fail-closed drift gate (SEC-4c)", () => {
  let tmpDir: string;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    exportCalled = false;
    tmpDir = await mkdtemp(join(tmpdir(), "am-tui-failclosed-"));
    await initRepo(tmpDir);
    await writeFile(
      join(tmpDir, "config.toml"),
      TOML.stringify({
        settings: { default_profile: "default" },
        servers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
        },
      } as TOML.JsonMap),
    );
    process.env.AM_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    __setAdapterResolverForTests(null);
    if (originalEnv === undefined) process.env.AM_CONFIG_DIR = undefined;
    else process.env.AM_CONFIG_DIR = originalEnv;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("drifted adapter is SKIPPED, not overwritten (default button press)", async () => {
    __setAdapterResolverForTests(async () => [driftedAdapter("drifted-fake")]);
    const msg = await runTuiApply(tmpDir);

    // The gate fired: export() never ran, so the native config was NOT wiped.
    expect(exportCalled).toBe(false);
    // The skipped tool is surfaced to the user with a force hint.
    expect(msg).toContain("SKIPPED");
    expect(msg).toContain("drifted-fake");
    expect(msg).toContain("[F]");
  });

  test("diff() that throws → SKIPPED (drift state unknown, fail-closed)", async () => {
    __setAdapterResolverForTests(async () => [throwingAdapter("throwing-fake")]);
    const msg = await runTuiApply(tmpDir);

    expect(exportCalled).toBe(false);
    expect(msg).toContain("SKIPPED");
    expect(msg).toContain("throwing-fake");
  });

  test("force=true overwrites the drifted adapter (explicit [F] opt-in)", async () => {
    __setAdapterResolverForTests(async () => [driftedAdapter("drifted-fake")]);
    const msg = await runTuiApply(tmpDir, true);

    // The explicit force opt-in writes through the gate.
    expect(exportCalled).toBe(true);
    expect(msg).not.toContain("SKIPPED");
    expect(msg).toContain("Apply complete");
    expect(msg).toContain("forced");
  });

  test("in-sync adapter applies normally (gate does not block clean state)", async () => {
    __setAdapterResolverForTests(async () => [cleanAdapter("clean-fake")]);
    const msg = await runTuiApply(tmpDir);

    expect(exportCalled).toBe(true);
    expect(msg).toContain("Apply complete");
    expect(msg).not.toContain("SKIPPED");
  });
});
