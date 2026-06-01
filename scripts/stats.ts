#!/usr/bin/env bun
/**
 * Regenerate the project-stats table in README.md (and print a summary).
 *
 * The audit (docs/audit/assessment-2026-05-31) found four mutually-contradictory
 * hand-maintained stat tables across README/ROADMAP/CLAUDE/AGENTS. This script is
 * the single source of truth: it counts the real numbers and rewrites the block
 * delimited by <!-- stats:start --> / <!-- stats:end --> in README.md.
 *
 * Test/assertion counts come from the authoritative `bun test` summary (the
 * runtime count differs from a static grep because of `it.each` / programmatic
 * tests). Pass --fast to skip the suite and use a static lower-bound estimate.
 *
 * Usage:
 *   bun run scripts/stats.ts            # run suite, rewrite README.md stats block
 *   bun run scripts/stats.ts --fast     # static estimate, no test run (quick)
 *   bun run scripts/stats.ts --check    # exit 1 if README static metrics are stale (CI)
 *   bun run scripts/stats.ts --json     # print computed stats as JSON
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FAST = process.argv.includes("--fast") || process.argv.includes("--check");

function walk(dir: string, match: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, match));
    else if (match(full)) out.push(full);
  }
  return out;
}

function countTestCases(files: string[]): { tests: number; assertions: number } {
  let tests = 0;
  let assertions = 0;
  const testRe = /^\s*(it|test)(\.(skip|only|todo|each\([^)]*\)))?\s*\(/gm;
  const expectRe = /\bexpect\s*\(/g;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    tests += (src.match(testRe) ?? []).length;
    assertions += (src.match(expectRe) ?? []).length;
  }
  return { tests, assertions };
}

const srcFiles = walk(join(ROOT, "src"), (p) => p.endsWith(".ts") || p.endsWith(".tsx"));
const testFiles = walk(join(ROOT, "test"), (p) => p.endsWith(".test.ts"));
const adrFiles = readdirSync(join(ROOT, "ADRs")).filter((f) => /^\d{4}[a-z]?-.*\.md$/.test(f));

// CLI subcommands: keys inside the `subCommands: { ... }` block of src/cli.ts
const cli = readFileSync(join(ROOT, "src/cli.ts"), "utf8");
const subBlock = cli.slice(cli.indexOf("subCommands:"));
const cliCommands = new Set(
  [...subBlock.matchAll(/^\s+"?([a-z][a-zA-Z0-9_-]*)"?:\s*\(\)\s*=>/gm)].map((m) => m[1]),
).size;

function runtimeTestCounts(): { tests: number; assertions: number } | null {
  try {
    const proc = Bun.spawnSync(["bun", "test"], { cwd: ROOT, stderr: "pipe", stdout: "pipe" });
    const text = `${proc.stdout?.toString() ?? ""}\n${proc.stderr?.toString() ?? ""}`;
    const ran = text.match(/Ran (\d+) tests across \d+ files/);
    const exp = text.match(/(\d+)\s+expect\(\) calls/);
    if (ran)
      return {
        tests: Number(ran[1]),
        assertions: exp ? Number(exp[1]) : countTestCases(testFiles).assertions,
      };
  } catch {
    /* fall through to static estimate */
  }
  return null;
}

// In --fast/--check mode we must NOT run the suite, but the static grep
// undercounts (it.each / programmatic tests). So reuse the test/assertion
// numbers already in the README and only validate the structural metrics.
function readmeTestNumbers(): { tests: number; assertions: number } | null {
  try {
    const r = readFileSync(join(ROOT, "README.md"), "utf8");
    const t = r.match(/\| Tests \| ([\d,]+) \|/);
    const a = r.match(/\| Assertions \| ([\d,]+) \|/);
    if (t && a)
      return { tests: Number(t[1].replace(/,/g, "")), assertions: Number(a[1].replace(/,/g, "")) };
  } catch {
    /* ignore */
  }
  return null;
}

const { tests, assertions } = FAST
  ? (readmeTestNumbers() ?? countTestCases(testFiles))
  : (runtimeTestCounts() ?? countTestCases(testFiles));

const stats = {
  sourceFiles: srcFiles.length,
  testFiles: testFiles.length,
  tests,
  assertions,
  ideAdapters: "13 (+community)",
  platformAdapters: 3,
  cliCommands,
  mcpTools: "38 (33 active + 5 deprecated aliases)",
  adrs: adrFiles.length,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

const fmt = (n: number) => n.toLocaleString("en-US");
const table = [
  "<!-- stats:start -->",
  "| Metric | Count |",
  "|--------|-------|",
  `| Source files | ${stats.sourceFiles} |`,
  `| Test files | ${stats.testFiles} |`,
  `| Tests | ${fmt(stats.tests)} |`,
  `| Assertions | ${fmt(stats.assertions)} |`,
  `| IDE adapters | ${stats.ideAdapters} |`,
  `| Platform adapters | ${stats.platformAdapters} |`,
  `| CLI commands | ${stats.cliCommands} |`,
  `| MCP tools | ${stats.mcpTools} |`,
  `| ADRs | ${stats.adrs} |`,
  "<!-- stats:end -->",
].join("\n");

const readmePath = join(ROOT, "README.md");
const readme = readFileSync(readmePath, "utf8");
const blockRe = /<!-- stats:start -->[\s\S]*?<!-- stats:end -->/;
if (!blockRe.test(readme)) {
  console.error("stats: no <!-- stats:start --> ... <!-- stats:end --> block found in README.md");
  process.exit(2);
}
const updated = readme.replace(blockRe, table);

if (process.argv.includes("--check")) {
  if (updated !== readme) {
    console.error("stats: README.md is out of date. Run `bun run scripts/stats.ts` to regenerate.");
    process.exit(1);
  }
  console.log("stats: README.md is up to date.");
  process.exit(0);
}

writeFileSync(readmePath, updated);
console.log("stats: README.md updated.");
console.log(JSON.stringify(stats, null, 2));
