
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

## Checkpoint 12 — 2026-06-04 (production-readiness audit + FIRST WORKING RELEASE)

After the deep-work-loop reached backlog-zero (checkpoints 10/11), a re-activated /goal triggered a FRESH independent production-readiness audit (5 facets w/ research: distribution, secrets-age, ADR-hygiene, supply-chain, pillars-UX). It found the one thing every prior wave-scoped review missed by only ever checking `main`:

**CRITICAL: the downloadable v0.5.0-rc6 binary was 288 commits stale — `am setup` (the documented headline command, built this very session) did NOT exist in it.** Gated by: the release pipeline hard-failed EVERY run on an unconditional npm-publish step (no NPM_TOKEN, name taken).

**Wave H** (4 disjoint strands, all reviewed) fixed 7 verified v1 gaps:
- release.yml npm-publish gated + ci.yml report-only `bun audit` step
- hono ^4.12.12 → ^4.12.18 (resolves 4.12.23, clears 6 advisories)
- `am serve` binds 127.0.0.1 by default (was 0.0.0.0/LAN) + `--lan`/`--host`; `am agent add` clean error (no stack trace) via `__setDiscoverFromUrlForTests` seam (replacing a mock.module that bled into discovery.test.ts)
- ADR-0054 promoted proposed→accepted; doc-honesty (README/install.sh/Homebrew first-touch → `am setup`; npm-step contradiction resolved); CHANGELOG [Unreleased] populated
Integrated: 3503 pass / 0 fail, tsc + lint clean, main CI green all OS.

**The release-cut (the north-star fix):**
- First rc7 tag FAILED: `if: ${{ secrets.NPM_TOKEN != '' }}` — the `secrets` context is NOT allowed in `if:` conditions; GitHub rejected release.yml at parse time. Caught by `actionlint` (which both the implementer and its adversarial reviewer had skipped). Fix: job-level `env: NPM_TOKEN: ${{ secrets.NPM_TOKEN }}` + `if: ${{ env.NPM_TOKEN != '' }}`.
- Added an **actionlint CI step (pinned v1.7.7)** so this context-error class is caught locally, not by a failed release.
- Re-tagged v0.5.0-rc7 on the fix → **release pipeline SUCCEEDED** (first green release since rc6): all 5 platform binaries + checksums attached, Homebrew formula regenerated, npm step cleanly SKIPPED. Verified by downloading `am-linux-x64` (checksum OK) and running `am setup --help` → wizard text (was root-help+exit1 in rc6).

**v0.5.0-rc7 is published.** v1 backlog: 0 open / 0 in_progress except agent-manager-43d2 (CI-AUDIT-HARDEN), deferred-with-documented-justification: the 2 remaining `bun audit` advisories are unfixable in-range (ws via dev-only wrangler→miniflare; @chenglou/pretext self-DoS via silvery TUI, no patch exists). Lesson: "main green" ≠ "release succeeds" ≠ "the binary ships the feature" — verify the downloadable artifact, not just the branch.

## Checkpoint 13 — 2026-06-04 (PHASE-8c: release default-path + supply-chain hardening)

The independent PHASE-8c verification of the rc7 release found one CRITICAL gap the release-cut itself missed (the same north-star failure mode, one level deeper): **the default `curl|sh` installed the stale rc6, NOT rc7.** install.sh resolved via GitHub `/releases/latest`, which EXCLUDES prereleases — rc7 was correctly tagged prerelease, rc6 was (mis-)flagged non-prerelease, so `/releases/latest` returned rc6. I'd verified "the released binary contains am setup" via `gh release download <tag>` but never the *default installer path*.

Fixes (all verified):
- **install.sh prerelease-aware** (`d4f5f4f`): prefer `/releases` first-item (newest of ANY kind) over `/releases/latest`, since the project ships only `-rc` prereleases pre-1.0. Verified END-TO-END: bare `sh install.sh` (no flags) → checksum OK → installs am 0.5.0-rc7 → `am setup --help` works. Also marked rc6 as prerelease (GitHub-state hygiene).
- **@chenglou/pretext override → 0.0.7** (cleared the high-severity DoS advisory). The PHASE-8c reviewer caught that my 43d2 deferral justification was factually wrong — pretext DID have fixed versions (0.0.5-0.0.7); silvery's `^0.0.3` caret locks to 0.0.3 on a 0.0.x version, fixable via a bun override (same mechanism as @silvery/commander). Verified: bun audit clears pretext, typecheck clean, TUI tests 13/0, build smoke OK, TUI module loads at runtime.
- **43d2 IMPLEMENTED, not deferred** (`598dbf3`): with hono≥4.12.18 + pretext override, no high/critical advisories remain, so added a hard `bun audit --audit-level=high` CI gate (+ kept full report-only audit for the dev-only `ws` moderate via wrangler→miniflare, not bundled).
- **CHANGELOG**: dropped the chub-mcp overclaim (v2-deferred, no code).
- **Stats refreshed** (`a962854`): 3064→3503 tests, 54→55 ADRs across README (badge+block+inline), AGENTS.md, ROADMAP.

**v0.5.0-rc7 published + the default install delivers it.** Advisory baseline: 1 dev-only moderate (ws, not shipped). v1 backlog: 0 open / 0 in_progress. Lesson (recursion of checkpoint 12): "binary contains the feature" ≠ "the default installer delivers that binary" — verify the documented one-liner end-to-end, not a pinned download.
