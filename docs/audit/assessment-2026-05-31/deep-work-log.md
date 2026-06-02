
## Checkpoint 8 — 2026-06-02 (stacked-PR wave landing)

**Merged to main (5 PRs, all green on ubuntu+windows-2025+macOS+integration+CodeRabbit):**
- #23 ci/xplat-sweep — all 93 residual Windows unit failures + 8 CI-3d residuals (env-coercion root cause: `process.env.X = undefined` → string "undefined" on Windows poisons the shared bun process + spawned subprocesses) + 3 CodeRabbit findings (deriveMarketplaceName `/`-split, wiki/resolve root-dir `//`, roo-code export toPosix) + de-flaked sync.test.ts (macOS APFS mtime/clock-skew with debounceSeconds:0).
- #24 apply-safety — SEC-4b fail-closed drift gate on MCP/web + per-target opt-in + precise skip summary.
- #25 tests-followups — command-handler coverage + TEST-2 CI guard + wiki/setup nits.
- #26 wiki-core — ADR-0054 R1/R3/R4 (live write-path, catalog NER, frontmatter enum) + 3 review-blocker fixes (lint enum, R3 wiring, delete-path liveness) + macOS realpath fix.
- #27 apply-follow — SEC-4c TUI fail-closed + apply.ts silent-failure narrowed + shared apply-default.

**Integrated main: 3367 pass / 0 fail, tsc first-party clean, lint clean (12 cosmetic warnings being cleaned in Wave C).**

Key lessons recorded to Mulch (cross-platform domain): real multi-OS CI is irreplaceable (Linux-only "correct-by-construction" missed shared-process env pollution + macOS `/var→/private/var` symlink + APFS mtime skew). Stacked-PR rebase: when base advances, rebase dependents to re-trigger CI; cherry-pick detection auto-drops already-merged commits.

**Remaining backlog → Wave C (in flight):** WIKI-R2/R5/R6/R7/R8 (5 features, partitioned by file-ownership) + lint-cleanup. WIKI-opt (chub-mcp) stays v2-deferred per ADR-0054 ("do NOT embed"). Plus 3 low-pri test/UI nits (wiki-lint-disk-test, TEST-TUI-MULTISELECT, WEB-UI-APPLY-SKIPPED).
