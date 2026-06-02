/**
 * Wave E (E-TUITEST): cover the interactive multiselect target-confirmation
 * path in `am apply`.
 *
 * `am apply` fans out to EVERY detected tool, and detection is pure
 * file-presence (over-reports). In an interactive live apply the operator is
 * shown the detected list and confirms/selects which tools to write
 * (P1-B opt-in). That branch — `clack.multiselect` behind the
 * `wantsInteractiveSelection` guard — was previously UNCOVERED because bun:test
 * has no TTY and can't drive a clack prompt.
 *
 * The target-selection decision is now factored into the pure/injectable
 * `resolveApplyTargets` unit, and the prompt is reachable through the
 * `__setClackForTests` / `__setDetectedAdaptersForTests` seams (mirroring the
 * pattern in commands/setup.ts and `__setAdapterResolverForTests` in the
 * controller). These tests drive that path WITHOUT a process-global
 * `mock.module("@clack/prompts", …)`, which would leak into every other
 * parallel test file that imports clack.
 *
 * Two layers:
 *   1. Unit — `resolveApplyTargets` directly: the multiselect returns the
 *      chosen subset / a cancel / the empty selection, and every
 *      non-interactive mode (--yes/--json/--quiet/--target/--targets/dry-run/
 *      non-TTY) bypasses the prompt and preserves fan-out-to-all.
 *   2. Handler — the real `applyCommand.run()` path under a forced TTY with the
 *      injected detection + clack double, asserting the multiselect FIRES and
 *      the apply proceeds, vs. a cancel that short-circuits before the
 *      controller. The selected-subset → controller scoping itself is proven
 *      separately by test/core/controller-apply-targets.test.ts (applyResolved
 *      resolves exactly the named targets); together they cover the chain.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, ExportResult, ResolvedConfig } from "../../src/adapters/types";
import {
  type ClackLike,
  __setClackForTests,
  __setDetectedAdaptersForTests,
  applyCommand,
  resolveApplyTargets,
} from "../../src/commands/apply";
import { __setAdapterResolverForTests } from "../../src/core/controller";
import { type TestDir, createTestDir } from "../helpers/tmp";

// `Symbol.for("clack:cancel")` is clack's actual cancel sentinel (a global
// registry symbol, so this resolves to the SAME symbol clack uses). The double
// below pairs it with a matching `isCancel`, so the source's injected
// `prompt.isCancel(selection)` check is exercised exactly as in production.
const CANCEL = Symbol.for("clack:cancel");

/**
 * Build a minimal detected-adapter list. Only `meta.name` / `meta.displayName`
 * are read by the multiselect path; the rest of the `Adapter` surface is unused
 * here so it is cast at the boundary (mirrors the clack double in
 * test/commands/setup-interactive.test.ts).
 */
function fakeAdapters(...names: Array<string | [name: string, display: string]>): Adapter[] {
  return names.map((n) => {
    const [name, displayName] = Array.isArray(n) ? n : [n, n];
    return { meta: { name, displayName } } as unknown as Adapter;
  });
}

/**
 * A clack double that records the options it was shown and returns a scripted
 * selection (or the cancel sentinel). `isCancel` is a real identity check
 * against the sentinel so the cancel branch is genuinely exercised.
 */
function makeClackDouble(answer: string[] | symbol): {
  clack: ClackLike;
  shownOptions: Array<{ value: string; label: string }> | undefined;
  shownInitial: string[] | undefined;
  calls: number;
} {
  const state = {
    shownOptions: undefined as Array<{ value: string; label: string }> | undefined,
    shownInitial: undefined as string[] | undefined,
    calls: 0,
  };
  const clack = {
    multiselect: async (cfg: {
      options: Array<{ value: string; label: string }>;
      initialValues: string[];
    }) => {
      state.calls += 1;
      state.shownOptions = cfg.options;
      state.shownInitial = cfg.initialValues;
      return answer;
    },
    isCancel: (v: unknown): v is symbol => v === CANCEL,
  } as unknown as ClackLike;
  return {
    clack,
    get shownOptions() {
      return state.shownOptions;
    },
    get shownInitial() {
      return state.shownInitial;
    },
    get calls() {
      return state.calls;
    },
  };
}

/** A clack double whose multiselect throws — proves the prompt was NOT called. */
function neverPromptClack(): ClackLike {
  return {
    multiselect: async () => {
      throw new Error("multiselect must not be called in this mode");
    },
    isCancel: (v: unknown): v is symbol => v === CANCEL,
  } as unknown as ClackLike;
}

function baseInput(overrides: Partial<Parameters<typeof resolveApplyTargets>[0]> = {}) {
  return {
    explicitTargets: [],
    target: undefined,
    yes: false,
    json: false,
    quiet: false,
    dryRun: false,
    isTTY: true,
    ...overrides,
  };
}

describe("resolveApplyTargets — interactive multiselect (unit)", () => {
  test("returns the user's chosen subset", async () => {
    const dbl = makeClackDouble(["claude-code", "cursor"]);
    const result = await resolveApplyTargets(
      baseInput(),
      async () => fakeAdapters("claude-code", "cursor", "windsurf"),
      dbl.clack,
    );
    expect(result).toEqual({ action: "apply", targets: ["claude-code", "cursor"] });
    // The prompt was actually driven, and it offered every detected tool.
    expect(dbl.calls).toBe(1);
    expect(dbl.shownOptions?.map((o) => o.value)).toEqual(["claude-code", "cursor", "windsurf"]);
    // initialValues pre-checks every detected tool (the fan-out default).
    expect(dbl.shownInitial).toEqual(["claude-code", "cursor", "windsurf"]);
  });

  test("uses displayName for the option label, falling back to name", async () => {
    const dbl = makeClackDouble(["claude-code"]);
    await resolveApplyTargets(
      baseInput(),
      async () => fakeAdapters(["claude-code", "Claude Code"], "cursor"),
      dbl.clack,
    );
    expect(dbl.shownOptions).toEqual([
      { value: "claude-code", label: "Claude Code" },
      { value: "cursor", label: "cursor" },
    ]);
  });

  test("a cancelled prompt yields a cancelled decision", async () => {
    const dbl = makeClackDouble(CANCEL);
    const result = await resolveApplyTargets(
      baseInput(),
      async () => fakeAdapters("claude-code", "cursor"),
      dbl.clack,
    );
    expect(result).toEqual({ action: "cancelled" });
    expect(dbl.calls).toBe(1);
  });

  test("an empty selection is returned as an explicit empty subset, not undefined", async () => {
    // `required: true` normally stops clack from returning [], but a double can.
    // The decision must surface the empty subset as `targets: []` rather than
    // collapsing it to `undefined` — `undefined` is the no-targets-flag signal
    // that the handler turns into apply-to-all, whereas `[]` is an explicit
    // "the operator selected nothing" that the caller can distinguish.
    const dbl = makeClackDouble([]);
    const result = await resolveApplyTargets(
      baseInput(),
      async () => fakeAdapters("claude-code", "cursor"),
      dbl.clack,
    );
    expect(result).toEqual({ action: "apply", targets: [] });
  });

  test("a single detected tool applies without prompting", async () => {
    const result = await resolveApplyTargets(
      baseInput(),
      async () => fakeAdapters("claude-code"),
      neverPromptClack(),
    );
    expect(result).toEqual({ action: "apply", targets: undefined });
  });

  test("zero detected tools applies (to none) without prompting", async () => {
    const result = await resolveApplyTargets(baseInput(), async () => [], neverPromptClack());
    expect(result).toEqual({ action: "apply", targets: undefined });
  });
});

describe("resolveApplyTargets — non-interactive bypasses (unit)", () => {
  test("explicit --targets wins and never prompts (even on a TTY)", async () => {
    let detected = false;
    const result = await resolveApplyTargets(
      baseInput({ explicitTargets: ["claude-code", "cursor"] }),
      async () => {
        detected = true;
        return fakeAdapters("a", "b", "c");
      },
      neverPromptClack(),
    );
    expect(result).toEqual({ action: "apply", targets: ["claude-code", "cursor"] });
    // Detection is not even consulted when explicit targets are given.
    expect(detected).toBe(false);
  });

  for (const [label, overrides] of [
    ["--yes", { yes: true }],
    ["--json", { json: true }],
    ["--quiet", { quiet: true }],
    ["--target", { target: "claude-code" }],
    ["--dry-run", { dryRun: true }],
    ["non-TTY", { isTTY: false }],
  ] as const) {
    test(`${label} bypasses the prompt and fans out to all (targets undefined)`, async () => {
      const result = await resolveApplyTargets(
        baseInput(overrides),
        async () => fakeAdapters("claude-code", "cursor"),
        neverPromptClack(),
      );
      expect(result).toEqual({ action: "apply", targets: undefined });
    });
  }
});

// ── Handler-level: drive the real applyCommand.run() through the seams ──────

let stdoutLines: string[] = [];
const origLog = console.log;
const origWrite = process.stdout.write.bind(process.stdout);
const origTTY = process.stdin.isTTY;

function captureConsole(): void {
  stdoutLines = [];
  console.log = (...chunks: unknown[]) => {
    stdoutLines.push(chunks.map(String).join(" "));
  };
  process.stdout.write = ((chunk: unknown) => {
    stdoutLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
}

function restoreConsole(): void {
  console.log = origLog;
  process.stdout.write = origWrite;
}

type Args = Record<string, unknown>;
async function invoke(args: Args): Promise<void> {
  await (applyCommand as { run: (ctx: { args: Args }) => Promise<void> }).run({ args });
}

function makeArgs(overrides: Args = {}): Args {
  return {
    "dry-run": false,
    diff: false,
    force: false,
    target: undefined,
    targets: undefined,
    yes: false,
    profile: undefined,
    json: false,
    quiet: false,
    verbose: false,
    ...overrides,
  };
}

/**
 * A fully-synthetic adapter whose `export()` returns an already-"written" file
 * struct WITHOUT touching the real filesystem, and whose `diff()` is in-sync (so
 * the live drift gate never trips). This is the hermetic pattern from
 * test/commands/apply-summary-line.test.ts: injected through the controller's
 * `__setAdapterResolverForTests`, a live `am apply` writes nothing to the host's
 * real `~/.claude.json` / `~/.cursor` etc.
 */
function inSyncFakeAdapter(name: string): Adapter {
  return {
    meta: { name, displayName: name, version: "0.0.0", capabilities: [] },
    detect() {
      return { installed: true, paths: {} };
    },
    import() {
      return { servers: [], instructions: [], skills: [], warnings: [] };
    },
    export(_config: ResolvedConfig): ExportResult {
      return { files: [{ path: `/tmp/${name}.json`, content: "{}", written: true }], warnings: [] };
    },
    diff(): { status: "in-sync"; changes: [] } {
      return { status: "in-sync", changes: [] };
    },
  } as unknown as Adapter;
}

describe("am apply — interactive multiselect (handler path)", () => {
  let dir: TestDir | undefined;
  const originalConfigDir = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-apply-multiselect-");
    process.env.AM_CONFIG_DIR = dir.path;
    const { initRepo } = await import("../../src/core/git");
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
    // Force the interactive guard ON.
    process.stdin.isTTY = true;
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    __setDetectedAdaptersForTests(null);
    __setClackForTests(null);
    __setAdapterResolverForTests(null);
    process.stdin.isTTY = origTTY;
    process.exitCode = 0;
    if (originalConfigDir === undefined) {
      // Avoid the Windows env-coercion footgun: deleting is correct, assigning
      // `undefined` would stringify to "undefined".
      // biome-ignore lint/performance/noDelete: env var teardown
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = originalConfigDir;
    }
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("the multiselect fires through the seam, then the apply proceeds (real handler)", async () => {
    // Detection (the prompt source) returns three tools; the operator picks two.
    // The controller is fed HERMETIC fakes so a live (non-dry-run) apply writes
    // nothing to the host. We assert the prompt was driven once and the run
    // proceeded past it into the controller (per-adapter "wrote" lines).
    __setDetectedAdaptersForTests(async () => fakeAdapters("claude-code", "cursor", "windsurf"));
    __setAdapterResolverForTests(async () => [
      inSyncFakeAdapter("claude-code"),
      inSyncFakeAdapter("cursor"),
    ]);
    const dbl = makeClackDouble(["claude-code", "cursor"]);
    __setClackForTests(dbl.clack);

    await invoke(makeArgs());

    // The interactive multiselect was reached and shown the full detected list.
    expect(dbl.calls).toBe(1);
    expect(dbl.shownOptions?.map((o) => o.value)).toEqual(["claude-code", "cursor", "windsurf"]);
    // The run proceeded into the controller (did NOT cancel).
    const out = stdoutLines.join("\n");
    expect(out).toContain("claude-code: wrote");
    expect(out).toContain("cursor: wrote");
    expect(process.exitCode).toBe(0);
  });

  test("a cancelled multiselect aborts with 'Apply cancelled.' and never reaches the controller", async () => {
    __setDetectedAdaptersForTests(async () => fakeAdapters("claude-code", "cursor"));
    const dbl = makeClackDouble(CANCEL);
    __setClackForTests(dbl.clack);
    // If the controller were reached it would resolve adapters here; make that
    // loud so a regression that ignores the cancel is caught.
    __setAdapterResolverForTests(async () => {
      throw new Error("controller must not run after a cancel");
    });

    await invoke(makeArgs());

    expect(dbl.calls).toBe(1);
    const out = stdoutLines.join("\n");
    expect(out).toContain("Apply cancelled.");
    expect(out).not.toContain("wrote");
  });

  test("--yes under a TTY bypasses the prompt entirely", async () => {
    // neverPromptClack throws if the prompt is reached; reaching the controller
    // (which reports the hermetic fakes) proves the bypass.
    __setDetectedAdaptersForTests(async () => fakeAdapters("claude-code", "cursor"));
    __setAdapterResolverForTests(async () => [
      inSyncFakeAdapter("claude-code"),
      inSyncFakeAdapter("cursor"),
    ]);
    __setClackForTests(neverPromptClack());

    await invoke(makeArgs({ yes: true }));

    const out = stdoutLines.join("\n");
    expect(out).toContain("claude-code: wrote");
    expect(out).toContain("cursor: wrote");
  });
});
