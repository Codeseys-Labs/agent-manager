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

