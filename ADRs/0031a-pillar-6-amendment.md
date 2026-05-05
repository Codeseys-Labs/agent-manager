---
status: accepted
date: 2026-05-05
amends: ADR-0031
---

# ADR-0031a: Pillar 6 — Local-Write-Path Scope Clarification

## Context

[ADR-0031](0031-product-scope-and-pillars.md) pillar 6 ("Three editing
surfaces over one core") states, in its accepted body:

> All three are skins over the same core via `core/controller.ts` (iter4
> Wave B) — no parallel implementations.

The 2026-05-05 parallel-critique architecture lens flagged that this
literal claim is incorrect against the shipped code. ADR-0031 is
`accepted` and bodies are immutable post-acceptance per the
adr-methodology convention used in this repo (see ADR-0033's
`pending_amendment_by` header for the precedent), so the fix is a
companion amendment rather than an in-place edit.

### What is actually true on disk (verified 2026-05-05 against `main`)

- **TUI** (`src/tui/`) routes mutations through `core/controller.ts` —
  `withConfig` for read-modify-write, `applyResolved` for apply.
  Confirmed at the canonical-controller-pipeline collapse landed in iter4
  Wave B (`handleRemoveServer`, `handleImport`, `handleApply`).
- **Local web** (`am serve`, `src/web/server.ts`) routes mutations through
  the same controller primitives.
- **Cloudflare Worker** (`src/web/worker.ts`) **imports nothing from
  `src/core/*`**. It is a stateless, independently-deployable git-over-HTTP
  client per [ADR-0015](0015-stateless-web-ui.md). It cannot apply, cannot
  detect tools, cannot reach the user's machine — it only edits the
  user's config repo via the platform's git API and pushes.

In other words, the controller is the chokepoint for **local write
paths** (TUI + local web). The CF Worker is intentionally outside that
chokepoint because [ADR-0015](0015-stateless-web-ui.md) makes it a
separate system that shares the config repo, not the core engine.

## Decision

Pillar 6 is hereby clarified as follows. Future audits, README/docs
authors, and AGENTS.md should use this wording, not the original.

> **Pillar 6 — Three editing surfaces, one local write path.**
> TUI (`am tui`) and local web (`am serve`) both route writes through
> `core/controller.ts` via `withConfig` + `applyResolved` — no parallel
> implementations of admission or apply on the user's machine. The
> Cloudflare Worker UI is an independently-deployed git-over-HTTP client
> per ADR-0015; it does NOT share `src/core/*`, cannot apply to native
> IDE files, and treats the config repo as the source of truth. The
> three surfaces converge on the **config repo**, not on a shared
> in-process core.

The companion AGENTS.md "Core tenets" pillar 6 entry is updated to match
in the same change set.

This is a documentation-only correction. No code change is implied; the
shipped behavior was already correct and is what the new wording
describes.

## Consequences

### Positive

- Audits no longer flag pillar 6 as "spec drift." The yardstick matches
  what shipped.
- The CF Worker's "no core import" property is now an explicit
  invariant readers can check, not an accident waiting for a
  well-intentioned PR to break.
- Future contributors thinking "the controller should also gate the
  CF Worker writes" are pointed at ADR-0015 first; the chokepoint
  argument doesn't extend across machines.

### Negative

- Pillar 6 is slightly less marketable. "Three UIs, one core" is a
  cleaner pitch than "two UIs share a core, the third shares the
  repo." The amendment trades pitch tidiness for accuracy.
- ADR-0031's body now disagrees with this companion ADR. Readers MUST
  consult both. The `amends:` frontmatter and the cross-reference
  added to ADR-0031 mitigate but do not eliminate this.

### Neutral

- No code surface is added or removed.

## Alternatives Considered

**Edit ADR-0031 in place.** Rejected — bodies of accepted ADRs are
immutable in this repo (precedent: ADR-0033 uses a companion-ADR
amendment via `pending_amendment_by`). In-place edits make ADRs
unauditable retroactively.

**Drop pillar 6 from ADR-0031 entirely and rewrite.** Rejected —
disproportionate. The pillar is correct in intent (three surfaces,
shared source-of-truth, no parallel implementations of writes); only
the wording needs precision.

**Rebuild the CF Worker on top of `core/controller.ts` so the
original wording becomes true.** Rejected — directly contradicts
ADR-0015's "independently deployable, no local filesystem access"
property. The Worker would need to import a Node-only path module set
that doesn't exist in the Workers runtime, and apply-to-IDE-files
makes no sense from a deployed cloud service.

## References

- [ADR-0031 Product scope and pillars](0031-product-scope-and-pillars.md)
- [ADR-0015 Stateless web UI](0015-stateless-web-ui.md)
- [ADR-0033 ACP agent tiers](0033-acp-agent-tiers-and-shim-wrapper.md) — precedent for companion-ADR amendment pattern
- `docs/reviews/2026-05-05-parallel-critique/synthesis.md` — finding C4
