---
status: proposed
date: 2026-06-04
supersedes: 0021
---

# ADR-0055: Runtime Access-Scoping Profiles for the MCP Server (Scopes)

## Context

ADR-0021 (accepted) made `settings.mcp_serve.tools` a GLOBAL tool-group
filter and EXPLICITLY rejected profile-scoped tool groups: "MCP serve is a
global process, not profile-scoped. Could revisit if multi-profile MCP serving
is needed" (ADR-0021:110-112). That premise no longer holds. The vision is for
`am` to be both a CLI that manages agents AND the MCP server agents call from
inside a session, where the active profile scopes ACCESS (tools, and later
skills/agents/knowledge) at RUNTIME.

Ground truth in the current code makes this a single, contained decoupling:

- `src/mcp/server.ts` already resolves the active profile name
  (`loadConfigAndProfile`, server.ts:620-631; `readActiveProfile` ??
  `default_profile` ?? 'default') but THROWS IT AWAY for tool gating.
- `tools/list` (server.ts:3022-3048) filters by `this.settings?.mcp_serve?.tools`
  ?? `DEFAULT_TOOL_GROUPS=['core']` (server.ts:386,3025-3026) — the GLOBAL
  settings block, never the profile.
- `tools/call` (server.ts:3051+) checks only tier/auth/zod, never the profile.
- `ProfileSchema` (src/core/schema.ts:136-147) has servers/server_tags/skills/
  agents/instructions/inherits but NO tool-access field — there is literally
  nowhere to declare per-profile tool scope today.
- The server advertises `capabilities: { tools: {} }` (server.ts:3003) — NO
  `listChanged` — so it cannot legally tell a live client its tool set changed
  after `am_use_profile`.
- stdio `mcp-serve` is single-session by construction (one subprocess == one
  client). True multi-profile-from-one-process only arises under HTTP (ADR-0056).

### Naming: a THIRD term, to stop the collision

Two "profile" concepts already strain the codebase: `AgentProfile`
(schema.ts:106, an agent EXECUTION spec, has its own `tools`/`disallowed_tools`
for what THAT agent may call) and `Profile` (schema.ts:136, the catalog
SUBSET). We do NOT introduce a third TYPE. We name the runtime BEHAVIOUR a
**Scope**: the access boundary the active `Profile` projects over the MCP
surface. The `Profile` type gains a `scope` subtable; the word "capability" is
reserved for explanatory docs only, never a schema key.

## Decision

**Supersede ADR-0021's rejection of profile-scoped tool groups.** Make the
active `Profile` a runtime Scope over the MCP tool surface, in two phases
matched to `am`'s two transports.

### Decision 1 — Schema: `Profile.scope` (the missing resource axis)

Extend `ProfileSchema` (schema.ts:136) with an optional `scope` subtable that
mirrors `settings.mcp_serve` so they COMPOSE BY INTERSECTION:

```ts
scope: z.object({
  tool_groups: z.array(z.enum(MCP_TOOL_GROUPS)).optional(),
  allow_tools: z.array(z.string()).optional(),
  deny_tools: z.array(z.string()).optional(),
}).optional()
```

Resolution (added to `resolveProfile`, resolver.ts:28-101, reusing the existing
parent-first/child-wins union; surfaced on `ResolvedProfile`, resolved.ts:4-12):

```
effective = (global settings.mcp_serve.tools  AS CEILING)
            INTERSECT (profile.scope.tool_groups if set, else the ceiling)
            PLUS  allow_tools
            MINUS deny_tools     // deny-overrides; deny wins
```

A profile that omits `scope` = today's global behaviour (safe default). This is
what keeps the tool-count test fences green: the default surface is unchanged.

### Decision 2 — Enforcement: gate BOTH list and call

In `src/mcp/server.ts`, intersect the resolved Scope into BOTH `tools/list`
(server.ts:3025-3028, HIDE) AND `tools/call` (server.ts:3051+, REFUSE with a
-32601-style "tool not available in active profile <name>"). Hiding alone is
not a boundary — an agent can call a name it saw before switching or
hallucinated. The Scope is a CEILING: it can NEVER widen beyond the global
`settings.mcp_serve.tools`. An unknown/typo profile resolves to default and
MUST NOT silently widen the surface (mirror the PROFILE_NOT_FOUND guard in
src/commands/use.ts).

### Decision 3 — Phase 1 connection-supplied Scope (stdio, cheap, ships now)

stdio is one-client-per-process, so "connection-supplied profile" reduces to
"process-supplied profile". Two channels, in priority order: (a) the
`initialize` param `params.capabilities.experimental['am.profile']`
(spec-legal: experimental capabilities are sanctioned; the handler at
server.ts:2963 currently reads only protocolVersion); (b) an env var fallback.
Stash the validated name on the instance and resolve the Scope from it instead
of the bare global settings. `am_use_profile` (server.ts:1461) updates the
active Scope.

### Decision 4 — listChanged for live switching

Advertise `capabilities.tools.listChanged: true` (server.ts:3003) and emit
`notifications/tools/list_changed` from `am_use_profile` after the switch, and
when the active profile changes out-of-band (state.toml edited by another
terminal — requires a watch/poll on state.toml, the one moderately-hard piece).
Without the capability flag, emitting the notification violates the spec and
clients ignore it.

### Decision 5 — Per-request resolution under HTTP (forward-compat with ADR-0056)

When the HTTP transport (ADR-0056) lands, Scope resolution MUST become a
function of the connection/session, NOT the shared `this.settings` instance
field, or concurrent HTTP connections cross-contaminate tool sets. Phase 1 may
use the instance field because stdio is single-session; Phase 2 must not.

### Decision 6 — Auditability

Ship `am profile show <name> --tools` and an MCP read-only tool that returns the
resolved Scope manifest {visible groups, allow, deny, effective tool names},
routed through the SAME `resolveProfile` so the explanation cannot drift from
enforcement. This is `am`'s differentiator over opaque interceptor functions:
the boundary is a git-diffable artifact.

## Consequences

### Positive
- The keystone vision (profiles scope ACCESS at runtime) is satisfied by adding
  ONE resource axis to the existing RBAC-additive model — no new engine.
- Per-profile token reduction falls out for free (the same intersection that
  scopes access also shrinks the emitted tools/list).
- Stays in-process, single-session, additive for Phase 1 — ships this iteration.

### Negative
- Out-of-band profile switches need a state.toml watch to push list_changed;
  until then a stale list is possible (tools/call still refuses correctly, so
  it fails loud, not silently wide).
- allow_tools/deny_tools by exact name are rename-fragile (ADR-0021's original
  objection). Mitigate: validate names against the live registry at load and
  surface unknowns via `am doctor`; prefer group-level tool_groups for
  durability; reserve name-level for power users. NEVER silent-skip an unknown
  name on a security field (that is fail-open).

### Neutral
- A profile without `scope` behaves exactly as today; the 38(->N) tool-count
  fences (test/mcp/server.test.ts, test/mcp/zod-validation.test.ts) stay green
  because the DEFAULT surface is unchanged. New behaviour is asserted only under
  a profile that SETS `scope`.

## Alternatives Considered
- **Keep ADR-0021 global-only.** Rejected: directly blocks the stated vision;
  the server already resolves the profile and discards it.
- **New `Scope`/`CapabilityProfile` TYPE.** Rejected: a third type deepens the
  AgentProfile-vs-Profile collision. Extend `Profile` with a `scope` subtable;
  "Scope" is the behaviour name, not a new schema type.
- **Cedar/ABAC policy DSL.** Rejected as overkill for single-dev local config:
  one principal axis (the active profile), no request-context attributes worth
  evaluating. Borrow only implicit-deny-once-opted-in and deny-overrides.
- **Capability tokens (object-ref + rights, transferable).** Rejected: adds a
  revocation problem `am` doesn't have. Treat the resolved Scope as an ephemeral
  capability set computed per session from the git-backed ACL — capability
  semantics with ACL-style O(1) revocation (edit profile, re-resolve).
- **FastMCP-style mutable per-session enable_components on the hand-rolled stdio
  server first.** Rejected as first step: needs listChanged plumbing + per-
  connection instance isolation `am` lacks; reach it via ADR-0056.

## References
- Supersedes ADR-0021 (MCP Tool Grouping via Profiles and Gateway Mode).
- ADR-0040 (Controller scope/concurrency) — Scope resolution lives in shared
  core so CLI/MCP/web/TUI read the same decision.
- ADR-0056 (Remote Streamable-HTTP MCP Transport) — Phase 2 per-session Scope.
- src/mcp/server.ts:386,392,620-631,1461,3003,3022-3048,3051+ ; src/core/
  schema.ts:136-152 ; src/core/resolver.ts:28-101 ; src/core/resolved.ts:4-12.
- MCP spec 2025-06-18 basic/lifecycle (experimental capabilities), server/tools
  (listChanged, notifications/tools/list_changed).
