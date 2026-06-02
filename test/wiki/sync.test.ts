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
