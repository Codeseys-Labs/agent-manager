/**
 * M5.1 wiki-sync git primitives (2026-05-03-C).
 *
 * Covers the three additive primitives added to `src/core/git.ts`:
 *   - `pullFastForwardOnly` — FF-only pull; throws `WikiSyncConflictError`
 *     with `conflictedFiles` when the remote has diverged.
 *   - `softResetHead` — rewinds HEAD by one commit and realigns the index so
 *     rolled-back paths don't show as "staged ahead of HEAD" (guards the
 *     2026-05-02 adversarial-review finding that `writeRef` alone leaves
 *     the index stale and could double-commit on retry).
 *   - `stageWikiFiles` — thin `git.add` loop.
 *
 * Remote transport note: isomorphic-git doesn't support the `file://`
 * transport, so the FF-only divergence path is tested by exercising
 * `git.merge({ fastForwardOnly: true })` directly on two local branches
 * — which is exactly the code path inside `pull()` that throws
 * FastForwardError. The translation logic (FastForwardError ->
 * WikiSyncConflictError) is the only wrapper-specific behavior, and a
 * separate test injects the error shape directly to lock that translation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import {
  commitAll,
  initRepo,
  pullFastForwardOnly,
  softResetHead,
  stageWikiFiles,
} from "../../src/core/git.ts";
import { WikiSyncConflictError } from "../../src/lib/errors.ts";

describe("M5.1 wiki-sync git primitives", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "am-wiki-sync-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("stageWikiFiles", () => {
    test("stages the given files, ignores others", async () => {
      await initRepo(dir);
      await writeFile(join(dir, "a.md"), "a");
      await writeFile(join(dir, "b.md"), "b");
      await writeFile(join(dir, "skip.md"), "skip");

      await stageWikiFiles(dir, ["a.md", "b.md"]);
      const matrix = await git.statusMatrix({ fs, dir });
      const staged = matrix.filter(([, , , stage]) => stage === 2).map(([f]) => f);
      expect(staged.sort()).toEqual(["a.md", "b.md"]);
      const notStaged = matrix.find(([f]) => f === "skip.md");
      expect(notStaged?.[3]).toBe(0);
    });

    test("tolerates empty list", async () => {
      await initRepo(dir);
      await stageWikiFiles(dir, []);
      // No throw = pass.
    });
  });

  describe("softResetHead", () => {
    test("throws on initial-commit repo (no parent)", async () => {
      await initRepo(dir);
      // initRepo makes exactly one commit (the .gitignore); no parent.
      await expect(softResetHead(dir)).rejects.toThrow(/no parent commit/);
    });

    test("rewinds HEAD by one commit; preserves workdir file", async () => {
      await initRepo(dir);
      const before = await git.log({ fs, dir, depth: 1 });
      const initialHead = before[0].oid;

      await writeFile(join(dir, "page.md"), "hello");
      await commitAll(dir, "wiki: auto-sync 1 page");

      // Sanity: HEAD advanced, file on disk.
      const after = await git.log({ fs, dir, depth: 1 });
      expect(after[0].oid).not.toBe(initialHead);
      expect(fs.existsSync(join(dir, "page.md"))).toBe(true);

      await softResetHead(dir);

      // HEAD is back at the init commit.
      const final = await git.log({ fs, dir, depth: 1 });
      expect(final[0].oid).toBe(initialHead);
      // Workdir file preserved (that's the point of soft reset).
      expect(fs.existsSync(join(dir, "page.md"))).toBe(true);
      expect(await Bun.file(join(dir, "page.md")).text()).toBe("hello");
    });

    test("2026-05-02 review guard: no staged-ahead-of-HEAD ghosts after reset", async () => {
      // If softResetHead rewrote HEAD but left the index stale, the file
      // added in the rolled-back commit would show as [head=0, stage=2]
      // (index has the file but HEAD doesn't) — equivalent to "staged but
      // unchanged" from the user's perspective. A retry commit would
      // double-apply it. This test fails if resetIndex is removed.
      await initRepo(dir);
      await writeFile(join(dir, "page.md"), "hello");
      await commitAll(dir, "wiki: auto-sync 1 page");

      await softResetHead(dir);

      const matrix = await git.statusMatrix({ fs, dir });
      const pageRow = matrix.find(([f]) => f === "page.md");
      // The page.md file is new (not in the rewound HEAD), workdir has
      // it, and the index MUST be realigned so the path reports as
      // "untracked" [head=0, workdir=2, stage=0] — never [head=0,
      // workdir=2, stage=2] which would be "staged-for-next-commit".
      expect(pageRow).toBeDefined();
      const [, head, workdir, stage] = pageRow as [string, 0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3];
      expect(head).toBe(0);
      expect(workdir).toBe(2);
      expect(stage).toBe(0);
    });
  });

  describe("pullFastForwardOnly (merge-layer simulation)", () => {
    // isomorphic-git lacks the `file://` transport, so we exercise the
    // `git.merge({ fastForwardOnly: true })` code path that `pull()` uses
    // internally. The FastForwardError this throws is the same one
    // `pullFastForwardOnly` translates into `WikiSyncConflictError`.
    test("merge FF-only succeeds when 'theirs' is strictly ahead", async () => {
      await initRepo(dir);
      await writeFile(join(dir, "seed.md"), "seed");
      await commitAll(dir, "seed");
      // Create `theirs` on top of main.
      await git.branch({ fs, dir, ref: "theirs", checkout: false });
      await git.checkout({ fs, dir, ref: "theirs" });
      await writeFile(join(dir, "extra.md"), "extra");
      await commitAll(dir, "theirs advance");
      await git.checkout({ fs, dir, ref: "main" });
      // FF merge should succeed.
      await git.merge({ fs, dir, ours: "main", theirs: "theirs", fastForwardOnly: true });
      const log = await git.log({ fs, dir, depth: 1 });
      expect(log[0].commit.message).toContain("theirs advance");
    });

    test("merge FF-only throws FastForwardError on divergence", async () => {
      await initRepo(dir);
      await writeFile(join(dir, "shared.md"), "baseline");
      await commitAll(dir, "baseline");
      // Branch theirs from baseline, add a commit.
      await git.branch({ fs, dir, ref: "theirs", checkout: false });
      await git.checkout({ fs, dir, ref: "theirs" });
      await writeFile(join(dir, "shared.md"), "from-theirs");
      await commitAll(dir, "theirs edit");
      // Back to main, add a different commit → divergence.
      await git.checkout({ fs, dir, ref: "main" });
      await writeFile(join(dir, "shared.md"), "from-main");
      await commitAll(dir, "main edit");
      // The underlying merge rejects with FastForwardError — the same
      // error `pullFastForwardOnly` catches and translates.
      try {
        await git.merge({ fs, dir, ours: "main", theirs: "theirs", fastForwardOnly: true });
        expect.unreachable("expected FastForwardError");
      } catch (err) {
        expect((err as { name?: string }).name).toBe("FastForwardError");
      }
    });

    test("translates FastForwardError into WikiSyncConflictError with conflictedFiles", async () => {
      // Directly exercise the error-translation logic by shimming
      // isomorphic-git's pull to throw the canonical FastForwardError, then
      // calling pullFastForwardOnly. This is the only per-wrapper behavior
      // — the rest is delegated to upstream.
      await initRepo(dir);
      // Seed a dirty file so statusMatrix has something to report.
      await writeFile(join(dir, "dirty.md"), "unstaged");

      const originalPull = git.pull;
      (git as unknown as { pull: typeof git.pull }).pull = async () => {
        const err = new Error("A simple fast-forward merge was not possible.");
        (err as Error & { name: string; code: string }).name = "FastForwardError";
        (err as Error & { name: string; code: string }).code = "FastForwardError";
        throw err;
      };
      try {
        await pullFastForwardOnly(dir);
        expect.unreachable("expected WikiSyncConflictError");
      } catch (err) {
        expect(err).toBeInstanceOf(WikiSyncConflictError);
        const e = err as WikiSyncConflictError;
        expect(e.code).toBe("WIKI_SYNC_CONFLICT");
        expect(e.suggestion).toContain("am wiki resolve");
        expect(e.conflictedFiles).toContain("dirty.md");
      } finally {
        (git as unknown as { pull: typeof git.pull }).pull = originalPull;
      }
    });

    test("propagates non-FastForward errors unchanged", async () => {
      await initRepo(dir);
      const originalPull = git.pull;
      const sentinel = new Error("network down");
      (sentinel as Error & { code: string }).code = "NetworkError";
      (git as unknown as { pull: typeof git.pull }).pull = async () => {
        throw sentinel;
      };
      try {
        await pullFastForwardOnly(dir);
        expect.unreachable("expected rethrow");
      } catch (err) {
        // Must NOT be wrapped — only FastForward errors translate.
        expect(err).toBe(sentinel);
        expect(err instanceof WikiSyncConflictError).toBe(false);
      } finally {
        (git as unknown as { pull: typeof git.pull }).pull = originalPull;
      }
    });
  });
});
