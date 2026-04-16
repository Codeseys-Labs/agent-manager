# MCP Tools UX Review

**Date:** 2026-04-14
**Scope:** `src/mcp/server.ts` -- all 26 MCP tools across 4 groups (core, registry, a2a, wiki)
**ADRs:** ADR-0009 (MCP Server Mode), ADR-0021 (Tool Grouping & Gateway)

---

## Summary

The MCP server is well-structured with clear permission tiers, consistent JSON
responses, and a sensible tool grouping system. The main issues are: (1) naming
inconsistency between tool groups, (2) several high-value CLI operations missing
from the MCP surface, (3) a few error messages that don't guide the agent toward
recovery, and (4) the `core` group being too large (14 tools) while session tools
should be their own group per ADR-0021's own table.

**Tool count by group:**

| Group | Count | Read-only | Write-local | Write-remote |
|-------|-------|-----------|-------------|--------------|
| core | 14 | 7 | 4 | 3 |
| registry | 3 | 2 | 1 | 0 |
| a2a | 4 | 2 | 0 | 2 |
| wiki | 5 | 3 | 2 | 0 |
| **Total** | **26** | **14** | **7** | **5** |

---

## Findings

### 1. Tool Naming Consistency

**Severity: MEDIUM**

The naming convention is inconsistent across groups:

| Group | Pattern | Examples |
|-------|---------|---------|
| core | `am_<verb>_<noun>` | `am_add_server`, `am_remove_server`, `am_use_profile` |
| core | `am_<noun>_<verb>` | `am_session_list`, `am_session_export`, `am_session_search` |
| core | `am_<noun>` | `am_status`, `am_apply`, `am_import` |
| registry | `am_registry_<verb>` | `am_registry_search`, `am_registry_install` |
| a2a | `am_agent_<verb>` | `am_agent_discover`, `am_agent_delegate` |
| wiki | `am_wiki_<verb>` | `am_wiki_search`, `am_wiki_add` |

The core group mixes `am_<verb>_<noun>` (add_server, remove_server, list_servers)
with `am_<noun>_<verb>` (session_list, session_export). The registry/a2a/wiki groups
consistently use `am_<group>_<verb>`, which is the better pattern.

**Suggested fix:** Adopt `am_<group>_<verb>` universally. For core tools, this means
the group prefix is implicit (or use `am_server_add`, `am_server_remove`,
`am_server_list`, `am_profile_list`, etc.). The session tools already follow
`am_session_<verb>` which is correct.

The worst offenders are the config management tools with no group prefix at all:
`am_status`, `am_apply`, `am_import`. An LLM seeing these alongside `am_wiki_search`
has to infer that the unprefixed ones are "core" tools.

**Line refs:**
- `server.ts:153` -- `am_list_servers` (should be `am_server_list`)
- `server.ts:188` -- `am_list_profiles` (should be `am_profile_list`)
- `server.ts:209` -- `am_status` (no group prefix)
- `server.ts:253` -- `am_config_show` (inconsistent -- uses `config` prefix but others don't)
- `server.ts:462` -- `am_add_server` (should be `am_server_add`)
- `server.ts:525` -- `am_remove_server` (should be `am_server_remove`)
- `server.ts:555` -- `am_use_profile` (should be `am_profile_use`)
- `server.ts:588` -- `am_import` (no group prefix)
- `server.ts:819` -- `am_apply` (no group prefix)

### 2. Missing MCP Tool: Enable/Disable Server

**Severity: HIGH**

The most common agent operation after listing servers is toggling one on/off. The
web API has `PUT /api/servers/:name` with an `enabled` field (server.ts:230), and
the CLI presumably supports this via `am config`, but the MCP server only offers
`am_add_server` and `am_remove_server` -- binary create/destroy.

An agent that wants to temporarily disable a noisy MCP server must either:
1. Remove it entirely (losing config) and re-add later, or
2. Have no way to do it at all

**Suggested fix:** Add `am_server_toggle` or `am_server_update` (write-local):

```typescript
{
  name: "am_server_update",
  description: "Update properties of an existing MCP server (enable/disable, tags, description, env).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Server name" },
      enabled: { type: "boolean", description: "Enable or disable the server" },
      tags: { type: "array", items: { type: "string" }, description: "Replace tags" },
      description: { type: "string", description: "Update description" },
      env: { type: "object", additionalProperties: { type: "string" }, description: "Update env vars" },
    },
    required: ["name"],
  },
}
```

### 3. Missing MCP Tool: Undo Last Change

**Severity: MEDIUM**

The CLI has `am undo` (commands/undo.ts) which reverts the last config change via
git. This is a powerful safety net for agents that make mistakes. Without it, an
MCP-connected agent that accidentally removes the wrong server has no recovery path
short of `am_sync_pull` (which requires a remote and write-remote permission).

**Suggested fix:** Add `am_undo` (write-local tier).

### 4. Missing MCP Tool: Config Validation / Doctor

**Severity: MEDIUM**

The CLI has `am config validate` and `am doctor`. Agents can't check whether their
changes resulted in a valid config, or diagnose why `am_apply` produced warnings.

**Suggested fix:** Add `am_doctor` (read-only) that returns health check results
as structured JSON. This is especially valuable after `am_add_server` or
`am_registry_install` -- the agent can verify the install succeeded end-to-end.

### 5. Missing MCP Tool: Registry Update Check

**Severity: LOW**

The CLI has `am update` to check for and apply registry updates. Agents managing
long-running environments should be able to check if their installed packages are
outdated.

**Suggested fix:** Add `am_registry_update` (write-local) or at minimum
`am_registry_check_updates` (read-only).

### 6. Missing MCP Tool: Wiki Show/Delete/Lint

**Severity: LOW**

The wiki CLI has `show`, `delete`, `lint`, `export`, `import`, and `graph`
subcommands. The MCP surface only exposes `search`, `add`, `synthesize`, `briefing`,
and `harvest`. Key gaps:

- **`am_wiki_show`** (read-only) -- Retrieve a specific wiki entry by ID or slug.
  Without this, an agent that gets a search result can't read the full entry.
- **`am_wiki_delete`** (write-local) -- Remove stale/incorrect knowledge.
- **`am_wiki_lint`** (read-only) -- Check for orphans, stale pages, broken links.

The `export`, `import`, and `graph` commands are less critical for agent use.

### 7. Session Tools in Wrong Group

**Severity: MEDIUM**

ADR-0021's table mentions `session` as a possible group name:

> `Available groups: core, registry, a2a, wiki, session`

But in the implementation, session tools (`am_session_list`, `am_session_export`,
`am_session_search`) are part of the `core` group. This contradicts the ADR and
bloats the core group unnecessarily. An agent doing config management doesn't need
session browsing tools in its tool list.

Additionally, the schema at `src/core/schema.ts:104` only defines four groups:
```typescript
export const MCP_TOOL_GROUPS = ["core", "registry", "a2a", "wiki"] as const;
```

The `session` group is mentioned in the ADR comment but never implemented.

**Suggested fix:**
1. Add `"session"` to `MCP_TOOL_GROUPS` in schema.ts
2. Add session tools to `TOOL_GROUP_MAP` in server.ts
3. This brings core down to 11 tools and creates a focused session group of 3

**Line refs:**
- `server.ts:64-88` -- `TOOL_GROUP_MAP` missing session entries
- `schema.ts:104` -- `MCP_TOOL_GROUPS` missing "session"

### 8. Permission Tier: am_apply Should Not Be write-local

**Severity: MEDIUM**

`am_apply` (line 819) writes to files *outside* the agent-manager config directory
-- it generates IDE-native configs like `.claude/settings.local.json`,
`.cursor/mcp.json`, etc. in the user's project directories. This is a meaningful
side effect beyond the am config repo.

Currently assigned `write-local`, same tier as `am_add_server` which only modifies
`config.toml`. The distinction matters: an agent auto-approving `am_add_server` is
low-risk, but `am_apply` can overwrite IDE configs that the user has customized.

**Suggested fix:** Either:
- Create a `write-external` tier (breaking change, probably not worth it), or
- Add a `dryRun: true` default when called via MCP (so agents preview before applying), or
- At minimum, the description should warn: "Writes config files outside the am directory. Use dryRun=true to preview."

**Line ref:** `server.ts:837` -- tier is `write-local`

### 9. Error Messages Missing Recovery Guidance

**Severity: HIGH**

Several error messages tell the agent *what* failed but not *what to do next*:

| Tool | Error | Issue |
|------|-------|-------|
| `am_add_server` (line 498) | `Server "${name}" already exists` | Doesn't suggest: "Use am_remove_server first, or use am_server_update to modify it" |
| `am_remove_server` (line 540) | `Server "${name}" not found` | Doesn't suggest: "Use am_list_servers to see available servers" |
| `am_agent_discover` (line 943) | Returns `{ error: ... }` in result | Uses non-standard error pattern -- returns success with error field instead of throwing. Inconsistent with all other tools. |
| `am_session_export` (line 356) | `Adapter "${adapterName}" does not support session reading` | Doesn't list which adapters do support it |
| `am_session_export` (line 360) | `Session "${id}" not found in ${adapterName}` | Doesn't suggest: "Use am_session_list to find valid session IDs" |
| `am_sync_push` (line 898) | `No remote configured` | Good -- tells user what to do next. |

**Suggested fixes:**

```typescript
// am_add_server
throw new Error(
  `Server "${name}" already exists. To modify it, use am_server_update. ` +
  `To replace it, use am_remove_server first.`
);

// am_remove_server
throw new Error(
  `Server "${name}" not found. Use am_list_servers to see available server names.`
);

// am_agent_discover -- use throw, not return { error }
throw new Error(`No A2A Agent Card found at ${url}. Verify the URL serves /.well-known/agent.json`);

// am_session_export
throw new Error(
  `Adapter "${adapterName}" does not support session reading. ` +
  `Adapters with session support: ${listAdapters().join(", ")}`
);
```

**Line refs:** `server.ts:498`, `server.ts:540`, `server.ts:943`, `server.ts:356`, `server.ts:360`

### 10. Tool Descriptions Need "When to Use" Guidance

**Severity: MEDIUM**

Several tool descriptions explain *what* the tool does but not *when* or *why* an
agent should use it. LLMs are better at tool selection when descriptions include
usage context.

**Good examples (already in the code):**
- `am_registry_install`: "Install an MCP server package from the registry into the agent-manager config. Resolves package metadata, adds the server entry, and auto-commits." -- Clear workflow.
- `am_agent_delegate`: "Send a task to a registered A2A agent. The agent must be in the local roster (use am_agent_list to see available agents)." -- Includes prerequisite.

**Needs improvement:**
- `am_status` (line 209): "Check drift detection and sync state." -- What is drift? When would an agent check this? Better: "Check if IDE tool configs are in sync with the agent-manager catalog. Use after adding/removing servers to see if am_apply is needed."
- `am_apply` (line 820): "Generate native IDE/tool configs from the agent-manager catalog." -- Better: "Sync the agent-manager catalog to IDE-native config files (Claude Code, Cursor, etc.). Run after am_add_server or am_remove_server to propagate changes. Use dryRun=true to preview."
- `am_import` (line 588): "Import MCP servers from a tool's native config." -- Better: "Import existing MCP servers from an IDE's native config into agent-manager. Use 'auto' to scan all detected tools, or specify an adapter name. Skips servers that already exist in the catalog."
- `am_wiki_synthesize` (line 1148): "Generate a context block from the knowledge base for a given query." -- What is a "context block"? Better: "Generate a markdown summary of relevant knowledge entries for a topic. Use this to build context for an agent before starting a task."
- `am_wiki_harvest` (line 1196): "Trigger knowledge extraction from a specific session." -- Better: "Extract facts, procedures, preferences, and capabilities from a completed coding session and store them in the wiki. Use am_session_list to find session IDs."

### 11. Response Format Inconsistencies

**Severity: LOW**

Most tools return well-structured JSON with an `action` field for mutations and
domain objects for reads. A few inconsistencies:

1. **am_agent_discover** (line 943-947): Returns `{ error: "..." }` on failure instead
   of throwing. Every other tool uses throw for errors. This means the MCP response
   will have `isError: false` but contain an error message in the result.

2. **am_wiki_add** (line 1139): Returns the entire entry object including internal
   fields like `provenance.modification_history`. This is noisy for an LLM. Better
   to return `{ action: "add", id: entry.id, type: entry.entity_type }`.

3. **am_session_list** (line 304-311): Spreads the full SessionSummary and then
   overrides date fields. If SessionSummary ever adds a field with sensitive data,
   it leaks. Better to explicitly pick fields.

4. **Pagination**: `am_session_search` (line 400) loads ALL sessions and searches
   in-memory. For large session stores this could be very slow. No pagination
   parameters are exposed. Consider adding `offset`/`limit` or warning in the
   description that this can be slow with many sessions.

**Line refs:** `server.ts:943`, `server.ts:1139`, `server.ts:304`, `server.ts:400`

### 12. am_agent_delegate Should Explain Async Model

**Severity: MEDIUM**

`am_agent_delegate` (line 972) sends a task and returns immediately, but the
description doesn't explain that:
- The result may be a partial/pending response
- The agent should use `am_agent_task_status` to poll for completion
- The returned task ID is needed for status checks

An LLM might assume the response contains the completed task result.

**Suggested description:**
```
"Send a task to a registered A2A agent and return immediately. The response
contains a task ID and initial status (which may be 'pending' or 'working').
Use am_agent_task_status with the returned task ID to poll for the final result."
```

**Line ref:** `server.ts:972-983`

### 13. am_wiki_add Parameter: "type" Shadows JSON Schema Keyword

**Severity: LOW**

The `am_wiki_add` tool uses `type` as a parameter name (line 1084). While this works
in the JSON Schema, `type` is a JSON Schema keyword, which can confuse some MCP
clients or LLM parsers. The CLI command uses `entity_type` internally.

**Suggested fix:** Rename to `entity_type` or `kind` for clarity.

**Line ref:** `server.ts:1084`

### 14. Missing "session" Group in TOOL_GROUP_MAP Comment

**Severity: LOW**

The comment at line 87 says:
```typescript
// All other tools (am_list_servers, am_list_profiles, am_status, etc.) default to "core"
```

This is accurate but misleading -- it makes the session tools' assignment to "core"
look intentional rather than an oversight given ADR-0021 mentions a `session` group.

### 15. am_sync_pull Tier Should Match am_sync_push

**Severity: LOW (correctly assigned)**

Both `am_sync_push` and `am_sync_pull` are `write-remote`. This is correct but worth
noting: `pull` could arguably be `write-local` since it only writes to the local
config repo (not to a remote). However, since it requires network access to a git
remote and could overwrite local changes, `write-remote` is the safer choice. No
change needed.

### 16. Potential Security: No Input Validation on Server Names

**Severity: MEDIUM**

`am_add_server` (line 495) accepts any string as a server name. TOML keys can contain
special characters that might cause parsing issues. The CLI likely validates this, but
the MCP handler trusts the input directly.

**Suggested fix:** Validate that `name` matches a safe pattern like `/^[a-zA-Z0-9_-]+$/`
before writing to config.

**Line ref:** `server.ts:495`

### 17. am_config_show Doesn't Show Project Config Origin

**Severity: LOW**

`am_config_show` returns the merged config but doesn't indicate which values came from
global vs. project vs. profile config. This makes it harder for an agent to know
*where* to make a change.

**Suggested fix:** Include a `sources` field showing which config files contributed.

---

## Missing Tools Summary (Prioritized)

| Priority | Tool | Group | Tier | Rationale |
|----------|------|-------|------|-----------|
| P0 | `am_server_update` | core | write-local | Enable/disable is the #1 agent operation after list. Web API has it, MCP doesn't. |
| P1 | `am_undo` | core | write-local | Safety net for agent mistakes. CLI has it. |
| P1 | `am_doctor` | core | read-only | Post-change validation. CLI has it. |
| P2 | `am_registry_check_updates` | registry | read-only | Staleness detection for installed packages. |
| P2 | `am_wiki_show` | wiki | read-only | Read full entry after search. CLI has it. |
| P2 | `am_wiki_delete` | wiki | write-local | Remove stale knowledge. CLI has it. |
| P3 | `am_wiki_lint` | wiki | read-only | Knowledge base health check. |
| P3 | `am_log` | core | read-only | View config change history (CLI `am log`). |
| P3 | `am_adapter_list` | core | read-only | List available adapters (useful before `am_import` or `am_apply`). |

---

## Tool Group Reorganization

Current state vs. recommended:

| Group | Current Tools | Recommended Change |
|-------|--------------|-------------------|
| core | 14 tools (config + session) | Remove 3 session tools -> 11 tools |
| session | (doesn't exist) | Create with 3 session tools |
| registry | 3 tools | Add `am_registry_check_updates` -> 4 |
| a2a | 4 tools | No change |
| wiki | 5 tools | Add `am_wiki_show`, `am_wiki_delete` -> 7 |

Update `MCP_TOOL_GROUPS` in `schema.ts:104`:
```typescript
export const MCP_TOOL_GROUPS = ["core", "registry", "a2a", "wiki", "session"] as const;
```

Update `TOOL_GROUP_MAP` in `server.ts:71`:
```typescript
const TOOL_GROUP_MAP: Record<string, McpToolGroup> = {
  // session group (extracted from core)
  am_session_list: "session",
  am_session_export: "session",
  am_session_search: "session",
  // registry group
  am_registry_search: "registry",
  ...
};
```

---

## Quick Wins (Can Fix Today)

1. **Fix am_agent_discover error pattern** (line 943) -- change `return { error }` to `throw`
2. **Add recovery hints to error messages** (5 locations listed in Finding #9)
3. **Improve tool descriptions** with "when to use" context (Finding #10)
4. **Extract session group** from core (Finding #7)
5. **Validate server names** in am_add_server (Finding #16)
6. **Trim am_wiki_add response** to exclude internal provenance details (Finding #11)

---

## Architecture Notes

The implementation follows ADR-0009 and ADR-0021 faithfully with one exception
(session group). The three-tier permission model (read-only, write-local,
write-remote) is well-designed and the `checkPermission` function at line 97 is
clean. The tool group filtering at line 1300-1305 correctly uses the settings to
control tool visibility.

The `loadConfigAndProfile()` helper at line 133 is called by almost every handler,
which means every tool call reads config from disk. For read-only tools this is
wasteful but safe. For write tools this prevents stale reads. Acceptable tradeoff
at current scale.

The `redactSecrets` function at line 122 correctly strips `enc:v1:` prefixed values
from `am_config_show` output, preventing secret leakage through the MCP interface.
