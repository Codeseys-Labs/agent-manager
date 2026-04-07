# agent-manager Design Specification

> **Version:** 0.1.0-draft
> **Date:** 2026-04-07
> **Status:** Approved for implementation
>
> chezmoi for AI agent configs — define your MCP servers, skills, and instructions
> once in TOML, sync via git, and generate native configs for every AI coding tool.

---

## 1. Problem Statement

Every AI coding tool stores configuration differently. MCP server definitions live
in `~/.claude.json`, `.mcp.json`, `~/.cursor/mcp.json`, `.vscode/mcp.json`, and a
dozen other locations. Instructions live in `CLAUDE.md`, `.cursor/rules/*.mdc`,
`.github/copilot-instructions.md`, `GEMINI.md`, and more.

Developers who use multiple AI tools — or even a single tool across multiple
machines — face a fragmented, manual, error-prone configuration experience.

**agent-manager (`am`)** solves this by providing a single TOML source of truth
that generates native configs for all tools, syncs across machines via git, and
supports profile-based subsets for context switching.

### Target Users

- **Multi-tool developers** — consistent MCP configs across Claude Code + Cursor + Copilot
- **Multi-machine developers** — configs follow them across laptop, desktop, cloud
- **Team leads** — define standard servers/instructions distributable via git
- **Power users** — 20+ MCP servers, need profiles to switch contexts
- **AI agents** — programmatic config management via MCP server mode and `--json` output

---

## 2. Architecture Overview

### Core Principles (from ADRs 0001-0011)

| Principle | ADR | Summary |
|-----------|-----|---------|
| Layered Core + Adapter Extensions | 0001 | Universal core schema + `[adapters.<name>]` escape hatches |
| Git-backed everything | 0002 | Every action is a commit; git IS the sync protocol |
| Hierarchical config | 0003 | Global + project layers, same schema both levels |
| TOML format | 0004 | Human-friendly, comments, Codex-validated pattern |
| Bidirectional adapters | 0005 | Import + export + diff for brownfield and greenfield |
| Drift detection | 0006 | Don't overwrite direct IDE edits; detect and surface |
| Two-phase Zod validation | 0007 | Core validates core, adapters validate their sections |
| Profile-based subsets | 0008 | Cargo inherits + Docker Compose tag activation |
| MCP server mode | 0009 | AI agents as first-class users |
| BunTS single binary | 0010 | Zero runtime deps, cross-platform |
| Built-in adapters | 0011 | All adapters in binary, lazy factory, subprocess escape hatch |

### System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Interfaces                                │
│  CLI (citty + @clack)  │  MCP Server (am mcp-serve)            │
│  TUI (Silvery, later)  │  Web UI (Hono + Preact, later)        │
├─────────────────────────────────────────────────────────────────┤
│                        Core Engine                               │
│  Config Store ──► Profile Resolver ──► Diff Engine              │
│  (TOML r/w)       (inheritance,        (drift detection)        │
│                    merge, tags)                                   │
│                        │                                         │
│                   Resolved Config                                │
│                        │                                         │
├────────────┬───────────┼───────────┬────────────────────────────┤
│            │           │           │         Adapters            │
│ Claude Code│  Cursor   │ Windsurf  │ Copilot │ Cline │ ...     │
│  import()  │ import()  │ import()  │ import()│import()│         │
│  export()  │ export()  │ export()  │ export()│export()│         │
│  diff()    │ diff()    │ diff()    │ diff()  │ diff() │         │
├────────────┴───────────┴───────────┴─────────┴────────┴─────────┤
│                        Storage                                   │
│  ~/.config/agent-manager/ (git repo)  │  SQLite (state.db)      │
│  config.toml + instructions/ + skills/│  Drift cache, sync log  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Model — Core Schema

### 8 Entity Types

Every entity supports an optional `[entity.adapters.<adapter-name>]` subtable for
tool-specific extensions (ADR-0001).

#### 3.1 Servers (MCP)

The most universal entity — identical JSON schema across 9/10 tools.

```toml
[servers.outlook]
command = "aws-outlook-mcp"
args = []
env = { MIDWAY_AUTH = "true" }
transport = "stdio"                  # stdio | streamable-http | sse
description = "Outlook email and calendar"
tags = ["email", "calendar", "work"]
enabled = true

[servers.outlook.adapters.claude-code]
always_allow = ["email_search", "calendar_view"]

[servers.outlook.adapters.cline]
always_allow = true
```

#### 3.2 Instructions

Markdown content with semantic activation rules. Core captures intent; adapters
translate to tool-specific formats.

```toml
[instructions.typescript-conventions]
content = """
Use strict TypeScript with no `any` types.
Prefer `interface` over `type` for object shapes.
"""
scope = "glob"                       # always | glob | agent-decision | manual
globs = ["**/*.ts", "**/*.tsx"]
description = "TypeScript coding conventions"
targets = ["claude-code", "cursor", "windsurf", "copilot"]

[instructions.typescript-conventions.adapters.cursor]
format = "mdc"
always_apply = false
```

**Generated outputs per adapter:**

| Adapter | Output | Transformation |
|---------|--------|----------------|
| Claude Code | `CLAUDE.md` (appended) | Strip frontmatter, concatenate |
| Cursor | `.cursor/rules/<name>.mdc` | Convert to .mdc YAML frontmatter |
| Windsurf | `.windsurf/rules/<name>.md` | Convert to Windsurf frontmatter |
| Copilot | `.github/instructions/<name>.instructions.md` | Convert to Copilot frontmatter |
| AGENTS.md-compatible | `AGENTS.md` (appended) | Universal fallback format |

#### 3.3 Skills

```toml
[skills.research-rabbithole]
path = "skills/research-rabbithole"
description = "Multi-agent parallel research"
tags = ["research"]

[skills.research-rabbithole.adapters.claude-code]
trigger = "/research-rabbithole"
```

#### 3.4 Plugins

```toml
[plugins.superpowers]
source = "registry"
version = "latest"
description = "Enhanced workflow patterns"
tags = ["workflow"]
```

#### 3.5 Agents (Subagents)

```toml
[agents.code-reviewer]
model = "sonnet"
description = "Reviews code for bugs and style"
instructions = "instructions/code-review.md"
tools = ["Read", "Grep", "Glob", "Bash"]

[agents.code-reviewer.adapters.claude-code]
subagent_type = "feature-dev:code-reviewer"

[agents.code-reviewer.adapters.roo-code]
mode = "code-review"
```

#### 3.6 Permissions

```toml
[permissions]
allow = ["Read", "Glob", "Grep", "Bash(git *)"]
ask = ["Write", "Edit", "Bash"]
deny = ["Write(.env)", "Bash(rm -rf *)"]

[permissions.adapters.claude-code]
permission_mode = "allowEdits"

[permissions.adapters.cline]
always_allow_read = true
auto_approve_max_requests = 20
```

#### 3.7 Models

```toml
[models]
primary = "claude-sonnet-4"
fast = "claude-haiku-4-5"
planning = "claude-opus-4"

[models.adapters.claude-code]
ANTHROPIC_MODEL = "global.anthropic.claude-sonnet-4-6-v1"
ANTHROPIC_SMALL_FAST_MODEL = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
```

#### 3.8 Profiles

```toml
[profiles.base]
description = "Always-on utilities"
servers = ["fetch", "context7"]

[profiles.work]
inherits = "base"
servers = ["tavily", "exa"]
server_tags = ["work"]
skills = ["research-rabbithole", "admin-lint"]
plugins = ["superpowers"]
instructions = ["typescript-conventions"]

[profiles.work.adapters.claude-code]
hooks.PostToolUse = ["scripts/lint-check.sh"]
output_style = "learning"

[profiles.work.env]
AWS_PROFILE = "work-sso"
```

---

## 4. Hierarchical Config (ADR-0003)

### Two Layers + Local Overrides

```
~/.config/agent-manager/
  config.toml              # Global catalog (git-synced via am's repo)
  config.local.toml        # Machine-specific (gitignored)
  instructions/            # Instruction markdown files
  skills/                  # Skill definitions
  secrets.age              # Encrypted secrets (git-tracked)
  .agent-manager/
    key.txt                # age identity (gitignored)
    state.db               # SQLite state (gitignored)

<repo>/
  .agent-manager.toml      # Project config (version-controlled in repo)
  .agent-manager.local.toml # Personal project overrides (gitignored)
```

### Resolution Order (highest wins)

```
CLI flags (--profile, --config key=val)
  <- ENV vars (AM_PROFILE, etc.)
    <- .agent-manager.local.toml   (project-local)
      <- .agent-manager.toml       (project, team-shared)
        <- config.local.toml       (user-local)
          <- config.toml           (user global)
            <- Built-in defaults
```

### Composition Rules

| Section | Strategy | Behavior |
|---------|----------|----------|
| Servers | Union (additive) | Project adds to global |
| Skills/Plugins | Union (additive) | Project adds to global |
| Instructions | Union (additive) | Project adds its own |
| Settings | Key-level override | Project overrides per-key |
| Env vars | Key-level override | Project overrides per-key |
| Adapter sections | Deep merge | Project adapter config merges into global |

### Project Config Example

```toml
# <repo>/.agent-manager.toml — shared with team
profile = "work"

[project]
name = "ADMINISTRIVIA"
description = "Personal productivity vault"

[servers.wiki]
command = "amazon-wiki-mcp"
tags = ["wiki", "work"]

[servers.tickety]
command = "tickety-aws-mcp"
tags = ["tickets"]

[adapters.claude-code.hooks.Stop]
command = "scripts/board-sync-check.sh"
```

---

## 5. Git-Backed Everything (ADR-0002)

The config directory IS a git repository. Every mutation commits automatically.

### Automatic Commits

| Action | Commit Message |
|--------|---------------|
| `am add server tavily ...` | `add server: tavily (search, web)` |
| `am use research` | `switch profile: work -> research` |
| `am import claude-code` | `import: claude-code (15 servers, 2 skills)` |
| `am remove server old-mcp` | `remove server: old-mcp` |

### Key Commands

```bash
am log                  # git log with am formatting
am undo                 # git revert HEAD + am apply
am push                 # git push to remote
am pull                 # git pull + am apply
am remote add <url>     # git remote add origin
am clone <url>          # clone config repo + auto-apply
```

### What's in Git vs Gitignored

| Git-tracked | Gitignored |
|-------------|------------|
| `config.toml` | `config.local.toml` |
| `instructions/`, `skills/` | `.agent-manager/key.txt` (age key) |
| `secrets.age` (encrypted) | `.agent-manager/state.db` |
| `.agent-manager.toml` (project) | `.agent-manager.local.toml` |

---

## 6. Adapter System (ADRs 0005, 0011)

### Adapter Interface

```typescript
interface Adapter {
  meta: {
    name: string;                      // "claude-code"
    displayName: string;               // "Claude Code"
    version: string;
    capabilities: Capability[];        // what this adapter supports
  };

  detect(): DetectResult;              // Is this tool installed?

  import(options: ImportOptions): ImportResult;     // native -> core
  export(config: ResolvedConfig, options: ExportOptions): ExportResult; // core -> native
  diff(config: ResolvedConfig): DiffResult;         // detect drift

  schema: AdapterSchema;               // Zod schemas for adapter TOML fields
}

type Capability =
  | "mcp" | "instructions" | "permissions" | "models"
  | "skills" | "plugins" | "agents" | "hooks" | "modes";
```

### Built-In Adapters (ADR-0011)

All adapters ship in the binary with lazy factory instantiation:

| Adapter | Priority | Capabilities |
|---------|----------|-------------|
| `claude-code` | P0 (MVP) | mcp, instructions, permissions, models, skills, plugins, agents, hooks |
| `cursor` | P0 (MVP) | mcp, instructions, permissions, models |
| `windsurf` | P1 | mcp, instructions, permissions, models |
| `copilot` | P1 | mcp, instructions |
| `cline` | P1 | mcp, instructions, permissions |
| `roo-code` | P1 | mcp, instructions, modes |
| `continue` | P2 | mcp, instructions, models |
| `gemini-cli` | P2 | mcp, instructions, models |
| `codex-cli` | P2 | mcp, instructions, permissions |
| `amazon-q` | P2 | mcp, instructions |

Auto-detection: each adapter's `detect()` checks if the tool is installed.
Only detected tools are active unless overridden in config.

### Bidirectional Flow

```
IMPORT (brownfield)          EXPORT (greenfield + ongoing)
native config files          resolved TOML config
       |                            |
  adapter.import()            adapter.export()
       |                            |
       v                            v
  core config.toml           native config files

          DIFF (drift detection)
          adapter.diff()
          compares resolved vs native
```

### Import Reconciliation

When importing from multiple tools, the importer:
1. Matches servers by command (not name) to detect duplicates
2. Prompts on conflicts (different versions, different names for same server)
3. Preserves tool-specific config in `[adapters.<name>]` sections

---

## 7. Drift Detection (ADR-0006)

```bash
$ am status
  Profile: work
  Sync: up to date with origin/main

  Tool Status:
    Claude Code   in sync
    Cursor        drift detected
      + server "playwright-mcp" added locally
      ~ server "tavily" args changed
    Copilot       in sync
    Windsurf      not installed

  Run `am import cursor` to adopt changes
  Run `am apply --target cursor` to overwrite
```

- `am status` uses each adapter's `diff()` method
- `am apply` warns on drift, offers options
- `am apply --force` overrides drift detection
- `am import <tool>` adopts native changes into config.toml

---

## 8. UX Design

### Zero-Config Start

```bash
$ am init
  Detected: Claude Code (15 servers), Cursor (8 servers), Copilot (3 servers)
  Import all? [Y/n] y
  Merged 15 unique servers (3 duplicates reconciled)
  Created profile "default"
  Written to ~/.config/agent-manager/config.toml
  Sync to git? [Y/n] y
  Repository URL: git@github.com:user/agent-config.git
  Pushed initial config
```

### One-Command Operations

```bash
am use work              # switch profile + auto-apply (one command, one intent)
am clone <url>           # new machine setup (one command to full parity)
am status                # drift check across all tools
am undo                  # rollback last change
```

### Agent Experience (AX)

Every command supports `--json` for structured output:

```bash
$ am list servers --json
{
  "servers": [
    { "name": "outlook", "command": "aws-outlook-mcp", "tags": ["work"], "active": true }
  ]
}
```

MCP server mode (ADR-0009):

```json
{
  "mcpServers": {
    "agent-manager": { "command": "am", "args": ["mcp-serve"] }
  }
}
```

Exposes tools: `am_list_servers`, `am_add_server`, `am_use_profile`, `am_apply`,
`am_status`, `am_import`, `am_sync_push`, `am_sync_pull`, `am_config_show`.

---

## 9. CLI Command Tree

```
am
├── init                              # First-time setup (detect, import, git init)
├── clone <url>                       # New machine setup from remote
├── add
│   ├── server <name> [--project]     # Add to global or project catalog
│   ├── skill <name|path>
│   └── plugin <name>
├── remove
│   ├── server <name>
│   ├── skill <name>
│   └── plugin <name>
├── list
│   ├── servers [--active|--global|--project|--json]
│   ├── skills [--active|--json]
│   ├── plugins [--active|--json]
│   ├── profiles [--json]
│   └── adapters [--json]
├── use <profile>                     # Switch profile + auto-apply
├── apply [--dry-run|--diff|--force]  # Generate IDE configs
│   └── --target <adapter>            # Apply to specific tool only
├── import
│   ├── <adapter>                     # Import from specific tool
│   └── auto                          # Auto-detect and import all
├── status [--json]                   # Drift detection + sync state
├── profile
│   ├── show <name>                   # Show computed config
│   ├── create <name> [--inherits]
│   └── delete <name>
├── push                              # Git push
├── pull                              # Git pull + auto-apply
├── log                               # Git log with am formatting
├── undo                              # Git revert HEAD + apply
├── remote
│   ├── add <url>
│   └── remove
├── config
│   ├── show [--resolved]             # Show config (raw or resolved)
│   ├── edit [--project]              # Open in $EDITOR
│   └── validate                      # Schema validation
├── doctor                            # Health check
├── mcp-serve                         # MCP server mode (stdio)
└── version
```

### Global Flags

```
--profile <name>         Override active profile
--config key=value       TOML-valued per-run override
--json                   JSON output for scripting/agents
--verbose / -v           Increase log verbosity
--quiet / -q             Suppress non-essential output
```

---

## 10. Validation (ADR-0007)

Two-phase Zod validation:

**Phase 1 — Core:** Validates all core fields strictly. Adapter sections are
`z.record(z.string(), z.unknown()).optional()` — preserved but not validated.

**Phase 2 — Adapter:** Each installed adapter validates its own
`[entity.adapters.<name>]` section with its Zod schema.

| Situation | Behavior |
|-----------|----------|
| Unknown core field | Warn (likely typo) |
| Unknown adapter name | Preserve silently, optional info message |
| Invalid adapter field | Warn (adapter validation failure) |
| Missing required core field | Error (fail validation) |

---

## 11. Build & Distribution (ADR-0010)

### Tech Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript |
| Runtime/Bundler | Bun (`bun build --compile`) |
| CLI framework | citty (command routing) + @clack/prompts (wizards) |
| Config | @iarna/toml (parser) + Zod (validation) |
| Git | isomorphic-git (default) + simple-git (when system git available) |
| Encryption | age-encryption |
| State | bun:sqlite |

### Build Targets

| Platform | Target |
|----------|--------|
| macOS ARM64 | `bun-darwin-arm64` |
| macOS Intel | `bun-darwin-x64` |
| Linux x64 | `bun-linux-x64` |
| Linux ARM64 | `bun-linux-arm64` |
| Windows x64 | `bun-windows-x64` |

### Distribution

| Channel | Method |
|---------|--------|
| GitHub Releases | Pre-compiled binaries |
| Homebrew | `brew install baladithyab/tap/agent-manager` |
| npm | `npx agent-manager` / `bunx agent-manager` |

Binary: `agent-manager` with `am` as symlink/alias.

---

## 12. Implementation Roadmap

### Phase 1: MVP — CLI + TOML + Git + Claude Code

| Component | Description |
|-----------|-------------|
| Project scaffold | Bun + TypeScript + citty + Zod |
| TOML engine | Read/write config.toml, profile resolution, merge rules |
| Claude Code adapter | import + export + diff for ~/.claude.json, .mcp.json, CLAUDE.md |
| Git layer | isomorphic-git: init, commit, push, pull, log, revert |
| Import wizard | `am init` with auto-detect and @clack/prompts |
| Binary build | `bun build --compile` for macOS |

**Deliverable:** `am init`, `am use <profile>`, `am apply`, `am status`, `am push/pull`

### Phase 2: Multi-Adapter + Full Profiles

| Component | Description |
|-----------|-------------|
| Cursor adapter | import + export + diff |
| Windsurf adapter | import + export + diff |
| Copilot adapter | import + export + diff |
| Instruction generator | CLAUDE.md, .mdc, .windsurf/rules, AGENTS.md |
| Profile management | create, delete, show, auto-detect |
| Secret encryption | age-based encryption for env vars |
| Cross-platform build | All 5 targets + CI/CD pipeline |

**Deliverable:** `am apply --target all`, full profile switching, encrypted secrets

### Phase 3: Remaining Adapters + MCP Server Mode

| Component | Description |
|-----------|-------------|
| Cline, Roo Code, Continue, Gemini, Codex, Amazon Q adapters | Complete coverage |
| MCP server mode | `am mcp-serve` with tool definitions |
| `--json` on all commands | Structured output for agents |
| Homebrew tap + npm package | Distribution channels |

**Deliverable:** Full 10-adapter coverage, MCP server mode, distribution

### Phase 4: TUI (Future)

| Component | Description |
|-----------|-------------|
| Silvery/Ink TUI | Dashboard, server list, profile switcher, sync status |
| `am tui` command | Interactive terminal dashboard |

### Phase 5: Web UI (Future)

| Component | Description |
|-----------|-------------|
| Hono API server | REST API + SSE for real-time |
| Preact SPA | Visual config management |
| GitHub/GitLab OAuth | Device flow + PKCE |
| `am serve` command | Launch web dashboard |

---

## 13. Project Structure

```
agent-manager/
├── src/
│   ├── cli.ts                    # Entry point (citty command routing)
│   ├── commands/                 # CLI command handlers
│   │   ├── init.ts
│   │   ├── add.ts
│   │   ├── use.ts
│   │   ├── apply.ts
│   │   ├── import.ts
│   │   ├── status.ts
│   │   ├── push.ts
│   │   ├── pull.ts
│   │   └── ...
│   ├── core/                     # Core engine
│   │   ├── config.ts             # TOML read/write
│   │   ├── resolver.ts           # Profile resolution + merge
│   │   ├── diff.ts               # Drift detection
│   │   ├── git.ts                # Git operations (isomorphic-git)
│   │   ├── secrets.ts            # age encryption
│   │   └── schema.ts             # Core Zod schemas
│   ├── adapters/                 # Built-in adapters
│   │   ├── registry.ts           # Lazy factory registry
│   │   ├── types.ts              # Adapter interface
│   │   ├── claude-code/
│   │   │   ├── index.ts          # detect, import, export, diff
│   │   │   └── schema.ts         # Adapter-specific Zod schema
│   │   ├── cursor/
│   │   ├── windsurf/
│   │   ├── copilot/
│   │   └── ...
│   └── mcp/                      # MCP server mode
│       └── server.ts
├── test/
│   ├── core/
│   ├── adapters/
│   └── fixtures/                 # Sample config files per tool
├── ADRs/                         # Architectural decisions
├── research/                     # Research documents
├── docs/                         # Design specs
├── scripts/
│   └── build.ts                  # Cross-platform build script
├── package.json
├── tsconfig.json
└── bunfig.toml
```

---

## References

- [Research Index](../research/agent-manager-research-index.md) — 12 research documents
- [ADR Index](../ADRs/README.md) — 11 architectural decisions
- [GitHub Repository](https://github.com/baladithyab/agent-manager)
