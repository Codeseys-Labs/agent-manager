/**
 * ADR-0033 Phase A: `am run <tier-3-agent>` must refuse with a helpful
 * message rather than silently failing when the adapter ships no
 * spawnable ACP runtime.
 *
 * This test drives the `am run` command's runnable-guard path directly
 * (invokes the command's runner) and asserts:
 *   1. Process exit code is 1.
 *   2. The error message mentions "catalog-only" so the user knows it's
 *      not a missing-dependency problem.
 *   3. The error message points the user at a runnable alternative
 *      (`am agent list --tier native`).
 *   4. No partial state is left behind (no spawn attempt).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCommand } from "../../src/commands/run";
import { type TestDir, createTestDir } from "../helpers/tmp";

type RunArgs = Record<string, unknown>;

async function invokeRun(args: RunArgs): Promise<void> {
  // citty commands expose a `run({ args })` method at the top level. We call
  // it directly rather than going through the CLI parser.
  await (runCommand as unknown as { run: (ctx: { args: RunArgs }) => Promise<void> }).run({ args });
}

// ── Console capture ────────────────────────────────────────────

let stdoutLines: string[] = [];
let stderrLines: string[] = [];
const origLog = console.log;
const origErr = console.error;

function captureConsole() {
  stdoutLines = [];
  stderrLines = [];
  console.log = (...chunks: unknown[]) => {
    stdoutLines.push(chunks.map(String).join(" "));
  };
  console.error = (...chunks: unknown[]) => {
    stderrLines.push(chunks.map(String).join(" "));
  };
}

function restoreConsole() {
  console.log = origLog;
  console.error = origErr;
}

// ── Suite ──────────────────────────────────────────────────────

describe("am run — tier-3 catalog-only guard (ADR-0033)", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-run-guard-");
    process.env.AM_CONFIG_DIR = dir.path;
    captureConsole();
    process.exitCode = undefined;
  });

  afterEach(async () => {
    restoreConsole();
    process.exitCode = undefined;
    if (originalEnv) process.env.AM_CONFIG_DIR = originalEnv;
    else process.env.AM_CONFIG_DIR = undefined;
    if (dir) await dir.cleanup();
  });

  test("am run cline ... exits 1 with a catalog-only message and a runnable-alternative hint", async () => {
    await invokeRun({
      agent: "cline",
      prompt: "refactor foo.ts",
      json: false,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode).toBe(1);
    const joined = stderrLines.join("\n");
    expect(joined).toContain("cline");
    expect(joined).toContain("catalog-only");
    // Points to the runnable alternatives listing.
    expect(joined).toContain("am agent list --tier native");
    // Stdout is empty — no spawn attempt, no streamed output.
    expect(stdoutLines.join("")).toBe("");
  });

  test.each([["windsurf"], ["roo-code"], ["copilot"], ["cursor"], ["kilo-code"], ["continue"]])(
    "am run %s refuses with catalog-only error",
    async (agent) => {
      await invokeRun({
        agent,
        prompt: "hello",
        json: false,
        quiet: false,
        verbose: false,
      });
      expect(process.exitCode).toBe(1);
      const joined = stderrLines.join("\n");
      expect(joined).toContain(agent);
      expect(joined).toContain("catalog-only");
    },
  );

  test("JSON mode: error is emitted as a JSON object on stderr", async () => {
    await invokeRun({
      agent: "cline",
      prompt: "do something",
      json: true,
      quiet: false,
      verbose: false,
    });
    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(stderrLines.join("\n"));
    expect(parsed.error).toContain("catalog-only");
    expect(parsed.error).toContain("cline");
  });

  test("unknown agent name still produces an 'Unknown agent' error (not catalog-only)", async () => {
    await invokeRun({
      agent: "definitely-not-a-real-agent-zxyv",
      prompt: "hello",
      json: false,
      quiet: false,
      verbose: false,
    });
    expect(process.exitCode).toBe(1);
    const joined = stderrLines.join("\n");
    expect(joined).toMatch(/Unknown agent/i);
    expect(joined).not.toContain("catalog-only");
  });
});
