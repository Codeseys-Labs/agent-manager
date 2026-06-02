import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Regression guard for the Windows env-coercion footgun.
 *
 * Assigning `undefined` to an environment variable does NOT delete it — on
 * Windows (and per the ECMAScript env-coercion semantics Bun mirrors) the value
 * is coerced to the STRING "undefined", which poisons the shared process for
 * every subsequent test that reads that variable. The established repo pattern
 * for unsetting an env var is:
 *
 *     Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
 *
 * This test scans the `src/` and `test/` trees and fails if any
 * `process.env.<NAME> = undefined` (dot- or bracket-access) assignment
 * reappears, excluding occurrences inside comments. See Wave F-ENVSWEEP.
 */

// test/lint/ -> repo root is two directories up.
const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCAN_DIRS = ["src", "test"];

// Directories we never want to walk into.
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

// Don't scan this guard file itself — it intentionally documents the pattern.
const SELF = join(import.meta.dir, "no-env-undefined.test.ts");

function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        walk(full);
      } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Remove `//` line comments and `/* … *\/` block comments so the offending-code
 * detector never trips on prose that documents the footgun.
 */
function stripComments(src: string): string {
  // Block comments first (non-greedy, across newlines).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Then line comments.
  out = out.replace(/\/\/.*$/gm, "");
  return out;
}

// Matches `process.env.NAME = undefined` and `process.env["NAME"] = undefined`
// (and single-quoted bracket form). Whitespace-tolerant around `=`.
const OFFENDING = /process\.env(?:\.[A-Za-z_$][\w$]*|\[\s*["'][^"']*["']\s*\])\s*=\s*undefined\b/g;

describe("env-coercion footgun guard", () => {
  test("no `process.env.X = undefined` assignments in src/ or test/", () => {
    const offenders: string[] = [];

    for (const dirName of SCAN_DIRS) {
      const files = collectSourceFiles(join(REPO_ROOT, dirName));
      for (const file of files) {
        if (file === SELF) continue;
        const raw = readFileSync(file, "utf8");
        const code = stripComments(raw);
        if (!OFFENDING.test(code)) continue;
        // Re-scan the raw lines to report precise, human-useful locations.
        const rawLines = raw.split("\n");
        const codeLines = code.split("\n");
        for (let i = 0; i < codeLines.length; i++) {
          OFFENDING.lastIndex = 0;
          if (OFFENDING.test(codeLines[i] ?? "")) {
            const rel = relative(REPO_ROOT, file);
            offenders.push(`${rel}:${i + 1}: ${(rawLines[i] ?? "").trim()}`);
          }
        }
        OFFENDING.lastIndex = 0;
      }
    }

    if (offenders.length > 0) {
      const hint =
        'Use `Reflect.deleteProperty(process.env, "NAME")` to unset an env var. ' +
        'Assigning `undefined` coerces to the STRING "undefined" and poisons the ' +
        "shared process (Windows env-coercion footgun).";
      throw new Error(
        `Found ${offenders.length} bare \`process.env.X = undefined\` assignment(s):\n` +
          `${offenders.map((o) => `  - ${o}`).join("\n")}\n\n${hint}`,
      );
    }

    expect(offenders).toHaveLength(0);
  });
});
