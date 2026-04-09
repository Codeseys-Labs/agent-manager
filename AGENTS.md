# AGENTS.md -- agent-manager

agent-manager (`am`) is chezmoi for AI agent configs. Define your MCP servers, skills,
instructions, and agent profiles once in TOML, sync the config via git, and generate
native config files for every AI coding tool. Single source of truth, bidirectional
sync, profile-based subsets, drift detection.

## Architecture

Layered Core + Dual-Axis Adapter Extensions (ADR-0001, ADR-0013). The core engine owns
five entity types:

| Entity | Purpose | Config key |
|--------|---------|------------|
| **Servers** | MCP server definitions (command, args, env, transport) | `[servers.<name>]` |
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

## Directory Structure

```
src/
  cli.ts                    # Entry point -- 21 subcommands via citty
  commands/                 # One file per CLI command (includes session.ts)
  core/
    schema.ts               # Zod schemas (Server, Instruction, Skill, AgentProfile, Profile, Config)
    config.ts               # TOML read/write, 4-layer hierarchical merge, buildResolvedConfig
    resolver.ts             # Profile resolution: inheritance, tag activation, merge
    git.ts                  # Git operations (isomorphic-git)
    secrets.ts              # AES-256-GCM encryption + ${VAR} interpolation
    instructions.ts         # Shared instruction generation for all formats
    session.ts              # Cross-tool session harvest: types, reader interface, filter/format
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
  platforms/
    types.ts                # GitPlatformAdapter interface
    registry.ts             # Platform detection (GitHub > GitLab > bare)
    github.ts, gitlab.ts, bare.ts
  mcp/
    server.ts               # MCP server: JSON-RPC 2.0, 14 tools, 3 permission tiers
  tui/
    index.tsx, App.tsx      # Silvery/React terminal UI with dashboard, status, profiles
  web/
    server.ts               # Local Hono server (REST API + SSE)
    worker.ts               # Cloudflare Workers (stateless, GitHub OAuth)
    public/                 # Static HTML
  lib/                      # Shared utilities (errors.ts, output.ts)
test/                       # 106 files, 982 tests, 2604 assertions
ADRs/                       # 19 architectural decision records
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
| `am adapter list` | Show registered adapters with install status |
| `am version` | Print version |
| `am mcp-serve` | Run as MCP server (JSON-RPC over stdio) |
| `am session list/export/search` | Cross-tool session harvest |
| `am tui` | Interactive terminal dashboard (Silvery/React) |
| `am serve` | Local web UI server (Hono) |

Global flags: `--profile <name>`, `--json`, `--verbose`, `--quiet`

## Key Design Decisions

**TOML config format (ADR-0004):** Human-friendly, supports comments, validated as
the best format for developer configs.

**Git-backed everything (ADR-0002):** The config directory is a git repo. `am add`,
`am import`, `am remove` auto-commit. `am push`/`am pull` sync. `am undo` reverts.
Ephemeral state (active profile) lives in gitignored `state.toml`.

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

**Stateless web UI (ADR-0015):** Cloudflare Workers with GitHub OAuth, encrypted
cookies, no persistent storage. Config accessed via GitHub API.

## Development Workflow

```bash
bun install              # Install dependencies
bun test                 # Run all 982 tests
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

[servers.tavily]
command = "bunx"
args = ["tavily-mcp@latest"]
tags = ["search", "web"]
enabled = true

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
```

Project config uses the same schema in `.agent-manager.toml` at the repo root.
Local overrides (gitignored) go in `config.local.toml` or `.agent-manager.local.toml`.
