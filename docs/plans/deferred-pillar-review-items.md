---
status: deferred-plan-stubs
date: 2026-05-02
source: docs/research/2026-05-02-all-pillars-review/00-synthesis.md
purpose: Track items from the 6-pillar Codex review that were NOT shipped in Wave 1 (commit daad6ba). Each stub has enough info for a future session to pick it up cold.
---

# Deferred Items — 6-Pillar Review Backlog

The 2026-05-02 pillar review surfaced 15+ items across 4 tiers. Wave 1
shipped Tier A1 (variants), A2 (dry-run for `am run`), and B1 (serve auth
bootstrap). This file tracks the rest as lightweight stubs so the backlog
stays visible without bloating the main roadmap.

## B3-full: Marketplace validator CLI

**Pillar 4 §6.1.** B3-lite (the author guide) shipped at
`docs/marketplace-author-guide.md`. The FULL B3 includes a runtime
validator:

- `am marketplace validate <path>` — parses every `plugin.json`, checks
  schema shape (Zod), flags duplicate plugin names, unreachable file
  references (`prompt_file` paths), and missing required fields.
- Uses the same `PluginManifest` Zod schema as the installer for a
  single source of truth.
- Exit code 0 = valid; nonzero with structured JSON output listing
  failures at file-level granularity.

**Acceptance:** given a fixture marketplace repo, `am marketplace validate
./fixture` exits 0. Given a fixture with a missing `plugin.json`,
duplicate names, bad schema, or unreachable prompt_file, exits 1 with
a JSON error list keyed by plugin.

**Effort:** ~2-3 days.

**Blockers:** none. Can be a standalone PR.

## C2: Wiki usage feedback loop

**Pillar 5 §4, §6.2.** `am_wiki_synthesize` returns context but the
agent can't tell which pages were actually used or whether its own wiki
contributions have been consumed by other sessions.

- Extend `synthesizeContext` return value to include `included_slugs:
  string[]` — the slugs whose content made it into the returned context
  block.
- Add a `used_by_session` metadata field on `WikiPage` (ISO-8601
  timestamp + session ID). `synthesizeContext` appends to this list
  when it includes a page.
- Expose via `am wiki show <slug>` — "last used by: session-abc on
  2026-06-01".
- Optionally: MCP tool `am_wiki_mark_useful` for explicit agent feedback
  ("this page helped"); schema accepts it, storage records it, search
  rankings later factor it in.

**Acceptance:** after a session invokes `am_wiki_synthesize "X"`, running
`am wiki show` on any slug from the result shows the session ID and
timestamp in the metadata.

**Effort:** 1 week. Requires schema change to `WikiPage` + storage
round-trip (ADR-0036-style pattern the CODEX-3 fix established).

**Blockers:** none architecturally. Nice-to-have precondition: wiki M5
plan (sync correctness) landing first so the usage-log doesn't create
conflicts on multi-machine sync.

## C3: Transactional apply

**Pillar 1 §3.** Currently `applyResolved` runs adapter exports
sequentially. If adapter 5 of 13 fails, adapters 1-4's writes persist
and 6-13 are silently skipped.

- Option A (two-phase): pre-compute all writes into a staging area,
  validate all, then commit atomically. Heaviest but safest.
- Option B (journal + rollback): write forward, log each adapter's
  undo action to a journal, roll back on failure. Standard
  filesystem-transaction pattern.
- Option C (best-effort + structured error): log per-adapter success /
  failure; don't promise atomicity. Simpler. Report clearly.

**Acceptance:** `am apply` with a deliberately-broken adapter config
either (1) rolls back every adapter's changes OR (2) reports per-adapter
status clearly with `am apply --json` showing `{ adapter, status,
error? }` entries.

**Effort:** 2-3 days for Option C (pragmatic), 1+ week for A/B.

**Recommendation:** Option C first, as a stepping stone. Revisit A/B
when/if a user actually hits partial-apply corruption.

**Blockers:** none.

## D1: Curated marketplace-of-marketplaces

**Pillar 4 §4.** `am marketplace add` requires a URL. Discovery of
marketplaces worth subscribing to is word-of-mouth.

- A repo like `Codeseys-Labs/am-marketplace-index` with a
  `marketplaces.json` listing vetted community marketplaces (name, URL,
  description, plugin count, risk label: curated / community / unvetted).
- `am marketplace discover` fetches the index and shows a selectable
  list. `am marketplace add curated/<slug>` clones from the indexed URL.
- `am init` offers to subscribe the user to the curated index.

**Acceptance:** `am marketplace discover` returns the curated list
without the user knowing any URLs up front.

**Effort:** 2 days (CLI + index repo + docs). The hardest part is the
ongoing curation — needs a vetting rubric similar to ADR-0034's ≥3/5
gate but applied to marketplaces.

**Blockers:** the index repo needs an owner. Could ship as part of
Codeseys-Labs org; could also wait for community volunteers.

## D2: Per-MCP-client policies (multi-tenant gateway)

**Pillar 2 §4, §5.3.** Today one `am mcp-serve` process exposes one
tool surface. Two different AI clients (say, a coding agent + a CI
bot) plumb into the same server and see the same tools.

- Extend `settings.mcp_serve` to accept `client_policies:
  Record<string, McpToolGroup[]>`. Keys are bearer tokens (or token
  hashes); values are the tool groups that token can see.
- `tools/list` filters by the caller's bearer → different tokens see
  different surfaces.
- `tools/call` enforces the same filter.
- Default: single-tenant (current behavior) when `client_policies` is
  empty.

**Acceptance:** two tokens configured → two different `tools/list`
surfaces when invoked with each token → cross-token calls rejected with
`unauthorized: tool not in your policy`.

**Effort:** 1 week. Touches auth gate, tool-group resolution, settings
schema, and needs dedicated tests.

**Recommendation:** write a proposed ADR-0039 first (synthesis
identified this as ADR-worthy) before implementing.

**Blockers:** needs a concrete two-client scenario to pin the design.
Not urgent until someone has two agents with different trust levels
sharing an `am mcp-serve`.

## Candidate ADRs (not yet written)

### ADR-0037: Per-tool MCP metadata

**Pillar 2 §5.1.** `x-am.*` namespace for tool outputs, error codes,
progress support, deprecation info, authentication requirements.
Prerequisite for enabling `am_agent_invoke` to accept `variant` (ADR-0036)
and for any MCP client to robustly handle typed errors.

Estimated scope: ~500 lines of ADR + schema revision. All 38 tools
need metadata entries. 1-week effort for the ADR accept + 1-week
implementation.

### ADR-0039: Per-MCP-client policies

**Pillar 2 §4.** See D2 above. Establishes the multi-tenant gateway
model. Needs to decide: token-hash identity? Per-request scope
header? Interaction with existing `AM_MCP_TOKEN` single-token auth?

## Summary table

| Item | Pillar | Effort | Priority | Blocker |
|---|---|---|---|---|
| B3-full: Marketplace validator | 4 | 2-3 days | P2 | none |
| C2: Wiki usage feedback | 5 | 1 week | P2 | wiki M5 first |
| C3: Transactional apply (Option C) | 1 | 2-3 days | P2 | none |
| C3: Transactional apply (Option A/B) | 1 | 1+ week | P3 | evidence of need |
| D1: Marketplace index | 4 | 2 days + curation | P3 | owner needed |
| D2: Per-client MCP policies | 2 | 1 week | P3 | concrete scenario |
| ADR-0037: Per-tool MCP metadata | 2 | 1-week ADR + 1-week impl | P2 | none |
| ADR-0039: Per-client policies | 2 | pre-D2 design | P3 | D2 scenario |

## What's NOT here

Items that pillar review flagged but that already have their own plan
file or are already tracked:

- **M5 wiki sync:** `docs/plans/wiki-sync-m5.md` (this one is a full
  plan with phases).
- **Skill/agent drift across adapters:** `docs/plans/skill-agent-drift.md`.
- **Windows CI re-baseline:** `docs/plans/windows-ci-rebaseline.md`.
- **Remove `--explain` alias from am run (per ADR-0038 correction):**
  follow-up PR, out of scope for this stub file. One-line fix.
- **Wire `variant.permission_policy` to enforcement (ADR-0036
  follow-up):** would pair with ADR-0037 (MCP metadata) since
  `am_agent_invoke` needs a variant parameter anyway.

## Reference

- `docs/research/2026-05-02-all-pillars-review/00-synthesis.md` — the
  master list + tier ranking
- `docs/research/2026-05-02-all-pillars-review/0[1-6]-*.md` — per-pillar
  detail + file:line citations
- Commit `daad6ba` — Wave 1 (ADR-0036 + ADR-0038 + B1 shipped)
