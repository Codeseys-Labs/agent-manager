---
status: accepted
date: 2026-04-10
---

# ADR-0024: MCP Registry Integration

## Context

MCP (Model Context Protocol) servers are the primary entity managed by
agent-manager. Users add servers manually (`am add server`) or import
from native tool configs (`am import`). However, discovering new MCP
servers requires users to search the web, find npm packages, and
manually construct the `command` + `args` + `env` configuration.

A centralized MCP registry exists where packages are published with
their server configuration metadata. Integrating with this registry
would allow users to discover, install, and update MCP servers with
a single command.

## Decision

### Registry client

`src/registry/client.ts` implements an HTTP client for the MCP registry:
- Default URL: `https://registry.modelcontextprotocol.io` (configurable via `AM_REGISTRY_URL`)
- In-memory LRU cache (50 entries, 5-minute TTL)
- Exponential backoff on 429/5xx (3 retries, 1s/2s/4s)
- Graceful fallback to cache on network failure

### CLI commands

Four new commands integrate registry operations into the workflow:

- `am search <query>` — search with `--tag`, `--verified`, `--limit`, `--json`
- `am install <package...>` — resolve, prompt for env vars, encrypt, add to config
- `am uninstall <name>` — remove server with confirmation
- `am update` — check for newer versions of registry-installed servers

### Provenance tracking

When a server is installed via the registry, a `_registry` metadata field
is added to the server entry:

```toml
[servers.tavily._registry]
source = "mcp-registry"
package = "tavily-mcp"
version = "1.2.0"
installed_at = "2026-04-10T10:30:00Z"
```

This is validated by `RegistryProvenanceSchema` in the core Zod schema.
`am update` uses this metadata to check for newer versions.

### Secret handling

Registry packages declare required env vars. During `am install`:
1. User is prompted for env var values
2. Values are auto-encrypted via the Tier 1 secret detection pipeline (ADR-0023)
3. Config is written with `${VAR}` references and encrypted originals in `settings.env`

### MCP tools

Three MCP tools expose registry operations to AI agents:
- `am_registry_search` (read-only tier)
- `am_registry_install` (write-local tier)
- `am_registry_list_installed` (read-only tier)

## Consequences

### Positive

- One-command server installation: `am install tavily-mcp`
- Automatic version tracking and update checking
- Secrets encrypted on install (no raw keys in config)
- Registry provenance enables audit trail

### Negative

- Registry dependency for install/search (network required)
- Registry API shape may change (mitigated by typed client + cache)

## References

- [ADR-0023](0023-tiered-secret-detection.md) — secret encryption on install
- [ADR-0012](0012-application-level-encryption.md) — AES-256-GCM encryption
