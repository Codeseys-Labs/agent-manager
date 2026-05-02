---
date: 2026-05-02
scope: Adversarial critique of deep-work-loop run 2026-05-01 (baseline 8a4d5f0 → 80d3a98)
reviewers: 6 feature-dev:code-reviewer subagents (scatter-gather, independent)
---

# Cross-Facet Synthesis

Six parallel adversarial reviewer subagents critiqued the 2026-05-01 deep-work-loop
run from distinct lenses. Each reviewer received only the artifact + questions,
not the implementer's reasoning. Convergence across reviewers = high-confidence
finding.

## Findings that landed as code (this session, 2026-05-02)

### Security (3 HIGHs — all live latent vulnerabilities)

| Finding | Where | Fix commit |
|---|---|---|
| SEC-1: `requestPermission` deny bypass — when agent omits reject options, old fallback selected `options[0]` which could be `allow_always` | `src/protocols/acp/client.ts:465` | 4905c96 |
| SEC-2: `AmAcpClient` class default was `"auto-approve"` — bridge fixed its path; `am run`/`am flow`/`am_agent_invoke` inherited permissive default | `src/protocols/acp/client.ts:80` (flipped to `"deny"`) + 3 caller opt-ins | 4905c96 |
| SEC-3: `redactProgressMessage` had no cycle guard — adversarial agent sends `a.self=a` → stack overflow → MCP server crash | `src/mcp/server.ts:145` (WeakSet) | 4905c96 |

All three followed the same pattern: previous work fixed a specific instance but
left a class default or alternate path permissive. The generalizable principle:
**declare at the boundary, don't assume at the default.**

### Test quality (1 mutation escape closed)

| Finding | Where | Fix commit |
|---|---|---|
| TEST-1: bridge tests asserted setters were called with correct values but not that they fired BEFORE `connect()`. A refactor reintroducing the original HIGH-2 bug (setters after connect) would pass all old tests. | `test/protocols/bridge.test.ts` — orderTrace + new ordering test | 4905c96 |

### Architecture / ADR integrity (4 fixes)

| Finding | Where | Fix commit |
|---|---|---|
| DOC-1 + DOC-4: ADR-0034 C1/C2 labels swapped vs research; no tiebreaker rule | `ADRs/0034-shim-scope-and-inclusion-criteria.md` — provenance note + "tie goes to community path" rule | 482d67a |
| DOC-3 (Facet 6 blocking): ADR-0034 C2 anchored to unverified research | `ADRs/0034-shim-scope-and-inclusion-criteria.md` — §Verification gate prerequisite to Accepted | 482d67a |
| DOC-2: ADR-0033 clean-cut removal vs ADR-0034 tier-down-before-remove was a live contradiction with no cross-reference | ADR-0033 `amended_by: ADR-0034` + inline note + ADRs/README.md + template.md extended | 482d67a |
| Meta: ADR-0031 meta-tooling rule was too elastic | Added "assign to nearest pillar" tiebreaker | 482d67a |

### Plans (4 future-execution landmines patched)

| Finding | Where | Fix commit |
|---|---|---|
| PLAN-1 (CRITICAL): wiki-sync-m5 `softResetHead` would leave index corrupted (stage-ahead-of-HEAD → double-commits) | `docs/plans/wiki-sync-m5.md` — now calls `git.resetIndex` | bd35eeb |
| PLAN-2 (CRITICAL): skill-agent-drift Phase 1 estimated 2 days; realistic 3.5-4; `unmanaged` stub is silent false negative | `docs/plans/skill-agent-drift.md` — revised 8→11-12 days + capability removed until export+diff both land | bd35eeb |
| PLAN-3 (IMPORTANT): Windows CI fail-count grep false-success on CRLF | `.github/workflows/ci.yml:65-85` — `tr -d '\r'` + defense-in-depth check for missing summary line | bd35eeb |
| PLAN-4 (IMPORTANT): wiki-sync schema-without-runtime pit trap | `docs/plans/wiki-sync-m5.md` — defer schema field to same milestone as timer | bd35eeb |

## Findings NOT addressed in this session (surfaced for later)

| Finding | Why deferred |
|---|---|
| Facet 2 ISSUE-1: `redactProgressMessage` doesn't walk non-enumerable props / Symbol keys / class instances | Harder fix (serialize/parse round-trip adds cost); separate PR worth doing standalone |
| Facet 2 ISSUE-3: `createTerminal` spawn path at client.ts:526 has only structural test | Requires a real ACP-speaking fake-agent test harness |
| Facet 2 new-backlog: `promptFlag` format validation for community shims | Needs ShimConfig schema extension |
| Facet 4 MED: E2E env-sandbox test has write-before-read race on slow CI | Cosmetic test hardening |
| Facet 4 MED: Prototype spy ESM-unsafe; should replace with clientFactory injection | API refactor — worth a dedicated PR |
| Facet 6 underclaim: `reachable` → `locallyInstalled` is a breaking MCP API change, deserves a deprecation alias | Could add a one-release alias |
| Facet 3 Q4: `--allow-dirty` flag + `agent_id` frontmatter field added without ADRs | Worth an ADR when they land in production |
| Pre-existing `test/mcp/concurrency.test.ts` flake (task #32) | Pre-dates this session's baseline |

## What the critique validated

- `synthesizeContext` double-bug fix (2026-05-01 Wave 3) was the strongest outcome
  of the original loop — Facet 6 cited it specifically.
- Every commit maps to at least one pillar or accepted meta-tooling (Facet 1 Q1).
- Bridge permission-policy hardening was genuine security work (Facet 1 confirmed).
- ADR-0033 tier split is "architecturally honest" (Facet 3).
- An investor would see forward motion on pillar 3 (protocol router), not
  maintenance (Facet 1 Q6).

## Executive verdict (Facet 6)

**7/10.** Weakest link: research corpus built on model memory with external tools
denied, then used to anchor ADR-0034's inclusion criteria. Strongest outcome:
`synthesizeContext` dual-bug fix. Blocking concern (now addressed as a
verification gate requirement): ADR-0034 C2 needs live-numeric citation before
flipping Proposed → Accepted.

One-action-this-week recommendation (Facet 6): promote
`docs/plans/wiki-sync-m5.md` to a tracked GitHub issue so it doesn't decay as
an orphaned plan. **Not yet done — awaiting user's signal that the plan is in
scope for a near milestone.**

## Reviewer framing

What's missing from ALL six reviewers' reports: none of them actually ran the
test suite. The findings are based on code inspection + test code inspection,
not on mutation testing in practice. A full mutation-testing pass (stryker or
similar) would produce a stronger gap report than any individual reviewer here.
Filed as a future audit idea, not as a task for this session.
