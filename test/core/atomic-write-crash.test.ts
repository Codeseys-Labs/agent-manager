/**
 * Real crash-mid-write test for atomicWriteFileSync.
 *
 * The existing atomic-write.test.ts has a "cleans up tmp file on rename
 * failure" test that only exercises the error path in the same process.
 * It never kills a process mid-write, which is the scenario atomic writes
 * exist to survive.
 *
 * Approach: spawn a Bun child that writes to a target in a tight loop with
 * a rotating payload (A*N or B*N). Parent SIGKILLs the child at a random
 * moment. On restart, the target file must either:
 *  - still hold the previous valid payload, or
 *  - hold the new valid payload,
 * never a truncated / mixed / zero-length / non-existent (once first write
 * succeeded) state.
 *
 * This is the end-to-end guarantee atomic writes provide, and nothing in
 * the original test suite actually verifies it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExe } from "../helpers/bun-exe";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "am-atomic-crash-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function validPayload(s: string): boolean {
  // Payloads are either 'A'.repeat(N) or 'B'.repeat(N) for a fixed set of
  // known lengths. A torn write would produce a substring/prefix like "AAAB"
  // or zero-length content.
  if (s.length === 0) return false;
  const first = s[0];
  if (first !== "A" && first !== "B") return false;
  for (let i = 1; i < s.length; i++) {
    if (s[i] !== first) return false;
  }
  return true;
}

describe("atomicWriteFileSync under subprocess crash", () => {
  test("SIGKILL mid-write never leaves target in torn state", async () => {
    const target = join(dir, "target.txt");
    const writerScript = join(dir, "writer.ts");
    // A child that writes alternating payloads to `target` as fast as
    // possible. The parent will SIGKILL it at a random time.
    writeFileSync(
      writerScript,
      `
        import { atomicWriteFileSync } from "${join(process.cwd(), "src/core/atomic-write.ts").replace(/\\/g, "/")}";
        const target = process.argv[2];
        let iter = 0;
        while (true) {
          const ch = iter % 2 === 0 ? "A" : "B";
          const len = 1024 + (iter % 8) * 256;
          atomicWriteFileSync(target, ch.repeat(len));
          iter++;
        }
      `,
    );

    // Seed the target with a known-good payload so "not yet written" is
    // distinguishable from "corrupted".
    writeFileSync(target, "A".repeat(100));
    expect(validPayload(readFileSync(target, "utf-8"))).toBe(true);

    const ITERATIONS = 5;
    for (let i = 0; i < ITERATIONS; i++) {
      const proc = Bun.spawn([bunExe(), writerScript, target], {
        stdout: "ignore",
        stderr: "ignore",
      });
      // Random delay 5-40ms gives the child time to do hundreds of writes,
      // so SIGKILL hits at essentially a uniform random moment relative to
      // the atomic sequence.
      const delay = 5 + Math.floor(Math.random() * 35);
      await new Promise((r) => setTimeout(r, delay));
      proc.kill("SIGKILL");
      await proc.exited;

      // Target must exist AND contain a valid payload.
      expect(existsSync(target)).toBe(true);
      const contents = readFileSync(target, "utf-8");
      if (!validPayload(contents)) {
        throw new Error(
          `Torn write detected on iteration ${i}: ${contents.slice(0, 20)}... (length ${contents.length})`,
        );
      }
    }
  }, 30000);
});
