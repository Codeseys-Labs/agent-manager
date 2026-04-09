---
tags: [research/agent-manager, protocols/acp, protocols/a2a, protocols/mcp, interoperability]
created: 2026-04-08
updated: 2026-04-08
status: active
---

# Agent Communication Protocols: ACP, A2A, and the Agent Interop Landscape

Deep-dive research into agent communication and orchestration protocols and
how they integrate with agent-manager's architecture. agent-manager (`am`) is
a central layer through which all agent configs flow -- it knows about ALL
agents across ALL tools. This unique position informs how each protocol fits.

This document informs [ADR-0017](../ADRs/0017-agent-communication-protocol.md).

**CORRECTION NOTE:** An earlier version conflated IBM's deprecated ACP (Agent
Communication Protocol, from BeeAI) with Zed's ACP (Agent Client Protocol).
These are entirely different protocols with different purposes, different
creators, and different goals. This version corrects that confusion.

---

## 1. Problem Statement

am currently manages **tool integration** (MCP servers) and **project
instructions** across 13 IDE adapters. MCP solves the vertical problem:
connecting an AI agent to external tools, data sources, and services.

Two additional problems remain unsolved:

### Problem A: IDE-to-Agent Standardization

Each IDE has its own way of launching, configuring, and communicating with
AI coding agents. A coding agent built for Zed does not work in JetBrains
or Kiro. The **Agent Client Protocol (ACP)** from Zed Industries addresses
this by defining a universal interface between IDEs (clients) and coding
agents (servers).

### Problem B: Agent-to-Agent Communication

Agents managed by am cannot communicate with each other across tools. A
Claude Code agent cannot delegate a subtask to a Cursor agent. Each tool
is an island. The **A2A Protocol** from Google/Linux Foundation addresses
this with peer-to-peer agent task delegation.

### The Three Protocol Layers

| Protocol | Layer | Direction | am's Role |
|----------|-------|-----------|-----------|
| **MCP** | Agent-to-Tool | Agent -> Tool | Config manager + participant (`am mcp-serve`) |
| **ACP** | IDE-to-Agent | IDE -> Agent | Config manager (generate IDE configs) |
| **A2A** | Agent-to-Agent | Agent <-> Agent | Participant + network coordinator |

The key insight: **am is not an IDE and it is not a single agent.** am is the
central coordination layer that knows about all agents across all tools. This
positions it differently for each protocol:

```
            am-cli (the central layer)
         /          |           \
        /           |            \
  MCP (done)    A2A (new)     ACP (config only)
  |               |               |
  "am configures  "am IS a       "am configures
   which tools    participant     which agents
   agents use"    in the agent    IDEs connect to"
                  network"
  |               |               |
  [servers]      [agents] ->     [agents] ->
  in TOML        AgentCards      ACP registrations
                 A2A server      in IDE configs
                 Discovery hub
```

---

## 2. ACP (Agent Client Protocol) -- Zed Industries

### IMPORTANT: Two Different "ACP" Protocols Exist

| | Zed ACP | IBM/BeeAI ACP |
|---|---------|---------------|
| **Full name** | Agent Client Protocol | Agent Communication Protocol |
| **Creator** | Zed Industries | IBM Research / BeeAI |
| **Purpose** | IDE-to-agent standardization | Agent-to-agent messaging |
| **Status** | Active, growing adoption | Deprecated, merged into A2A |
| **Website** | agentclientprotocol.com | agentcommunicationprotocol.dev |
| **Backers** | Zed, JetBrains, Kiro | IBM (now part of A2A) |

**This section covers Zed's ACP only.** IBM's ACP is covered in section 8.

### What Is ACP?

ACP (Agent Client Protocol) is an open protocol that defines a standard
interface between IDEs (clients) and AI coding agents (servers). Created by
Zed Industries, it aims to solve the fragmentation problem where each IDE
has its own proprietary way of integrating AI agents.

**Website:** agentclientprotocol.com
**npm package:** `@agent-client-protocol/core` (renamed from
`@zed-industries/agent-client-protocol`)
**License:** Open source
**Backers:** Zed, JetBrains, Kiro (AWS)

### The Problem ACP Solves

Building a coding agent today means choosing a single IDE to target. An agent
built for Cursor's API does not work in Zed. ACP defines a universal "driver"
so an ACP-compatible agent works in any ACP-compatible editor, like a printer
driver works with any supporting OS.

### Architecture: Hierarchical Client-Server

ACP is NOT peer-to-peer. It is hierarchical:

- **Client** = IDE (Zed, JetBrains, Kiro, any editor)
- **Server** = Coding agent (Claude agent, Codex agent, custom agent)

The IDE (client) controls the agent (server). The IDE:
1. Discovers and registers available ACP agents
2. Sends user requests to the agent
3. Presents agent responses to the user
4. Mediates tool access (the agent requests through the IDE, not directly)

This is the inverse of MCP's direction:
- **MCP:** Agent (client) -> Tool server
- **ACP:** IDE (client) -> Agent server

### Core Concepts

| Concept | Description |
|---------|-------------|
| **Agent Manifest** | JSON/TOML metadata describing an agent's capabilities and entry point |
| **Extension** | The packaging unit for an ACP agent |
| **Context** | IDE-provided information: open files, project structure, diagnostics |
| **Tool Use** | Agent requests tool invocations through the IDE (mediated, not direct) |
| **Slash Commands** | Agent-defined commands the user can invoke |
| **Language Model** | Agent can request LLM completions through the IDE's LM API |

### Agent Manifest

An ACP agent declares itself via a manifest:

```toml
[agent]
name = "my-coding-agent"
description = "An AI coding assistant"
version = "1.0.0"

[agent.capabilities]
slash_commands = true
tool_use = true
context_awareness = true
streaming = true
```

### IDE Support

| IDE | ACP Status | Notes |
|-----|-----------|-------|
| **Zed** | Native, reference implementation | Created ACP |
| **JetBrains** | Announced support | Founding backer |
| **Kiro** | Announced support | Founding backer; am has Kiro adapter |
| **VS Code** | Not announced | Could adopt |
| **Cursor** | Not announced | Proprietary integration currently |

### How ACP Relates to MCP

```
  IDE (ACP Client)
       |
       | ACP (controls the agent)
       |
  Coding Agent (ACP Server)
       |
       | MCP (agent uses tools)
       |
  MCP Servers (database, GitHub, etc.)
```

- ACP defines how the IDE talks to the agent
- MCP defines how the agent talks to tools
- They coexist: an ACP agent uses MCP tools internally
- The IDE mediates: agent requests tool use, IDE checks permissions

### Where Does am Fit with ACP?

This is the critical question. am is not an IDE (so it would not be an ACP
client) and it is not a coding agent that IDEs launch (so ACP server is
questionable). am's natural role with ACP is **config management**:

| Role | Fit for am? | Rationale |
|------|------------|-----------|
| ACP Client (IDE) | No | am is not an IDE |
| ACP Server (Agent) | Unlikely | am is a config manager, not an agent IDEs launch |
| ACP Config Manager | Yes | am generates IDE configs; when IDEs support ACP, am should generate ACP agent registrations |

The config management pattern is identical to MCP: am does not implement MCP
in IDE configs -- it generates the config that tells each IDE which MCP
servers to connect to. Similarly, am would generate the config that tells
each IDE which ACP agents are available.

### Open Question: CLI Tools as ACP Participants

The question of whether CLI tools (not IDEs) can meaningfully participate in
ACP is open. The protocol was designed for IDE-to-agent communication, but
CLI tools like Gemini CLI and Codex CLI blur the line between "IDE" and
"standalone tool." If ACP is adopted by CLI tools as well as IDEs, am's role
could expand beyond config management to actual protocol participation.

**RESOLVED:** OpenClaw and ACPX research completed (see Section 9).

**ACPX** (`npm: acpx`, v0.5.3) is a "headless CLI client for the Agent Client
Protocol -- talk to coding agents from the command line." This proves ACP is
NOT limited to IDEs. CLI tools can be ACP clients.

**OpenClaw** (`npm: openclaw`, by steipete) is a "personal AI assistant you
run on your own devices" -- a local-first gateway with 23+ messaging channel
integrations. It depends on BOTH `@agentclientprotocol/sdk` (v0.18.0) and
`@modelcontextprotocol/sdk` (v1.29.0), demonstrating dual-protocol usage.

This changes the ACP assessment for am: ACP client integration is viable
and should be a Phase 4 candidate (see ADR-0017).

---

## 3. A2A (Agent-to-Agent Protocol) -- Google/Linux Foundation

### What Is A2A?

A2A is an HTTP-oriented interoperability protocol for agent-to-agent
orchestration. Created by Google, now governed under the Linux Foundation's
Agentic AI Foundation (AAIF) alongside MCP and AGENTS.md.

**Repository:** `github.com/a2aproject/A2A`
**Spec version:** v0.3.0
**Governance:** Linux Foundation AAIF
**Backers:** Google, IBM (post-ACP merger), Linux Foundation

### Why A2A is the Highest-Value Protocol for am

am has a unique advantage that no single IDE has: **cross-tool visibility.**
am knows about every agent configured for Claude Code, Cursor, Kiro, Codex,
and every other tool. This makes am the natural A2A hub:

1. **AgentCard generation** -- am's `[agents]` section already contains the
   metadata A2A AgentCards need.
2. **Discovery hub** -- `am a2a serve` publishes a composite AgentCard
   advertising all managed agents.
3. **Delegation broker** -- When agent A (Claude Code) wants to delegate to
   agent B (Cursor), am is the natural broker.
4. **Network coordinator** -- am becomes the central node in the agent network.

### Core Concepts

| Concept | Description |
|---------|-------------|
| **AgentCard** | Machine-readable "business card" -- capabilities, endpoints, auth, skills |
| **Task** | Unit of work with lifecycle states, session affinity, artifact output |
| **Message** | Ordered content with role (user/agent), typed parts |
| **Artifact** | Named output with typed parts, metadata, streaming support |
| **Part** | Typed content: TextPart, DataPart, FilePart (with MIME types) |

### AgentCard -- The Discovery Primitive

```json
{
  "name": "Code Reviewer Agent",
  "description": "Reviews pull requests for security and quality issues",
  "version": "1.2.0",
  "protocolVersion": "a2a-0.3.0",
  "url": "https://agents.example.com/.a2a",
  "provider": "Example Corp",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true,
    "extendedAgentCard": true
  },
  "authentication": {
    "securitySchemes": [
      { "type": "oauth2", "flows": ["authorization_code"] },
      { "type": "http", "scheme": "bearer" }
    ]
  },
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text", "file"],
  "skills": [
    {
      "id": "review-pr",
      "name": "Review Pull Request",
      "description": "Analyzes a PR diff for issues",
      "inputModes": ["text", "json"],
      "outputModes": ["json", "text"]
    }
  ]
}
```

Published at: `/.well-known/agent.json` or `/.well-known/agent-card.json`

### Mapping am's Agent Schema to A2A AgentCards

| am field | A2A AgentCard field | Notes |
|----------|-------------------|-------|
| `agents.<name>.name` | `name` | Direct mapping |
| `agents.<name>.description` | `description` | Direct mapping |
| `agents.<name>.model` | Part of `provider` | Model info |
| `agents.<name>.tools` | Informs `skills[].inputModes` | Tool capabilities |
| `agents.<name>.mcp_servers` | Referenced in skills | What tools the agent uses |
| `agents.<name>.adapters.a2a.url` | `url` | A2A endpoint |
| `agents.<name>.adapters.a2a.capabilities` | `capabilities` | Streaming, push, etc. |
| `agents.<name>.adapters.a2a.skills.*` | `skills[]` | Skill definitions |
| `settings.a2a.publish.provider` | `provider` | Organization name |

### Task Lifecycle

```
submitted -> working -> input-required -> completed
                    \-> auth-required  \-> failed
                                        \-> canceled
                                        \-> rejected
```

- Terminal states are final
- `sessionId` groups related tasks
- `TaskStatus` carries state, optional message, timestamp

### Wire Protocol

- **JSON-RPC 2.0** methods: `message/send`, `message/stream`, `tasks/get`,
  `tasks/cancel`
- **SSE** for streaming: `Content-Type: text/event-stream`
- **gRPC** binding (optional)
- **Push notifications** via webhook

### SDK Availability

| Language | Status |
|----------|--------|
| Python | Official SDK |
| JavaScript/TypeScript | Official SDK |
| Go | Official SDK |
| Java | Community SDK |

### Gemini CLI's A2A Support

Gemini CLI ships with A2A support via the `--acp` flag (confusingly named).
This validates the pattern of an AI coding tool acting as both an A2A client
and A2A server.

---

## 4. How am Fits: The Agent Network Coordinator

### am's Unique Position

```
  Gemini CLI           Claude Code          Cursor           Kiro
  (A2A native)         (via MCP)            (via MCP)        (ACP + MCP)
       |                    |                   |                |
       |                    |                   |                |
       +--------+-----------+---------+---------+--------+------+
                |                               |
          am a2a serve                    am mcp-serve
          (HTTP, A2A protocol)            (stdio, MCP protocol)
                |                               |
                +---------------+---------------+
                                |
                          am-cli core
                    (knows ALL agents,
                     ALL tools, ALL configs)
                                |
                    +--------+--------+--------+
                    |        |        |        |
                 agent A  agent B  agent C  agent D
                 (Claude)  (Codex)  (Gemini) (custom)
```

am is the **only** component in this architecture that has cross-tool
visibility. Claude Code does not know about Cursor's agents. Kiro does not
know about Codex's agents. But am knows about all of them.

### Protocol Roles for am

| Protocol | am's Role | How |
|----------|-----------|-----|
| **MCP** | Config manager + participant | `[servers]` in TOML + `am mcp-serve` |
| **A2A** | Participant + network coordinator | AgentCards + `am a2a serve` + discovery |
| **ACP** | Config manager only | Generate ACP registrations in IDE configs |

### Why am Should NOT Implement ACP

ACP is fundamentally an IDE-to-agent protocol:
- The **client** is an IDE (with UI, file system, diagnostics, editor state)
- The **server** is a coding agent (takes context, returns code changes)

am is neither. am is a config management and coordination layer. Implementing
ACP would require am to:
- Present editor UI (it does not have one)
- Provide file context, diagnostics, language services (IDE features)
- Manage agent lifecycle in the way an IDE does

am's existing MCP server mode (`am mcp-serve`) already makes am accessible
to agents as a tool. ACP would add a second protocol for the same purpose,
with the added requirement of IDE features am does not have.

The right role for am with ACP is **config generation**: when Kiro ships ACP
support, am's Kiro adapter generates the ACP agent registrations in Kiro's
config files.

### Why am SHOULD Implement A2A

A2A is agent-to-agent, which fits am perfectly:
- am knows about all agents across all tools
- am can expose these agents as A2A AgentCards
- am can accept task delegations and route to the right agent
- am already has HTTP server infrastructure (Hono in web/)
- am already has agent profiles with capabilities and tools

The "agent network coordinator" role is unique to am and impossible for any
single IDE.

---

## 5. MCP-as-Agent-Bridge (Works Today)

Before A2A is ready, MCP can serve as a pragmatic agent-to-agent bridge:

```toml
# Codex CLI as MCP server accessible to Claude Code
[servers.codex-agent]
command = "codex"
args = ["mcp-server"]
description = "Codex CLI agent as MCP tool"
tags = ["agent-bridge"]
transport = "stdio"

# am itself as a bridge
[servers.agent-manager]
command = "am"
args = ["mcp-serve"]
description = "Agent-manager exposing all agents as MCP tools"
tags = ["agent-bridge"]
transport = "stdio"
```

### MCP-as-Bridge: Pros and Cons

| Pro | Con |
|-----|-----|
| Already works today | No discovery (must pre-configure) |
| Universal support (all 13+ tools) | No task lifecycle (stateless) |
| No new protocol to implement | No rich content negotiation |
| Reuses existing am infrastructure | Limited to tool invocations |
| Simple mental model | No streaming task updates |

MCP-as-bridge is the stepping stone; A2A server mode is the destination.

---

## 6. Maturity Assessment

### ACP (Zed) Maturity

| Criterion | Assessment |
|-----------|-----------|
| Spec stability | Early, actively developed |
| SDK | TypeScript (@agent-client-protocol/core) |
| IDE adoption | Zed (native), JetBrains (announced), Kiro (announced) |
| Relevance to am | **Medium** -- config management for IDE adapters |
| Risk | Low (only config generation, not protocol implementation) |

### A2A Maturity

| Criterion | Assessment |
|-----------|-----------|
| Spec stability | v0.3.0 -- pre-1.0, expect changes |
| SDK | Python, JS/TS, Go (official) |
| IDE adoption | Gemini CLI (`--acp` flag) |
| Relevance to am | **High** -- am as agent network coordinator |
| Risk | Medium (spec changes, limited adoption) |

### Recommendation Priority Order

1. **A2A** -- Highest value. am becomes the agent network coordinator.
   Phase into: schema (now), AgentCard export (v0.5+), server mode (v1.0+).

2. **ACP config management** -- Natural extension. When Kiro/JetBrains
   publish ACP config formats, extend existing adapters. Low effort.

3. **MCP bridge** -- Already works. Document patterns for cross-tool agent
   communication via MCP tool proxying.

---

## 7. Integration Proposals

### A2A Integration (Primary)

#### Phase 1: Schema (Now)
- A2A metadata in `[agents]` via `adapters.a2a` passthrough
- A2A settings in `[settings.a2a]` for discovery sources
- Zero code changes

#### Phase 2: AgentCard Export (A2A v0.5+)
- New A2A adapter (~500 lines) that generates AgentCard JSON
- `am a2a export` command
- Import: parse AgentCards from URLs into agent profiles

#### Phase 3: A2A Server Mode (A2A v1.0+)
- `am a2a serve` -- HTTP server publishing AgentCards, accepting tasks
- Delegation routing to agent profiles via MCP tools
- New MCP tools for agent discovery/communication
- am becomes the agent network coordinator

### ACP Integration (Secondary)

#### Phase 1: Schema (Now)
- ACP metadata in `[agents]` via `adapters.acp` passthrough
- Zero code changes

#### Phase 2: Adapter Extensions (When IDEs Ship ACP Configs)
- Extend Kiro adapter to emit ACP agent registrations
- Extend future JetBrains adapter similarly
- Same pattern as MCP server config generation

---

## 8. IBM/BeeAI ACP (Deprecated) -- Historical Context

IBM's Agent Communication Protocol was focused on agent-to-agent messaging
(different from Zed's IDE-to-agent ACP). It merged into A2A under the Linux
Foundation in mid-2025.

- **Repository:** `github.com/i-am-bee/acp` (deprecated)
- **Status:** Merged into A2A, migration bridges available
- **Relevance to am:** None. Use A2A.

The naming collision between IBM's "ACP" and Zed's "ACP" is unfortunate.
In this document, "ACP" always means Zed's Agent Client Protocol unless
explicitly stated otherwise.

---

## 9. Open Research Questions

### OpenClaw and ACPX (RESOLVED)

**ACPX** (`npm: acpx`, v0.5.3, by steipete and osolmaz):
- "Headless CLI client for the Agent Client Protocol (ACP)"
- Keywords: acp, agent-client-protocol, ai, claude-code, cli, codex, coding-agent
- Enables talking to ACP-compatible coding agents from the command line
- This is the **key finding**: ACP is not IDE-only. CLI tools can be ACP clients.

**OpenClaw** (`npm: openclaw`, v2026.4.9):
- "Multi-channel AI gateway with extensible messaging integrations"
- A personal AI assistant running on your own devices -- local-first, single-user
- Architecture: central Gateway at `ws://127.0.0.1:18789` connecting Pi agent,
  CLI, WebChat, macOS/iOS/Android nodes
- Dependencies include BOTH `@agentclientprotocol/sdk` (v0.18.0) AND
  `@modelcontextprotocol/sdk` (v1.29.0) -- dual-protocol
- 23+ channels: WhatsApp, Telegram, Slack, Discord, Google Chat, Signal,
  iMessage, IRC, Teams, Matrix, Feishu, LINE, WeChat, and more
- Features: voice, browser control (CDP), cron, webhooks, Live Canvas (A2UI)
- Contains `vitest.acp.config.ts` and `vitest.extension-acpx*.config.ts`,
  indicating ACP layer and ACPX extensions for agent-gateway communication

**What this means for am-cli:**
- am could use `@agentclientprotocol/sdk` to talk to coding agents via ACP
- `am agent run claude-code --task "review"` could use ACP under the hood
- am sits at the intersection of MCP (tools), ACP (agent control), A2A (discovery)
- OpenClaw's dual-protocol pattern (ACP + MCP) validates this approach
- Phase 4 of ADR-0017 should explore ACP client integration

### ACP in Non-IDE Contexts

More broadly: does ACP make sense outside of IDEs? The protocol was designed
for IDE-to-agent communication, but if CLI tools adopt it, the client-server
model could apply to any host application (not just IDEs). This would make
ACP relevant to am as a protocol participant, not just a config manager.

---

## 10. Comparison: All Protocols for am

| Criterion | MCP | A2A | ACP (Zed) | ANP |
|-----------|-----|-----|-----------|-----|
| **am's role** | Config + participant | Participant + coordinator | Config manager | N/A |
| **Priority** | Done | High (next) | Medium (IDE adapter extension) | Low (monitor) |
| **Implementation** | `[servers]` + `am mcp-serve` | AgentCards + `am a2a serve` | Adapter passthrough | N/A |
| **Effort** | Done | Medium-High (Phase 2-3) | Low (~200 lines per adapter) | High |
| **Value** | High (universal) | High (unique cross-tool coordination) | Medium (Kiro/JetBrains config) | Low |
| **Spec maturity** | Stable | Pre-1.0 (v0.3.0) | Early | V1.0, low adoption |
| **IDE support** | Universal | Gemini CLI | Zed, JetBrains, Kiro | None |
| **Risk** | None | Medium | Low (config only) | High |

---

## Sources

### ACP (Agent Client Protocol -- Zed)
- Website: agentclientprotocol.com
- npm: @agent-client-protocol/core
- Zed blog: zed.dev/blog/acp-progress-report
- Overview: philschmid.de/acp-overview
- Backers: Zed, JetBrains, Kiro

### A2A (Agent-to-Agent Protocol)
- Repository: github.com/a2aproject/A2A
- Spec: a2a-protocol.org/v0.3.0/specification
- SDKs: Python, JS/TS, Go (a2aproject org)
- Governance: Linux Foundation AAIF

### IBM/BeeAI ACP (Deprecated)
- Repository: github.com/i-am-bee/acp (deprecated)
- Website: agentcommunicationprotocol.dev (deprecated)

### Other
- ANP: agent-network-protocol.com, arXiv:2508.00007
- MCP: modelcontextprotocol.io/specification/2025-11-25
- Gemini CLI: google-gemini.github.io/gemini-cli
- Linux Foundation AAIF: governs MCP, A2A, AGENTS.md

### agent-manager Context
- [10-agent-protocols-and-standards.md](10-agent-protocols-and-standards.md)
- [ADR-0009](../ADRs/0009-mcp-server-mode.md) -- MCP server mode
- [ADR-0001](../ADRs/0001-layered-core-plus-adapter-extensions.md) -- Layered architecture
- [ADR-0007](../ADRs/0007-two-phase-zod-validation.md) -- Two-phase validation
