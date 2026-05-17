---
status: partially-shipped
date: 2026-05-01
last-updated: 2026-05-17
milestone: M5
relates-to: ADR-0022, ADR-0023, ADR-0020, src/commands/wiki.ts:1009
research: docs/research/2026-05-01-wiki-sync-patterns.md
implementation:
  m5_1: shipped in commit f5f7401 (2026-05-03) — 3 primitives + 2 typed errors + 9 tests
  m5_2: shipped in commit f349a5d (2026-05-03) — sync.ts pipeline + auto-commit + sidecar + 19 tests
  m5_3:
    resolve: shipped — `am wiki resolve` subcommand (resolveSubcommand in src/commands/wiki.ts:1173) wraps resolveConflicts (src/wiki/resolve.ts) with --strategy short-circuit + --json shape. Unit coverage in test/wiki/resolve.test.ts; command-level coverage in test/commands/wiki-resolve.test.ts (DWL-T10, 2026-05-17).
    relink: deferred to a follow-up wave — `am wiki relink` (real-dir orphan → symlink merge).
    doctor_symlink_check: deferred — `am doctor` symlink integrity guard (file overlap with concurrent T9 work, postponed to next wave).
    subtree_export: deferred — `am wiki export --project --to <url>` one-way subtree-split push. Stretch goal per original plan; not blocking this milestone close.
---

# M5 Wiki-Sync Correctness Upgrade — Implementation Plan

## Goal

Replace the thin `am wiki sync` push/pull wrapper with a correctness-first sync
pipeline: debounced auto-commit with pre-commit secret scanning, fast-forward-only
pulls that refuse divergence and expose a pick-side resolution command, and an
`am doctor` guard that prevents the single-physical-tree invariant (ADR-0022) from
being silently violated.

## Acceptance Criteria

- `am wiki sync` with a dirty working tree auto-commits wiki files not modified
  in the last 60 seconds, unless `--no-auto-commit` is passed.
- Auto-commit is blocked and `process.exitCode = 1` is set if ADR-0023 tier-1
  or tier-2 secret detection finds a hit in the staged-for-auto-commit file set.
- Pull is fast-forward-only. On a non-fast-forward remote, the command exits
  with code 1 and prints a message directing the user to `am wiki resolve`.
- If auto-commit was made before a failed pull, it is rolled back via a soft-reset
  equivalent before the error is surfaced.
- `am wiki sync --direction {push|pull|both|commit-and-sync}` controls scope.
- `am wiki sync --no-auto-commit` fails with exit 1 if the tree is dirty
  (current behaviour promoted to a flag). `--allow-dirty` preserves the old
  warn-and-proceed behaviour.
- `am wiki resolve` lists last-failed-sync files, presents a per-file pick
  (local / remote / edit) prompt via `@clack/prompts`, stages and commits.
- `am doctor` emits a `fail`-level check when `<project>/.agent-manager/wiki`
  exists as a real directory rather than a symlink, and directs to `am wiki relink`.
- `am wiki relink` copies newer files from the orphaned real directory into the
  central store, commits, replaces the directory with the correct symlink.
- `am wiki export --project <name> --to <url>` performs a one-way subtree-split
  push to the given remote. Documented as one-way, not a sync.
- All new paths support `--json`. New code has ≥ 90 % line coverage.
- `bun run typecheck` and `bun run lint` pass with zero new errors.

## Phased Steps

### M5.1 — Core git primitives + fast-forward enforcement (PR 1)

Purely additive; zero user-visible change.

- `pullFastForwardOnly(dir, ref)` in `src/core/git.ts` — calls
  `git.pull({ fastForwardOnly: true })`. On non-FF, throws a typed
  `WikiSyncConflictError` carrying `conflictedFiles` from `git.statusMatrix`.
- `softResetHead(dir)` in `src/core/git.ts` — reads parent oid from
  `git.log({ depth: 2 })`, `git.writeRef({ ref: 'HEAD', value: parentOid })`,
  **then calls `git.resetIndex({ fs, dir, filepath })` for each staged path
  to realign the index with the new HEAD.** This addresses the 2026-05-02
  adversarial-review finding that `writeRef` alone leaves the index ahead
  of HEAD — next `am wiki sync` would show the same files as staged-but-
  uncommitted and could double-commit. Working tree files are preserved
  (the point of a soft reset). Throws on initial-commit repo.

  Test that explicitly guards this: after commit → softResetHead → call
  `git.statusMatrix` and assert no path shows as `[1, 2, 2]` (staged and
  unchanged) that wasn't staged before the commit.
- `stageWikiFiles(dir, files)` — calls `git.add` for each relative path.
- `WikiSyncConflictError`, `WikiSyncSecretBlockedError` added to `src/lib/errors.ts`.
- `test/core/git-wiki-sync.test.ts` covers each primitive with an
  `AM_CONFIG_DIR`-isolated tmp dir + bare-repo fake remote.

### M5.2 — Auto-commit pipeline + upgraded `am wiki sync` (PR 2)

Depends on M5.1.

- `src/wiki/sync.ts` (new file) — `autoCommitWikiFiles(wikiDir, opts)`:
  1. `getStatus(wikiDir)` → dirty list.
  2. Filter by `fs.stat().mtimeMs` against `debounceSeconds` (default 60).
  3. `scanFilesForSecrets(files)` — ADR-0023 tier-1 + optional tier-2 (betterleaks).
     Throws `WikiSyncSecretBlockedError` on hit.
  4. `stageWikiFiles`, then `commitAll` with message `wiki: auto-sync N page(s)`.
- Rewrite `syncSubcommand` in `src/commands/wiki.ts:1009`:
  args: `direction`, `auto-commit`/`no-auto-commit`, `allow-dirty`, `debounce`,
  `remote`, `branch`, `json`, `quiet`, `verbose`.
  Execution: resolve wikiDir → validate → auto-commit (if enabled + tree dirty)
  → `pullFastForwardOnly` (rollback auto-commit on conflict; write
  `wiki-conflict.json` sidecar) → push (retry once on non-FF rejection).
- **PLAN-4 (2026-05-02): do NOT add the `settings.wiki.auto_sync_interval_seconds`
  schema field in M5.2.** Shipping a schema field without the runtime timer
  creates a pit trap — users set it, observe no behavior, file bugs. Move
  the schema addition to the SAME milestone as the `am serve` / `am mcp-serve`
  timer integration, which is explicitly a follow-up. Until both ship together,
  no schema field.
- `test/commands/wiki-sync.test.ts` covers: clean+pull, dirty+recent+debounce,
  dirty+old+auto-commit, secret-block, non-FF pull rollback, `--no-auto-commit`
  dirty-error, `--allow-dirty` warn+proceed, each `--direction` value,
  `--json` output shape.

### M5.3 — `am wiki resolve`, `am doctor` symlink check, `am wiki relink`, subtree export (PR 3)

Depends on M5.2.

- `resolveSubcommand` reads `<configDir>/.agent-manager/wiki-conflict.json`
  (written by M5.2 on `WikiSyncConflictError`). Per-file `@clack/prompts`
  select: `keep-local` / `take-remote` / `edit`. Stages chosen versions,
  commits `wiki: resolve merge conflict (manual)`, deletes sidecar.
- `am doctor` wiki symlink integrity check: `lstatSync(wikiLink)` must be
  a symbolic link. On Windows, junction detection uses `realpathSync != wikiLink`.
- `relinkSubcommand`: merges newer files from orphaned real dir into central
  store, commits, replaces with symlink.
- `exportSubcommand` extended with `--project <name> --to <url>`: one-way
  subtree-split push via manually-constructed tree objects. **Stretch goal** —
  if tree-construction proves too expensive, defer to follow-up and ship only
  M5.3.1–M5.3.4.
- Tests in `test/commands/wiki-resolve.test.ts`,
  `test/commands/wiki-relink.test.ts`, doctor additions.

## New ADR Required

**ADR-0035: Wiki Sync Correctness Policy.** Records:
1. Why auto-commit is opt-out by default but requires explicit interval to run on a timer.
2. The deliberate choice of fast-forward-only pull over 3-way merge given the
   isomorphic-git constraint (ADR-0010).
3. Rejection of per-project remotes; subtree-export as the escape hatch.
4. The `wiki-conflict.json` sidecar as the mechanism passing state from
   `am wiki sync` to `am wiki resolve`.
5. The `am doctor` symlink check as the ADR-0022 invariant guard.

## Rollback Plan

- M5.1: additive; revert-safe.
- M5.2: old behaviour preserved under `--allow-dirty`. Regression hotfix = 2-line
  default flip in the args definition.
- M5.3: all additive. Reverting is safe; stale `wiki-conflict.json` is ignored.

## Risks

| Risk | Mitigation |
|---|---|
| isomorphic-git `fastForwardOnly` behaviour in pinned version | Add diverged-remote test before implementing; verify flag honoured |
| `softResetHead` via `writeRef` is not a first-class API | Test: commit → soft-reset → `commitAll` again preserves working-tree files |
| Raw-text secret scan in Markdown has unknown false-positive rate | Ship M5.2 with betterleaks tier-2 only; gate tier-1 heuristic behind `--strict-secret-scan` |
| `am wiki export --project` subtree tree construction is non-trivial | Marked as stretch goal; defer to follow-up if too expensive |
| Auto-sync timer disable during `am wiki ingest` / harvester batches | Timer wiring is a follow-up, not this milestone — not a risk for M5 directly |
| Windows junction vs symlink detection | `realpathSync != wikiLink` fallback; ADR to record the behaviour |

## Follow-up Tasks (out of M5 scope)

1. Auto-sync timer wiring in `am serve` / `am mcp-serve`.
2. Subtree push (`am wiki export --project --to`) if deferred from M5.3.
3. Syncthing + git co-existence doc in `docs/guides/wiki-sync-advanced.md`.
4. isomorphic-git merge capability re-verification (could `am wiki resolve`
   auto-resolve non-conflicting hunks?).
5. BetterLeaks text-mode scanning calibration on real wiki pages.
6. `am wiki resolve --strategy local-wins` / `--strategy remote-wins` for
   non-interactive / CI resolution.

> **Auto-sync schema + timer ship together.** `settings.wiki.auto_sync_interval_seconds` MUST NOT be added to `SettingsSchema` until the runtime timer that reads it is implemented in the SAME milestone. Shipping the field without the timer creates a pit trap: users set it, observe no behavior, file bugs. (CODEX-5 + PLAN-4 reconciliation, 2026-05-02.)
