---
status: accepted
date: 2026-06-07
---

# ADR-0057: ServerSchema as a discriminated union on `transport`

## Context

`ServerSchema` (src/core/schema.ts) is a single `z.object` with both `command:
z.string()` and `url: z.string().optional()`, a `transport` enum defaulting to
`"stdio"`, and a `.superRefine` that rejects the illegal `stdio + url`
combination. This lets illegal states be representable and only catches the one
combination the refine happens to check. The schema's own comment (and seed
`agent-manager-a067`) flagged the intended fix: a `z.discriminatedUnion` on
`transport` so the type system makes the stdio/remote shapes mutually exclusive.

Two facts make this safe and small (verified empirically against the repo's
pinned `zod@3.25.76` during research, `docs/research/2026-06-07-backlog/`):

1. **Adapters don't consume `z.infer<Server>` directly.** All 13 export paths
   read the hand-written `ResolvedServer` interface (decoupled from the Zod
   type). So discriminated-union narrowing does NOT cascade into adapters — the
   feared 13-file churn is unfounded.
2. **`am` stores the remote URL in `command`** (export-utils reads
   `server.command` for remote transports; `url` is largely informational). So
   `command` must remain valid on the remote variant too.

### The default-discriminator sharp edge

`z.discriminatedUnion` inspects the raw discriminator value *before* field-level
`.default()` applies. A config `{ command = "x" }` with `transport` absent
therefore throws `"No matching discriminator"` at runtime even if the stdio
variant's `transport` literal carries `.default("stdio")`. Verified. The fix is
to inject the default with `z.preprocess` *before* the union runs.

## Decision

Replace the object+superRefine with a `z.preprocess`-wrapped
`z.discriminatedUnion("transport", [Stdio, Remote])`:

- A shared `ServerBase` `z.object` holds every common field — **including
  `command`** — so `z.infer<Server>` keeps `command`/`args`/`env`/`tags`/etc.
  present on both variants (zero adapter/bridge churn).
- `StdioServer = ServerBase.extend({ transport: z.literal("stdio"), url:
  z.undefined().optional() })` — `url` forbidden structurally (replaces the
  superRefine `stdio+url` branch at both type and runtime level).
- `RemoteServer = ServerBase.extend({ transport: z.union([literal
  "streamable-http", literal "sse"]), url: z.string().optional() })`.
- `z.preprocess` injects `transport: "stdio"` when the key is absent (guarding
  for an object input), preserving today's default-to-stdio behavior.
- The `_registry` XOR `_marketplace` invariant is re-attached via `.superRefine`
  on the union.

`command` stays on both variants (deliberately, per fact 2) — this ADR does NOT
drop it. A later ADR may split command/url cleanly once the remote path stops
overloading `command`.

## Consequences

### Positive
- Illegal `stdio + url` states are now unrepresentable at the type level, not
  just rejected by one ad-hoc refine.
- No adapter changes — `ResolvedServer` is the decoupling layer.

### Negative / Neutral
- The outer schema becomes a `ZodEffects` (from `preprocess`), so `.shape` /
  `.extend` / `.pick` / `.omit` are unavailable on `ServerSchema`. Current usage
  is only `.parse`/`.safeParse` + `z.record(z.string(), ServerSchema)` — all
  fine. If a future caller needs `.shape`, expose the inner union separately.
- Exactly two object-literal-then-mutate write sites (`commands/install.ts`,
  `marketplace/installer.ts`) construct `{...}` then assign `server.url`; under
  the union they must build the remote object with `url` already present
  (branch on transport) instead of post-hoc mutation.
- The `stdio+url` error message changes from a custom string to a Zod
  `invalid_type` on `["url"]`; tests asserting only `.toThrow()` stay green.

## Alternatives considered
- **Keep the object + superRefine.** Rejected: leaves illegal states
  representable; only catches combinations the refine enumerates.
- **`.default("stdio")` on the literal, no preprocess.** Rejected: typechecks
  but throws at runtime on transport-absent config (verified) — the union picks
  the branch before defaults apply.
- **Drop `command` from the remote variant (clean split).** Deferred: `am`
  currently stores the remote URL in `command`; removing it touches
  export-utils + mcp-superset + url-credentials and breaks round-tripping.
  A follow-up ADR can do the clean split once that overload is removed.

## References
- Seed `agent-manager-a067`. Research brief:
  `docs/research/2026-06-07-backlog/research-raw.txt` (Zod 3.25.76 probes;
  coder/mux + huggingface.js tiny-agents precedents).
- Touch points: `src/core/schema.ts` (ServerSchema), `src/commands/install.ts`,
  `src/marketplace/installer.ts`, `test/core/schema.test.ts`.
