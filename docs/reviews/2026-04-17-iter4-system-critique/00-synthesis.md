# Iter4 System Critique — Synthesis

**Date:** 2026-04-17
**Baseline:** agent-manager 0.5.0-rc1 (post-iter3 vision reframe).
**Method:** 6 parallel research agents covering new facets — structural coherence
after the reframe, agent auto-detection (user ask), MCP parallel tool calling
(user ask), undocumented pillars (user ask), live-smoke bug RCA, and
ACP/A2A-as-MCP-tools unification (user ask). Plus a live smoke against the
0.5.0-rc1 binary that surfaced 5 real bugs.
**Per-facet reports:** `01-system-structure.md` … `06-acp-a2a-mcp-tools.md`

## Scorecard

| # | Facet | Score | Headline |
|---|-------|------:|---------|
| 01 | System structure | 6.5/10 | Three independent apply pipelines (CLI/MCP/web), no admission layer, core→commands layer inversion. |
| 02 | Agent auto-detection | — (proposal) | 10 of 16 ACP agents derivable from existing adapters; 6 need `Bun.which`. Tiered cheap PATH + deep probe. |
| 03 | Parallel tool calling | **3/10** | Protocol parallelizes via Promise.all, business layer unguarded — NO mutex/semaphore anywhere. `am_apply` × 2 has the same shape as the 2026-04-15 wipe incident. |
| 04 | Undocumented pillars | — | 0 net-new standalone pillars. 3 underemphasized features (drift detection, session harvest, MCP Package Registry) + biggest naming inconsistency is catalog/config/repo. |
| 05 | Smoke bug RCA | — | Bug 1 needs structural fix (remove subcommand collision). Bugs 3–5 are small. Total ~4–6h. |
| 06 | ACP/A2A-as-MCP-tools | — | 10 concrete gaps. Recommend unified `am_agent_*` namespace. **Plus a new real bug**: `am_acp_session_cancel` only rm's the dir, never calls `conn.cancel`. |

**Overall iter4 meta-finding:** the iter3 vision reframe landed the right
boundaries, but the code underneath has never been *restructured* around them.
Three independent implementations of apply, zero concurrency control, four
sites with hardcoded `"0.1.0"`, layer inversions in the shared core — all
because we kept adding without refactoring the spine.

## Cross-Cutting Themes

### Theme L — "Three independent pipelines, one dream"

R1's top finding, confirmed by R3 and R5:

- **Apply pipeline implemented 3x**: `commands/apply.ts`, `mcp/server.ts`, `web/server.ts` each reload config + decrypt + detect + export.
- **Add-server RMW implemented ~20x**: every command that mutates the catalog reimplements `tryReadConfig → mutate → writeConfig → commitAll`. 9 of 23 sites handle `isNothingToCommitError`, 14 don't.
- **Version string hardcoded 4x**: `src/mcp/server.ts:2285`, `src/adapters/community/proxy.ts:170` (maybe), `src/web/server.ts:136`, `src/web/worker.ts:171` — iter3 AM_VERSION was *supposed* to unify these but only migrated 3 sites.

These aren't separate bugs — they're one refactor waiting to happen. R1's
recommended fix: `core/controller.ts` exposing `withConfig(fn, {commitMessage})`
and `applyResolved(resolved, adapters, opts)`. ~800 LOC of duplication → ~400
LOC shared. Gives locking a natural home (Theme M) and gives version a single
source of truth (Theme N).

### Theme M — "No mutex means 2026-04-15 will happen again"

R3's finding: concurrency safety is 3/10 because the business layer has no
locks. Your own 2026-04-15 incident (global ~/.claude.json wiped) is the
exact failure mode: two callers read old state, both write "their" merge,
one wins. Atomic writes save bytes but not merges.

**Top 3 hazards:**
1. `am_apply` × 2 → racing merge into `~/.claude.json`.
2. `am_add_server` / `am_remove_server` / `am_import` / `am_registry_install` racing each other → lost-update silently deletes servers.
3. `am_wiki_harvest` concurrent → MiniSearch index corruption.

**Fix:** per-server AsyncMutex in `McpServer`, tool classification into
`read-only | config-writer | wiki-writer | git-writer`. Read-only stay
parallel, writers in same category serialize. Needs 5 concurrency tests
in `test/mcp/concurrency.test.ts` — zero exist today.

### Theme N — "Version drift between 0.1.0 and whatever we actually built"

R5 + R1 + smoke converge: 4 sites still hardcode `"0.1.0"`:
- `src/mcp/server.ts:2285` → `serverInfo.version` on MCP initialize
- `src/web/server.ts:136` + `src/web/worker.ts:171` → `GET /api/health`
- Possibly `src/adapters/community/proxy.ts:170` (am→adapter handshake version)

Plus the cosmetic build.ts `'"${version}"'` shell-quote leak that turns
`--version` output into `"0.5.0-rc1"` with literal quotes.

This is "declared-but-not-enforced" theme (iter2 Theme A) striking again.
Fix is a CI invariant test: every wire-advertised version MUST equal
`AM_VERSION`. Would have caught all 4 in one PR.

### Theme O — "Auto-detection unlocks pillar 3"

R2's finding: every IDE our adapters already detect is also an ACP host
(10 of 16 agents). We can derive `{installed, version}` for the unified
registry from existing adapter `detect()` results — no new code for 10
agents. Only 6 need a fresh `Bun.which` helper.

**Why this matters to the vision:** you said "we want to make sure that
every agent can call/delegate/collaborate with other agents however
they'd like." Today `am agent list` shows 17 agents but 15 may not be
installed — the user runs `am run claude` and gets a silent npx fetch.
With auto-detection, the table distinguishes present from nominal, and
`am run <agent>` can fail fast with a "not installed — run `npm i -g
foo`" hint.

### Theme P — "MCP mode for ACP/A2A is half-built"

R6's finding: we have `am_run_agent` and `am_agent_delegate` and
`am_acp_*` but:

- **`am_acp_session_cancel` doesn't cancel** — it rm -rf's the persisted session dir but never calls `conn.cancel`. The tool name lies. New bug.
- **No streaming** — ACP prompt is streaming, A2A sendSubscribe is SSE; MCP tools/call returns one result. MCP has `notifications/progress` with a `progressToken` — not wired up.
- **No unified `am_agent_invoke`** — today consumers must know if an agent is ACP or A2A and pick the right tool. Unify: one `am_agent_invoke` routes based on agent source.
- **Namespace is mixed** — `am_acp_list_agents` returns the unified registry (misnamed), separate from `am_agent_list` which is A2A-only (also misnamed per iter2).
- **No per-agent ACL** — any MCP client that auths once can invoke any agent. Probably fine for local trust, but worth explicit "all-or-nothing" stamp.

R6 recommends a migration: introduce `am_agent_invoke` + `am_agent_session_*`
unified namespace in 0.5.x, keep old tools as deprecated aliases until 0.6.

### Theme Q — "Underemphasized features hurt the pitch more than unnamed pillars"

R4's counterintuitive finding: no net-new standalone pillars, but three
shipped features deserve H2-level README placement they don't have:

1. **Drift detection** (ADR-0006, 100% adapter coverage) — this IS the
   answer to "my tool config got wiped / drifted from my catalog."
   Buried under "CLI Reference H2" in README. Should be pillar 1's
   first bullet after "define once."

2. **Session harvest** (ADR-0016) — the *only* cross-tool read-side
   pipeline feeding pillar 5 (wiki). All other adapters only *write*.
   Undocumented in the pillar 1 blurb. Name mentioned once in the
   matrix.

3. **MCP Package Registry** (ADR-0024) — has its own command group in
   `src/help.ts` ("Registry commands"), its own ADR, its own MCP tool
   group. ADR-0031 folds it invisibly into pillar 1. Either name it as
   sub-pillar 1.3 or let it be its own thing (but not both).

Plus the naming mess: the thing we call "catalog" in README + ADR-0031
is "config"/"config.toml"/"AM repo"/"repo" across ~30 ADRs, ~17
catalog-mentions vs hundreds of config-mentions in src/. R4 recommends
ADR-0032 as a glossary.

## Severity-Aggregated Top 15

Ranked impact × likelihood × pillar-risk:

1. **`am run <agent> <prompt>` is unusable** — M2 left subCommand collision. Pillar 3 unreachable from CLI. (smoke bug 1, R5 CRITICAL)
2. **`am_acp_session_cancel` doesn't cancel** — name lies. (R6 CRITICAL)
3. **`am_apply` concurrent race** — identical shape to 2026-04-15 wipe. (R3 CRITICAL)
4. **3 apply pipelines duplicate ~800 LOC of logic.** (R1 HIGH)
5. **~20 RMW sites with no locking, inconsistent commit handling.** (R1 HIGH)
6. **Hardcoded `"0.1.0"` in 4 sites, `--version` has literal quotes.** (R5 + R1 HIGH)
7. **Zero concurrency tests.** (R3 HIGH)
8. **No agent auto-detection — pillar 3 surface lies about availability.** (R2 HIGH)
9. **No streaming support for ACP/A2A over MCP.** (R6 HIGH)
10. **core/merge.ts imports from commands/import.ts; commands/use.ts is imported by core.** Layer inversion. (R1 MEDIUM)
11. **Drift detection / session harvest / MCP Package Registry under-promoted.** (R4 MEDIUM)
12. **Catalog/config/repo naming inconsistency.** (R4 MEDIUM)
13. **`am run session list` requires agent positional.** (smoke bug 2, R5 MEDIUM)
14. **`am agent list --json` omits protocol field.** (smoke bug 4, R5 MEDIUM)
15. **`am_agent_list` / `am_acp_list_agents` misnamed.** (R6 MEDIUM)

## Fix Wave Plan

Phase 3 dispatch. File-conflict analysis → 4 parallel waves safely.

### Wave A — Smoke bug fixes (1–2h)
Scope: bugs 3–5 (small); Bug 1+2 (bigger, restructures `run` subcommands).
Files: `src/mcp/server.ts`, `src/web/server.ts`, `src/web/worker.ts`,
`src/commands/run.ts`, `src/commands/agent.ts`, `scripts/build.ts`,
tests.
Unblocks: Users can actually invoke agents from CLI.

### Wave B — `core/controller.ts` + locking (3–4h)
Scope: R1's "one change" recommendation + R3's AsyncMutex.
Files: NEW `src/core/controller.ts`, NEW `src/core/locks.ts`, refactor
`src/commands/apply.ts` + `src/mcp/server.ts` + `src/web/server.ts` to call
it. Migrate 20+ RMW sites to `withConfig(fn)`. Tool classification in
mcp/server.ts. 5 new concurrency tests.
Unblocks: eliminates the 2026-04-15-class bug permanently.

### Wave C — Agent auto-detection (2h)
Scope: R2's tiered implementation.
Files: NEW `src/core/agent-detection.ts`, extend `src/core/agent-registry.ts`
`UnifiedAgent` type with `installed` + `version`, wire into `listAllAgentsAsync`,
add `am agent detect` command.
Unblocks: pillar 3 usability — `am agent list` shows what's real.

### Wave D — ACP/A2A-as-MCP-tools unification (3h)
Scope: R6's migration. New `am_agent_invoke` + `am_agent_session_*`. Fix
the `am_acp_session_cancel` cancel-without-cancel bug. Wire `notifications/progress`
for streaming. Deprecate old tool names with alias routing.
Files: `src/mcp/server.ts`, `src/protocols/acp/client.ts` (cancel bug).
Unblocks: pillar 2 × pillar 3 — consuming agents get a coherent surface.

### Wave E — README + AGENTS.md + CLAUDE.md pillar emphasis (1h)
Scope: user's explicit ask. Promote drift detection + session harvest + registry
per R4. Fix catalog/config naming. Add AGENTS.md (doesn't exist) and
CLAUDE.md (repo-root-level, doesn't exist — vault has one but not the
agent-manager repo). Draft ADR-0032 glossary.
Files: README.md, AGENTS.md (new), CLAUDE.md (new), ADRs/0032-*.md (new).
Unblocks: the pillars actually get enforced as tenets for all future work.

### Wave F — Final (20 min)
Tests + commits + push + log.

## Recommended Wave Order

Sequential:
- A (bug fixes, unblocks smoke confidence)
- B (controller extraction — invasive; all other waves benefit from it landing first, but could also run in parallel with C and D if we're careful)
- C + D can parallelize after B lands since they touch different areas
- E + F sequential at end

Practical call: run A inline (fast), launch B + C + D in parallel (different
primary file sets), then E + F.

Wave B touches `src/commands/apply.ts`, Wave D touches `src/mcp/server.ts`,
Wave C touches `src/core/agent-registry.ts` and adds new files. Overlap is
minimal; each can mostly add rather than rewrite shared surfaces.

## Deferred (not this iteration)

- Drift-detection promotion to CLI — `am drift` as own command? (currently embedded in `am status`)
- `am session` daemon mode (auto-harvest without manual trigger)
- Multi-catalog support (one am, many repos)
- RBAC / multi-tenancy for the Cloudflare worker (ADR-0031 says no until post-1.0)

## Recommendation

Waves A + B + C + D + E + F should all land in this session if parallelism
holds. Post-landing: tag `0.5.0-rc2`. No 1.0 until beta feedback on the
reframed pillars + auto-detection + unified agent tool.
