/**
 * Unit tests for `isNothingToCommitError` helper in src/core/git.ts.
 *
 * Filed under test/commands because that's where the current permission
 * surface allows new files. Logical home is test/core/git.test.ts;
 * move once permissions permit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll, initRepo, isNothingToCommitError } from "../../src/core/git";

describe("isNothingToCommitError", () => {
  test("returns true for Error('Nothing to commit')", () => {
    expect(isNothingToCommitError(new Error("Nothing to commit"))).toBe(true);
  });

  test("returns false for other Error shapes", () => {
    expect(isNothingToCommitError(new Error("permission denied"))).toBe(false);
    expect(isNothingToCommitError(new Error("ENOSPC"))).toBe(false);
    expect(isNothingToCommitError(new Error(""))).toBe(false);
    expect(isNothingToCommitError(new Error("nothing to commit"))).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isNothingToCommitError(null)).toBe(false);
    expect(isNothingToCommitError(undefined)).toBe(false);
    expect(isNothingToCommitError("Nothing to commit")).toBe(false);
    expect(isNothingToCommitError(42)).toBe(false);
    expect(isNothingToCommitError({})).toBe(false);
  });

  test("returns true for the actual error commitAll throws on a clean tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "am-git-nothing-"));
    try {
      await initRepo(dir);
      let caught: unknown;
      try {
        await commitAll(dir, "empty");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isNothingToCommitError(caught)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
