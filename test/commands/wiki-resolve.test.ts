/**
 * Command-level tests for `am wiki resolve` (M5.3-lite, DWL-T10).
 *
 * The resolve subcommand wraps `resolveConflicts` (covered at the unit
 * level in test/wiki/resolve.test.ts) with:
 *   - sidecar-absent guard → process.exitCode = 1 + structured error
 *   - --strategy flag short-circuiting the @clack/prompts select
 *   - --json output shape (action/wikiDir/sidecarPath/sidecarCleared/
 *     commitOid/resolvedFiles)
 *   - skip warning + exit 1 when at least one file was deferred
 *
 * The subcommand itself is NOT exported from src/commands/wiki.ts
 * (only the primary navigation subcommands are public exports).
 * We reach it via wikiCommand.subCommands.resolve() — the same path
 * citty uses at runtime.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { wikiCommand } from "../../src/commands/wiki";
import { commitAll, initRepo } from "../../src/core/git";
import { ensureWikiDirs, resolveWikiDir } from "../../src/wiki/storage";
import { writeConflictSidecar } from "../../src/wiki/sync";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ── Console capture (mirrors test/commands/wiki.test.ts) ──────────

let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const origLog = console.log;
const origError = console.error;
const origConfigDir = process.env.AM_CONFIG_DIR;

function captureConsole(): void {
  consoleOutput = [];
  consoleErrors = [];
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
}

function restoreConsole(): void {
  console.log = origLog;
  console.error = origError;
}

// ── Subcommand resolver ───────────────────────────────────────────

/**
 * Pull the resolve subcommand out of the lazy citty subCommands map.
 * Each entry is a thunk that returns Promise<CommandDef>; resolve()
 * unwraps it. Returns the same singleton each call.
 */
async function getResolveSubcommand() {
  const subs = wikiCommand.subCommands as Record<string, () => Promise<unknown>>;
  const sub = await subs.resolve();
  return sub as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> };
}

// Default args shape for the resolve subcommand. Each test overrides what it cares about.
function makeArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    json: false,
    quiet: false,
    verbose: false,
    strategy: undefined,
    ...overrides,
  };
}

// ── Test fixture: AM_CONFIG_DIR-isolated wiki dir + initialised repo ──

describe("am wiki resolve", () => {
  let dir: TestDir;
  let configDir: string;
  let wikiDir: string;

  beforeEach(async () => {
    dir = await createTestDir("am-wiki-resolve-cmd-");
    configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    wikiDir = resolveWikiDir({ global: true });
    await ensureWikiDirs(wikiDir);
    await initRepo(wikiDir);
    captureConsole();
    // Bun does not honour `process.exitCode = undefined` (it stays at the
    // last numeric value), so we set it to 0 here to mark "no failure
    // observed yet". Tests that expect a successful run assert
    // `process.exitCode` is 0; tests that expect a failure assert 1.
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    process.exitCode = 0;
    if (origConfigDir === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = origConfigDir;
    }
    if (dir) await dir.cleanup();
  });

  test("sidecar absent → emits guidance error and sets exit code 1", async () => {
    const cmd = await getResolveSubcommand();
    await cmd.run({ args: makeArgs() });

    expect(process.exitCode).toBe(1);
    const errText = consoleErrors.join("\n");
    expect(errText).toContain("wiki-conflict.json");
    // Caller is told what to do next.
    expect(errText).toContain("am wiki sync");
  });

  test("--strategy keep-local resolves all files non-interactively + clears sidecar", async () => {
    // Seed: a file under workdir that has been edited locally relative to HEAD.
    await writeFile(join(wikiDir, "page.md"), "original");
    await commitAll(wikiDir, "baseline");
    await writeFile(join(wikiDir, "page.md"), "local edit");

    await writeConflictSidecar(wikiDir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      branch: "main",
      conflictedFiles: ["page.md"],
    });

    const cmd = await getResolveSubcommand();
    await cmd.run({ args: makeArgs({ strategy: "keep-local" }) });

    // Sidecar gone, no error exit.
    expect(existsSync(join(wikiDir, "wiki-conflict.json"))).toBe(false);
    expect(process.exitCode).toBe(0);
    // Per-file line + cleared confirmation reach stdout via info().
    const out = consoleOutput.join("\n");
    expect(out).toMatch(/keep-local\s+page\.md/);
    expect(out).toContain("Sidecar cleared");
  });

  test("--strategy with invalid value throws and surfaces a useful error", async () => {
    await writeFile(join(wikiDir, "x.md"), "v1");
    await commitAll(wikiDir, "baseline");
    await writeFile(join(wikiDir, "x.md"), "v2");
    await writeConflictSidecar(wikiDir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["x.md"],
    });

    const cmd = await getResolveSubcommand();
    await cmd.run({ args: makeArgs({ strategy: "force-local" }) });

    expect(process.exitCode).toBe(1);
    expect(consoleErrors.join("\n")).toContain("force-local");
  });

  test("--json output shape includes action, sidecarCleared, commitOid, resolvedFiles", async () => {
    await writeFile(join(wikiDir, "a.md"), "orig-a");
    await writeFile(join(wikiDir, "b.md"), "orig-b");
    await commitAll(wikiDir, "baseline");
    await writeFile(join(wikiDir, "a.md"), "local-a");
    await writeFile(join(wikiDir, "b.md"), "local-b");

    await writeConflictSidecar(wikiDir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      branch: "main",
      conflictedFiles: ["a.md", "b.md"],
    });

    const cmd = await getResolveSubcommand();
    await cmd.run({ args: makeArgs({ strategy: "keep-local", json: true }) });

    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.action).toBe("resolve");
    expect(payload.wikiDir).toBe(wikiDir);
    expect(payload.sidecarPath).toBe(join(wikiDir, "wiki-conflict.json"));
    expect(payload.sidecarCleared).toBe(true);
    expect(typeof payload.commitOid).toBe("string");
    expect(payload.resolvedFiles).toEqual([
      { file: "a.md", choice: "keep-local" },
      { file: "b.md", choice: "keep-local" },
    ]);
    // JSON mode does not also dump non-JSON status lines that would corrupt parsing.
    expect(consoleOutput).toHaveLength(1);
  });

  test("--strategy skip leaves sidecar in place and warns with exit code 1", async () => {
    await writeFile(join(wikiDir, "z.md"), "orig");
    await commitAll(wikiDir, "baseline");
    await writeFile(join(wikiDir, "z.md"), "local-z");

    await writeConflictSidecar(wikiDir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["z.md"],
    });

    const cmd = await getResolveSubcommand();
    await cmd.run({ args: makeArgs({ strategy: "skip" }) });

    expect(existsSync(join(wikiDir, "wiki-conflict.json"))).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.join("\n")).toMatch(/Sidecar NOT cleared/i);
  });

  test("UX-2: no --strategy in non-interactive mode → error + exit 1 (does not hang)", async () => {
    // Seed a real sidecar so we get past the sidecar-absent guard and reach
    // the interactivity check. The test runner stdin is not a TTY, so without
    // --strategy the @clack/prompts.select prompt would hang forever; the
    // guard must surface a structured error and ask for --strategy instead.
    await writeFile(join(wikiDir, "ni.md"), "orig");
    await commitAll(wikiDir, "baseline");
    await writeFile(join(wikiDir, "ni.md"), "local-ni");
    await writeConflictSidecar(wikiDir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["ni.md"],
    });

    const cmd = await getResolveSubcommand();
    await cmd.run({ args: makeArgs() });

    expect(process.exitCode).toBe(1);
    const errText = consoleErrors.join("\n");
    expect(errText).toContain("--strategy");
    // Sidecar must remain untouched — nothing was resolved.
    expect(existsSync(join(wikiDir, "wiki-conflict.json"))).toBe(true);
  });

  test("UX-2: --json with no --strategy → error + exit 1 (no prompt)", async () => {
    await writeFile(join(wikiDir, "j.md"), "orig");
    await commitAll(wikiDir, "baseline");
    await writeFile(join(wikiDir, "j.md"), "local-j");
    await writeConflictSidecar(wikiDir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["j.md"],
    });

    const cmd = await getResolveSubcommand();
    await cmd.run({ args: makeArgs({ json: true }) });

    expect(process.exitCode).toBe(1);
    // In --json mode the error is emitted as a JSON object on stderr.
    expect(consoleErrors.join("\n")).toContain("--strategy");
  });

  test("UX-2: invalid --strategy errors before any IO even with a sidecar present", async () => {
    await writeFile(join(wikiDir, "v.md"), "orig");
    await commitAll(wikiDir, "baseline");
    await writeFile(join(wikiDir, "v.md"), "local-v");
    await writeConflictSidecar(wikiDir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["v.md"],
    });

    const cmd = await getResolveSubcommand();
    await cmd.run({ args: makeArgs({ strategy: "nonsense" }) });

    expect(process.exitCode).toBe(1);
    expect(consoleErrors.join("\n")).toContain("nonsense");
    // Sidecar untouched: validation happened up front.
    expect(existsSync(join(wikiDir, "wiki-conflict.json"))).toBe(true);
  });

  test("--strategy take-remote with no remote ref yields a structured error (not a stack trace)", async () => {
    // No FETCH_HEAD and no origin/<branch> in the bare local repo → take-remote
    // can't locate the remote blob. The subcommand should surface the
    // resolveConflicts error via error() + exit 1, not crash with an
    // uncaught rejection.
    await writeFile(join(wikiDir, "p.md"), "v1");
    await commitAll(wikiDir, "baseline");
    await writeFile(join(wikiDir, "p.md"), "v2");

    await writeConflictSidecar(wikiDir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      branch: "main",
      conflictedFiles: ["p.md"],
    });

    const cmd = await getResolveSubcommand();
    await cmd.run({ args: makeArgs({ strategy: "take-remote" }) });

    expect(process.exitCode).toBe(1);
    // The error path runs through lib/output#error, which writes to stderr.
    // We don't assert exact wording (that lives in resolve.ts) — just that
    // an error reached the user surface and execution didn't bypass the catch.
    expect(consoleErrors.join("\n").length).toBeGreaterThan(0);
  });
});
