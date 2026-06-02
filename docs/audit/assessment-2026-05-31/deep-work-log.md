
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

## Checkpoint 9 — 2026-06-02 (BACKLOG ZERO)

All 11 PRs merged (#23–#33). main @ 6048e6c. **Backlog: 0 open / 0 in_progress / 52 closed.**

Waves B/C/D/E + ACP-leak landed after the wave-A stack:
- Wave B: wiki-core request-changes fixes (lint enum, R3 wiring, delete-path) → approve; apply follow-ups (SEC-4c TUI, silent-failure narrow, shared default) → approve. (#26, #27)
- Wave C+D: full ADR-0054 wiki — R2 harvest-wikilinks, R5 cross-project meta-index, R6 pushToGlobal promote, R7 task-aware apply-injection, R8 multi-adapter session enumeration + gated LLM extraction. Wave C reviews caught R7/R8 as plumbing-only (zero callers); Wave D wired them into real call paths (re-review: approve with file:line evidence). Lint cleanup (12 dead biome-ignores). (#28, #29)
- Wave E: wiki-lint disk-frontmatter migration test, apply.ts resolveApplyTargets extraction + multiselect coverage, web-UI fail-closed skipped[] rendering + Force re-apply. (#30, #31, #32)
- ACP killSubprocess grace-timer leak (Promise.race orphaned setTimeout) — mutation-verified regression test. (#33)

WIKI-opt (chub-mcp) closed-as-deferred: ADR-0054 mandates optional-external-only, never-embed; v2 web-platform scope (see Mulch wiki/decision record).

Integrated main verified green across all three OS runners (ubuntu/windows-2025/macOS) + integration + integration-windows on every PR; local full suite 3451 pass / 0 fail; tsc first-party clean; lint 0 warnings.

Key cross-platform lessons (Mulch cross-platform domain): `process.env.X = undefined` → string "undefined" on Windows poisons shared bun process + spawned children; macOS `/var→/private/var` symlink breaks exact-path asserts (use realpathSync); APFS mtime/clock-skew breaks debounceSeconds:0 (backdate mtimes); atomic-write prune must drive off manifest insertion-order not lexical readdir; session-reader realpath dedup must case-fold on NTFS/APFS.
