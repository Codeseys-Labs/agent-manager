# Run 2026-05-05-B — two-track deep-work-loop

**Baseline:** `14ed1dc`
**Budget:** 2 waves max, 2 parallel tracks (no file overlap between tracks).
**Source documents:**
- `docs/design/2026-05-05-hosted-ux-secrets-adapters.md` (Track A)
- existing `src/wiki/` + `src/core/session.ts` + ADR-0016/0020/0022 (Track B)

## Track A — Hosted UX + secrets implementation foundations

Phase 1 of the 6-week plan in the design memo. **Documentation + interface scaffolding only this run** — no behavior changes that could break the 2693-passing test baseline.

### Wave 1A — Two ADRs (proposed status)

| id | file | status |
|---|---|---|
| A-01 | `ADRs/0042-universal-secrets-strategy.md` (new) | proposed |
| A-02 | `ADRs/0043-hosted-ui-auth-and-git-backend-tiers.md` (new) | proposed |

Both based on the design memo. MADR 3.0 format. Both `proposed` — promotion gates documented inside each.

### Wave 2A — SecretsBackend interface scaffolding (additive only)

| id | file | risk |
|---|---|---|
| A-03 | `src/core/secrets-backend.ts` (new) — interface + types | low (no callers yet) |
| A-04 | `src/core/secrets.ts` — refactor existing impl into `class AgeSecretsBackend implements SecretsBackend` adapter, keeping the legacy export functions for back-compat (zero behavior change) | medium — touches the load-bearing crypto path |
| A-05 | `test/core/secrets-backend.test.ts` (new) — interface contract tests | low |

Wave 2A touches `src/core/secrets.ts` which is high-blast-radius. Defer real age implementation to a future run; this wave is **interface only**, with the existing AES-GCM path renamed to a backend implementation but functionally identical. Acceptance: all 2693 existing tests still pass.

If even this proves risky, defer Wave 2A entirely and ship only Wave 1A (the ADRs) this run.

## Track B — LLM-wiki vision + plan (parallel, no file overlap with Track A)

Track B is **research + design documents only**. No source-code changes. Files:

| id | file | type |
|---|---|---|
| B-01 | `docs/research/2026-05-05-llm-wiki-prior-art.md` (new) | research |
| B-02 | `docs/design/2026-05-05-llm-wiki-vision.md` (new) | design |

Track B answers the user's specific questions:
1. The two-tier wiki: **global cross-project KB** (lives in the am repo at `~/.config/agent-manager/wiki/`) vs **project-local mirror** (lives at `<project>/.am-wiki/` symlinked / synced from the global).
2. Sync semantics — when does project-local content become global? When is global content visible per-project?
3. Cross-tool session harvest (currently 2/13 adapters per recent deep-work-log) — is that the bottleneck?
4. How does an agent in `<project>` see the local-mirrored wiki without requiring the agent to know about `am`?
5. MCP-tool surface design (`am_wiki_*`).
6. What can ship in 1-2 weeks vs what's a quarter-long bet?

## File-ownership verification — no Track A / Track B overlap

| Track | Touches |
|---|---|
| A | `ADRs/`, `src/core/secrets*.ts`, `test/core/secrets*.test.ts` |
| B | `docs/research/`, `docs/design/` |

Disjoint. Safe to parallelize.

## Acceptance for the run

- 4-6 new docs/ADRs.
- Optional: Wave 2A interface scaffolding lands.
- Tests still 2693+ passing.
- Both tracks committed.
- Phase 8 cross-family review (genuine cross-family this time, post-Hermes-restart) on the most consequential output (probably ADR-0042 + the wiki vision).

## Out of scope for this run

- Implementing age crypto.
- Touching the platform adapters (GitHub/GitLab/Gitea REST surfaces).
- Building any browser code.
- Migrating existing user data.
- Implementing wiki harvest for the missing 11 adapters.
- Building the wiki UI in any surface.
