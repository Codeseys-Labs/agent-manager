# Deep-Work-Loop Backlog Audit — 2026-05-05

**Baseline HEAD:** `177ccc9` (Run G complete: ADR-0044 Wave B shipped + reviewer fixes).

This audit consolidates every pending item across the project: open ADRs,
ROADMAP gaps, prior-run reviewer findings, and codebase-health checks
(lint/typecheck baseline).

## Categorisation

| Priority | Definition |
|----------|-----------|
| P0 | Blocks a major feature, breaks a sign-off invariant, or is a security gap |
| P1 | Visible quality regression, ADR gate not closed, repeated user friction |
| P2 | Polish / extension / nice-to-have, no current user pain |

| Complexity | Effort estimate |
|------------|-----------------|
| S | < 30 min focused, single-file edit |
| M | 30 min – 2 h, multi-file but well-scoped |
| L | 2 – 6 h, design + tests + docs |
| XL | full-day or multi-session, blocks on infra / external |

---

## Section A — Wave C completion (ADR-0044 plan tasks 9-12)

| ID | Title | Pri | Cmpx | Depends | Notes |
|----|-------|-----|------|---------|-------|
| W-C9  | Default `.am-wiki/` to gitignored on init | P1 | S | — | Plan task 9. Covered partially by `ensureAmWikiGitignore` but verify default behaviour. |
| W-C10 | CLI wiring sanity check (am wiki migrate/publish/pull surfaced in --help) | P1 | S | — | Plan task 10. |
| W-C11 | Promote ADR-0044 from `proposed` → `accepted` | P1 | S | W-C9, W-C10 | Plan task 11. Update verification gates section. |
| W-C12 | ADR-0022 final cross-reference cleanup | P1 | S | W-C11 | Plan task 12. Update status note + amended_by. |

---

## Section B — Reviewer-flagged backlog from Wave B (deferred)

| ID | Title | Pri | Cmpx | Source | Notes |
|----|-------|-----|------|--------|-------|
| R-B1 | `pushToGlobal` return shape ambiguity (`{pushed: slug, conflict: true}`) | P2 | S | deepseek-v4-pro MED | Use discriminated union or `pushed: null` on conflict. |
| R-B2 | `resolveWikiDir` doesn't recognise `.am-wiki/` for `am wiki path` | P1 | S | deepseek-v4-pro LOW | Affects `am wiki path` command output post-migration. |
| R-B3 | `discoverPromoteSlugs` regex fragility (`promote: True`, `"true"`, comments) | P2 | S | deepseek-v4-pro LOW | Replace with proper YAML frontmatter parse. |
| R-B4 | `ensureWikiGitignore` legacy helper still callable; could re-add stale entry | P2 | S | deepseek-v4-pro LOW | Mark `@deprecated` or refactor away. |
| R-B5 | Test gap: `am wiki path` post-migration | P2 | S | deepseek-v4-pro LOW | After R-B2, add test. |
| R-B6 | Test gap: publish-with-zero-promote-entries `--auto` | P2 | S | grok-4.3 LOW | Add edge-case test. |

---

## Section C — Open ADRs (proposed → needs gate closure)

| ADR | Status | Open gates / blockers | Pri | Cmpx |
|-----|--------|----------------------|-----|------|
| 0042 | proposed | Gates 1, 4, 5 open: browser integration, SECURITY.md threat model, `am pair` command | P1 | XL |
| 0043 | proposed | Implementation pending entirely (hosted UI auth tiers); blocks ADR-0045 too | P1 | XL |
| 0044 | proposed | Promotes via W-C11 | P1 | S |
| 0045 | proposed | Implementation pending; blocked on hosted UI bundle pipeline | P2 | XL |
| 0034 | proposed | Shim scope and inclusion criteria | P2 | M |
| 0035 | proposed | Community shim registration | P2 | M |
| 0036 | proposed | Agent variants — partially implemented (tests pass) | P1 | M |
| 0037 | proposed | Per-tool MCP metadata | P2 | M |
| 0038 | proposed | Dry-run / explain surface | P2 | M |
| 0039 | proposed | Marketplace v1 scope decision | P2 | M |
| 0046 | accepted | (already done — included for completeness) | — | — |

---

## Section D — Codebase health (toolchain baseline)

| ID | Title | Pri | Cmpx | Notes |
|----|-------|-----|------|-------|
| H-1 | `bun run typecheck` returns 244 errors on clean main | P0 | M | All errors in `node_modules/@silvery/*` and test files. `skipLibCheck: true` is set but TS is still flagging JSX namespace + missing `@types/react-reconciler`. Project-wide typecheck is currently a no-op for src/. |
| H-2 | `bun run lint` returns 25 errors (mostly `delete process.env.X`) | P1 | S | Pattern is biome `lint/performance/noDelete`. Auto-fixable. |
| H-3 | Doctor scan regex coverage extension (ADR-0046 LOW) | P2 | S | `team_passphrase` quoted/dotted/inline TOML forms. |
| H-4 | Test-coverage metrics (bun --coverage in CI, badge in README) | P2 | M | ROADMAP infrastructure backlog. |
| H-5 | Windows CI runner (junction-point symlinks) | P2 | L | ROADMAP infrastructure backlog. |
| H-6 | npm package: split platform binaries into optionalDependencies | P2 | M | ROADMAP infrastructure backlog. |

---

## Section E — Known operational notes (not blocking, observability)

| ID | Title | Notes |
|----|-------|-------|
| O-1 | Hermes `max_concurrent_children: 6` not picked up live (cached at 3) | Operational; orchestrator splits 6-way scatters into 2× 3. |
| O-2 | Subagent timeout pattern: long-research-then-large-write stalls at post-impl summary | Recovery: check git status + targeted test, never blind retry. |

---

## Wave plan

Wave plans now grouped to maximise parallelism while respecting file-ownership.

### Wave C (this run, mechanical)
- W-C9, W-C10, W-C11, W-C12 → single subagent (all touch ADR docs + wiki.ts gitignore default + ROADMAP)

### Wave H (this run, parallel)
- H-1 (typecheck baseline) — single subagent, isolated to tsconfig + types/
- H-2 (lint cleanup) — single subagent, codebase-wide auto-fix + spot-check
- R-B2 (resolveWikiDir for .am-wiki/) — single subagent, wiki/storage.ts + tests
- R-B3 (discoverPromoteSlugs YAML parse) — single subagent, wiki.ts + tests
- R-B6 (publish --auto zero entries test) — single subagent, test/commands/wiki-wave-b.test.ts (BUT: file owned by R-B2/R-B3 if they touch it. Verify. Likely independent.)

Wave H respects file-ownership: 5 subagents, 5 distinct files/areas, no overlap.

### Wave I (sequential, after Wave H reconciled)
- R-B1 (pushToGlobal return shape) — single subagent, storage.ts + callers (depends on R-B2 not touching the same lines)
- R-B4 (deprecate ensureWikiGitignore) — single subagent
- R-B5 (am wiki path post-migration test) — single subagent (depends on R-B2)
- H-3 (doctor scan extension) — single subagent

### Wave J (parallel research / planning, no impl)
- ADR-0042 gates 1, 4, 5 — research subagent (browser secret strategy, SECURITY.md threat model, `am pair` design)
- ADR-0043 implementation plan — research + design subagent (hosted UI auth tiers)
- ADR-0036 finalisation — survey subagent (verify implementation parity, propose acceptance gate)
- ADR-0034/0035/0037/0038/0039 triage — single subagent surveys current state of each

### Wave K (only proceed after user OK)
- Implementation of ADR-0042 / 0043 / 0036 / shim ADRs based on Wave J research output.

### Wave L (final)
- ROADMAP infrastructure (H-4 coverage metrics, H-5 Windows CI, H-6 optionalDeps).

---

## Concurrent review team

A separate review team runs alongside Waves C, H, I — looking for new
issues, regressions, and additions to backlog. Each waves' artifacts
are reviewed by 3 cross-family reviewers (per `parallel-critique`
skill), feeding back into this audit doc as new R-* entries.

## Budget guardrails

- Max 5 waves in this loop before user checkpoint.
- Estimated cost: ~$8-15 OpenRouter total.
- Estimated wall-clock: 2-4 hours.
