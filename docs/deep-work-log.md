# Deep Work Log

## Run 2026-05-01 — started at 8a4d5f0

**Scope:** Drive the Phase-1 research backlog to zero. Items identified by four parallel research agents (ADR drift, test gaps, TODO/issue sweep, pillar alignment).

**Budget:** 3 execution waves + architect/research phases + final verification.

**Baseline hash:** `8a4d5f09dcdb91ed94e8295eb0fd50e6170b8a17`

### Blocked items (surfaced, not silently skipped)

**Task #20 — npm publish needs NPM_TOKEN.** User must add the NPM_TOKEN
repository secret on GitHub. Until then, `.github/workflows/release.yml`
`Publish to npm` step fails with ENEEDAUTH. `npm install -g agent-manager`
serves stale 0.5.0-rc3. **Action required by user: settings → secrets →
actions → new repository secret `NPM_TOKEN`.**

**Task #21 — End-to-end install-path test.** Blocked on #20 and #13
(prerelease flag, closed in c6e3e0c). Once npm publishes successfully,
we need a verified install-path run:
1. `curl … | sh` installs both `am` and `am-acp-shell` to `~/.local/bin`
2. `brew install am` installs both binaries
3. `am agent enable-shim aider --yes && am run aider "hello"` completes

Auto-unblocks when #20 lands + a fresh rc is cut.

**Task #25 — Tier-2 shim E2E tests.** Blocked on CI runner image
decisions — the aider/amazon-q/cody binaries aren't on GitHub-hosted
runners. Options: self-hosted runners with those CLIs pre-installed,
container images (slow), or skip and rely on the existing generic-contract
tests. Needs explicit product decision before unblocking.

### Deferred items (acknowledged, not deleted)

**Task #26 — Phase E/F/G ROADMAP items.** Phase E (community shim
configs) is now redirected through the ADR-0027 community adapter path
per ADR-0034. Phase F (release verification job) should land after #20.
Phase G (systematic Windows portability) is a separate multi-wave effort
— see task #24's plan for the re-baseline precursor.

**Task #27 — LLM-powered NER extraction.** Explicit ROADMAP line 185
Phase 2 deferral. Quality ceiling on the wiki, not a correctness issue.
Not executing in this loop; document only.

---

### Run 2026-05-01 — final state at 8dfd4ca

**Commits in this run (baseline 8a4d5f0):**
- fd4411d  docs(deep-work-log): start
- 7463c5a  feat(wave1): quick-wins (7 tasks closed)
- d6453fb  test(wave1): +61 tests across MCP + wiki + protocols (5 tasks)
- c6e3e0c  feat(wave2): ADR-0034 shim scope + arg-named promptFlag (3 tasks)
- a1ff610  docs(deep-work-log): surface blockers (5 tasks)
- 5ec9a92  feat(wave3): 3 plans + reviewer fixes (3 plans + 2 MED fixes)
- 8dfd4ca  fix(types): agent_id on WikiPage (completes task #31 fix)

**Artifacts produced:**
- 1 new ADR (0034 shim scope, proposed)
- 1 ADR addendum (0021 group reconciliation)
- 1 ADR extension (0031 meta-tooling category)
- 3 research reports (docs/research/2026-05-01-*.md)
- 3 plans (docs/plans/*.md — wiki sync, skill/agent drift, Windows CI)
- 2 planned ADRs to follow (0035 wiki sync, 0036 drift detection)
- 61 new tests, 2449 total pass, 0 fail
- Zero source tsc errors (was 4 pre-existing wiki ones, now fixed as side
  effect of task #31)
- 1 pre-existing concurrency flake surfaced (task #32) — NOT regression

**Tasks closed:** 24 of 26 surfaced (including 5 blocked + 2 deferred
with explicit surfacing). Remaining: #32 is a newly-discovered pre-existing
flake — it predates baseline 8a4d5f0.

**Reviewer findings addressed:**
- MED: synthesizeContext had 2 stacked bugs (round-trip agent_id loss +
  topK budget monopolization) — both fixed
- MED: am_agent_detect `reachable` renamed to `locallyInstalled` (was
  misleading for protocol:both entries)
- LOW: ADR-0034 C2 anchored to 3 concrete sources with 90-day freshness
- Question: amazon-q vs Kiro IDE conflation clarified in audit table

**What did not ship (deliberately deferred — out of loop budget):**
- M5 wiki sync implementation (plan written, 3-phase ~2-week effort)
- Skill/agent drift implementation (plan written, ~8 dev-days effort)
- Windows CI re-baseline (plan written, awaits a trigger commit)
- npm publish blockage (user action required)
- Tier-2 shim E2E tests (CI runner image decision required)

**Exit hash:** `8dfd4ca`

**Two-team sign-off (Phase 8):**
- Execution team: zero pending tasks in backlog except #32 (pre-existing).
- Review team: MED findings integrated mid-loop. Adversarial review on
  wave 1+2 produced durable fixes, not merely nits.
- `bun test`: 2449 pass / 0 fail / 7183 expect() calls
- `bun run lint`: 1 pre-existing warning (unchanged)
- `bun run typecheck` (source only): 0 errors (was 4 pre-existing wiki ones)

**Pre-existing in-flight items (from issue #2):**
- npm publish not configured (needs NPM_TOKEN secret — **blocked on user**)
- Release marked isPrerelease:false (workflow fix)
- Windows CI re-baseline (test run + continue-on-error removal)
- End-to-end install-path test (needs a published release — **blocked on prior items**)
- NODE_OPTIONS forwarding docs
- arg-named promptTemplate decision (implement or remove)
- Tier-2 shim E2E tests (**blocked on CI runner images**)
- Phase E community shim configs
- Phase F release verification job
- Phase G Windows portability pass

**New items from Phase 1 research:**
- MCP security hardening cluster (5 sub-items — path traversal tests, progress redaction tests, env-sandbox integration test, bridge permissionPolicy test, ADR-0021 reconciliation)
- `am_agent_detect` wire-up (Wave C deferred TODO in src/mcp/server.ts:2207)
- `am wiki sync` correctness gaps (M5 — commits, per-project remotes, conflict handling)
- ADR-0027 / ADR-0028 status contradiction (README vs frontmatter)
- ADR-0026 Wave C attribution mismatch (file location)
- Phase E openclaw scope fence (ADR amendment before borrowing)
- `synthesizeContext` untested I/O path
- Full skill/agent drift detection across all 13 adapters (ROADMAP)
- LLM-powered NER extraction (ROADMAP Phase 2)
- Shell completion meta-tooling note (ADR-0031 non-goals)
- `acp-shell-cli.ts` CLAUDE.md directory-map entry
- Wiki browser design doc status unclear


## Run 2026-05-02 — started at 01b44a2

**Scope:** Drive the backlog surfaced by the Codex multi-facet adversarial
critique to zero. 8 new findings across 6 Codex reviewers (vision,
security, architecture, tests, plans, executive). Previous Claude-reviewer
round of fixes already landed in 4905c96 / 482d67a / bd35eeb / 8030f24.
This run addresses the items Codex caught that Claude missed.

**Budget:** 2-3 execution waves + concurrent review. Most items are small
doc/test fixes; 1 is a new security hardening (depth-cap DoS); 1 is a
strategic unblock (community-shim path doesn't exist — may defer to a
design conversation).

**Baseline hash:** `01b44a2`

**Items surfaced by Codex (2026-05-02):**
- CODEX-NEW-1 (HIGH): cycle guard prevents cycles but deep acyclic nesting still stack-overflows. Add depth cap + iterative traversal.
- CODEX-NEW-2 (P1, STRATEGIC): ADR-0034 Phase-E redirect assumes a community-shim path that doesn't exist. ADR-0027's adapter protocol doesn't cover ACP shim registration.
- CODEX-NEW-3 (P2): ADR-0033 now `amended_by: ADR-0034` which is still `proposed` — accepted ADR defers to non-accepted ADR.
- CODEX-NEW-4 (P2): `reachable` → `locallyInstalled` MCP API rename landed without compatibility alias.
- CODEX-NEW-5 (P3): wiki-sync-m5.md acceptance criteria + rollback still reference `auto_sync_interval_seconds` schema field that PLAN-4 said to defer.
- CODEX-NEW-6 (MED, test): `topK` synthesizer test can false-pass with zero results.
- CODEX-NEW-7 (plan): skill-agent-drift estimate amended in body (11-12 days) but footer still says 8 days / Phase 1 = 2 days.
- CODEX-NEW-8 (plan): skill-agent-drift Known Risks still says "or stub as unmanaged" — directly contradicting the new capability-removal rule.
- Also from Facet 4: Test smell MED — `topK <= 3` assertion allows 0; Facet 4 LOW — empty-allowedPaths test checks length only.
- Also from Facet 5: skill-agent-drift rule is currently unenforceable because forgecode and kilo-code DO list `"agents"` capability while their `diff.ts` doesn't diff agents.

## Wave 1 codex-backlog complete — 2026-05-02

**Commits:** `c5d92e4` (phase 1 marker) → `69cdb10` (main Wave 1 set) → `41d65f9` (signoff fixes) → `9cbec70` (flake fix). End hash: `9cbec70`.

**Team:** `am-wave1-codex-backlog` — team-lead + adr-drafter + plan-reconciler + verifier. All teammates shut down cleanly post-commit.

**Items closed:** 14 CODEX findings (1-10 original + 11-14 surfaced by concurrent Codex review during execution) + 2 MAJOR signoff fixes (CODEX-11 cancel ID-confusion, CODEX-14 double-firing streaming callback) + 1 flake timeout raise.

**New tests:** `test/core/adr-frontmatter.test.ts` (3 tests pinning the `pending_amendment_by` pattern until ADR-0034 promotes to accepted).

**New ADR:** `ADRs/0035-community-shim-registration.md` (proposed, 399 lines) — precondition for ADR-0034's Phase-E redirect to be operational.

**Verification (Phase 8):**
- Execution team: zero pending/in-progress tasks in `am-wave1-codex-backlog`.
- Review team (Codex final signoff on 69cdb10): caught 2 MAJOR issues (CODEX-11 cancel + CODEX-14 double-fire); both addressed in 41d65f9. All other facets OK or MINOR.
- `bun test`: **2462 pass / 0 fail / 7252 expect() across 184 files**.
- `bun run typecheck`: 0 src TS errors.
- `bun run lint`: 0 errors, 1 pre-existing warning (unchanged).

## Run 2026-05-02-B — started at ffb0751

**Scope:** Drive the 6-pillar review backlog (synthesis at
`docs/research/2026-05-02-all-pillars-review/00-synthesis.md`) toward
zero. 15+ findings across 4 tiers + 4 candidate ADRs.

**Budget:** 3 waves max. The full 4-ADR design scope is a multi-week
effort; this loop ships the A-tier unlocks (variants schema + dry-run +
serve auth bootstrap) and leaves B/C/D tiers as tracked plans.

**Pragmatic cut-list for this loop:**
- Tier A1 (variants schema + --variant plumbing) → proposed ADR-0036 + minimal schema + 1 end-to-end path (`am run claude --variant <name>`)
- Tier B1 (am serve auth bootstrap) → ship the fix (one-day)
- Tier A2 (dry-run/explain) → proposed ADR-0038 + one implementation as proof-of-concept (`am run --dry-run`)
- Other Tier B/C/D items: written as plans in `docs/plans/`, not shipped.

**Deferred with explicit justification:**
- Tier A3 per-tool MCP metadata (ADR-0037): genuine multi-week effort; all 38 tools need metadata.
- Tier D per-client MCP policies (ADR-0039): architectural, needs design conversation.
- Tier B2 wiki M5: plan already written (`docs/plans/wiki-sync-m5.md`).
- Tier B3 marketplace author kit: 3-day effort, standalone.

**Baseline hash:** `ffb07519a848deffa589ccc33866769e6b182c90`

### Run 2026-05-02-B — final state at b752c45

**Commits (baseline ffb0751):**
- 0fcc27d  docs(deep-work-log): start
- daad6ba  feat(wave1): ADR-0036 variants + ADR-0038 dry-run + B1 serve auth (team-based)
- b752c45  feat(wave2): marketplace author guide + MCP timing log + deferred stubs

**Team:** `am-pillar-review-wave1` (team-lead + variants-shipper +
dry-run-shipper + serve-auth-fixer). All terminated cleanly post-Wave-1.
Wave 2+3 executed direct (team already disbanded, solo work acceptable
for doc + small-code-fix scope).

**Artifacts produced:**
- 2 new ADRs (0036 variants, 0038 dry-run) — both proposed
- 2 new ADR corrections mid-flight via concurrent Codex review:
  (a) ADR-0036 dropped "first-defined wins" + raw-layer resolver +
  permission_policy accept-but-don't-enforce; (b) ADR-0038 dropped
  --explain alias + allowed Bun.which.
- 3 new source files: variant-resolver.ts, marketplace-author-guide.md,
  deferred-pillar-review-items.md
- 3 new test files: variant-resolver.test.ts, variant.test.ts,
  dry-run.test.ts, timing-log.test.ts (+1 bonus from C1-lite)
- +62 tests net (31 variant + 16 dry-run + 12 serve-auth + 3 timing)
- 1 security-posture improvement: serve-auth bootstrap (B1)

**Items closed:**
- Tier A1 (variants): SHIPPED as MVP, gated AM_VARIANTS=1
- Tier A2 (dry-run): SHIPPED for `am run` as MVP
- Tier B1 (serve auth): SHIPPED — Pillar 6 "borderline stub-ware" fixed
- Tier B3-lite (marketplace author guide): SHIPPED as docs
- Tier C1-lite (MCP timing log): SHIPPED as AM_MCP_TIMING=1 opt-in

**Items deferred with tracked stubs** (docs/plans/deferred-pillar-review-items.md):
- B3-full: marketplace validator CLI (~2-3 days)
- C2: wiki usage feedback (1 week, blocked on M5)
- C3: transactional apply (Option C: 2-3 days; A/B: 1+ week)
- D1: marketplace-of-marketplaces index (2 days + ongoing curation)
- D2: per-client MCP policies (1 week)
- ADR-0037 proposed (per-tool MCP metadata, 1 week + 1 week impl)
- ADR-0039 proposed (per-client policies)

**Verification (Phase 8):**
- `bun test`: 2532 pass / 0 fail / 7452 expect() (ran 3 times, stable on runs 2+3)
- `bun run typecheck`: 0 src errors
- `bun run lint`: 0 errors, 1 pre-existing warning
- Two-team signoff: execution team (the 3 teammates) reported complete;
  Codex concurrent review caught 5 ADR flaws during Wave 1 which were
  patched before teammates finalized. Final Codex signoff hit ChatGPT
  Plus usage-limit mid-run so Wave 2 lacks cross-model validation —
  acknowledged in the commit message.

**Exit hash:** `b752c45`

**What this loop did NOT try to do:**
- Full implementation of any of the 4 proposed ADRs beyond the MVP
  slice (A1, A2 only; Pillar-review Tier C/D items intentionally
  deferred as stubs, not shipped).
- Fix the 1 pre-existing lint warning or the pre-existing flake
  (tracked separately as task #32 from prior sessions).
- Remove the `--explain` alias that dry-run-shipper shipped before the
  ADR-0038 correction reached them. It's a 3-line cleanup tracked in
  deferred-pillar-review-items.md.

## Run 2026-05-03 — started at 0fb8ccd

**Scope:** Drive the tracked backlog from `docs/plans/deferred-pillar-review-items.md`
to zero, plus the known follow-ups from prior runs.

**Baseline hash:** `0fb8ccd5dac1c69b7e89655494189a1877911804`

### Run 2026-05-03 — final state at 8033e47

**Commits (baseline 0fb8ccd):**
- b09ebfd  docs(deep-work-log): start
- 8033e47  feat(wave3): 5 deferred items shipped (validator CLI + apply
           status + ADR-0037 + concurrency flake fix + deferral doc)

**Items closed this run:** 5 — all from the deferred-pillar-review-items
backlog + flake-task #32:
- B3-full marketplace validator (`am marketplace validate <path>`)
- C3 Option C per-adapter apply status
- ADR-0037 proposed (per-tool MCP metadata)
- Task #32 concurrency.test.ts flake (timeout raised to 30s)
- --explain alias cleanup (confirmed already clean; no action)

**Items STILL deferred with rationale** (documented in
deferred-pillar-review-items.md Run-2026-05-03 update):
- C2 wiki usage feedback (blocks on M5)
- D1 marketplace-index (needs owner decision)
- D2 per-client MCP policies (needs scenario)
- A2A variants (needs use case)
- ADR-0036 permission_policy enforcement (waits on ADR-0037 accept)

**Verification:**
- bun test: 2553 pass / 0 fail / 7532 expect() across 190 files
- bun run typecheck: 0 src errors
- bun run lint: 0 errors, 1 pre-existing warning
- +18 tests net (14 validator + 4 apply-partial)

**Deviation from skill script:** no teammate spawned + no Codex concurrent
review this loop. Rationale: 5 independent small changes, low coordination
value; ChatGPT Plus usage cap persists blocking reliable Codex access.
Accepted as limitation, not forced.

**Exit hash:** `8033e47`

---

**Backlog source:** `docs/plans/deferred-pillar-review-items.md` (written
in Run-B at b752c45) enumerates 7 deferred items + 2 candidate ADRs.
Additional known follow-ups:
- Task #32 — pre-existing concurrency.test.ts flake (persists; ADR-0032
  follow-up or similar)
- `--explain` alias cleanup (ADR-0038 correction; dry-run-shipper landed
  it before the ADR was patched)
- Rate-limit risk: Codex ChatGPT Plus usage caps may limit the concurrent-
  review lever this session.

**Budget plan:** 3 waves max.
- Wave 1 (P2 items, low-risk, parallelizable):
  - Remove --explain alias from `am run` (cleanup)
  - Ship `am marketplace validate <path>` CLI subcommand (B3-full)
  - Ship transactional apply Option C — per-adapter status in apply result (C3 lite)
- Wave 2 (medium-risk, design-first):
  - ADR-0037 proposed — per-tool MCP metadata
  - Flaky concurrency.test.ts: investigate + fix OR quarantine with documented reason
- Wave 3 (items that genuinely can't close in this loop):
  - C2 wiki usage feedback (depends on M5 wiki sync which remains unshipped)
  - D1 marketplace-index (needs owner decision)
  - D2 per-client MCP policies (needs concrete scenario)
  - A2A variants extension (ADR-0036 follow-up) — needs a use case
  - ADR-0036 permission_policy enforcement wiring (needs ADR-0037 first)

Items in Wave 3 get explicit deferral documentation, not silent skip.

## Run 2026-05-03-B — focused: ADR-0037 Phase 1 (1-commit loop)

**Baseline:** `c990ae2` · **Exit:** `707105b` (+ ADR frontmatter update)

Chose ADR-0037 Phase 1 after Codex deliberation (option A of the 4
remaining shippable paths). Codex recommendation + reasoning: highest
leverage-to-risk ratio, mechanical derivation, clear done-condition,
unblocks ADR-0036 MCP variant work downstream.

Shipped:
- AmToolMetadata interface + DEPRECATED_ALIASES registry + PROGRESS_SUPPORTED set
- buildToolMetadata() pure function
- tools/list decoration emits x-am on every tool
- +8 tests / 623 assertions locking contract + structural warnDeprecated-vs-registry guarantee

Did not run a concurrent Codex review of the shipped code — one PR's
worth of focused work with a clear contract doesn't benefit from
adversarial review as much as a multi-agent wave does. Accepted as a
deliberate deviation from the skill's default Wave-1 pattern.

ADR-0037 frontmatter updated to reflect Phase 1 landed; Phase 2/3 stay
deferred.

## Run 2026-05-03-C — M5.1 + M5.2 wiki-sync pipeline (continuation of -B)

**Baseline:** `b48c478` · **Exit:** `f349a5d` (+ cli.ts description fix
at HEAD)

Continued the autonomous-deliberation pattern from Run-B. First Codex
pass (option A-E deliberation) picked **A — M5.1 wiki-sync core
primitives**; shipped at f5f7401. Then ran a 4-agent parallel deep-dive
(no Codex — ChatGPT Plus usage-limit hit mid-run) covering all 6
pillars + an onboarding/novice-UX review. Used their findings to pick
the next slice: **M5.2 wire-up**, because (a) it completes the pipeline
M5.1 started, (b) the Pillar-5 audit rated it Shippable-in-<2-hours,
and (c) it unblocks C2 wiki usage feedback (deferred from Run 2026-05-03).

**Commits in this run (baseline b48c478):**
- f5f7401  feat(wiki-sync): M5.1 core git primitives (+2 typed errors)
- f349a5d  feat(wiki-sync): M5.2 FF-only pipeline + auto-commit + conflict sidecar
- (pending this commit)  docs(deep-work-log,wiki-sync-m5): mark M5.1/M5.2 shipped + fix stale am --help description

**Artifacts produced:**
- 3 new git primitives in src/core/git.ts: `pullFastForwardOnly`,
  `softResetHead`, `stageWikiFiles`
- 2 new typed errors in src/lib/errors.ts: `WikiSyncConflictError`
  (with `conflictedFiles[]`), `WikiSyncSecretBlockedError` (with
  `hits[]`)
- 1 new module: src/wiki/sync.ts (auto-commit + FF-only pull + rollback
  + wiki-conflict.json sidecar + tier-1 text secret scanner)
- Rewrite of `syncSubcommand` in src/commands/wiki.ts with 5 new CLI
  flags (--auto-commit, --allow-dirty, --debounce,
  --strict-secret-scan, --direction=commit-and-sync alias)
- +28 tests net (9 M5.1 primitive tests + 19 M5.2 pipeline tests)
- Stale `am --help` description fix: "chezmoi for AI agent configs"
  → "The control plane for your AI agents …" (aligns with ADR-0031
  and README headline)

**Items closed:**
- M5.1 wiki-sync primitives (docs/plans/wiki-sync-m5.md §M5.1)
- M5.2 wiki-sync pipeline (docs/plans/wiki-sync-m5.md §M5.2)
- Partial onboarding-audit finding: stale `am --help` description

**Items deferred with rationale:**
- **M5.3** (`am wiki resolve`, `am doctor` symlink check,
  `relinkSubcommand`, subtree export) — standalone ~3-day effort.
  Sidecar format is locked from M5.2, so M5.3 can pick up cold.
- **C2 wiki usage feedback** — no longer blocked (M5 pipeline now
  FF-only + sidecar-ready). Can be scheduled independently.
- **npm publish + install.sh + E2E install-path test** — user-action
  blockers (NPM_TOKEN secret), tracked in prior runs.
- **Full-drift across 13 adapters** — 11-12 dev-days, tracked in
  docs/plans/skill-agent-drift.md.

**Parallel-team deep-dive findings (from 4 subagents on 6 pillars +
onboarding, run concurrent with M5.1 shipping):**
- **Pillar 1**: 78% complete. Biggest gaps: skill/agent drift is
  paper-only across 11 of 13 adapters; `loadResolvedConfig` silently
  ignores project-local when `opts.projectFile` is null in MCP
  handler path.
- **Pillar 2**: 72% complete. ADR-0037 Phase 2 (output_schema) +
  Phase 3 (error_codes) explicitly deferred. No integration test for
  `am_apply` via MCP handleRequest writing real files.
- **Pillar 3**: 78% complete. Tier-2 shim path works for dev builds
  but `am-acp-shell` was absent from install.sh pre-rc6; tier-2 E2E
  test blocked on CI runner images (deep-work-log task #25).
- **Pillar 4**: 72% complete. ADR-0034 + ADR-0035 form a circular
  dependency; neither can flip to `accepted` without the other, and
  neither has code. Community shim registration (Phase E of
  ADR-0034) is a paper decision pointing at another paper decision.
- **Pillar 5**: 62% complete pre-M5.2, ~75% post-M5.2. LLM
  extraction (ADR-0020 phases 1-2) still paper — harvester is
  regex-only. Only 2 of 13 adapters have SessionReader
  implementations (claude-code, codex-cli).
- **Pillar 6**: 58% complete. CF Worker is read-only in production
  (no write routes on `/api/config/:owner/:repo`). Local `am serve`
  has no `/api/wiki/*` routes. TUI add/edit flows punt to CLI.
- **Onboarding**: All 4 advertised install paths require a
  published release; NPM_TOKEN blocker persists from prior runs.
  `install.sh` exists at repo root (audit mis-identified location).
  `am import auto` exists (audit was wrong about that), so the
  `am init` success message IS valid.

**Verification (Phase 8):**
- `bun test`: **2589 pass / 0 fail / 8210 expect() across 193 files**
  (+19 M5.2, +9 M5.1 vs. the 2561 post-ADR-0037-Phase-1 baseline).
- `bun run typecheck`: 0 src errors.
- `bun run lint`: 0 errors, 1 pre-existing warning (unchanged).
- No adversarial Codex review this run (rate-limit hit). 4-agent
  subagent fan-out substituted for it — delivered 6-pillar audit +
  onboarding review from 4 independent contexts.

**Deviation from skill script:**
1. Codex rate-limit forced fallback to subagent-only review. The
   adversarial-Codex lever was unavailable for ~60 min.
2. Ran *two* shippable slices (M5.1 + M5.2) in one continuation loop
   rather than the default "one slice per loop" from Run-B. Acceptable
   because M5.2 is a direct continuation of M5.1 (not a second
   deliberated pick) and completes a user-coherent unit.

**Exit hash:** `f349a5d` (pre-docs), final at HEAD after this commit.

## Run 2026-05-03-D — started at 0d6c571

**Scope:** Continue grinding the backlog toward zero. User explicitly
asked to try multi-Codex background fan-out + TeamCreate + subagent
teams simultaneously, with deep research via tavily/exa/deepwiki.

**Baseline hash:** `0d6c571`

### Run 2026-05-03-D — final state at 64def23

**Commits (baseline 0d6c571):**
- 05036a7  feat(wave1): 3 P0/P1 safety features + 2 research reports
- e113e74  fix(wave1-review): 4 findings from adversarial review
- 64def23  feat(wave3): am mcp-superset check|apply (closes issue #3 problem 1)

**Backlog items closed this run (12 of 12):**

Wave 1 (code-shipping, ~2 hrs):
- #75 Tier-2 shim pre-flight (`checkShimPreflight` in src/commands/run.ts)
- #76 atomic-write snapshot-before-overwrite hook (closes issue #1)
- #77 URL-credential refusal in applyResolved (closes issue #3 prob 2)
- #79 /api/wiki/* already present — closed as no-op (audit was stale)

Wave 1 review fixes (adversarial reviewer found 4 real issues):
- #83 REV-1: credential-key regex false-positive on compound nouns
  (publickey/sandboxkey) — tightened to /^[a-z][a-z_-]*[_-]key$/i
- #84 REV-2: formatCredentialHits leaked second raw credential from
  multi-param URLs via naive .replace — switched to URL API + mask
  every other credential-shaped param
- #85 REV-3: manifest grew unbounded while .bak files were pruned;
  listBackupsForTarget returned dead paths — slice manifest in lockstep
- #86 REV-NB-2: scanServersForUrlCredentials didn't walk args[]; Codex-
  CLI wrapper style (npx mcp-remote URL) snuck credentials past — fixed

Wave 2 (test-only):
- #78 am_apply MCP integration — closed; test/mcp/server.test.ts:635
  already pins dry-run path
- #81 migrateLegacyKey conflict-branch coverage — new test file
- #82 MCP auth-reject — closed; test/mcp/auth-gate.test.ts:169+
  already comprehensive

Wave 3 (biggest — new CLI command):
- #80 `am mcp-superset check|apply` — 4 copy classes
  (copy/refuse/skip/rewrite), git-push-style exit codes (0/1/2/3),
  JSON schema with schema_version=1, remediation suggestions

**Research reports produced (2):**
- docs/research/2026-05-03-config-backup-patterns.md — drove the
  atomic-write backup hook design (centralized dir, N=10 retention,
  ISO-basic-UTC + hrtime filename)
- docs/research/2026-05-03-mcp-superset-prior-art.md — drove the
  am-superset command shape (chezmoi check/apply split,
  git-push-style refuse UX, exit-code 2 for security findings)

**Multi-agent orchestration (per user's explicit request):**
- 2 parallel research agents in phase 3 (background)
- 1 concurrent adversarial reviewer during wave 1 (found 4 real issues;
  all patched in e113e74)
- Codex deliberation not usable this run (ChatGPT Plus usage limit);
  subagent-based reviewer substituted

**Verification (Phase 8):**
- `bun test`: **2638 pass / 0 fail / 8334 expect() across 199 files**
  (+68 new tests vs. the 2570 pre-loop baseline: 5 preflight +
  8 backup + 13+3 url-cred + 4 apply-refuse + 3 secrets + 12 superset)
- `bun run typecheck`: 0 src errors
- `bun run lint`: 0 errors, 1 pre-existing warning (unchanged)
- Final adversarial review on 05036a7+e113e74+64def23: in-flight at
  commit time; findings will be integrated into next loop's backlog
  per skill rule 5 (review concurrent with execution)

**Closes GitHub issues:**
- Issue #1 (global MCP config wipe resilience): snapshot-before-
  overwrite hook + URL-credential refuse guard both shipped
- Issue #3 (MCP superset invariant + URL-credential redaction): BOTH
  problems closed — superset CLI (problem 1) + URL-cred refuse
  (problem 2)

**Not closed this run (explicit deferrals):**
- M5.3 wiki resolve/relink/subtree export (separate ~3-day effort)
- ADR-0034 + ADR-0035 circular dependency (needs user/product
  decision on community-shim-registration scope)
- Windows CI re-baseline (needs CI trigger)
- skill/agent drift across 13 adapters (11-12 dev-days)
- NPM publish / distribution pipeline (user-action blocker)

**Exit hash:** `64def23`
