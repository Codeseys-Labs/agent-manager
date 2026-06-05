/**
 * M5.2 wiki sync pipeline tests (2026-05-03-C).
 *
 * Focus: the individual pipeline stages and the divergence-rollback path.
 * The full network-backed pull roundtrip is exercised in
 * test/core/git-wiki-sync.test.ts (via the translation-layer shim) because
 * isomorphic-git does not support the `file://` transport for testing.
 *
 * Covered here:
 *   - scanTextForSecrets detects high-signal shapes, ignores placeholders.
 *   - collectDirtyWikiFiles filters by mtime debounce + file extension.
 *   - autoCommitWikiFiles returns early when nothing qualifies.
 *   - autoCommitWikiFiles throws WikiSyncSecretBlockedError on hit when
 *     strictSecretScan is on.
 *   - autoCommitWikiFiles happy path stages + commits wiki pages.
 *   - syncWiki integration: dirty-tree-without-auto-commit rejects.
 *   - syncWiki: WikiSyncConflictError → softResetHead rollback + sidecar.
 *   - syncWiki: clean sync clears a stale sidecar from a prior run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { addRemote, commitAll, initRepo } from "../../src/core/git";
import { WikiSyncConflictError, WikiSyncSecretBlockedError } from "../../src/lib/errors";
import {
  CONFLICT_SIDECAR,
  autoCommitWikiFiles,
  clearConflictSidecar,
  collectDirtyWikiFiles,
  scanTextForSecrets,
  syncWiki,
  writeConflictSidecar,
} from "../../src/wiki/sync";

/**
 * Stomp file mtimes safely into the past so debounce-filtered collectors
 * (collectDirtyWikiFiles) include them deterministically. Avoids the macOS
 * flake where a file stat'd just after write reports an mtime fractionally
 * ahead of a `Date.now()` cutoff sampled a moment earlier.
 */
function backdate(dir: string, ...files: string[]): void {
  const past = Date.now() - 120_000;
  for (const f of files) {
    fs.utimesSync(join(dir, f), new Date(past), new Date(past));
  }
}

describe("M5.2 scanTextForSecrets", () => {
  test("detects PEM headers", () => {
    const hits = scanTextForSecrets("a.md", "-----BEGIN RSA PRIVATE KEY-----\nabc\n");
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("pem-private-key");
  });

  test("detects GitHub tokens", () => {
    const hits = scanTextForSecrets("a.md", "my token: ghp_abcdefghijklmnopqrst123");
    expect(hits).toHaveLength(1);
    expect(hits[0].pattern).toBe("github-token");
  });

  test("detects OpenAI tokens", () => {
    const hits = scanTextForSecrets("a.md", "sk-abcdefghijklmnopqrst1234567890");
    expect(hits[0].pattern).toBe("openai-token");
  });

  test("detects AWS access keys", () => {
    const hits = scanTextForSecrets("a.md", "access key: AKIAIOSFODNN7EXAMPLE");
    expect(hits[0].pattern).toBe("aws-access-key");
  });

  test("ignores generic-api-key when ${VAR} placeholder is present", () => {
    // Doc pages that teach the user how to write ${FOO} should not alarm.
    const hits = scanTextForSecrets(
      "a.md",
      "To configure, set api_key = ${FOO_API_KEY_XXXX_PLACEHOLDER}",
    );
    expect(hits.filter((h) => h.pattern === "generic-api-key-assignment")).toHaveLength(0);
  });

  test("ignores YOUR_KEY_HERE placeholder", () => {
    const hits = scanTextForSecrets("a.md", 'api_key: "YOUR_API_KEY_HERE_NOW"');
    expect(hits.filter((h) => h.pattern === "generic-api-key-assignment")).toHaveLength(0);
  });

  test("returns [] for clean markdown", () => {
    const hits = scanTextForSecrets(
      "guide.md",
      "# Guide\n\nThis page documents how to use the wiki.",
    );
    expect(hits).toHaveLength(0);
  });
});

describe("M5.2 collectDirtyWikiFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "am-m52-dirty-"));
    await initRepo(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns [] on a clean tree", async () => {
    const files = await collectDirtyWikiFiles(dir, 60);
    expect(files).toEqual([]);
  });

  test("only returns .md/.toml files", async () => {
    await writeFile(join(dir, "a.md"), "wiki");
    await writeFile(join(dir, "binary.png"), "not markdown");
    // Stomp mtime to simulate an older edit.
    const past = Date.now() - 120_000;
    fs.utimesSync(join(dir, "a.md"), new Date(past), new Date(past));
    fs.utimesSync(join(dir, "binary.png"), new Date(past), new Date(past));
    const files = await collectDirtyWikiFiles(dir, 60);
    expect(files.sort()).toEqual(["a.md"]);
  });

  test("respects debounce — recent edits are skipped", async () => {
    await writeFile(join(dir, "recent.md"), "wiki");
    // No mtime stomp → file appears fresh → skipped at debounce=60.
    const files = await collectDirtyWikiFiles(dir, 60);
    expect(files).toEqual([]);
  });

  test("includes old edits past debounce", async () => {
    await writeFile(join(dir, "old.md"), "wiki");
    const past = Date.now() - 120_000;
    fs.utimesSync(join(dir, "old.md"), new Date(past), new Date(past));
    const files = await collectDirtyWikiFiles(dir, 60);
    expect(files).toContain("old.md");
  });
});

describe("M5.2 autoCommitWikiFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "am-m52-commit-"));
    await initRepo(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns committed=false when nothing dirty", async () => {
    const res = await autoCommitWikiFiles(dir, { debounceSeconds: 0 });
    expect(res.committed).toBe(false);
    expect(res.files).toEqual([]);
  });

  test("commits qualifying files with a N-page message", async () => {
    await writeFile(join(dir, "a.md"), "one");
    await writeFile(join(dir, "b.md"), "two");
    // Backdate mtime so the files are unambiguously past the debounce cutoff.
    // collectDirtyWikiFiles skips files whose mtime is NEWER than now - debounce;
    // with debounceSeconds:0 the cutoff is `now`, and a file stat'd microseconds
    // after write can report an mtime fractionally ahead of the sampled `now`
    // (mtime resolution / clock skew on macOS APFS), intermittently excluding it.
    // Stomping mtime to the past removes the race (matches the pattern used by
    // the collectDirtyWikiFiles tests above).
    backdate(dir, "a.md", "b.md");
    const res = await autoCommitWikiFiles(dir, { debounceSeconds: 0 });
    expect(res.committed).toBe(true);
    expect(res.files.sort()).toEqual(["a.md", "b.md"]);
    const log = await git.log({ fs, dir, depth: 1 });
    expect(log[0].commit.message).toContain("wiki: auto-sync 2 pages");
  });

  test("throws WikiSyncSecretBlockedError on tier-1 hit", async () => {
    await writeFile(join(dir, "leak.md"), "token: ghp_abcdefghijklmnopqrst123");
    // Backdate so the file isn't debounce-skipped before the secret scan runs
    // (else autoCommit returns committed:false instead of throwing — flaky on macOS).
    backdate(dir, "leak.md");
    await expect(
      autoCommitWikiFiles(dir, { debounceSeconds: 0, strictSecretScan: true }),
    ).rejects.toBeInstanceOf(WikiSyncSecretBlockedError);
  });

  test("does NOT commit when strict scan triggers", async () => {
    await writeFile(join(dir, "leak.md"), "token: ghp_abcdefghijklmnopqrst123");
    backdate(dir, "leak.md");
    const logBefore = await git.log({ fs, dir, depth: 1 });
    try {
      await autoCommitWikiFiles(dir, { debounceSeconds: 0, strictSecretScan: true });
    } catch {
      // expected
    }
    const logAfter = await git.log({ fs, dir, depth: 1 });
    expect(logAfter[0].oid).toBe(logBefore[0].oid);
  });
});

describe("M5.2 conflict sidecar + syncWiki rollback", () => {
  let dir: string;
  const originalPull = git.pull;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "am-m52-sync-"));
    await initRepo(dir);
    await addRemote(dir, "https://example.com/fake.git");
  });
  afterEach(async () => {
    (git as unknown as { pull: typeof git.pull }).pull = originalPull;
    await rm(dir, { recursive: true, force: true });
  });

  test("dirty tree without auto-commit + without allow-dirty throws", async () => {
    await writeFile(join(dir, "a.md"), "edit");
    const past = Date.now() - 120_000;
    fs.utimesSync(join(dir, "a.md"), new Date(past), new Date(past));
    await expect(
      syncWiki(dir, { direction: "pull", autoCommit: false, allowDirty: false }),
    ).rejects.toThrow(/dirty/);
  });

  test("auto-commits, then writes conflict sidecar + rolls back on divergence", async () => {
    // Seed a dirty wiki page and backdate it past the debounce.
    await writeFile(join(dir, "page.md"), "local edit");
    const past = Date.now() - 120_000;
    fs.utimesSync(join(dir, "page.md"), new Date(past), new Date(past));

    // Stub pull() to throw a FastForwardError → pullFastForwardOnly
    // translates into WikiSyncConflictError.
    (git as unknown as { pull: typeof git.pull }).pull = async () => {
      const e = new Error("A simple fast-forward merge was not possible.");
      (e as Error & { name: string; code: string }).name = "FastForwardError";
      (e as Error & { name: string; code: string }).code = "FastForwardError";
      throw e;
    };

    const logBefore = await git.log({ fs, dir, depth: 1 });
    const initialOid = logBefore[0].oid;

    const result = await syncWiki(dir, {
      direction: "pull",
      autoCommit: true,
      allowDirty: false,
      debounceSeconds: 0,
    });

    // Sidecar written.
    expect(result.sidecarWritten).toBe(join(dir, CONFLICT_SIDECAR));
    expect(fs.existsSync(join(dir, CONFLICT_SIDECAR))).toBe(true);

    // Auto-commit was recorded...
    const commitAction = result.actions.find((a) => a.action === "auto-commit");
    expect(commitAction?.ok).toBe(true);

    // ...pull failed with the divergence message...
    const pullAction = result.actions.find((a) => a.action === "pull");
    expect(pullAction?.ok).toBe(false);
    expect(pullAction?.error).toContain("fast-forward-only");

    // ...and rollback fired: HEAD is back at the initial commit.
    const rollback = result.actions.find((a) => a.action === "rollback");
    expect(rollback?.ok).toBe(true);
    const logAfter = await git.log({ fs, dir, depth: 1 });
    expect(logAfter[0].oid).toBe(initialOid);

    // Workdir file is preserved.
    expect(fs.existsSync(join(dir, "page.md"))).toBe(true);
    expect(await Bun.file(join(dir, "page.md")).text()).toBe("local edit");
  });

  test("writeConflictSidecar + clearConflictSidecar are complementary", async () => {
    await writeConflictSidecar(dir, {
      timestamp: "2026-05-03T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["a.md"],
    });
    expect(fs.existsSync(join(dir, CONFLICT_SIDECAR))).toBe(true);
    await clearConflictSidecar(dir);
    expect(fs.existsSync(join(dir, CONFLICT_SIDECAR))).toBe(false);
    // Second clear is a no-op.
    await clearConflictSidecar(dir);
  });

  test("WikiSyncConflictError is properly translated in the pipeline", async () => {
    // Direct unit check: the error shape consumed by syncWiki matches the
    // one thrown by pullFastForwardOnly.
    const e = new WikiSyncConflictError(["a.md", "b.md"]);
    expect(e.name).toBe("WikiSyncConflictError");
    expect(e.code).toBe("WIKI_SYNC_CONFLICT");
    expect(e.conflictedFiles).toEqual(["a.md", "b.md"]);
  });
});

/**
 * R-TEST3 — previously-untested syncWiki branches:
 *   - the PUSH branch records {action:'push', ok:false} WITHOUT throwing when
 *     gitPush fails,
 *   - the direction:'both' / 'commit-and-sync' pipeline (auto-commit → pull →
 *     push) with stale-sidecar clearing on success,
 *   - the rollback-FAILURE sub-branch: softResetHead itself throws →
 *     {action:'rollback', ok:false} is recorded (not rethrown).
 *
 * Seam note: src/wiki/sync.ts has no DI seam for gitPush/pullFastForwardOnly/
 * softResetHead — they are static imports from ../core/git. Rather than
 * mock.module("../core/git", ...) (process-global in Bun, NOT undone by
 * mock.restore(), leaks into later files), we stub the underlying isomorphic-git
 * methods (git.push / git.pull / git.log) by per-object property assignment and
 * restore the originals in afterEach. This is the same leak-free pattern the
 * rollback-success test above already uses for git.pull. Each git wrapper used
 * by the parts of the pipeline we DON'T want to perturb (commitAll, getStatus,
 * collectDirtyWikiFiles) avoids git.log, so stubbing git.log to force a
 * softResetHead failure does not disturb auto-commit.
 */
describe("R-TEST3 syncWiki push / both / rollback-failure branches", () => {
  let dir: string;
  const originalPull = git.pull;
  const originalPush = git.push;
  const originalLog = git.log;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "am-rtest3-sync-"));
    await initRepo(dir);
    await addRemote(dir, "https://example.com/fake.git");
  });
  afterEach(async () => {
    (git as unknown as { pull: typeof git.pull }).pull = originalPull;
    (git as unknown as { push: typeof git.push }).push = originalPush;
    (git as unknown as { log: typeof git.log }).log = originalLog;
    await rm(dir, { recursive: true, force: true });
  });

  function stubPush(impl: () => Promise<unknown>): void {
    (git as unknown as { push: (...a: unknown[]) => Promise<unknown> }).push = impl;
  }
  function stubPull(impl: () => Promise<unknown>): void {
    (git as unknown as { pull: (...a: unknown[]) => Promise<unknown> }).pull = impl;
  }

  test("push failure → records {action:'push', ok:false} without throwing", async () => {
    stubPush(async () => {
      throw new Error("remote rejected: 403 forbidden");
    });

    // direction:'push' skips pull; goes straight to the push branch.
    const result = await syncWiki(dir, {
      direction: "push",
      autoCommit: false,
      allowDirty: true,
    });

    const push = result.actions.find((a) => a.action === "push");
    expect(push).toBeDefined();
    expect(push?.ok).toBe(false);
    expect(push?.error).toContain("403 forbidden");
    // syncWiki itself resolved (push failure is recorded, not fatal).
    expect(result.wikiDir).toBe(dir);
  });

  test("direction:'both' runs auto-commit → pull → push and clears a stale sidecar on success", async () => {
    // Pre-seed a stale conflict sidecar from a hypothetical prior run; a clean
    // sync must clear it.
    await writeConflictSidecar(dir, {
      timestamp: "2026-01-01T00:00:00Z",
      remote: "origin",
      conflictedFiles: ["old.md"],
    });
    expect(fs.existsSync(join(dir, CONFLICT_SIDECAR))).toBe(true);

    // Dirty wiki page, backdated past the debounce so auto-commit picks it up.
    await writeFile(join(dir, "note.md"), "fresh local note");
    const past = Date.now() - 120_000;
    fs.utimesSync(join(dir, "note.md"), new Date(past), new Date(past));

    // Pull = clean fast-forward (no-op resolve); push succeeds.
    stubPull(async () => undefined);
    stubPush(async () => undefined);

    const result = await syncWiki(dir, {
      direction: "both",
      autoCommit: true,
      allowDirty: false,
      debounceSeconds: 0,
    });

    // All three stages recorded as ok.
    const ac = result.actions.find((a) => a.action === "auto-commit");
    const pull = result.actions.find((a) => a.action === "pull");
    const push = result.actions.find((a) => a.action === "push");
    expect(ac?.ok).toBe(true);
    expect(ac?.files).toContain("note.md");
    expect(pull?.ok).toBe(true);
    expect(push?.ok).toBe(true);

    // Stale sidecar cleared on the clean-sync exit, and no new one written.
    expect(result.sidecarWritten).toBeUndefined();
    expect(fs.existsSync(join(dir, CONFLICT_SIDECAR))).toBe(false);
  });

  test("direction:'commit-and-sync' behaves like 'both' (auto-commit → pull → push)", async () => {
    await writeFile(join(dir, "cas.md"), "commit-and-sync note");
    const past = Date.now() - 120_000;
    fs.utimesSync(join(dir, "cas.md"), new Date(past), new Date(past));

    stubPull(async () => undefined);
    let pushed = false;
    stubPush(async () => {
      pushed = true;
    });

    const result = await syncWiki(dir, {
      direction: "commit-and-sync",
      autoCommit: true,
      allowDirty: false,
      debounceSeconds: 0,
    });

    expect(result.actions.find((a) => a.action === "auto-commit")?.ok).toBe(true);
    expect(result.actions.find((a) => a.action === "pull")?.ok).toBe(true);
    expect(result.actions.find((a) => a.action === "push")?.ok).toBe(true);
    expect(pushed).toBe(true);
  });

  test("rollback FAILURE: softResetHead throws → records {action:'rollback', ok:false}", async () => {
    // Dirty wiki page that auto-commits successfully (commitAll does not use
    // git.log, so the git.log stub below does not disturb it).
    await writeFile(join(dir, "diverge.md"), "local edit");
    const past = Date.now() - 120_000;
    fs.utimesSync(join(dir, "diverge.md"), new Date(past), new Date(past));

    // Pull diverges → WikiSyncConflictError → triggers the rollback path.
    stubPull(async () => {
      const e = new Error("A simple fast-forward merge was not possible.") as Error & {
        name: string;
        code: string;
      };
      e.name = "FastForwardError";
      e.code = "FastForwardError";
      throw e;
    });

    // softResetHead's FIRST git call is git.log({depth:2}). Make it throw so
    // the rollback sub-branch hits its catch and records ok:false (instead of
    // rethrowing or recording ok:true).
    (git as unknown as { log: (...a: unknown[]) => Promise<unknown> }).log = async () => {
      throw new Error("git.log boom — cannot read parent commit");
    };

    const result = await syncWiki(dir, {
      direction: "pull",
      autoCommit: true,
      allowDirty: false,
      debounceSeconds: 0,
    });

    // Auto-commit ran...
    expect(result.actions.find((a) => a.action === "auto-commit")?.ok).toBe(true);

    // ...rollback was attempted and FAILED (recorded, not thrown).
    const rollback = result.actions.find((a) => a.action === "rollback");
    expect(rollback).toBeDefined();
    expect(rollback?.ok).toBe(false);
    expect(rollback?.error).toContain("git.log boom");

    // The conflict sidecar is still written despite the rollback failure, and
    // its path is returned to the caller.
    expect(result.sidecarWritten).toBe(join(dir, CONFLICT_SIDECAR));
    expect(fs.existsSync(join(dir, CONFLICT_SIDECAR))).toBe(true);

    // The pull divergence is also recorded ok:false.
    const pull = result.actions.find((a) => a.action === "pull" && a.ok === false);
    expect(pull?.error).toContain("fast-forward-only");
  });
});
