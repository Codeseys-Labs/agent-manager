# agent-manager (`am`)

chezmoi for AI agent configs -- define your MCP servers, skills, instructions,
and agent profiles once in TOML, sync via git, and generate native configs for
every AI coding tool.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript (strict, ES2022) |
| Runtime / Bundler | Bun (`bun build --compile` for single binary) |
| CLI framework | citty (command routing) + @clack/prompts (interactive wizards) |
| Config | @iarna/toml (parser) + Zod (validation) |
| Git | isomorphic-git (pure JS, no system git dependency) |
| Web framework | Hono (local server + Cloudflare Workers) |
| TUI | Silvery + React (terminal dashboard) |
| Encryption | Web Crypto API (AES-256-GCM) |
| Output | @clack/prompts (interactive) |
| Testing | bun:test (1470 tests across 134 files) |
| Search | MiniSearch (BM25 for wiki full-text search) |
| Secret detection | Tiered: key-name patterns (built-in) + BetterLeaks (optional) |
| Linting | Biome |

## Directory Layout

```
src/                                 # 165 TypeScript files
  cli.ts                             # Entry point -- citty command routing with 28 lazy subcommands
  help.ts                            # Grouped help output for root command (ADR-0029)
  commands/                          # CLI command handlers (one file per command)
    init.ts, add.ts, list.ts, use.ts, apply.ts, status.ts,
    config.ts, profile.ts, doctor.ts, import.ts, push.ts, pull.ts,
    undo.ts, log.ts, secret.ts, version.ts, adapter.ts,
    mcp-serve.ts, serve.ts, tui.ts, session.ts, init-project.ts,
    search.ts, install.ts, uninstall.ts, update.ts, wiki.ts, agents.ts, run.ts
  core/                              # Core engine -- config, resolution, git, validation, encryption
    schema.ts                        # Zod schemas: Server, Instruction, Skill, AgentProfile, Profile, Config, ProjectConfig
    config.ts                        # TOML read/write, hierarchical merge (4 layers), project config, buildResolvedConfig
    resolver.ts                      # Profile resolution: inheritance chains, tag activation, server/skill/agent/instruction merge
    git.ts                           # Git operations via isomorphic-git (init, commit, push, pull, revert, status, log)
    secrets.ts                       # AES-256-GCM encryption + ${VAR} interpolation + async decrypt walk
    secret-detection.ts              # Tiered secret detection: key-name patterns + BetterLeaks shell-out
    betterleaks.ts                   # BetterLeaks binary management: detect, install, scan
    instructions.ts                  # Shared instruction generation: CLAUDE.md, AGENTS.md, .mdc, steering, .windsurf rules, copilot
    session.ts                       # Cross-tool session harvest: types, SessionReader interface, filter/format/estimation
  adapters/                          # 13 built-in IDE adapters
    types.ts                         # Adapter interface: detect/import/export/diff + SessionReader + all type definitions
    registry.ts                      # Lazy factory registry (ADAPTER_FACTORIES map + cache)
    claude-code/                     # Claude Code: ~/.claude.json, .mcp.json, CLAUDE.md
    codex-cli/                       # Codex CLI: ~/.codex/config.yaml, AGENTS.md
    copilot/                         # GitHub Copilot: .vscode/mcp.json, .github/instructions/*.md
    cursor/                          # Cursor: ~/.cursor/mcp.json, .cursor/rules/*.mdc
    forgecode/                       # ForgeCode: ~/.forgecode/mcp_settings.json
    kilo-code/                       # Kilo Code: ~/.kilo-code/mcp_settings.json, JSONC parsing
    kiro/                            # Kiro: .kiro/mcp.json, .kiro/steering/*.md
    windsurf/                        # Windsurf: ~/.windsurf/mcp.json, .windsurf/rules/*.md
    gemini-cli/                      # Gemini CLI: ~/.gemini/settings.json, GEMINI.md
    cline/                           # Cline: VS Code globalStorage, cline_mcp_settings.json, .clinerules
    roo-code/                        # Roo Code: VS Code globalStorage, roo_mcp_settings.json, .roo/rules
    amazon-q/                        # Amazon Q: ~/.aws/amazonq/mcp.json
    continue/                        # Continue.dev: ~/.continue/config.json
    shared/                          # Shared adapter utilities
      utils.ts                       # Common adapter helper functions
      diff-utils.ts                  # Shared diff/drift detection utilities
  registry/                          # MCP package registry client
    types.ts                         # RegistryPackage, provenance, filter types
    client.ts                        # HTTP client with LRU cache, retry, exponential backoff
  protocols/                         # Agent communication protocols
    a2a/                             # Agent-to-Agent protocol (ADR-0017)
      types.ts                       # Agent Card, Task, Message types
      client.ts                      # A2A HTTP client for task delegation
      server.ts                      # A2A server endpoint handling
      discovery.ts                   # Agent roster management, URL-based discovery
      generate-card.ts               # Generate Agent Card from am config
    acp/                             # Agent Communication Protocol (ADR-0026)
      types.ts                       # ACP type definitions (agent, session, update events)
      client.ts                      # ACP client: spawn, stream, cancel agents headlessly
      registry.ts                    # Agent resolution from config + auto-detection
  wiki/                              # LLM Wiki / Knowledge Synthesis (ADR-0020)
    types.ts                         # Wiki entry, page, index types
    storage.ts                       # TOML-backed wiki storage with symlinks
    harvester.ts                     # Extract knowledge from sessions into wiki pages
    synthesizer.ts                   # Generate context blocks and agent briefings
    ner.ts                           # Named entity recognition for auto-linking
    graph.ts                         # Knowledge graph export, orphan detection
  platforms/                         # 3 git platform adapters
    types.ts                         # GitPlatformAdapter interface (detect, pushUrl, pullUrl, auth)
    registry.ts                      # Platform detection from remote URL (ordered by specificity)
    github.ts                        # GitHub platform adapter
    gitlab.ts                        # GitLab platform adapter
    bare.ts                          # Bare git fallback
  mcp/                               # MCP server mode
    server.ts                        # JSON-RPC 2.0 over stdio, 33 tools, 6 groups, 3 permission tiers (ADR-0009)
  tui/                               # Terminal UI (Silvery + React)
    index.tsx                        # TUI launcher
    App.tsx                          # Root component with tab navigation
    Dashboard.tsx                    # Main dashboard view
    StatusView.tsx                   # Drift status display
    ProfileSwitcher.tsx              # Interactive profile switching
    HelpView.tsx                     # Help/keybindings view
    data.ts                          # Data loading for TUI
  web/                               # Web UI
    server.ts                        # Local Hono server: REST API + SSE events + static dashboard
    worker.ts                        # Cloudflare Workers: stateless, GitHub OAuth, encrypted cookies, GitHub API
    public/                          # Static HTML (index.html, login.html)
  lib/                               # Shared utilities
    errors.ts                        # Shared error types (AmError) and formatting
    output.ts                        # JSON/text output helpers (--json, --quiet, --verbose)
    toml.ts                          # TOML parsing/serialization helpers

test/                                # 134 test files, 1470 tests, 4312 assertions
  core/                              # Unit tests for core modules
  adapters/                          # Adapter-specific tests (per-adapter directories)
  commands/                          # CLI command integration tests
  fixtures/                          # Sample native config files per tool
  helpers/                           # Test utilities (tmp dirs, config builders)
  integration/                       # End-to-end tests

ADRs/                                # 29 architectural decision records
docs/                                # Design specs and guides
scripts/
  build.ts                           # Cross-platform build (5 targets via Bun.spawn)
  install.sh                         # curl-based installer (platform detection)
```

## Architecture

**Layered Core + Dual-Axis Adapter Extensions** (ADR-0001, ADR-0013):

1. **Core** owns the universal schema (servers, instructions, skills, agent profiles, config profiles) and validates it with Zod
2. **IDE adapters** (13) bridge core TOML to each tool's native format: detect, import, export, diff
3. **Platform adapters** (3) handle git remote URL detection and auth: GitHub, GitLab, bare
4. **Two-phase validation** (ADR-0007): Core validates core fields strictly; adapter sections are `z.record(z.string(), z.unknown())` at the core level, then each adapter validates its own section
5. **MCP server mode** (ADR-0009): agent-manager as an MCP tool server with 33 tools across 6 groups and 3 permission tiers
6. **Stateless web UI** (ADR-0015): Cloudflare Workers with GitHub OAuth, encrypted cookies, no persistent storage

**Config hierarchy** (highest wins):
```
CLI flags -> ENV vars -> .agent-manager.local.toml -> .agent-manager.toml -> config.local.toml -> config.toml -> defaults
```

**Git-backed everything** (ADR-0002): Durable config changes auto-commit. Ephemeral state (active profile in `state.toml`) does not.

**AES-256-GCM encryption** (ADR-0012): Secrets are encrypted with `am secret set`, stored as `enc:v1:nonce:ciphertext` in TOML, decrypted at apply time. Key from `AM_ENCRYPTION_KEY` env var or `.agent-manager/key.txt`.

## Key Conventions

### Bun-native

- Use `bun:test` for all tests (`describe`, `it`, `expect`)
- Use `Bun.file()`, `Bun.write()`, `Bun.spawn()` where appropriate
- Node `fs/promises` is acceptable for read/write operations (used in config.ts)
- Adapter files use inline `require("node:fs")` for lazy synchronous filesystem access within try/catch blocks. This is intentional — adapters need synchronous operations and lazy loading. Top-level ESM imports are preferred elsewhere.

### TDD

Write failing test first, implement, verify, commit. Tests mirror `src/` structure under `test/`.

### Structured Output

Every command supports `--json` for structured output. Use the helpers in `src/lib/output.ts`:
- `output(data, opts)` -- JSON when `--json`, silent otherwise
- `info(msg, opts)` -- suppressed in JSON or quiet mode
- `error(msg, opts)` -- structured JSON error or plain text
- `debug(msg, opts)` -- only in verbose mode

### Adapter Interface

All 13 IDE adapters implement the `Adapter` interface from `src/adapters/types.ts`:

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

### Platform Adapter Interface

The 3 platform adapters in `src/platforms/` implement `GitPlatformAdapter`:

```typescript
interface GitPlatformAdapter {
  meta: { name: string; displayName: string };
  detect(remoteUrl: string): boolean;   // Does this URL match this platform?
  // Platform-specific push/pull URL handling
}
```

Detection is ordered by specificity (GitHub > GitLab > bare fallback).

### Config Hierarchy

```
~/.config/agent-manager/config.toml          # Global catalog (git-synced)
~/.config/agent-manager/config.local.toml    # Machine-specific (gitignored)
<repo>/.agent-manager.toml                   # Project config (version-controlled)
<repo>/.agent-manager.local.toml             # Personal project overrides (gitignored)
```

Override `AM_CONFIG_DIR` to change the global config location (useful in tests).

### Profile Switching

`am use <profile>` writes to `state.toml` (gitignored), NOT `config.toml`. Only `am add`, `am import`, `am install`, `am uninstall`, and `am config edit` modify `config.toml` and auto-commit.

### Git Operations

All git operations use **isomorphic-git** (pure JS). No dependency on system `git`. This ensures the compiled binary works on machines without git installed.

### Merge Rules

| Section | Strategy |
|---------|----------|
| Servers / Skills / Instructions / Agents | Union -- same-name key in higher layer wins |
| Settings / Env | Shallow merge -- per-key override |
| Adapter sections | Passthrough -- core preserves, adapter merges |

## How to Add a New IDE Adapter

1. Create `src/adapters/<name>/` with these files:
   - `index.ts` -- adapter entry point, wires the interface
   - `detect.ts` -- check if tool is installed, return config file paths
   - `import.ts` -- parse native config files into `ImportResult`
   - `export.ts` -- write `ResolvedConfig` to native config files
   - `diff.ts` -- structural comparison for drift detection
   - `schema.ts` -- Zod schemas for this adapter's TOML extensions

2. Implement the `Adapter` interface from `src/adapters/types.ts`

3. Register in `src/adapters/registry.ts`:
   ```typescript
   "<name>": async () => {
     const { myAdapter } = await import("./<name>/index.ts");
     return myAdapter;
   },
   ```

4. Add tests in `test/adapters/<name>/` (detect, import, export, diff, roundtrip)

5. Add fixture files in `test/helpers/fixtures.ts` if needed

## How to Add a New Platform Adapter

1. Create `src/platforms/<name>.ts` implementing the `GitPlatformAdapter` interface
2. Add the adapter to the `PLATFORMS` array in `src/platforms/registry.ts` (order matters -- more specific first)
3. Add tests verifying URL detection and platform-specific behavior

## How to Add a New CLI Command

1. Create `src/commands/<name>.ts` exporting a `defineCommand()` from citty
2. Accept the global flags (`--json`, `--verbose`, `--quiet`, `--profile`) where relevant
3. Use `src/lib/output.ts` helpers for all user-facing output
4. Register in `src/cli.ts` subCommands:
   ```typescript
   <name>: () => import("./commands/<name>").then((m) => m.<name>Command),
   ```
5. Add tests in `test/commands/<name>.test.ts`

## How to Add an MCP Tool

1. Add a `ToolEntry` to the `defineTools()` array in `src/mcp/server.ts`
2. Choose the appropriate tier: `read-only`, `write-local`, or `write-remote`
3. Define the JSON Schema for input parameters
4. Implement the async handler function
5. Write-remote tools require explicit opt-in via `settings.mcp_serve` in config.toml

## How to Modify the Schema

1. Edit `src/core/schema.ts` -- add/change Zod schemas
2. Update `src/core/config.ts` if merge behavior changes
3. Update `src/core/resolver.ts` if profile resolution is affected
4. Run `bun test test/core/schema.test.ts` to verify
5. Check adapter schemas if the change touches `adapters` passthrough sections

## Testing

```bash
bun test                          # Run all 1470 tests
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

Targets: `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64`.
The build uses `Bun.spawn()` to invoke `bun build --compile` (the JS API doesn't support `--compile`).

## Development

```bash
bun run dev -- <command> [args]   # Run CLI in dev mode (e.g., bun run dev -- list servers)
bun run lint                      # Biome check
bun run lint:fix                  # Biome auto-fix
bun run typecheck                 # tsc --noEmit
bun run dev:web                   # Cloudflare Workers local dev
bun run deploy:web                # Deploy to Cloudflare Workers
```

## ADRs

| ADR | Decision |
|-----|----------|
| [0001](ADRs/0001-layered-core-plus-adapter-extensions.md) | Layered Core + Adapter Extensions -- universal core, tool-specific escape hatches |
| [0002](ADRs/0002-git-backed-everything.md) | Git-Backed Everything -- config dir is a git repo, durable changes auto-commit |
| [0003](ADRs/0003-hierarchical-config.md) | Hierarchical Config -- global + project layers with defined merge rules |
| [0004](ADRs/0004-toml-config-format.md) | TOML as Configuration Format -- human-friendly, supports comments |
| [0005](ADRs/0005-bidirectional-adapters.md) | Bidirectional Adapters -- import + export + diff for brownfield and greenfield |
| [0006](ADRs/0006-drift-detection-over-overwrite.md) | Drift Detection Over Overwrite -- detect and surface native changes, don't clobber |
| [0007](ADRs/0007-two-phase-zod-validation.md) | Two-Phase Zod Validation -- core validates core, adapters validate their sections |
| [0008](ADRs/0008-profile-based-config-subsets.md) | Profile-Based Subsets -- inheritance + tag activation for context switching |
| [0009](ADRs/0009-mcp-server-mode.md) | MCP Server Mode -- AI agents as first-class users via `am mcp-serve` |
| [0010](ADRs/0010-bunts-single-binary.md) | BunTS Single Binary -- zero runtime deps, `bun build --compile` |
| [0011](ADRs/0011-built-in-adapters.md) | Built-In Adapters -- all adapters in binary, lazy factory, subprocess escape hatch |
| [0012](ADRs/0012-application-level-encryption.md) | Application-Level Encryption -- AES-256-GCM, platform-agnostic secret storage |
| [0013](ADRs/0013-git-platform-adapters.md) | Git Platform Adapters -- GitHub, GitLab, bare git with URL-based detection |
| [0014](ADRs/0014-workspace-profile-import.md) | Workspace-to-Profile Import -- import from existing workspace configs |
| [0015](ADRs/0015-stateless-web-ui.md) | Stateless Web UI -- git-backed, independently deployable, encrypted cookies |
| [0016](ADRs/0016-session-harvest.md) | Session Harvest -- cross-tool conversation export via SessionReader interface |
| [0017](ADRs/0017-agent-communication-protocol.md) | Multi-Protocol Agent Integration -- MCP, A2A, and ACP protocol landscape |
| [0018](ADRs/0018-tui-framework-silvery.md) | TUI Framework -- Ink to Silvery migration |
| [0019](ADRs/0019-security-hardening.md) | Security Hardening -- threat model and fixes |
| [0020](ADRs/0020-session-knowledge-synthesis.md) | Session Knowledge Synthesis -- LLM Wiki with BM25 search |
| [0021](ADRs/0021-mcp-tool-grouping-and-gateway.md) | MCP Tool Grouping -- per-profile tool selection for MCP server mode |
| [0022](ADRs/0022-wiki-location-strategy.md) | Wiki Location Strategy -- dual global + project wiki with symlinks |
| [0023](ADRs/0023-tiered-secret-detection.md) | Tiered Secret Detection -- key-name patterns + BetterLeaks |
| [0024](ADRs/0024-mcp-registry-integration.md) | MCP Registry Integration -- package install with provenance tracking |
| [0025](ADRs/0025-worker-multi-backend-auth.md) | Worker Multi-Backend Git Auth -- GitHub, GitLab, Codeberg, self-hosted Gitea |
| [0026](ADRs/0026-acpx-acp-runtime-integration.md) | ACP Runtime Integration via ACPX -- 4-phase plan for headless agent orchestration |
| [0027](ADRs/0027-community-adapter-loading.md) | Community Adapter Loading -- JSON-RPC subprocess, npm/git install, adapters.toml |
| [0028](ADRs/0028-brownfield-import-merge.md) | Brownfield Import Merge -- two-tier identity matching, interactive conflict resolution |
| [0029](ADRs/0029-command-grouping.md) | Command Grouping -- grouped help output for root command, gh CLI pattern |

## Git Commit Style

Follow the existing pattern: `feat:`, `fix:`, `test:`, `docs:`, `refactor:` prefix followed by a concise description. No attribution lines or co-author tags.
