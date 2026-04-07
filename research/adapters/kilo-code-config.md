# Kilo Code - Configuration Research for Agent Manager Adapter

**Researched:** 2026-04-07
**Sources:** kilo.ai docs, blog.kilo.ai, GitHub Kilo-Org/kilocode, VS Code Marketplace, tessl.io interview

---

## 1. What Is Kilo Code?

Kilo Code is an **open-source AI coding agent** (MIT license) available as a VS Code extension, JetBrains plugin, and standalone CLI. It supports 500+ AI models via its "Kilo Gateway" or direct provider API keys.

- **Company:** Kilo Code, Inc. (~30 people, Amsterdam + San Francisco)
- **CEO:** Scott Breitenother (since Sep 2025; founder Jan Paul Posma)
- **Funding:** $8M seed round
- **GitHub:** `Kilo-Org/kilocode` (17.5k stars, 2.3k forks, 901 contributors)
- **Marketplace:** 943k+ installs on VS Code Marketplace
- **Current version:** v7.1.x (as of Apr 2026)

## 2. Relationship to Cline and Roo Code

Kilo Code is a **fork of a fork**:

```
Cline (original) --> Roo Code (fork of Cline) --> Kilo Code (fork of Roo Code)
```

- **March 2025:** Kilo Code launched by forking Roo Code
- Kilo positions itself as a **"superset of both Cline and Roo Code"** — it merges features from both upstream projects plus its own additions
- Kilo continues to merge changes from both Roo Code and Cline
- All three are open source (Cline: Apache 2.0, Roo Code: Apache 2.0, Kilo: MIT)

**April 2026 rebuild:** Kilo completely rebuilt its VS Code extension on "OpenCode server" — an MIT-licensed portable core. The CLI and VS Code extension now share the same engine. This is a significant architectural departure from the original Cline/Roo codebase.

## 3. Config File Locations

Kilo Code has gone through config format evolution. The **current** system (v7.x / Kilo CLI 1.0) uses JSONC config files:

### Current Config System (Kilo CLI 1.0 / New VS Code Extension)

| Scope | Primary Path | Alternatives |
|-------|-------------|-------------|
| Global | `~/.config/kilo/kilo.jsonc` | `kilo.json`, `config.json`, `opencode.json`, `opencode.jsonc` |
| Project | `./kilo.jsonc` | `./.kilo/kilo.jsonc` (takes priority if both exist) |

**Note:** The CLI merges `config.json`, `opencode.json`, and `opencode.jsonc` from `~/.config/kilo/`. The "opencode" naming comes from the OpenCode server foundation.

### Legacy Config System (VS Code Extension < v7.x)

| Scope | Path | Format |
|-------|------|--------|
| Global MCP | `~/.config/kilo/mcp_settings.json` (via "Edit Global MCP") | JSON |
| Project MCP | `.kilocode/mcp.json` | JSON |
| VS Code settings | VS Code `settings.json` with `kilocode.*` keys | JSON |

### Detection Strategy for Agent Manager

To detect Kilo Code, check for:
1. `kilo.jsonc` or `.kilo/kilo.jsonc` in project root (new system)
2. `.kilocode/` directory in project root (legacy system)
3. `~/.config/kilo/` directory (global config)
4. CLI binary: `kilo` command in PATH

## 4. MCP Server Configuration

Kilo supports **two config formats** for MCP servers — a new CLI-native format and the legacy Cline/Roo-compatible format.

### Format A: New CLI-Native Format (kilo.jsonc)

MCP servers go under the `mcp` key:

```jsonc
{
  "mcp": {
    "my-local-server": {
      "type": "local",
      "command": ["node", "/path/to/server.js"],
      "environment": {
        "API_KEY": "your_api_key"
      },
      "enabled": true,
      "timeout": 10000
    },
    "my-remote-server": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer your-token"
      },
      "enabled": true,
      "timeout": 15000
    }
  }
}
```

**Key fields (new format):**
- `type`: `"local"` (stdio) or `"remote"` (HTTP/SSE)
- `command`: Array of command + args (for local)
- `url`: Endpoint URL (for remote)
- `environment`: Env vars (note: `environment` not `env`)
- `headers`: HTTP headers (for remote)
- `enabled`: Boolean toggle (default: true)
- `timeout`: Milliseconds (default: 60000)
- `oauth`: Boolean, can disable OAuth with `false` (for remote)

### Format B: Legacy Cline/Roo-Compatible Format

Also supported, using `mcpServers` key:

```json
{
  "mcpServers": {
    "server1": {
      "command": "python",
      "args": ["/path/to/server.py"],
      "env": {
        "API_KEY": "your_api_key"
      },
      "alwaysAllow": ["tool1", "tool2"],
      "disabled": false
    }
  }
}
```

**Key fields (legacy format):**
- `command`: String (single command)
- `args`: Array of arguments (separate from command)
- `env`: Env vars (note: `env` not `environment`)
- `alwaysAllow`: Array of tool names to auto-approve
- `disabled`: Boolean (inverted from `enabled`)
- `timeout`: Number in seconds (not ms in some contexts)

### Environment Variable References

Both formats support `{env:VARIABLE_NAME}` syntax:

```jsonc
{
  "mcp": {
    "my-server": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer {env:MY_API_KEY}"
      }
    }
  }
}
```

### MCP CLI Commands

```bash
kilo mcp list          # List all configured MCP servers
kilo mcp add           # Add an MCP server
kilo mcp auth          # Authenticate with an MCP server
```

Inside TUI: `/mcps` slash command toggles servers on/off.

## 5. Instructions / Rules System

Kilo has a **layered instructions system** with multiple mechanisms (priority order, highest first):

### Priority Hierarchy

| Priority | Feature | Scope | Location |
|----------|---------|-------|----------|
| 1 (highest) | Mode-specific Custom Rules | Project | `.kilocode/rules-{mode}/` |
| 2 | Custom Rules | Project | `.kilocode/rules/` |
| 3 | AGENTS.md | Project | `AGENTS.md` at project root |
| 4 | Global Custom Rules | Global | `~/.kilocode/rules/` |
| 5 (lowest) | Custom Instructions | Global | IDE settings / config |

### Custom Rules

Markdown files in `.kilocode/rules/` directory:

```
.kilocode/
  rules/
    react-conventions.md
    testing-standards.md
    restricted-files.md
  rules-code/          # Only loaded in "code" mode
    code-specific.md
  rules-architect/     # Only loaded in "architect" mode
    arch-specific.md
```

**Legacy compatibility:** Also reads `.kilocoderules`, `.roorules`, `.clinerules` files.

### AGENTS.md

Standard markdown file at project root. Kilo supports:
- `AGENTS.md` (primary, recommended)
- `AGENT.md` (fallback)
- `CLAUDE.md` (compatibility)
- `CONTEXT.md` (additional context)

Per-directory `AGENTS.md` files are also supported (loaded dynamically when agent reads files in that directory).

### Custom Instructions via Config

The `instructions` key in `kilo.jsonc` accepts paths, globs, or URLs:

```jsonc
{
  "instructions": [
    "./docs/coding-standards.md",
    "./teams/frontend-rules.md",
    "https://example.com/team-rules.md"
  ]
}
```

URL-based sources are fetched at session start with 5s timeout; silently skipped if unreachable.

### Global Instructions

- `~/.config/kilo/AGENTS.md`
- `~/.claude/CLAUDE.md` (compatibility)

### Per-Agent Prompts

Each agent/mode can have its own custom prompt in `kilo.jsonc`:

```jsonc
{
  "agent": {
    "code": {
      "prompt": "Your custom instructions for the code agent..."
    }
  }
}
```

## 6. Agents / Modes System

Kilo has evolved from "modes" (Cline/Roo heritage) to "agents":

### Built-in Agents

- **Code** — Writing code, implementing features
- **Architect** — Planning, system design (can create markdown plans)
- **Debug** — Finding and fixing errors
- **Orchestrator** — Breaking large tasks into subtasks, delegating to other agents
- **Ask** — Q&A about codebase (read-only)

### Custom Agents via Config (kilo.jsonc)

```jsonc
{
  "agent": {
    "code-reviewer": {
      "description": "Reviews code for best practices",
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-20250514",
      "prompt": "You are a code reviewer...",
      "permission": {
        "edit": "deny",
        "bash": "deny"
      }
    }
  }
}
```

### Custom Agents via Markdown Files

Place `.md` files in:
- Global: `~/.config/kilo/agents/<name>.md`
- Project: `.kilo/agents/<name>.md`

### Agent Precedence

1. Built-in agent defaults
2. Global config (`~/.config/kilo/config.json`)
3. Project config (`kilo.jsonc`)
4. Global agent markdown (`~/.config/kilo/agents/`)
5. Project agent markdown (`.kilo/agents/`)

### Agent CLI Commands

```bash
kilo agent list            # List all agents
kilo agent create          # Interactive agent creation
kilo agent create \
  --path .kilo \
  --description "..." \
  --mode subagent \
  --tools "read,grep,glob"
```

## 7. Skills System

Kilo implements the **Agent Skills** open standard (SKILL.md):

### Skill Directory Structure

```
my-skill/
  SKILL.md        # Required - YAML frontmatter + markdown instructions
  scripts/        # Optional executable code
  references/     # Optional documentation
  assets/         # Optional templates
```

### SKILL.md Format

```markdown
---
name: my-skill-name
description: A brief description of what this skill does
---

# Instructions

Your detailed instructions here...
```

### Skill Locations

| Scope | Path | Notes |
|-------|------|-------|
| Global | `~/.kilocode/skills/` | All projects |
| Project | `.kilocode/skills/` | This project only |
| Mode-specific | `.kilocode/skills-code/`, `.kilocode/skills-architect/` | Per-mode |

Skills are **lazy-loaded**: only metadata (name + description) is read at startup. Full SKILL.md is loaded on-demand when a task matches.

## 8. Permissions System

```jsonc
{
  "permission": {
    "read": "allow",
    "edit": "ask",
    "bash": "ask",
    "mcp": "ask",
    "external_directory": {
      "~/projects/personal/": "allow"
    }
  }
}
```

Values: `"allow"`, `"ask"`, `"deny"`

## 9. Other Notable Config Keys

```jsonc
{
  "$schema": "https://kilo.ai/schema/kilo.json",
  "model": "anthropic/claude-sonnet-4-20250514",
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      },
      "models": { /* custom model definitions */ }
    }
  },
  "mcp": { /* MCP servers */ },
  "agent": { /* agent/mode definitions */ },
  "permission": { /* tool permissions */ },
  "instructions": ["./CONTRIBUTING.md"],
  "formatter": { /* code formatter config */ },
  "disabled_providers": [],
  "enabled_providers": [],
  "experimental": {
    "codebase_search": true,
    "batch_tool": false,
    "mcp_timeout": 30000
  }
}
```

## 10. Unique / Notable Features

1. **Parallel tool calls + subagent delegation** — Agent can execute multiple actions concurrently
2. **Agent Manager** — Built-in orchestration of multiple live agent sessions with git worktree isolation
3. **Cross-platform session continuity** — Start in CLI, continue in VS Code, share via Slack
4. **Multi-model comparison** — Run different LLMs on the same prompt side-by-side
5. **Inline code review** — Comment inline on diffs, feed structured feedback
6. **MCP Marketplace** — Built-in marketplace for discovering/installing MCP servers
7. **Workflows** — Repeatable prompt templates as `.md` files
8. **Kilo Gateway** — Proprietary model gateway with 500+ models, transparent pricing
9. **Autocomplete** — FIM-based with Codestral, status bar cost tracking
10. **`.kilocodeignore`** — Like `.gitignore` for excluding files from AI context
11. **Codebase indexing** — Semantic index for better context awareness
12. **Context condensing** — Summarize older context to stay within limits

## 11. Adapter Implementation Notes for Agent Manager

### Key Considerations

1. **Dual config format:** Must handle both `mcp` (new) and `mcpServers` (legacy) keys
2. **JSONC support:** Config files use `.jsonc` (JSON with comments) — need a JSONC parser
3. **Multiple config locations:** Global config has several possible filenames (`kilo.jsonc`, `config.json`, `opencode.json`, `opencode.jsonc`)
4. **Project config options:** `./kilo.jsonc` OR `./.kilo/kilo.jsonc` (latter takes priority)
5. **Env var syntax:** Uses `{env:VAR_NAME}` (not `$VAR_NAME` or `${VAR_NAME}`)
6. **Field naming differences:** `environment` vs `env`, `enabled` vs `disabled` (inverted), `command` as array vs string+args

### Mapping to Agent Manager Schema

| Agent Manager Field | Kilo New Format | Kilo Legacy Format |
|--------------------|-----------------|--------------------|
| server name | key under `mcp` | key under `mcpServers` |
| command | `command[0]` | `command` |
| args | `command[1..]` | `args` |
| env vars | `environment` | `env` |
| enabled | `enabled` (true=on) | `!disabled` (false=on) |
| auto-approve tools | (not in new format) | `alwaysAllow` |
| timeout | `timeout` (ms) | `timeout` (varies) |
| transport type | `type: "local"/"remote"` | implied by presence of `command` vs `url` |

### Recommended Detection Order

1. Check for `kilo` CLI in PATH
2. Check for `.kilo/kilo.jsonc` in project root
3. Check for `kilo.jsonc` in project root
4. Check for `.kilocode/` directory (legacy)
5. Check for `~/.config/kilo/` directory (global)
