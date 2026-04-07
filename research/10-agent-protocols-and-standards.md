---
tags: [research/agent-manager, protocols/mcp, protocols/acp, protocols/a2a, protocols/anp, standards]
created: 2026-04-07
updated: 2026-04-07
status: active
---

# Agent Protocols and Standards Research

Research into emerging agent protocol standards and how AI coding tools are converging
or diverging. This informs the design of a "superset" schema for an agent-manager tool
that can generate configuration for any target IDE or agent framework.

---

## 1. MCP (Model Context Protocol) -- Anthropic

### Overview

MCP is the dominant open protocol for connecting LLM applications to external tools,
data sources, and services. Created by Anthropic (announced November 2024), it defines
a standardized JSON-RPC 2.0 interface between hosts (LLM apps), clients (connectors),
and servers (capability providers). The spec is open-source at modelcontextprotocol.io.

**Current spec version:** 2025-11-25 (latest tagged release)

### Core Primitives

| Primitive | Purpose | Direction |
|-----------|---------|-----------|
| **Tools** | Executable functions with JSON Schema input | Server -> Client (model invokes) |
| **Resources** | Read-oriented context (files, queries, blobs) by URI | Server -> Client (user/model reads) |
| **Prompts** | Reusable message templates with arguments | Server -> Client (user selects) |
| **Sampling** | Server-initiated LLM interactions | Client -> Server (server requests completion) |
| **Roots** | Client-declared URI scopes constraining server access | Client -> Server |
| **Completions** | Auto-complete for prompt/resource arguments | Server -> Client |
| **Logging** | Structured log messages from server | Server -> Client |

### Transports

| Transport | Status | Use Case |
|-----------|--------|----------|
| **stdio** | Stable, widely used | Local servers (IDE integrations, CLI tools) |
| **Streamable HTTP** | Stable | Remote/cloud servers, production deployments |
| **SSE** (Server-Sent Events) | Deprecated by MCP project | Legacy remote servers (still in some implementations) |

### Lifecycle and Capabilities Negotiation

1. Client connects to server via chosen transport
2. Peers exchange `protocolVersion` (e.g., "2025-11-25") and `capabilities` object
3. Capabilities declare which primitives each side supports (tools, resources, prompts,
   completions, notifications, sampling)
4. `ClientCapabilities` includes an `experimental` property for non-standard extensions
5. Methods: `tools/list`, `resources/list`, `prompts/list`, `tools/call`,
   `resources/read`, `completion/complete`, `ping`, plus notification methods

### OAuth and Security

- Servers MUST implement OAuth 2.1 resource server behavior
- Protected Resource Metadata (RFC9728) and `WWW-Authenticate` discovery
- Authorization Code flow with PKCE for public clients
- Client Credentials for machine-to-machine
- Dynamic client registration (RFC7591) suggested
- Short-lived access tokens with optional refresh tokens

### MCP Registry

The official registry at registry.modelcontextprotocol.io provides an app-store model
for MCP server discovery:
- REST API (OpenAPI 3.1) with `/v0/servers` endpoint
- Namespace verification (GitHub or DNS)
- `server.json` metadata format
- Status: Preview (may have breaking changes before GA)
- Active growth into 2026 with thousands of servers listed

### IDE Implementation Divergence

| IDE/Tool | MCP Support | Notable Deviations |
|----------|-------------|-------------------|
| **Claude Code** | Native, full spec | Reference implementation; hooks/plugins extend beyond MCP |
| **Cursor** | Supported | OAuth refresh-token bug documented (PKCE flow); .mdc rules are separate |
| **Windsurf** | Supported | No public deviation docs; uses own rules system |
| **VS Code Copilot** | Supported | Enterprise security patterns; MCP used alongside VS Code extension API |
| **Cline** | Supported | `alwaysAllow` per-tool; `cline_mcp_settings.json` format |
| **Continue** | Supported | `mcpServers` in `config.yaml` with inline definitions |
| **Gemini CLI** | Supported via extensions | `gemini-extension.json` manifest with settings array; admin allowlisting |
| **OpenAI Codex CLI** | Supported | Can run AS an MCP server; supports hosted MCP, streamable HTTP, stdio |
| **Roo Code** | Supported | Same as Cline MCP format (fork heritage) |

**Key Finding:** MCP is the one protocol ALL major AI coding tools support. It is the
de facto universal integration layer. However, each tool wraps MCP in its own config
format and adds proprietary features on top.

---

## 2. ACP (Agent Communication Protocol) -- IBM/BeeAI

### Overview

ACP is an open, HTTP-native protocol for inter-agent messaging, discovery, delegation,
and orchestration. Created by IBM Research as part of the BeeAI platform. It focuses on
agent-to-agent communication (complementary to MCP's tool-to-agent focus).

### Core Concepts

| Concept | Description |
|---------|-------------|
| **Agent Manifest** | Agent metadata: name, description, capabilities, endpoints |
| **Run** | A single agent execution instance with `run_id`, `session_id`, `status` |
| **Message** | Ordered content units with typed `MessagePart`s |
| **MessagePart** | Typed content: text, image, JSON, file (MIME-typed, optionally JWS-signed) |
| **Session** | Stateful grouping of runs (platform-dependent) |

### Wire Format and Transport

- HTTP REST with JSON bodies (primary)
- WebSocket and SSE for streaming/delta updates
- JSON-RPC 2.0 style for session APIs
- TLS 1.3 required
- OpenAPI spec published in `i-am-bee/acp` repository

### Discovery

ACP supports four discovery patterns:
1. **Basic Discovery** -- query ACP server via REST `/agents` endpoint
2. **Open Discovery** -- public manifest files at well-known URLs
3. **Registry-Based Discovery** -- centralized catalog
4. **Embedded Discovery** -- metadata in container image labels

### Task Lifecycle

States: `created` -> `in_progress` -> `awaiting` -> `completed`/`failed`
- BeeAI adds platform lifecycle: INITIALIZING, ACTIVE, DEGRADED, RETIRING, RETIRED
- Idempotency-Key header for retry safety
- Structured error objects with codes: `invalid_request`, `rate_limit_exceeded`,
  `request_not_idempotent` (409), `processing_error` (422), `service_unavailable` (503)

### Security

- Bearer tokens and optional mutual TLS
- Capability tokens (signed objects with resource types, operations, expiry)
- Proof-of-Possession handshake (ACP-HP/ACP-SIGN)
- AgentID format: base58 encoding of public key hash
- JWS signing of individual message parts

### Relationship to MCP

ACP and MCP are **complementary**:
- ACP = agent-to-agent orchestration and collaboration
- MCP = tool/resource discovery and invocation by agents
- BeeAI Framework provides `MCPTool` adapters that let ACP agents call MCP tools

### Current Status

- Moved from pre-alpha to draft alpha during 2025
- **Merged into A2A initiative under Linux Foundation** with migration guidance published
- Reference implementations in Python and TypeScript
- L-level roadmap: L1-L4, with future L5 "Decentralized ACP-D"

---

## 3. Google A2A (Agent-to-Agent Protocol)

### Overview

A2A is an HTTP-oriented interoperability protocol for agent orchestration created by
Google. It defines machine-readable Agent Cards, a Task abstraction, Messages and
Artifacts as payload carriers, with JSON-RPC 2.0 + SSE + optional gRPC transports.

### AgentCard Schema

An AgentCard is the "business card" an agent publishes for discovery:

```json
{
  "name": "Acme Purchasing Concierge",
  "description": "Agent that helps with procurement",
  "version": "1.2.0",
  "protocolVersion": "a2a-0.3.0",
  "url": "https://acme.example.com/.a2a",
  "provider": "Acme Corp",
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
      "id": "create-purchase-order",
      "name": "Create Purchase Order",
      "description": "Creates a PO from line items",
      "inputModes": ["text", "json"],
      "outputModes": ["json", "file"]
    }
  ]
}
```

Published at well-known paths: `/.well-known/agent.json` or `/.well-known/agent-card.json`
(inconsistency across implementations).

### Task Lifecycle

States: `submitted` -> `working` -> `input-required` | `auth-required` -> `completed` | `failed` | `canceled` | `rejected`

- Terminal states are final (no restart)
- `sessionId` groups related tasks
- TaskStatus contains state, optional message, timestamp

### Message Format

- JSON-RPC 2.0 methods: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`
- Messages have `role` (user/agent), `parts` array, `messageId`, optional `taskId`/`sessionId`
- Part types: TextPart, DataPart, FilePart (with MIME types)

### Artifacts

- Output objects with `id`, `name`, `parts`, `metadata`
- Streaming via `append`/`lastChunk` flags on TaskArtifactUpdateEvent
- Clients reassemble chunks by applying append-ordered parts

### Streaming and Push

- **SSE**: Primary streaming transport, `Content-Type: text/event-stream`
- **gRPC**: Optional high-performance binding
- **Push Notifications**: Webhook registration via `tasks/pushNotificationConfig/set`
  - Bearer token or signature authentication
  - Retry with exponential backoff (10-30s timeout)

### Relationship to MCP

A2A and MCP serve different purposes:
- **A2A**: Horizontal agent-to-agent discovery and orchestration at runtime
- **MCP**: Vertical tool integrations (tool-to-agent)
- A2A uses dynamic discovery (AgentCards); MCP uses manifest/registry-based tool catalogs
- A2A has built-in task lifecycle; MCP is stateless request/response

### Current Status

- Protocol version: v0.3.0
- Governed at github.com/a2aproject/A2A
- Under Linux Foundation's Agentic AI Foundation (alongside MCP and Goose)
- Backed by Google, used in Gemini Enterprise
- SDKs in Python, JavaScript, Go
- ACP merged into A2A in mid-2025

---

## 4. ANP (Agent Network Protocol)

### Overview

ANP (Agent Network Protocol) is an open-source protocol aiming to be "the HTTP of the
Agentic Web era." Created by independent contributors (led by Gaowei Chang), published
as arXiv:2508.00007, released V1.0 in May 2025. ~1,252 GitHub stars.

### Three-Layer Architecture

| Layer | Purpose |
|-------|---------|
| **Identity & Encrypted Communication** | W3C DID-based decentralized identity + E2E encryption |
| **Meta-Protocol Negotiation** | Natural language negotiation of communication protocols between agents |
| **Application Protocol** | Agent Description Protocol (ADP) + agent discovery |

### Key Design Differences

ANP differs fundamentally from MCP and A2A:

| Dimension | MCP | A2A | ANP |
|-----------|-----|-----|-----|
| **Interaction model** | Remote Call (client calls tools) | Task Outsourcing (delegate tasks) | Data Crawling (navigate linked data) |
| **Info disclosure** | Full tool/resource lists at once | Capability overview via AgentCard | Hierarchical links, on-demand access |
| **Identity** | OAuth tokens | Security schemes in AgentCard | W3C DID (decentralized, no blockchain) |
| **Transport** | JSON-RPC over stdio/HTTP | JSON-RPC over HTTP/SSE/gRPC | HTTP + JSON-LD (Linked Data) |
| **Scope** | Tool/resource integration | Agent task delegation | Open internet agent interconnection |

### Wire Format

- **JSON-LD** with `@context` using schema.org vocabularies
- DID method: `did:wba` (Web-Based Agent) -- DNS/HTTPS-based, no blockchain required
- Agent Description Protocol provides structured capability descriptions
- Agents navigate linked data network starting from description document entry point

### Current Status

- V1.0 released May 2025
- Apache 2.0 license
- Protocol SDK at github.com/agent-network-protocol/AgentConnect
- Positioned as complementary: "Use MCP for tools, A2A for enterprise collaboration,
  ANP for open internet agent connections"
- Less adoption than MCP/A2A but intellectually interesting for decentralized scenarios

---

## 5. OpenAI's Approach

### Codex CLI Configuration

OpenAI's Codex CLI uses **TOML** configuration with a hierarchical precedence model:

```
1. CLI flags and --config overrides (highest)
2. Profile values (--profile <name>)
3. Project config: .codex/config.toml
4. User config: ~/.codex/config.toml
5. System config: /etc/codex/config.toml (lowest)
```

**Key config.toml fields:**
- `model` -- default model (e.g., "gpt-5.4")
- `approval_policy` -- "untrusted", "on-request", "never", "granular"
- `sandbox_mode` -- "read-only", "workspace-write", "danger-full-access"
- `model_instructions_file` -- path to instructions file
- `shell_environment_policy.include_only` -- env var allowlist
- `agents.<name>.description` -- role guidance for named agents
- `agents.<name>.config_file` -- per-agent TOML config layer
- `agents.max_threads` -- concurrent agent thread limit (default: 6)
- `agents.max_depth` -- nesting depth limit (default: 1)
- `features.*` -- feature flags (boolean toggles)

**Admin enforcement:** `requirements.toml` constrains security-sensitive settings that
users cannot override (allowed approval policies, sandbox modes, etc.).

**JSON Schema available** at `developers.openai.com/codex/config-schema.json` for
IDE autocompletion.

### Codex as MCP Server

Codex CLI can run as an MCP server (`codex mcp-server`), exposing two tools:
- `codex` -- run a full Codex session with config parameters
- Plan tool (optional)

This enables multi-agent workflows via the OpenAI Agents SDK.

### OpenAI Agents SDK

A Python/JavaScript SDK with minimal primitives:
- **Agents** -- LLMs with instructions and tools
- **Handoffs** -- agent-to-agent delegation
- **Guardrails** -- input/output validation
- **Sessions** -- persistent memory across turns
- **MCP integration** -- built-in support for hosted MCP, streamable HTTP, stdio servers
- **Tracing** -- built-in observability

The SDK does NOT define a config file format -- agents are defined in code.

### AGENTS.md

OpenAI initiated AGENTS.md as a cross-tool instruction file standard. As of late 2025,
it was placed under the Linux Foundation's Agentic AI Foundation (AAIF) with backing
from OpenAI, Anthropic, Google, AWS, Bloomberg, Cloudflare. Over 60,000 repos on GitHub
include an AGENTS.md.

**Current AGENTS.md support:**

| Tool | Reads AGENTS.md | Native File | Subdirectory Support |
|------|----------------|-------------|---------------------|
| OpenAI Codex CLI | Primary | AGENTS.override.md | Yes |
| GitHub Copilot | Yes | .github/copilot-instructions.md | Yes |
| Cursor | Yes | .cursor/rules/*.mdc | Yes |
| Windsurf | Yes | .windsurf/rules/*.md | Yes |
| Amp | Yes | -- | Yes |
| Devin | Yes | -- | Yes |
| Claude Code | **No** (uses CLAUDE.md) | CLAUDE.md | Yes |
| Gemini CLI | **No** (uses GEMINI.md) | GEMINI.md | Yes |

---

## 6. Claude Code Plugins Specification

### Plugin Manifest (plugin.json)

Located at `.claude-plugin/plugin.json`:

```json
{
  "name": "plugin-name",
  "version": "1.2.0",
  "description": "Brief plugin description",
  "author": {
    "name": "Author Name",
    "email": "author@example.com",
    "url": "https://github.com/author"
  },
  "homepage": "https://docs.example.com/plugin",
  "repository": "https://github.com/author/plugin",
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "commands": ["./custom/commands/special.md"],
  "agents": "./custom/agents/",
  "skills": "./custom/skills/",
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "outputStyles": "./styles/",
  "lspServers": "./.lsp.json"
}
```

Only `name` is required if manifest is present. Manifest itself is optional --
Claude Code auto-discovers components in default locations.

### Component Types

| Component | Location | Format |
|-----------|----------|--------|
| **Commands** | `commands/*.md` | Markdown with YAML frontmatter (name, description) |
| **Skills** | `skills/<name>/SKILL.md` | Markdown with extensive frontmatter |
| **Agents** | `agents/*.md` or `.claude/agents/*.md` | Markdown with YAML frontmatter |
| **Hooks** | `hooks/hooks.json` or inline in plugin.json | JSON event handlers |
| **MCP Servers** | `.mcp.json` at plugin root | Standard MCP config JSON |
| **LSP Servers** | `.lsp.json` at plugin root | LSP config JSON |
| **Output Styles** | `output-styles/*.md` | Markdown with frontmatter |

### Skill Frontmatter Fields

```yaml
---
name: skill-name           # Optional, defaults to dir name
description: What and when  # Recommended, max 1024 chars
argument-hint: [issue-num]  # Hint in autocomplete
disable-model-invocation: false  # true = user-only trigger
user-invocable: true        # false = hidden from / menu
allowed-tools: Read, Grep   # Pre-approved tools
model: inherit              # sonnet, opus, haiku, inherit
context: fork               # Run in isolated subagent
agent: Explore              # Subagent type (Explore, Plan, general-purpose)
hooks:                      # Lifecycle hooks scoped to skill
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "npm run lint"
---
```

### Agent Frontmatter Fields

```yaml
---
name: code-reviewer        # Required, matches filename
description: When to invoke # Required
tools: Read, Grep, Glob    # Allowed tools
disallowedTools: Write     # Explicitly denied tools
model: sonnet              # Model override
permissionMode: default    # default, acceptEdits, dontAsk, bypassPermissions, plan
maxTurns: 10               # Max agentic turns
skills: [lint, test]       # Preloaded skills
mcpServers: {}             # MCP servers for this agent
hooks: {}                  # Scoped lifecycle hooks
memory: project            # Persistent memory scope: user, project, local
---
```

### Hook Events

| Event | When | Supports Matcher |
|-------|------|-----------------|
| SessionStart | Session begins/resumes | startup, resume, clear, compact |
| PreToolUse | Before tool call (can block) | Tool name regex |
| PostToolUse | After tool completes | Tool name regex |
| PostToolUseFailure | After tool fails | Tool name regex |
| PermissionRequest | Permission dialog appears | Tool name regex |
| PermissionDenied | Permission denied | Tool name regex |
| UserPromptSubmit | User sends message | No |
| Notification | Notification sent | No |
| SubagentStart | Subagent spawned | No |
| SubagentStop | Subagent finishes | No |
| TaskCreated | Task created via TaskCreate | No |
| TaskCompleted | Task marked complete | No |
| Stop | Claude finishes responding | No |

Hook types: `command` (shell), `prompt` (LLM evaluation), `agent` (agentic verifier),
`http` (webhook endpoint).

---

## 7. Cursor Rules Ecosystem

### Modern Rules System (.cursor/rules/)

Cursor transitioned from legacy `.cursorrules` (single file) to a directory-based system:

```
.cursor/rules/
  typescript-standards.mdc
  react-patterns.mdc
  api-guidelines.mdc
  testing-conventions.mdc
```

### .mdc File Format

```markdown
---
description: "Standards for TypeScript code"
globs: "*.ts,*.tsx"
alwaysApply: false
---

# TypeScript Standards
...rule content in markdown...
```

### Activation Modes

| Mode | Fields | When Applied |
|------|--------|-------------|
| Always Apply | `alwaysApply: true` | Every chat session |
| Glob-scoped | `globs: "*.ts"` | When matching files are in context |
| Description-matched | `description` only | AI decides based on relevance |
| Manual | `alwaysApply: false`, no globs | User explicitly references |

### Rule Types and Precedence

1. **Team Rules** (highest) -- dashboard-managed, org-wide enforcement (Team/Enterprise)
2. **Project Rules** -- `.cursor/rules/*.mdc`, version-controlled
3. **User Rules** -- Cursor Settings > General > Rules for AI
4. **AGENTS.md** -- plain markdown, always-on, simpler alternative

### RULE.md (Latest Format)

Cursor's latest format uses `RULE.md` inside subdirectories:
```
.cursor/rules/
  my-rule/
    RULE.md           # Main rule file
    ...               # Supporting files
```

---

## 8. The "Agent Config" Landscape (2025-2026)

### Config Format Survey

| Tool | Config Format | Config File | Instruction File | MCP Config |
|------|--------------|-------------|-----------------|------------|
| Claude Code | JSON | `.claude/settings.json` | `CLAUDE.md` | `.mcp.json` |
| Cursor | YAML frontmatter + MD | `.cursor/rules/*.mdc` | AGENTS.md | settings |
| Windsurf | YAML frontmatter + MD | `.windsurf/rules/*.md` | `.windsurfrules`, AGENTS.md | settings |
| Copilot | YAML frontmatter + MD | `.github/instructions/*.instructions.md` | `.github/copilot-instructions.md`, AGENTS.md | VS Code settings |
| Cline | JSON | `cline_mcp_settings.json` | `.clinerules`, AGENTS.md | `cline_mcp_settings.json` |
| Roo Code | JSON | `.roomodes` | `.clinerules` | MCP settings JSON |
| Continue | YAML | `config.yaml` | Rules in config | `mcpServers` in config.yaml |
| Gemini CLI | JSON | `.gemini/settings.json` | `GEMINI.md` | `gemini-extension.json` |
| Codex CLI | TOML | `.codex/config.toml` | `AGENTS.md` | MCP server config |

### Standardization Efforts

1. **AGENTS.md (Linux Foundation AAIF)**: Closest to a cross-tool standard for
   project instructions. Backed by OpenAI, Anthropic, Google, AWS. 60,000+ repos.
   But Claude Code and Gemini CLI still use their own formats.

2. **MCP (Anthropic)**: The universal tool integration layer. Every major IDE supports
   it, but each wraps it in different config syntax.

3. **A2A (Google) + ACP (IBM)**: Merging under Linux Foundation for agent-to-agent
   interoperability. Not yet relevant to IDE config but will affect multi-agent
   orchestration patterns.

4. **Skills Playground / DevTk.AI**: Commercial tools that generate config for
   multiple AI coding tools from a single definition. Validates the market need
   for an agent-manager.

5. **claudelint.com**: Publishes JSON Schema files for all Claude Code config
   components (skills, agents, hooks, MCP, plugins, settings, LSP, output styles).

### The Fragmentation Problem

The landscape is ~90% identical in WHAT gets configured but wildly different in HOW:
- All tools need: model selection, instructions, tool permissions, MCP servers
- Divergence is in: file format (JSON/TOML/YAML/MD), file location, frontmatter schema,
  activation logic, permission models, hook systems, agent definitions

---

## 9. IDE-Specific Unique Features

### Claude Code

| Feature | Description | Unique? |
|---------|-------------|---------|
| **Hooks system** | PreToolUse, PostToolUse, Stop, 12+ event types with command/prompt/agent/http handlers | Most comprehensive |
| **Plugin system** | plugin.json manifest with commands, skills, agents, hooks, MCP, LSP, output styles | Only Claude Code |
| **Skills with frontmatter** | `context: fork`, `agent: Explore`, `allowed-tools`, `model` override per skill | Only Claude Code |
| **Agent subagents** | Markdown-defined agents with tool restrictions, model override, maxTurns, memory scope | Only Claude Code |
| **Permission modes** | default, acceptEdits, dontAsk, bypassPermissions, plan | Granular unique |
| **Output styles** | Custom markdown formatting rules | Only Claude Code |
| **LSP server integration** | `.lsp.json` for language server protocol | Only Claude Code |
| **Prompt-based hooks** | LLM evaluates whether to allow/block actions | Only Claude Code |
| **Agent hooks** | Spawn agentic verifiers with tool access | Only Claude Code |
| **Team agent plans** | TeamCreate/SendMessage for parallel agent teams | Only Claude Code |
| **Plugin marketplace** | `marketplace.json` for plugin distribution | Only Claude Code |
| **Memory scoping** | user, project, local memory per agent | Only Claude Code |

### Cursor

| Feature | Description | Unique? |
|---------|-------------|---------|
| **Team Rules (cloud)** | Dashboard-managed org-wide rules, enforced or optional | Only Cursor |
| **.mdc with globs** | YAML frontmatter with `alwaysApply`, `globs`, `description` triggers | Cursor-specific format |
| **AI tab settings** | Model selection and rules in IDE Settings UI | Cursor-specific |
| **Rule import** | Import rules from external sources | Cursor feature |
| **RULE.md subdirectories** | Rule folders with RULE.md + supporting files | Latest Cursor pattern |

### Windsurf

| Feature | Description | Unique? |
|---------|-------------|---------|
| **Cascade Memories** | Auto-generated persistent memories across conversations | Only Windsurf |
| **Trigger types** | `always_on`, `glob`, `model_decision`, `manual` per rule | Windsurf-specific |
| **System-level rules** | OS-deployed rules (`/Library/Application Support/Windsurf/rules/`) | Enterprise feature |
| **Global rules file** | `~/.codeium/windsurf/memories/global_rules.md` (6K char limit) | Windsurf-specific |
| **Per-rule char limits** | 12,000 chars per workspace rule, 6,000 chars global | Windsurf constraint |

### GitHub Copilot

| Feature | Description | Unique? |
|---------|-------------|---------|
| **excludeAgent** | Frontmatter field to exclude specific agents from file access | Only Copilot |
| **applyTo** | Frontmatter field scoping instruction files to patterns | Copilot-specific |
| **Content exclusion** | Org-level file exclusion from Copilot suggestions (Biz/Enterprise) | Only Copilot |
| **Agent plugins** | VS Code extension-based plugins with marketplace | Copilot-specific |
| **Custom agent skills** | `.github/skills/` directory with SKILL.md | Converging with Claude Code |
| **Custom subagents** | `.github/agents/*.md` with tools, argument-hint | Converging with Claude Code |
| **Premium model requests** | Rate-limited premium tier for advanced models | Copilot-specific |

### Cline

| Feature | Description | Unique? |
|---------|-------------|---------|
| **alwaysAllow per MCP tool** | `"alwaysAllow": ["tool1", "tool2"]` in MCP config | Cline-specific granularity |
| **Plan/Act mode** | Separate API config per mode (different models for planning vs acting) | Cline/Roo specific |
| **Custom config directory** | `--config /path/to/config` for isolated instances | Cline CLI feature |
| **Per-provider API config** | Different URL, model, key per provider per mode | Cline-specific |
| **Command permissions** | Allow/deny patterns for shell commands | Cline CLI feature |
| **Workflows** | Configurable multi-step workflows | Cline feature |

### Roo Code

| Feature | Description | Unique? |
|---------|-------------|---------|
| **.roomodes** | Project-level custom modes with role definitions | Only Roo Code |
| **Mode definitions** | Custom modes like Architect, Code, Ask, Debug with tool restrictions | Roo-specific |
| **Mode source selection** | Global vs project mode precedence | Roo-specific |
| **Per-mode tool restrictions** | Each mode defines which tools are allowed | Roo-specific |

### Continue

| Feature | Description | Unique? |
|---------|-------------|---------|
| **config.yaml** | YAML-first configuration with models array, context providers, rules | Continue-specific |
| **Hub ecosystem** | `uses: anthropic/claude-sonnet-4-6` references to hub configs | Only Continue |
| **Context providers** | Pluggable context sources (diff, file, code, docs) | Continue-specific |
| **Custom slash commands** | Prompts defined in config.yaml with name, description, prompt template | Continue-specific |
| **Multi-model roles** | Models assigned to roles: chat, edit, autocomplete | Continue-specific |
| **Autocomplete options** | debounceDelay, maxPromptTokens, onlyMyCode | Continue-specific |
| **Data sources** | Named data configurations in config | Continue-specific |

### Gemini CLI

| Feature | Description | Unique? |
|---------|-------------|---------|
| **GEMINI.md** | Project instructions file (like CLAUDE.md but with `/init` generator) | Gemini-specific |
| **Extensions system** | `gemini-extension.json` with settings array, envVar mapping, sensitive flag | Only Gemini CLI |
| **ACP mode** | `--acp` flag for Agent Communication Protocol mode | Only Gemini CLI |
| **Sandbox options** | `true`, `"docker"`, `"podman"` | Gemini-specific sandbox variety |
| **coreTools/excludeTools** | Allowlist/denylist of built-in tools by name | Gemini-specific |
| **Plan mode** | `/plan` command with dedicated planning mode | Gemini CLI feature |
| **Chat compression** | Automatic chat history compression settings | Gemini-specific |
| **Session retention** | Auto-delete chats by age or count | Gemini-specific |
| **JIT Context Discovery** | Just-In-Time context for file system tools | Gemini-specific |
| **Include directories** | Multi-directory workspace support | Gemini-specific |

---

## 10. Protocol Comparison Matrix

### Communication Models

| Protocol | Model | Statefulness | Primary Use Case |
|----------|-------|-------------|-----------------|
| MCP | Client-server RPC | Stateful sessions | Tool integration |
| A2A | Peer-to-peer tasks | Stateful tasks | Agent orchestration |
| ACP | HTTP REST + streaming | Stateful runs | Agent collaboration |
| ANP | Data crawling (linked) | Stateless navigation | Open internet agents |

### Maturity and Adoption

| Protocol | Spec Version | Governance | Major Backers | Adoption Level |
|----------|-------------|-----------|---------------|---------------|
| MCP | 2025-11-25 | Anthropic | Anthropic, all IDE vendors | Very High (universal) |
| A2A | v0.3.0 | Linux Foundation AAIF | Google, IBM, Linux Foundation | Medium (growing) |
| ACP | Draft alpha | Merged into A2A | IBM | Low (merged) |
| ANP | V1.0 | Independent | Community | Low (niche) |

---

## 11. Universal Features Matrix (ALL tools share)

These features are present in every AI coding tool surveyed:

| Feature | Universal Form |
|---------|---------------|
| **Project instructions** | Markdown file in project root (CLAUDE.md / AGENTS.md / GEMINI.md / .windsurfrules) |
| **MCP server support** | JSON config for MCP servers with command, args, env |
| **Model selection** | Configure which LLM model to use |
| **Tool/command execution** | Shell command execution with some permission model |
| **File read/write** | Read and edit files in the project |
| **Context from files** | Include project files as context for the model |
| **Conversation interface** | Chat-based interaction with the AI |

---

## 12. Common Features Matrix (50%+ tools share)

| Feature | Tools Supporting | Coverage |
|---------|----------------|----------|
| **AGENTS.md support** | Codex, Copilot, Cursor, Windsurf, Cline, Amp, Devin | ~70% (not Claude Code, Gemini) |
| **Hierarchical config** | Claude Code, Codex, Cursor, Windsurf, Copilot, Gemini | ~75% (user > project > local) |
| **Tool permission model** | Claude Code, Codex, Cursor, Cline, Gemini, Roo | ~75% |
| **Auto-approve settings** | Claude Code, Codex, Cursor, Windsurf, Cline, Gemini | ~75% |
| **Custom rules/instructions with scoping** | Claude Code, Cursor, Windsurf, Copilot, Cline | ~60% |
| **Sandbox/isolation** | Claude Code, Codex, Gemini, Cline | ~50% |
| **Subdirectory instruction files** | Codex, Copilot, Cursor, Windsurf | ~50% |
| **Multi-model support** | Claude Code, Codex, Continue, Cline, Roo | ~50% |
| **Custom slash commands** | Claude Code, Continue, Gemini | ~40% |
| **Hooks/lifecycle events** | Claude Code, Cline, Windsurf (memories) | ~30% |
| **Agent/subagent definitions** | Claude Code, Copilot, Codex | ~30% |

---

## 13. Unique Features Catalog (only one tool has)

| Feature | Tool | Description |
|---------|------|-------------|
| Plugin system (full) | Claude Code | Self-contained plugin directories with manifest, commands, skills, agents, hooks, MCP, LSP |
| Prompt-based hooks | Claude Code | LLM evaluates whether to allow/block tool actions |
| Agent hooks (agentic verifiers) | Claude Code | Spawn agents with tool access to verify actions |
| Output styles | Claude Code | Custom markdown formatting rules |
| LSP server integration | Claude Code | Language server protocol in config |
| Memory scoping per agent | Claude Code | user/project/local memory persistence |
| Team Rules (cloud-managed) | Cursor | Org-wide dashboard rules with enforcement |
| Cascade Memories (auto) | Windsurf | Auto-generated persistent context across sessions |
| System-level rules (OS-deployed) | Windsurf | Admin-deployed rules in OS directories |
| excludeAgent | Copilot | Per-file agent exclusion in frontmatter |
| Content exclusion (org-level) | Copilot | Enterprise file exclusion from all Copilot |
| .roomodes | Roo Code | Project-level custom modes with role + tool restrictions |
| Hub ecosystem (uses:) | Continue | Reference shared configs from a hub |
| Context providers (pluggable) | Continue | Pluggable context sources in config |
| Extensions with settings/envVar | Gemini CLI | Extension manifest with user-configurable settings |
| ACP mode | Gemini CLI | Agent Communication Protocol transport |
| JIT Context Discovery | Gemini CLI | Just-in-time file system context |
| requirements.toml (admin) | Codex CLI | Admin-enforced security constraints |
| Codex as MCP server | Codex CLI | Run the IDE tool itself as an MCP server |
| Plan/Act mode split | Cline | Different API configs for planning vs acting |
| alwaysAllow per tool | Cline | Tool-level auto-approve in MCP config |

---

## 14. Implications for Core vs Adapter Boundary

### Core Schema (what the agent-manager should model universally)

Based on the universal and common features matrices, the core schema should capture:

1. **Identity**: name, version, description, author, license, repository
2. **Instructions**: Project-level instructions content (markdown) with hierarchy
   (global, project, directory)
3. **Models**: Model name/provider/ID with roles (primary, fast, planning)
4. **MCP Servers**: command, args, env, transport type, enabled/disabled -- this is
   truly universal across ALL tools
5. **Tool Permissions**: approval policy (auto/ask/deny), per-tool overrides, sandbox mode
6. **Rules**: Markdown content with activation conditions (always, glob, description-based)
7. **Skills**: name, description, content, trigger conditions, allowed tools
8. **Agents/Subagents**: name, description, model, tools, max turns, instructions

### Adapter Layer (what adapters translate to per-tool format)

Each adapter handles the tool-specific:

| Concern | Adapter Responsibility |
|---------|----------------------|
| **File format** | JSON (Claude), TOML (Codex), YAML (Continue), MD+frontmatter (Cursor) |
| **File location** | `.claude/`, `.codex/`, `.cursor/rules/`, `.windsurf/rules/`, `.github/` |
| **Instruction file name** | CLAUDE.md vs AGENTS.md vs GEMINI.md vs .windsurfrules |
| **Permission syntax** | Claude hooks vs Codex approval_policy vs Cline alwaysAllow |
| **Activation logic** | Claude skill triggers vs Cursor globs vs Windsurf trigger types |
| **Hook translation** | Claude hook events -> no equivalent in most tools (drop gracefully) |
| **Plugin packaging** | Only Claude Code has plugins; adapter would skip or use closest analog |
| **Team/cloud features** | Cursor Team Rules, Copilot org settings -- cloud-only, not in file config |

### Recommended Architecture

```
                    agent-manager core schema (YAML/TOML)
                              |
        +----------+----------+---------+----------+
        |          |          |         |          |
   claude-code  cursor   windsurf   copilot    codex
    adapter    adapter   adapter   adapter   adapter
        |          |          |         |          |
  .claude/    .cursor/  .windsurf/ .github/  .codex/
  CLAUDE.md   rules/    rules/    instructions/ config.toml
  .mcp.json   *.mdc     *.md      *.md      AGENTS.md
  plugin.json                     copilot-
  hooks.json                      instructions.md
```

### Key Design Principles

1. **MCP is the integration universal** -- model MCP servers as first-class objects
   in core schema; every adapter can emit them

2. **Instructions are content, not format** -- core schema stores markdown content;
   adapters decide the filename and location

3. **Permissions are semantic, not syntactic** -- core schema models intent ("auto-approve
   read tools", "ask before writes", "deny shell commands matching rm -rf"); adapters
   translate to tool-specific syntax

4. **Degrade gracefully for unique features** -- if core schema includes hooks and the
   target tool doesn't support hooks, the adapter silently skips them (or emits a
   warning). The schema should support the superset.

5. **AGENTS.md as a fallback** -- for any tool that reads AGENTS.md, the adapter can
   emit a shared AGENTS.md alongside tool-specific config

6. **Protocol awareness is optional** -- the agent-manager manages IDE config, not
   runtime protocols. But awareness of A2A/ACP/ANP informs the agent/skill schema
   design (AgentCard-like metadata, task lifecycle awareness, capability declarations)

### Protocol Implications for Agent Schema

The A2A AgentCard pattern suggests the core agent definition should include:
- Capabilities declaration (what the agent can do)
- Input/output modes (text, json, file)
- Skills with typed inputs/outputs
- Authentication requirements (when applicable)
- Version and protocol compatibility

This maps well to Claude Code's agent frontmatter and could be the richest target.

---

## Sources

### Primary Protocol Specifications
- MCP: modelcontextprotocol.io/specification/2025-11-25
- A2A: github.com/a2aproject/A2A, a2a-protocol.org/v0.3.0/specification
- ACP: github.com/i-am-bee/acp, agentcommunicationprotocol.dev
- ANP: agent-network-protocol.com, arXiv:2508.00007

### IDE Documentation
- Claude Code: code.claude.com/docs, github.com/anthropics/claude-code
- Cursor: cursor.com docs, github.com/sanjeed5/awesome-cursor-rules-mdc
- Windsurf: docs.windsurf.com
- Copilot: code.visualstudio.com/docs/copilot
- Cline: docs.cline.bot, github.com/cline/cline
- Roo Code: github.com/RooCodeInc/Roo-Code
- Continue: docs.continue.dev/reference
- Gemini CLI: google-gemini.github.io/gemini-cli, geminicli.com
- Codex CLI: developers.openai.com/codex

### Standards Bodies
- Linux Foundation AAIF: Governs AGENTS.md, A2A/ACP merger, and MCP
- MCP Registry: registry.modelcontextprotocol.io
