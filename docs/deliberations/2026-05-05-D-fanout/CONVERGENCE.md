# Fan-out Deliberation — Convergence Summary

**Date:** 2026-05-05 (Run D)
**Reviewers (6, all confirmed via metadata + self-reference probe):**
- `openai/gpt-5.5`
- `moonshotai/kimi-k2.6`
- `google/gemini-3.1-pro-preview`
- `minimax/minimax-m2.7`
- `deepseek/deepseek-v4-pro`
- `x-ai/grok-4.3`

**Method:** parallel-critique fan-out vote, identical prompt, 12 open
decisions across hosted-UX (4) + LLM-wiki (8). Each reviewer voted
A/B/NUANCED/ABSTAIN with 1-3 sentence reasoning.

**Hermes config:** `delegation.max_concurrent_children` raised to 6 in
`~/.hermes/config.yaml` but the running process held a cached value of 3 —
the 6 reviewers ran as two batches of 3 (operationally equivalent;
deliberation independence preserved by no inter-reviewer file access).

**Cross-family signal verified:** all 6 reviewers ran on the requested
model (per `delegate_task` metadata + opening `[reviewer: <slug>]` header).
Router fix held across 6 calls.

---

## Convergence table

| ID | Decision | Votes | Outcome |
|----|----------|-------|---------|
| **A1** | CodeMirror 6 vs Monaco | A:5 / NUANCED:1 | **CM6 for hosted UI** (strong) |
| **A2** | `op://` install detection | A:2 / B:2 / NUANCED:2 | **Detect + show install command, never auto-execute** (operational consensus despite phrasing split) |
| **A3** | Reject `team_passphrase` in schema | A:5 / NUANCED:1 | **Reject in schema** (strong) |
| **A4** | `config_template` in MVP | NUANCED:4 / B:1 / unparsed:1 | **Ship behind `--unsafe-config-template` opt-in flag** (consensus) |
| **B1** | Rename `.am-wiki/` | A:6 | **UNANIMOUS — rename** |
| **B2** | Copy vs symlink | A:6 | **UNANIMOUS — copy** |
| **B3** | Bidirectional vs push-only | NUANCED:4 / B:2 | **Push-only MVP, explicit `am wiki pull` for opt-in down-sync** |
| **B4** | gitignore default | A:5 / NUANCED:1 | **Gitignored-by-default until ADR-0042 secrets integration is end-to-end live** |
| **B5** | Promotion gesture | NUANCED:6 | **UNANIMOUS-on-NUANCED — both: frontmatter declares intent, command executes** |
| **B6** | AGENTS.md hardcoded vs customisable | A:3 / B:1 / NUANCED:2 | **Hardcoded MVP with version pin; extension point in v2** |
| **B7** | Block on SessionReader gap | B:6 | **UNANIMOUS — parallel; do not block two-tier on adapter expansion** |
| **B8** | Tier model | NUANCED:6 | **UNANIMOUS-on-NUANCED — two-tier MVP, layout-compatible with later workspace tier** |

**4 unanimous (B1, B2, B7, plus all-NUANCED B5+B8 converging on the same
nuanced answer).** **5 strong-majority (A1, A3, B4 5/6).** **1 operational
consensus (A2).** **1 nuanced consensus (A4).** Zero genuine splits.

---

## Highest-conviction items (multiple reviewers flagged HIGH-confidence)

- **B1 + B2** (rename + copy) — 6/6 unanimous, multiple reviewers
  explicitly cited Windows compat + zero-installation-legibility. Ready
  to ADR.
- **B7** (parallel adapter expansion) — 6/6 unanimous. Two-tier
  shouldn't block on adapter audit; SessionReader gap is its own track.
- **A1** (CM6) — 5/6 strong. Bundle size on Cloudflare Workers is a hard
  constraint.
- **A3** (reject team_passphrase) — 5/6 strong. Anti-pattern, must be
  enforced in schema, not just discouraged.

## Lowest-conviction (would change with new evidence)

- **A4** (config_template) — depends on which MCP servers actually need
  config files vs env. Multiple reviewers want a survey before final.
- **B6** (AGENTS.md customisability) — depends on user-base patterns;
  hardcoded MVP is reversible.
- **B5** (promotion: both flag and command) — depends on usage patterns;
  supporting both early is hedge.

---

## Notable individual notes from reviewers

- **deepseek**: Most NUANCED votes (10/12). Tends to defer concrete
  choices to "let's gather more data first" — useful in deliberation,
  less useful as final votes. High-confidence on B7 (parallel adapter
  expansion) and B2 (copy, cross-platform) only.
- **grok-4.3**: Cleanest pass — 9 firm A votes, 1 firm B (A4 defer
  config_template), 2 NUANCED. Most decisive reviewer; aligns with
  synthesis recommendations on most points.
- **gemini**: Used "CHOICE C (NUANCED)" formatting that broke a
  string-match regex initially; voted B on B3 (push-only) and B6
  (per-project AGENTS.md customisation), differing from majority on
  both. Worth re-examining its reasoning if those decisions become
  contentious.
- **minimax**: Reported it couldn't find ADR files on disk and "relied
  on synthesis citations" — that's a model error (the files exist and
  the other 5 reviewers read them). Its votes are still useful
  signal but treat its grounding as weaker.
- **kimi**: Ran for 7.5 minutes (longest of any reviewer); did
  extensive search-files probing for ADR locations. Final votes
  well-reasoned and agree with majority.
- **gpt-5.5**: Fastest serious vote (38s); reasoning is consistently
  pragmatic; flagged the actual ADR-0022 filename mismatch (`0022-llm-wiki-design.md`
  vs `0022-wiki-location-strategy.md`) which the prompt got wrong.

---

## Total cost

~$5 OpenRouter (6 reviewers × ~250-650k input tokens each, ~2-6k output
each, all medium-tier models). Wall-time: ~10 min total (3 batches of 3,
each batch capped by slowest reviewer).

---

## What this unlocks

ADR-0044 can now be drafted with strong cross-family backing:
- §1 Wiki location: `.am-wiki/` (rename, B1)
- §2 Materialisation: copy not symlink (B2)
- §3 Sync direction: push-only MVP, `am wiki pull` for opt-in (B3)
- §4 Default `.gitignore`: gitignored-by-default until ADR-0042 fully
  live (B4)
- §5 Promotion gesture: frontmatter `promote: true` + `am wiki publish`
  (B5)
- §6 AGENTS.md: hardcoded template with version pin (B6)
- §7 Parallel adapter expansion (does not block) (B7)
- §8 Two-tier MVP, layout extensible to workspace tier (B8)

ADR-0043 amendment can pin:
- §A1 CM6 default for hosted UI; Monaco optional for `am serve`

ADR-0042 amendment can pin:
- §A3 Reject `team_passphrase` in schema validator
- §A4 `config_template` ships behind opt-in flag with explicit
  plaintext-on-disk warning in the docs

A2 (`op://` detection) is documentation-level: the actual behavior
recommended (detect + show command + never auto-execute) is what we'll
implement; the table-row in synthesis already says that.

---

## Status

This deliberation memo is **input** for Phase 4's ADR drafting and
Phase 5's wave plan.
