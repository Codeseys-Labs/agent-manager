import * as fs from "node:fs";
import { join } from "node:path";
import git from "isomorphic-git";
import { WikiSyncConflictError } from "../lib/errors.ts";

const DEFAULT_AUTHOR = { name: "agent-manager", email: "am@localhost" };

const GITIGNORE_ENTRIES = [
  "config.local.toml",
  ".agent-manager/state.toml",
  // Legacy key locations — the master key now lives in the OS data dir (see
  // `resolveKeyPath` in src/core/secrets.ts and SECURITY.md). These entries
  // defensively ignore any stray file that lands back in the config dir
  // (e.g. from an old migration, a manual copy, or a downgraded install).
  ".agent-manager/key.txt",
  ".agent-manager/key",
  ".agent-manager/key.*",
  "**/key.txt",
];

export async function initRepo(dir: string): Promise<void> {
  await git.init({ fs, dir, defaultBranch: "main" });
  await fs.promises.mkdir(join(dir, ".agent-manager"), { recursive: true });
  await fs.promises.writeFile(join(dir, ".gitignore"), `${GITIGNORE_ENTRIES.join("\n")}\n`);
  await git.add({ fs, dir, filepath: ".gitignore" });
  await git.commit({
    fs,
    dir,
    message: "init: agent-manager repository",
    author: DEFAULT_AUTHOR,
  });
}

/**
 * Detect the benign "Nothing to commit" error thrown by `commitAll` when the
 * working tree is clean. Call sites should swallow only this shape and
 * rethrow / warn on anything else (permission, lock, ENOSPC, corrupt repo).
 */
export function isNothingToCommitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === "string" && msg === "Nothing to commit";
}

export async function commitAll(dir: string, message: string): Promise<string> {
  const matrix = await git.statusMatrix({ fs, dir });

  // Stage everything first — git.add forces a content hash check that
  // bypasses isomorphic-git's stat-based index cache.
  for (const [filepath, _head, workdir, _stage] of matrix) {
    if (workdir === 0) {
      await git.remove({ fs, dir, filepath });
    } else {
      await git.add({ fs, dir, filepath });
    }
  }

  // Re-read the matrix after staging to detect real changes
  const staged = await git.statusMatrix({ fs, dir });
  const hasChanges = staged.some(([_f, head, _workdir, stage]) => !(head === 1 && stage === 1));

  if (!hasChanges) {
    throw new Error("Nothing to commit");
  }

  return git.commit({ fs, dir, message, author: DEFAULT_AUTHOR });
}

export async function push(dir: string, remote = "origin", branch?: string): Promise<void> {
  const ref = branch ?? (await git.currentBranch({ fs, dir })) ?? "main";
  await git.push({
    fs,
    http: (await import("isomorphic-git/http/node")).default,
    dir,
    remote,
    ref,
  });
}

export async function pull(dir: string, remote = "origin", branch?: string): Promise<void> {
  const ref = branch ?? (await git.currentBranch({ fs, dir })) ?? "main";
  await git.pull({
    fs,
    http: (await import("isomorphic-git/http/node")).default,
    dir,
    remote,
    ref,
    author: DEFAULT_AUTHOR,
  });
}

/**
 * Outcome of `bestEffortPull` — used by `am pair finalize` (autodetect)
 * to mirror the dispatch's "requires git pull integration" gate
 * without making a transient network failure fatal.
 */
export type BestEffortPullResult =
  | { kind: "no-repo" }
  | { kind: "no-remote" }
  | { kind: "ok" }
  | { kind: "failed"; message: string };

/**
 * Best-effort `git pull` against `origin/<currentBranch>`. Designed for
 * advisory pulls (e.g. before scanning `recipients/*.pub`) where:
 *   - no git repo at `dir` → silent skip
 *   - no remote configured → silent skip
 *   - pull failure (network, auth, conflict) → caller reports a warning
 *     and continues with local-only state
 *
 * Never throws; returns a discriminated result so the caller can decide
 * how to surface each outcome.
 */
export async function bestEffortPull(
  dir: string,
  remote = "origin",
): Promise<BestEffortPullResult> {
  let remotes: Awaited<ReturnType<typeof git.listRemotes>>;
  try {
    remotes = await git.listRemotes({ fs, dir });
  } catch {
    return { kind: "no-repo" };
  }
  if (!remotes.some((r) => r.remote === remote)) {
    return { kind: "no-remote" };
  }
  try {
    await pull(dir, remote);
    return { kind: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "failed", message };
  }
}

export interface LogEntry {
  oid: string;
  message: string;
  author: { name: string; email: string; timestamp: number };
}

export async function log(dir: string, count?: number): Promise<LogEntry[]> {
  const commits = await git.log({ fs, dir, depth: count });
  return commits.map((c) => ({
    oid: c.oid,
    message: c.commit.message.trim(),
    author: {
      name: c.commit.author.name,
      email: c.commit.author.email,
      timestamp: c.commit.author.timestamp,
    },
  }));
}

export async function revertHead(dir: string): Promise<string> {
  const commits = await git.log({ fs, dir, depth: 2 });
  if (commits.length < 2) {
    throw new Error("Cannot revert: no parent commit");
  }

  const parentOid = commits[1].oid;
  const headMessage = commits[0].commit.message.trim();

  // Read every file from the parent tree and write it to the workdir,
  // then stage the result. We use TREE to walk the parent and HEAD to diff.
  // Strategy: checkout the parent tree contents into workdir.
  const parentTree = commits[1].commit.tree;
  const headTree = commits[0].commit.tree;

  // Get files in parent commit
  const parentFiles = await listTreeFiles(dir, parentOid);
  // Get files in HEAD commit
  const headFiles = await listTreeFiles(dir, commits[0].oid);

  // Write all parent files to workdir
  for (const filepath of parentFiles) {
    const { blob } = await git.readBlob({
      fs,
      dir,
      oid: parentOid,
      filepath,
    });
    const fullPath = join(dir, filepath);
    await fs.promises.mkdir(join(fullPath, ".."), { recursive: true });
    await fs.promises.writeFile(fullPath, Buffer.from(blob));
    await git.add({ fs, dir, filepath });
  }

  // Remove files that existed in HEAD but not in parent
  for (const filepath of headFiles) {
    if (!parentFiles.includes(filepath)) {
      const fullPath = join(dir, filepath);
      try {
        await fs.promises.unlink(fullPath);
      } catch {
        // File may already be gone
      }
      await git.remove({ fs, dir, filepath });
    }
  }

  return git.commit({
    fs,
    dir,
    message: `revert: ${headMessage}`,
    author: DEFAULT_AUTHOR,
  });
}

async function listTreeFiles(dir: string, oid: string): Promise<string[]> {
  const files: string[] = [];
  await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: oid })],
    map: async (filepath, [entry]) => {
      if (!entry) return;
      const type = await entry.type();
      if (type === "blob" && filepath !== ".") {
        files.push(filepath);
      }
      return filepath;
    },
  });
  return files;
}

export interface StatusResult {
  branch: string;
  clean: boolean;
  dirty: string[];
  remotes: Array<{ remote: string; url: string }>;
}

export async function getStatus(dir: string): Promise<StatusResult> {
  const branch = (await git.currentBranch({ fs, dir })) ?? "HEAD (detached)";
  const matrix = await git.statusMatrix({ fs, dir });
  const dirty: string[] = [];

  for (const [filepath, head, workdir, stage] of matrix) {
    if (!(head === 1 && workdir === 1 && stage === 1)) {
      dirty.push(filepath);
    }
  }

  const remotes = await git.listRemotes({ fs, dir });

  return {
    branch,
    clean: dirty.length === 0,
    dirty,
    remotes,
  };
}

export async function addRemote(dir: string, url: string, remote = "origin"): Promise<void> {
  await git.addRemote({ fs, dir, remote, url });
}

/**
 * Fast-forward-only pull. Used by the wiki sync pipeline (ADR-0022 / M5.1).
 * On non-fast-forward divergence, throws a typed `WikiSyncConflictError`
 * carrying `conflictedFiles` sourced from `git.statusMatrix` so callers
 * (e.g. `am wiki resolve`) can present a per-file pick prompt without
 * re-reading the workdir.
 */
export async function pullFastForwardOnly(dir: string, branch?: string): Promise<void> {
  const ref = branch ?? (await git.currentBranch({ fs, dir })) ?? "main";
  try {
    await git.pull({
      fs,
      http: (await import("isomorphic-git/http/node")).default,
      dir,
      remote: "origin",
      ref,
      fastForwardOnly: true,
      author: DEFAULT_AUTHOR,
    });
  } catch (err) {
    // isomorphic-git throws an error with name "FastForwardError" when
    // fastForwardOnly is set and the remote isn't a fast-forward ancestor.
    const name = (err as { name?: string })?.name;
    const code = (err as { code?: string })?.code;
    if (name === "FastForwardError" || code === "FastForwardFail") {
      const matrix = await git.statusMatrix({ fs, dir });
      const conflictedFiles = matrix
        .filter(([_f, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1))
        .map(([f]) => f);
      throw new WikiSyncConflictError(conflictedFiles);
    }
    throw err;
  }
}

/**
 * Stage the given repo-relative paths. Thin wrapper around `git.add` with a
 * single-pass loop so callers can stage the wiki-page subset without
 * walking the whole worktree.
 */
export async function stageWikiFiles(dir: string, files: string[]): Promise<void> {
  for (const filepath of files) {
    await git.add({ fs, dir, filepath });
  }
}

/**
 * Soft-reset HEAD to its parent: rewind HEAD by one commit but preserve
 * workdir contents. Used by the wiki sync pipeline (M5.2) to roll back an
 * auto-commit when a subsequent pull fails — the user's edits stay on disk
 * so they can retry or resolve.
 *
 * 2026-05-02 adversarial-review fix: writing HEAD alone leaves the index
 * ahead of HEAD — next status would still show the rolled-back files as
 * "staged" and a second commit could double-apply them. We realign the
 * index to the new HEAD by calling `git.resetIndex` on every path whose
 * head/stage differ after the HEAD rewrite.
 */
export async function softResetHead(dir: string): Promise<void> {
  const commits = await git.log({ fs, dir, depth: 2 });
  if (commits.length < 2) {
    throw new Error("Cannot soft-reset: no parent commit (initial-commit repo)");
  }
  const parentOid = commits[1].oid;

  await git.writeRef({
    fs,
    dir,
    ref: "HEAD",
    value: parentOid,
    force: true,
  });

  // Realign the index to the new HEAD. statusMatrix returns one row per
  // known path as [filepath, head, workdir, stage] where 0/1/2/3 each have
  // specific meanings. Any row with head !== stage is a path the old HEAD
  // added/modified — resetIndex(ref=HEAD) points the index entry back at
  // the new-HEAD tree, so subsequent statusMatrix reports the path as
  // unstaged-but-modified (workdir kept, index realigned).
  const matrix = await git.statusMatrix({ fs, dir });
  for (const [filepath, head, _workdir, stage] of matrix) {
    if (head !== stage) {
      await git.resetIndex({ fs, dir, filepath });
    }
  }
}

/**
 * Outcome of {@link cloneRepo}.
 */
export interface CloneResult {
  /** The branch that was checked out. */
  branch: string;
  /** How the clone was performed — "http" (network) or "local" (filesystem). */
  transport: "http" | "local";
}

/**
 * Strip a leading `file://` scheme from a remote URL, returning the bare
 * filesystem path. `file:///abs/path` → `/abs/path`. Anything that is not a
 * `file://` URL is returned unchanged.
 */
function fileUrlToPath(url: string): string {
  if (!url.startsWith("file://")) return url;
  // file:///abs → /abs ; file://host/abs is rejected (we only support local).
  const withoutScheme = url.slice("file://".length);
  // A triple-slash form leaves a leading slash already; a host form
  // (file://host/path) would leave "host/path" — treat the first slash as the
  // path root for the local-only contract.
  if (withoutScheme.startsWith("/")) return withoutScheme;
  const slash = withoutScheme.indexOf("/");
  return slash === -1 ? withoutScheme : withoutScheme.slice(slash);
}

/**
 * Decide whether a remote URL points at the local filesystem (a bare repo on
 * disk or a `file://` URL) rather than a network host. Network schemes
 * (`http`, `https`, `ssh`, `git`) and SCP-style `git@host:org/repo` shorthand
 * are NOT local.
 */
export function isLocalRemote(url: string): boolean {
  if (url.startsWith("file://")) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false; // http(s)://, ssh://, git://
  if (/^[^/]+@[^/]+:/.test(url)) return false; // scp-style git@host:org/repo
  return true; // bare path: /abs/path, ./rel, ../rel, C:\… handled by callers
}

/**
 * Clone a git repository into `dir`. Two transports:
 *   - HTTP(S): isomorphic-git's network clone (uses the node http client).
 *   - Local (a bare repo path or `file://` URL): isomorphic-git has no local
 *     transport, so we filesystem-copy the bare repo's git database into
 *     `<dir>/.git`, record `origin`, and check out the default branch. This
 *     is the path exercised by tests (a local bare repo as the remote) and by
 *     dotfile bootstraps that point at a synced-down catalog.
 *
 * The destination `dir` must not already be a git repo (no `.git`). Callers
 * (e.g. the setup wizard) gate on that and merge rather than clobber.
 */
export async function cloneRepo(dir: string, url: string): Promise<CloneResult> {
  await fs.promises.mkdir(dir, { recursive: true });

  if (isLocalRemote(url)) {
    const sourcePath = fileUrlToPath(url);
    // The source may be a bare repo (its own root is the git db) or a normal
    // repo (git db under `.git`). Detect which and copy the right tree.
    let gitDbSource = sourcePath;
    try {
      await fs.promises.access(join(sourcePath, ".git"));
      gitDbSource = join(sourcePath, ".git");
    } catch {
      // No nested `.git` → treat `sourcePath` itself as the git database
      // (the bare-repo case).
    }
    const destGit = join(dir, ".git");
    await fs.promises.cp(gitDbSource, destGit, { recursive: true });
    // A copied bare repo is marked `core.bare = true`; flip it so checkout
    // treats `dir` as a working tree. isomorphic-git reads config lazily, so
    // the simplest robust fix is to drop the bare flag via setConfig.
    try {
      await git.setConfig({ fs, dir, path: "core.bare", value: false });
    } catch {
      // Non-fatal: a non-bare source has no bare flag to clear.
    }
    await git.addRemote({ fs, dir, remote: "origin", url, force: true });
    const branch = (await git.currentBranch({ fs, dir })) ?? "main";
    await git.checkout({ fs, dir, ref: branch, force: true });
    return { branch, transport: "local" };
  }

  await git.clone({
    fs,
    http: (await import("isomorphic-git/http/node")).default,
    dir,
    url,
    singleBranch: true,
  });
  const branch = (await git.currentBranch({ fs, dir })) ?? "main";
  return { branch, transport: "http" };
}
