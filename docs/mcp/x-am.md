# `x-am.*` — MCP Tool Metadata Extension

> Client reference for the agent-manager–specific metadata surfaced on every
> tool entry in `tools/list`. See [ADR-0037] for the design rationale.

**Stability**: Phase 1 fields are stable. Phase 2/3 fields (`output_schema`,
`error_codes`, `progress_shape`) are deferred and NOT guaranteed present.

**Spec basis**: MCP [2025-11-25 server/tools][mcp-tools-2025-11-25] permits
arbitrary extension fields on tool objects. The `x-` prefix follows the
OpenAPI convention for vendor-specific extensions and is forward-compatible
with any future upstream MCP standardization.

## Why

The MCP spec's `tools/list` returns `{name, description, inputSchema}` per
tool. It does NOT tell a client:

- which permission **tier** a tool is (read-only, write-local, write-remote);
- whether the tool requires a **bearer token** when `AM_MCP_TOKEN` is set;
- whether the tool is a **deprecated alias** and what replaces it;
- whether the tool emits **`notifications/progress`** events when called with
  a `_meta.progressToken`;
- which **tool group** the tool belongs to (so a UI can filter, badge, or
  cluster them).

Before ADR-0037, every MCP-client author against agent-manager either
source-dived, parsed stderr deprecation warnings, or trial-and-errored.
`x-am.*` closes that gap with a single structured object on every tool.

## Where it lives

The `x-am` object is attached at the SAME level as `name` / `description` /
`inputSchema` on each tool entry returned by `tools/list`. The MCP spec
2025-11-25 defines tool objects with `additionalProperties: true`, so
unknown keys are allowed and MUST be ignored by conformant clients.

Example wire shape (abbreviated):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "am_apply",
        "description": "Apply active profile to configured adapters.",
        "inputSchema": { "type": "object", "properties": { /* ... */ } },
        "x-am": {
          "group": "core",
          "tier": "write-local",
          "auth_required": true,
          "deprecated": false,
          "progress_supported": false
        }
      }
    ]
  }
}
```

## Field reference (Phase 1 — shipped)

Derivation: everything in `x-am` is computed by `buildToolMetadata(name, tier)`
in [`src/mcp/server.ts`][server-ts] (§`buildToolMetadata`). No hand-maintained
registry per tool; adding a new tool gets metadata automatically.

### `group` (required)

- Type: `"core" | "registry" | "a2a" | "wiki" | "session" | "acp"`
- Source: `TOOL_GROUP_MAP` in `src/mcp/server.ts` + `McpToolGroup` enum in
  `src/core/schema.ts`.
- Use: clients can cluster / filter tools by feature area. The same enum
  drives `settings.mcp_serve.tools` filtering (ADR-0021).

### `tier` (required)

- Type: `"read-only" | "write-local" | "write-remote"`
- Source: `ToolEntry.tier` declared when each tool is registered
  (ADR-0009 permission tiers).
- Use:
  - `read-only` — never mutates state; safe on any connection.
  - `write-local` — mutates local config / working dir (requires auth when
    `AM_MCP_TOKEN` is configured).
  - `write-remote` — touches remote services (always requires auth; must
    be opt-in through `settings.mcp_serve.write_remote`).

### `auth_required` (required)

- Type: `boolean`
- Derivation: `tier !== "read-only"`.
- Use: client-side hint at discovery time for whether to include
  `_meta.authorization` on the call. This is STATIC — it does not depend
  on whether the running server actually has a token configured. A
  read-only tool stays `false` either way; a write-tier tool stays `true`
  either way.

### `deprecated` (required)

- Type: `boolean`
- Derivation: `true` iff the tool name appears as a key in
  `DEPRECATED_ALIASES`.
- Use: clients can surface a warning in autocomplete / docs without waiting
  for the first invocation to produce a stderr deprecation line.

### `deprecation` (conditional — present iff `deprecated === true`)

- Type: `{ replacement: string; removal_version: string }`
- Source: `DEPRECATED_ALIASES` registry in `src/mcp/server.ts`.
- Use: structured replacement info. Example:

```json
"x-am": {
  "group": "acp",
  "tier": "write-remote",
  "auth_required": true,
  "deprecated": true,
  "deprecation": { "replacement": "am_agent_invoke", "removal_version": "v0.4" },
  "progress_supported": true
}
```

Current shipped deprecations (as of 2026-05-05):

| Old name                   | Replacement              | Removal |
|----------------------------|--------------------------|---------|
| `am_agent_delegate`        | `am_agent_invoke`        | v0.4    |
| `am_run_agent`             | `am_agent_invoke`        | v0.4    |
| `am_acp_list_agents`       | `am_agent_list`          | v0.4    |
| `am_acp_session_list`      | `am_agent_session_list`  | v0.4    |
| `am_acp_session_cancel`    | `am_agent_session_cancel`| v0.4    |

### `progress_supported` (required)

- Type: `boolean`
- Source: `PROGRESS_SUPPORTED` set in `src/mcp/server.ts`, derived from
  actual `ctx.emitProgress(...)` call sites.
- Use: clients that subscribe to `notifications/progress` should only set
  `_meta.progressToken` on tools where `progress_supported === true`.
  Setting a token on a tool that does not emit progress is harmless but
  wastes wire chatter.

## Deferred fields (Phase 2 / Phase 3)

The following are specified in ADR-0037 but NOT yet emitted. Clients MUST
treat their absence as "unknown / unstructured" and MUST NOT depend on them.

- `output_schema` — JSON Schema for the successful-return shape.
- `error_codes` — `Array<{code, description}>` for structured error tags.
- `progress_shape` — documents the shape of progress `message` payloads
  (especially for ACP session-update forwarding).

These land tool-by-tool rather than 38-at-once. The rollout plan targets
five high-value tools first (`am_apply`, `am_agent_invoke`, `am_status`,
`am_registry_search`, `am_session_export`); see the ADR-0037 follow-up
issue when that work kicks off.

## Relationship to upstream MCP annotations

The MCP spec has been moving in parallel. Clients that ONLY read upstream
annotations get coarse coverage; clients that read `x-am` get full coverage.
Where both exist, they are intended to stay consistent.

| `x-am` field           | Upstream analogue                        | Status    |
|------------------------|------------------------------------------|-----------|
| `tier`                 | `readOnlyHint` + `destructiveHint`       | 2025-03-26 spec rev |
| `auth_required`        | *(none — am-specific)*                   | —         |
| `deprecated`           | *(none — am-specific)*                   | —         |
| `deprecation`          | *(none — am-specific)*                   | —         |
| `progress_supported`   | implicit from `_meta.progressToken` contract | — |
| `group`                | *(none — am-specific)*                   | —         |
| Phase 2 `output_schema`| `outputSchema`                           | 2025-11-25 spec rev |

Additional upstream hints under active discussion in community SEPs:
`idempotentHint`, `openWorldHint`, `sensitiveHint`, `egressHint`,
`reversibleHint`. agent-manager has not adopted these yet.

### Dual emission policy

Long-term, `x-am.*` and upstream annotations should coexist. The am-side
fields stay canonical for richer semantics (tiered permissions, deprecation
schedule, group) while upstream annotations cover generic hints.

When a Phase 2+ tool adds `output_schema`, agent-manager will also emit
the upstream `outputSchema` field with the same JSON Schema value, so
am-unaware clients still get the benefit. Similarly, when the `tier` →
`readOnlyHint` / `destructiveHint` mapping is formalised (tracked
separately), it will dual-emit both:

- `tier == "read-only"`  ⇒ `readOnlyHint: true`
- `tier == "write-local"` ⇒ `readOnlyHint: false`, `destructiveHint` per tool
- `tier == "write-remote"` ⇒ `readOnlyHint: false`, `destructiveHint` per tool

Dual emission is NOT yet implemented. Clients SHOULD read `x-am.*` if they
want these semantics today.

## Versioning

- `x-am.*` field SHAPES are stable within a major release. Renaming or
  removing a field is a breaking change and triggers a new major or an
  ADR-level deprecation cycle.
- New OPTIONAL fields may be added at any time under the `x-am` object
  without bumping compat. Clients MUST ignore unknown keys.
- Addition of a Phase 2/3 field on a given tool (e.g. `output_schema`
  landing for `am_apply`) is additive and MUST NOT be read by clients as
  a breaking change.
- Upstream adoption: if the MCP spec standardises a field that has an
  `x-am.*` analogue, agent-manager will:
  1. dual-emit both for at least one minor release,
  2. document the overlap in this file,
  3. keep the `x-am.*` field until clients have had time to migrate
     (removal is a separate ADR).

## Client usage example

```ts
// Pseudocode for an MCP client that wants to show deprecation badges
const { tools } = await mcp.request({ method: "tools/list" });
for (const tool of tools) {
  const xam = tool["x-am"];
  if (!xam) continue; // server is not agent-manager; skip

  if (xam.deprecated && xam.deprecation) {
    console.warn(
      `Tool '${tool.name}' is deprecated — use '${xam.deprecation.replacement}' ` +
      `(removal: ${xam.deprecation.removal_version})`,
    );
  }

  if (xam.auth_required && !client.hasBearerToken()) {
    // Skip showing it, or render as "requires auth"
  }

  if (xam.progress_supported) {
    // Offer this tool in a "long-running / streaming" UI lane
  }
}
```

## Conformance

The conformance test [`test/mcp/x-am-metadata.test.ts`][conformance-test]
pins the contract:

- every tool in `tools/list` carries an `x-am` object;
- every `x-am` object has the 5 required fields (`group`, `tier`,
  `auth_required`, `deprecated`, `progress_supported`) with valid enum
  values;
- `auth_required` is consistent with `tier`;
- deprecated aliases carry a `deprecation` sub-object; non-deprecated
  tools do not;
- `progress_supported` matches the `PROGRESS_SUPPORTED` registry;
- `DEPRECATED_ALIASES` stays in sync with `warnDeprecated(...)` call sites;
- `buildToolMetadata` is pure (same input → same output).

Run it with:

```shell
bun test test/mcp/x-am-metadata.test.ts
```

## References

- ADR-0037 — Per-Tool MCP Metadata via `x-am.*` Namespace
  ([`ADRs/0037-per-tool-mcp-metadata.md`][ADR-0037])
- ADR-0009 — MCP server mode (permission tiers)
- ADR-0021 — MCP tool grouping
- ADR-0036 — Per-agent variants (forward-compat pointer for `am_agent_invoke`)
- `src/mcp/server.ts` — `AmToolMetadata`, `DEPRECATED_ALIASES`,
  `PROGRESS_SUPPORTED`, `buildToolMetadata`
- MCP spec 2025-11-25 server/tools:
  https://modelcontextprotocol.io/specification/2025-11-25/server/tools

[ADR-0037]: ../../ADRs/0037-per-tool-mcp-metadata.md
[server-ts]: ../../src/mcp/server.ts
[conformance-test]: ../../test/mcp/x-am-metadata.test.ts
[mcp-tools-2025-11-25]: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
