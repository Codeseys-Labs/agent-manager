/**
 * apply-summary-line (Wave A-APPLY): the `am apply` summary must DISTINGUISH
 * the two fail-closed skip reasons the controller funnels into `skipped[]`:
 *
 *   1. drift detected      — `adapter.diff()` reported the native config has
 *                            drifted from the catalog (warning "drift detected").
 *   2. drift check failed  — `adapter.diff()` THREW; drift state is UNKNOWN
 *                            (warning "drift check failed"). SEC-4 fail-closed.
 *
 * Before this fix the summary mislabeled BOTH as "skipped (drift detected;
 * rerun --force)", hiding the fact that for the diff-error case we never even
 * read the drift state. This test pins the two distinct summary strings.
 *
 * Adapters are injected via the controller's `__setAdapterResolverForTests`
 * seam (cleared in finally) — NOT `mock.module`, which is process-global in
 * Bun and leaks into other test files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, DiffResult, ExportResult, ResolvedConfig } from "../../src/adapters/types";
import { applyCommand } from "../../src/commands/apply";
import { __setAdapterResolverForTests } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ── Console capture ───────────────────────────────────────────────
let stdoutLines: string[] = [];
let stderrLines: string[] = [];
const origLog = console.log;
const origErr = console.error;
const origWrite = process.stdout.write.bind(process.stdout);

function captureConsole(): void {
  stdoutLines = [];
  stderrLines = [];
  console.log = (...chunks: unknown[]) => {
    stdoutLines.push(chunks.map(String).join(" "));
  };
  console.error = (...chunks: unknown[]) => {
    stderrLines.push(chunks.map(String).join(" "));
  };
  process.stdout.write = ((chunk: unknown) => {
    stdoutLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
}

function restoreConsole(): void {
  console.log = origLog;
  console.error = origErr;
  process.stdout.write = origWrite;
}

type Args = Record<string, unknown>;
async function invoke(args: Args): Promise<void> {
  await (applyCommand as { run: (ctx: { args: Args }) => Promise<void> }).run({ args });
}

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
      return { files: [{ path: `/tmp/${name}.json`, content: "{}", written: true }], warnings: [] };
    },
  };
}

/** Adapter whose diff() reports DRIFT (one change). */
function driftedAdapter(name: string): Adapter {
  return {
    ...baseAdapter(name),
    diff(_config: ResolvedConfig): DiffResult {
      return {
        status: "drifted",
        changes: [{ entity: "server", name: "fetch", type: "modified" }],
      };
    },
  };
}

/** Adapter whose diff() THROWS — drift state unknown. */
function throwingAdapter(name: string): Adapter {
  return {
    ...baseAdapter(name),
    diff(): DiffResult {
      throw new Error("simulated diff() failure");
    },
  };
}

describe("am apply — summary line distinguishes skip reasons", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-apply-summary-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
    await writeFile(
      join(dir.path, "config.toml"),
      `
[servers.fetch]
command = "uvx"
args = ["mcp-server-fetch"]
transport = "stdio"
enabled = true
`,
      "utf-8",
    );
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    __setAdapterResolverForTests(null);
    process.exitCode = 0;
    if (originalEnv === undefined) process.env.AM_CONFIG_DIR = undefined;
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("confirmed drift → 'skipped (drift detected; rerun with --force)'", async () => {
    __setAdapterResolverForTests(async () => [driftedAdapter("drifted-fake")]);
    await invoke({
      "dry-run": false,
      diff: true,
      force: false,
      json: false,
      quiet: false,
      verbose: false,
    });

    const out = stdoutLines.join("\n");
    expect(out).toContain("skipped (drift detected; rerun with --force)");
    // It must NOT use the diff-error wording for a confirmed-drift skip.
    expect(out).not.toContain("drift check failed");
    // Non-zero exit so CI catches the refusal.
    expect(process.exitCode).toBe(1);
  });

  test("diff() threw → 'skipped (drift check failed — state unknown; rerun with --force)'", async () => {
    __setAdapterResolverForTests(async () => [throwingAdapter("throwing-fake")]);
    await invoke({
      "dry-run": false,
      diff: true,
      force: false,
      json: false,
      quiet: false,
      verbose: false,
    });

    const out = stdoutLines.join("\n");
    expect(out).toContain("drift check failed — state unknown");
    // The diff-error skip must NOT be mislabeled as confirmed drift in the
    // summary line. (The per-adapter warning legitimately says "drift check
    // failed"; the regression we guard is the SUMMARY saying "drift detected".)
    const summaryLine = stdoutLines.find((l) => l.includes("Applied to")) ?? "";
    expect(summaryLine).not.toContain("(drift detected;");
    expect(process.exitCode).toBe(1);
  });

  test("both kinds in one run → summary reports each separately", async () => {
    __setAdapterResolverForTests(async () => [
      driftedAdapter("drifted-fake"),
      throwingAdapter("throwing-fake"),
    ]);
    await invoke({
      "dry-run": false,
      diff: true,
      force: false,
      json: false,
      quiet: false,
      verbose: false,
    });

    const summaryLine = stdoutLines.find((l) => l.includes("Applied to")) ?? "";
    expect(summaryLine).toContain("drift detected; rerun with --force");
    expect(summaryLine).toContain("drift check failed — state unknown");
    // Each reason names its own adapter so the operator knows which is which.
    expect(summaryLine).toContain("drifted-fake");
    expect(summaryLine).toContain("throwing-fake");
    expect(process.exitCode).toBe(1);
  });
});
