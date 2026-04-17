---
status: accepted
date: 2026-04-16
---

# ADR-0031: Product Scope and Pillars

## Context

The v0.1 tagline was *"chezmoi for AI agent configs — define once in TOML,
sync via git, generate native configs for every tool."* Across 30 prior ADRs
and 15 deep-work-loop iterations, the product expanded materially beyond
that frame:

- **ACP runtime** (ADR-0026) makes am delegate to local agents.
- **Community adapter loading** (ADR-0027) turns am into a host for third-party adapters.
- **Brownfield import merge** (ADR-0028) accepts existing tool config as source of truth.
- **Unified agent registry** (ADR-0030) merges config + ACP + A2A agents.
- **Git-based marketplace** ships curated catalogs of MCPs + skills + plugins.
- **A2A server + bridge** accept remote delegations and bridge them to local ACP.
- **LLM-wiki** (Karpathy design) consolidates session activity into agent-accessible context.
- **Three UIs** — TUI, local web, Cloudflare web.

An iter2 vision audit (`docs/reviews/2026-04-16-iter2-adapter-schemas-and-vision/02-vision-coherence.md`)
scored the product at 6.5/10 on vision coherence — core 9/10, surface 5/10.
The report recommended cutting ~40% of shipped LOC (Cloudflare Worker, Flows,
Marketplace) as "sprawl."

That recommendation was graded against the wrong tagline. Against the product
that actually shipped, those surfaces are not sprawl — they are pillars of a
coherent whole: a **control plane for AI agents**. The job of this ADR is to
state that explicitly so future audits and feature decisions have the right
yardstick.

## Decision

**Tagline (new):**

> **agent-manager — the control plane for your AI agents.**
> Define catalog once (TOML, git-backed). Route any agent through a unified
> MCP gateway. Delegate locally via ACP or remotely via A2A. Subscribe to
> marketplaces. Remember sessions in an LLM-wiki. Edit from terminal, local
> web, or cloud.

**Short form:** *Control plane for AI agents: catalog, gateway, protocols, marketplace, wiki.*

**Six pillars (in-scope):**

1. **Catalog + git sync.** Servers, skills, agents, plugins, profiles defined
   once in TOML. User's choice of git backend (GitHub, GitLab, Bitbucket,
   self-hosted). Brownfield import from any supported tool.

2. **MCP gateway.** `am mcp-serve` is a stable endpoint any agent can plumb
   into. The catalog becomes the single source of truth; individual IDEs /
   agents consume through am instead of maintaining their own config.

3. **Protocol router.** ACP for local subprocess agents, A2A for remote
   agents, bridge for routing A2A tasks into local ACP execution. Session
   lifecycle, permission policies, and delegation are protocol-agnostic from
   the user's perspective.

4. **Marketplace.** Users subscribe to git-backed catalogs of MCPs + skills
   + plugins + agents. Replicates Claude Code's marketplace model but
   tool-agnostic. Supply-chain hardened (commit SHA pinning, TOFU, path
   traversal scrub, `--ignore-scripts`).

5. **LLM-wiki.** Karpathy-style session context capture. Globally git-backed,
   locally mirrored per project. Agents using am have context of what was
   done and discussed across sessions. **This is the least-documented
   differentiator and deserves first-class README placement.**

6. **Three editing surfaces over one core.** TUI (terminal power users),
   local web (rich UI, local trust), Cloudflare web (multi-device,
   auth-gated). All three are skins over the same core; they are not
   competing products.

**Explicit non-goals (out of scope):**

- am is **not** a workflow orchestrator. `am flow` exists as a coordination
  primitive for pillar 3 (compose ACP/A2A agents across catalog entries),
  not as a generic Airflow / Temporal / n8n competitor. If users need
  general-purpose workflow, point them at dedicated tools.
- am is **not** a hosted inference product. Agents run wherever their
  runtime runs; am is the control plane, not the data plane.
- am is **not** a replacement for native IDE configuration UX. It is
  complementary: native stays, am gives you the "define once, sync
  everywhere" layer.
- am is **not** a general-purpose dotfile manager. It is agent-focused.
  chezmoi remains the right tool for shell configs.

## Consequences

### Positive

- **Audit yardstick is explicit.** Future audits measure against the six
  pillars, not the v0.1 tagline. The iter2 "cut 40% of LOC" recommendation
  is superseded — those are pillars, not sprawl.
- **Feature decisions have a home.** Every new feature proposal answers:
  "which pillar does this serve?" Features that don't map to a pillar are
  flagged for reconsideration.
- **README can be honest.** The v0.1 tagline under-sells the product;
  users arrive expecting chezmoi-lite and find a control plane. The new
  tagline sets the right expectations.
- **LLM-wiki gets promoted.** It was buried under `src/wiki/`; now it is
  pillar 5 with dedicated command grouping and README placement.

### Negative

- **Bigger surface area to maintain.** Six pillars means six areas that
  must stay coherent under iteration. The iter2 audit already showed how
  fast surface sprawl accumulates; ongoing discipline required.
- **"Control plane" framing invites enterprise expectations.** Audit
  logs, RBAC, multi-tenancy become legitimate asks. We are NOT planning
  these for v1.0 — they are post-v1.0 work if they happen at all.
- **Marketplace becomes load-bearing.** If we advertise it as a pillar,
  we commit to supply-chain durability (checksum enforcement, pinning,
  audit trail). The iter1+iter2 hardening passes already landed most of
  this, but future regressions have a higher bar.

### Neutral

- **No code change implied by this ADR alone.** It formalizes intent.
  Code changes land in companion commits: collapse duplicate surfaces
  (M2), ship `am add skill` / `am add agent` (M3), promote LLM-wiki
  (M4), rewrite README (M5).

## Alternatives Considered

**Keep the chezmoi tagline, cut everything else.** The iter2 audit's
implicit recommendation. Rejected — we already shipped the additional
pillars; users are already using ACP delegation, marketplace subscriptions,
the wiki. Cutting would break real workflows for a pitch-clarity gain that
could be had by updating the pitch instead.

**Rebrand as a workflow orchestrator.** `am flow` is a real surface. We
could lean into that framing. Rejected — orchestration is an implementation
detail of pillar 3 (protocol routing), not the product's center of gravity.
Dedicated orchestrators (Temporal, Airflow, Prefect, n8n) do it better;
competing on that axis is a losing move.

**Split into multiple binaries** (`am-core`, `am-proto`, `am-web`,
`am-marketplace`). Considered. Rejected for v1.0 — the single-binary
distribution story is a concrete user benefit (one install, one version,
one config). Re-evaluate at v2 if the binary size or startup time
becomes a real problem.

**Keep sprawl-as-sprawl, accept the surface incoherence.** Rejected —
the duplicate `am list agents` / `am agent list` / `am run agents`
surfaces are directly user-visible and harm the "define once" promise.
Even if the pillars are right, the redundant surfaces within them are
real UX debt.

## References

- `docs/reviews/2026-04-16-iter2-adapter-schemas-and-vision/02-vision-coherence.md`
  — the audit that prompted this ADR.
- `docs/reviews/2026-04-16-iter2-adapter-schemas-and-vision/00-synthesis.md`
  — cross-cutting themes from iter2.
- ADR-0026 ACPX/ACP runtime integration (pillar 3 foundation).
- ADR-0027 Community adapter loading (pillar 1 extensibility).
- ADR-0030 Unified agent registry (pillar 3 implementation).
- Karpathy, "LLM Wiki" — the design pattern behind pillar 5.
- Claude Code plugin marketplace — the model pillar 4 replicates.
