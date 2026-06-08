# AGENTS.md -- agent-manager

> **Canonical agent-instruction file.** This is the single source of truth for
> agents and contributors working on agent-manager. `CLAUDE.md` is a thin pointer
> to this file (the project's own thesis: one definition, many tools — so we do
> not maintain two divergent copies). When facts change, edit AGENTS.md.

agent-manager (`am`) is **the control plane for AI agents**. Define your catalog
once in TOML (MCP servers, skills, instructions, agents, profiles), sync via git,
and generate native config files for every AI coding tool. Route any agent through
a unified MCP gateway. Delegate locally via ACP or remotely via A2A. Install MCP
servers from the registry and vendor skills/instructions/agents via git. Remember
sessions in an LLM-wiki. Edit from terminal, local web, or cloud.

### North star (evaluate every change against this)

`am` is a **one-stop-shop control plane** that works **both outside AND inside the
agent** — a CLI a developer uses to manage agents (a2a remote / acp local / plain
CLI), AND the MCP server those agents call to use `am`'s functionality *from inside
a session*. "Inside and outside the agent, `am` helps." Audience: **individual
developers first.** The load-bearing pillars of that vision:

1. **MCP gateway + runtime access-scoping.** Profiles scope a user's **access** to
   everything they have — tools (live, ADR-0055), and progressively skills / agents
   / knowledge — and the gateway optimizes operational **token** usage. Scope is a
   runtime boundary, not just apply-time config.
2. **Git-backed superset with CLI ⇄ UI parity.** One canonical git-backed config a
   UI operates on the **same repo**, so onboard/offboard of tools/skills/agents/
   profiles works **identically** via CLI and UI. The shared `core/controller.ts`
   write path is what makes parity a reach-problem, not an architecture one.
3. **Project- AND user-level LLM-wiki** knowledge, readable by humans **and** agents.
4. **Absorb single-purpose tools** (ContextHub / seeds / mulch-class) into one tool
   for end users (note: seeds/mulch/canopy are `am`'s OWN dev tooling today).
5. **Future:** AWS AgentCore Gateway + Registry interop (greenfield; needs a remote
   MCP transport — ADR-0056).

When weighing a feature or a review comment, ask: *does this advance the git-backed
superset that CLI+UI both operate on, for an individual dev managing inside-and-
outside-agent workflows?* See `ADRs/0031` (scope/pillars) and `ADRs/0055` (the
access-scoping keystone).

## Core tenets (per [ADR-0031](ADRs/0031-product-scope-and-pillars.md))

Every feature decision and audit must answer: **which of the six pillars does
this serve?** Features orthogonal to all six are flagged for reconsideration.

1. **Catalog + git sync** — define once, sync via user's choice of git.
   Includes brownfield import (ADR-0028), drift detection (ADR-0006), secret
   hygiene (AES-256-GCM + 40+ provider-pattern detection — covering env vars,
   inline command/arg secrets, AND URL query-param credentials like
   `?tavilyApiKey=…`, all auto-obfuscated to `${VAR}` + encrypted on
   add/import and decrypted at apply), MCP Package Registry (ADR-0024).
2. **MCP gateway** — `am mcp-serve` as the stable endpoint any agent plumbs
   into. 44 tools (39 canonical + 5 deprecated aliases that still dispatch to
   their replacements; alias removal targeted for v1.0), concurrency-safe
   writers (iter4 Wave B), bearer auth (iter2 Wave B), streaming via MCP
   progress notifications (iter4 Wave D).
3. **Protocol router** — ACP local, A2A remote, A2A-ACP bridge, unified agent
   registry (ADR-0030), **auto-detection of installed agents** (iter4 Wave C),
   flows (ADR-0026) scoped to pillar 3 composition.
4. **Marketplace (deferred to v2)** — git-backed catalogs of skills /
   instructions / agent bundles, supply-chain hardened (SHA pinning, TOFU,
   `--ignore-scripts`). **Deferred, not deleted:** the marketplace surface is
   paused until the hosted web platform is live (the v2 era it pairs with), so
   it is kept out of the v1 CLI's advertised surface but the code in
   `src/marketplace/*` is retained. For v1, use the MCP Package Registry
   (`am search/install`) for servers and git subtree/submodule vendoring for
   skills, instructions, and agent-profile bundles.
   NOTE: ADR-0039 (retire) and ADR-0052 (schedule code deletion) are
   **superseded by this product decision** — do NOT execute the marketplace
   deletion; it returns in v2.
5. **LLM-wiki** — Karpathy-style session context. Session harvest (ADR-0016)
   is the cross-tool read pipeline — without it, pillar 5 is an empty shelf.
   Global git-backed + per-project local mirror. `am wiki` + MCP `am_wiki_*`.
6. **Three editing surfaces, one local write path** — TUI (`am tui`) and
   local web (`am serve`) both route writes through `core/controller.ts`
   via `withConfig` + `applyResolved`; no parallel admission/apply paths
   on the user's machine. The Cloudflare Worker UI is an independently-
   deployed git-over-HTTP client per [ADR-0015](ADRs/0015-stateless-web-ui.md)
   and ADR-0031a — it does NOT share `src/core/*`, cannot apply to native
   IDE files, and treats the config repo as the source of truth.

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
  cli.ts                    # Entry point -- 37 subcommands via citty
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
    agent-registry.ts       # Unified agent registry: config + tiered ACP built-in + A2A roster (ADR-0030, ADR-0033)
    controller.ts           # shared write path: withConfig (serialized RMW) + applyResolved + APPLY_SAFE_DEFAULTS (ADR-0040)
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
    server.ts               # MCP server: JSON-RPC 2.0, 44 tools (39 canonical + 5 deprecated aliases that still dispatch; removal targeted v1.0), 6 groups, 3 permission tiers, runtime access-scoping (ADR-0009, ADR-0055 supersedes ADR-0021)
  tui/
    index.tsx, App.tsx      # Silvery/React terminal UI with dashboard, server management (D/E/I/P keys)
  web/
    server.ts               # Local Hono server (REST API + SSE, server CRUD, wiki browser endpoints)
    worker.ts               # Cloudflare Workers (stateless, multi-backend git auth, wiki browsing — ADR-0025)
    git-providers.ts        # Git provider abstraction: GitHub, GitLab, Codeberg/Gitea (ADR-0025)
    public/                 # Static HTML
  lib/                      # Shared utilities (errors.ts, output.ts)
test/                       # 284 files, 3670 tests, 11482 assertions
ADRs/                       # 57 architectural decision records (0001-0056, incl. 0031a)
scripts/
  build.ts                  # Cross-platform build (5 targets)
install.sh                  # curl-based installer (repo root, not scripts/)
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `am setup` | Guided first-run wizard (ADR-0053): detect → import → key + profile → apply → health check. Idempotent; `--yes`/`--json`/`--from <git-url>` for CI/onboarding |
| `am init` | First-time setup: detect tools, init git (run `am import auto` to import existing configs) |
| `am add server <name>` | Add an MCP server (auto-commits) |
| `am list servers` | List all servers (`--active`, `--json`) |
| `am use <profile>` | Switch active profile |
| `am apply` | Generate native configs for all detected tools. Fail-closed by default (SEC-4b/4c): a live apply runs `adapter.diff()` and SKIPS any tool whose native config has drifted out of band rather than overwriting it; `--force` overwrites, `--diff` shows the per-tool drift summary, `--dry-run` previews. The same `APPLY_SAFE_DEFAULTS` posture is shared verbatim by MCP (`am_apply`), web (`POST /api/apply`), and the TUI apply button. |
| `am status` | Drift detection + sync state across all tools |
| `am import <adapter>` | Import native configs into core TOML (auto-commits) |
| `am push` | Git push config to remote |
| `am pull` | Git pull from remote |
| `am undo` | Git revert HEAD |
| `am log` | Git log with am formatting |
| `am config` | View/edit configuration settings |
| `am profile` | Manage profiles (list, show, create, delete); `am profile show <name> --tools` prints the MCP access scope the profile grants (ADR-0055) |
| `am doctor` | Health check: config validation, adapter status, git state |
| `am secret set/get/list/generate-key` | Manage AES-256-GCM encrypted secrets (`generate-key` creates the key; also `import-key`) |
| `am secret scan` | Audit config for unencrypted secrets (`--fix` to auto-substitute) |
| `am secret install-scanner` | Download BetterLeaks binary for Tier 2 scanning |
| `am adapter list` | Show registered adapters with install status |
| `am version` | Print version |
| `am mcp-serve` | Run as MCP server (JSON-RPC over stdio) |
| `am mcp-superset` | Reconcile the project `.mcp.json` to be a superset of global `~/.claude.json` MCP servers |
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
| `am marketplace …` | **Deferred to v2** (kept, not deleted — supersedes ADR-0039/0052). Deprecated commands print a notice; prefer `am search/install` + git-vendored bundles |
| `am pair` | Cross-device age-key handoff via git-native rendezvous (ADR-0047) |
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

**MCP tool grouping (ADR-0021):** `settings.mcp_serve.tools` is the GLOBAL tool-group
ceiling — a discovery-time filter over the 6 groups (core/registry/a2a/wiki/session/acp).

**Runtime access-scoping profiles (ADR-0055, supersedes ADR-0021's global-only model):**
the active profile's optional `[profiles.<name>.scope]` projects a RUNTIME access
boundary over the MCP tool surface, intersected with the global ceiling (the ceiling is
absolute — scope can only NARROW, never widen):

```toml
[profiles.locked.scope]
tool_groups = ["core", "wiki"]   # narrow within the global ceiling
allow_tools = ["am_registry_search"]  # re-include a specific tool (still within ceiling)
deny_tools  = ["am_apply"]       # remove a specific tool (deny wins)
```

Enforced at BOTH `tools/list` (hide) AND `tools/call` (refuse with -32601) — hiding alone
is not a boundary. A profile WITHOUT `scope` is unchanged (global ceiling). The connection
selects its profile via the `initialize` param `capabilities.experimental["am.profile"]`
or the `AM_MCP_PROFILE` env var (stdio is one-client-per-process). Per-session scoping over
a shared HTTP transport is Phase 2 (depends on ADR-0056's remote transport).

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
config agents > ACP built-in > A2A roster. Same-name agents across sources are merged
(both acp + a2a protocols). The bridge uses this registry to route incoming A2A tasks
to local ACP agents.

**Tiered ACP agents (ADR-0033):** The flat 16-entry built-in list was split into
three explicit tiers. `am apply` writes config for all three; `am run` respects the
tier on spawn.

| Tier | Spawnable | Set |
|------|-----------|-----|
| 1 — Native | yes, directly | `claude`, `codex`, `gemini`, `kiro` |
| 2 — Shim   | yes, after `am agent enable-shim <name>` | `aider`, `amazon-q`, `cody` |
| 3 — Catalog-only | no — config-only, use from native UI | `cline`, `continue`, `copilot`, `cursor`, `kilo-code`, `roo-code`, `windsurf` |

Tier 2 wrappers inherit the wrapped CLI's trust posture — they do NOT interpose
on file-write permissions. See ADR-0033 for the full security analysis.

### Adding a Tier-2 shim

Tier-2 entries live in `src/protocols/acp/shell-wrapper.ts` (`BUILT_IN_SHIMS`
map) and in `BUILT_IN_AGENTS` in `src/core/agent-registry.ts` with
`tier: "tier-2-shim"` and `command: ""`. A shim entry needs:

1. An entry in `BUILT_IN_AGENTS` with the tier and an empty `command` string
   (so `resolveAgent` returns `runnable: false` until the user opts in).
2. An entry in `BUILT_IN_SHIMS` in `shell-wrapper.ts` with the wrapped
   CLI command, flag wiring, and a user-facing `--help` banner (including
   the trust-posture caveat).
3. An entry in `AGENT_BINARIES` in `src/core/agent-detection.ts` so
   `am agent detect <name>` truthfully reports whether the wrapped CLI is
   installed.
4. A test in `test/protocols/acp/shell-wrapper.test.ts`.

`am agent enable-shim <name>` writes
`[agents.<name>].adapters.acp.command = "am-acp-shell <name>"` into the user's
config — that's how opt-in flows through the Unified Agent Registry.

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
bun test                 # Run all 3670 tests
bun test --watch         # Watch mode
bun run dev              # Run CLI in dev mode
bun run build            # Single binary (macOS arm64)
bun run build -- --all   # All 5 platform targets
bun run lint             # Biome lint
bun run typecheck        # TypeScript checking
bun run dev:web          # Local web UI dev (Wrangler)
```

## Adding a New Adapter

Each adapter follows a 5-file core pattern under `src/adapters/<name>/`, plus
optional helpers. The `Adapter` interface is four behavioral methods only —
the old `schema.ts` / `schema` field was deleted per ADR-0041, so do NOT create
one (it is loaded by nothing):

1. `detect.ts` -- tool installation detection
2. `import.ts` -- native config -> core config
3. `export.ts` -- core config -> native files
4. `diff.ts` -- structural drift comparison
5. `index.ts` -- wire everything, export adapter object

Optional per-adapter files (present only where needed): `identity.ts` (server
identity matching), `session.ts` (SessionReader for harvest), `marketplace.ts`
(VS Code extension scan), and format helpers like `jsonc.ts` / `yaml.ts`.

Register the lazy factory in `src/adapters/registry.ts`. Add tests in `test/adapters/<name>/`.

## Adding a New Platform Adapter

1. Create `src/platforms/<name>.ts` implementing the `GitPlatformAdapter` interface
2. Add the adapter to the `PLATFORMS` array in `src/platforms/registry.ts` (order matters -- more specific first)
3. Add tests verifying URL detection and platform-specific behavior

## Adding a New CLI Command

1. Create `src/commands/<name>.ts` exporting a `defineCommand()` from citty
2. Accept the global flags (`--json`, `--verbose`, `--quiet`, `--profile`) where relevant
3. Use `src/lib/output.ts` helpers for all user-facing output
4. Register in `src/cli.ts` subCommands:
   ```typescript
   <name>: () => import("./commands/<name>").then((m) => m.<name>Command),
   ```
5. Add tests in `test/commands/<name>.test.ts`

## Adding an MCP Tool

1. Add a `ToolEntry` to the `defineTools()` array in `src/mcp/server.ts`
2. Choose the appropriate tier: `read-only`, `write-local`, or `write-remote`
3. Define the JSON Schema for input parameters
4. Implement the async handler function
5. Write-remote tools require explicit opt-in via `settings.mcp_serve` in config.toml

## Modifying the Schema

1. Edit `src/core/schema.ts` -- add/change Zod schemas
2. Update `src/core/config.ts` if merge behavior changes
3. Update `src/core/resolver.ts` if profile resolution is affected
4. Run `bun test test/core/schema.test.ts` to verify
5. Adapter `[entity.adapters.<tool>]` sections are opaque passthrough (ADR-0007/0041) — core preserves them; there is no adapter-side Zod schema to update

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

## How We Work (AI-assisted development model)

This project is built primarily through AI-orchestrated development. The
following practices are **the default working model** — internalize them; you do
not need to be re-told them each session.

### 1. Research before acting
Never implement on incomplete information. For anything involving an unfamiliar
library, an external best practice, a security/crypto decision, or "how do others
do this", **research first** using the available MCP tools — Tavily
(`tavily_search`/`tavily_research`), Exa (`web_search_exa`/`get_code_context_exa`),
and DeepWiki (`ask_question` against real GitHub repos) — and WebFetch/context7 for
canonical docs. Write findings to `docs/research/<slug>.md` before writing code.

### 2. Orchestrate with workflows and subagents
Substantial work is run as **multi-agent workflows**, not one linear pass. The
canonical shape is **investigate → deep-dive → architect → plan → act → review**,
fanning out parallel subagents within each phase and sequencing the phases. Use the
deep-work-loop process for vision-driven, multi-phase efforts (commit-state →
backlog-audit → research → architect-with-ADRs → plan-in-waves → parallel-execution
→ concurrent-review → iterate-until-empty → final-verify). A **separate review team
runs concurrently** with execution and feeds findings back into the backlog in real
time. Adversarially verify findings against ground truth before acting on them —
agent reports can be confidently wrong (e.g. a claimed "missing file" that exists).

### 3. Parallel branches + worktrees, with a deterministic rebase plan
When work parallelizes, run each strand in an **isolated git worktree** on its own
`wave/N-<slug>` branch, partitioned by **disjoint file ownership** so branches are
conflict-free by construction. Shared "hub" files (`README.md`, `ROADMAP.md`,
`src/cli.ts`, `src/help.ts`) are owned by exactly one wave or edited only as
follow-ups on `main`. **Merge order = wave order** (lowest first); after each merge,
open branches rebase onto `main` (a sync, not a conflict-resolution, because of the
disjoint write-sets). The full rule lives in
`docs/audit/assessment-2026-05-31/INTEGRATION-PLAN.md` — follow it when fanning out.

### 4. Stacked PRs + layered review (local codex + CodeRabbit)
Land work as focused, independently-reviewable PRs (one per wave) so
[CodeRabbit](.coderabbit.yaml) can review a tight diff. Stack a PR on another only
when it genuinely depends on the other's new code; otherwise target `main`. Keep the
stack rebased per the integration plan.

Every PR gets **two review layers before merge**:
1. **Local review with codex** — before pushing, run a codex review pass over the
   diff locally and address what it surfaces. (This is in addition to the
   concurrent adversarial-review team from §2 — local codex is the fast pre-flight.)
2. **CodeRabbit on the PR** — once the PR is open, CodeRabbit reviews the diff.
   **Act on its comments**: triage each, fix the real ones, and reply/resolve the
   rest with a reason. Do not merge a PR with unaddressed CodeRabbit findings.
Both layers feed the same backlog loop (§5) — a review comment that surfaces a real
defect becomes a tracked item, fixed, and re-verified, exactly like §2's findings.

### 5. Goal-driven backlog loop
Track work in **Seeds** (`sd`), not ad-hoc lists. Drive toward an explicit goal:
enumerate the backlog, categorize by priority/dependency/wave, execute in waves,
review concurrently, reconcile new findings into the backlog, and **repeat until the
backlog is zero and the review team confirms nothing remains**. Surface blockers
immediately; never silently skip or defer an item without recorded justification.

### 6. Verify, then commit
Evidence before assertions. Run `bun test`, `bun run lint`, and `bun x tsc --noEmit`
(first-party must be clean) before claiming done. Commit at phase boundaries with the
project's `feat:`/`fix:`/`docs:`/`refactor:` style (no co-author trailers). Keep
`docs/` stats and the README stats block honest — they are generated by
`bun run scripts/stats.ts`, not hand-edited.

**Secret hygiene at the commit boundary.** Install the git hooks once per clone
(`bunx lefthook install`, run automatically by the `prepare` script on
`bun install`). Pre-commit runs **betterleaks** (the same scanner `am` shells out
to for Tier-2 detection) over staged changes and Biome over staged source; it
blocks a commit that introduces a real secret-shaped string. Deliberate
redaction-test fixtures (fake `ghp_…` / `user:pass@host` strings that exercise the
scrubbing code) are allowlisted in `.betterleaks.toml` — keep that list TIGHT and
review every addition. CI re-runs the same secret scan as a **hard gate**
(`.github/workflows/ci.yml` `secret-scan` job), so the local hook is convenience,
not the enforcing layer. Never commit a real credential; if one lands, rotate it.

### Non-negotiables
- **Scope:** marketplace (pillar 4) is **deferred to v2**, not deleted — keep
  `src/marketplace/*`; this supersedes ADR-0039/0052 deletion. ACP/A2A (pillar 3)
  are **in** the v1 supported core (agent-usage enhancement is the CLI's thesis).
- **Repo hygiene:** dev-accelerator meta-tooling (`.overstory/`, ruflo, etc.) is
  **never committed**. The project's own git-native tooling — `.mulch/`, `.seeds/`,
  `.canopy/` — **is** committed on purpose (it is mandated below).
- **One doc truth:** `AGENTS.md` is canonical; `CLAUDE.md` points to it. Don't fork
  project facts across both — we refuse to do to our own repo what `am` exists to fix.
