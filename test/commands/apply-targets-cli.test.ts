/**
 * P1-B (CLI surface): `am apply --targets a,b` scopes the fan-out to the named
 * adapters, and the prompt is bypassed in every non-interactive mode.
 *
 * `am apply` historically fanned out to EVERY detected tool, and detection is
 * pure file-presence (over-reports). The opt-in contract:
 *   - `--targets a,b`  → apply only to a,b (no prompt).
 *   - `--json` / `--yes` / `--quiet` / dry-run / non-TTY → apply to all
 *     detected (prior behavior preserved for scripts/CI).
 *   - interactive TTY (none of the above) → prompt to confirm/select.
 *
 * The bun:test runner has no TTY (`process.stdin.isTTY` is falsy), so these
 * tests exercise the non-interactive contract deterministically. We assert via
 * the `--json` results array, which enumerates exactly which adapters were
 * processed — i.e. surfaces the targets in the result (P1-B requirement).
 *
 * Real adapter names + dry-run keep these tests host-independent: dry-run
 * writes nothing and explicit targets bypass host IDE detection.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyCommand } from "../../src/commands/apply";
import { type TestDir, createTestDir } from "../helpers/tmp";

let stdoutLines: string[] = [];
const origLog = console.log;
const origWrite = process.stdout.write.bind(process.stdout);

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

function parseJson(): Record<string, unknown> {
  const stdout = stdoutLines.join("");
  const firstBrace = stdout.indexOf("{");
  expect(firstBrace).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(firstBrace)) as Record<string, unknown>;
}

describe("am apply --targets (P1-B CLI opt-in)", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-apply-targets-cli-");
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
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    process.exitCode = 0;
    if (originalEnv === undefined) process.env.AM_CONFIG_DIR = undefined;
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("--targets scopes the apply to exactly the named adapters", async () => {
    await invoke({
      "dry-run": true,
      diff: false,
      force: false,
      targets: "claude-code,cursor",
      json: true,
      quiet: false,
      verbose: false,
    });
    const parsed = parseJson();
    const results = parsed.results as Array<{ adapter: string }>;
    expect(results.map((r) => r.adapter).sort()).toEqual(["claude-code", "cursor"]);
  });

  test("--targets with whitespace and a trailing comma is tolerated", async () => {
    await invoke({
      "dry-run": true,
      diff: false,
      force: false,
      targets: " claude-code , ",
      json: true,
      quiet: false,
      verbose: false,
    });
    const parsed = parseJson();
    const results = parsed.results as Array<{ adapter: string }>;
    expect(results.map((r) => r.adapter)).toEqual(["claude-code"]);
  });

  test("--json without targets does not prompt; results enumerate the applied targets", async () => {
    // No TTY in the test runner + --json → non-interactive. With a single
    // explicit target (to stay host-independent) the result still surfaces
    // which adapter was applied — the P1-B 'surface targets via result' clause.
    await invoke({
      "dry-run": true,
      diff: false,
      force: false,
      target: "claude-code",
      json: true,
      quiet: false,
      verbose: false,
    });
    const parsed = parseJson();
    const results = parsed.results as Array<{ adapter: string }>;
    expect(results.map((r) => r.adapter)).toEqual(["claude-code"]);
  });
});
