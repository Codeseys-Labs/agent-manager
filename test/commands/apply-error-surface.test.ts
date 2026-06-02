/**
 * Wave B apply-follow — two regressions on `am apply`:
 *
 * 1. silent-failure (MEDIUM): `apply.ts` previously wrapped `applyResolved` in
 *    a catch that converted ANY non-'not found' error into
 *    `AmError('Config not found', 'Run am init', 'CONFIG_NOT_FOUND')`. That
 *    MASKED a real Windows crypto throw ('The string contains invalid
 *    characters', from `atob()` on a malformed key) as a misleading 'Config not
 *    found', costing debugging time. The catch is now narrowed: only an
 *    adapter-not-found keeps a dedicated code; every other error surfaces with
 *    its REAL message. A non-config error must NOT be reported as 'Config not
 *    found'.
 *
 * 2. CLI fail-closed default (LOW): a bare `am apply` (no `--diff`, no `--force`)
 *    now runs the drift gate by default (derived from the shared
 *    APPLY_SAFE_DEFAULTS), consistent with the MCP / web / TUI surfaces. A
 *    drifted adapter is SKIPPED (not overwritten) and the run exits non-zero,
 *    even though the operator passed no `--diff` flag. `--force` overwrites.
 *
 * Adapters / failures are injected via the controller's
 * `__setAdapterResolverForTests` seam (cleared in afterEach) — NOT
 * `mock.module`, which is process-global in Bun and leaks across files.
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

function defaultArgs(overrides: Args = {}): Args {
  return {
    "dry-run": false,
    diff: false,
    force: false,
    json: false,
    quiet: false,
    verbose: false,
    ...overrides,
  };
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

let exportCalled = false;

describe("am apply — error surfacing + fail-closed default", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    exportCalled = false;
    dir = await createTestDir("am-apply-errsurface-");
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
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("silent-failure: a non-config error surfaces its REAL message, NOT 'Config not found'", async () => {
    // Simulate the Windows crypto throw that the old catch masked. The message
    // does NOT contain 'not found', so the old code would have rewritten it as
    // 'Config not found'.
    __setAdapterResolverForTests(async () => {
      throw new Error("The string contains invalid characters");
    });

    await invoke(defaultArgs());

    const allOut = [...stdoutLines, ...stderrLines].join("\n");
    // The real failure cause is preserved.
    expect(allOut).toContain("The string contains invalid characters");
    // The misleading legacy label must NOT appear.
    expect(allOut).not.toContain("Config not found");
    // And it should not steer the user to `am init` for a non-config problem.
    expect(allOut).not.toContain("Run `am init`");
    expect(process.exitCode).toBe(1);
  });

  test("adapter-not-found still surfaces a 'not found' message (dedicated path preserved)", async () => {
    // An unknown explicit target throws "Adapter ... not found" from the
    // controller; the CLI keeps its dedicated mapping for that.
    await invoke(defaultArgs({ target: "definitely-not-a-real-adapter" }));

    const allOut = [...stdoutLines, ...stderrLines].join("\n");
    expect(allOut).toContain("not found");
    expect(allOut).not.toContain("Config not found");
    expect(process.exitCode).toBe(1);
  });

  test("fail-closed default: bare `am apply` (no --diff) SKIPS a drifted adapter", async () => {
    __setAdapterResolverForTests(async () => [driftedAdapter("drifted-fake")]);

    // Note: NO diff flag and NO force — the previous default would have
    // overwritten the drifted native config (the SEC-4b overwrite class).
    await invoke(defaultArgs());

    // The gate fired: export() never ran.
    expect(exportCalled).toBe(false);
    const out = stdoutLines.join("\n");
    expect(out).toContain("skipped (drift detected; rerun with --force)");
    expect(out).toContain("drifted-fake");
    // Non-zero exit so CI catches the refusal.
    expect(process.exitCode).toBe(1);
  });

  test("--force overwrites a drifted adapter under the new default", async () => {
    __setAdapterResolverForTests(async () => [driftedAdapter("drifted-fake")]);

    await invoke(defaultArgs({ force: true }));

    // The explicit opt-in writes through the gate.
    expect(exportCalled).toBe(true);
    const out = stdoutLines.join("\n");
    expect(out).toContain("Applied to 1");
    expect(out).not.toContain("skipped");
    expect(process.exitCode).toBe(0);
  });

  test("default output stays uncluttered: no inline 'drift=' line without --diff", async () => {
    // An in-sync adapter applies; the gate runs but the verbose drift summary
    // line is only shown with the explicit --diff flag.
    const inSync: Adapter = {
      ...baseAdapter("clean-fake"),
      diff(): DiffResult {
        return { status: "in-sync", changes: [] };
      },
    };
    __setAdapterResolverForTests(async () => [inSync]);

    await invoke(defaultArgs());

    const out = stdoutLines.join("\n");
    expect(exportCalled).toBe(true);
    expect(out).toContain("wrote");
    expect(out).not.toContain("drift=");
    expect(process.exitCode).toBe(0);
  });

  test("--diff still shows the inline drift summary line", async () => {
    const inSync: Adapter = {
      ...baseAdapter("clean-fake"),
      diff(): DiffResult {
        return { status: "in-sync", changes: [] };
      },
    };
    __setAdapterResolverForTests(async () => [inSync]);

    await invoke(defaultArgs({ diff: true }));

    const out = stdoutLines.join("\n");
    expect(out).toContain("drift=in-sync");
    expect(process.exitCode).toBe(0);
  });
});
