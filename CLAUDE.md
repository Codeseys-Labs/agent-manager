# agent-manager (`am`)

chezmoi for AI agent configs — define your MCP servers, skills, and instructions
once in TOML, sync via git, and generate native configs for every AI coding tool.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript (strict, ES2022) |
| Runtime / Bundler | Bun (`bun build --compile` for single binary) |
| CLI framework | citty (command routing) + @clack/prompts (interactive wizards) |
| Config | @iarna/toml (parser) + Zod (validation) |
| Git | isomorphic-git (pure JS, no system git dependency) |
| Output | chalk (colors), @clack/prompts (interactive) |
| Testing | bun:test |
| Linting | Biome |

## Directory Layout

```
src/
  cli.ts                        # Entry point — citty command routing with lazy subcommand imports
  commands/                     # CLI command handlers (one file per command)
    init.ts, add.ts, list.ts, use.ts, apply.ts, status.ts,
    import.ts, push.ts, pull.ts, undo.ts, log.ts, version.ts
  core/                         # Core engine — config, resolution, git, validation
    schema.ts                   # Zod schemas: Server, Instruction, Skill, Profile, Config
    config.ts                   # TOML read/write, hierarchical merge, project config
    resolver.ts                 # Profile resolution: inheritance, tag activation, merge
    git.ts                      # Git operations via isomorphic-git
    secrets.ts                  # ${VAR} interpolation from env + config.local.toml
  adapters/                     # Built-in adapters (one dir per tool)
    types.ts                    # Adapter interface: detect/import/export/diff + types
    registry.ts                 # Lazy factory registry (ADAPTER_FACTORIES map)
    claude-code/                # Claude Code adapter
      index.ts                  # Adapter entry — wires detect/import/export/diff
      detect.ts                 # Check if claude CLI is installed, find config paths
      import.ts                 # Parse ~/.claude.json + .mcp.json -> core format
      export.ts                 # Write resolved config -> native JSON + CLAUDE.md
      diff.ts                   # Structural drift detection
      identity.ts               # Server identity resolution (package, endpoint, basename)
      schema.ts                 # Claude Code-specific Zod schema
  lib/                          # Shared utilities
    output.ts                   # JSON/text output helpers (--json, --quiet, --verbose)
  mcp/                          # MCP server mode (Phase 3)

test/                           # Mirrors src/ structure
  core/                         # Unit tests for core engine
  adapters/claude-code/         # Adapter-specific tests
  commands/                     # Command integration tests
  helpers/                      # Test utilities (tmp dirs, fixtures)

ADRs/                           # 11 architectural decision records
docs/                           # Design spec
scripts/
  build.ts                      # Cross-platform build script (Bun.spawn)
```

## Architecture

**Layered Core + Adapter Extensions** (ADR-0001):

1. **Core** owns the universal schema (servers, instructions, skills, profiles) and validates it with Zod
2. **Adapters** own tool-specific extensions via `[entity.adapters.<name>]` passthrough sections
3. **Two-phase validation** (ADR-0007): Core validates core fields strictly; adapter sections are `z.record(z.string(), z.unknown())` at the core level, then each adapter validates its own section

**Config hierarchy** (highest wins):
```
CLI flags -> ENV vars -> .agent-manager.local.toml -> .agent-manager.toml -> config.local.toml -> config.toml -> defaults
```

**Git-backed everything** (ADR-0002): Durable config changes auto-commit. Ephemeral state (active profile in `state.toml`) does not.

## Key Conventions

### Bun-native

- Use `bun:test` for all tests (`describe`, `it`, `expect`)
- Use `Bun.file()`, `Bun.write()`, `Bun.spawn()` where appropriate
- Node `fs/promises` is acceptable for read/write operations (used in config.ts)

### TDD

Write failing test first, implement, verify, commit. Tests mirror `src/` structure under `test/`.

### Structured Output

Every command supports `--json` for structured output. Use the helpers in `src/lib/output.ts`:
- `output(data, opts)` — JSON when `--json`, silent otherwise
- `info(msg, opts)` — suppressed in JSON or quiet mode
- `error(msg, opts)` — structured JSON error or plain text
- `debug(msg, opts)` — only in verbose mode

### Adapter Interface

All adapters implement the `Adapter` interface from `src/adapters/types.ts`:

```typescript
interface Adapter {
  meta: AdapterMeta;           // name, displayName, version, capabilities
  detect(): DetectResult;      // Is tool installed? Where are its configs?
  import(options): ImportResult;   // native config -> core format
  export(config, options): ExportResult;  // core format -> native config files
  diff(config): DiffResult;    // detect drift between resolved and native
  schema: AdapterSchema;       // Zod schemas for adapter-specific TOML fields
}
```

### Config Hierarchy

```
~/.config/agent-manager/config.toml          # Global catalog (git-synced)
~/.config/agent-manager/config.local.toml    # Machine-specific (gitignored)
<repo>/.agent-manager.toml                   # Project config (version-controlled)
<repo>/.agent-manager.local.toml             # Personal project overrides (gitignored)
```

Override `AM_CONFIG_DIR` to change the global config location (useful in tests).

### Profile Switching

`am use <profile>` writes to `state.toml` (gitignored), NOT `config.toml`. Only `am add`, `am remove`, `am import`, and `am config edit` modify `config.toml` and auto-commit.

### Git Operations

All git operations use **isomorphic-git** (pure JS). No dependency on system `git`. This ensures the compiled binary works on machines without git installed.

### Merge Rules

| Section | Strategy |
|---------|----------|
| Servers / Skills / Instructions | Union — same-name key in higher layer wins |
| Settings / Env | Shallow merge — per-key override |
| Adapter sections | Passthrough — core preserves, adapter merges |

## How to Add a New Adapter

1. Create `src/adapters/<name>/` with these files:
   - `index.ts` — adapter entry point, wires the interface
   - `detect.ts` — check if tool is installed, return config file paths
   - `import.ts` — parse native config files into `ImportResult`
   - `export.ts` — write `ResolvedConfig` to native config files
   - `diff.ts` — structural comparison for drift detection
   - `schema.ts` — Zod schemas for this adapter's TOML extensions

2. Implement the `Adapter` interface from `src/adapters/types.ts`

3. Register in `src/adapters/registry.ts`:
   ```typescript
   // In ADAPTER_FACTORIES:
   "<name>": async () => {
     const { myAdapter } = await import("./<name>/index.ts");
     return myAdapter;
   },
   ```

4. Add tests in `test/adapters/<name>/` (detect, import, export, diff, roundtrip)

5. Add fixture files in `test/helpers/fixtures.ts` if needed

## How to Add a New Command

1. Create `src/commands/<name>.ts` exporting a `defineCommand()` from citty
2. Accept the global flags (`--json`, `--verbose`, `--quiet`, `--profile`) where relevant
3. Use `src/lib/output.ts` helpers for all user-facing output
4. Register in `src/cli.ts` subCommands:
   ```typescript
   <name>: () => import("./commands/<name>").then((m) => m.<name>Command),
   ```
5. Add tests in `test/commands/<name>.test.ts`

## How to Modify the Schema

1. Edit `src/core/schema.ts` — add/change Zod schemas
2. Update `src/core/config.ts` if merge behavior changes
3. Update `src/core/resolver.ts` if profile resolution is affected
4. Run `bun test test/core/schema.test.ts` to verify
5. Check adapter schemas if the change touches `adapters` passthrough sections

## Testing

```bash
bun test                          # Run all tests
bun test:unit                     # Core + adapter unit tests only
bun test:integration              # Integration tests only
bun test --watch                  # Watch mode
bun test test/core/schema.test.ts # Single file
```

**Test isolation:** Set `AM_CONFIG_DIR` to a temp directory to avoid touching real config. See `test/helpers/tmp.ts` for the tmpdir helper pattern.

## Building

```bash
bun run build                     # macOS arm64 binary -> dist/am-darwin-arm64
bun run build -- --all            # All 5 platform targets
bun run build -- --target bun-linux-x64  # Specific target
```

The build uses `Bun.spawn()` to invoke `bun build --compile` (the JS API doesn't support `--compile`).

## Development

```bash
bun run dev -- <command> [args]   # Run CLI in dev mode (e.g., bun run dev -- list servers)
bun run lint                      # Biome check
bun run lint:fix                  # Biome auto-fix
bun run typecheck                 # tsc --noEmit
```

## ADRs

| ADR | Decision |
|-----|----------|
| [0001](ADRs/0001-layered-core-plus-adapter-extensions.md) | Layered Core + Adapter Extensions — universal core, tool-specific escape hatches |
| [0002](ADRs/0002-git-backed-everything.md) | Git-Backed Everything — config dir is a git repo, durable changes auto-commit |
| [0003](ADRs/0003-hierarchical-config.md) | Hierarchical Config — global + project layers with defined merge rules |
| [0004](ADRs/0004-toml-config-format.md) | TOML as Configuration Format — human-friendly, supports comments |
| [0005](ADRs/0005-bidirectional-adapters.md) | Bidirectional Adapters — import + export + diff for brownfield and greenfield |
| [0006](ADRs/0006-drift-detection-over-overwrite.md) | Drift Detection Over Overwrite — detect and surface native changes, don't clobber |
| [0007](ADRs/0007-two-phase-zod-validation.md) | Two-Phase Zod Validation — core validates core, adapters validate their sections |
| [0008](ADRs/0008-profile-based-config-subsets.md) | Profile-Based Subsets — inheritance + tag activation for context switching |
| [0009](ADRs/0009-mcp-server-mode.md) | MCP Server Mode — AI agents as first-class users via `am mcp-serve` |
| [0010](ADRs/0010-bunts-single-binary.md) | BunTS Single Binary — zero runtime deps, `bun build --compile` |
| [0011](ADRs/0011-built-in-adapters.md) | Built-In Adapters — all adapters in binary, lazy factory, subprocess escape hatch |

## Git Commit Style

Follow the existing pattern: `feat:`, `fix:`, `test:`, `docs:`, `refactor:` prefix followed by a concise description. No attribution lines or co-author tags.
