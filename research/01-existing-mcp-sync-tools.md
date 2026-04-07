---
tags: [research/agent-manager, tools/mcp, tools/cli]
created: 2026-04-07
updated: 2026-04-07
---

# Existing MCP/Plugin Sync & Management Tools

Comprehensive survey of every significant tool for managing, installing, syncing, and
organizing Model Context Protocol (MCP) servers, skills, plugins, and agent configurations.
This research informs the design of `agent-manager` by identifying what exists, what works,
and what gaps remain.

> [!info] Cross-references
> See also: [[02-git-as-backend-patterns]], [[04-toml-profile-design]],
> [[06-tui-frameworks-typescript-bun]], [[09-bun-cross-platform-compilation]]

---

## Table of Contents

1. [Tier 1: Full-Featured Package Managers](#tier-1-full-featured-package-managers)
2. [Tier 2: Hub/Gateway Servers](#tier-2-hubgateway-servers)
3. [Tier 3: Registries & Directories](#tier-3-registries--directories)
4. [Tier 4: Lightweight Installers & Utilities](#tier-4-lightweight-installers--utilities)
5. [Tier 5: GUI/Desktop Apps](#tier-5-guidesktop-apps)
6. [Tier 6: Internal/Enterprise Tools](#tier-6-internalenterprise-tools)
7. [Feature Comparison Matrix](#feature-comparison-matrix)
8. [Gaps Analysis](#gaps-analysis)

---

## Tier 1: Full-Featured Package Managers

These tools aim to be the "npm/brew for MCP" — discovery, install, config management,
and multi-client support.

### 1.1 MCPM (pathintegral-institute/mcpm.sh)

| Field | Value |
|-------|-------|
| **Repository** | [pathintegral-institute/mcpm.sh](https://github.com/pathintegral-institute/mcpm.sh) |
| **Website** | [mcpm.sh](https://mcpm.sh/) |
| **Stars** | ~1.5K+ (active, fast-growing) |
| **Language** | Python (Click + Rich) |
| **License** | MIT |
| **Install** | `brew install mcpm` / `pipx install mcpm` / `uv tool install mcpm` / `curl -sSL https://mcpm.sh/install \| bash` |
| **Status** | **Active** — v2.6.1 on PyPI (Aug 2025), frequent releases |

#### Architecture

MCPM uses a **global workspace model** (introduced in v2.0):

1. **Servers** are installed once to a central config
2. **Profiles** are virtual tags grouping servers for different workflows
3. **Client integration** pushes configs to specific MCP clients

#### CLI Commands

```bash
# Server management
mcpm search [QUERY]            # Browse registry
mcpm info SERVER_NAME          # Server details
mcpm install SERVER_NAME       # Install from registry
mcpm uninstall SERVER_NAME     # Remove globally
mcpm ls                        # List installed + profile assignments
mcpm edit SERVER_NAME          # Edit config
mcpm inspect SERVER_NAME       # Launch MCP Inspector
mcpm new SERVER_NAME --type stdio --command "..."  # Add custom server
mcpm new SERVER_NAME --type remote --url "..."     # Add remote server

# Execution & sharing
mcpm run SERVER_NAME           # stdio execution
mcpm run SERVER_NAME --http    # HTTP execution
mcpm share SERVER_NAME         # Expose via secure tunnel
mcpm usage                     # Analytics dashboard

# Profile management
mcpm profile ls / create / rm PROFILE
mcpm profile edit PROFILE      # Interactive server selector
mcpm profile edit PROFILE --add-server NAME
mcpm profile run PROFILE       # Run all servers in profile
mcpm profile run PROFILE --http --host 0.0.0.0 --port 8080
mcpm profile share PROFILE
mcpm profile inspect PROFILE

# Client integration
mcpm client ls                 # List supported clients + status
mcpm client edit CLIENT_NAME   # Interactive enable/disable
mcpm client edit CLIENT_NAME --add-profile PROFILE --force
mcpm client import CLIENT_NAME # Import existing client configs

# Updates & system
mcpm update [SERVER_NAME]      # Update servers (git ff-only, npm/uvx auto)
mcpm update --check            # Dry run
mcpm doctor                    # Health check
mcpm config                    # Settings management
mcpm migrate                   # v1 → v2 migration
```

#### Supported Clients

Claude Desktop, Cursor, Windsurf, VS Code, Cline, Continue, Goose, 5ire, Roo Code

#### AI/Automation Mode

```bash
MCPM_NON_INTERACTIVE=true   # Suppress prompts
MCPM_FORCE=true             # Skip confirmations
MCPM_JSON_OUTPUT=true       # Machine-readable output
```

#### Key Strengths

- Most complete CLI in the ecosystem — profiles, client integration, HTTP serving, tunneling
- Central registry at mcpm.sh/registry
- Removing a profile keeps servers installed (non-destructive)
- `mcpm share` for public tunneling
- `mcpm usage` analytics dashboard
- `llm.txt` auto-generated from CLI structure for AI agents

#### Key Limitations

- **No git-based sync** — config is local-only, no cross-machine sync
- **No TOML/YAML config** — internal format only, not human-editable dotfiles
- **No skill/agent management** — MCP servers only
- **Python dependency** — requires Python 3.10+
- Docker execution support pending
- TUI interface pending

---

### 1.2 MCP-Club/mcpm (npm)

| Field | Value |
|-------|-------|
| **Repository** | [mcp-club/mcpm](https://github.com/mcp-club/mcpm) |
| **Stars** | 105 |
| **Language** | TypeScript |
| **Install** | `npm install -g @mcpm/cli` |
| **Status** | **Low activity** — original mcpm before pathintegral fork |

#### CLI Commands

```bash
search [query]     # Browse MCPHub registry
install <n> [-y]   # Install by ID
add [name]         # Manually register
remove [name]      # Unregister
disable [name]     # Archive to ~/.mcpm/
enable [name]      # Restore from archive
list               # Show all configured servers
mcp                # Self-integration mode (runs as MCP server)
restart            # Restart Claude.app
```

#### Key Differences from pathintegral/mcpm.sh

- Node.js/npm ecosystem (vs Python)
- Claude App-specific (vs multi-client)
- Has unique "self as MCP server" mode
- No profiles, no HTTP serving, no tunneling
- Much smaller community and feature set

---

### 1.3 Smithery CLI (smithery-ai/cli)

| Field | Value |
|-------|-------|
| **Repository** | [smithery-ai/cli](https://github.com/smithery-ai/cli) |
| **Website** | [smithery.ai](https://smithery.ai/) |
| **Stars** | 612 |
| **Language** | TypeScript |
| **License** | AGPL-3.0 |
| **Install** | `npm install -g @smithery/cli@latest` / `npx @smithery/cli@latest setup` |
| **Status** | **Active** — commercial platform with free tier |

#### Architecture

Smithery is both a **registry platform** (smithery.ai) and a **CLI tool**. It goes
beyond MCP servers to include **Skills** (reusable prompt/instruction packages) and
**Agent configurations**.

#### CLI Commands

```bash
# MCP server management
smithery mcp search [term]         # Search registry
smithery mcp add <url>             # Add server connection
smithery mcp list                  # View connections
smithery mcp remove <ids...>       # Remove connections
smithery mcp publish <url> -n org/server  # Publish to registry

# Tool interaction
smithery tool list [connection]    # List available tools
smithery tool find [query]         # Search by name/intent
smithery tool get <conn> <tool>    # Tool details
smithery tool call <conn> <tool> [args]  # Invoke tool

# Skills registry
smithery skill search [query]      # Search skills (--json, --page)
smithery skill add <skill> --agent <name>  # Install to agent
smithery skill upvote/downvote <skill>
smithery skill review list/add/remove <skill>

# Auth & namespaces
smithery auth login/logout/whoami
smithery auth token [--policy '<json>']  # Mint restricted tokens
smithery namespace list/use <name>
```

#### Key Strengths

- **Skills ecosystem** — not just MCP servers, but reusable prompt packages
- **Agent-targeted install** (`--agent <name>`)
- **OAuth + token policies** — enterprise-grade auth
- **Organization namespaces** — multi-team support
- **Hosted infrastructure** — OAuth, credentials, sessions fully managed
- **Review/voting system** for community curation

#### Key Limitations

- **AGPL license** — viral copyleft, problematic for some use cases
- **Cloud-dependent** — registry is hosted, no offline mode documented
- **No local config format documented** — opaque config management
- **No profiles/subsets** — no way to group servers for different workflows
- **No cross-machine sync** beyond cloud account
- **No self-hosted option** documented

---

### 1.4 mcp-get (michaellatman/mcp-get) [DEPRECATED]

| Field | Value |
|-------|-------|
| **Repository** | [michaellatman/mcp-get](https://github.com/michaellatman/mcp-get) |
| **Stars** | 506 |
| **Language** | TypeScript |
| **License** | MIT |
| **Install** | `npx @michaellatman/mcp-get@latest <command>` |
| **Status** | **Archived/Deprecated** — recommends Smithery as replacement |

Was one of the earliest MCP package managers. Simple npx-based commands:

```bash
npx @michaellatman/mcp-get@latest list
npx @michaellatman/mcp-get@latest install <package>
npx @michaellatman/mcp-get@latest install <package> <version>
npx @michaellatman/mcp-get@latest uninstall <package>
npx @michaellatman/mcp-get@latest update
```

Supported Node.js, Python, and Go runtimes. Had a community registry at
mcp-get.com with JSON package definitions. Now deprecated in favor of Smithery.

---

## Tier 2: Hub/Gateway Servers

These tools act as centralized coordinators — a single endpoint that proxies/aggregates
multiple MCP servers.

### 2.1 MCP-Hub (ravitemer/mcp-hub)

| Field | Value |
|-------|-------|
| **Repository** | [ravitemer/mcp-hub](https://github.com/ravitemer/mcp-hub) |
| **Stars** | 469 |
| **Language** | TypeScript/Node.js |
| **License** | MIT |
| **Install** | `npm install -g mcp-hub` |
| **Status** | **Active** — MCP 2025-03-26 spec compliant |

#### Architecture

MCP-Hub is a **central coordinator** with two interfaces:

1. **Management Interface** (`/api/*`) — REST API + web UI for managing servers
2. **MCP Server Interface** (`/mcp`) — single endpoint for all clients

Clients like Claude Desktop only need one connection:
```json
{ "mcpServers": { "Hub": { "url": "http://localhost:37373/mcp" } } }
```

#### CLI & Config

```bash
mcp-hub --port 3000 --config path/to/config.json
mcp-hub --port 3000 --config global.json --config project.json  # Merge multiple
mcp-hub --port 3000 --config .vscode/mcp.json --watch  # VS Code compat
```

Config format is **JSON/JSON5** with rich variable substitution:

```json
{
  "mcpServers": {
    "local-server": {
      "command": "${MCP_BINARY_PATH}/server",
      "args": ["--token", "${API_TOKEN}"],
      "env": {
        "API_TOKEN": "${cmd: aws ssm get-parameter --name /app/token ...}",
        "DB_URL": "postgresql://user:${DB_PASSWORD}@localhost/myapp"
      }
    },
    "remote-server": {
      "url": "https://${PRIVATE_DOMAIN}/mcp",
      "headers": { "Authorization": "Bearer ${cmd: op read op://vault/api/token}" }
    }
  }
}
```

Variable syntax: `${VAR}`, `${env:VAR}`, `${cmd: command}`, `${workspaceFolder}`,
`${userHome}`, `${input:id}`.

#### REST API

Full CRUD lifecycle: health, list servers, start/stop, refresh, execute tools,
access resources, get prompts, marketplace browse, workspace tracking.

SSE events at `/api/events` for real-time updates.

#### Key Features

- **Multi-config merge** — global + project configs, later overrides earlier
- **Variable substitution** with command execution (`${cmd: ...}`)
- **VS Code mcp.json compatibility** — direct import
- **Hot-reload** (`--watch`) — only restarts affected servers
- **Development mode** — file watching with auto-restart
- **Automatic namespacing** — `filesystem__search` vs `database__search`
- **OAuth 2.0 + PKCE** for remote servers
- **Neovim integration** via mcphub.nvim plugin
- **Marketplace** powered by ravitemer/mcp-registry

#### Key Limitations

- **No sync mechanism** — local-only config management
- **No profiles/subsets** — all servers in one flat config
- **No Roots, Sampling, or Completion** support
- **Hub model only** — requires running a daemon process
- Web UI and TUI both listed as TODO

---

### 2.2 Supergateway (supercorp-ai/supergateway)

| Field | Value |
|-------|-------|
| **Repository** | [supercorp-ai/supergateway](https://github.com/supercorp-ai/supergateway) |
| **Stars** | 2,547 |
| **Language** | TypeScript |
| **License** | MIT |
| **Install** | `npx -y supergateway` / Docker: `supercorp/supergateway` |
| **Status** | **Active** — most popular transport bridge |

#### What It Does

Supergateway is a **transport converter**, not a manager. It bridges MCP transport
protocols:

| Input | Output | Use Case |
|-------|--------|----------|
| stdio | SSE | Expose local server over HTTP |
| stdio | WebSocket | Expose over WS |
| stdio | Streamable HTTP | Expose via new HTTP streaming |
| SSE | stdio | Connect remote server locally |
| Streamable HTTP | stdio | Connect remote streaming locally |

```bash
# Expose local filesystem server over SSE
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --baseUrl http://localhost:8000

# Connect remote SSE server locally with auth
npx -y supergateway \
    --sse "https://mcp-server.example.com" \
    --oauth2Bearer "token"
```

#### Key Strengths

- Highest GitHub stars in the space (2.5K+)
- Solves real transport mismatch pain
- Docker images with pre-installed runtimes (`:uvx`, `:deno`)
- CORS, health endpoints, custom headers
- Stateful mode with session timeouts

#### Key Limitations

- **Not a manager** — only converts transport protocols
- No server discovery, installation, or configuration
- No multi-server management
- No profiles or sync

---

### 2.3 MCPHub (Jayden-Dong/MCPHub)

| Field | Value |
|-------|-------|
| **Repository** | [Jayden-Dong/MCPHub](https://github.com/Jayden-Dong/MCPHub) |
| **Stars** | ~new (Mar 2026) |
| **Status** | Early stage |

"Transforms scattered MCP servers into one unified platform. Connect your AI agent
to a single endpoint and instantly unlock unlimited tools — no more juggling dozens
of server configs. Hot-swap plugins without restart, proxy existing servers in seconds."

Similar concept to mcp-hub but newer and less mature.

---

### 2.4 Microsoft MCP Gateway

| Field | Value |
|-------|-------|
| **Repository** | [microsoft/mcp-gateway](https://github.com/microsoft/mcp-gateway) |
| **Stars** | 559 |
| **Language** | Go |
| **Status** | **Active** — enterprise-focused |

A **reverse proxy and management layer** for MCP servers in Kubernetes environments.
Provides session-aware stateful routing and lifecycle management. Enterprise-grade
but focused on K8s deployment, not local dev management.

---

## Tier 3: Registries & Directories

These provide discovery and metadata but don't manage local configurations.

### 3.1 Official MCP Registry (modelcontextprotocol/registry)

| Field | Value |
|-------|-------|
| **Repository** | [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry) |
| **Website** | [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io/) |
| **Stars** | 6,630 |
| **Language** | Go |
| **Status** | **Active** — v0.1 API freeze (Oct 2025), GA planned |

The official "app store for MCP servers" maintained by Anthropic, GitHub, PulseMCP,
and Stacklok. Functions as:

- **Discovery API** — clients query for available servers
- **Publishing platform** — auth via GitHub OAuth/OIDC, DNS, or HTTP verification
- **Namespace governance** — `io.github.user/` requires authenticating as that user

Has a **publisher CLI** (`cmd/publisher/`) for server authors. The `server.json`
format defines metadata, capabilities, and install instructions.

Integrated into VS Code, Claude Desktop, and GitHub Copilot for server discovery.

### 3.2 Glama (glama.ai)

| Field | Value |
|-------|-------|
| **Website** | [glama.ai](https://glama.ai/) |
| **Stars** | N/A (SaaS platform) |
| **Status** | **Active** — 21K+ servers listed, MCP Connectors + hosting |

Glama started as an MCP directory and evolved into a **hosting platform**:

- **Directory**: 21,000+ MCP servers indexed, searchable, with usage stats
- **Hosting**: Deploy MCP servers to Glama infrastructure
- **Connectors**: OAuth-managed connections from the Glama UI
- Has an MCP server for searching the registry itself

### 3.3 PulseMCP

| Field | Value |
|-------|-------|
| **Website** | [pulsemcp.com](https://pulsemcp.com/) |
| **Status** | **Active** — curated directory |

Curated MCP server directory with categorization, provider info, and classification
(community vs official). Focused on discovery, not management.

### 3.4 GitHub MCP Registry (github.com/mcp)

Integrated into the GitHub org-level MCP namespace. Organizations can configure
**MCP registries** that developers discover through Copilot. Documented at
[docs.github.com](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-mcp-usage/configure-mcp-registry).

---

## Tier 4: Lightweight Installers & Utilities

Smaller tools focused on one aspect of MCP management.

### 4.1 install-mcp (supermemoryai/install-mcp)

| Field | Value |
|-------|-------|
| **Repository** | [supermemoryai/install-mcp](https://github.com/supermemoryai/install-mcp) |
| **Stars** | 182 |
| **Language** | TypeScript |
| **License** | MIT |
| **Install** | `npm install -g install-mcp` |
| **Status** | **Active** |

"A simple CLI to install MCP servers into any client — auth included!" Focused on
the install step with built-in authentication handling. Lightweight alternative
to full package managers.

### 4.2 mcp-manager (nstebbins/mcp-manager)

| Field | Value |
|-------|-------|
| **Repository** | [nstebbins/mcp-manager](https://github.com/nstebbins/mcp-manager) |
| **Stars** | 25 |
| **Language** | Python |
| **License** | GPL-3.0 |
| **Status** | Early stage (v0.2.6) |

```bash
search <keyword>                    # Find servers
info <server-name>                  # Show details
install <server-name> [--client=...]  # Install for client
uninstall <server-name> [--client=...]
list                                # Show installed
config path [--client=...]          # Show config path
config set-path <path> [--client=...] # Update config path
```

Supports Claude Desktop, Cursor, Claude Code. Only 6 servers available.

### 4.3 mcpx-cli (gustavodiasdev/mcpx-cli)

| Field | Value |
|-------|-------|
| **Repository** | [gustavodiasdev/mcpx-cli](https://github.com/gustavodiasdev/mcpx-cli) |
| **Stars** | 4 |
| **Status** | Minimal |

"Interactive CLI to configure MCP servers for multiple AI providers." Supports
Claude, Codex, Copilot, and more. Very early stage.

### 4.4 mcpx (kwonye/mcpx)

| Field | Value |
|-------|-------|
| **Repository** | [kwonye/mcpx](https://github.com/kwonye/mcpx) |
| **Stars** | 0 |
| **Status** | Concept stage |

"Universal MCP server manager — install once, auth once, sync to every AI coding tool."
Closest to the agent-manager vision but appears abandoned (0 stars).

### 4.5 MCP Auto Install (@mcpmarket/mcp-auto-install)

| Field | Value |
|-------|-------|
| **npm** | `@mcpmarket/mcp-auto-install` |
| **Downloads** | 1.2K weekly |
| **Status** | Active |

An MCP server that helps install other MCP servers. Meta-tool approach — runs as
an MCP server itself and uses AI to auto-detect, install, and configure new servers.

### 4.6 mcp-cli (jritsema/mcp-cli)

| Field | Value |
|-------|-------|
| **Repository** | [jritsema/mcp-cli](https://github.com/jritsema/mcp-cli) |
| **Stars** | 12 |
| **Language** | Go |
| **License** | MIT |

"MCP CLI is a tool for managing MCP server configuration files." Lightweight Go
binary for config file manipulation.

### 4.7 mcpc (apify/mcp-cli)

| Field | Value |
|-------|-------|
| **Repository** | [apify/mcp-cli](https://github.com/apify/mcp-cli) |
| **Stars** | 437 |
| **Language** | TypeScript |

A CLI **client** for MCP (not a manager). Supports persistent sessions, stdio/HTTP,
OAuth 2.1, JSON output, and proxy for AI sandboxes. Useful for testing and debugging
MCP servers, not for managing configurations.

---

## Tier 5: GUI/Desktop Apps

### 5.1 MCP Orchestrator

| Field | Value |
|-------|-------|
| **Website** | [mcporchestrator.app](https://mcporchestrator.app/) |
| **Platform** | macOS 15+ (native Swift/SwiftUI) |
| **Status** | **Free beta** |

Native macOS app for centralized MCP management:

- **Single endpoint** — all clients point to one hub
- **Server installation** from npm, PyPI, GitHub, or local folders
- **Tool visibility control** — enable/disable individual tools before agent exposure
- **Agent Skills** — deploy SKILL.md files to supported clients
- **Background daemon** — starts at login, centralized logs
- **Supported clients**: Cursor, Claude Desktop, Claude Code, Codex

#### Key Limitations

- macOS-only
- Beta quality
- No sync, no profiles
- Closed source

### 5.2 MCPBundler

| Field | Value |
|-------|-------|
| **Website** | [mcp-bundler.com](http://mcp-bundler.com/) |
| **Platform** | macOS |
| **Status** | Active |

"Manage every MCP server and skills from one macOS app." Claims:

- Skills sync between Claude/Codex/AMP/Goose/etc
- Folders for skills/MCP servers
- Install skills from marketplaces/GitHub links
- Context-optimized output

Details limited (site is JS-heavy, minimal documentation available).

---

## Tier 6: Internal/Enterprise Tools

### 6.1 aim (AI Integration Manager) — Amazon Internal

| Field | Value |
|-------|-------|
| **CLI** | `aim` (replaces older `mcp-registry` CLI) |
| **Install** | Via Toolbox (Amazon internal package manager) |
| **Platform** | macOS, Amazon Linux |
| **Status** | **Active** — primary internal tool |

#### Full Command Tree

```
aim
├── mcp
│   ├── list [-i] [-r <registry>]    # Browse registry + installed
│   ├── install <id> [--print-client-config] [--clients=claude-code]
│   ├── uninstall <id>
│   ├── start-server
│   ├── configure
│   ├── create                        # Create MCP bundle for publishing
│   ├── create-registry               # Create custom registry
│   ├── publish                       # Publish to registry
│   └── add-service-to-registry
├── skills
│   ├── list / install / uninstall / update
├── agents
│   ├── list / install / uninstall / update
└── migrate                           # mcp-registry → aim migration
```

#### Registry Status Labels

| Status | Meaning |
|--------|---------|
| Recommended | Production-ready, officially supported |
| Supported | Maintained, stable |
| In development | May not install (BrazilVS artifact errors) |
| Under assessment | Being evaluated |

#### Key Strengths

- **Unified management** of MCP servers, skills, AND agents
- **Registry with maturity labels** — clear signal on what's production-ready
- **Auto-configuration** for Claude Code (`--clients=claude-code`)
- **Multi-server batch install** (`aim mcp install a b c`)
- **Custom registry creation** — teams can publish their own registries

#### Key Limitations

- **Amazon-internal only** — not available to public
- **No sync mechanism** — installs are machine-local
- **No profiles/subsets** — no way to group servers by workflow
- **No config format standard** — writes to client-specific JSON
- **Large registry output** (~350KB) with no built-in filtering
- **In-development servers often fail** with BrazilVS resolution errors
- **Separate from `.mcp.json`** — doesn't manage project-scoped configs

---

## Feature Comparison Matrix

| Feature | MCPM (PI) | Smithery | MCP-Hub | Supergateway | MCP Orchestrator | aim | mcp-get |
|---------|-----------|----------|---------|--------------|------------------|-----|---------|
| **Server discovery** | Registry | Registry | Marketplace | - | npm/PyPI/GH | Registry | Registry |
| **Install/uninstall** | Yes | Yes | - | - | Yes | Yes | Yes |
| **Multi-client support** | 9 clients | Agent-targeted | Any MCP client | - | 4 clients | Claude Code | Claude |
| **Profiles/subsets** | Yes | - | - | - | - | - | - |
| **Global + project scope** | Global only | Cloud | Multi-config merge | - | - | Both | - |
| **Config sync (cross-machine)** | - | Cloud account | - | - | - | - | - |
| **Git-based sync** | - | - | - | - | - | - | - |
| **TOML/YAML config** | - | - | JSON/JSON5 | - | - | JSON | JSON |
| **Human-editable dotfiles** | - | - | Yes (JSON5) | - | - | Yes | - |
| **Variable substitution** | - | - | Yes (rich) | - | - | - | - |
| **HTTP serving** | Yes | - | Yes (hub) | Yes (bridge) | Yes (daemon) | - | - |
| **Transport bridging** | - | - | - | Yes (all) | - | - | - |
| **Skills management** | - | Yes | - | - | Yes (SKILL.md) | Yes | - |
| **Agent management** | - | - | - | - | - | Yes | - |
| **Tool filtering** | - | - | Namespacing | - | Per-tool toggle | - | - |
| **OAuth/auth** | - | Yes (tokens) | OAuth 2.0+PKCE | Bearer tokens | - | Midway | - |
| **Hot-reload** | - | - | Yes (--watch) | - | - | - | - |
| **Analytics/monitoring** | `mcpm usage` | - | SSE events | - | Logs | - | - |
| **TUI interface** | Pending | - | Pending | - | - | - | - |
| **GUI** | - | Web | Pending | - | Native macOS | - | - |
| **Offline capable** | Yes | No | Yes | Yes | Yes | Yes | No |
| **Open source** | MIT | AGPL | MIT | MIT | No | No | MIT |
| **Language** | Python | TypeScript | TypeScript | TypeScript | Swift | Internal | TypeScript |

---

## Gaps Analysis

> [!warning] The Opportunity Space for agent-manager
> The following capabilities are NOT provided by ANY existing tool. This is where
> `agent-manager` can differentiate.

### 1. Git-Based Config Sync

**No tool syncs MCP/skill/agent configurations across machines using git.**

- MCPM is local-only
- Smithery uses cloud accounts (vendor lock-in)
- mcp-hub uses local JSON files
- aim is machine-local installs

The agent-manager pattern of a **git-backed dotfile repository** with automatic
push/pull is completely novel in the MCP management space.

### 2. TOML-Based Configuration

**No tool uses TOML** as its configuration format. Everything is JSON or opaque.

- mcp-hub uses JSON/JSON5 (closest to human-editable)
- Claude Code uses JSON (`~/.claude.json`, `.mcp.json`)
- VS Code uses JSON (`.vscode/mcp.json`)
- No tool supports TOML, YAML, or any format designed for human authoring

TOML with profiles, inheritance, and comments would be a significant DX improvement.

### 3. Unified Skill + MCP + Agent Config

**Only `aim` manages MCP servers, skills, AND agents** — and it's internal-only.

- MCPM manages MCP servers only
- Smithery manages MCP + skills but not agent configs
- mcp-hub manages MCP servers only
- MCP Orchestrator manages MCP + skills but not agent configs

A unified tool managing all three with a consistent config format is a gap.

### 4. Profile-Based Subsets with Inheritance

**Only MCPM has profiles**, and they're limited to server grouping.

No tool supports:
- Profile inheritance (base → project → machine-specific overrides)
- Environment-aware profiles (work vs personal)
- Conditional activation based on directory, git remote, or env vars

### 5. Cross-Client Config Generation

**No tool generates configs for ALL major clients from a single source of truth.**

- MCPM supports 9 clients but you manage within MCPM
- install-mcp supports multiple clients
- mcp-hub's single-endpoint model avoids the problem

A tool that reads a canonical TOML config and generates per-client JSON
(`.claude.json`, `.vscode/mcp.json`, `.cursor/mcp.json`, etc.) doesn't exist.

### 6. Declarative "Infrastructure as Code" for AI Tooling

**No tool supports a declarative, version-controlled manifest** that fully describes
an agent's MCP servers, skills, env vars, and configurations.

The closest is mcp-hub's JSON config with variable substitution, but it's:
- Not designed for version control
- No diffing/review workflow
- No merge conflict resolution
- No CI/CD integration

### 7. Plugin/Hook System

**No tool has a plugin architecture** for extending behavior (pre-install hooks,
post-config-change actions, custom sync backends).

### 8. Browser-Based Config Editor with OAuth

**No tool provides a web UI for editing configs** with OAuth login to git providers.
mcp-hub's web UI is TODO. Glama has a web UI for discovery but not config editing.

### 9. Offline-First with Sync

**No tool is offline-first with eventual sync.** Either they're fully local
(MCPM, mcp-hub) or fully cloud (Smithery). The git-backed model enables
offline-first with sync-when-connected.

### 10. Cross-Platform Binary Distribution

**Most tools require runtime dependencies** (Node.js, Python, Go). A single
self-contained binary (like Bun-compiled) would lower the adoption barrier
significantly. Only supergateway offers Docker as an alternative.

---

## Summary

The MCP management ecosystem is **fragmented and immature**. Most tools focus on
server discovery and installation, with minimal attention to:

- Configuration management (how you organize and maintain configs)
- Cross-machine sync (how you share configs across devices)
- Multi-concern management (servers + skills + agents together)
- Human-friendly config formats (everything is JSON)
- Declarative, version-controlled manifests

**MCPM** (pathintegral-institute) is the most complete tool today, with profiles,
multi-client support, and HTTP serving. **mcp-hub** is the most sophisticated for
runtime management (variable substitution, hot-reload, single-endpoint model).
**Smithery** leads on the commercial/hosted side with skills and auth.

But none of them solve the core problem: **managing the full stack of AI agent
configuration (MCP servers + skills + agent configs) as version-controlled,
git-synced, human-readable dotfiles with profile-based subsets.**

That's the agent-manager opportunity.
