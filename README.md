# agent-manager (`am`)

**The control plane for your AI agents.** Define your catalog once (TOML,
git-backed). Route any agent through a unified MCP gateway. Delegate locally
via ACP or remotely via A2A. Subscribe to marketplaces. Remember sessions in
an LLM-wiki. Edit from terminal, local web, or cloud.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests: 2286 pass](https://img.shields.io/badge/tests-2286%20pass-green.svg)](#testing)
[![Adapters: 13](https://img.shields.io/badge/adapters-13-purple.svg)](#adapter-support-matrix)
[![MCP Tools: 33](https://img.shields.io/badge/MCP%20tools-33-orange.svg)](#mcp-server-mode)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1.svg)](https://bun.sh)

```bash
am init                    # detect installed tools, import existing configs
am add server tavily \
  --command "bunx tavily-mcp@latest" \
  --tags search,web        # add an MCP server (secrets auto-detected)
am use work                # switch to your work profile
am apply                   # generate native configs for all detected tools
```

One catalog. Thirteen tools. Git-synced across every machine. Agent-aware.

---

## The six pillars

agent-manager is not "chezmoi for configs" — it outgrew that framing. It is
a control plane for AI agents, built on six composing pillars:

1. **Catalog + git sync.** Servers, skills, agents, plugins, profiles
   defined once in TOML. User's choice of git backend. Brownfield import
   from any supported tool.
2. **MCP gateway.** `am mcp-serve` exposes the catalog as a stable MCP
   endpoint. Plumb any agent into it once; the catalog becomes the single
   source of truth.
3. **Protocol router.** ACP for local subprocess agents (Claude Code,
   Codex, Gemini, Cursor, Kiro, Copilot…). A2A for remote agents. Bridge
   routes remote delegations into local ACP execution.
4. **Marketplace.** Subscribe to git-backed catalogs of MCPs + skills +
   plugins + agents. Supply-chain hardened (commit SHA pinning,
   trust-on-first-use, path traversal scrub, `--ignore-scripts`).
5. **LLM-wiki.** Karpathy-style session context capture. Globally
   git-backed, locally mirrored per project. Agents using am have context
   of what was done and discussed across sessions. Browse via `am wiki`.
6. **Three UIs over one core.** TUI (`am tui`), local web (`am web`),
   Cloudflare web (multi-device, auth-gated). All three talk to the same
   core; they are skins, not competing products.

See [ADR-0031](ADRs/0031-product-scope-and-pillars.md) for the formal
statement of scope and explicit non-goals.

---

## Why

Every AI coding tool stores configuration differently:

| Data | Claude Code | Cursor | Copilot | Windsurf | Kiro |
|------|-------------|--------|---------|----------|------|
| MCP servers | `~/.claude.json` | `.cursor/mcp.json` | `.vscode/mcp.json` | `~/.windsurf/mcp.json` | `.kiro/mcp.json` |
| Instructions | `CLAUDE.md` | `.cursor/rules/*.mdc` | `.github/instructions/*.md` | `.windsurf/rules/*.md` | `.kiro/steering/*.md` |

The data is the same -- MCP server definitions, instruction files, model settings --
but every tool wants it in a different format, in a different location.

**agent-manager** is the universal translation layer. Define once in TOML, generate
native configs for all tools, sync across machines via git, switch contexts with
profiles, and detect when someone edits an IDE config directly.

---

## Adapter Support Matrix

| Capability | Claude Code | Codex CLI | Cursor | Copilot | Windsurf | ForgeCode | Kilo Code | Kiro | Gemini CLI | Cline | Roo Code | Amazon Q | Continue |
|:-----------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **MCP Servers** | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| **Instructions** | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| **Agent Profiles** | Y | Y | Y | - | - | Y | Y | Y | - | - | - | - | - |
| **Skills** | Y | - | - | - | - | Y | Y | Y | - | - | - | - | - |
| **Permissions** | Y | Y | - | - | - | - | - | - | - | - | - | - | - |
| **Models** | Y | - | - | - | - | Y | - | - | - | - | - | - | - |
| **Modes** | - | - | - | - | - | - | Y | - | - | - | Y | - | - |
| **Plugins** | Y | - | - | - | - | - | - | - | - | - | - | - | - |
| **Hooks** | Y | - | - | - | - | - | - | - | - | - | - | - | - |
| **Session Harvest** | Y | Y | - | - | - | - | - | - | - | - | - | - | - |
| **Import** | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| **Export** | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| **Drift Detection** | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |

All 13 adapters implement full bidirectional sync: detect, import, export, and drift detection.

---

## Install

```bash
# Shell script (macOS / Linux) -- checksums verified
curl -fsSL https://raw.githubusercontent.com/Codeseys-Labs/agent-manager/main/install.sh | sh

# Homebrew
brew tap Codeseys-Labs/am && brew install am

# npm
npm install -g agent-manager

# From source
git clone https://github.com/Codeseys-Labs/agent-manager.git
cd agent-manager && bun install && bun run build
```

---

## Quick Start

### First-Time Setup

```bash
am init
#   Detected: Claude Code (15 servers), Cursor (8 servers), Kiro (5 servers)
#   Import all? [Y/n] y
#   Merged 22 unique servers (6 duplicates resolved)
#   3 potential secrets detected -- run `am secret scan` to review
#   Created profile "default"

am secret scan --fix       # auto-encrypt any detected API keys
```

### Daily Usage

```bash
am use work                # switch to work profile
am apply                   # write native configs for all tools
am status                  # check for drift across tools
am add server playwright \
  --command "npx @playwright/mcp@latest" \
  --tags testing,browser   # add a new server (auto-commits)
am push                    # sync to remote
```

### New Machine

```bash
am init                    # setup + pull from remote
am apply                   # instant parity with your other machines
```

### MCP Registry

```bash
am search tavily                        # search the MCP registry
am install tavily-mcp                   # install with env var prompts + encryption
am install tavily-mcp --version 1.2.0   # pin version
am update                               # check for newer versions
am uninstall tavily                     # remove a package
```

### Marketplace

Browse and install plugins from git-based marketplaces (community-maintained
registries of skills, hooks, and MCP server bundles).

```bash
am marketplace add https://github.com/org/am-plugins  # add a marketplace repo
am marketplace list                                     # list available plugins
am marketplace search "code review"                     # search across marketplaces
am marketplace install org/my-plugin                    # install a plugin
am marketplace remove my-plugin                         # uninstall
am marketplace update                                   # update marketplace repos
```

### LLM-Wiki (pillar 5)

Session context capture that agents using am can read. Globally git-backed;
locally mirrored per project so the current directory has context of what
was done. Inspired by Karpathy's LLM-Wiki pattern.

```bash
am wiki list                            # recent entries
am wiki show <slug>                     # print one entry
am wiki search "auth middleware"        # grep + semantic search
am wiki sync                            # push/pull the global wiki via git
am wiki path                            # print local wiki dir — cd "$(am wiki path)"
```

Entries flow in automatically from `am session` (transcript harvest) and can
be authored manually via `am wiki add`. See [`docs/wiki/`](docs/) for the
full authoring reference.

### Brownfield Import

Import configs from existing tool installations with intelligent merge and
conflict resolution:

```bash
am import claude-code                           # interactive import (default)
am import claude-code --auto                    # auto-resolve conflicts
am import claude-code --report                  # show conflict report only
am import claude-code --marketplace             # include plugins/extensions
```

---

## Core Concepts

### Servers

MCP server definitions -- the most universal entity across tools. Define once, apply everywhere.

```toml
[servers.tavily]
command = "bunx tavily-mcp@latest"
env = { TAVILY_API_KEY = "${TAVILY_API_KEY}" }   # ${VAR} resolved at apply time
tags = ["search", "web"]

[servers.tavily.adapters.claude-code]
always_allow = ["tavily_search", "tavily_extract"]

[servers.tavily._registry]                        # auto-set by am install
package = "tavily-mcp"
version = "1.2.0"
installed_at = "2026-04-09T10:30:00Z"
```

### Instructions

Markdown content with semantic activation rules. Core captures intent; each adapter translates to its native format (CLAUDE.md, `.mdc`, `.instructions.md`, steering files, rules).

```toml
[instructions.typescript-conventions]
content = """
Use strict TypeScript with no `any` types.
Prefer `interface` over `type` for object shapes.
"""
scope = "glob"
globs = ["**/*.ts", "**/*.tsx"]
```

### Skills

Reusable agent capabilities with tool-specific triggers.

```toml
[skills.research-rabbithole]
path = "skills/research-rabbithole"
description = "Multi-agent parallel research"
tags = ["research"]
```

### Agent Profiles

Named agent configurations with prompts, models, tools, and MCP server subsets.

```toml
[agents.researcher]
name = "researcher"
description = "Deep research agent"
prompt = "You are a thorough researcher..."
model = "opus"
mcp_servers = ["tavily", "fetch"]
```

### Config Profiles

Profile-based subsets with single inheritance and tag-based server activation.

```toml
[profiles.work]
inherits = "base"
servers = ["outlook", "tavily"]
server_tags = ["work"]
instructions = ["typescript-conventions"]
agents = ["researcher"]
```

Switch with `am use work`. The active profile is stored locally (never committed), so each machine can use a different profile from the same config.

### Encryption and Secret Detection

AES-256-GCM encryption for secrets in TOML. Encrypted values are stored as `enc:v1:nonce:ciphertext` and decrypted at apply time.

Dynamic secret detection scans server configs for inline API keys using patterns derived from [gitleaks](https://github.com/gitleaks/gitleaks), extended with AI/LLM provider-specific patterns. Detects keys for 24+ services including OpenAI, Anthropic, AWS, GitHub, Stripe, Tavily, and more.

```bash
am secret init             # generate encryption key
am secret scan             # audit all servers for exposed secrets
am secret scan --fix       # auto-substitute with ${VAR} + encrypt
am secret set API_KEY      # encrypt and store a secret
am secret get API_KEY      # decrypt and display
```

Secrets detected during `am import` and `am add server` are flagged automatically with confidence levels (high/medium/low) and the user is prompted to encrypt them.

### Git Sync

Every durable config change is an automatic commit. Git IS the sync protocol.

```bash
am push                    # push config to remote
am pull                    # pull + auto-apply
am undo                    # revert last change (git revert HEAD)
am log                     # config change history
```

---

## Knowledge Wiki

An LLM-optimized knowledge base following the [Karpathy llm-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern -- one markdown file per concept/entity/topic with YAML frontmatter, BM25 full-text search via [MiniSearch](https://github.com/lucaong/minisearch), and rule-based NER for automatic cross-linking.

### Dual Location Storage (ADR-0022)

- **Global wiki** (`~/.config/agent-manager/wiki/global/`): cross-project knowledge
- **Project wikis** (`wiki/projects/<name>/`): project-scoped knowledge
- Projects access their wiki via symlink: `.agent-manager/wiki` -> central AM repo
- Everything syncs via the git-backed AM repo (`am push`/`am pull`)
- Browsable via the stateless web UI

### Usage

```bash
am wiki init                    # initialize wiki for current project (symlink + gitignore)
am wiki search "authentication" # BM25 full-text search
am wiki add                     # interactively add a knowledge entry
am wiki show <slug>             # display a wiki page
am wiki harvest                 # extract knowledge from agent sessions
am wiki ingest                  # create wiki pages from sessions
am wiki lint                    # check for orphans, stale pages, broken links
am wiki graph --json            # export knowledge graph for visualization
am wiki synthesize <query>      # generate context block from knowledge base
am wiki briefing <agent-id>     # generate agent briefing document
am wiki export --format json    # full knowledge base export
am wiki import <file>           # import entries from JSON or markdown
```

### Architecture

- **BM25 search** via MiniSearch with fuzzy matching and field boosting
- **Rule-based NER** extracts file paths, package names, config keys, CLI commands, function names, URLs, and 38+ known tool names
- **Knowledge graph** (JSON adjacency list) with wikilink edges and entity mention edges
- **Session harvesting** extracts knowledge from Claude Code and Codex CLI transcripts with Jaccard similarity deduplication

---

## A2A-ACP Bridge

The bridge connects remote A2A delegation to local ACP agent execution (ADR-0026 Phase 4, ADR-0030). When an external agent sends an A2A task, agent-manager resolves the target locally, spawns it via ACP, and returns the result as an A2A response.

```bash
# Remote agent sends: "run claude: fix the failing tests"
# Bridge resolves "claude" → ACP spawn → executes → returns A2A response
```

The **Unified Agent Registry** (`src/core/agent-registry.ts`) merges three sources with priority: config agents > ACP built-in (16 agents) > A2A roster. Same agent name available both locally and remotely gets both protocols.

---

## Agent-to-Agent Protocol (A2A)

Support for Google's Agent-to-Agent protocol (ADR-0017). Enables agent discovery and task delegation between agent-manager instances and other A2A-compatible agents.

```bash
am agents add https://agent.example.com   # discover agent via Agent Card
am agents list                            # show registered agents
am agents ping my-agent                   # verify reachable
am agents delegate my-agent "review PR"   # send task, stream response
am agents remove my-agent                 # remove from roster
```

Agent Cards are served at `/.well-known/agent.json` on the local web server. The A2A server handles `tasks/send`, `tasks/get`, and `tasks/cancel` via JSON-RPC.

**Security & reliability features:**
- **Bearer token auth:** Optional `auth_token` protects A2A server endpoints
- **TTL eviction:** Terminal tasks auto-expire after 1 hour, two-phase eviction (TTL then capacity-based LRU)
- **SSE streaming:** Real-time event streaming for task progress and agent updates
- **Auto-discovery:** Configure `settings.a2a.discovery_sources` URLs for automatic agent roster population
- **Async polling:** `sendAndPoll()` convenience method for fire-and-wait task delegation

---

## ACP Agent Orchestration

Drive ACP-compatible coding agents headlessly through a unified interface (ADR-0026).

```bash
am run claude "fix the failing tests"          # one-shot: spawn, prompt, wait, exit
am run codex "add error handling to api.ts"    # different agent, same interface
am run --session backend claude "continue"     # named session (resume previous work)
am run --cwd /path/to/project claude "refactor" # override working directory
am run session list                            # list active ACP sessions
am run session cancel <sessionId>              # cancel active session
```

Agents are resolved via the **Unified Agent Registry** (ADR-0030): config overrides > 16 built-in ACP agents > A2A roster entries. Register custom agents in config.toml under `[agents.<name>]` with `acp` and/or `a2a` subtables.

---

## Flows Engine

Multi-step workflow orchestration for ACP agents. Define workflows as typed node
graphs (acp, action, compute, checkpoint) with conditional routing, then run them
from the CLI. Flow state is persisted for crash recovery and status inspection.

```bash
am flow run deploy-pipeline              # execute a flow
am flow list                             # list recent runs
am flow status <run-id>                  # inspect a run
```

See ADR-0026 Phase 3 for the design.

---

## Community Adapters

Extend agent-manager with third-party adapters loaded as JSON-RPC subprocesses.
Install from npm or git, and they integrate seamlessly alongside the 13 built-in
adapters.

```bash
am adapter list                          # show all adapters (built-in + community)
am adapter install <name>                # install from npm/git
am adapter remove <name>                 # uninstall
am adapter update                        # update all community adapters
am adapter verify <name>                 # health-check
```

See ADR-0027 for the loading architecture.

---

## MCP Server Mode

`am mcp-serve` turns agent-manager into an MCP server that AI agents can call to manage their own configuration. 33 tools across 3 permission tiers, grouped by function:

### Tool Grouping

Control which tools are exposed via `settings.mcp_serve.tools`. Default: `["core"]` (14 tools).

```toml
[settings.mcp_serve]
allow_push = false
tools = ["core", "registry", "a2a", "wiki", "session", "acp"]   # expose all 33 tools
```

| Group | Tools | Tier |
|-------|-------|------|
| **core** (14) | `am_list_servers`, `am_list_profiles`, `am_status`, `am_config_show`, `am_doctor`, `am_add_server`, `am_remove_server`, `am_server_update`, `am_undo`, `am_use_profile`, `am_import`, `am_apply`, `am_sync_push`, `am_sync_pull` | read/write-local/write-remote |
| **registry** (3) | `am_registry_search`, `am_registry_install`, `am_registry_list_installed` | read/write-local |
| **a2a** (4) | `am_agent_discover`, `am_agent_list`, `am_agent_delegate`, `am_agent_task_status` | read/write-remote |
| **wiki** (5) | `am_wiki_search`, `am_wiki_add`, `am_wiki_synthesize`, `am_wiki_briefing`, `am_wiki_harvest` | read/write-local |
| **session** (3) | `am_session_list`, `am_session_export`, `am_session_search` | read-only |
| **acp** (4) | `am_run_agent`, `am_acp_list_agents`, `am_acp_session_list`, `am_acp_session_cancel` | write-local |

Add to any tool's MCP config:

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

---

## Drift Detection

`am status` uses structural comparison to detect when native configs diverge from your TOML source of truth:

```
$ am status
  Profile: work
  Sync: up to date with origin/main

  Tool Status:
    Claude Code   in sync
    Cursor        drifted (2 changes)
      + server "playwright-mcp" added locally
      ~ server "tavily" args changed
    Kiro          in sync

  Run `am import cursor` to adopt changes
  Run `am apply --target cursor` to overwrite
```

Drift covers servers and instructions. Drift is surfaced, never silently overwritten.

---

## Configuration

### Config Hierarchy

```
~/.config/agent-manager/config.toml          # global catalog (git-synced)
~/.config/agent-manager/config.local.toml    # machine-specific (gitignored)
<repo>/.agent-manager.toml                   # project config (version-controlled)
<repo>/.agent-manager.local.toml             # personal project overrides (gitignored)
```

Resolution order: project.local > project > global.local > global > built-in defaults.

### Full Example

```toml
# ~/.config/agent-manager/config.toml

[settings]
default_profile = "work"

[settings.mcp_serve]
allow_push = false
tools = ["core", "registry"]

[servers.tavily]
command = "bunx tavily-mcp@latest"
env = { TAVILY_API_KEY = "${TAVILY_API_KEY}" }
tags = ["search", "web"]

[servers.tavily._registry]
source = "mcp-registry"
package = "tavily-mcp"
version = "1.2.0"
installed_at = "2026-04-09T10:30:00Z"

[servers.tavily.adapters.claude-code]
always_allow = ["tavily_search", "tavily_extract"]

[instructions.typescript-conventions]
content = "Use strict TypeScript. No `any` types."
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

---

## CLI Reference

### Config Management

| Command | Description |
|---------|-------------|
| `am init` | First-time setup -- detect tools, import configs, init git repo |
| `am init --project` | Initialize project-level `.agent-manager.toml` |
| `am add server <name>` | Add an MCP server (secrets auto-detected) |
| `am list servers` | List servers with status, tags, and profile filtering |
| `am use <profile>` | Switch active profile |
| `am apply` | Generate native config files for all detected tools |
| `am status` | Drift detection across all tools + git sync state |
| `am config` | View and edit configuration settings |
| `am profile list\|show\|create\|delete` | Manage profiles |

### Git Sync

| Command | Description |
|---------|-------------|
| `am push` | Push config repo to remote |
| `am pull` | Pull from remote + auto-apply |
| `am undo` | Revert last config change (git revert HEAD) |
| `am log` | Config change history |

### MCP Registry

| Command | Description |
|---------|-------------|
| `am search <query>` | Search MCP registry (`--tag`, `--verified`, `--limit`, `--json`) |
| `am install <package...>` | Install MCP server packages (`--version`, `--dry-run`, `--yes`) |
| `am uninstall <name>` | Remove a server package (`--dry-run`, `--yes`) |
| `am update` | Check for and apply registry updates (`--dry-run`, `--yes`) |

### Knowledge Wiki

| Command | Description |
|---------|-------------|
| `am wiki init` | Initialize wiki for current project (symlink + gitignore) |
| `am wiki search <query>` | BM25 full-text search (`--json`, `--global`) |
| `am wiki add` | Interactive knowledge entry creation |
| `am wiki show <slug>` | Display a wiki page |
| `am wiki delete <slug>` | Remove a wiki page (`--force`) |
| `am wiki harvest` | Extract knowledge from agent sessions |
| `am wiki ingest` | Create wiki pages from sessions |
| `am wiki lint` | Check for orphans, stale pages, broken links |
| `am wiki graph` | Export knowledge graph (`--json`) |
| `am wiki synthesize <query>` | Generate context block |
| `am wiki briefing <agent-id>` | Generate agent briefing |
| `am wiki export` | Export knowledge base (`--format json\|markdown`) |
| `am wiki import <file>` | Import from JSON or markdown |

### Agent-to-Agent

| Command | Description |
|---------|-------------|
| `am agents list` | List all discovered A2A agents |
| `am agents add <url>` | Add agent by fetching its Agent Card |
| `am agents remove <name>` | Remove from roster |
| `am agents ping <name>` | Verify reachable, show capabilities |
| `am agents delegate <name> <task>` | Send task, stream response |

### ACP Agent Orchestration

| Command | Description |
|---------|-------------|
| `am run <agent> "<prompt>"` | Drive an ACP-compatible agent headlessly |
| `am run --session <name> <agent> "<prompt>"` | Named session (resume previous work) |
| `am run --cwd <path> <agent> "<prompt>"` | Override working directory |
| `am run session list` | List active ACP sessions |
| `am run session cancel <id>` | Cancel an active session |

### Flows

| Command | Description |
|---------|-------------|
| `am flow run <file>` | Execute a multi-step workflow from a TOML definition |
| `am flow list` | List recent flow runs |
| `am flow status <id>` | Show status of a flow run |

### Marketplace

| Command | Description |
|---------|-------------|
| `am marketplace add <url>` | Add a git-based marketplace repo |
| `am marketplace remove <name>` | Remove a marketplace |
| `am marketplace list` | List marketplaces and available plugins (`--installed`) |
| `am marketplace search <query>` | Search across all marketplaces |
| `am marketplace install <id>` | Install a plugin from a marketplace |
| `am marketplace uninstall <name>` | Remove an installed plugin |
| `am marketplace update` | Update marketplace repos |

### Community Adapters

| Command | Description |
|---------|-------------|
| `am adapter list` | Show all adapters (built-in + community) with install status |
| `am adapter install <name>` | Install a community adapter from npm/git |
| `am adapter remove <name>` | Remove a community adapter |
| `am adapter update` | Update all community adapters |
| `am adapter verify <name>` | Health-check a community adapter |

### Tools and Diagnostics

| Command | Description |
|---------|-------------|
| `am import <adapter>` | Import native config (`--auto`, `--report`, `--marketplace`) |
| `am doctor` | Health check -- config, adapters, git, secret audit |
| `am secret init` | Generate encryption key |
| `am secret set\|get <key>` | Encrypt/decrypt secrets |
| `am secret scan` | Audit servers for exposed secrets (`--fix` to auto-encrypt) |
| `am session list\|export\|search` | Cross-tool session discovery and export |
| `am version` | Print version (`--json`) |

### Interfaces

| Command | Description |
|---------|-------------|
| `am mcp-serve` | Run as MCP server (JSON-RPC over stdio) |
| `am tui` | Interactive terminal dashboard (Silvery/React) |
| `am serve` | Local web UI server with Bearer token auth |
| `am completion bash\|zsh\|fish` | Generate shell completion scripts |

### Global Flags

```
--profile <name>     Override active profile for this invocation
--json               JSON output for scripting and AI agents
--verbose, -v        Increase log verbosity
--quiet, -q          Suppress non-essential output
```

---

## Web UI

### Local Server

```bash
am serve
# Opens http://localhost:3000 with Bearer token auth
# Token stored at ~/.config/agent-manager/web-token.txt
```

REST API + SSE for real-time updates. Includes wiki browser UI for browsing knowledge base pages, search, and graph visualization.

### Stateless Web UI (Cloudflare Workers)

A browser-based management dashboard that accesses your git-backed AM repo via the GitHub/GitLab API. Fully stateless -- config and wiki data live in your git backend, sessions use AES-GCM encrypted cookies. No KV, D1, or R2.

Users can browse their config, wiki, and make changes through the web UI rather than the CLI -- both access the same git-backed source of truth. Wiki pages are browsable from both local and worker web UIs.

```bash
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put SESSION_SECRET
bun run deploy:web
```

---

## Architecture

```mermaid
graph LR
    CLI["CLI (31 commands)"] --> Core["Core Engine<br/>(TOML + Zod + Git)"]
    MCP["MCP Server<br/>(33 tools, 6 groups)"] --> Core
    TUI["TUI (Silvery)"] --> Core
    Web["Web UI"] --> Hono["Hono (local) /<br/>CF Workers"]

    Core --> Adapters["IDE Adapters (13)<br/>+ Community (JSON-RPC)<br/>detect / import /<br/>export / diff"]
    Core --> Platform["Platform Adapters<br/>(GitHub, GitLab, bare)"]
    Core --> Secrets["Secret Detection<br/>(gitleaks patterns)"]
    Core --> AgentReg["Unified Agent Registry<br/>(config + ACP + A2A)"]

    Adapters --> Native["Native Config Files"]
    Platform --> Remote["Git Remotes"]

    Core --> Wiki["LLM Wiki<br/>(BM25 + NER + Graph)"]
    Core --> Registry["MCP Registry<br/>(search / install)"]
    Core --> Marketplace["Git Marketplace<br/>(plugins / scanners)"]
    Core --> Flows["Flows Engine<br/>(multi-step workflows)"]

    AgentReg --> A2A["A2A Protocol<br/>(discovery / delegation)"]
    AgentReg --> ACP["ACP Orchestration<br/>(spawn / stream)"]
    A2A <--> Bridge["A2A-ACP Bridge"] <--> ACP
```

Design decisions documented in [30 ADRs](ADRs/README.md).

---

## Development

```bash
bun install                       # install dependencies
bun test                          # run all tests (1864)
bun test --watch                  # watch mode
bun run dev -- <command> [args]   # run CLI from source
bun run lint                      # Biome check
bun run typecheck                 # tsc --noEmit
bun run build                     # macOS arm64 binary -> dist/am-darwin-arm64
bun run build -- --all            # all 5 platform targets
```

### CI/CD — Blacksmith Runners

CI runs on [Blacksmith](https://blacksmith.sh) bare-metal runners for 2x faster builds
and 4x faster cache downloads. Drop-in replacement for GitHub-hosted runners.

| Runner | Platform | Used In |
|--------|----------|---------|
| `blacksmith-2vcpu-ubuntu-2404` | Linux x64 | CI test + lint + typecheck + build |
| `blacksmith-6vcpu-macos-latest` | macOS arm64 | Build verify |
| `blacksmith-2vcpu-windows-2025` | Windows x64 | Build verify (continue-on-error) |

Bun is installed via `useblacksmith/setup-bun@v1` which uses Blacksmith's colocated
cache for faster downloads.

**CI pipeline** (`.github/workflows/ci.yml` — triggers on push to main + PRs):
1. Type check — `tsc --noEmit` filtered to `src/` errors only
2. Lint — `biome check`
3. Test with coverage — `bun test --coverage` (1864 tests)
4. Build smoke test — all 5 platform targets
5. Cross-platform build verify — Ubuntu + macOS + Windows

**Release pipeline** (`.github/workflows/release.yml` — triggers on `v*.*.*` tags):
1. Build all 5 binaries on native runners (Linux on Ubuntu, macOS on macOS, Windows on Windows)
2. Generate SHA-256 checksums
3. Create GitHub Release with all artifacts
4. Publish to npm

**Workarounds documented in CI:**
- Bun exits 1 when test code writes to stderr even with 0 failures — CI captures
  output and checks for actual `N fail` lines where N > 0
- Silvery ships `.ts` source in `node_modules` causing tsc errors — typecheck filters
  to `src/` files only
- Windows has 59 pre-existing path separator failures — marked `continue-on-error`

### Project Stats

| Metric | Count |
|--------|-------|
| Source files | 182 |
| Test files | 151 |
| Tests | 1,859 |
| Assertions | 5,512 |
| IDE adapters | 13 (+community) |
| Platform adapters | 3 |
| CLI commands | 31 |
| MCP tools | 33 |
| ADRs | 30 |

### Tech Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript (strict mode, zero `as any`) |
| Runtime / Bundler | Bun (`bun build --compile` for single binary) |
| CLI framework | citty + @clack/prompts |
| Config | @iarna/toml + Zod |
| Git | isomorphic-git (pure JS, no system git) |
| Web | Hono (local server + Cloudflare Workers) |
| TUI | Silvery + React |
| Encryption | Web Crypto API (AES-256-GCM) |
| Search | MiniSearch (BM25 for wiki) |
| Secret detection | gitleaks-derived patterns (24+ services) |
| Testing | bun:test |
| Linting | Biome |

---

## License

[MIT](LICENSE)
