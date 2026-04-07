---
tags: [research/agent-manager, config/formats, tools/ide]
created: 2026-04-07
updated: 2026-04-07
---

# Agent/IDE Configuration Format Survey

> Comprehensive survey of where every major AI coding tool stores its configuration,
> what formats they use, and how scoping works. Critical input for agent-manager's
> sync and normalization strategy.
>
> Cross-references: [[01-existing-mcp-sync-tools]], [[05-toml-profile-configuration-design]]

---

## Table of Contents

1. [Claude Code](#1-claude-code)
2. [Cursor](#2-cursor)
3. [Windsurf (Codeium)](#3-windsurf-codeium)
4. [GitHub Copilot](#4-github-copilot)
5. [Cline](#5-cline)
6. [Roo Code](#6-roo-code)
7. [Continue.dev](#7-continuedev)
8. [Aider](#8-aider)
9. [Amazon Q Developer](#9-amazon-q-developer)
10. [Gemini CLI](#10-gemini-cli)
11. [Unified Comparison Matrix](#11-unified-comparison-matrix)
12. [Normalization Strategy](#12-normalization-strategy)

---

## 1. Claude Code

Claude Code has the most sophisticated configuration hierarchy of any AI coding tool,
with four distinct scopes (Managed > Local > Project > User) and a rich ecosystem of
plugins, skills, agents, hooks, and MCP servers.

### Configuration Files

| File | Location | Format | Scope | Shared? | Purpose |
|------|----------|--------|-------|---------|---------|
| `~/.claude/settings.json` | User home | JSON | User (global) | No | Global settings: model, env vars, hooks, plugins, attribution, sandbox, permissions |
| `.claude/settings.json` | Project root | JSON | Project | Yes (git) | Team-shared settings: permissions, hooks, plugins |
| `.claude/settings.local.json` | Project root | JSON | Local | No (gitignored) | Personal project overrides: permissions, hooks, enabled plugins |
| `~/.claude.json` | User home | JSON | User | No | Preferences, OAuth session, user-scope MCP servers, per-project state, caches |
| `.mcp.json` | Project root | JSON | Project | Yes (git) | Project-scoped MCP server definitions |
| `CLAUDE.md` | Project root | Markdown | Project | Yes (git) | Project instructions (system prompt injection) |
| `.claude/CLAUDE.md` | Project `.claude/` | Markdown | Project | Yes (git) | Alternative project instructions location |
| `~/.claude/CLAUDE.md` | User home | Markdown | User | No | Global instructions across all projects |
| `CLAUDE.local.md` | Project root | Markdown | Local | No (gitignored) | Personal project instructions |
| `managed-settings.json` | System dir | JSON | Managed | Yes (IT) | Enterprise-enforced settings (highest priority) |
| `managed-mcp.json` | System dir | JSON | Managed | Yes (IT) | Enterprise-enforced MCP servers |

**System directories for managed settings:**
- macOS: `/Library/Application Support/ClaudeCode/`
- Linux/WSL: `/etc/claude-code/`
- Windows: `C:\Program Files\ClaudeCode\`

### Directory Structure

```
~/.claude/
├── settings.json          # Global settings
├── settings.local.json    # Global local overrides
├── CLAUDE.md              # Global instructions
├── agents/                # User-scope subagent definitions (.md files)
├── skills/                # User-scope skills (each has SKILL.md)
├── plugins/               # Installed plugins (marketplace + local)
│   ├── installed_plugins.json
│   ├── blocklist.json
│   └── <plugin-name>/
├── plans/                 # Plan files
├── hooks/                 # Hook scripts
├── projects/              # Per-project auto-memory
└── backups/               # Auto-backup of config files

~/.claude.json             # Preferences, OAuth, user MCP servers

<project>/
├── CLAUDE.md              # Project instructions
├── CLAUDE.local.md        # Personal project instructions
├── .mcp.json              # Project MCP servers
└── .claude/
    ├── settings.json      # Team settings
    ├── settings.local.json # Personal project settings
    ├── agents/            # Project-scope subagents
    ├── skills/            # Project-scope skills
    └── commands/          # Slash commands
```

### MCP Server Config Format

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "server-package"],
      "env": { "API_KEY": "value" }
    }
  }
}
```

Both `~/.claude.json` (under `mcpServers` key) and `.mcp.json` use this format.
Per-project MCP overrides in `~/.claude.json` use the `projects` key with the
project path as key.

### Settings JSON Schema

The `settings.json` supports a JSON schema at `https://json.schemastore.org/claude-code-settings.json`.

Key settings categories:
- **`permissions`**: `allow`, `ask`, `deny` arrays with pattern rules
- **`env`**: Environment variables applied to every session
- **`hooks`**: Lifecycle hooks (`UserPromptSubmit`, `PostToolUse`, `Stop`, etc.)
- **`model`**: Model override (e.g., `"opus[1m]"`)
- **`sandbox`**: Filesystem/network isolation settings
- **`attribution`**: Git commit/PR attribution customization
- **`enabledPlugins`**: Plugin enable/disable map
- **`autoMode`**: Auto-permission classifier rules

### Scope Precedence (highest to lowest)

1. **Managed** (cannot be overridden)
2. **Command-line arguments**
3. **Local** (`.claude/settings.local.json`)
4. **Project** (`.claude/settings.json`)
5. **User** (`~/.claude/settings.json`)

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_MODEL` | Override model |
| `ANTHROPIC_SMALL_FAST_MODEL` | Fast/subagent model |
| `CLAUDE_CODE_USE_BEDROCK` | Enable AWS Bedrock |
| `AWS_PROFILE` | AWS credential profile |
| `DISABLE_ERROR_REPORTING` | Privacy control |
| `DISABLE_NON_ESSENTIAL_MODEL_CALLS` | Privacy control |

### Sync/Export Mechanisms

- No built-in sync. Manual git for project-scoped files.
- Plugin marketplace for distributing skills/hooks/agents.
- `managed-settings.d/` drop-in directory for IT fragment deployment.

---

## 2. Cursor

Cursor (VS Code fork) uses `.mdc` rule files with YAML frontmatter, a project MCP
config, and global settings in Cursor's app data directory.

### Configuration Files

| File | Location | Format | Scope | Shared? | Purpose |
|------|----------|--------|-------|---------|---------|
| `.cursor/rules/*.mdc` | Project | Markdown + YAML frontmatter | Project | Yes (git) | Scoped AI rules (always-on, glob, agent-requested, manual) |
| `.cursorrules` | Project root | Plaintext/Markdown | Project | Yes (git) | **Legacy** single-file project instructions (deprecated) |
| `.cursor/mcp.json` | Project root | JSON | Project | Yes (git) | Project-scoped MCP servers |
| `~/.cursor/mcp.json` | User home | JSON | User (global) | No | Global MCP servers |
| Cursor Settings → Rules | App settings | UI/text | User (global) | No | Global user rules |
| Team Rules (dashboard) | Cloud | UI | Team | Yes (cloud) | Enterprise team-wide rules (Team/Enterprise plans) |

### Rule File Format (`.mdc`)

```yaml
---
description: "Database migration patterns using Drizzle ORM"
globs: ["src/api/**/*.ts", "src/routes/**/*.ts"]
alwaysApply: false
---

Rule content in plain markdown here.
```

**Frontmatter fields:**

| Field | Type | Purpose |
|-------|------|---------|
| `alwaysApply` | boolean | Load in every AI request |
| `description` | string | Agent reads to decide relevance |
| `globs` | string[] | File patterns that auto-trigger |

**Four rule types:**
1. **Always Apply**: `alwaysApply: true` — injected into every request
2. **Auto-Attached**: `globs: [...]` — fires when matching files are active
3. **Agent-Requested**: `description: "..."` only — agent self-selects
4. **Manual**: empty frontmatter — only via `@rule-name`

### MCP Config Format

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "package-name"],
      "env": { "KEY": "value" }
    }
  }
}
```

Remote servers use `"url"` and `"headers"` instead of `"command"`/`"args"`.

### Scope Precedence

1. Team Rules (cloud dashboard) — cannot be disabled
2. Project Rules (`.cursor/rules/`)
3. User Rules (Cursor Settings)

### Sync/Export

- Remote Rules: paste a GitHub repo URL in Cursor Settings → auto-syncs
- Project rules are git-committed
- No native config sync between machines

---

## 3. Windsurf (Codeium)

Windsurf uses a dedicated `~/.codeium/` directory for global config and
`.windsurf/rules/` for project-scoped rules with trigger-based activation.

### Configuration Files

| File | Location | Format | Scope | Shared? | Purpose |
|------|----------|--------|-------|---------|---------|
| `~/.codeium/windsurf/mcp_config.json` | User home | JSON | Global | No | MCP server definitions |
| `~/.codeium/windsurf/memories/global_rules.md` | User home | Markdown | Global | No | Always-on global rules (6K char limit) |
| `~/.codeium/windsurf/memories/` | User home | Various | Global | No | Auto-generated memories |
| `.windsurf/rules/*.md` | Project | Markdown + YAML frontmatter | Project | Yes (git) | Workspace rules with trigger modes |
| `.windsurfrules` | Project root | Plaintext | Project | Yes (git) | **Legacy** single-file rules |
| `AGENTS.md` | Project | Markdown | Project | Yes (git) | Cross-tool agent instructions |
| System rules directory | System | Markdown | System (enterprise) | Yes (IT) | Read-only enterprise rules |

**System rules directories:**
- macOS: `/Library/Application Support/Windsurf/rules/*.md`
- Linux/WSL: `/etc/windsurf/rules/*.md`
- Windows: `C:\ProgramData\Windsurf\rules\*.md`

### MCP Config Format

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["package-name"],
      "env": { "KEY": "value" }
    }
  }
}
```

Supports `${env:VARIABLE_NAME}` interpolation in `command`, `args`, `env`, `serverUrl`, `url`, `headers`.

**Tool limit:** Maximum 100 tools across all active MCP servers.

### Workspace Rule Frontmatter

```yaml
---
trigger: glob
globs: "**/*.test.ts"
---

Rule content here.
```

**Trigger modes:**

| Mode | Value | Behavior |
|------|-------|----------|
| Always On | `always_on` | Every system prompt |
| Model Decision | `model_decision` | Description shown; content loaded on demand |
| Glob | `glob` | Matches file patterns via `globs:` |
| Manual | `manual` | Only when `@rule-name` mentioned |

### Enterprise Controls

- Team MCP whitelisting at `windsurf.com/team/settings`
- Regex pattern matching for server IDs
- Case-sensitive server ID matching required

---

## 4. GitHub Copilot

GitHub Copilot spans multiple IDEs with instruction files in `.github/` and MCP
configuration via VS Code's `mcp.json` or Copilot CLI's config.

### Configuration Files

| File | Location | Format | Scope | Shared? | Purpose |
|------|----------|--------|-------|---------|---------|
| `.github/copilot-instructions.md` | Project | Markdown | Project | Yes (git) | Repository-wide custom instructions |
| `.github/instructions/*.instructions.md` | Project | Markdown + YAML frontmatter | Project/Path | Yes (git) | Path-specific instructions with glob patterns |
| `AGENTS.md` | Project (any dir) | Markdown | Project | Yes (git) | Agent instructions (cross-tool) |
| `.vscode/mcp.json` | Project | JSON | Workspace | Yes (git) | VS Code workspace MCP servers |
| User `mcp.json` | VS Code profile | JSON | User | No | User-level MCP servers |
| `~/.copilot/mcp-config.json` | User home | JSON | User (CLI) | No | Copilot CLI MCP servers |
| `.github/prompts/*.prompt.md` | Project | Markdown | Project | Yes (git) | Reusable prompt templates |

**VS Code user MCP config paths:**
- macOS: `~/Library/Application Support/Code/User/mcp.json`
- Windows: `%APPDATA%\Code\User\mcp.json`
- Linux: `~/.config/Code/User/mcp.json`

### Path-Specific Instructions Frontmatter

```yaml
---
applyTo: "**/*.ts,**/*.tsx"
excludeAgent: "code-review"
---

Instructions for TypeScript files.
```

### MCP Config Format (VS Code)

```json
{
  "servers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    },
    "local-server": {
      "command": "npx",
      "args": ["-y", "@some/mcp-server"]
    }
  }
}
```

> **Note:** VS Code uses `"servers"` as the top-level key, NOT `"mcpServers"`.
> Copilot CLI uses `"mcpServers"`.

### Copilot CLI MCP Format

```json
{
  "mcpServers": {
    "server-name": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "package"],
      "tools": ["*"],
      "env": {}
    }
  }
}
```

### Instruction Precedence

1. Personal instructions (user settings)
2. Repository instructions (`.github/copilot-instructions.md`)
3. Organization instructions

### JetBrains Global Instructions

- macOS: `/Users/<USERNAME>/.config/github-copilot/intellij/global-copilot-instructions.md`
- Windows: `C:\Users\<USERNAME>\AppData\Local\github-copilot\intellij\`

---

## 5. Cline

Cline (formerly Claude Dev) is a VS Code extension with a CLI variant. Configuration
lives in VS Code's global storage and a dedicated `~/.cline/` directory for CLI.

### Configuration Files

| File | Location | Format | Scope | Shared? | Purpose |
|------|----------|--------|-------|---------|---------|
| VS Code `cline_mcp_settings.json` | VS Code globalStorage | JSON | Global | No | MCP server config (extension) |
| `~/.cline/data/settings/cline_mcp_settings.json` | User home | JSON | Global (CLI) | No | MCP server config (CLI) |
| `.clinerules/*.md` | Project root | Markdown + optional YAML | Project | Yes (git) | Project rules (scoped via frontmatter) |
| Global rules directory | OS-specific | Markdown/text | Global | No | Always-on global rules |
| `.clineignore` | Project root | Gitignore format | Project | Yes (git) | File exclusion patterns |

**VS Code extension MCP config path:**
- macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Windows: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- Linux: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

**CLI directory structure:**
```
~/.cline/
├── data/
│   ├── globalState.json
│   ├── secrets.json        # API keys (encrypted)
│   ├── settings/
│   │   └── cline_mcp_settings.json
│   ├── workspace/
│   └── tasks/
└── log/
```

**Global rules directories:**
- macOS: `~/Documents/Cline/Rules/`
- Windows: `Documents\Cline\Rules\`
- Linux: `~/Documents/Cline/Rules/` (fallback: `~/Cline/Rules/`)

### MCP Config Format

```json
{
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": { "API_KEY": "value" },
      "alwaysAllow": ["tool1", "tool2"],
      "disabled": false
    }
  }
}
```

### Rule File Frontmatter (conditional scoping)

```yaml
---
paths:
  - "src/components/**"
  - "**/*.test.ts"
---

Rules scoped to matching files.
```

### Cross-Tool Rule Detection

Cline auto-detects and reads:
- `.cursorrules` (Cursor)
- `.windsurfrules` (Windsurf)
- `AGENTS.md` (cross-tool standard)

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLINE_DIR` | Override config directory |
| `CLINE_COMMAND_PERMISSIONS` | JSON with `allow`/`deny` globs |

---

## 6. Roo Code

Roo Code (VS Code extension, fork of Cline) adds a `.roo/` directory for
project-scoped config and supports custom modes with tool-group restrictions.

### Configuration Files

| File | Location | Format | Scope | Shared? | Purpose |
|------|----------|--------|-------|---------|---------|
| `mcp_settings.json` | VS Code settings | JSON | Global | No | Global MCP servers |
| `.roo/mcp.json` | Project root | JSON | Project | Yes (git) | Project MCP servers |
| `.roomodes` | Project root | YAML or JSON | Project | Yes (git) | Custom mode definitions |
| `settings/custom_modes.yaml` | App settings | YAML (preferred) | Global | No | Global custom modes |
| `settings/custom_modes.json` | App settings | JSON (legacy) | Global | No | Global custom modes (deprecated) |
| `.roo/rules-{slug}/*.md` | Project | Markdown/text | Project | Yes (git) | Mode-specific rules |
| `~/.roo/rules-{slug}/` | User home | Markdown/text | Global | No | Global mode-specific rules |
| `.roo/rules/` | Project | Markdown/text | Project | Yes (git) | Shared rules (all modes) |
| `.roorules-{mode-slug}` | Project root | Text | Project | Yes (git) | Fallback single-file rules |
| `.clinerules-{mode-slug}` | Project root | Text | Project | Yes (git) | Legacy backward compat |

### `.roomodes` Format (YAML)

```yaml
customModes:
  - slug: docs-writer
    name: "Documentation Writer"
    description: Short UI summary
    roleDefinition: Detailed role identity text
    whenToUse: Guidance for orchestration
    customInstructions: Behavioral guidelines
    groups:
      - read
      - - edit
        - fileRegex: \.(md|mdx)$
          description: Markdown files only
```

### MCP Config Format

Same `"mcpServers"` format as Cline. Project config in `.roo/mcp.json` takes
precedence over global `mcp_settings.json`.

### Custom Mode Properties

| Property | Purpose |
|----------|---------|
| `slug` | Unique ID (pattern: `/^[a-zA-Z0-9-]+$/`) |
| `name` | Display name |
| `roleDefinition` | Injected at start of system prompt |
| `groups` | Tool access: `read`, `edit`, `command`, `mcp` |
| `customInstructions` | Appended near end of system prompt |

### Precedence

1. Project `.roomodes`
2. Global `custom_modes.yaml` (then `.json`)
3. Built-in default modes

---

## 7. Continue.dev

Continue uses `config.yaml` (replacing deprecated `config.json`) with MCP support,
rules, prompts, context providers, and model configuration.

### Configuration Files

| File | Location | Format | Scope | Shared? | Purpose |
|------|----------|--------|-------|---------|---------|
| `~/.continue/config.yaml` | User home | YAML | Global | No | Primary config: models, MCP, rules, context, docs |
| `~/.continue/config.json` | User home | JSON | Global | No | **Deprecated** legacy config |
| Rules files | Local or remote | Markdown + frontmatter | Per-rule | Varies | System message rules |
| Prompt files | Local or remote | Markdown + frontmatter | Per-prompt | Varies | Slash-command prompts |

### Config Format

```yaml
name: my-config
version: "1.0"
schema: v1

models:
  - name: claude-sonnet
    provider: anthropic
    model: claude-sonnet-4-6
    roles: [chat, edit, apply]
    capabilities: [tool_use]
    defaultCompletionOptions:
      temperature: 0.7
      maxTokens: 4096

mcpServers:
  - name: My Server
    command: uvx
    args: [mcp-server-sqlite, --db-path, ./test.db]
    cwd: /path/to/project
    env:
      NODE_ENV: production

context:
  - provider: file
  - provider: code
  - provider: diff

rules:
  - uses: org/ruleset-name
  - uses: file://path/to/rules.md

prompts:
  - uses: org/prompt-name
  - uses: file://path/to/prompts.md

docs:
  - name: Continue
    startUrl: https://docs.continue.dev/intro
```

### Key Features

- **YAML anchors** for deduplication (`&anchor` / `<<: *anchor`)
- **Continue Hub** for remote config sharing (`uses: org/config-name`)
- **Role-based models**: `chat`, `autocomplete`, `embed`, `rerank`, `edit`, `apply`, `summarize`

---

## 8. Aider

Aider uses a YAML config file with a simple cascading load order and `.env`
files for API keys.

### Configuration Files

| File | Location | Format | Scope | Shared? | Purpose |
|------|----------|--------|-------|---------|---------|
| `~/.aider.conf.yml` | User home | YAML | Global | No | Global settings |
| `<git-root>/.aider.conf.yml` | Git root | YAML | Project | Yes (git) | Project settings |
| `.aider.conf.yml` | CWD | YAML | Local | No | Directory-level overrides |
| `.env` | Git root | Dotenv | Project | Yes (git) | API keys and env vars |
| `.aider.input.history` | CWD | Text | Local | No | Input history |
| `.aider.chat.history.md` | CWD | Markdown | Local | No | Chat history |

### Config Format

```yaml
# Model config
model: claude-sonnet-4-6
weak-model: claude-haiku-4-5
editor-model: claude-sonnet-4-6
architect: false

# API keys (only OpenAI/Anthropic in YAML; others in .env)
anthropic-api-key: sk-ant-xxx

# Git behavior
git: true
auto-commits: true
dirty-commits: true
attribute-co-authored-by: true

# Linting
auto-lint: true
lint-cmd:
  - "python: flake8 --select=..."

# Repo map
map-tokens: 1024
map-refresh: auto

# Environment
set-env:
  - VAR=value
env-file: .env
```

### Load Order (last wins)

1. `~/.aider.conf.yml` (home)
2. `<git-root>/.aider.conf.yml`
3. `.aider.conf.yml` (CWD)
4. `--config <file>` flag

### MCP Support

Aider does **not** support MCP servers. It uses direct LLM API calls with
LiteLLM as the backend for multi-provider support.

---

## 9. Amazon Q Developer

Amazon Q Developer supports both IDE and CLI contexts with MCP configuration
in `.amazonq/` directories and project rules.

### Configuration Files

| File | Location | Format | Scope | Shared? | Purpose |
|------|----------|--------|-------|---------|---------|
| `~/.aws/amazonq/default.json` | User home | JSON | Global | No | Primary global config (GUI-managed) |
| `.amazonq/default.json` | Project root | JSON | Project | Yes (git) | Project-level config |
| `~/.aws/amazonq/mcp.json` | User home | JSON | Global | No | **Legacy** global MCP config |
| `.amazonq/mcp.json` | Project root | JSON | Project | Yes (git) | **Legacy** project MCP config |
| `.amazonq/rules/*.md` | Project root | Markdown | Project | Yes (git) | Project rules / custom instructions |

### MCP Config Format

```json
{
  "mcpServers": {
    "server-name": {
      "command": "uvx",
      "args": ["awslabs.aws-documentation-mcp-server@latest"],
      "env": { "FASTMCP_LOG_LEVEL": "ERROR" },
      "timeout": 60
    }
  }
}
```

HTTP servers use `"url"` and `"headers"` instead of `"command"`/`"args"`.

### Legacy Support

Legacy `mcp.json` files controlled by `useLegacyMcpJson` field in `default.json`:
```json
{
  "useLegacyMcpJson": true
}
```

### Project Rules

Plain markdown files in `.amazonq/rules/` — no special syntax required.
Auto-applied as context for all chat sessions within the project.
Toggleable per session via the Rules button in the Q chat panel.

### Scoping

Workspace-level configs take precedence over global configs for MCP servers,
permissions, and stored settings.

---

## 10. Gemini CLI

Gemini CLI has a comprehensive configuration system with 7 layers of precedence,
GEMINI.md context files, and full MCP support.

### Configuration Files

| File | Location | Format | Scope | Shared? | Purpose |
|------|----------|--------|-------|---------|---------|
| `~/.gemini/settings.json` | User home | JSON | User | No | Global settings |
| `.gemini/settings.json` | Project root | JSON | Project | Yes (git) | Project settings |
| System defaults | OS-specific | JSON | System (base) | Yes (IT) | Lowest-priority defaults |
| System overrides | OS-specific | JSON | System (override) | Yes (IT) | Highest-priority enterprise settings |
| `GEMINI.md` | Project (hierarchical) | Markdown | Project | Yes (git) | Context instructions (traverses upward to `.git`) |
| `.gemini/.env` | Project | Dotenv | Project | Yes (git) | Project environment variables |
| `~/.env` | User home | Dotenv | User | No | User environment variables |
| `.gemini/system.md` | Project | Markdown | Project | Yes | System prompt override (when `GEMINI_SYSTEM_MD` set) |

**System paths:**

| Type | macOS | Linux | Windows |
|------|-------|-------|---------|
| Defaults | `/Library/Application Support/GeminiCli/system-defaults.json` | `/etc/gemini-cli/system-defaults.json` | `C:\ProgramData\gemini-cli\system-defaults.json` |
| Overrides | `/Library/Application Support/GeminiCli/settings.json` | `/etc/gemini-cli/settings.json` | `C:\ProgramData\gemini-cli\settings.json` |

### Settings Format

```json
{
  "general": {
    "vimMode": true,
    "defaultApprovalMode": "default",
    "checkpointing": { "enabled": false },
    "maxAttempts": 10
  },
  "model": {
    "name": "gemini-2.5-pro",
    "maxSessionTurns": -1,
    "compressionThreshold": 0.5
  },
  "context": {
    "fileName": ["GEMINI.md", "CONTEXT.md"],
    "includeDirectoryTree": true,
    "memoryBoundaryMarkers": [".git"],
    "includeDirectories": ["path/to/dir"]
  },
  "tools": {
    "sandbox": "docker",
    "allowed": ["shell", "read_file"],
    "exclude": ["write_file"]
  },
  "mcpServers": {
    "server-name": {
      "command": "bin/mcp_server.py",
      "args": [],
      "env": {},
      "timeout": 30000,
      "trust": false,
      "includeTools": ["tool1"],
      "excludeTools": ["tool2"]
    }
  },
  "hooks": {},
  "security": {
    "toolSandboxing": false,
    "disableYoloMode": false,
    "enableConseca": false
  },
  "admin": {
    "secureModeEnabled": false,
    "mcp": {
      "enabled": true,
      "config": {},
      "requiredConfig": {}
    }
  }
}
```

### Precedence (highest to lowest)

1. Command-line arguments
2. Environment variables / `.env` files
3. System override settings
4. Project `settings.json`
5. User `settings.json`
6. System defaults
7. Hardcoded defaults

### GEMINI.md Discovery

- Traverses upward from CWD, loading every `GEMINI.md` found
- Stops at boundaries defined by `context.memoryBoundaryMarkers` (default: `.git`)
- Configurable filename via `context.fileName` (accepts string or array)

### Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `GEMINI_API_KEY` | Gemini API key |
| `GEMINI_MODEL` | Default model override |
| `GEMINI_SANDBOX` | Sandbox mode |
| `GEMINI_SYSTEM_MD` | System prompt override |
| `GEMINI_CLI_HOME` | Root config directory |

### JSON Schema

Available at: `https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json`

---

## 11. Unified Comparison Matrix

### MCP Server Configuration

| Tool | Global Path | Project Path | Format | Top-Level Key | Env Interpolation |
|------|-------------|-------------|--------|---------------|-------------------|
| **Claude Code** | `~/.claude.json` | `.mcp.json` | JSON | `mcpServers` | No |
| **Cursor** | `~/.cursor/mcp.json` | `.cursor/mcp.json` | JSON | `mcpServers` | No |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | N/A | JSON | `mcpServers` | `${env:VAR}` |
| **Copilot (VS Code)** | `~/Library/.../Code/User/mcp.json` | `.vscode/mcp.json` | JSON | `servers` | Input vars |
| **Copilot CLI** | `~/.copilot/mcp-config.json` | N/A (proposed) | JSON | `mcpServers` | No |
| **Cline (ext)** | `globalStorage/.../cline_mcp_settings.json` | N/A | JSON | `mcpServers` | No |
| **Cline (CLI)** | `~/.cline/data/settings/cline_mcp_settings.json` | N/A | JSON | `mcpServers` | No |
| **Roo Code** | `mcp_settings.json` (VS Code) | `.roo/mcp.json` | JSON | `mcpServers` | `${env:VAR}` |
| **Continue** | `~/.continue/config.yaml` | N/A | YAML | `mcpServers` (list) | No |
| **Aider** | N/A | N/A | N/A | N/A | N/A |
| **Amazon Q** | `~/.aws/amazonq/default.json` | `.amazonq/default.json` | JSON | `mcpServers` | No |
| **Gemini CLI** | `~/.gemini/settings.json` | `.gemini/settings.json` | JSON | `mcpServers` | `$VAR`, `${VAR:-default}` |

### Instructions / Rules

| Tool | Global | Project | Format | Scoping Mechanism |
|------|--------|---------|--------|-------------------|
| **Claude Code** | `~/.claude/CLAUDE.md` | `CLAUDE.md` | Markdown | Scope hierarchy (managed > local > project > user) |
| **Cursor** | Settings UI | `.cursor/rules/*.mdc` | MD + YAML frontmatter | `alwaysApply`, `globs`, `description` |
| **Windsurf** | `~/.codeium/.../global_rules.md` | `.windsurf/rules/*.md` | MD + YAML frontmatter | `trigger`: always_on, model_decision, glob, manual |
| **Copilot** | IDE-specific | `.github/copilot-instructions.md` | Markdown | `applyTo` glob, `excludeAgent` |
| **Cline** | `~/Documents/Cline/Rules/` | `.clinerules/*.md` | MD + optional YAML | `paths` glob array |
| **Roo Code** | `~/.roo/rules-{slug}/` | `.roo/rules-{slug}/` | Markdown/text | Mode slug + file sorting |
| **Continue** | `~/.continue/config.yaml` | Rules via `uses:` | YAML + Markdown | Continue Hub references |
| **Aider** | N/A | N/A | N/A | N/A |
| **Amazon Q** | N/A | `.amazonq/rules/*.md` | Markdown | Auto-applied, toggleable per session |
| **Gemini CLI** | N/A | `GEMINI.md` | Markdown | Hierarchical traversal to `.git` boundary |

### Cross-Tool Instruction Files

| File | Recognized By |
|------|---------------|
| `AGENTS.md` | Copilot, Windsurf, Cline |
| `CLAUDE.md` | Claude Code, Copilot |
| `GEMINI.md` | Gemini CLI |
| `.cursorrules` | Cursor, Cline |
| `.windsurfrules` | Windsurf, Cline |

### Model Configuration

| Tool | Config Location | Format | Multi-Provider |
|------|----------------|--------|----------------|
| **Claude Code** | `settings.json` `model` key + env vars | JSON | Yes (Anthropic, Bedrock, Vertex, Foundry) |
| **Cursor** | Settings UI + API keys | UI | Yes (Anthropic, OpenAI, Google, custom) |
| **Windsurf** | Settings UI | UI | Yes (via Codeium) |
| **Copilot** | Settings UI | UI | Limited (GitHub backend) |
| **Cline** | Settings UI + `globalState.json` | JSON | Yes (Anthropic, OpenAI, Bedrock, Ollama, LM Studio) |
| **Roo Code** | Settings UI | UI/JSON | Yes (same as Cline) |
| **Continue** | `config.yaml` `models` key | YAML | Yes (any LiteLLM-supported provider) |
| **Aider** | `.aider.conf.yml` `model` key | YAML | Yes (LiteLLM backend) |
| **Amazon Q** | AWS credentials | AWS | No (AWS-only) |
| **Gemini CLI** | `settings.json` `model.name` + env vars | JSON | Limited (Gemini, Vertex AI, Code Assist) |

### Hooks / Lifecycle Events

| Tool | Hooks Support | Config Location | Events |
|------|--------------|-----------------|--------|
| **Claude Code** | Yes | `settings.json` `hooks` key | `UserPromptSubmit`, `PostToolUse`, `Stop`, `Notification`, `SubagentStop` |
| **Cursor** | No | N/A | N/A |
| **Windsurf** | No | N/A | N/A |
| **Copilot** | No | N/A | N/A |
| **Cline** | Yes | Customization settings | Pre/post tool execution |
| **Roo Code** | No | N/A | N/A |
| **Continue** | No | N/A | N/A |
| **Aider** | No | N/A | N/A |
| **Amazon Q** | No | N/A | N/A |
| **Gemini CLI** | Yes | `settings.json` `hooks` key | `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `SessionStart`, `SessionEnd`, `BeforeModel`, `AfterModel`, `Notification`, `PreCompress`, `BeforeToolSelection` |

---

## 12. Normalization Strategy

### The Problem

Every tool uses a slightly different:
1. **File path** for the same concept (MCP servers, instructions, models)
2. **Format** (JSON vs YAML vs Markdown with various frontmatter schemas)
3. **Schema** (top-level key `mcpServers` vs `servers`, list vs object)
4. **Scoping model** (user/project/managed vs global/workspace vs flat)

### Proposed Universal Config Model

agent-manager needs a **canonical internal representation** that maps bidirectionally
to each tool's native format. See [[05-toml-profile-configuration-design]] for the
TOML profile format design.

#### Config Categories to Normalize

| Category | What It Contains | Tools That Support It |
|----------|-----------------|----------------------|
| **MCP Servers** | Server name, command, args, env, transport | All except Aider |
| **Instructions** | System prompt text, scoping rules | All |
| **Model Config** | Provider, model ID, API keys, options | All |
| **Permissions** | Allow/deny rules, tool restrictions | Claude Code, Cline, Gemini CLI |
| **Hooks** | Lifecycle event handlers | Claude Code, Cline, Gemini CLI |
| **Plugins/Skills** | Extended capabilities | Claude Code |

#### MCP Server Normalization

The core MCP server definition is nearly identical across all tools:

```toml
# agent-manager canonical format
[mcp.servers.my-server]
command = "npx"
args = ["-y", "server-package"]
env = { API_KEY = "$SECRET_API_KEY" }
transport = "stdio"  # stdio | http | sse
```

**Mapping to native formats:**

| Field | Claude Code | Cursor | Windsurf | Copilot VS Code | Gemini CLI |
|-------|-------------|--------|----------|-----------------|------------|
| Wrapper key | `mcpServers` | `mcpServers` | `mcpServers` | `servers` | `mcpServers` |
| `command` | `command` | `command` | `command` | `command` | `command` |
| `args` | `args` | `args` | `args` | `args` | `args` |
| `env` | `env` | `env` | `env` | (input vars) | `env` |
| `url` (http) | N/A | `url` | `serverUrl`/`url` | `url` | `httpUrl`/`url` |
| `headers` | N/A | `headers` | `headers` | (varies) | `headers` |
| `timeout` | N/A | N/A | N/A | N/A | `timeout` |
| `disabled` | N/A | N/A | N/A | N/A | N/A |
| `trust` | N/A | N/A | N/A | N/A | `trust` |

#### Instructions Normalization

Instructions are the hardest to normalize because:
- Claude Code uses plain Markdown files with no frontmatter
- Cursor uses `.mdc` with `alwaysApply`/`globs`/`description` frontmatter
- Windsurf uses `.md` with `trigger`/`globs` frontmatter
- Copilot uses `.instructions.md` with `applyTo`/`excludeAgent` frontmatter
- Cline uses `.md` with `paths` frontmatter
- Gemini uses `GEMINI.md` with hierarchical discovery

**Proposed approach:** Store instructions as Markdown with a superset frontmatter
schema. Generate tool-specific files during sync:

```yaml
---
# agent-manager universal frontmatter
name: typescript-conventions
scope: glob                    # always | glob | agent-decision | manual
globs: ["**/*.ts", "**/*.tsx"]
description: "TypeScript coding conventions"
targets: [claude, cursor, windsurf, copilot]  # which tools to sync to
---

Instruction content here.
```

#### Sync Operations

For each tool, agent-manager needs:

1. **Read** — parse native config → canonical model
2. **Write** — canonical model → native config files
3. **Diff** — detect changes between canonical and native
4. **Merge** — resolve conflicts when both have changed

See [[01-existing-mcp-sync-tools]] for existing approaches to MCP sync
(mcpm, mcp-get, mcp-manager) and their limitations that agent-manager addresses.

### Implementation Priority

Based on ecosystem prevalence and config complexity:

1. **P0 (launch):** Claude Code, Cursor, Windsurf — highest adoption, most config surface
2. **P1 (fast-follow):** Copilot (VS Code), Cline, Roo Code — VS Code ecosystem
3. **P2 (later):** Gemini CLI, Continue, Amazon Q — growing but smaller user base
4. **P3 (if requested):** Aider — minimal config surface, no MCP

### Key Design Decisions for agent-manager

1. **MCP is the universal entry point** — every tool except Aider supports `mcpServers`
   with nearly identical schemas. Start here.

2. **Instructions require per-tool generation** — no single file format works everywhere.
   Store canonically, render to each tool's format.

3. **Secrets must stay out of git** — use environment variable references in canonical
   config, resolve at sync time from a secure store.

4. **VS Code tools share storage quirks** — Cline, Roo Code, and Copilot all store
   MCP config in VS Code's globalStorage or profile directories, not user-writable
   dotfiles. agent-manager needs to handle these platform-specific paths.

5. **The `servers` vs `mcpServers` split is the biggest gotcha** — VS Code uses
   `servers`, everyone else uses `mcpServers`. Must map correctly.
