---
status: accepted
date: 2026-05-05
amends: ADR-0007
---

# ADR-0041: ADR-0007 Phase 2 Resolution — Delete the Adapter Schema Field

## Context

[ADR-0007](0007-two-phase-zod-validation.md) (`accepted` 2026-04-07)
described a two-phase Zod validation strategy:

- **Phase 1 — Core validation:** strict, applied at config load. Shipped.
- **Phase 2 — Adapter validation:** each adapter validates its own
  `[entity.adapters.<name>]` subtable against an adapter-owned Zod
  schema. **Never wired.**

The 2026-05-05 parallel-critique architecture lens verified, against
`main` at d0ba4e6:

```
$ rg '\.schema\.(parse|safeParse)' src/
(zero hits)
```

All 13 built-in adapters populate a `schema: AdapterSchema` field on
their `Adapter` instance. The community-adapter proxy
(`src/adapters/community/proxy.ts`) fetches a schema from the
subprocess via JSON-RPC `adapter/schema` and stores it on the proxy.
**Nothing reads any of these.** The 13 `schema.ts` files (≈421 LOC
total) and the 14 wire-up sites are dead code carried as if it were
load-bearing.

The synthesis recommendation (C2 in
`docs/reviews/2026-05-05-parallel-critique/synthesis.md`) was: wire it
or delete it.

## Decision

**Delete the `schema` field from the Adapter interface.**

Specifically:

1. Remove `schema: AdapterSchema` from `Adapter` in
   `src/adapters/types.ts`. Remove the `AdapterSchema` interface too —
   it has no remaining consumers.
2. Delete the 13 `src/adapters/<name>/schema.ts` files.
3. In each of the 13 `src/adapters/<name>/index.ts` files, drop the
   `import { ... } from "./schema.ts"` and the `schema: ...` field
   from the exported adapter object.
4. In `src/adapters/community/proxy.ts`, drop the `schema` field, the
   constructor parameter, and the JSON-RPC `adapter/schema` handshake
   call. The community-proxy protocol shrinks by one method; document
   in `src/adapters/community/types.ts` that `adapter/schema` is no
   longer requested by the host.
5. Update `test/adapters/registry.test.ts` and
   `test/adapters/community/proxy.test.ts` to remove the
   `expect(adapter.schema).toBeDefined()` assertions.
6. Amend [ADR-0007](0007-two-phase-zod-validation.md) status to
   reflect that Phase 2 was withdrawn (frontmatter
   `amended_by: ADR-0041`, with a header note pointing here).

This ADR does NOT change Phase 1 — strict core validation continues
unchanged. It does not change `z.record(z.string(), z.unknown())` for
`adapters.*` subtables — those are still preserved opaque, just no
longer revalidated by adapter-owned schemas (which never happened
anyway).

### Why delete rather than wire

- Built-in adapters are TypeScript code; their consumption of
  `[entity.adapters.<name>]` is type-checked at the compile site.
  Phase 2 caught zero typos in production because no production
  `[entity.adapters.<name>]` subtable has been fielded that would
  fail validation but pass type checking.
- Community adapter input validation is already covered by the
  community proxy's protocol envelope (initialize handshake,
  protocol version, JSON-RPC type checking). The `schema` round-trip
  was passthrough — it never gated anything.
- The ADR-0027 community proxy uses its own validation path for
  proxy-provided data; it does not need adapter-side schemas to
  validate user-provided data because the user-provided data flows
  through Phase 1 already.
- The cost of leaving 421 LOC of dead infrastructure across 13
  adapters is paid at every adapter refactor, every "where do I
  put X" decision, and every reading of the adapter pattern as a
  template for the 14th. Negative carry.
- Re-introduction is cheap if a real use case appears. Adapters are
  isolated; adding a schema field back to a single adapter (or to
  the interface) is a ~30-LOC change. We are not burning a bridge,
  we are removing a vestigial limb.

## Consequences

### Positive

- Removes ~421 LOC of dead schema declarations + wire-up.
- The Adapter interface narrows from "import / export / diff /
  detect / **schema**" to four methods, matching what an adapter
  *actually does*. Every reading of the adapter pattern is now
  honest.
- New (14th) adapters do not need to author a `schema.ts` file
  whose only purpose was to satisfy the type system. The "how do I
  ship an adapter" mental model simplifies.
- Community-proxy protocol is one round-trip lighter at startup
  (no `adapter/schema` call). Marginal but real.

### Negative

- **Loss of optionality.** If we later decide community-adapter
  output validation is needed (e.g., a community adapter returns a
  malformed `ImportedServer`), we have removed the seam where it
  would naturally live. We would re-add it. ADR-0027 existing
  protocol-envelope validation is the proximate fallback.
- **An ADR is being walked back.** ADR-0007 Phase 2 was `accepted`
  for ~13 months and is now being withdrawn. Future readers may see
  that as ADR drift. The amendment trail (ADR-0007 →
  `amended_by: ADR-0041`) is the audit record.
- **Zero remaining defense-in-depth at the adapters/<name> subtable
  layer.** Phase 1 is the only validator; it treats subtables as
  opaque. Mitigation: adapter consumers in TypeScript see strict
  types at the compile site; runtime errors surface inside the
  adapter rather than at config-load time. This is the status quo —
  we are documenting it, not regressing it.

### Neutral

- Tests adjust by 2 assertions; bun test count unchanged in net.
- ADR-0007 stays `accepted` (Phase 1 is shipped and load-bearing);
  the amendment narrows its scope.

## Alternatives Considered

**Option B — Wire Phase 2 for built-in adapters and community proxy
output.** At config load, for each built-in adapter, run
`adapter.schema.server?.safeParse(server.adapters[name])` with
warnings on fail (not errors, to preserve forward-compat for a future
adapter the user has on a different machine). Validate
community-proxy responses against their declared JSON-Schema in the
proxy's response handler.

Rejected because:

- The validation gain is hypothetical (no real-world failures
  reported in 13 months of production passthrough).
- The community-proxy use case is already covered by the protocol
  envelope; layering schema validation on top adds cost without
  observed benefit.
- Wiring requires touching config-load (`src/core/config.ts`) — a
  hot path — and threading warnings through the diagnostic
  pipeline. Material effort for unverified upside.
- If a real use case surfaces for community-proxy output validation,
  it can be added narrowly (community-only) without resurrecting
  the built-in-adapter schema field.

**Option C — Keep the field, mark it `@deprecated`, plan future
removal.** Rejected. Soft-deprecation accumulates in repos; the
actual removal never happens. A clean cut is cheaper than carrying
13 schemas in a deprecated state for an indefinite period.

## References

- [ADR-0007 Two-phase Zod validation](0007-two-phase-zod-validation.md)
- [ADR-0027 Community adapter loading](0027-community-adapter-loading.md)
- `src/adapters/types.ts` (pre-change)
- `src/adapters/community/proxy.ts` (pre-change)
- `docs/reviews/2026-05-05-parallel-critique/synthesis.md` — finding C2
