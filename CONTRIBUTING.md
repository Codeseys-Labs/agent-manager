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

If all tests pass, you're ready.

## Project Structure

```
agent-manager/
  src/
    cli.ts                  # Entry point (citty command routing)
    commands/               # CLI command handlers (init, add, apply, etc.)
    core/                   # Config engine (TOML, resolver, diff, git, schema)
    adapters/               # Built-in adapters (one directory each)
      types.ts              # Adapter interface -- start here for adapter work
      registry.ts           # Lazy factory registry for all adapters
      claude-code/          # Reference adapter implementation
    lib/                    # Shared utilities
    mcp/                    # MCP server mode
  test/
    core/                   # Core engine tests
    adapters/               # Adapter tests (mirror src/adapters structure)
    commands/               # CLI command tests
    fixtures/               # Sample config files for testing
    helpers/                # Test utilities (temp dirs, mock configs)
  ADRs/                     # Architectural decision records
  docs/                     # Design specs and guides
  scripts/
    build.ts                # Cross-platform build script
```

## Development Workflow

### 1. Pick an Issue or Feature

Check existing issues first. For adapter work, see `docs/adapter-development-guide.md`.

### 2. Create a Branch

```bash
git checkout -b feat/cursor-adapter   # or fix/import-crash, docs/readme, etc.
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
bun test            # All tests pass
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
git commit -m "feat(adapter): add Cursor adapter with import/export/diff"
git commit -m "fix(import): handle missing mcpServers key in .claude.json"
git commit -m "test(diff): add drift detection tests for env var changes"
```

Keep commits atomic -- one logical change per commit.

### 7. Push and Open a PR

```bash
git push -u origin feat/cursor-adapter
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
- Adapter modules export a single default adapter object from `index.ts`

## How To...

### Add a CLI Command

1. Create `src/commands/<name>.ts` using citty's `defineCommand`
2. Wire it into `src/cli.ts` as a subcommand
3. Add tests in `test/commands/<name>.test.ts`

### Add an Adapter

See `docs/adapter-development-guide.md` for the full walkthrough. Summary:

1. Create `src/adapters/<name>/` with detect, import, export, diff, schema, index
2. Register the lazy factory in `src/adapters/registry.ts`
3. Add tests in `test/adapters/<name>/`

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

Design decisions are recorded in `ADRs/`. Before proposing a change that conflicts
with an existing ADR, read it first. To propose a new direction, create a new ADR
using `ADRs/template.md`.

## Questions?

Open an issue or check the design spec at `docs/2026-04-07-agent-manager-design-spec.md`.
