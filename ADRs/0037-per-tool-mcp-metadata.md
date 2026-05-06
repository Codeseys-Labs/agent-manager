---
status: accepted
date: 2026-05-03
accepted: 2026-05-05
implementation:
  phase_1: shipped in commit 707105b (2026-05-03) — x-am on all tools in tools/list
  phase_2: deferred — per-tool output_schema
  phase_3: deferred — per-tool error_codes + progress_shape
verification:
  conformance_test: test/mcp/x-am-metadata.test.ts (8 tests, 623 expect() calls)
  client_reference: docs/mcp/x-am.md
  promoted_on: 2026-05-05 (Lens E acceptance roadmap)
---

# ADR-0037: Per-Tool MCP Metadata via `x-am.*` Namespace

## Context

`am mcp-serve` exposes 38 tools (ADR-0021 addendum) across 6 groups. The
MCP spec's `tools/list` response gives clients tool name, description,
and JSON Schema for `inputSchema`. It does NOT give clients:

- Which **group** a tool belongs to (core / registry / a2a / wiki /
  session / acp).
- Which **tier** the tool is (read-only / write-local / write-remote).
- Whether the tool requires **bearer auth** (when `AM_MCP_TOKEN` is set).
- Whether the tool is an **alias / deprecated** and what the replacement
  is (`am_acp_list_agents` → `am_agent_list`, removal targeted v0.4).
- Whether the tool **emits progress** (`notifications/progress`) when
  called with a `_meta.progressToken`.
- A structured **output schema** for the tool's result shape.
- Typed **error codes** or error-shape guarantees for downstream
  consumers.

The 2026-05-02 all-pillars review (Pillar 2, §5.1-2) called this the
single biggest docs-for-builders gap in Pillar 2. Each MCP-client author
builds against agent-manager reverse-engineers these properties from
source, stderr deprecation warnings, or trial-and-error.

The AM_MCP_TIMING log (shipped 2026-05-02) shows tool duration + success
flag, which is a first step but doesn't help builders at schema-discovery
time. This ADR is about the STATIC contract exposed through `tools/list`.

Related: ADR-0036 adds an `am_agent_invoke` `variant` parameter that
downstream clients will need to discover + validate. Without this ADR,
`am_agent_invoke` landing a new parameter is invisible at the protocol
level until a client tries to use it and fails.

## Decision

Extend every tool in `tools/list` with an **`x-am` extension object**
attached to the tool definition. The MCP spec permits server-specific
extension fields (the `x-` convention from OpenAPI carries over).
Clients that don't understand `x-am` ignore it; clients that do get
rich metadata.

### Shape

```json
{
  "name": "am_apply",
  "description": "...",
  "inputSchema": { ... },
  "x-am": {
    "group": "core",
    "tier": "write-local",
    "auth_required": true,
    "deprecated": false,
    "progress_supported": false,
    "output_schema": {
      "type": "object",
      "properties": {
        "action": { "const": "apply" },
        "profile": { "type": "string" },
        "dryRun": { "type": "boolean" },
        "results": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "adapter": { "type": "string" },
              "status": { "enum": ["ok", "failed"] },
              "files": { "type": "array" },
              "error": { "type": "string" }
            }
          }
        }
      }
    },
    "error_codes": [
      { "code": "ADAPTER_NOT_FOUND", "description": "Adapter --target is unknown" },
      { "code": "CONFIG_NOT_FOUND", "description": "Config dir missing or corrupt" },
      { "code": "ENCRYPTION_KEY_MISSING", "description": "Cannot decrypt secrets" }
    ]
  }
}
```

### Field definitions

| Field | Type | Required | Purpose |
|---|---|---|---|
| `group` | `"core" \| "registry" \| "a2a" \| "wiki" \| "session" \| "acp"` | ✓ | The tool-group enum from `McpToolGroup` (src/core/schema.ts) |
| `tier` | `"read-only" \| "write-local" \| "write-remote"` | ✓ | Permission tier from ADR-0009 |
| `auth_required` | `boolean` | ✓ | True if this tool checks the bearer token (write-tier). Clients use it to decide whether to include `_meta.authorization` on the call. |
| `deprecated` | `boolean` | ✓ | True if the tool is an alias slated for removal |
| `deprecation` | `{ replacement: string, removal_version: string }` | when `deprecated` | Structured replacement info. e.g. `{ replacement: "am_agent_list", removal_version: "v0.4" }` |
| `progress_supported` | `boolean` | ✓ | True if handler emits `notifications/progress` when `_meta.progressToken` is set |
| `progress_shape` | `object` | when `progress_supported` | Optional: documents what progress `message` payloads look like. For ACP session updates this points at the ACP spec. |
| `output_schema` | JSON Schema | optional-MVP | Shape of the tool's successful-return JSON. Optional in MVP because 38 tools × bespoke result shape is a lot. See Rollout. |
| `error_codes` | `Array<{code, description}>` | optional-MVP | Typed error codes the tool can raise (beyond generic `Invalid arguments` validation errors) |

### Placement

The `x-am` object goes INTO the tool definition itself, at the same
level as `name` / `description` / `inputSchema`. This works because the
MCP spec (2025-11-25) defines tool objects as "additionalProperties: true"
— client-specific extensions are allowed.

```typescript
// src/mcp/server.ts — ToolEntry extension
interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { ... };
  "x-am"?: AmToolMetadata;
}

interface AmToolMetadata {
  group: McpToolGroup;
  tier: ToolTier;
  auth_required: boolean;
  deprecated: boolean;
  deprecation?: { replacement: string; removal_version: string };
  progress_supported: boolean;
  progress_shape?: unknown;
  output_schema?: unknown; // JSON Schema
  error_codes?: Array<{ code: string; description: string }>;
}
```

### Rollout

Shipping x-am across 38 tools is substantial — 2 ADR-0037 subclaims:

**Phase 1 (ship in one PR):** required fields only — `group`, `tier`,
`auth_required`, `deprecated`, `deprecation`, `progress_supported`. Every
tool gets these, derived from the existing `ToolEntry.tier` + the
TOOL_GROUP_MAP + the existing alias deprecation list. Mechanical; ~1 day.

**Phase 2 (later):** `output_schema` per tool. Each schema requires
hand-crafting or codegen from the handler return type. Ship gradually.
A tool without `output_schema` means "not documented yet" — clients
should treat it as unstructured `unknown`.

**Phase 3 (later):** `error_codes`. Depends on a separate error-code
refactor (Pillar 2 §5.2 "Standardize {ok, data|error} envelope") — out
of scope for this ADR.

### Interaction with ADR-0036

`am_agent_invoke`'s schema gets an optional `variant: string` parameter
via Phase 1 of THIS ADR landing first. The x-am metadata clarifies
that `variant` selects an ADR-0036 variant entry. This ordering means
ADR-0036 variant wiring to the MCP surface waits on ADR-0037 Phase 1.

### Interaction with ADR-0021

ADR-0021 defines the tool-group enum and filter behavior. This ADR
surfaces the existing group assignment in the protocol. No behavior
change to filtering — just visibility.

## Consequences

### Positive
- MCP-client builders get a self-describing tool surface. No more
  source-diving to learn which tools need bearer tokens, which are
  deprecated aliases, or which emit progress notifications.
- Deprecation discovery moves from stderr log lines (currently emitted
  on every legacy alias call) to structured metadata. Builders can
  script "warn me if my tool is deprecated" checks.
- Progress-supported hint lets smart clients choose to set
  `_meta.progressToken` only when useful, cutting wire chatter on
  progress-unsupported tools.
- Forward-compat with ADR-0036 variants + future MCP tool extensions.

### Negative
- 38 tool definitions × N fields = real maintenance debt. Adding a new
  tool now requires filling metadata, not just the handler. Mitigation:
  derive from single source of truth (TOOL_GROUP_MAP + tier on ToolEntry)
  in the Phase-1 adapter function; new tools get metadata automatically.
- `output_schema` per tool is a substantial lift if done exhaustively
  (Phase 2). Accept that Phase 1 is the MVP and Phase 2/3 iterate.
- The `x-am` field adds ~100-200 bytes per tool entry in `tools/list`
  responses (6kb total at 38 tools). Negligible.

### Neutral
- No impact on non-MCP surfaces (CLI, web UI, TUI). Tool metadata lives
  in `src/mcp/server.ts` and surfaces via `tools/list` only.
- Backward compat is automatic: clients that don't read `x-am` are
  unaffected. The MCP spec says unknown fields MUST be ignored, not
  rejected.

## Alternatives Considered

**Free-form in `description` text.** Status quo. Rejected — regex
parsing of human prose is not a client contract. It's what 2026-05-02
reviewers correctly called out.

**Top-level MCP spec extension PR** (propose `mcp.tools.list` standardize
these fields). Appealing long-term but waiting on upstream spec process
blocks agent-manager's users today. ADR-0037 is expected-forward-compatible
with any upstream standardization — the `x-am` namespace prefix is
non-controversial and the fields themselves map to concepts MCP would
likely standardize (tier = scope, auth_required = permission, etc.).

**Flat top-level attributes** (e.g. `am_group: "core"`, `am_tier: "write-local"`).
Considered. Rejected — pollutes the top-level tool object with every
tool-specific concept. Nesting under `x-am` keeps the MCP core shape
clean.

**Separate `am_mcp_describe_tool` MCP tool** that returns metadata for
a named tool. Rejected — redundant round-trip. Clients should get the
metadata in the first `tools/list` without a second call.

## Verification Gates (closed 2026-05-05)

Phase 1 acceptance gates per the Lens E roadmap
(`docs/research/2026-05-05-deep-loop/lens-mcp-marketplace.md` §ADR-0037):

1. **Conformance test** — every tool in `tools/list` round-trips
   `x-am` with the 5 required fields, enum values valid, and
   deprecation/progress registries in sync. Closed by
   `test/mcp/x-am-metadata.test.ts` (8 tests, 623 expect() calls, all
   pass as of 2026-05-05).
2. **Client reference doc** — `docs/mcp/x-am.md` documents the
   `x-am.*` namespace for third-party MCP client authors, including the
   mapping to emerging upstream annotations (`readOnlyHint`,
   `destructiveHint`, `outputSchema`) and the dual-emission policy for
   future overlap.
3. **Follow-up pointer for Phases 2/3** — Phase 2 (`output_schema`) and
   Phase 3 (`error_codes`, `progress_shape`) remain deferred. The Lens E
   roadmap recommends a small-batch rollout (5 high-value tools first:
   `am_apply`, `am_agent_invoke`, `am_status`, `am_registry_search`,
   `am_session_export`) rather than 38-at-once. Each phase will land as
   its own ADR-level change so the per-tool schema work is reviewed
   alongside the surface it documents.

Promoted `proposed → accepted` on 2026-05-05.

## References

- ADR-0009 MCP server mode (permission tiers)
- ADR-0021 MCP tool grouping (group enum)
- ADR-0036 per-agent variants (will need x-am variant info on
  `am_agent_invoke`)
- `docs/research/2026-05-02-all-pillars-review/02-mcp-gateway.md` §5.1-2
- `src/mcp/server.ts:75-83` — current `McpToolDef` type
- `src/core/schema.ts:129-140` — `McpToolGroup` enum
- MCP spec 2025-11-25 tool definition permits unknown fields —
  https://modelcontextprotocol.io/specification/2025-11-25/server/tools
