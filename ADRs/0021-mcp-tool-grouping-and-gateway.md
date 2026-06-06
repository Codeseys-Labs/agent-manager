---
status: accepted
date: 2026-04-09
---

# ADR-0021: MCP Tool Grouping via Profiles and Gateway Mode

## Context

The MCP server (ADR-0009) currently exposes ALL 26 tools to every caller. As the
tool count grows (registry, A2A, wiki), this creates noise for LLM agents that
only need config management. A caller asking "list my servers" shouldn't see
`am_wiki_synthesize` or `am_agent_delegate` in the tool list — extra tools
increase prompt token usage, slow down tool selection, and risk spurious calls.

Additionally, there's a question of whether am-cli should act as an MCP gateway
(proxying MCP tool calls to agent-native formats) in addition to its current
import/export model.

## Decision

### Profiles as Tool Groups (Stable, Default)

Profiles already control which servers, instructions, skills, and agents are
active. Extend this mechanism to control which MCP tool categories are exposed
when am-cli runs as an MCP server.

Add to `SettingsSchema`:

```toml
[settings.mcp_serve]
allow_push = false
tools = ["core", "registry"]  # Only expose these tool groups
# Available groups: core, registry, a2a, wiki, session
# Default: ["core"] — just config management tools
```

Tool group mapping:

| Group | Count | Tools |
|-------|-------|-------|
| `core` | 14 | `am_list_servers`, `am_list_profiles`, `am_status`, `am_config_show`, `am_add_server`, `am_remove_server`, `am_use_profile`, `am_import`, `am_apply`, `am_sync_push`, `am_sync_pull`, `am_session_list`, `am_session_export`, `am_session_search` |
| `registry` | 3 | `am_registry_search`, `am_registry_install`, `am_registry_list_installed` |
| `a2a` | 4 | `am_agent_discover`, `am_agent_list`, `am_agent_delegate`, `am_agent_task_status` |
| `wiki` | 5 | `am_wiki_search`, `am_wiki_add`, `am_wiki_synthesize`, `am_wiki_briefing`, `am_wiki_harvest` |

> **Note (2026-06-04, W1-4).** The counts above are the *original* ADR-acceptance
> snapshot. Five quick-win tools were later added (`am_list_skills`,
> `am_list_instructions`, `am_profile_create`, `am_profile_delete` → `core`;
> `am_registry_uninstall` → `registry`), bringing `core` to 18, `registry` to 4,
> and the total to 43. See the addendum table at the foot of this ADR for the
> current group enumeration. ADR-0055 (proposed) supersedes this ADR's rejection
> of *profile-scoped* tool groups.

When `settings.mcp_serve.tools` is unset, the default is `["core"]` — the
original 14 config-management tools from ADR-0009. This ensures backward
compatibility while reducing noise by default.

This is the **recommended** approach. The import/export model (`am apply` /
`am import`) remains the primary usage pattern for syncing configs to IDE-native
formats.

### MCP Gateway Mode (Experimental)

An alternative architecture where am-cli acts as both MCP server AND client —
proxying MCP tool calls through to configured servers, translating between native
formats. Similar to claude-code's lazy MCP loading or AWS AgentCore MCP Gateway.

In this mode, am-cli would:

- Accept MCP tool calls from agents
- Route them to the appropriate configured MCP server
- Translate responses into the calling agent's native format
- Provide unified authentication and rate limiting

**Status: Experimental. Not recommended for production.**

Tradeoffs vs import/export:

| | Pro | Con |
|---|---|---|
| **Proxying** | Real-time tool access, no config file generation needed | am-cli becomes a runtime dependency (must be running) |
| **Unified auth** | Single auth/rate-limit layer across all tools | Added latency from proxying every call |
| **Simplicity** | — | Complexity of maintaining live connections to N servers |
| **Current model** | — | Import/export already handles the translation use case |

The primary goal of am-cli is translation of MCP tools into agent-native config
formats. The gateway mode adds runtime complexity that may not be justified until
there's a proven need (e.g., tools that cannot be expressed as static configs).

## Consequences

### Positive

- Users control MCP tool surface via `settings.mcp_serve.tools` array
- Default exposure is minimal (`["core"]`), reducing LLM token usage and confusion
- Groups align naturally with feature areas: core config, registry, A2A, wiki
- Existing permission tiers (read-only, write-local, write-remote) compose
  orthogonally with tool groups

### Negative

- Tool group names are hardcoded — adding a new group requires a code change
  (acceptable: new feature areas are infrequent)
- MCP gateway mode remains unbuilt — documented as experimental for future
  reference only

### Neutral

- The import/export model (`am apply` / `am import`) remains the primary usage
  pattern; this ADR doesn't change that
- Permission tiers from ADR-0009 are unchanged and compose with groups

## Alternatives Considered

- **Per-tool allowlist:** Let users list individual tool names in config.
  Rejected — too granular, error-prone, and would break when tools are renamed.
- **Profile-scoped tool groups:** Tie tool groups to the active profile rather
  than global settings. Rejected for now — MCP serve is a global process, not
  profile-scoped. Could revisit if multi-profile MCP serving is needed.
- **Build gateway first:** Implement the MCP gateway instead of tool groups.
  Rejected — the gateway adds runtime complexity and the import/export model
  covers the primary use case.

## References

- [ADR-0009: MCP Server Mode](0009-mcp-server-mode.md) — original MCP server decision
- [ADR-0013: Platform Adapters](0013-platform-adapters.md) — dual-axis adapter pattern
- `src/core/schema.ts` — SettingsSchema with `mcp_serve.tools`
- `src/mcp/server.ts` — tool group filtering in `tools/list`

## Addendum — 2026-05-01 reconciliation

The original decision locked the tool-group set at `["core", "registry", "a2a",
"wiki", "session"]` with a 14+3+4+5 budget totalling 26 tools. ADR-0026 Phase 2
(ACP runtime integration) shipped a sixth group `"acp"` that was not reflected
here, and Wave D added unified `am_agent_*` tools under the same group. This
addendum is the audit trail — the original Decision remains unchanged, the
group enumeration is expanded.

**Current state as of commit 8a4d5f0 (run 2026-05-01):**

| Group | Count | Notes |
|-------|-------|-------|
| `core` | 18 | Config/catalog management. **W1-4 (2026-06-04)** added `am_list_skills`, `am_list_instructions`, `am_profile_create`, `am_profile_delete` (was 14). |
| `registry` | 4 | **W1-4 (2026-06-04)** added `am_registry_uninstall` (was 3). |
| `a2a` | 4 | Unchanged from original |
| `wiki` | 5 | Unchanged from original |
| `session` | 3 | Split out from core per original Decision |
| `acp` | 9 | **Added by ADR-0026 Phase 2 + Wave D.** `am_run_agent`, `am_acp_list_agents`, `am_acp_session_list`, `am_acp_session_cancel`, `am_agent_invoke`, `am_agent_session_list`, `am_agent_session_cancel`, `am_agent_status`, `am_agent_detect`. |
| **Total** | **43** | Up from 26 at ADR acceptance (38 at the 2026-05-01 addendum; +5 at W1-4). |

**Settings enum.** `McpToolGroup` in `src/core/schema.ts` was extended to
include `"acp"`; `settings.mcp_serve.tools` accepts all six group names.

**Backward compatibility.** Deployments that set `tools = ["core"]` continue to
get only the 14 core tools — no ACP surface is exposed unless explicitly opted
in. Deployments that set `tools = ["acp"]` get the full 9-tool ACP surface, and
future Wave D merges will re-home `a2a` under a unified `"agents"` group (a
separate ADR will govern that migration).

**Why this is an addendum, not a supersession.** Adding a sixth group is
compatible with the original decision: groups exist precisely so tool surface
can grow without forcing every consumer to see everything. A supersession would
be warranted if the grouping mechanism itself changed (e.g., per-tool allowlist
replacing groups) — that hasn't happened.
