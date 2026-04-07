# AGENTS.md — agent-manager

agent-manager (`am`) is chezmoi for AI agent configs. Define your MCP servers, skills,
and instructions once in TOML, sync the config via git, and generate native config files
for every AI coding tool (Claude Code, Cursor, Windsurf, Copilot, Cline, and more).
Single source of truth, bidirectional sync, profile-based subsets, drift detection.

## Architecture

Layered Core + Adapter Extensions (ADR-0001). The core engine owns four entities:

| Entity | Purpose | Config key |
|--------|---------|------------|
| **Servers** | MCP server definitions (command, args, env, transport) | `[servers.<name>]` |
| **Instructions** | Markdown rules with activation scope (always/glob/manual) | `[instructions.<name>]` |
| **Skills** | Reusable prompt/skill bundles with paths and descriptions | `[skills.<name>]` |
| **Profiles** | Named subsets with inheritance, tag-based server selection | `[profiles.<name>]` |

Each entity supports `[entity.adapters.<tool>]` subtables for tool-specific extensions
that core preserves but does not validate (two-phase validation, ADR-0007).

Adapters implement `detect() | import() | export() | diff()` to bridge between the
universal TOML config and each tool's native format. All adapters are built into the
binary with lazy factory instantiation (ADR-0011).

Config is hierarchical: global (`~/.config/agent-manager/config.toml`) + project
(`.agent-manager.toml`), with `.local.toml` overrides at each level. The config
directory is a git repo — durable changes auto-commit (ADR-0002).

## Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | [Bun](https://bun.sh) (TypeScript, `bun build --compile` for single binary) |
| CLI | [citty](https://github.com/unjs/citty) (command routing) + [@clack/prompts](https://github.com/bombshell-dev/clack) (wizards) |
| Validation | [Zod](https://zod.dev) (two-phase: core strict, adapter passthrough) |
| Config | [@iarna/toml](https://github.com/iarna/iarna-toml) (TOML parse/stringify) |
| Git | [isomorphic-git](https://isomorphic-git.org) |
| Formatting | [chalk](https://github.com/chalk/chalk) |

## Directory Structure

```
src/
  cli.ts                    # Entry point — citty command routing
  commands/                 # One file per CLI command (init, add, list, use, apply, ...)
  core/
    config.ts               # TOML read/write
    resolver.ts             # Profile resolution + hierarchical merge
    diff.ts                 # Structural drift detection engine
    git.ts                  # Git operations (isomorphic-git)
    schema.ts               # Core Zod schemas (Server, Instruction, Skill, Profile, Config)
    identity.ts             # Server identity matching for import dedup
    secrets.ts              # ${VAR} interpolation
  adapters/
    types.ts                # Adapter interface + all type definitions
    registry.ts             # Lazy factory adapter registry
    claude-code/            # Claude Code adapter (detect/import/export/diff)
  mcp/                      # MCP server mode (am mcp-serve)
  lib/                      # Shared utilities
test/
  core/                     # Unit tests for core modules
  adapters/                 # Adapter-specific tests
  commands/                 # CLI command integration tests
  fixtures/                 # Sample native config files per tool
  helpers/                  # Test utilities (temp dirs, config builders)
  integration/              # End-to-end tests
ADRs/                       # 11 architectural decision records
research/                   # Research documents (tool formats, prior art)
docs/                       # Design specifications
scripts/
  build.ts                  # Cross-platform binary build script
```

## Key Design Decisions

**TOML config format (ADR-0004):** Human-friendly, supports comments, validated as
the best format for developer configs via adversarial review.

**Git-backed everything (ADR-0002):** The config directory is a git repo. `am add`,
`am import`, `am remove` auto-commit. `am push`/`am pull` sync. `am undo` reverts.
Ephemeral state (active profile) lives in gitignored `state.toml`.

**Two-phase validation (ADR-0007):** Core Zod schemas validate core fields strictly.
Adapter sections use `z.record(z.string(), z.unknown())` passthrough — preserved by
core, validated by each adapter's own schema.

**Built-in adapters (ADR-0011):** All adapters ship in the binary. Lazy factory
instantiation — only detected tools are activated. No external plugin loading in Phase 1.

**Drift detection over overwrite (ADR-0006):** `am status` uses structural comparison
(not textual diff) to detect when a user edited native configs directly. Surfaces drift
rather than silently overwriting. `am apply --force` to override.

**Bidirectional adapters (ADR-0005):** Every adapter implements `import()` (native to
core), `export()` (core to native), and `diff()` (detect drift). Brownfield-friendly.

## Development Workflow

```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun test --watch         # Watch mode
bun run dev              # Run CLI in dev mode (bun run src/cli.ts)
bun run dev -- init      # Run a specific command
bun run build            # Compile single binary (scripts/build.ts)
bun run lint             # Biome lint + format check
bun run lint:fix         # Auto-fix lint issues
bun run typecheck        # TypeScript type checking
```

**TDD workflow:** Write a failing test -> implement the minimum code -> verify all
tests pass -> commit. Tests live next to the code they test, mirroring the `src/` structure.

**Environment override:** Set `AM_CONFIG_DIR` to use a temp directory as the config
root during testing. All tests that touch the filesystem must use isolated temp dirs.

## Adding a New Adapter

Each adapter follows a 5-file pattern:

```
src/adapters/<name>/
  index.ts      # Implements the Adapter interface (detect, import, export, diff)
  schema.ts     # Zod schemas for adapter-specific TOML fields
  detect.ts     # Tool installation detection (optional, can inline in index)
  import.ts     # Native config -> core config mapping
  export.ts     # Core config -> native config file generation
```

Steps:
1. Create the adapter directory under `src/adapters/`
2. Implement the `Adapter` interface from `src/adapters/types.ts`
3. Register it in `src/adapters/registry.ts` (lazy factory entry)
4. Add test fixtures in `test/fixtures/<name>/` with sample native configs
5. Write tests in `test/adapters/<name>/`

The `Adapter` interface requires:
- `meta` — name, displayName, version, capabilities list
- `detect()` — returns `{ installed: boolean, version?, paths }` 
- `import(options)` — reads native configs, returns servers/instructions/skills
- `export(config, options)` — writes native config files from resolved config
- `diff(config)` — compares resolved config vs native files, returns drift status
- `schema` — Zod schemas for validating `[entity.adapters.<name>]` sections

## Testing Conventions

- **Runner:** `bun:test` (built into Bun)
- **Isolation:** Every test that touches the filesystem creates a temp dir and cleans
  up after. Use `AM_CONFIG_DIR` env var to redirect config operations.
- **Fixtures:** `test/fixtures/` contains sample native config files for each tool
  (e.g., `claude-code/.claude.json`, `cursor/.cursor/mcp.json`)
- **Helpers:** `test/helpers/` provides utilities for creating temp config dirs and
  building test configs
- **Structure:** `test/core/` mirrors `src/core/`, `test/adapters/` mirrors
  `src/adapters/`, `test/commands/` tests CLI command handlers

## CLI Commands

| Command | Description |
|---------|-------------|
| `am init` | First-time setup: detect installed tools, import configs, init git |
| `am add server <name>` | Add an MCP server to config (auto-commits) |
| `am list servers` | List all servers (supports `--active`, `--json`) |
| `am use <profile>` | Switch active profile + auto-apply |
| `am apply` | Generate native configs for all detected tools (`--dry-run`, `--force`) |
| `am status` | Show drift detection + sync state across all tools (`--json`) |
| `am import <adapter>` | Import native configs into core TOML (auto-commits) |
| `am push` | Git push config to remote |
| `am pull` | Git pull + auto-apply |
| `am undo` | Git revert HEAD + re-apply |
| `am log` | Git log with am formatting |
| `am version` | Print version |

Global flags: `--profile <name>`, `--json`, `--verbose`, `--quiet`

## Config Format

```toml
# ~/.config/agent-manager/config.toml

[settings]
default_profile = "work"

[servers.tavily]
command = "bunx"
args = ["tavily-mcp@latest"]
transport = "stdio"
description = "Web search"
tags = ["search", "web"]
enabled = true

[servers.tavily.adapters.claude-code]
always_allow = ["tavily_search"]

[instructions.typescript-rules]
content = "Use strict TypeScript. Prefer interface over type."
scope = "glob"
globs = ["**/*.ts"]
description = "TypeScript conventions"

[skills.research]
path = "skills/research"
description = "Deep research skill"
tags = ["research"]

[profiles.base]
description = "Always-on utilities"
servers = ["tavily"]

[profiles.work]
inherits = "base"
servers = ["outlook", "slack"]
server_tags = ["work"]
instructions = ["typescript-rules"]

[adapters.claude-code]
permission_mode = "allowEdits"
model = "opus[1m]"
```

Project-level config uses the same schema in `.agent-manager.toml` at the repo root.
Local overrides (gitignored) go in `config.local.toml` or `.agent-manager.local.toml`.
