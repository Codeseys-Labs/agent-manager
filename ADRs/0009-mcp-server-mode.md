---
status: accepted
date: 2026-04-07
---

# ADR-0009: agent-manager as an MCP Server

## Context

AI agents are first-class users of agent-manager. Claude Code, Cursor, and other
MCP-capable tools can invoke MCP server tools programmatically. If agent-manager
exposes itself as an MCP server, AI agents can manage their own configurations
without human intervention.

This creates a powerful feedback loop: an agent notices it needs a tool, adds it
via agent-manager, and continues working — all within a single session.

## Decision

agent-manager implements an MCP server mode via `am mcp-serve` (stdio transport).
Users add it to their MCP config like any other server:

```json
{
  "mcpServers": {
    "agent-manager": {
      "command": "am",
      "args": ["mcp-serve"]
    }
  }
}
```

Exposed MCP tools:

| Tool | Description |
|------|-------------|
| `am_list_servers` | List servers (all or active in current profile) |
| `am_list_profiles` | List available profiles |
| `am_status` | Check drift and sync state |
| `am_add_server` | Add a server to the catalog |
| `am_remove_server` | Remove a server |
| `am_use_profile` | Switch active profile |
| `am_apply` | Regenerate IDE configs |
| `am_import` | Import from a specific tool |
| `am_sync_push` | Push to git remote |
| `am_sync_pull` | Pull from git remote |
| `am_config_show` | Show resolved config |

All tools return structured JSON responses with success/error status, making them
parseable by any AI agent.

## Consequences

### Positive
- AI agents can self-configure — "I need tavily, let me add it"
- Programmatic access to all agent-manager operations
- No custom API needed — MCP is the universal agent tool protocol
- Works with any MCP-capable tool (Claude Code, Cursor, Copilot, etc.)
- Enables autonomous agent workflows (add server → apply → use)

### Negative
- Security consideration: an AI agent can modify its own config
  (mitigation: MCP permission systems in each tool control which tools are auto-approved)
- Adds complexity to the binary — must implement MCP server protocol
  (mitigation: use `@modelcontextprotocol/sdk` which handles the protocol)
- Potential for recursive config changes if agent-manager manages its own MCP entry
  (mitigation: detect and skip self-referential changes)

### Neutral
- MCP server mode is optional — users who don't add it to their MCP config don't get it
- stdio transport means no network exposure — runs as a subprocess of the IDE

## Alternatives Considered

- **REST API only:** Rejected — MCP is the native protocol for AI agent tools.
  A REST API would require custom integration in each IDE.
- **CLI with --json only:** Rejected — while `--json` output is useful for scripting,
  MCP provides a richer interaction model with tool schemas and streaming.
- **No agent interface:** Rejected — AI agents are a primary user persona.
  Ignoring them misses a major opportunity.

## References

- [10-agent-protocols-and-standards.md](../research/10-agent-protocols-and-standards.md) — MCP as universal tool protocol
- [01-existing-mcp-sync-tools.md](../research/01-existing-mcp-sync-tools.md) — Gap #8: no tool exposes agent-friendly interface
