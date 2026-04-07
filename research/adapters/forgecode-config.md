# ForgeCode Configuration Research

## What is ForgeCode?

**ForgeCode** (aka "Forge") is a CLI-based AI coding harness — a terminal-native
alternative to Claude Code with first-class multi-provider support. It runs in
your shell, integrates with Zsh via a plugin (`:` prefix triggers prompts), and
supports 300+ models across cloud, open-weight, and local providers.

- **Made by:** Tailcall, Inc. (antinomyhq)
- **Website:** https://forgecode.dev
- **GitHub:** https://github.com/antinomyhq/forgecode (~6K stars, ~1.3K forks, 2.4K+ commits, 312+ releases)
- **Written in:** Rust (93.5%)
- **CLI command:** `forge`
- **Install:** `curl -fsSL https://forgecode.dev/cli | sh` or `npm install -g forgecode@latest`
- **Platforms:** macOS, Linux, Android, Windows (WSL/Git Bash)
- **License:** Open source
- **Latest version:** ~v0.121+ (as of April 2026)
- **TermBench 2.0 rank:** #1 with 81.8% accuracy

## Maturity

GA and actively developed. ~312 releases, steady weekly cadence. Major features
added recently: AGENTS.md support (v0.111), agent-to-agent communication (v0.110),
SKILL.md, .mcp.json, .forge.toml, VS Code extension. The project is production-ready
for daily development use.

## Config File Locations

ForgeCode uses a multi-layered configuration system with separate files for different
concerns. The config architecture is **distributed** — no single monolithic settings file.

### Directory Structure

```
~/forge/                          # Global config (user scope)
  agents/                         # Global custom agent definitions
    <agent-name>.md               # Agent: markdown with YAML frontmatter
  commands/                       # Global custom commands
    <command-name>.md             # Command: markdown with YAML frontmatter
  skills/                         # Global skills
    <skill-name>/
      SKILL.md                    # Skill definition

.forge/                           # Project-local config (project scope)
  agents/                         # Project-specific agent definitions
    <agent-name>.md
  skills/                         # Project-specific skills
    <skill-name>/
      SKILL.md

# Root-level config files (project scope)
.mcp.json                         # MCP server configuration
.forge.toml                       # ForgeCode-specific settings (NEW - replaces forge.yaml)
AGENTS.md                         # Project guidelines / rules (equiv to CLAUDE.md)
.ignore                           # Files to exclude from context

# Legacy (deprecated)
forge.yaml                        # Being replaced by .forge.toml + individual files
.env                              # Provider API keys (deprecated, use `forge provider login`)
```

### Precedence Rules

- **Agents:** Project `.forge/agents/` overrides global `~/forge/agents/` (same `id` wins)
- **MCP servers:** Local `.mcp.json` overrides user-scope config (same server name)
- **AGENTS.md:** Searched in order: base path (`~/forge`) > git root > cwd. First found wins.
- **Skills:** Both project and global skills are loaded; no override semantics documented.

## forge.yaml / .forge.toml (Global Behavior Config)

The legacy `forge.yaml` is being replaced by `.forge.toml` and individual config files.
Known fields from `forge.yaml` (many still apply):

```yaml
# forge.yaml (legacy but still functional)
model: claude-sonnet-4                    # Default model for all agents
max_requests_per_turn: 50                 # Safety limit: total requests before asking user
max_tool_failure_per_turn: 3              # Safety limit: failures before asking user

# Guidelines (deprecated — use AGENTS.md instead)
guidelines:
  - "Use TypeScript strict mode"
  - "Always handle errors"

# Custom commands (deprecated — use ~/forge/commands/*.md instead)
commands:
  - name: fmt
    description: Format and fix Rust code
    prompt: |
      Run cargo fmt and cargo clippy, then fix any issues
```

## AGENTS.md (Project Guidelines / Rules)

The primary rules file. Equivalent to Claude Code's `CLAUDE.md` — content can be
copied directly between them without modification.

- **Location:** Project root (or `~/forge/` for global, or git root)
- **Format:** Plain markdown, no frontmatter required
- **Injected into:** Every AI conversation as part of the system prompt
- **Priority:** base path > git root > cwd (first found wins)

```markdown
# Development Guidelines

## Core Standards
- Use TypeScript strict mode
- Add error handling to all functions
- Include unit tests for new code

## Project Structure
- All API calls must go through the `services/` directory
- Use the custom `apiClient` wrapper for consistent error handling

## Restrictions
- NEVER attempt to run the application - it's already running on port 3000
- NEVER use `any` type in TypeScript
```

### Key Difference from Claude Code

ForgeCode's `AGENTS.md` does NOT support hierarchical/nested loading from
subdirectories. It uses the first file found in the priority chain. Claude Code's
`CLAUDE.md` loads from parent directories and merges them.

## .mcp.json (MCP Server Configuration)

Full MCP support via the standard `.mcp.json` format. Identical schema to Claude Code's
`.mcp.json`.

### Format

```json
{
  "mcpServers": {
    "server_name": {
      "command": "command_to_execute",
      "args": ["arg1", "arg2"],
      "env": {
        "ENV_VAR": "value"
      }
    },
    "url_server": {
      "url": "https://example.com/mcp/sse"
    },
    "disabled_server": {
      "command": "node",
      "args": ["server.js"],
      "disable": true
    }
  }
}
```

### Server Configuration Types

| Type | Fields | Description |
|------|--------|-------------|
| Command-based | `command`, `args`, `env` | Spawns a local process |
| URL-based | `url` | Connects to remote SSE/streamable HTTP |

### Additional Fields

- `disable: true` — Server is ignored and not loaded (keeps config for later re-enable)
- `disable: false` or omitted — Server loads normally

### MCP Scopes

1. **Local scope:** `.mcp.json` in project root
2. **User scope:** global ForgeCode config directory

Local wins when both define the same server name.

### CLI Management

```bash
forge mcp import '<json>'              # Add servers from JSON string
forge mcp import --scope user '<json>' # Add to user scope
forge mcp list                          # List all configured servers
forge mcp show <server_name>            # Show full config for one server
forge mcp remove <server_name>          # Remove a server
forge mcp remove --scope user <name>    # Remove from user scope
forge mcp reload                        # Reload after manual .mcp.json edit
```

### Tool Access in Agents

MCP tools are automatically available to all agents. Per-agent tool filtering
uses glob patterns in the agent definition:

```yaml
tools:
  - read
  - search
  - "mcp_*"    # All MCP tools via prefix glob
```

## Agent Configuration

Agents are markdown files with YAML frontmatter. This is ForgeCode's most
distinctive feature — a rich multi-agent system with three built-in agents and
unlimited custom agents.

### Built-in Agents

| Agent | Access | Purpose |
|-------|--------|---------|
| `forge` | read + write | Implementation (default) |
| `muse` | read + write | Planning & analysis |
| `sage` | read only | Research & investigation (internal, used by forge/muse) |

### Custom Agent File Format

Location: `~/forge/agents/<name>.md` (global) or `.forge/agents/<name>.md` (project)

```yaml
---
id: security-auditor                        # REQUIRED: unique identifier
title: Security Auditor                      # Display name
description: Reviews code for vulnerabilities # Required for agent-as-tool

# Tool access (default: none unless specified)
tools:
  - read
  - search
  - "mcp_*"                                  # Glob pattern for MCP tools
  # - "*"                                    # All tools (use sparingly)

# Model selection (optional — defaults to configured model)
model: claude-sonnet-4
provider: anthropic                          # snake_case: open_router, openai, requesty, etc.

# Sampling (optional)
temperature: 0.1                             # 0.0–2.0
top_p: 0.9                                   # 0.0–1.0
top_k: 40                                    # 1–1000
max_tokens: 8192                             # 1–100,000

# Limits (optional)
max_turns: 50                                # Max conversation turns
max_requests_per_turn: 10
max_tool_failure_per_turn: 3

# Visibility (optional)
tool_supported: true                         # Can be called as tool by other agents

# Reasoning (optional — for models that support it)
reasoning:
  enabled: true
  effort: medium                             # low | medium | high
  max_tokens: 2048                           # Must be > 1024 and < max_tokens
  exclude: false                             # Hide reasoning from response

# User prompt template (optional — Handlebars)
user_prompt: |-
  <{{event.name}}>{{event.value}}</{{event.name}}>
  <date>{{current_date}}</date>
---

System prompt goes here in plain markdown.
You are a security specialist focused on finding and fixing vulnerabilities.
```

### Agent Frontmatter Fields Summary

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier (used as command name) |
| `title` | string | No | Display name |
| `description` | string | No | Required for agent-as-tool capability |
| `tools` | string[] | No | Tool whitelist (default: none) |
| `model` | string | No | Override model for this agent |
| `provider` | string | No | Provider name (snake_case) |
| `temperature` | float | No | 0.0–2.0 |
| `top_p` | float | No | 0.0–1.0 |
| `top_k` | int | No | 1–1000 |
| `max_tokens` | int | No | 1–100,000 |
| `max_turns` | int | No | Max conversation turns |
| `max_requests_per_turn` | int | No | Total requests before asking user |
| `max_tool_failure_per_turn` | int | No | Failures before forcing completion |
| `tool_supported` | bool | No | Whether callable as tool by other agents |
| `reasoning` | object | No | Reasoning configuration |
| `user_prompt` | string | No | Handlebars template for user messages |

## SKILL.md (Skills / Reusable Workflows)

Skills are reusable workflows — identical format to Claude Code's SKILL.md.
Claude Code skills can be copied directly without modification.

### Location

- Project: `.forge/skills/<skill-name>/SKILL.md`
- Global: `~/forge/skills/<skill-name>/SKILL.md`

### Format

Plain markdown (no frontmatter). Write it like instructions to a teammate.

```markdown
# Generate Release Notes

1. Run `./scripts/get-commits.sh` to collect commits since the last tag
2. Run `./scripts/categorize.sh` to group them into Features, Bug Fixes, and Breaking Changes
3. Write the release notes in `CHANGELOG.md` using the output from the scripts
4. Run `./scripts/validate-changelog.sh` to confirm the format is correct
```

### Importing from Claude Code

```bash
cp -r .claude/skills .forge/skills    # Works without any changes
```

## Custom Commands

Commands are markdown files with YAML frontmatter in `~/forge/commands/`.
Invoked with `/command_name` syntax in the CLI.

### Format

```markdown
---
name: check
description: Checks if the code is ready to be committed
---
- Run the `lint` and `test` commands and verify if everything is fine.
  <lint>npm run lint</lint>
  <test>npm test</test>
- Fix every issue found in the process
```

### Dynamic Parameters

Commands support `{{parameters}}` (Handlebars) for user-provided arguments:

```markdown
---
name: explain
description: Explain code or concepts in detail
---
Provide a detailed explanation of: {{parameters}}
Include:
- Purpose and functionality
- How it works internally
- Common use cases and examples
```

Usage: `/explain React hooks and their lifecycle`

## .ignore (File Exclusion)

Similar to `.gitignore` — controls which files ForgeCode excludes from context.
Details sparse in documentation.

## Provider Configuration

ForgeCode uses `forge provider login` (interactive) for authentication.
Supports: Anthropic, OpenAI, Google Vertex AI, OpenRouter, x.ai, Cerebras,
Groq, Amazon Bedrock, and any OpenAI-compatible provider.

```bash
forge provider login     # Interactive provider setup
forge provider list      # List supported providers
forge provider logout    # Remove credentials
```

Model selection:

```bash
:model                   # Interactive model picker (in session)
:config-model <id>       # Set default model (persistent)
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `FORGE_LOG` | Logging level (`forge=error`, `forge=debug`, etc.) |
| `FORGE_TRACKER` | Control tracking enrichment in telemetry |
| `FORGE_KEY` | API key for CI/automation |
| `FORGE_HISTORY_FILE` | Custom history file path |
| `FORGE_DUMP_AUTO_OPEN` | Auto-open dump files |
| `FORGE_BIN` | Custom binary path |
| `HTTP_PROXY` / `HTTPS_PROXY` | Proxy configuration |
| `EDITOR` | Editor for `:edit` command |

## Built-in Tools

ForgeCode provides these tools to agents:

| Tool | Description |
|------|-------------|
| `read` | Read files and directories |
| `write` | Create and modify files |
| `patch` | Apply targeted text changes |
| `shell` | Execute shell commands |
| `search` | Search within files |
| `fetch` | Retrieve external resources |
| `remove` | Delete files |
| `undo` | Reverse previous changes |

## Unique / Novel Features

1. **Multi-agent architecture** — Three built-in agents (forge/muse/sage) with custom
   agent definitions. Agents can call other agents as tools (agent-to-agent communication).
   This is more sophisticated than most CLI tools.

2. **Zsh integration** — `:` prefix in shell triggers ForgeCode. Tab completion for
   commands. Native shell experience rather than a separate REPL.

3. **Agent-as-tool** — Agents with `description` field can be invoked as tools by other
   agents, enabling hierarchical agent workflows.

4. **Multi-provider** — Single tool supports 300+ models across all major providers.
   Switch models mid-session without restarting.

5. **ForgeCode Services** — Cloud-backed context engine for large codebases, tool
   corrections for local models, and skills scaling.

6. **AGENTS.md/CLAUDE.md compatibility** — Direct content portability with Claude Code.

7. **Sandbox mode** — `--sandbox <name>` for isolated execution contexts.

## Mapping to agent-manager Concepts

| agent-manager Concept | ForgeCode Equivalent |
|----------------------|---------------------|
| MCP servers | `.mcp.json` (identical format to Claude Code) |
| Instructions/rules | `AGENTS.md` (equiv to `CLAUDE.md`) |
| Skills | `.forge/skills/*/SKILL.md` (identical to Claude Code) |
| Settings | `.forge.toml` (replaces `forge.yaml`) |
| Agent profiles | `.forge/agents/*.md` (YAML frontmatter + markdown) |
| Commands | `~/forge/commands/*.md` (YAML frontmatter + markdown) |
| Ignore patterns | `.ignore` |
| Provider config | `forge provider login` (interactive, stored internally) |

## Key Differences from Claude Code

| Aspect | Claude Code | ForgeCode |
|--------|------------|-----------|
| Rules file | `CLAUDE.md` (hierarchical, merges parent dirs) | `AGENTS.md` (first-found wins, no merge) |
| Config dir | `.claude/` | `.forge/` |
| Global config dir | `~/.claude/` | `~/forge/` |
| MCP config | `.mcp.json` (identical) | `.mcp.json` (identical) |
| Skills | `.claude/skills/*/SKILL.md` | `.forge/skills/*/SKILL.md` (same format) |
| Agents | Subagents via SDK | Rich agent system with frontmatter config |
| Settings | `settings.json` + env vars | `.forge.toml` + `forge.yaml` (legacy) |
| Hooks | `settings.local.json` hooks config | Not documented (no hook system found) |
| Memory | `~/.claude/projects/*/memory/` | Not documented |
| Permissions | Permission modes in settings | System permissions via CLI |
| Provider | Anthropic only (or Bedrock) | 300+ models, multi-provider |

## Sources

- https://forgecode.dev/docs/ (installation, configuration, agents, MCP, skills)
- https://github.com/antinomyhq/forgecode (README, releases)
- https://forgecode.dev/blog/ (release articles, best practices)
- https://forgecode.dev/releases/ (changelog)
