---
status: proposed
date: 2026-05-05
supersedes: ADR-0034, ADR-0035
---

# ADR-0039: Marketplace v1 Scope Decision — Retire in favor of MCP Registry + git-subtree bundles

## Context

The 2026-05-05 parallel-critique review surfaced a load-bearing
disagreement (D1) about pillar 4 (Marketplace, ADR-0031) that the
project must decide before further work in this area:

- **Vision lens** flagged marketplace as "cut or defer." Evidence:
  ADR-0034 ("Shim scope and inclusion criteria") and ADR-0035
  ("Community shim registration") are mutually-referencing,
  `status: proposed`, with ~72% of described surface area as paperware
  (no shipped code path actually exercises them end-to-end). Pillar 4
  is one of two pillars in ADR-0031 that the audit graded "load-bearing
  but partial."
- **Security lens** flagged the marketplace installer as actively
  exploitable: `serverDef.command` / `args` were copied verbatim into
  `am apply` with `z.string().min(1)` as the only validation. Wave 1's
  B-01 closed this with a command allowlist + prompt-on-novel-executable
  + `sandboxEnv()` propagation, but the security review was clear that
  marketplace is the largest **ongoing** supply-chain surface in the
  product.
- **Integration lens** argued marketplace was the #1 concrete external
  integration win, with Hermes's ~20-skill library as a ready
  validation corpus ("Hermes-as-am-marketplace").

These positions are not all reconcilable. Either marketplace becomes a
load-bearing v1 surface with active customer-finding work, or it
retires. "Leave as paperware while ADR-0034/0035 sit in proposed
limbo" is the worst of all worlds — the security cost stays on the
books, no positive customer evidence accumulates, and every future
ADR that touches plugin distribution adds another link to the
circular reference chain.

### Evidence inventory (verified against `main` at d0ba4e6 + Wave 1)

- Marketplace shipped surface: `src/marketplace/installer.ts`,
  `src/marketplace/security.ts`, ~6 commands under `src/commands/marketplace.ts`.
- Real production customers: **0 known**. No public marketplace catalog
  is published by this project; no third party has registered one.
- `MCP Package Registry` ([ADR-0024](0024-mcp-registry-integration.md))
  already covers "browse and install MCP servers from a source of
  truth" for pillar 1. It uses the upstream npm/Smithery index and
  handles install-from-URL.
- Hermes integration is **speculative** — listed in OOS-5 of the
  current backlog as "depends on this decision." It is not a present
  customer.
- The bundle abstraction (one install pulls servers + skills +
  instructions + agents together) is genuinely useful and not covered
  by MCP Registry, which is server-only.

## Decision

**Retire the marketplace as a distinct pillar 4 surface.** Mark
[ADR-0034](0034-shim-scope-and-inclusion-criteria.md) and
[ADR-0035](0035-community-shim-registration.md) as `superseded` by
this ADR. Re-route the user-facing problem ("install a curated bundle
of MCPs + skills + instructions + agents") through two existing
mechanisms:

1. **MCP servers** → already handled by MCP Package Registry (ADR-0024).
   No new abstraction needed.
2. **Skills + instructions + agent profiles bundles** → users import
   from a git source via `git subtree add` (or
   `git submodule`) into their config repo's `skills/` /
   `instructions/` directories, then `am import` to register them.
   This is the same trust model — the user is responsible for what
   they pull from a git URL — but uses git's native vendoring rather
   than a custom installer + manifest format.

### Concrete actions implied by this decision

- Update [ADR-0031](0031-product-scope-and-pillars.md) pillar 4 to
  read "Marketplace (v0, retired) — see ADR-0039." Defer in-place edit
  to a future companion amendment (ADR-0031b) consistent with
  ADR-0031a's pattern; out of scope for this ADR.
- Promote ADR-0034 and ADR-0035 to `superseded_by: ADR-0039`. Close
  open paperware.
- Mark `src/marketplace/*` and the `am marketplace *` commands as
  **frozen** — Wave 1's B-01 hardening stays in place to keep the
  surface non-exploitable for any user who has wired a private
  catalog, but no new feature work lands. A removal ADR can follow if
  no non-trivial dependent work materializes by v1.0.
- Remove the "marketplace" pillar bullet's promise of "many
  marketplaces, each pinned independently" from README/AGENTS.md
  marketing copy.
- Document the git-subtree bundle pattern in `docs/guides/` (separate
  PR; not blocking on this ADR).

This ADR is `status: proposed` because retiring a named pillar of
ADR-0031 is a meaningful product call, not a unilateral one. Promote
once a maintainer has signed off.

## Consequences

### Positive

- Removes the single largest open supply-chain surface from the
  product's ongoing maintenance burden. B-01's allowlist becomes a
  capstone, not a foundation for further work.
- Closes the ADR-0034/0035 circular-reference paperware debt that
  parallel-critique called out (D1, C3).
- Cuts the "what is the marketplace v1 API?" decision the project
  has been deferring for ~6 months. The API is now: there isn't one,
  use git + ADR-0024.
- Reduces six pillars to five real ones. Pillar 4 (Marketplace)
  becomes pillar 4 (MCP Registry) — and the registry is shipped, not
  paperware. This is a documentation honesty win.
- Frees Wave 3+ planning capacity that would have gone to "build
  marketplace v1 catalog spec" toward pillars 2 (MCP gateway) and
  5 (LLM-wiki), which both have shipped foundations and unmet depth.

### Negative

- **Loses the bundle abstraction**. A user who wants
  "install one URL, get servers + skills + instructions + agents
  together" has no first-class path. They get fragments: MCP
  Registry for servers, git-subtree for content. The bundle is
  reconstructable but not pre-packaged.
- **Discards the Hermes-integration story** as a marketing surface.
  Hermes can still consume `am`, but not as "browse the am
  marketplace and one-click-install Hermes." The skill library
  becomes a git URL, not a catalog entry.
- **Breaks any external user who is currently running a private
  marketplace catalog**. The frozen-not-removed posture mitigates
  this for the medium term, but anyone investing further in this
  surface should now expect deprecation rather than growth.
- **Closes off a plausible commercial differentiator**. "Curated
  bundles of agentic config" is a defensible product axis we are
  choosing not to pursue.

### Neutral

- The 13-adapter pattern, ACP, A2A, MCP gateway, wiki, and CF Worker
  surfaces are all unaffected. This decision is local to pillar 4.
- `src/marketplace/security.ts` (B-01) stays. Even a frozen surface
  is required to be non-exploitable for the existing installed base.

## Alternatives Considered

### Option A — Commit to Marketplace v1, Hermes as first customer

Take the integration lens seriously: ship a v1 with concrete API
(`install`, `uninstall`, `list`, `search`, `update`), publish a real
public catalog with at least one external bundle (Hermes), and use
that to validate ADR-0034/0035 with shipping evidence rather than
paperware. Now that B-01 has landed (command allowlist + prompt on
novel executables), the exploit-shaped objections are bounded.

**Why this was rejected:**

- The Hermes-as-customer story is **speculative**. Hermes has not
  asked to be hosted. Building a marketplace pillar around a
  hypothetical first customer is the inverse of "find one user, then
  build the abstraction."
- MCP Registry (ADR-0024) **already** covers MCP-server distribution.
  The marketplace's distinct value is bundles (servers + skills +
  agents), but bundle demand is also unproven — no third party has
  asked to publish one in the ~6 months since the marketplace surface
  shipped.
- Committing to v1 means committing to a manifest format,
  catalog-spec versioning, supply-chain policy, and an SLA on the
  installer. That is a multi-quarter investment for a pillar with
  zero validated demand. The opportunity cost (pillars 2 and 5 are
  underbuilt) is high.
- The trust-model problem is real even with B-01. SHA pinning
  proves "same code as last time," not "code is benign." Beyond the
  command allowlist, the next gate is some form of signature /
  reputation system, which is materially expensive.
- Vision and Architecture both leaned toward retire/defer.
  Integration was the only enthusiastic voice and it leaned on a
  hypothetical customer.

This option remains **viable to revisit** if a third party
materializes wanting to publish a curated bundle and has concrete
catalog requirements that git-subtree cannot meet.

### Option B — Retire (this ADR's choice)

Above. Selected because the evidence weight (zero customers + MCP
Registry already covers the server case + ADR-0034/0035 paperware
debt + maintenance surface) outweighs the speculative integration
upside.

### Option C — Ambiguous status quo

Leave ADR-0034/0035 as `proposed`, leave `src/marketplace/*` as-is,
defer the decision to "after some signal." Rejected explicitly. The
parallel-critique synthesis named this state as the worst of all
worlds: ongoing security surface without ongoing customer evidence.
"Defer the decision" is itself a decision, and it has been the
decision for ~6 months. Force the choice.

## References

- [ADR-0024 MCP Registry integration](0024-mcp-registry-integration.md)
- [ADR-0031 Product scope and pillars](0031-product-scope-and-pillars.md)
- [ADR-0032 Terminology glossary](0032-terminology-glossary.md) — Registry vs Marketplace
- [ADR-0034 Shim scope and inclusion criteria](0034-shim-scope-and-inclusion-criteria.md) — superseded by this ADR
- [ADR-0035 Community shim registration](0035-community-shim-registration.md) — superseded by this ADR
- `docs/reviews/2026-05-05-parallel-critique/synthesis.md` — D1 disagreement, C3 finding
- `docs/plans/2026-05-05-backlog.md` — B-01 hardening (Wave 1) and OOS-5 (Hermes-as-marketplace)
