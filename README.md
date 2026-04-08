# agent-manager (`am`)

**chezmoi for AI agent configs** -- define your MCP servers, skills, and instructions
once in TOML, sync via git, and generate native configs for every AI coding tool.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-bun%20test-green.svg)](#development)
[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](package.json)

---

## The Problem

Every AI coding tool stores configuration differently. MCP server definitions live in
`~/.claude.json`, `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, and a dozen
other locations. Instructions live in `CLAUDE.md`, `.cursor/rules/*.mdc`,
`.github/copilot-instructions.md`, and more.

Developers who use multiple tools -- or a single tool across multiple machines -- face
a fragmented, manual, error-prone configuration experience.

## The Solution

**agent-manager** provides a single TOML source of truth for all your AI coding tool
configs. Define your MCP servers, instructions, skills, and profiles once.
`am apply` generates the native config files each tool expects. Git backs every change
automatically -- sync across machines with `am push` / `am pull`, roll back mistakes
with `am undo`, and detect when someone edits an IDE config directly with `am status`.

## Quick Start

```bash
# Install (macOS)
brew install baladithyab/tap/agent-manager

# Import your existing configs
am init

# Switch to a profile
am use work

# Generate native config files
am apply
```

## Features

- **Single TOML source of truth** -- one file defines servers, instructions, skills, and profiles for all tools
- **Git-backed everything** -- every `am add` / `am import` is an automatic commit; git IS the sync protocol
- **Profile-based subsets with inheritance** -- `work` inherits from `base`, activate with `am use work`
- **Drift detection** -- `am status` detects direct IDE edits so you never lose changes
- **Bidirectional adapters** -- import existing configs with `am import`, export with `am apply`
- **Cross-tool config generation** -- one config generates `~/.claude.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, and more
- **Hierarchical config** -- global + project layers, local overrides, environment variable interpolation
- **`--json` output** -- every command supports structured output for scripting and AI agents

## Supported Tools

| Tool | Status | Adapter |
|------|--------|---------|
| Claude Code | **Phase 1** | `claude-code` |
| Cursor | Phase 2 | `cursor` |
| Windsurf | Phase 2 | `windsurf` |
| GitHub Copilot | Phase 2 | `copilot` |
| Cline | Phase 3 | `cline` |
| Roo Code | Phase 3 | `roo-code` |
| Continue | Phase 3 | `continue` |
| Gemini CLI | Phase 3 | `gemini-cli` |
| Codex CLI | Phase 3 | `codex-cli` |
| Amazon Q | Phase 3 | `amazon-q` |

## Example Workflow

```bash
$ am init
  Detected: Claude Code (15 servers)
  Import all? [Y/n] y
  Merged 15 unique servers
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
  Applied to: Claude Code

$ am status
  Profile: work
  Sync: up to date with origin/main

  Tool Status:
    Claude Code   in sync

$ am apply --dry-run
  Would write:
    ~/.claude.json            12 servers
    .mcp.json                  3 servers
    CLAUDE.md                  2 instruction blocks

$ am apply
  Applied profile "work" to Claude Code
    ~/.claude.json            12 servers written
    .mcp.json                  3 servers written
    CLAUDE.md                  2 instruction blocks written
```

## Configuration

agent-manager uses TOML for all configuration. The global config lives at
`~/.config/agent-manager/config.toml`. Projects can add a `.agent-manager.toml`
at the repo root for team-shared, project-specific config.

```toml
# ~/.config/agent-manager/config.toml

default_profile = "work"

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

[profiles.base]
description = "Always-on utilities"
servers = ["fetch", "context7"]

[profiles.work]
inherits = "base"
servers = ["outlook", "tavily"]
server_tags = ["work"]
instructions = ["typescript-conventions"]
```

### Config Resolution Order (highest wins)

```
CLI flags  <-  ENV vars  <-  .agent-manager.local.toml  <-  .agent-manager.toml
           <-  config.local.toml  <-  config.toml  <-  Built-in defaults
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `am init` | First-time setup -- detect installed tools, import configs, init git repo |
| `am add server <name>` | Add an MCP server to the global or project catalog |
| `am list servers` | List all servers with status, tags, and active profile filtering |
| `am use <profile>` | Switch the active profile and auto-apply to all detected tools |
| `am apply` | Generate native config files from the resolved TOML config |
| `am status` | Drift detection across all tools + git sync state |
| `am import <adapter>` | Import native config from a specific tool into config.toml |
| `am push` | Push config repo to remote |
| `am pull` | Pull from remote and auto-apply |
| `am undo` | Revert the last config change (git revert HEAD) and re-apply |
| `am log` | Show config change history with am-formatted git log |
| `am version` | Print version information |

### Global Flags

```
--profile <name>     Override active profile for this invocation
--json               JSON output for scripting and AI agents
--verbose, -v        Increase log verbosity
--quiet, -q          Suppress non-essential output
```

## Web UI (Cloud Deployment)

The web dashboard can be deployed to Cloudflare Workers for browser-based config
management from any device. It is stateless -- config lives in your GitHub repo,
sessions live in Workers KV. See [ADR-0015](ADRs/0015-stateless-web-ui.md) for
the full architecture.

```bash
# Prerequisites: wrangler CLI authenticated with Cloudflare

# 1. Create KV namespace for sessions
bun run web:kv:create
# Copy the ID into wrangler.toml (replace REPLACE_WITH_KV_ID)

# 2. Set secrets
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put SESSION_SECRET

# 3. Deploy
bun run deploy:web

# Local dev (uses .dev.vars for secrets)
bun run dev:web
```

The CLI's `am serve` remains for local use (reads local filesystem).
The Workers version reads/writes config via the GitHub API using OAuth tokens.

## Architecture

agent-manager follows a **layered core + adapter** architecture:

- **Core engine** -- TOML config store, profile resolver, diff engine, git operations
- **Adapter interface** -- each tool implements `import()`, `export()`, and `diff()`
- **Built-in adapters** -- all adapters ship in the binary with lazy factory instantiation

```
CLI (citty)  ->  Core Engine  ->  Adapter Registry  ->  Native Config Files
                 (TOML + Git)     (claude-code, ...)    (~/.claude.json, etc.)
```

Design decisions are documented in [11 ADRs](ADRs/README.md). The full design
specification is at [docs/2026-04-07-agent-manager-design-spec.md](docs/2026-04-07-agent-manager-design-spec.md).

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run tests in watch mode
bun test --watch

# Type check
bun x tsc --noEmit

# Lint
bunx @biomejs/biome check ./src ./test

# Build binary
bun run build

# Run from source
bun run src/cli.ts init
```

### Project Structure

```
src/
  cli.ts              # Entry point (citty command routing)
  commands/            # CLI command handlers (init, add, apply, ...)
  core/                # Config store, resolver, diff, git, schema
  adapters/            # Built-in adapters (claude-code, ...)
    registry.ts        # Lazy factory registry
    types.ts           # Adapter interface
test/
  core/                # Core engine tests
  adapters/            # Adapter tests
  fixtures/            # Sample config files per tool
ADRs/                  # Architectural decision records
docs/                  # Design specifications
```

## License

[MIT](LICENSE)
