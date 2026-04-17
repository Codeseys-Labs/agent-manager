---
status: accepted
date: 2026-04-16
---

# ADR-0030: Unified Agent Registry and Protocol Routing

## Context

agent-manager currently maintains two separate agent registries:

1. **ACP registry** (`src/protocols/acp/registry.ts`) — maps agent names to spawn
   commands for local subprocess execution. Contains 16 built-in agents plus config
   overrides from `[settings.acp.agents]`.

2. **A2A roster** (`agents.toml` + `settings.a2a.discovery_sources`) — stores discovered
   remote agents with HTTP URLs. Managed via `discovery.ts` with CRUD operations.

These registries do not know about each other. An agent available both locally (ACP)
and remotely (A2A) appears as two unrelated entries. There is no unified lookup, no
protocol selection logic, and no fallback chain.

ADR-0017 established the protocol roles:
- **ACP = local agents** — spawned as subprocesses, driven via stdio JSON-RPC
- **A2A = remote agents** — network services, discovered via Agent Cards, delegated via HTTP

ADR-0026 added ACP runtime client capability. But neither ADR addressed how am should
**route** a delegation request to the correct protocol, or how the two registries should
be unified.

### Protocol Facts That Inform This Decision

- **ACP transport:** stdio is the only finalized transport. HTTP exists as an unfinished
  draft. The spec says agents "SHOULD support stdio whenever possible." ACP is
  fundamentally a local subprocess protocol.

- **A2A transport:** HTTP/JSON-RPC 2.0 is the only transport. No stdio variant exists.
  A2A is fundamentally a network protocol. It CAN run on localhost (valid HTTP endpoint)
  but provides no subprocess lifecycle management.

- **MCP-over-ACP:** An active RFD proposes tunneling MCP tool calls over ACP channels.
  This would let am inject its own tools into ACP agent sessions. Not yet in the
  TypeScript SDK.

## Decision

### 1. Merge registries into a unified agent registry

Replace the separate ACP registry and A2A roster with a single unified registry where
each agent entry can have ACP and/or A2A capabilities:

```toml
[agents.claude]
name = "Claude Code"
description = "Anthropic's Claude Code agent"

[agents.claude.acp]
command = "npx -y @agentclientprotocol/claude-agent-acp@latest"

# Optional: same agent also available remotely
# [agents.claude.a2a]
# url = "https://claude-agent.internal.example.com"

[agents.review-bot]
name = "Review Bot"
description = "Custom review agent (remote only)"
[agents.review-bot.a2a]
url = "https://review-bot.internal.example.com"

[agents.hybrid]
name = "Hybrid Agent"
fallback = true
[agents.hybrid.acp]
command = "./my-agent --acp"
[agents.hybrid.a2a]
url = "https://hybrid.example.com"
```

The built-in ACP registry (16 agents) becomes default entries that users can override.

### 2. ACP = local, A2A = remote as the default routing model

Protocol selection follows deterministic rules:

1. If `--local` flag: use ACP. If `--remote` flag: use A2A.
2. If agent has explicit `preferred: "acp"` or `preferred: "a2a"`: use that.
3. If agent has ACP entry and binary is available: use ACP (prefer local).
4. If agent has A2A entry: use A2A.
5. Otherwise: error.

### 3. Opt-in fallback from ACP to A2A

When an ACP agent fails to spawn (binary not found, timeout, crash), am does NOT
automatically fall back to A2A. Silently routing a prompt from a local subprocess to
a network endpoint changes the security boundary.

Fallback requires explicit opt-in: `fallback = true` on the agent entry, or `--fallback`
on the CLI command.

### 4. am does not auto-detect protocols

am does not scan the system to determine which agents are available. Agents must be
registered in config (explicitly or via built-in defaults). A discovery command
(`am agents scan`) can check reachability but does not auto-register.

### 5. am does not implement ACP server

am is not a coding agent. ACP servers receive prompts and edit code. am sends prompts
to agents. The MCP server mode (`am mcp-serve`) already covers the "am as a tool" use
case. There is no additional value in implementing ACP server.

### 6. am implements A2A server

am IS a participant in the A2A agent network. It has unique cross-tool visibility (knows
about agents in every IDE), can generate composite Agent Cards, and can broker delegation.
This is already implemented in `src/protocols/a2a/server.ts`.

## Consequences

### Positive

- **Single lookup path** — `am agents list` shows all agents regardless of protocol.
  No more checking two separate systems.

- **Deterministic routing** — given an agent name, the protocol choice is predictable
  based on config, not runtime guessing.

- **Dual-protocol agents** — the same agent can be registered for both ACP and A2A,
  supporting development (local) and CI/CD (remote) workflows.

- **Security-conscious defaults** — prompts stay local unless explicitly configured
  otherwise. No silent network escalation.

- **Extensible** — when ACP HTTP transport finalizes, it can be added as a third
  transport option on any agent entry without changing the routing model.

### Negative

- **Migration required** — existing `[settings.acp.agents]` entries and `agents.toml`
  roster entries need to be migrated to the unified `[agents.*]` format. Can be done
  automatically with a migration command.

- **Config complexity** — the `[agents.*]` section gains `acp` and `a2a` sub-tables.
  Mitigated by sensible defaults (built-in agents just work).

- **Built-in registry maintenance** — the 16 built-in ACP agents need to be kept
  current as agent projects change their CLI interfaces.

### Neutral

- The A2A server (`src/protocols/a2a/server.ts`) is unaffected — it already works with
  resolved config.

- MCP server mode is unaffected — it uses the existing config resolution pipeline.

- The `fallback` feature is additive and does not affect non-fallback agents.

## Alternatives Considered

### 1. Keep separate registries, add a lookup facade

A wrapper that queries both registries and merges results at query time. Rejected because
it leaves the config fragmented (`[settings.acp.agents]` for local, `agents.toml` for
remote) and provides no natural place for dual-protocol metadata like `fallback` and
`preferred`.

### 2. Auto-detect protocols at runtime

Scan PATH for ACP binaries, probe known A2A URLs, and build the registry dynamically.
Rejected because: (a) PATH scanning is slow and unreliable, (b) network probes add
latency to every operation, (c) the results are non-deterministic, and (d) it creates
a security risk (unexpected agents could be discovered and used).

### 3. Use ACP for everything (wait for HTTP transport)

ACP's HTTP transport draft, once finalized, could theoretically support remote agents.
Rejected because: (a) the HTTP transport is not specified, (b) there is no timeline for
finalization, (c) A2A v1.0 is already released and widely adopted for remote agent
communication, and (d) ACP and A2A solve different problems (IDE-agent control vs
agent-agent delegation).

### 4. Use A2A for everything (run all agents as HTTP services)

Require all agents to be running as HTTP services, even local ones. Rejected because:
(a) users would need to daemonize every agent, (b) ACP provides richer client callbacks
(filesystem, terminal, permissions) that HTTP-based A2A lacks, (c) on-demand subprocess
spawn is lower overhead than maintaining persistent HTTP services.

## References

- [Design doc: A2A vs ACP Protocol Positioning](../docs/designs/2026-04-16-protocol-positioning/a2a-acp-positioning.md)
- [ADR-0017: Multi-Protocol Agent Integration](0017-agent-communication-protocol.md)
- [ADR-0026: ACP Runtime Integration via ACPX](0026-acpx-acp-runtime-integration.md)
- [ADR-0009: MCP Server Mode](0009-mcp-server-mode.md)
- ACP spec: agentclientprotocol.com (stdio transport, MCP-over-ACP RFD)
- A2A spec v1.0.0: a2a-protocol.org
- ACP TypeScript SDK: @agentclientprotocol/sdk
