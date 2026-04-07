# Agent Profiles Landscape: Cross-Tool Configuration Research

**Date:** 2026-04-07
**Purpose:** Determine whether agent profiles should be a core entity in agent-manager or remain adapter-specific.

---

## 1. Claude Code

### Where configs live

| Scope | Path |
|-------|------|
| Project | `.claude/agents/<name>.md` |
| Personal | `~/.claude/agents/<name>.md` |

### Format

Markdown with YAML frontmatter.

```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices. Use after writing or modifying code.
tools: Read, Grep, Glob, Bash
disallowedTools: Write, Edit
model: sonnet
permissionMode: default
maxTurns: 50
---

You are a senior code reviewer.

When invoked:
1. Run git diff to see recent changes
2. Focus on modified files
3. Review for readability, error handling, security, and test coverage
```

### Configurable fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier (lowercase + hyphens) |
| `description` | Yes | When Claude should delegate to this subagent |
| `tools` | No | Allowed tools (inherits all if omitted) |
| `disallowedTools` | No | Tools to deny (removed from inherited set) |
| `model` | No | `sonnet`, `opus`, `haiku`, full model ID, or `inherit` (default) |
| `permissionMode` | No | `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `plan` |
| `maxTurns` | No | Maximum agentic turns |
| `mcpServers` | No | MCP servers available to subagent |
| `hooks` | No | Lifecycle hooks |
| `skills` | No | Skills available to subagent |
| `memory` | No | Memory configuration |
| `effort` | No | Reasoning effort level |
| `background` | No | Run in background |
| `isolation` | No | Context isolation settings |

### Multi-agent support

Yes. Multiple `.md` files in agents/ directory. Agent Teams via `TeamCreate`/`SendMessage` for parallel orchestration. Delegate mode restricts lead to coordination only.

### Key design choices

- Markdown body IS the system prompt
- Subagents get their own context window (isolation)
- Skills can fork into subagents via `context: fork`
- SDK API also supports inline agent definitions via `--agents` JSON flag

---

## 2. Cursor

### Where configs live

| Scope | Path |
|-------|------|
| Project | `.cursor/agents/<name>.md` |
| User | `~/.cursor/agents/<name>.md` |
| Claude compat | `.claude/agents/<name>.md` (also read) |
| Codex compat | `.codex/agents/<name>.md` (also read) |

### Format

Markdown with YAML frontmatter (same as Claude Code).

```markdown
---
name: security-auditor
description: Security specialist. Use when implementing auth, payments, or handling sensitive data.
model: inherit
readonly: true
---

You are a security expert auditing code for vulnerabilities.
When invoked:
1. Identify security-sensitive code paths
2. Check for common vulnerabilities (injection, XSS, auth bypass)
3. Verify secrets are not hardcoded
```

### Configurable fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier |
| `description` | Yes | When to delegate to this subagent |
| `model` | No | `inherit`, `fast`, or specific model ID |
| `readonly` | No | Restrict write permissions (boolean) |
| `is_background` | No | Execute in background (boolean) |

### Multi-agent support

Yes. Default subagents for codebase research, terminal commands, parallel workstreams. Custom subagents via files. `.cursor/` takes precedence over `.claude/` or `.codex/` on name conflicts.

### Key design choices

- Deliberately compatible with Claude Code agent format
- Also reads from `.claude/agents/` and `.codex/agents/` for cross-tool compatibility
- Removed custom modes in 2.1, community pushback ongoing
- Skills defined in `SKILL.md` files (separate from agents)

---

## 3. Roo Code

### Where configs live

| Scope | Path |
|-------|------|
| Project | `.roomodes` file (single file, array of modes) |
| Project (individual) | `.roo/modes/<slug>.json` or `.roo/modes/<slug>.yaml` |
| Global | VS Code settings `roo-code.customModes` |

### Format

JSON or YAML (YAML support added via PR #3711).

```json
{
  "customModes": [
    {
      "slug": "security-auditor",
      "name": "Security Auditor",
      "roleDefinition": "Act as an expert security auditor specializing in web application security...",
      "groups": [
        ["read", {}],
        ["command", { "fileRegex": "^(npm|npx|yarn)\\s" }],
        ["mcp", {}]
      ],
      "customInstructions": "Focus on OWASP Top 10..."
    }
  ]
}
```

### Configurable fields

| Field | Required | Description |
|-------|----------|-------------|
| `slug` | Yes | URL-safe unique identifier |
| `name` | Yes | Display name (supports emoji) |
| `roleDefinition` | Yes | System prompt / role description |
| `groups` | Yes | Tool group permissions with optional regex restrictions |
| `customInstructions` | No | Additional instructions appended to prompts |

### Tool groups

Tool access is controlled via named groups: `read`, `edit`, `command`, `browser`, `mcp`, with optional file/command regex filters per group.

### Multi-agent support

Yes. Multiple modes defined in `.roomodes` or individual files. SPARC orchestration pattern uses Boomerang Tasks for multi-agent coordination (Orchestrator, Researcher, Implementer, Tester, Reviewer modes).

### Key design choices

- Role-based approach: modes define what the agent IS, not just what it can DO
- Tool restrictions via group-level permissions (not individual tool names)
- No model field -- model selection is separate from mode definition
- Strong orchestration patterns via community (SPARC)

---

## 4. Kiro (Amazon)

### Where configs live

| Scope | Path |
|-------|------|
| Project | `.kiro/agents/<name>.json` |
| Global | `~/.kiro/agents/<name>.json` |

### Format

JSON with a defined schema.

```json
{
  "name": "backend-dev",
  "description": "Node.js/Express API development with MongoDB",
  "prompt": "Backend development expert. Focus on API design...",
  "model": "claude-sonnet-4-20250514",
  "tools": ["fs_read", "fs_write", "execute_bash"],
  "allowedTools": ["fs_read"],
  "toolsSettings": {
    "fs_write": {
      "allowedPaths": ["src/api/", "src/routes/"]
    }
  },
  "mcpServers": {},
  "resources": ["file://.kiro/steering/review-checklist.md"],
  "hooks": {},
  "toolAliases": {},
  "includeMcpJson": true,
  "keyboardShortcut": "ctrl+shift+a"
}
```

### Configurable fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Agent name (derived from filename if omitted) |
| `description` | Yes | What the agent does |
| `prompt` | Yes | System prompt (inline or `file://` URI) |
| `model` | No | Model ID (e.g., `claude-sonnet-4-20250514`) |
| `tools` | No | Available tools array |
| `allowedTools` | No | Pre-approved tools (no confirmation) |
| `toolsSettings` | No | Per-tool config (e.g., `allowedPaths`) |
| `toolAliases` | No | Rename tools to avoid collisions |
| `mcpServers` | No | MCP server configurations |
| `resources` | No | File resources available to agent |
| `hooks` | No | Lifecycle hooks |
| `includeMcpJson` | No | Inherit MCP servers from `mcp.json` |
| `keyboardShortcut` | No | Quick switch shortcut |

### Multi-agent support

Yes. Multiple JSON files in `.kiro/agents/`. Switch with `/agent swap`. List with `/agent list`. Kiro also has steering files (separate from agents) for always-on rules.

### Key design choices

- JSON format (not markdown) -- most structured of all tools
- Richest tool-level configuration (per-tool settings, aliases, allowed paths)
- `resources` field for injecting file context
- Hooks integrated directly into agent config
- Steering files (`.kiro/steering/`) separate from agents -- agents are workers, steering is context

---

## 5. Codex CLI (OpenAI)

### Where configs live

| Scope | Path |
|-------|------|
| User | `~/.codex/config.toml` |
| Project | `.codex/config.toml` |
| Agent instructions | `AGENTS.md` (project root + subdirectories) |

### Format

TOML for configuration, Markdown for instructions.

```toml
model = "gpt-5.4"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[profiles.fast]
model = "gpt-5.1-mini"
reasoning_effort = "low"
service_tier = "fast"

[profiles.security]
model = "gpt-5.4"
reasoning_effort = "xhigh"
```

### Configurable fields (profiles)

| Field | Description |
|-------|-------------|
| `profiles.<name>.model` | Model override |
| `profiles.<name>.reasoning_effort` | `none`/`minimal`/`low`/`medium`/`high`/`xhigh` |
| `profiles.<name>.service_tier` | `flex`/`fast` |
| `profiles.<name>.tools_view_image` | Enable/disable image tool |
| `profiles.<name>.web_search` | `disabled`/`cached`/`live` |
| `profiles.<name>.plan_mode_reasoning_effort` | Plan-mode reasoning override |
| `sandbox_mode` | `read-only`/`workspace-write`/`danger-full-access` |
| `approval_policy` | `untrusted`/`on-request`/`never` |
| `project_doc_fallback_filenames` | Fallbacks when `AGENTS.md` missing |

### Multi-agent support

No dedicated multi-agent system. Profiles are configuration presets, not independent agents. No subagent/delegation mechanism.

### Key design choices

- TOML format -- unusual among AI tools
- Profiles are config presets, not agent identities (no description, no system prompt)
- Agent instructions via AGENTS.md (plain markdown, no schema)
- Strong sandbox/permission model
- No `.codex/agents/` directory (despite Cursor reading from it for compat)

---

## 6. Continue.dev

### Where configs live

| Scope | Path |
|-------|------|
| User | `~/.continue/config.yaml` |
| Workspace | `.continue/config.yaml` |
| Hub | `hub.continue.dev` (remote configs) |
| Profiles | `.continue/configs/` (new, PR #11935, March 2026) |

### Format

YAML.

```yaml
name: My Assistant
version: 0.0.1
schema: v1

models:
  - name: Claude Sonnet
    provider: anthropic
    model: claude-sonnet-4-6
    capabilities:
      - tool_use
      - image_input

rules:
  - always use TypeScript strict mode

context:
  - provider: codebase
  - provider: diff
  - provider: file

mcpServers:
  - name: filesystem
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
```

### Configurable fields

| Field | Description |
|-------|-------------|
| `name` | Assistant name |
| `models` | Array of model configs (provider, model ID, capabilities) |
| `rules` | Array of rules (strings or file references) |
| `context` | Context providers (codebase, diff, file, web, MCP, etc.) |
| `mcpServers` | MCP server configurations |
| `prompts` | Custom slash command prompts |
| `docs` | Documentation sources for RAG |

### Multi-agent support

Limited. Hub configs allow multiple "assistants" (switching between configurations). Local configs directory (`.continue/configs/`) added March 2026. No subagent delegation or orchestration.

### Key design choices

- YAML format with a formal schema
- "Assistants" are complete config bundles, not role-specialized workers
- Hub-based sharing model (community + organization)
- Context providers are a unique differentiator
- No agent-as-subagent pattern

---

## 7. AGENTS.md Standard (Linux Foundation / AAIF)

### Where configs live

| Scope | Path |
|-------|------|
| Project root | `AGENTS.md` |
| Subdirectories | `path/to/AGENTS.md` (closest file wins) |

### Format

Plain Markdown. No required schema or frontmatter.

### What it defines

- Project-specific guidance for AI agents
- Build commands, test runners, conventions, constraints
- Codebase overview and directory structure
- Tool-specific instructions

### What it does NOT define

- Agent profiles, roles, or identities
- Model selection
- Tool restrictions
- Subagent configurations
- Multi-agent orchestration

### Adoption

60,000+ open-source projects. Supported by Claude Code, Codex, Cursor, Gemini CLI, Copilot, Windsurf, Devin, Roo Code, and others. Donated to AAIF under Linux Foundation (Dec 2025).

### Key design choices

- Analogous to README.md -- project context, not agent configuration
- Intentionally schema-free for maximum adoption
- Not an agent profile standard -- it's a project context standard
- Closest AGENTS.md to the file being edited takes precedence

---

## 8. A2A Protocol AgentCard (Google)

### Where configs live

Agent Cards are served at well-known HTTP endpoints (`/.well-known/agent.json`) or via registries.

### Format

JSON (defined by protobuf schema, JSON as convenience output).

```json
{
  "name": "burger_seller_agent",
  "description": "Helps with creating burger orders",
  "url": "https://agent.example.com",
  "version": "1.0.0",
  "protocolVersions": ["0.3.0"],
  "provider": {
    "organization": "Example Corp",
    "url": "https://example.com"
  },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "capabilities": {
    "streaming": true,
    "pushNotifications": true,
    "stateTransitionHistory": true,
    "extendedAgentCard": true
  },
  "skills": [
    {
      "id": "create_burger_order",
      "name": "Burger Order Creation Tool",
      "description": "Helps with creating burger orders",
      "tags": ["burger order creation"],
      "examples": ["I want to order 2 classic cheeseburgers"],
      "inputModes": ["text/plain"],
      "outputModes": ["text/plain"]
    }
  ],
  "securitySchemes": {},
  "security": []
}
```

### Configurable fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Agent name |
| `description` | Yes | Purpose and capabilities |
| `version` | Yes | Implementation version |
| `url` | Yes | Service endpoint |
| `provider` | No | Organization info |
| `capabilities` | No | Streaming, push notifications, etc. |
| `skills` | No | Array of skill definitions (id, name, description, tags, examples, I/O modes) |
| `defaultInputModes` | No | Supported input MIME types |
| `defaultOutputModes` | No | Supported output MIME types |
| `securitySchemes` | No | Auth schemes |
| `security` | No | Required auth |
| `protocolVersions` | No | Supported A2A versions |
| `documentationUrl` | No | Link to docs |
| `iconUrl` | No | Agent icon |

### Multi-agent support

Core design purpose. A2A is specifically for agent-to-agent communication and discovery. AgentCard is the discovery mechanism.

### Key design choices

- Network-first: agents as services, not files
- Skills as capability units (not subagent delegation)
- Strong auth/security model
- Protobuf as normative source (JSON is convenience)
- No model selection -- agents are opaque services
- Extended AgentCard for authenticated clients

---

## 9. Summary Comparison Matrix

| Dimension | Claude Code | Cursor | Roo Code | Kiro | Codex CLI | Continue | AGENTS.md | A2A AgentCard |
|-----------|-------------|--------|----------|------|-----------|----------|-----------|---------------|
| **Config path** | `.claude/agents/` | `.cursor/agents/` | `.roomodes` / `.roo/modes/` | `.kiro/agents/` | `~/.codex/config.toml` | `~/.continue/config.yaml` | `AGENTS.md` | HTTP endpoint |
| **Format** | MD + YAML FM | MD + YAML FM | JSON/YAML | JSON | TOML | YAML | Markdown | JSON (proto) |
| **Name/ID** | Yes | Yes | Yes (`slug`) | Yes | N/A (profiles) | Yes | N/A | Yes |
| **Description** | Yes | Yes | Yes (`roleDefinition`) | Yes | N/A | N/A | N/A | Yes |
| **System prompt** | MD body | MD body | `roleDefinition` | `prompt` field | AGENTS.md | `rules` | Body text | N/A |
| **Model** | Yes | Yes | No | Yes | Yes (profiles) | Yes | N/A | N/A |
| **Tool restrictions** | Yes | Partial (`readonly`) | Yes (groups) | Yes (rich) | Sandbox only | Via MCP | N/A | N/A (opaque) |
| **MCP servers** | Yes | N/A | Via groups | Yes | N/A | Yes | N/A | N/A |
| **Max turns** | Yes | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| **Permissions** | Yes | Partial | Via groups | `allowedTools` | Sandbox | N/A | N/A | Auth schemes |
| **Hooks** | Yes | N/A | N/A | Yes | N/A | N/A | N/A | N/A |
| **Multi-agent** | Teams | Subagents | Boomerang | Swap | No | No | N/A | Core purpose |
| **Background exec** | Yes | Yes | N/A | N/A | N/A | N/A | N/A | Async tasks |
| **Cross-tool compat** | N/A | Reads `.claude/`, `.codex/` | N/A | N/A | N/A | N/A | Universal | Universal |

---

## 10. Three-Tool Promotion Test

The agent-manager 3-tool promotion rule: a concept becomes a core entity if it's normalizable across 3+ tools.

### Fields present in 3+ tools (normalizable)

| Field | Claude Code | Cursor | Roo Code | Kiro | Codex | Continue | Count |
|-------|-------------|--------|----------|------|-------|----------|-------|
| `name` / `slug` | Y | Y | Y | Y | N | Y | **5** |
| `description` | Y | Y | Y | Y | N | N | **4** |
| `system_prompt` | Y (body) | Y (body) | Y (`roleDef`) | Y (`prompt`) | N | Y (`rules`) | **5** |
| `model` | Y | Y | N | Y | Y | Y | **5** |
| `tools` (allow/deny) | Y | Partial | Y | Y | N | Via MCP | **4** |
| `mcp_servers` | Y | N | Via groups | Y | N | Y | **3** |

### Fields in < 3 tools (adapter-specific)

| Field | Tools | Count |
|-------|-------|-------|
| `maxTurns` | Claude Code | 1 |
| `permissionMode` | Claude Code | 1 |
| `readonly` / `is_background` | Cursor | 1 |
| `toolAliases` | Kiro | 1 |
| `toolsSettings.allowedPaths` | Kiro | 1 |
| `resources` | Kiro | 1 |
| `keyboardShortcut` | Kiro | 1 |
| `hooks` | Claude Code, Kiro | 2 |
| `reasoning_effort` | Codex | 1 |
| `context_providers` | Continue | 1 |
| `tool_groups` (with regex) | Roo Code | 1 |

**Result: 6 fields pass the 3-tool threshold.** Agent profiles are normalizable.

---

## 11. Proposed Universal Agent Profile Schema

Based on the cross-tool analysis, here is the normalizable core schema:

```typescript
interface AgentProfile {
  // === Core identity (5+ tools) ===
  name: string;              // Unique identifier (slug format)
  description: string;       // When/why to use this agent
  prompt: string;            // System prompt / role definition
  model?: string;            // Model ID or alias ('sonnet', 'opus', 'inherit', full ID)

  // === Capability control (3-4 tools) ===
  tools?: string[];          // Allowed tools
  disallowedTools?: string[];// Denied tools (removed from inherited set)
  mcpServers?: Record<string, McpServerConfig>;  // MCP server access

  // === Adapter extensions (opaque) ===
  extensions?: Record<string, unknown>;  // Tool-specific fields
}
```

### How each tool maps

| Universal Field | Claude Code | Cursor | Roo Code | Kiro | Codex | Continue |
|----------------|-------------|--------|----------|------|-------|----------|
| `name` | `name` | `name` | `slug` | `name` | profile key | `name` |
| `description` | `description` | `description` | `name` + context | `description` | -- | -- |
| `prompt` | MD body | MD body | `roleDefinition` | `prompt` | AGENTS.md | `rules[]` |
| `model` | `model` | `model` | -- | `model` | `profiles.*.model` | `models[0].model` |
| `tools` | `tools` | -- | `groups` | `tools` | -- | via MCP |
| `disallowedTools` | `disallowedTools` | `readonly` (bool) | group exclusion | -- | -- | -- |
| `mcpServers` | `mcpServers` | -- | via `mcp` group | `mcpServers` | -- | `mcpServers` |
| `extensions` | `permissionMode`, `maxTurns`, `hooks`, `memory`, `effort`, `isolation` | `readonly`, `is_background` | `customInstructions`, group regex | `toolsSettings`, `toolAliases`, `resources`, `hooks`, `allowedTools`, `keyboardShortcut` | `sandbox_mode`, `approval_policy`, `reasoning_effort` | `context`, `docs`, `prompts` |

---

## 12. Recommendation: Core Entity

**Agent profiles SHOULD be a core entity in agent-manager.**

### Rationale

1. **Passes 3-tool rule decisively.** 6 fields normalize across 3+ tools. The core identity triple (`name`, `description`, `prompt`) exists in 5 of 6 tools that have any agent concept.

2. **Format convergence is already happening.** Cursor explicitly reads Claude Code's `.claude/agents/` directory. Both use identical markdown-with-YAML-frontmatter format. Kiro uses JSON but with the same semantic fields. The industry is converging on a file-per-agent model.

3. **A2A AgentCard provides a network-level normalization target.** While A2A is service-oriented (not file-based), its `AgentCard` schema maps cleanly to the proposed universal schema. agent-manager could bridge file-based agent configs to A2A discovery.

4. **AGENTS.md is NOT the answer.** AGENTS.md is project context, not agent identity. It explicitly does not define roles, models, tool restrictions, or multi-agent configurations. It complements agent profiles but does not replace them.

5. **The `extensions` escape hatch handles adapter-specific fields.** Kiro's `toolAliases`, Claude Code's `permissionMode`, Roo's group-regex patterns -- all fit cleanly into an opaque extensions map that adapters own.

### Proposed core entity structure

```
AgentProfile (core)
  ├── name: string
  ├── description: string
  ├── prompt: string
  ├── model?: string
  ├── tools?: string[]
  ├── disallowedTools?: string[]
  ├── mcpServers?: Record<string, McpServerConfig>
  └── extensions?: Record<string, unknown>
```

### Adapter responsibilities

Each adapter translates to/from its native format:

| Adapter | Read from | Write to | Format |
|---------|-----------|----------|--------|
| `claude-code` | `.claude/agents/*.md` | `.claude/agents/*.md` | MD + YAML frontmatter |
| `cursor` | `.cursor/agents/*.md` | `.cursor/agents/*.md` | MD + YAML frontmatter |
| `roo-code` | `.roomodes` or `.roo/modes/*.json` | `.roomodes` or `.roo/modes/*.json` | JSON/YAML |
| `kiro` | `.kiro/agents/*.json` | `.kiro/agents/*.json` | JSON |
| `codex` | `.codex/config.toml` (profiles section) | `.codex/config.toml` | TOML |
| `continue` | `.continue/config.yaml` | `.continue/config.yaml` | YAML |

### What agent-manager enables

With agent profiles as a core entity, `am` can:

1. **`am agents list`** -- show all agent profiles across all detected tools
2. **`am agents add <name>`** -- create an agent profile, written to all detected tool formats
3. **`am agents sync`** -- normalize profiles across tools (e.g., Claude Code agent -> Cursor agent)
4. **`am agents export --format a2a`** -- export to A2A AgentCard format for network discovery
5. **`am agents import <file>`** -- import from any supported format

### What remains adapter-specific

- Kiro's `toolSettings.allowedPaths` (path-level restrictions)
- Claude Code's `permissionMode`, `maxTurns`, `isolation`
- Roo Code's tool group regex patterns
- Codex's `sandbox_mode`, `approval_policy`
- Continue's context providers, docs sources
- Cursor's `is_background`, `readonly`

These live in `extensions` and are preserved during roundtrip but not normalized.

---

## 13. Cross-Tool Compatibility Note

An important emerging pattern: **Cursor already reads Claude Code and Codex agent formats**. This means writing to `.claude/agents/` gives you both Claude Code AND Cursor support for free. agent-manager should leverage this:

- Writing a Claude-format agent gives coverage for 2 tools
- Writing a Kiro-format agent covers Kiro
- Writing a Roo-format mode covers Roo Code
- Codex profiles are structurally different (config presets, not agents)
- Continue assistants are config bundles, not role-specialized agents

The minimum viable adapter set for agent profile sync: **Claude Code + Kiro + Roo Code** covers 4 tools (Claude, Cursor, Kiro, Roo) and the three distinct formats.
