# agent-manager (`am`)

**chezmoi for AI agent configs** -- define your MCP servers, skills, instructions,
and agent profiles once in TOML, sync via git, and generate native configs for
every AI coding tool.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests: 647 pass](https://img.shields.io/badge/tests-647%20pass-green.svg)](#development)
[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](package.json)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1.svg)](https://bun.sh)

---

## The Problem

Every AI coding tool stores configuration differently. MCP server definitions live in
`~/.claude.json`, `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, and a dozen
other locations. Instructions live in `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc`,
`.github/copilot-instructions.md`, `.windsurf/rules/*.md`, `.kiro/steering/*.md`,
and more.

Developers who use multiple tools -- or a single tool across multiple machines -- face
a fragmented, manual, error-prone configuration experience.

## The Solution

**agent-manager** provides a single TOML source of truth for all your AI coding tool
configs. Define your MCP servers, instructions, skills, agent profiles, and configuration
profiles once. `am apply` generates the native config files each tool expects. Git backs
every change automatically -- sync across machines with `am push` / `am pull`, roll back
mistakes with `am undo`, and detect when someone edits an IDE config directly with
`am status`.

## Quick Start

```bash
# Install (macOS)
curl -fsSL https://raw.githubusercontent.com/baladithyab/agent-manager/main/scripts/install.sh | bash

# Import existing configs from all detected tools
am init

# Switch to a profile and generate native configs
am use work
am apply

# Check drift across all tools
am status
```

## Features

- **Single TOML source of truth** -- one file defines servers, instructions, skills, agent profiles, and config profiles for all tools
- **8 IDE adapters** -- Claude Code, Codex CLI, ForgeCode, Cursor, Kiro, Kilo Code, Windsurf, GitHub Copilot
- **3 platform adapters** -- GitHub, GitLab, bare git for push/pull operations
- **Git-backed everything** -- every `am add` / `am import` is an automatic commit; git IS the sync protocol
- **Profile-based subsets with inheritance** -- `work` inherits from `base`, activate with `am use work`
- **Drift detection** -- `am status` uses structural comparison to detect direct IDE edits without false positives
- **Bidirectional adapters** -- import existing configs with `am import`, export with `am apply`, detect drift with `am status`
- **MCP server mode** -- `am mcp-serve` exposes agent-manager as an MCP server so AI agents can manage their own config
- **Terminal UI** -- `am tui` launches an interactive Ink-based dashboard with profile switching and status monitoring
- **Web UI** -- `am serve` for local browser dashboard; Cloudflare Workers deployment for remote access
- **AES-256-GCM encryption** -- secrets in TOML are encrypted at rest with `am secret set`, decrypted at apply time
- **Instructions engine** -- shared instruction generation for CLAUDE.md, AGENTS.md, .cursor/rules, .windsurf/rules, .kiro/steering, Copilot .instructions.md
- **Agent profiles** -- define named agent configurations with prompts, models, tools, and MCP server subsets
- **5 cross-platform build targets** -- single binary via `bun build --compile` for darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64
- **Hierarchical config** -- global + project layers, local overrides, environment variable interpolation
- **`--json` output** -- every command supports structured output for scripting and AI agents

## Supported Tools

| Tool | Adapter | Capabilities |
|------|---------|-------------|
| Claude Code | `claude-code` | MCP servers, instructions, permissions, models, skills, agents, hooks |
| Codex CLI | `codex-cli` | MCP servers, instructions, agents |
| ForgeCode | `forgecode` | MCP servers, instructions, permissions |
| Cursor | `cursor` | MCP servers, instructions (`.mdc` rules), permissions, models |
| Kiro | `kiro` | MCP servers, instructions (steering files), specs |
| Kilo Code | `kilo-code` | MCP servers, instructions, modes, JSONC parsing |
| Windsurf | `windsurf` | MCP servers, instructions (rules), models |
| GitHub Copilot | `copilot` | MCP servers, instructions (`.instructions.md`), models |

All 8 adapters are fully implemented with detect, import, export, and diff support.

## Example Workflow

```bash
$ am init
  Detected: Claude Code (15 servers), Cursor (8 servers), Kiro (5 servers)
  Import all? [Y/n] y
  Merged 22 unique servers (6 duplicates resolved)
  Created profile "default"
  Written to ~/.config/agent-manager/config.toml
  Sync to git? [Y/n] y
  Repository URL: git@github.com:user/agent-config.git
  Pushed initial config

$ am add server tavily --command "bunx tavily-mcp@latest" --tags search,web
  add server: tavily (search, web)

$ am list servers
  NAME       COMMAND              TAGS          ENABLED
  outlook    aws-outlook-mcp      email, work   yes
  tavily     bunx tavily-mcp      search, web   yes
  fetch      uvx mcp-server-fetch util          yes
  ...

$ am use work
  Switched to profile: work (inherits: base)

$ am status
  Profile: work
  Sync: up to date with origin/main

  Tool Status:
    Claude Code   in sync
    Cursor        in sync
    Kiro          drifted (2 changes)

$ am apply --dry-run
  Would write:
    ~/.claude.json            12 servers
    .mcp.json                  3 servers
    .cursor/mcp.json          12 servers
    .cursor/rules/ts.mdc       1 instruction
    CLAUDE.md                  2 instruction blocks
    .kiro/mcp.json             5 servers
    .kiro/steering/ts.md       1 instruction

$ am apply
  Applied profile "work" to 3 tools
    Claude Code: 3 files written
    Cursor:      2 files written
    Kiro:        2 files written
```

## Configuration

agent-manager uses TOML for all configuration. The global config lives at
`~/.config/agent-manager/config.toml`. Projects can add a `.agent-manager.toml`
at the repo root for team-shared, project-specific config.

```toml
# ~/.config/agent-manager/config.toml

[settings]
default_profile = "work"

[settings.mcp_serve]
allow_apply = true
allow_push = false

[servers.outlook]
command = "aws-outlook-mcp"
env = { MIDWAY_AUTH = "true" }
tags = ["email", "calendar", "work"]
description = "Outlook email and calendar"

[servers.tavily]
command = "bunx tavily-mcp@latest"
tags = ["search", "web"]

[servers.tavily.adapters.claude-code]
always_allow = ["tavily_search", "tavily_extract"]

[instructions.typescript-conventions]
content = """
Use strict TypeScript with no `any` types.
Prefer `interface` over `type` for object shapes.
"""
scope = "glob"
globs = ["**/*.ts", "**/*.tsx"]

[agents.researcher]
name = "researcher"
description = "Deep research agent"
prompt = "You are a thorough researcher..."
model = "opus"
mcp_servers = ["tavily", "fetch"]

[profiles.base]
description = "Always-on utilities"
servers = ["fetch", "context7"]

[profiles.work]
inherits = "base"
servers = ["outlook", "tavily"]
server_tags = ["work"]
instructions = ["typescript-conventions"]
agents = ["researcher"]
```

### Config Resolution Order (highest wins)

```
CLI flags  <-  ENV vars  <-  .agent-manager.local.toml  <-  .agent-manager.toml
           <-  config.local.toml  <-  config.toml  <-  Built-in defaults
```

## CLI Reference

### Core Commands

| Command | Description |
|---------|-------------|
| `am init` | First-time setup -- detect installed tools, import configs, init git repo |
| `am add server <name>` | Add an MCP server to the global or project catalog |
| `am list servers` | List all servers with status, tags, and active profile filtering |
| `am use <profile>` | Switch the active profile |
| `am apply` | Generate native config files from the resolved TOML config |
| `am status` | Drift detection across all tools + git sync state |
| `am import <adapter>` | Import native config from a specific tool into config.toml |

### Git Sync Commands

| Command | Description |
|---------|-------------|
| `am push` | Push config repo to remote |
| `am pull` | Pull from remote |
| `am undo` | Revert the last config change (git revert HEAD) |
| `am log` | Show config change history with am-formatted git log |

### Config and Profile Management

| Command | Description |
|---------|-------------|
| `am config` | View and edit configuration settings |
| `am profile` | Manage profiles (list, show, create) |
| `am secret set <key>` | Encrypt and store a secret value (AES-256-GCM) |
| `am secret get <key>` | Decrypt and display a secret value |
| `am secret init` | Generate an encryption key |

### Diagnostics and Info

| Command | Description |
|---------|-------------|
| `am doctor` | Health check -- validate config, check adapters, verify git state |
| `am adapter list` | Show all registered adapters with install status and capabilities |
| `am version` | Print version information |

### Advanced Modes

| Command | Description |
|---------|-------------|
| `am mcp-serve` | Run agent-manager as an MCP server (JSON-RPC over stdio) |
| `am tui` | Launch interactive terminal dashboard (Ink/React) |
| `am serve` | Start local web UI server (Hono on Bun) |

### Global Flags

```
--profile <name>     Override active profile for this invocation
--json               JSON output for scripting and AI agents
--verbose, -v        Increase log verbosity
--quiet, -q          Suppress non-essential output
```

## MCP Server Mode

`am mcp-serve` turns agent-manager into an MCP server that AI agents can call.
Three permission tiers control what tools are available (ADR-0009):

| Tier | Tools | Default |
|------|-------|---------|
| Read-only | `am_list_servers`, `am_list_profiles`, `am_status`, `am_config_show` | Always available |
| Write-local | `am_add_server`, `am_remove_server`, `am_use_profile`, `am_import` | Available by default |
| Write-remote | `am_apply`, `am_sync_push`, `am_sync_pull` | Requires opt-in via `settings.mcp_serve` |

Add to your tool's MCP config:

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

## Web UI

### Local Server (`am serve`)

The local web server reads your filesystem config directly:

```bash
am serve
# Opens http://localhost:3000 with dashboard, server list, profile switcher
```

Endpoints: `/api/health`, `/api/config`, `/api/servers`, `/api/profiles`,
`/api/status`, `/api/events` (SSE), `/api/profile/use`, `/api/apply`,
`/api/sync/push`, `/api/sync/pull`.

### Cloudflare Workers Deployment

The web dashboard can be deployed to Cloudflare Workers for browser-based config
management from any device. It is fully stateless -- config lives in your GitHub
repo (accessed via GitHub API), sessions use AES-GCM encrypted cookies (no KV, D1,
or R2). See [ADR-0015](ADRs/0015-stateless-web-ui.md) for the full architecture.

```bash
# Set secrets
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put SESSION_SECRET

# Deploy
bun run deploy:web

# Local dev (uses .dev.vars for secrets)
bun run dev:web
```

The Workers version authenticates via GitHub OAuth and reads/writes config via
the GitHub API using the OAuth token.

## Architecture

agent-manager follows a **layered core + dual-axis adapter** architecture:

```
CLI (citty)  ->  Core Engine   ->  IDE Adapters     ->  Native Config Files
                 (TOML + Git)      (8 adapters)         (~/.claude.json, etc.)
                      |
                      +---------->  Platform Adapters ->  Git Remotes
                      |             (GitHub, GitLab)      (push/pull/auth)
                      |
MCP Server   ->  Same Core     ->  Same Adapters
(JSON-RPC)
                      |
TUI (Ink)    ->  Same Core     ->  Same Adapters
                      |
Web UI       ->  Hono Server   ->  Same Core (local)
(Hono)            or Workers        GitHub API (cloud)
```

- **Core engine** -- TOML config store, Zod validation, profile resolver with inheritance, diff engine, git operations (isomorphic-git), AES-256-GCM encryption, shared instruction generation
- **IDE adapter interface** -- each tool implements `detect()`, `import()`, `export()`, and `diff()`
- **Platform adapters** -- GitHub, GitLab, and bare git handle push/pull URL detection and auth
- **5 entity types** -- Servers, Instructions, Skills, Agent Profiles, Config Profiles
- **Built-in adapters** -- all adapters ship in the binary with lazy factory instantiation

Design decisions are documented in [15 ADRs](ADRs/README.md). The full design
specification is at [docs/2026-04-07-agent-manager-design-spec.md](docs/2026-04-07-agent-manager-design-spec.md).

## Development

```bash
# Install dependencies
bun install

# Run tests (647 tests across 67 test files)
bun test

# Run tests in watch mode
bun test --watch

# Unit tests only (core + adapters)
bun test:unit

# Integration tests only
bun test:integration

# Type check
bun x tsc --noEmit

# Lint
bunx @biomejs/biome check ./src ./test

# Build binary (macOS arm64 default)
bun run build

# Build all 5 platform targets
bun run build -- --all

# Run from source
bun run src/cli.ts init

# Web UI local dev
bun run dev:web

# Deploy web UI to Cloudflare Workers
bun run deploy:web
```

### Project Structure

```
src/                            # 99 TypeScript files
  cli.ts                        # Entry point (citty, 20 subcommands)
  commands/                     # CLI command handlers (20 files)
  core/                         # Config engine
    schema.ts                   # Zod schemas (Server, Instruction, Skill, AgentProfile, Profile, Config)
    config.ts                   # TOML read/write, hierarchical merge, project config
    resolver.ts                 # Profile resolution: inheritance, tag activation, merge
    git.ts                      # Git operations via isomorphic-git
    secrets.ts                  # AES-256-GCM encryption + ${VAR} interpolation
    instructions.ts             # Shared instruction generation (CLAUDE.md, .mdc, steering, etc.)
  adapters/                     # 8 IDE adapters (~6,800 lines total)
    types.ts                    # Adapter interface
    registry.ts                 # Lazy factory registry
    claude-code/                # 808 lines, 7 files
    codex-cli/                  # 781 lines, 6 files
    copilot/                    # 726 lines, 6 files
    cursor/                     # 886 lines, 6 files
    forgecode/                  # 717 lines, 6 files
    kilo-code/                  # 1280 lines, 8 files (includes JSONC parser)
    kiro/                       # 938 lines, 7 files
    windsurf/                   # 673 lines, 7 files
  platforms/                    # 3 git platform adapters
    types.ts                    # Platform adapter interface
    registry.ts                 # Platform detection from remote URL
    github.ts, gitlab.ts, bare.ts
  mcp/                          # MCP server mode (JSON-RPC over stdio)
    server.ts                   # 10 tools across 3 permission tiers
  tui/                          # Terminal UI (Ink + React)
    index.tsx, App.tsx, Dashboard.tsx, StatusView.tsx,
    ProfileSwitcher.tsx, HelpView.tsx, data.ts
  web/                          # Web UI
    server.ts                   # Local Hono server (REST + SSE)
    worker.ts                   # Cloudflare Workers (stateless, GitHub OAuth)
    public/                     # Static HTML (index.html, login.html)
  lib/                          # Shared utilities (output.ts)
test/                           # 67 test files, 647 tests, 1569 expect() calls
ADRs/                           # 15 architectural decision records
docs/                           # Design specifications and guides
scripts/
  build.ts                      # Cross-platform build (5 targets)
  install.sh                    # curl-based installer
```

### Stats

| Metric | Count |
|--------|-------|
| Source files | 99 |
| Test files | 67 |
| Tests | 647 |
| Assertions | 1,569 |
| IDE adapters | 8 |
| Platform adapters | 3 |
| CLI commands | 20 |
| ADRs | 15 |
| Commits | 59 |

## License

[MIT](LICENSE)
