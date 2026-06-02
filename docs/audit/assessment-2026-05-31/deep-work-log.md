
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

All 11 PRs merged (#23–#33). main @ 6048e6c. **Backlog: 0 open / 0 in_progress / 129 closed (project total).**

Waves B/C/D/E + ACP-leak landed after the wave-A stack:
- Wave B: wiki-core request-changes fixes (lint enum, R3 wiring, delete-path) → approve; apply follow-ups (SEC-4c TUI, silent-failure narrow, shared default) → approve. (#26, #27)
- Wave C+D: full ADR-0054 wiki — R2 harvest-wikilinks, R5 cross-project meta-index, R6 pushToGlobal promote, R7 task-aware apply-injection, R8 multi-adapter session enumeration + gated LLM extraction. Wave C reviews caught R7/R8 as plumbing-only (zero callers); Wave D wired them into real call paths (re-review: approve with file:line evidence). Lint cleanup (12 dead biome-ignores). (#28, #29)
- Wave E: wiki-lint disk-frontmatter migration test, apply.ts resolveApplyTargets extraction + multiselect coverage, web-UI fail-closed skipped[] rendering + Force re-apply. (#30, #31, #32)
- ACP killSubprocess grace-timer leak (Promise.race orphaned setTimeout) — mutation-verified regression test. (#33)

WIKI-opt (chub-mcp) closed-as-deferred: ADR-0054 mandates optional-external-only, never-embed; v2 web-platform scope (see Mulch wiki/decision record).

Integrated main verified green across all three OS runners (ubuntu/windows-2025/macOS) + integration + integration-windows on every PR; local full suite 3451 pass / 0 fail; tsc first-party clean; lint 0 warnings.

Key cross-platform lessons (Mulch cross-platform domain): `process.env.X = undefined` → string "undefined" on Windows poisons shared bun process + spawned children; macOS `/var→/private/var` symlink breaks exact-path asserts (use realpathSync); APFS mtime/clock-skew breaks debounceSeconds:0 (backdate mtimes); atomic-write prune must drive off manifest insertion-order not lexical readdir; session-reader realpath dedup must case-fold on NTFS/APFS.

## Checkpoint 10 — 2026-06-02 (PHASE 8 SIGN-OFF: v1 backlog zero, both teams confirm)

**Deep-work-loop closed.** 18 PRs merged total (#23–#40). main @ 4c9aa36+.

The loop ran the full investigate→plan→execute→review→reconcile cycle to convergence:
- Waves A–E landed the original audit backlog + ADR-0054 wiki (R1–R8) + cross-platform hardening (93+8 Windows failures, env-coercion root cause) + apply-safety (SEC-4b/4c fail-closed across all surfaces) + command-handler coverage.
- **PHASE 8 review #1 (independent, NO sign-off):** caught real gaps the per-wave reviews missed — R7 wired to only 4/13 adapters, `am setup` claimed import it didn't do (P0-4 doc-honesty), ~52 test-side `=undefined` env footguns, 5th apply surface bypassing shared default. Fed back into backlog.
- **Wave F + G:** closed every PHASE-8 gap — R7 across all 13 adapters; wizard genuinely wires `am import`; env-coercion swept (108 sites) + CI regression guard; APPLY_SAFE_DEFAULTS unified across all 5 apply surfaces; doc honesty; R4 supersede/coverage read surface.
- **PHASE 8 review #2 (independent re-verification): SIGN-OFF APPROVED** — backlogZero=true, signOff=true; all 3 re-audits `clean`; only 2 optional-low polish items remain (filed: e7c0, 929a).

**Final state:** v1 Seeds backlog = 0 open / 0 in_progress. Full suite 3490 pass / 0 fail. Main CI green on all 3 OS runners + integration. tsc first-party clean, lint 0 warnings.

**Documented v-next deferrals (ADR-backed, NOT v1 gaps):** WIKI-opt chub-mcp (ADR-0054: optional-external-only, never embed); WIKI-supersede-consumer invalidate-don't-delete contradiction handling (ADR-0054 R4: fields are forward-compat scaffolding, auto-flow is v-next); marketplace pillar (ADR-0031/0052: v2 web-platform era).

Key durable lessons (Mulch): real multi-OS CI is irreplaceable (Linux-only "correct-by-construction" missed shared-process env pollution, macOS symlink/APFS-mtime, R7/R8 dead-code wiring gaps); file-ownership partitioning keeps parallel waves conflict-free but defers cross-boundary wiring (needs an integration pass); don't launch a follow-up wave touching files an in-flight wave still owns (Wave G/F copilot collision); the independent final review catches what per-wave reviews rationalize past.

## Checkpoint 11 — 2026-06-02 (TRUE ZERO: optional nits closed too)

PHASE-8 re-review signed off with 2 OPTIONAL low items classed non-blocking; implemented them anyway for a genuine empty backlog:
- Wizard apply-failclosed test (proves setup = 5th surface honors APPLY_SAFE_DEFAULTS; distinguishes live write from dry-run preview).
- Copilot glob-only test (pins the by-design edge: glob-scoped-only instructions → no canonical file → no wiki injection).
(#41; also fixed a CI-vs-local biome line-width mismatch on the new test.)

**FINAL: 19 PRs merged (#23–#41). v1 Seeds backlog = 0 open / 0 in_progress / all closed. Full suite 3490 pass / 0 fail. tsc first-party clean, lint 0 warnings. main CI green across ubuntu/windows-2025/macOS + integration + integration-windows. Both execution and review teams confirm zero remaining v1 work. Documented v-next deferrals: WIKI-opt chub-mcp, WIKI-supersede-consumer contradiction-handling, marketplace pillar — all ADR-backed.**

Loop closed.
