---
status: superseded
date: 2026-05-05
superseded_by: product-scope decision (AGENTS.md, 2026-06-04)
---

> **Superseded 2026-06-04 by the product-scope decision (AGENTS.md): the
> marketplace (pillar 4) is DEFERRED to v2, not retired/deleted. It pairs with
> the hosted web platform and returns in the v2 era. `src/marketplace/*` still
> ships. Do NOT execute the retirement/deletion described below.** This ADR is
> retained for its decision history; the retire-pillar-4 outcome is no longer in
> force.

# ADR-0039: Marketplace v1 Scope Decision — Retire pillar 4 in favor of MCP Registry + git-subtree bundles

## Context

The 2026-05-05 parallel-critique review surfaced a load-bearing
disagreement (D1) about pillar 4 (Marketplace, ADR-0031) that the
project must decide before further work in this area:

- **Vision lens** flagged marketplace as "cut or defer." Evidence:
  the synthesis described ADR-0034/0035 as "circular paperware,"
  but **on direct verification those ADRs govern shims (pillar 3),
  not the marketplace (pillar 4)** — they ARE backed by shipped code
  (`src/protocols/acp/shell-wrapper.ts`, `src/acp-shell-cli.ts`,
  `src/commands/agent-enable-shim.ts`). The synthesis erred in
  conflating the two surfaces. The legitimate "paperware" concern is
  that pillar 4 ITSELF (as enumerated in ADR-0031) has no committed
  customer and `src/marketplace/*` (1,612 LOC) ships without external
  validation. This ADR addresses pillar 4 in ADR-0031 — NOT
  ADR-0034/0035, which remain `proposed` and continue to govern the
  shim scope policy they were always about.
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
retires. "Keep pillar 4 active while doing nothing concrete" is the
worst of all worlds — the security cost stays on the
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

**Retire the marketplace as a distinct pillar 4 surface.** Do NOT touch
ADR-0034/0035 — they govern shims (pillar 3), not the marketplace, and
remain in force. Re-route the user-facing problem ("install a curated
bundle of MCPs + skills + instructions + agents") through two existing
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
  ADR-0031a's pattern; **MUST land before this ADR can be promoted to
  `accepted`** — see Verification Gates below.
- Deprecate `src/marketplace/*` and the `am marketplace *` commands:
  (a) add a `@deprecated` JSDoc to the public entry points with a
  pointer to this ADR, (b) print a one-line deprecation warning when
  `am marketplace *` is invoked. Wave 1's B-01 hardening stays in place
  to keep the surface non-exploitable for any user who has wired a
  private catalog. **Removal target: v1.0.** If no non-trivial dependent
  work materializes before then, a follow-up ADR flips this from
  "deprecated" to "removed."
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
- Resolves the pillar 4 paperware debt that parallel-critique called
  out (D1, C3) — without conflating it with ADR-0034/0035 (shims),
  which the synthesis incorrectly grouped together.
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
that to validate the marketplace v1 model with shipping evidence
rather than paperware. Now that B-01 has landed (command allowlist + prompt on
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
Registry already covers the server case + pillar-4 paperware
debt + maintenance surface) outweighs the speculative integration
upside.

### Option C — Ambiguous status quo

Leave pillar 4 alive in ADR-0031 + leave `src/marketplace/*` as-is,
defer the decision to "after some signal." Rejected explicitly. The
parallel-critique synthesis named this state as the worst of all
worlds: ongoing security surface without ongoing customer evidence.
"Defer the decision" is itself a decision, and it has been the
decision for ~6 months. Force the choice.

## Verification gates (resolved for `accepted`)

1. **ADR-0031 pillar 4 amendment — resolved.** ADR-0031 now marks pillar 4 as
   "MCP Registry + git-vendored bundles" and includes a dedicated
   "Marketplace v1 retirement" amendment section pointing back to ADR-0039.
2. **Code-side deprecation lands — resolved.** `src/commands/marketplace.ts`
   and every `src/marketplace/*.ts` module carry `@deprecated` JSDoc pointing
   to this ADR. `am marketplace *` invocations print a one-line deprecation
   warning to stderr.
3. **Doc-marketing scrub — resolved.** README and AGENTS.md no longer advertise
   marketplace subscriptions or "many marketplaces, each pinned independently";
   remaining marketplace mentions are compatibility/deprecation references.
4. **No-callers verification — resolved for production code.** The only
   production imports of `src/marketplace/*` are from the deprecated
   `src/commands/marketplace.ts` command surface. Other hits are test imports
   or unrelated adapter-specific extension-marketplace scanners.
5. **Removal target tracked — resolved.** Removal target is documented here as
   `v1.0`; the deprecated command/runtime warning and README compatibility note
   both point users to ADR-0039 for the migration path.

## References

- [ADR-0024 MCP Registry integration](0024-mcp-registry-integration.md)
- [ADR-0031 Product scope and pillars](0031-product-scope-and-pillars.md)
- [ADR-0032 Terminology glossary](0032-terminology-glossary.md) — Registry vs Marketplace
- `docs/reviews/2026-05-05-parallel-critique/synthesis.md` — D1 disagreement, C3 finding
- `docs/plans/2026-05-05-backlog.md` — B-01 hardening (Wave 1) and OOS-5 (Hermes-as-marketplace)
