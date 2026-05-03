/**
 * M5.2 wiki-sync pipeline (2026-05-03-C).
 *
 * The public surface is `syncWiki(wikiDir, opts)`, which is what the
 * upgraded `am wiki sync` subcommand calls. Every sub-step is exported
 * separately so `test/wiki/sync.test.ts` can exercise each one without
 * the git/network round-trip.
 *
 * Pipeline (when --direction=both):
 *   1. Collect dirty wiki files filtered by mtime debounce.
 *   2. Tier-1 secret scan (--strict-secret-scan gate). Block on hit.
 *   3. Stage + commit the filtered set with message `wiki: auto-sync N page(s)`.
 *   4. Fast-forward-only pull. On `WikiSyncConflictError`, roll back the
 *      auto-commit via `softResetHead` and write `wiki-conflict.json` sidecar
 *      for M5.3's `am wiki resolve`.
 *   5. Push.
 *
 * Schema note: this module does NOT touch `settings.wiki.auto_sync_interval_seconds`.
 * Per PLAN-4 (2026-05-02), that schema field ships in the SAME milestone as the
 * timer that reads it — shipping just the field creates a pit trap where users
 * set it and observe no behavior.
 */

import * as fs from "node:fs";
import { join, relative } from "node:path";
import git from "isomorphic-git";
import {
  commitAll,
  getStatus,
  pull as gitPullStandard,
  push as gitPush,
  pullFastForwardOnly,
  softResetHead,
  stageWikiFiles,
} from "../core/git";
import { WikiSyncSecretBlockedError } from "../lib/errors";

// ── Tier-1 markdown text scan (minimal, opt-in) ──────────────────────────────

/**
 * Minimal tier-1 patterns for raw-text secret detection. Kept tight to
 * avoid false positives in markdown. Only matches high-signal shapes:
 *   - bare PEM headers
 *   - explicit GitHub/GitLab/OpenAI token prefixes
 *   - AWS-style AKIA[0-9A-Z]{16} access keys
 *   - generic `api[_-]?key\s*[:=]` shaped assignments where the value
 *     looks like a secret (≥ 20 alnum chars). Env-style placeholders like
 *     `${FOO}` or `YOUR_KEY_HERE` are excluded.
 *
 * Callers opt in via --strict-secret-scan; default is off.
 */
const TEXT_SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // "BEGIN RSA PRIVATE KEY", "BEGIN PRIVATE KEY", "BEGIN EC PRIVATE KEY",
  // "BEGIN OPENSSH PRIVATE KEY" — any variant. Match up to 30 chars before
  // "KEY-----" so the key-type tokens (one or two words) can all fit.
  { name: "pem-private-key", re: /-----BEGIN\s+[A-Z][A-Z\s]{0,30}KEY-----/i },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "openai-token", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack-token", re: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "generic-api-key-assignment",
    re: /(?:api[_-]?key|secret|password|passwd)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?/i,
  },
];

const PLACEHOLDER_HINTS = [/\$\{[A-Z_]+\}/, /<[A-Z_]+>/, /YOUR_[A-Z_]+_HERE/i, /XXX+/, /\*{3,}/];

export interface TextSecretHit {
  file: string;
  pattern: string;
  excerpt: string;
}

/**
 * Scan a string for obvious secret shapes. Returns at most one hit per
 * pattern to avoid spamming the user. Returns [] if the text smells like
 * documentation rather than a real secret (placeholders present).
 */
export function scanTextForSecrets(file: string, text: string): TextSecretHit[] {
  const hits: TextSecretHit[] = [];
  for (const { name, re } of TEXT_SECRET_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const excerpt = m[0].slice(0, 48) + (m[0].length > 48 ? "…" : "");
    const hasPlaceholder = PLACEHOLDER_HINTS.some((p) => p.test(text));
    if (name === "generic-api-key-assignment" && hasPlaceholder) continue;
    hits.push({ file, pattern: name, excerpt });
  }
  return hits;
}

// ── Dirty-file collection ────────────────────────────────────────────────────

/**
 * Enumerate wiki files whose workdir differs from HEAD and whose mtime is
 * older than `debounceSeconds` seconds (so files the user is actively
 * editing don't get mid-keystroke auto-committed). Only .md files under
 * the wiki dir are returned — adapter state, logs, and git internals are
 * excluded.
 */
export async function collectDirtyWikiFiles(
  wikiDir: string,
  debounceSeconds: number,
): Promise<string[]> {
  const matrix = await git.statusMatrix({ fs, dir: wikiDir });
  const cutoffMs = Date.now() - debounceSeconds * 1000;
  const dirty: string[] = [];
  for (const [filepath, head, workdir, stage] of matrix) {
    if (head === 1 && workdir === 1 && stage === 1) continue; // clean
    if (!filepath.endsWith(".md") && !filepath.endsWith(".toml")) continue;
    const abs = join(wikiDir, filepath);
    try {
      const st = await fs.promises.stat(abs);
      if (st.mtimeMs > cutoffMs) continue; // too recent (user still editing)
      dirty.push(filepath);
    } catch {
      // File may be deleted — include it so staging picks up the removal.
      dirty.push(filepath);
    }
  }
  return dirty;
}

// ── Auto-commit ──────────────────────────────────────────────────────────────

export interface AutoCommitOptions {
  debounceSeconds?: number;
  strictSecretScan?: boolean;
}

export interface AutoCommitResult {
  committed: boolean;
  files: string[];
  commitOid?: string;
}

/**
 * Stage and commit wiki files older than the debounce cutoff. Returns
 * `{ committed: false, files: [] }` when nothing qualifies. Throws
 * `WikiSyncSecretBlockedError` on any tier-1 hit (strictSecretScan only).
 */
export async function autoCommitWikiFiles(
  wikiDir: string,
  opts: AutoCommitOptions = {},
): Promise<AutoCommitResult> {
  const debounce = opts.debounceSeconds ?? 60;
  const files = await collectDirtyWikiFiles(wikiDir, debounce);
  if (files.length === 0) return { committed: false, files: [] };

  if (opts.strictSecretScan) {
    const hits: Array<{ file: string; reason: string }> = [];
    for (const rel of files) {
      const abs = join(wikiDir, rel);
      if (!fs.existsSync(abs)) continue; // deletion — nothing to scan
      try {
        const text = await fs.promises.readFile(abs, "utf-8");
        for (const hit of scanTextForSecrets(rel, text)) {
          hits.push({ file: hit.file, reason: `${hit.pattern}: ${hit.excerpt}` });
        }
      } catch {
        // unreadable — skip; staging will surface a clearer error later
      }
    }
    if (hits.length > 0) throw new WikiSyncSecretBlockedError(hits);
  }

  await stageWikiFiles(wikiDir, files);
  const message =
    files.length === 1 ? "wiki: auto-sync 1 page" : `wiki: auto-sync ${files.length} pages`;
  const commitOid = await commitAll(wikiDir, message);
  return { committed: true, files, commitOid };
}

// ── Sidecar for M5.3 resolve flow ────────────────────────────────────────────

/**
 * Conflict sidecar that `am wiki resolve` (M5.3) consumes. Written at the
 * wiki dir root so it's per-wiki, not per-project.
 */
export const CONFLICT_SIDECAR = "wiki-conflict.json";

export interface ConflictSidecar {
  timestamp: string;
  remote: string;
  branch?: string;
  conflictedFiles: string[];
  rolledBackCommit?: string;
}

export async function writeConflictSidecar(wikiDir: string, data: ConflictSidecar): Promise<void> {
  await fs.promises.writeFile(
    join(wikiDir, CONFLICT_SIDECAR),
    `${JSON.stringify(data, null, 2)}\n`,
    "utf-8",
  );
}

export async function clearConflictSidecar(wikiDir: string): Promise<void> {
  try {
    await fs.promises.unlink(join(wikiDir, CONFLICT_SIDECAR));
  } catch {
    // already gone
  }
}

// ── Top-level sync ───────────────────────────────────────────────────────────

export type Direction = "push" | "pull" | "both" | "commit-and-sync";

export interface SyncOptions {
  direction: Direction;
  remote?: string;
  branch?: string;
  autoCommit: boolean;
  allowDirty: boolean;
  debounceSeconds?: number;
  strictSecretScan?: boolean;
}

export interface SyncActionRecord {
  action: "auto-commit" | "pull" | "push" | "rollback";
  ok: boolean;
  detail?: string;
  error?: string;
  files?: string[];
}

export interface SyncResult {
  wikiDir: string;
  remote: string;
  branch: string;
  actions: SyncActionRecord[];
  sidecarWritten?: string;
}

export async function syncWiki(wikiDir: string, opts: SyncOptions): Promise<SyncResult> {
  const remote = opts.remote ?? "origin";
  const actions: SyncActionRecord[] = [];

  const status = await getStatus(wikiDir);
  const branch = status.branch;

  // Dirty-tree handling. When auto-commit is off, a dirty tree blocks
  // a FF-only pull unless --allow-dirty. Historical bare-warn behavior
  // is promoted to a flag per wiki-sync-m5.md §M5.2.
  const isDirty = !status.clean;
  if (isDirty && !opts.autoCommit && !opts.allowDirty) {
    throw new Error("Wiki working tree is dirty. Retry with `--auto-commit` or `--allow-dirty`");
  }

  let autoCommitOid: string | undefined;
  if (opts.autoCommit && isDirty && opts.direction !== "push") {
    // Auto-commit runs before pull so the subsequent FF check is honest.
    try {
      const ac = await autoCommitWikiFiles(wikiDir, {
        debounceSeconds: opts.debounceSeconds,
        strictSecretScan: opts.strictSecretScan,
      });
      if (ac.committed) {
        autoCommitOid = ac.commitOid;
        actions.push({
          action: "auto-commit",
          ok: true,
          detail: `${ac.files.length} file(s)`,
          files: ac.files,
        });
      } else {
        actions.push({ action: "auto-commit", ok: true, detail: "nothing to commit (debounce)" });
      }
    } catch (err) {
      actions.push({
        action: "auto-commit",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err; // secret-block is fatal
    }
  }

  // Pull (FF-only).
  if (
    opts.direction === "pull" ||
    opts.direction === "both" ||
    opts.direction === "commit-and-sync"
  ) {
    try {
      await pullFastForwardOnly(wikiDir, opts.branch);
      actions.push({ action: "pull", ok: true });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === "WikiSyncConflictError") {
        // Roll back auto-commit to leave the user's workdir intact + pristine.
        if (autoCommitOid) {
          try {
            await softResetHead(wikiDir);
            actions.push({ action: "rollback", ok: true, detail: "auto-commit reverted" });
          } catch (rb) {
            actions.push({
              action: "rollback",
              ok: false,
              error: rb instanceof Error ? rb.message : String(rb),
            });
          }
        }
        const conflictedFiles = (err as { conflictedFiles?: string[] }).conflictedFiles ?? [];
        await writeConflictSidecar(wikiDir, {
          timestamp: new Date().toISOString(),
          remote,
          branch: opts.branch,
          conflictedFiles,
          rolledBackCommit: autoCommitOid,
        });
        actions.push({
          action: "pull",
          ok: false,
          error: "fast-forward-only pull refused: remote and local have diverged",
          files: conflictedFiles,
        });
        return {
          wikiDir,
          remote,
          branch,
          actions,
          sidecarWritten: join(wikiDir, CONFLICT_SIDECAR),
        };
      }
      // Non-FF error — rethrow with context.
      actions.push({
        action: "pull",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      if (opts.direction === "pull") return { wikiDir, remote, branch, actions };
    }
  }

  // Push.
  if (
    opts.direction === "push" ||
    opts.direction === "both" ||
    opts.direction === "commit-and-sync"
  ) {
    try {
      await gitPush(wikiDir, remote, opts.branch);
      actions.push({ action: "push", ok: true });
    } catch (err) {
      actions.push({
        action: "push",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Sync succeeded without divergence → clear any stale sidecar from a prior run.
  await clearConflictSidecar(wikiDir);

  return { wikiDir, remote, branch, actions };
}

// Re-exports so consumers only need this module.
export { gitPullStandard, relative };
