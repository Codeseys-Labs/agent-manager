/**
 * TEST-2 (Wave A) — CLI handler-coverage CI guard.
 *
 * The discovery review flagged that several CLI command handlers had no test
 * that actually invokes their `run()` — the per-command tests exercised helper
 * functions or metadata instead. TEST-1 (handler-coverage.test.ts +
 * per-command handler tests) closed that gap for the high-value handlers; this
 * guard keeps it closed.
 *
 * The contract: **every non-fenced subcommand registered in `src/cli.ts` must
 * have at least one `test/commands/**` test that invokes a command/subcommand
 * `run()` from that command's source module.** When a new command is added to
 * `cli.ts` without a handler-run test (or fenced with justification), this test
 * fails — it is the executable version of "write a handler test for every
 * command", wired as a plain `bun:test` so it runs in CI alongside everything
 * else (no separate ci.yml step needed; `bun test test/commands` covers it).
 *
 * How it works:
 *   1. Parse `src/cli.ts` for the `subCommands: { … }` block to enumerate the
 *      registered command names and the module each imports from.
 *   2. Drop fenced entries (servers / interactive UIs / module aliases — see
 *      FENCED below, each with a recorded reason).
 *   3. For every remaining command, scan all `test/commands/**` test files for
 *      one that BOTH imports from that command's module AND invokes a `run()`
 *      handler (`.run(`, `.run?.(`, `.run!(`, the `run(<cmd>)` / `sub(<cmd>)`
 *      helper wrappers, or `resolveRun(<cmd>)`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");
const TEST_COMMANDS_DIR = join(REPO_ROOT, "test", "commands");

/**
 * Commands intentionally exempt from the handler-run requirement, each with a
 * recorded reason. Keep this list SMALL — prefer adding a handler test over
 * fencing. If you fence something, justify it here.
 */
const FENCED: Record<string, string> = {
  // Long-running / blocking processes with no one-shot handler result to
  // assert: the handler starts a server or an event loop and never returns in
  // a unit-test-friendly way. Their non-handler surface (arg parsing, helpers,
  // report builders) is tested separately.
  serve: "starts a long-running Hono HTTP server (event loop, no one-shot result)",
  "mcp-serve": "starts a long-running JSON-RPC-over-stdio server (blocks on stdin)",
  "mcp-superset":
    "drives the long-running superset MCP server; helpers tested in mcp-superset*.test.ts",
  tui: "launches the Silvery/React terminal UI render loop (no headless handler result)",
  // Module aliases: a second cli.ts name pointing at the SAME source module as
  // another (covered) entry. Testing the alias adds nothing.
  agent: "alias of `agents` (same module: commands/agents)",
  acp: "alias of `run` (same module: commands/run)",
};

interface CliEntry {
  name: string;
  module: string; // e.g. "use" for ./commands/use
}

/** Parse the `subCommands: { … }` block of src/cli.ts into name → module. */
function parseCliSubcommands(src: string): CliEntry[] {
  const start = src.indexOf("subCommands:");
  expect(start).toBeGreaterThan(-1);
  // The block ends at the matching closing brace of subCommands. The block is
  // flat (no nested objects), so the first "}," / "}\n  }" after start that
  // closes it is fine; we scan line-by-line until a line that is just `},`.
  const lines = src.slice(start).split("\n");
  const entries: CliEntry[] = [];
  // Each entry looks like:
  //   <name>: () => import("./commands/<module>").then((m) => m.<export>),
  // <name> may be quoted ("mcp-serve") or bare (use).
  const re =
    /^\s*(?:"([^"]+)"|([A-Za-z0-9_]+))\s*:\s*\(\)\s*=>\s*import\("\.\/commands\/([^"]+)"\)/;
  for (const line of lines) {
    if (/^\s*\},?\s*$/.test(line) && entries.length > 0) break; // end of block
    const m = re.exec(line);
    if (m) {
      entries.push({ name: m[1] ?? m[2], module: m[3] });
    }
  }
  return entries;
}

/** Recursively collect every *.test.ts under test/commands. */
function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (ent.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// Matches any of the recognized handler-invocation forms in test source.
const RUN_INVOCATION = /\.run(?:[!?]|\?\.)?\s*\(|\brun\s*\(|\bsub\s*\(|\bresolveRun\s*\(/;

describe("TEST-2: every non-fenced CLI subcommand has a handler-run test", () => {
  const cliSrc = readFileSync(CLI_PATH, "utf-8");
  const entries = parseCliSubcommands(cliSrc);
  const testFiles = collectTestFiles(TEST_COMMANDS_DIR).map((f) => ({
    path: f,
    text: readFileSync(f, "utf-8"),
  }));

  test("cli.ts parsed at least the known core subcommands", () => {
    const names = new Set(entries.map((e) => e.name));
    // Sanity anchors so a broken parser does not silently pass the guard.
    for (const anchor of ["use", "apply", "doctor", "wiki", "secret"]) {
      expect(names.has(anchor)).toBe(true);
    }
    expect(entries.length).toBeGreaterThanOrEqual(20);
  });

  const checked = entries.filter((e) => !(e.name in FENCED));

  for (const entry of checked) {
    test(`\`am ${entry.name}\` (commands/${entry.module}) is exercised by a handler-run test`, () => {
      const importNeedle = `commands/${entry.module}"`;
      const covering = testFiles.filter(
        (f) => f.text.includes(importNeedle) && RUN_INVOCATION.test(f.text),
      );
      expect(
        covering.length,
        `No test under test/commands/ imports from src/commands/${entry.module} AND invokes a run() handler. ` +
          `Add a handler test that drives \`${entry.name}\`'s run(), or fence it in cli-handler-coverage-guard.test.ts with a reason.`,
      ).toBeGreaterThan(0);
    });
  }
});
