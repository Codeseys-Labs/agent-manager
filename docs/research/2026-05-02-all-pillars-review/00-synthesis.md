# All-Pillars Review — Cross-Pillar Synthesis

**Source:** 6 parallel Codex `exec review` agents, one per ADR-0031 pillar.
**Date:** 2026-05-02. Facet reports at `01-catalog-git.md` … `06-three-uis.md`.

## TL;DR — the three convergent themes

Every pillar review surfaces the same three structural gaps, at different
levels of the stack:

1. **Dry-run / explain / preview is missing** — users cannot see what
   `am` will do before it does it. Pillar 1: no working `--diff`. Pillar
   3: no `am run --dry-run`. Pillar 4: no `am marketplace info --diff`.
   Pillar 6: TUI has no preview-before-apply. **This is one product
   principle with seven implementations.**

2. **The auth/provider/variant layer is schema-absent** — Pillar 1 says
   the AgentProfile has only `model: string`; Pillar 3 shows the variant
   TOML design; Pillar 5 notes session-reader adapter seam exists for
   Claude Code and Codex only; Pillar 2 says the MCP gateway can't do
   per-client policy. **Add `variants` to agents.*, plumb through run
   + MCP + env-sandbox, and four pillars get simultaneously better.**

3. **Feedback / observability to the user is thin** — TUI toasts vanish
   in 3s (P6); MCP progress has no duration/trace-id (P2); wiki
   synthesize doesn't tell the agent "your note was used" (P5); apply
   is not transactional and partial failures leave silent residue (P1).
   **A shared event/log surface across pillars would fix all four.**

## Per-pillar headline findings

| Pillar | Rating read | Single most important fix |
|---|---|---|
| **1 Catalog + git** | Solid core; UX gaps at edges | Wire `--diff/--force` through `applyResolved`, block drift-overwrite by default |
| **2 MCP gateway** | Technically strong, docs thin | Per-tool `x-am` metadata (output schema, error codes, progress support, deprecation) |
| **3 Protocol router** | Security hardened; auth/variant absent | Add `variants` to agent schema + `am run --variant` + `--dry-run` |
| **4 Marketplace** | Crisp vocabulary, hostile to new authors | Author kit: guide + `am marketplace validate` + sample repo |
| **5 LLM-wiki** | Strong bones, feedback loop doesn't close | Return included-slugs + `used_by_session` from synthesize so agents learn what was useful |
| **6 Three UIs** | Half-baked; local web borderline stub-ware | One-time-token auth for `am serve` so first contact actually loads data |

## The auth/multi-provider story (spans P1, P3, P5, P6)

Your original question — "multi-provider auth: Claude via Bedrock, Codex
via OpenAI API, OpenRouter as a backend, etc." — lands across four
pillars:

- **P1 (Catalog):** `AgentProfile` schema has no `variants`, no
  `provider`, no `credential_ref`. Same map-to-env shape as everything
  else. (`src/core/schema.ts:88-107`)
- **P3 (Protocol router):** `run.ts` + `am_agent_invoke` + detection +
  resolver have no `--variant` path. Sandbox strips provider env vars
  unless explicit env is passed; run never passes it.
- **P5 (LLM-wiki):** tangentially — session-reader adapter seam exists
  but only Claude Code + Codex register; Cursor/Windsurf/aider/Kilo/Roo
  need readers.
- **P6 (UIs):** Cloud login UI is GitHub-hardcoded even though the
  worker supports GitHub/GitLab/Codeberg/Gitea — same "schema backs
  multi-provider but UI doesn't expose it" shape.

**P3 proposed the clearest schema** — a working TOML example is in
`03-protocol-router.md` §4. Upshot: one proposed ADR, one schema field
(`variants` on agent entries), and the auth story falls into place.

## Prioritized roadmap (honest read, NOT a commitment)

### Tier A — foundations that unlock multiple pillars

A1. **`variants` on agent schema + `--variant` plumbing** (P3 §4 +
   P1 §4). Delivers the multi-provider story. Worth a proposed ADR.

A2. **`--diff` / `--dry-run` / `explain` surface pattern** (P1 §5.1,
   P3 §6.1, P4 §6.2, P6 §6.1). One design applied across commands:
   `am apply --diff`, `am run --dry-run`, `am marketplace info --diff`,
   TUI preview.

A3. **Per-tool MCP metadata** (P2 §5.1-2). Adds `x-am.{group, tier,
   auth, deprecation, progress, outputSchema, errorCodes}` to every
   tool. Unblocks MCP-client builders.

### Tier B — known debt that's been deferred

B1. **Local `am serve` auth bootstrap** (P6 §6.1). Today the HTML
   fetches without a bearer token → API returns 401. Fix: one-time
   URL-bound token in the `am serve` output.

B2. **Wiki sync M5 + privacy posture** (P5 §6.3). The plan is written,
   the fix is committed-to, but not shipped. Concrete multi-week effort.

B3. **Marketplace author kit** (P4 §6.1). Guide + schema + validator
   CLI. Likely a 3-day task with high external-contributor payoff.

### Tier C — observability + feedback loop

C1. **MCP per-call duration + trace id** (P2 §5.2). Unblocks anyone
   debugging why their agent is slow.

C2. **Wiki synthesize usage feedback** (P5 §6.2). Agents learn that
   their contribution was useful — closes the Karpathy loop.

C3. **Transactional apply** (P1 §3). Rollback on partial-adapter
   failure.

### Tier D — discoverability + per-client policy

D1. **Marketplace-of-marketplaces** (P4 §4). Curated index so new
   users don't start from zero URL knowledge.

D2. **Per-MCP-client policy (multi-tenant)** (P2 §4). Two bearer
   tokens → two different `tools/list` surfaces. Required before
   `am mcp-serve` can host multiple agent identities safely.

### Deferred (honest)

- Per-agent remote-session persistence (P3 §3). In-memory task store
  is a known limitation; fixing = new dependency.
- Cross-project wiki search (P5 §3.5). Architecture is there;
  implementation is a feature, not a fix.

## ADRs that these findings would justify

- **ADR-0036: Per-agent auth/variant schema.** Schema shape is in the
  P3 report. Precondition: none. Best companion for Tier-A1.
- **ADR-0037: Per-tool MCP metadata.** `x-am.*` namespace conventions
  for tool outputs, errors, progress. Precondition: none. Tier-A3.
- **ADR-0038: Dry-run/explain surface pattern.** Cross-cutting CLI/MCP
  convention. Precondition: none. Ties together A2.
- **ADR-0039: Per-client MCP policies.** Multi-tenant gateway. Not
  urgent but architecturally load-bearing. D2.

## Meta-observation on the Codex review itself

Codex reports were **substantially higher signal density than the
previous Claude-subagent critique** (comparing commit-hash citation
rates + concrete schema proposals vs generic "rough for new user"
bullets). The scatter-gather-one-per-pillar structure forced
non-overlap; the shared 6-question skeleton forced comparable answers.
The `codex-parallel-critique` skill pattern is validated again —
this was its second successful use.

## References

- `01-catalog-git.md`, `02-mcp-gateway.md`, `03-protocol-router.md`,
  `04-marketplace.md`, `05-llm-wiki.md`, `06-three-uis.md`
- ADRs/0031-product-scope-and-pillars.md (source of the six-pillar
  model)
- ADRs/0033, 0034, 0035 (agent tier / shim scope / community shims)
