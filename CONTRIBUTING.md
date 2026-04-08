# Contributing to agent-manager

Thanks for your interest in contributing to agent-manager (`am`) -- the chezmoi for
AI agent configs. This guide covers setup, workflow, and conventions.

## Prerequisites

- **Bun** 1.3+ -- runtime, bundler, test runner, and package manager
- **Git** -- version control (also used internally by `am` for config sync)

Verify your setup:

```bash
bun --version   # 1.3.0+
git --version   # 2.x+
```

## Setup

```bash
git clone https://github.com/baladithyab/agent-manager.git
cd agent-manager
bun install
bun test
```

If all 647 tests pass, you're ready.

## Project Structure

```
agent-manager/
  src/
    cli.ts                  # Entry point (citty, 20 subcommands)
    commands/               # CLI command handlers (20 files)
    core/                   # Config engine (TOML, resolver, git, schema, secrets, instructions)
      schema.ts             # Zod schemas (Server, Instruction, Skill, AgentProfile, Profile, Config)
      config.ts             # TOML read/write, hierarchical 4-layer merge
      resolver.ts           # Profile resolution with inheritance chains
      git.ts                # Git operations (isomorphic-git)
      secrets.ts            # AES-256-GCM encryption + ${VAR} interpolation
      instructions.ts       # Shared instruction generation for all output formats
    adapters/               # 8 built-in IDE adapters
      types.ts              # Adapter interface -- start here for adapter work
      registry.ts           # Lazy factory registry for all adapters
      claude-code/          # Reference adapter (808 lines, 7 files)
      codex-cli/            # Codex CLI adapter (781 lines)
      copilot/              # GitHub Copilot adapter (726 lines)
      cursor/               # Cursor adapter (886 lines)
      forgecode/            # ForgeCode adapter (717 lines)
      kilo-code/            # Kilo Code adapter (1280 lines, includes JSONC parser)
      kiro/                 # Kiro adapter (938 lines)
      windsurf/             # Windsurf adapter (673 lines)
    platforms/              # 3 git platform adapters
      types.ts              # GitPlatformAdapter interface
      registry.ts           # Platform detection from remote URL
      github.ts, gitlab.ts, bare.ts
    mcp/                    # MCP server mode (JSON-RPC over stdio)
      server.ts             # 10 tools across 3 permission tiers
    tui/                    # Terminal UI (Ink + React)
    web/                    # Web UI (Hono local + Cloudflare Workers)
    lib/                    # Shared utilities (output.ts)
  test/
    core/                   # Core engine tests
    adapters/               # Adapter tests (mirror src/adapters structure)
    commands/               # CLI command tests
    fixtures/               # Sample config files for testing
    helpers/                # Test utilities (temp dirs, mock configs)
    integration/            # End-to-end tests
  ADRs/                     # 15 architectural decision records
  docs/                     # Design specs and guides
  scripts/
    build.ts                # Cross-platform build script (5 targets)
    install.sh              # curl-based installer
```

## Development Workflow

### 1. Pick an Issue or Feature

Check existing issues first. For adapter work, see `docs/adapter-development-guide.md`.

### 2. Create a Branch

```bash
git checkout -b feat/new-adapter   # or fix/import-crash, docs/readme, etc.
```

### 3. Write Tests First (TDD)

Write failing tests before implementation. Tests live in `test/` mirroring the `src/`
structure:

```bash
# Run all tests
bun test

# Run a specific test file
bun test test/adapters/claude-code/detect.test.ts

# Watch mode during development
bun test --watch
```

### 4. Implement

Keep changes focused. One feature or fix per PR.

### 5. Validate

```bash
bun test            # All 647 tests pass
bun run lint        # Biome linting + formatting
bun run typecheck   # TypeScript type checking
```

All three must pass before pushing.

### 6. Commit

Use conventional commit messages:

| Prefix | Use for |
|--------|---------|
| `feat:` | New features (new command, new adapter, new capability) |
| `fix:` | Bug fixes |
| `docs:` | Documentation only |
| `test:` | Test additions or fixes |
| `build:` | Build system, dependencies, CI |
| `refactor:` | Code restructuring without behavior change |
| `chore:` | Maintenance tasks |

Examples:

```bash
git commit -m "feat(adapter): add Kilo Code adapter with JSONC parsing"
git commit -m "fix(import): handle missing mcpServers key in .claude.json"
git commit -m "test(diff): add drift detection tests for env var changes"
```

Keep commits atomic -- one logical change per commit.

### 7. Push and Open a PR

```bash
git push -u origin feat/new-adapter
```

Open a PR against `main`. Describe what changed and why. Include test evidence.

## Code Style

**Biome** handles linting and formatting. No ESLint or Prettier config needed.

```bash
bun run lint        # Check
bun run lint:fix    # Auto-fix
```

Key conventions:
- TypeScript strict mode -- no `any` types
- Prefer `interface` over `type` for object shapes
- Use named exports (not default exports) for functions
- Adapter modules export a single adapter object from `index.ts`

## How To...

### Add a CLI Command

1. Create `src/commands/<name>.ts` using citty's `defineCommand`
2. Wire it into `src/cli.ts` as a subcommand
3. Add tests in `test/commands/<name>.test.ts`

### Add an IDE Adapter

See `docs/adapter-development-guide.md` for the full walkthrough. Summary:

1. Create `src/adapters/<name>/` with detect, import, export, diff, schema, index
2. Register the lazy factory in `src/adapters/registry.ts`
3. Add tests in `test/adapters/<name>/`

Study the existing adapters for patterns:
- **Claude Code** (808 lines) -- reference implementation, 7 files
- **Kilo Code** (1280 lines) -- most complex, includes JSONC parser
- **Windsurf** (673 lines) -- simplest, good starting point

### Add a Platform Adapter

Platform adapters handle git remote URL detection and auth:

1. Create `src/platforms/<name>.ts` implementing `GitPlatformAdapter` from `src/platforms/types.ts`
2. Add to the `PLATFORMS` array in `src/platforms/registry.ts` (order by specificity -- more specific first, bare last)
3. Write tests for URL detection patterns

### Add an MCP Tool

MCP tools are defined in `src/mcp/server.ts`:

1. Add a `ToolEntry` to the `defineTools()` function
2. Choose the permission tier: `read-only`, `write-local`, or `write-remote`
3. Define the JSON Schema for input parameters
4. Implement the async handler function
5. Write-remote tools require opt-in via `settings.mcp_serve` in config.toml (ADR-0009)

### Modify the Core Schema

1. Edit the Zod schemas in `src/core/schema.ts`
2. Update `src/adapters/types.ts` if the change affects the adapter interface
3. Update affected adapters and their tests
4. Document the change in an ADR if it's a design decision

### Extend Config

Config is TOML-based with two-phase validation (ADR-0007):
- **Phase 1 (core):** `src/core/schema.ts` validates universal fields
- **Phase 2 (adapter):** Each adapter's `schema.ts` validates its `[adapters.<name>]` sections

To add a new core field, update the Zod schema and the `Resolved*` types in `types.ts`.
To add an adapter-specific field, update only that adapter's `schema.ts`.

## Architecture Decisions

Design decisions are recorded in [15 ADRs](ADRs/README.md). Before proposing a change
that conflicts with an existing ADR, read it first. To propose a new direction, create
a new ADR using `ADRs/template.md`.

## Questions?

Open an issue or check the design spec at `docs/2026-04-07-agent-manager-design-spec.md`.
