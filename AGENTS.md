# AGENTS.md -- agent-manager

agent-manager (`am`) is **the control plane for AI agents**. Define your catalog
once in TOML (MCP servers, skills, instructions, agents, profiles), sync via git,
and generate native config files for every AI coding tool. Route any agent through
a unified MCP gateway. Delegate locally via ACP or remotely via A2A. Subscribe to
marketplaces. Remember sessions in an LLM-wiki. Edit from terminal, local web, or
cloud.

## Core tenets (per [ADR-0031](ADRs/0031-product-scope-and-pillars.md))

Every feature decision and audit must answer: **which of the six pillars does
this serve?** Features orthogonal to all six are flagged for reconsideration.

1. **Catalog + git sync** — define once, sync via user's choice of git backend.
2. **MCP gateway** — `am mcp-serve` as the stable endpoint any agent plumbs into.
3. **Protocol router** — ACP for local agents, A2A for remote, bridge between.
4. **Marketplace** — subscribe to git-backed catalogs of MCPs/skills/plugins/agents.
5. **LLM-wiki** — Karpathy-style session context, globally git-backed, locally mirrored.
6. **Three UIs over one core** — TUI, local web, Cloudflare web.

Underemphasized features that are still load-bearing for pillar 1:
**drift detection** (100% adapter coverage), **brownfield import** (intelligent
merge across tools), **session harvest** (cross-tool read-side pipeline feeding
pillar 5), **MCP Package Registry** (install/search/update/uninstall with
supply-chain controls).

Explicit non-goals: am is NOT a workflow orchestrator (flows serve pillar 3
composition only), NOT a hosted inference product, NOT a replacement for native
IDE UX, NOT a general-purpose dotfile manager.

## Architecture

Layered Core + Dual-Axis Adapter Extensions (ADR-0001, ADR-0013). The core engine owns
five entity types:

| Entity | Purpose | Config key |
|--------|---------|------------|
| **Servers** | MCP server definitions (command, args, env, transport). Supports `_registry` provenance for registry-installed packages. | `[servers.<name>]` |
| **Instructions** | Markdown rules with activation scope (always/glob/agent-decision/manual) | `[instructions.<name>]` |
| **Skills** | Reusable prompt/skill bundles with paths and descriptions | `[skills.<name>]` |
| **Agent Profiles** | Named agent configurations (prompt, model, tools, MCP servers) | `[agents.<name>]` |
| **Profiles** | Named config subsets with inheritance and tag-based server selection | `[profiles.<name>]` |

Each entity supports `[entity.adapters.<tool>]` subtables for tool-specific extensions
that core preserves but does not validate (two-phase validation, ADR-0007).

**13 IDE adapters** bridge the universal TOML to native formats: Claude Code, Codex CLI,
Cursor, GitHub Copilot, Windsurf, ForgeCode, Kilo Code, Kiro, Gemini CLI, Cline,
Roo Code, Amazon Q, Continue.dev. Each implements `detect() | import() | export() | diff()`.
All ship in the binary with lazy factory instantiation (ADR-0011).

**3 platform adapters** handle git remote operations: GitHub, GitLab, bare git. Detection
is URL-based, ordered by specificity (ADR-0013).

Config is hierarchical: global (`~/.config/agent-manager/config.toml`) + project
(`.agent-manager.toml`), with `.local.toml` overrides at each level. The config
directory is a git repo -- durable changes auto-commit (ADR-0002).

Secrets are encrypted at rest with AES-256-GCM (ADR-0012), stored as `enc:v1:nonce:ciphertext`
in TOML, decrypted at apply time.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | [Bun](https://bun.sh) (TypeScript, `bun build --compile` for single binary) |
| CLI | [citty](https://github.com/unjs/citty) + [@clack/prompts](https://github.com/bombshell-dev/clack) |
| Validation | [Zod](https://zod.dev) (two-phase: core strict, adapter passthrough) |
| Config | [@iarna/toml](https://github.com/iarna/iarna-toml) |
| Git | [isomorphic-git](https://isomorphic-git.org) |
| Web | [Hono](https://hono.dev) (local + Cloudflare Workers) |
| TUI | [Silvery](https://silvery.dev) + React |
| Encryption | Web Crypto API (AES-256-GCM) |
| Search | MiniSearch (BM25 for wiki full-text search) |
| Secret detection | Tiered: key-name patterns (built-in) + BetterLeaks (optional) |

## Directory Structure

```
src/
  cli.ts                    # Entry point -- 30 subcommands via citty
  commands/                 # One file per CLI command (includes session.ts, wiki.ts, agents.ts, run.ts, flow.ts, completion.ts)
  core/
    schema.ts               # Zod schemas (Server, Instruction, Skill, AgentProfile, Profile, Config)
    config.ts               # TOML read/write, 4-layer hierarchical merge, buildResolvedConfig
    resolver.ts             # Profile resolution: inheritance, tag activation, merge
    git.ts                  # Git operations (isomorphic-git)
    secrets.ts              # AES-256-GCM encryption + ${VAR} interpolation
    secret-detection.ts     # Tiered secret detection: key-name patterns + BetterLeaks
    betterleaks.ts          # BetterLeaks binary shell-out for Tier 2 scanning
    instructions.ts         # Shared instruction generation for all formats + wiki context injection
    session.ts              # Cross-tool session harvest: types, reader interface, filter/format
    agent-registry.ts       # Unified agent registry: config + ACP built-in (16) + A2A roster (ADR-0030)
  adapters/
    types.ts                # Adapter interface + all type definitions
    registry.ts             # Lazy factory adapter registry (13 adapters)
    claude-code/            # Claude Code
    codex-cli/              # Codex CLI
    copilot/                # GitHub Copilot
    cursor/                 # Cursor
    forgecode/              # ForgeCode
    kilo-code/              # Kilo Code (includes JSONC parser)
    kiro/                   # Kiro
    windsurf/               # Windsurf
    gemini-cli/             # Gemini CLI
    cline/                  # Cline (VS Code extension)
    roo-code/               # Roo Code (VS Code extension, modes)
    amazon-q/               # Amazon Q
    continue/               # Continue.dev
  registry/
    types.ts                # MCP registry package types (RegistryPackage, provenance, filters)
    client.ts               # HTTP client with LRU cache, retry, exponential backoff
  protocols/
    bridge.ts               # A2A-ACP bridge: routes A2A tasks to local ACP agents (ADR-0026 Phase 4)
    a2a/                    # Agent-to-Agent protocol (ADR-0017)
      types.ts              # Agent Card, Task, Message types
      client.ts             # A2A HTTP client for task delegation + SSE streaming
      server.ts             # A2A server endpoint handling + async tasks
      discovery.ts          # Agent roster management, URL-based + auto-discovery
      generate-card.ts      # Generate Agent Card from am config
    acp/                    # Agent Communication Protocol (ADR-0026)
      types.ts              # ACP type definitions (agent, session, update events)
      client.ts             # ACP client: spawn, stream, cancel agents headlessly
      registry.ts           # Agent resolution from config + auto-detection
      flows.ts              # Flows engine: multi-step workflow orchestration (ADR-0026 Phase 3)
  wiki/                     # LLM Wiki / Knowledge Synthesis (ADR-0020)
    types.ts                # Wiki entry, page, index types
    storage.ts              # TOML-backed wiki storage with symlinks
    harvester.ts            # Extract knowledge from sessions into wiki pages
    synthesizer.ts          # Generate context blocks and agent briefings
    ner.ts                  # Named entity recognition for auto-linking
    graph.ts                # Knowledge graph export, orphan detection
  platforms/
    types.ts                # GitPlatformAdapter interface
    registry.ts             # Platform detection (GitHub > GitLab > bare)
    github.ts, gitlab.ts, bare.ts
  mcp/
    server.ts               # MCP server: JSON-RPC 2.0, 33 tools, 6 groups, 3 permission tiers (ADR-0009, ADR-0021)
  tui/
    index.tsx, App.tsx      # Silvery/React terminal UI with dashboard, server management (D/E/I/P keys)
  web/
    server.ts               # Local Hono server (REST API + SSE, server CRUD, wiki browser endpoints)
    worker.ts               # Cloudflare Workers (stateless, multi-backend git auth, wiki browsing — ADR-0025)
    git-providers.ts        # Git provider abstraction: GitHub, GitLab, Codeberg/Gitea (ADR-0025)
    public/                 # Static HTML
  lib/                      # Shared utilities (errors.ts, output.ts)
test/                       # 146 files, 1772 tests, 5336 assertions
ADRs/                       # 30 architectural decision records
scripts/
  build.ts                  # Cross-platform build (5 targets)
  install.sh                # curl-based installer
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `am init` | First-time setup: detect tools, import configs, init git |
| `am add server <name>` | Add an MCP server (auto-commits) |
| `am list servers` | List all servers (`--active`, `--json`) |
| `am use <profile>` | Switch active profile |
| `am apply` | Generate native configs for all detected tools (`--dry-run`, `--force`) |
| `am status` | Drift detection + sync state across all tools |
| `am import <adapter>` | Import native configs into core TOML (auto-commits) |
| `am push` | Git push config to remote |
| `am pull` | Git pull from remote |
| `am undo` | Git revert HEAD |
| `am log` | Git log with am formatting |
| `am config` | View/edit configuration settings |
| `am profile` | Manage profiles (list, show, create) |
| `am doctor` | Health check: config validation, adapter status, git state |
| `am secret set/get/init` | Manage AES-256-GCM encrypted secrets |
| `am secret scan` | Audit config for unencrypted secrets (`--fix` to auto-substitute) |
| `am secret install-scanner` | Download BetterLeaks binary for Tier 2 scanning |
| `am adapter list` | Show registered adapters with install status |
| `am version` | Print version |
| `am mcp-serve` | Run as MCP server (JSON-RPC over stdio) |
| `am session list/export/search` | Cross-tool session harvest |
| `am tui` | Interactive terminal dashboard (Silvery/React) |
| `am serve` | Local web UI server (Hono) |
| `am search <query>` | Search the MCP registry for packages (`--tag`, `--verified`) |
| `am install <packages>` | Install MCP server packages from the registry (`--version`, `--dry-run`) |
| `am uninstall <name>` | Remove an MCP server package from config (`--dry-run`) |
| `am update` | Check for and apply MCP registry updates (`--dry-run`) |
| `am wiki <subcommand>` | LLM Wiki: search, add, show, delete, ingest, synthesize, briefing, export, import, lint, graph |
| `am agents <subcommand>` | A2A agent management: list, add, remove, ping, delegate |
| `am run <agent> "<prompt>"` | ACP agent orchestration: drive coding agents headlessly |
| `am run session list\|cancel` | Manage active ACP sessions |
| `am flow run\|list\|status` | Multi-step workflow orchestration (flows engine) |
| `am completion bash\|zsh\|fish` | Generate shell completion scripts |

Global flags: `--profile <name>`, `--json`, `--verbose`, `--quiet`

## Key Design Decisions

**TOML config format (ADR-0004):** Human-friendly, supports comments, validated as
the best format for developer configs.

**Git-backed everything (ADR-0002):** The config directory is a git repo. `am add`,
`am import`, `am install`, `am uninstall` auto-commit. `am push`/`am pull` sync.
`am undo` reverts. Ephemeral state (active profile) lives in gitignored `state.toml`.

**Two-phase validation (ADR-0007):** Core Zod schemas validate core fields strictly.
Adapter sections use `z.record(z.string(), z.unknown())` passthrough -- preserved by
core, validated by each adapter's own schema.

**Built-in adapters (ADR-0011):** All 13 adapters ship in the binary. Lazy factory
instantiation -- only detected tools are activated.

**Drift detection over overwrite (ADR-0006):** `am status` uses structural comparison
to detect native config edits. Surfaces drift rather than silently overwriting.

**Application-level encryption (ADR-0012):** AES-256-GCM for secrets in TOML. Key
from env var or file. Encrypted values are safe to commit to git.

**Platform adapters (ADR-0013):** GitHub, GitLab, bare git. URL-based detection for
push/pull auth handling.

**Stateless web UI (ADR-0015):** Cloudflare Workers with multi-backend git auth
(GitHub, GitLab, Codeberg, Gitea — ADR-0025), encrypted cookies, no persistent
storage. Config accessed via git provider API. Wiki browsing + server CRUD from
both local and worker web UIs.

**MCP tool grouping (ADR-0021):** `settings.mcp_serve.tools` controls which MCP tools
are exposed per profile. Enables fine-grained tool selection when running as an MCP
server gateway -- profiles can restrict tools to a subset without modifying the
underlying server definitions.

**Wiki dual location (ADR-0022):** Wiki pages live in two locations: global
(`~/.config/agent-manager/wiki/`) for cross-project knowledge, and project-level
(`.agent-manager/wiki/`) for project-specific entries. Project wikis are symlinked
into the global store for unified search. This avoids polluting repos while keeping
project context accessible.

**BM25 search for wiki (ADR-0020):** Full-text search over wiki entries uses MiniSearch
with BM25 ranking. Sessions are harvested into structured wiki pages via NER-based
entity extraction, enabling knowledge synthesis and agent briefings.

**Tiered secret detection (ADR-0023):** Two-tier approach: Tier 1 uses key-name pattern
matching (40+ provider patterns, built-in, zero dependencies). Tier 2 shells out to
BetterLeaks for value-based and inline secret detection when installed. Secrets found
during import/add are auto-substituted with `${VAR}` references and encrypted.

**MCP Registry with provenance (ADR-0024):** Registry-installed servers carry `_registry`
metadata (package name, version, installed timestamp). `am update` compares installed
versions against the registry to detect available upgrades. Provenance is preserved
through config merges and profile resolution.

**Multi-backend git auth (ADR-0025):** Cloudflare Worker supports GitHub, GitLab,
Codeberg, and self-hosted Gitea via a `GitProvider` interface that normalizes OAuth
flows and API access. Provider detection is automatic from the configured remote URL.

**ACP runtime integration (ADR-0026):** Headless agent orchestration via `am run`.
Spawn, stream output, and cancel ACP-compatible coding agents (Claude Code, Codex CLI).
4-phase design: Phase 1 (done) covers one-shot execution, session management, and
MCP tool exposure. Phase 4 (done) adds A2A-ACP bridge for remote-to-local routing.

**Unified Agent Registry (ADR-0030):** Three-source agent resolution with priority:
config agents > ACP built-in (16 known agents) > A2A roster. Same-name agents across
sources are merged (both acp + a2a protocols). The bridge uses this registry to route
incoming A2A tasks to local ACP agents.

## MCP Registry Integration

The `registry/` module provides an HTTP client for the public MCP package registry.
Features include LRU caching with TTL, exponential backoff on failure, and typed
response parsing. Registry-installed servers carry `_registry` provenance metadata
(package name, version, installed timestamp) so `am update` can detect newer versions.

Workflow: `am search` → `am install` → `am update` → `am uninstall`.

## A2A Protocol Integration

The `protocols/a2a/` module implements Google's Agent-to-Agent (A2A) protocol
(ADR-0017). Key components:

- **Agent Card generation** from am config (name, description, skills, endpoint)
- **Discovery** via `/.well-known/agent.json` URL convention
- **Client** for sending tasks to remote agents and receiving responses
- **Roster** management: persist discovered agents in config, ping for health checks

Workflow: `am agents add <url>` → `am agents ping <name>` → `am agents delegate <name> <task>`.

## Wiki / Knowledge Synthesis

The `wiki/` module (ADR-0020) provides an LLM-optimized knowledge base:

- **Harvester**: extracts structured knowledge from cross-tool session transcripts
- **NER**: named entity recognition for auto-linking wiki entries
- **Synthesizer**: generates context blocks and agent briefings from the knowledge graph
- **Graph**: entity-relationship graph with orphan detection and JSON export
- **Storage**: TOML-backed with dual location strategy (ADR-0022)

Workflow: `am wiki ingest --session <id>` → `am wiki search <query>` → `am wiki synthesize <query>`.

## Development Workflow

```bash
bun install              # Install dependencies
bun test                 # Run all 1772 tests
bun test --watch         # Watch mode
bun run dev              # Run CLI in dev mode
bun run build            # Single binary (macOS arm64)
bun run build -- --all   # All 5 platform targets
bun run lint             # Biome lint
bun run typecheck        # TypeScript checking
bun run dev:web          # Local web UI dev (Wrangler)
```

## Adding a New Adapter

Each adapter follows a 5-6 file pattern under `src/adapters/<name>/`:

1. `detect.ts` -- tool installation detection
2. `import.ts` -- native config -> core config
3. `export.ts` -- core config -> native files
4. `diff.ts` -- structural drift comparison
5. `schema.ts` -- Zod schemas for adapter TOML sections
6. `index.ts` -- wire everything, export adapter object

Register the lazy factory in `src/adapters/registry.ts`. Add tests in `test/adapters/<name>/`.

## Config Format

```toml
[settings]
default_profile = "work"

[settings.mcp_serve]
tools = ["search", "status", "apply"]   # MCP tool grouping (ADR-0021)

[servers.tavily]
command = "bunx"
args = ["tavily-mcp@latest"]
tags = ["search", "web"]
enabled = true

[servers.tavily._registry]              # Registry provenance (auto-set by am install)
package = "tavily-mcp"
version = "1.2.0"
installed_at = "2025-01-15T10:30:00Z"

[instructions.typescript-rules]
content = "Use strict TypeScript."
scope = "glob"
globs = ["**/*.ts"]

[agents.researcher]
name = "researcher"
prompt = "You are a thorough researcher..."
model = "opus"
mcp_servers = ["tavily"]

[profiles.work]
inherits = "base"
servers = ["outlook", "tavily"]
server_tags = ["work"]
instructions = ["typescript-rules"]
agents = ["researcher"]

[settings.env]
TAVILY_API_KEY = "enc:v1:abc123:ciphertext"  # Encrypted secret (AES-256-GCM)
```

Project config uses the same schema in `.agent-manager.toml` at the repo root.
Local overrides (gitignored) go in `config.local.toml` or `.agent-manager.local.toml`.
