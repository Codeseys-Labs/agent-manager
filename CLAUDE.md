# agent-manager (`am`)

**The control plane for AI agents.** Define your catalog once in TOML (MCP servers,
skills, instructions, agents, profiles), sync via git, generate native configs for
every AI coding tool, route any agent through a unified MCP gateway, delegate via
ACP (local) or A2A (remote), subscribe to marketplaces, remember sessions in an
LLM-wiki, edit from terminal, local web, or cloud.

## Core tenets (ADR-0031)

Every feature decision must answer: **which of the six pillars does this serve?**

1. **Catalog + git sync** — entity types (servers/instructions/skills/agents/
   profiles), user's git choice, brownfield import (ADR-0028), drift detection
   (ADR-0006), AES-256-GCM secret hygiene, MCP Package Registry (ADR-0024).
2. **MCP gateway** — `am mcp-serve`, 38 tools across 6 groups, concurrency-safe writers
   (iter4 Wave B), bearer auth (iter2 Wave B), streaming via MCP
   notifications/progress (iter4 Wave D).
3. **Protocol router** — ACP local, A2A remote, bridge, unified `am_agent_*`
   tools, agent auto-detection (iter4 Wave C), flows (ADR-0026) scoped to
   pillar 3 composition.
4. **Marketplace** — git-backed catalogs, supply-chain hardened (SHA pinning,
   TOFU, `--ignore-scripts`). Distinct from Registry per ADR-0032.
5. **LLM-wiki** (Karpathy) — session harvest (ADR-0016) feeds the wiki;
   without harvest the wiki is an empty shelf. Global git-backed + per-project
   mirror. `am wiki` CLI + MCP `am_wiki_*`.
6. **Three UIs over one core** — TUI, local web, Cloudflare web; route
   through `core/controller.ts`.

Features orthogonal to all six are flagged for reconsideration. Non-goals are
enumerated in [ADR-0031](ADRs/0031-product-scope-and-pillars.md). Terminology
(catalog vs config vs Registry vs Marketplace) is locked in
[ADR-0032](ADRs/0032-terminology-glossary.md).

**ACP agent tiers.** The flat 16-entry built-in ACP agent list was split into
three explicit tiers in [ADR-0033](ADRs/0033-acp-agent-tiers-and-shim-wrapper.md):
tier-1-native (spawnable directly — `claude`, `codex`, `gemini`, `kiro`),
tier-2-shim (spawnable via `am-acp-shell` after `am agent enable-shim <name>`
— `aider`, `amazon-q`, `cody`), and tier-3-catalog-only (config-only, used
from native IDE UI — `cline`, `continue`, `copilot`, `cursor`, `kilo-code`,
`roo-code`, `windsurf`). `am apply` writes config for all three; only tier-1
and opt-in tier-2 are `am run`-able. Tier-2 shims inherit the wrapped CLI's
trust posture and do NOT interpose on file-write permissions — read ADR-0033
before enabling one.


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
| Testing | bun:test (2906 tests across 222 files) |
| Search | MiniSearch (BM25 for wiki full-text search) |
| Secret detection | Tiered: key-name patterns (built-in) + BetterLeaks (optional) |
| Linting | Biome |

## Directory Layout

```
src/                                 # 199 TypeScript files
  cli.ts                             # Entry point -- citty command routing with 31 lazy subcommands
  acp-shell-cli.ts                   # Secondary binary entry point for am-acp-shell (ADR-0033 Phase B tier-2 shim wrapper)
  help.ts                            # Grouped help output for root command (ADR-0029)
  commands/                          # CLI command handlers (one file per command)
    init.ts, add.ts, list.ts, use.ts, apply.ts, status.ts,
    config.ts, profile.ts, doctor.ts, import.ts, push.ts, pull.ts,
    undo.ts, log.ts, secret.ts, version.ts, adapter.ts,
    mcp-serve.ts, serve.ts, tui.ts, session.ts, init-project.ts,
    search.ts, install.ts, uninstall.ts, update.ts, wiki.ts, agents.ts, run.ts,
    flow.ts, completion.ts, marketplace.ts
  core/                              # Core engine -- config, resolution, git, validation, encryption
    schema.ts                        # Zod schemas: Server, Instruction, Skill, AgentProfile, Profile, Config, ProjectConfig
    config.ts                        # TOML read/write, hierarchical merge (4 layers), project config, buildResolvedConfig
    resolver.ts                      # Profile resolution: inheritance chains, tag activation, server/skill/agent/instruction merge
    git.ts                           # Git operations via isomorphic-git (init, commit, push, pull, revert, status, log)
    secrets.ts                       # AES-256-GCM encryption + ${VAR} interpolation + async decrypt walk
    secret-detection.ts              # Tiered secret detection: key-name patterns + BetterLeaks shell-out
    betterleaks.ts                   # BetterLeaks binary management: detect, install, scan
    instructions.ts                  # Shared instruction generation: CLAUDE.md, AGENTS.md, .mdc, steering, .windsurf rules, copilot + wiki context injection
    session.ts                       # Cross-tool session harvest: types, SessionReader interface, filter/format/estimation
    agent-registry.ts                # Unified agent registry: config + tiered ACP built-in + A2A roster, merged resolution (ADR-0030, tier split per ADR-0033)
  adapters/                          # 13 built-in IDE adapters
    types.ts                         # Adapter interface: detect/import/export/diff + SessionReader + all type definitions
    registry.ts                      # Lazy factory registry (ADAPTER_FACTORIES map + cache)
    claude-code/                     # Claude Code: ~/.claude.json, .mcp.json, CLAUDE.md + plugin marketplace scanner
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
      marketplace-vscode.ts          # VS Code extension marketplace scanner (shared across Cursor, Copilot, Kiro, Windsurf)
    community/                       # Community adapter loading (ADR-0027)
      types.ts                       # CommunityAdapterConfig, adapters.toml types
      proxy.ts                       # JSON-RPC subprocess proxy wrapping Adapter interface
      loader.ts                      # Read/write adapters.toml, lazy proxy cache
  registry/                          # MCP package registry client
    types.ts                         # RegistryPackage, provenance, filter types
    client.ts                        # HTTP client with LRU cache, retry, exponential backoff
  marketplace/                       # Git-based plugin marketplace
    types.ts                         # Marketplace entry, plugin manifest types
    client.ts                        # Clone/update/remove marketplace repos
    scanner.ts                       # Scan marketplace repos for available plugins
    installer.ts                     # Install/uninstall plugins from marketplaces
  protocols/                         # Agent communication protocols
    bridge.ts                        # A2A-ACP bridge: routes A2A tasks to local ACP agents (ADR-0026 Phase 4)
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
      flows.ts                       # Flows engine: multi-step workflow orchestration (ADR-0026 Phase 3)
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
    server.ts                        # JSON-RPC 2.0 over stdio, 38 tools (core=14, registry=3, a2a=4, wiki=5, session=3, acp=9), 3 permission tiers (ADR-0009, ADR-0021)
  tui/                               # Terminal UI (Silvery + React)
    index.tsx                        # TUI launcher
    App.tsx                          # Root component with tab navigation
    Dashboard.tsx                    # Main dashboard view
    StatusView.tsx                   # Drift status display
    ProfileSwitcher.tsx              # Interactive profile switching
    HelpView.tsx                     # Help/keybindings view
    data.ts                          # Data loading for TUI
  web/                               # Web UI
    server.ts                        # Local Hono server: REST API + SSE events + static dashboard + wiki browser
    worker.ts                        # Cloudflare Workers: stateless, multi-backend git auth, wiki browsing (ADR-0025)
    git-providers.ts                 # Git provider abstraction: GitHub, GitLab, Codeberg/Gitea (ADR-0025)
    public/                          # Static HTML (index.html, login.html)
  lib/                               # Shared utilities
    errors.ts                        # Shared error types (AmError) and formatting
    output.ts                        # JSON/text output helpers (--json, --quiet, --verbose)
    toml.ts                          # TOML parsing/serialization helpers

test/                                # 222 test files, 2906 tests, 9122 assertions
  core/                              # Unit tests for core modules
  adapters/                          # Adapter-specific tests (per-adapter directories)
  commands/                          # CLI command integration tests
  fixtures/                          # Sample native config files per tool
  helpers/                           # Test utilities (tmp dirs, config builders)
  integration/                       # End-to-end tests

ADRs/                                # 52 architectural decision records
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
5. **MCP server mode** (ADR-0009): agent-manager as an MCP tool server with 38 tools across 6 groups and 3 permission tiers
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
bun test                          # Run all tests (2906)
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
| [0030](ADRs/0030-unified-agent-registry.md) | Unified Agent Registry -- config + ACP + A2A merged resolution, protocol routing |
| [0031](ADRs/0031-product-scope-and-pillars.md) | Product Scope and Pillars -- the six-pillar model |
| [0031a](ADRs/0031a-pillar-6-amendment.md) | Pillar 6 Amendment — Local-Write-Path Scope Clarification (amends ADR-0031) |
| [0032](ADRs/0032-terminology-glossary.md) | Terminology Glossary -- Registry vs Marketplace, catalog vs config |
| [0033](ADRs/0033-acp-agent-tiers-and-shim-wrapper.md) | ACP Agent Tiers and Shim Wrapper -- tier-1-native / tier-2-shim / tier-3-catalog-only |
| [0034](ADRs/0034-shim-scope-and-inclusion-criteria.md) | Scope Fence for First-Party ACP Shims |
| [0035](ADRs/0035-community-shim-registration.md) | Community Shim Registration Protocol |
| [0036](ADRs/0036-agent-variants.md) | Per-Agent Variants for Multi-Provider / Multi-Account Routing |
| [0037](ADRs/0037-per-tool-mcp-metadata.md) | Per-Tool MCP Metadata via `x-am.*` Namespace |
| [0038](ADRs/0038-dry-run-explain-surface.md) | Dry-Run / Explain Surface Pattern |
| [0039](ADRs/0039-marketplace-v1-scope-decision.md) | Marketplace v1 Scope Decision — retire pillar 4 in favor of MCP Registry + git-subtree bundles |
| [0040](ADRs/0040-controller-scope-and-concurrency.md) | Controller Scope & Concurrency Model — `withConfig` + AsyncMutex |
| [0041](ADRs/0041-adr-0007-phase-2-deferred.md) | ADR-0007 Phase 2 Resolution — Delete the Adapter Schema Field |
| [0042](ADRs/0042-universal-secrets-strategy.md) | Universal Secrets Strategy — age envelope + Argon2id passphrase + OS keychain cache |
| [0043](ADRs/0043-hosted-ui-auth-and-git-backend-tiers.md) | Hosted UI Auth + Git Backend Tiers |
| [0044](ADRs/0044-wiki-two-tier-copy-materialisation.md) | Wiki Two-Tier Materialisation — Copy Over Symlink, Project-Level + Global Store |
| [0045](ADRs/0045-hosted-ui-editor-codemirror.md) | Hosted UI Editor — CodeMirror 6 Default, Monaco Optional for Local |
| [0046](ADRs/0046-reject-team-passphrase-schema.md) | Reject `team_passphrase` Field in Schema — Force Per-Recipient Identity |
| [0047](ADRs/0047-am-pair-cross-device-key-handoff.md) | `am pair` cross-device key handoff via git-native rendezvous |
| [0048](ADRs/0048-hosted-ui-auth-implementation.md) | Hosted UI Auth Implementation Plan |
| [0049](ADRs/0049-hosted-ui-editor-cm6-implementation.md) | Hosted UI Editor CodeMirror 6 Implementation Plan |
| [0050](ADRs/0050-browser-secret-decryption-bundle.md) | Browser Secret Decryption Bundle (Synthesizes Lens H + Clarification) |
| [0051](ADRs/0051-secrets-rotation-grace-period.md) | Secrets Rotation + Grace Period (Synthesizes Lens I) |

## Git Commit Style

Follow the existing pattern: `feat:`, `fix:`, `test:`, `docs:`, `refactor:` prefix followed by a concise description. No attribution lines or co-author tags.

<!-- mulch:start -->
## Project Expertise (Mulch)
<!-- mulch-onboard:v0.10.0 -->

This project uses [Mulch](https://github.com/jayminwest/mulch) v0.10.0 for structured expertise management.

**At the start of every session**, run:
```bash
ml prime
```

Injects project-specific conventions, patterns, decisions, failures, references, and guides into
your context. Run `ml prime --files src/foo.ts` before editing a file to load only records
relevant to that path (per-file framing, classification age, and confirmation scores included).

For monolith projects where dumping every record wastes context, set
`prime.default_mode: manifest` in `.mulch/mulch.config.yaml` (or pass `--manifest`) to emit a
quick reference + domain index. Agents then scope-load with `ml prime <domain>` or
`ml prime --files <path>`.

**Before completing your task**, record insights worth preserving — conventions discovered,
patterns applied, failures encountered, or decisions made:
```bash
ml record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
```

Evidence auto-populates from git (current commit + changed files). Link explicitly with
`--evidence-seeds <id>` / `--evidence-gh <id>` / `--evidence-linear <id>` / `--evidence-bead <id>`,
`--evidence-commit <sha>`, or `--relates-to <mx-id>`. Upserts of named records merge outcomes
instead of replacing them; validation failures print a copy-paste retry hint with missing fields
pre-filled.

Run `ml status` for domain health, `ml doctor` to check record integrity (add `--fix` to strip
broken file anchors), `ml --help` for the full command list. Write commands use file locking and
atomic writes, so multiple agents can record concurrently. Expertise survives `git worktree`
cleanup — `.mulch/` resolves to the main repo.

`ml prune` soft-archives stale records to `.mulch/archive/` instead of deleting them; pass
`--hard` for true deletion. Restore an archived record with `ml restore <id>`. Do not read
`.mulch/archive/` directly — those records are stale by definition. If you need historical
context, run `ml search --archived <query>`.

### Before You Finish

If you discovered conventions, patterns, decisions, or failures worth preserving during
this session, record them before closing:

```bash
ml learn                                                                    # see what files changed
ml record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
ml sync                                                                     # validate, stage, commit
```

Skip if no insight surfaced. Unrecorded learnings are lost; ritual filler records are also noise.
<!-- mulch:end -->

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard:v0.4.5 -->
<!-- seeds-onboard-schema:4 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) v0.4.5 for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows. Pass `--format json|compact|markdown|plain|ids` on any command for agent-friendly output.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd search <query>` — Full-text search across titles + descriptions
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd dep add <id> <depends-on>` — Add dependency between issues
- `sd sync` — Sync with git (run before pushing)

### Planning
Use `sd plan` when work is large or ambiguous enough that an LLM benefits from structured decomposition. Submit spawns one child seed per step; `step.blocks` uses forward semantics (step i with `blocks: [j]` means step i blocks step j, and step j gets step i's id in its `blockedBy`).

- `sd plan templates` — List built-ins (`feature`, `bug`, `refactor`) plus custom templates
- `sd plan prompt <seed-id>` — Emit a structured prompt the LLM fills in
- `sd plan submit <seed-id> --plan <file>` — Validate + spawn child seeds
- `sd plan show <pl-id>` — View sections, children, sub-plans
- `sd plan outcome <pl-id> --result success|partial|failure` — Record outcome (storage-only)
- `sd plan review <pl-id> --by <name>` — Record reviewer (informational)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->

<!-- canopy:start -->
## Prompt Management (Canopy)
<!-- canopy-onboard-v:2 -->

This project uses [Canopy](https://github.com/jayminwest/canopy) for git-native prompt management.

**At the start of every session**, run:
```
cn prime
```

This injects prompt workflow context: commands, conventions, and common workflows.

**Quick reference:**
- `cn list` — List all prompts
- `cn render <name>` — View rendered prompt (resolves inheritance)
- `cn emit --all` — Render prompts to files
- `cn update <name>` — Update a prompt (creates new version)
- `cn sync` — Stage and commit .canopy/ changes

**Do not manually edit emitted files.** Use `cn update` to modify prompts, then `cn emit` to regenerate.

**Mulch metadata:** Prompts can declare expertise dependencies via `mulch.prime.domains`, `mulch.prime.files`, `mulch.budget`, `mulch.on_empty`, plus a top-level `extends_mulch` flag (override-by-default; merge with parent when `true`). Canopy never shells out to `ml` — `cn render --json` surfaces the resolved declaration in a top-level `mulch` field for consumers to act on. See SPEC.md "Mulch Metadata".
<!-- canopy:end -->
