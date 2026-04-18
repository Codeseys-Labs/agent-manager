# Changelog

## [Unreleased]

## [0.5.0-rc4] - 2026-04-18

## [0.5.0-rc1] - 2026-04-17

All notable changes to agent-manager are documented in this file.

## [0.4.0] - 2026-04-16 — 0.4.0

### New Features

**A2A-ACP Bridge (ADR-0026 Phase 4)**
- `src/protocols/bridge.ts` — routes incoming A2A tasks to local ACP agents
- Message parsing: text pattern ("run claude: fix tests") or structured data parts
- Composite handler: bridge-first with fallthrough to default A2A handler

**Unified Agent Registry (ADR-0030)**
- `src/core/agent-registry.ts` — merges config, ACP built-in (16 agents), and A2A roster
- Resolution priority: config agents > ACP built-in > A2A roster
- Same-name agents across sources are merged (both acp + a2a protocols)
- `listAllAgents()` and `resolveAgent()` with sync and async variants

**SSE Streaming**
- Real-time event streaming for A2A task progress and ACP agent updates
- SSE endpoints on local web server for live status

**Wiki Context Injection**
- Wiki knowledge auto-injected into generated CLAUDE.md / AGENTS.md at apply time
- `generateWikiContext()` synthesizes top-5 entries via BM25
- Splice markers (`am:wiki:begin`/`am:wiki:end`) preserve manual content
- Enabled via `settings.wiki.inject_on_apply`

**Wiki Browser UI**
- Local web server: wiki page listing, search, graph visualization endpoints
- Cloudflare Worker: wiki browsing via git provider API

**Shell Completions**
- `am completion bash|zsh|fish` — generate shell completion scripts
- Covers all top-level commands and subcommands

**Flows Engine (ADR-0026 Phase 3)**
- `am flow run <name>` — execute multi-step workflows from TOML definitions
- `am flow list` / `am flow status <id>` — inspect workflow runs
- `src/protocols/acp/flows.ts` — typed node graphs (acp, action, compute, checkpoint)
- Conditional routing between nodes, crash recovery via persisted run state

**Community Adapter Loading (ADR-0027)**
- `am adapter install/remove/update/verify` — manage third-party adapters
- JSON-RPC subprocess protocol for community adapters (`src/adapters/community/`)
- `adapters.toml` config for installed community adapters
- Lazy proxy loading with `CommunityAdapterProxy` wrapping the JSON-RPC bridge

**Brownfield Import Merge (ADR-0028)**
- `am import --auto` — auto-resolve conflicts without prompting
- `am import --report` — show conflict report without making changes
- Two-tier identity matching for intelligent merge of existing configs

**Marketplace Import**
- `am import --marketplace` — scan installed plugins and extensions for MCP servers
- `src/adapters/shared/marketplace-vscode.ts` — shared VS Code extension scanner (Cursor, Copilot, Kiro, Windsurf)
- `src/adapters/claude-code/marketplace.ts` — Claude Code plugin scanner

**Git-Based Marketplace**
- `am marketplace add/remove/list/search/install/uninstall/update` — full plugin lifecycle
- `src/marketplace/` — client, scanner, installer, types modules
- Clone git-based plugin registries, search across them, install plugins

**ACP Agent Orchestration (ADR-0026)**
- `am run <agent> "<prompt>"` drives ACP-compatible coding agents headlessly
- Session management via `am run session list|cancel`
- New module: `src/protocols/acp/` (client.ts, registry.ts, types.ts)

**Grouped CLI Help (ADR-0029)**
- `src/help.ts` — commands organized by category following gh CLI pattern
- Categories: Config, Git sync, Registry, Wiki, Agent-to-Agent, ACP, Tools, Interfaces

**MCP Tools Expansion**
- 7 new tools: `am_server_update`, `am_undo`, `am_doctor`, `am_run_agent`, `am_acp_list_agents`, `am_acp_session_list`, `am_acp_session_cancel`
- Tool count: 26 → 33 across 6 groups (added `session` and `acp` groups)

**A2A Protocol Hardening**
- Bearer token auth for A2A server endpoints via `auth_token` option
- TTL eviction: terminal tasks auto-expire after 1 hour, two-phase eviction (TTL then LRU)
- Auto-discovery: `settings.a2a.discovery_sources[]` for URL-based agent roster population
- Async tasks: `tasks/send` returns immediately; `pollTask()` and `sendAndPoll()` on client

**Entity-Aware CLI**
- `am list` accepts entity type (servers, instructions, skills, agents, profiles)
- `am add` accepts entity type (server, instruction, skill, agent)
- Backwards compatible — defaults to servers

**Adapter Updates**
- Claude Code: skills export, AGENTS.md generation with wiki context
- Windsurf: skills and AGENTS.md support
- Gemini CLI: migrated to 6-file adapter pattern
- ForgeCode: migrated to 6-file adapter pattern with model support
- All 13 adapters now use shared utilities (`src/adapters/shared/utils.ts`, `diff-utils.ts`)

### Bug Fixes
- Fix MCP error messages: all errors now include recovery hints
- Fix `am_agent_discover` non-standard error pattern
- Fix `am list <invalid>` silently defaulting to servers
- Fix cancel-then-complete race condition in A2A async handler
- Fix `am_server_update` missing recovery hint on "not found" error
- Add `hint` field to JSON error responses for programmatic recovery guidance
- **P0**: `am apply` now filters entities by active profile
- **HIGH**: `writeConfig` preserves `agents` section through write cycles
- **HIGH**: `loadTuiData()` uses `buildResolvedConfig()` instead of hand-rolled config
- **HIGH**: Local web server requires Bearer token auth on all API endpoints
- Eliminate all `as any` casts from src/ (20 → 0)
- Replace all `catch (err: any)` with `catch (err: unknown)` (25 → 0)

### Design Documents
- **ADR-0026:** ACP runtime integration via ACPX — 4-phase headless agent orchestration
- **ADR-0027:** Community adapter loading — JSON-RPC subprocess, npm/git install
- **ADR-0028:** Brownfield import merge — two-tier identity matching, conflict resolution
- **ADR-0029:** Command grouping — grouped help output, gh CLI pattern
- **ADR-0030:** Unified agent registry — config + ACP + A2A merged resolution

### Reviews
- MCP tools review: 17 findings (3 critical/high)
- A2A protocol review: 32 findings (7 high)
- CLI UX review: 22 findings (3 critical)
- Phase 4 cross-review: 4 medium issues found and fixed
- Security hardening review of bridge + ACP + streaming

### Security Hardening (Iteration 10-11)
- **CRITICAL**: Agent name sanitization in bridge.ts — `/^[a-zA-Z0-9_-]{1,64}$/` validation
- **CRITICAL**: Flow cycle detection via DFS before execution + MAX_FLOW_STEPS guard (1000)
- **CRITICAL**: Adapter binary SHA256 checksum verification before subprocess spawn
- **HIGH**: `createTerminal` uses array spawn instead of `sh -c` (prevents shell injection)
- **HIGH**: Timing-safe bearer token comparison via `crypto.timingSafeEqual`
- **HIGH**: `--no-auto-approve` flag for `am run` (configurable permission policy)
- **HIGH**: Fix checkpoint handler API contract (nodeId was receiving message)
- **HIGH**: Detect dead cached proxy (isAlive check), evict and respawn
- **HIGH**: Validate pluginId in Claude Code scanner (reject path traversal)
- **MEDIUM**: SSE stream 5-minute idle timeout with auto-cleanup
- **MEDIUM**: History cap: `MAX_HISTORY_PER_TASK = 100`
- **MEDIUM**: ACP path restriction: `readTextFile`/`writeTextFile` validated against `allowed_paths`
- Add `_marketplace` provenance to skills and agents schemas
- Add `flow` + `marketplace` to shell completions
- Add Claude Code `.claude-plugin` format interop

### Tests
- 1,916 tests across 152 files, 5,655 assertions (up from 1,335/132/3,901)

### Distribution
- Release workflow: CHANGELOG-based release notes, Homebrew formula auto-update, version stamping

## [0.3.0] — 2026-04-13

### New Features

**MCP Registry Integration (ADR-0024)**
- `am search <query>` — search MCP registry with filtering
- `am install <package>` — resolve, prompt for env vars, encrypt, add to config
- `am uninstall <name>` — remove with confirmation
- `am update` — check for newer versions of registry-installed servers
- Registry provenance tracking via `_registry` metadata field
- 3 MCP tools: `am_registry_search`, `am_registry_install`, `am_registry_list_installed`

**A2A Protocol Integration (ADR-0017)**
- Full A2A v0.3.0 types (AgentCard, Task, Message, Artifact)
- A2A client: discover agents, send tasks, query status
- A2A server: JSON-RPC endpoint, Agent Card at `/.well-known/agent.json`
- Agent discovery from URLs and local TOML roster
- `am agents list|add|remove|ping|delegate` commands
- 4 MCP tools: `am_agent_discover`, `am_agent_list`, `am_agent_delegate`, `am_agent_task_status`

**LLM Wiki / Knowledge Synthesis (ADR-0020, ADR-0022)**
- Markdown file storage with YAML frontmatter (Karpathy llm-wiki pattern)
- BM25 search via MiniSearch with fuzzy matching and field boosting
- Rule-based NER: file paths, packages, config keys, CLI commands, function names, 38+ tool names
- Knowledge graph (JSON adjacency list) with wikilink + entity edges
- Dual location: global wiki + per-project with symlinks (ADR-0022)
- Session harvesting with Jaccard similarity deduplication
- `am wiki init|search|add|show|delete|harvest|ingest|lint|graph|synthesize|briefing|export|import`
- 5 MCP tools: `am_wiki_search`, `am_wiki_add`, `am_wiki_synthesize`, `am_wiki_briefing`, `am_wiki_harvest`

**Tiered Secret Detection (ADR-0023)**
- Tier 1 (built-in): key-name pattern matching for env vars (40+ provider patterns)
- Tier 2 (BetterLeaks): value-based + inline detection via shell-out when installed
- Auto-encrypt on import/add: secrets detected → substituted with `${VAR}` → encrypted
- `am secret scan` — audit with `--fix` to auto-substitute

**MCP Tool Grouping (ADR-0021)**
- Profiles control which MCP tool groups are exposed via `settings.mcp_serve.tools`
- Default: `["core"]` (14 tools). Optional: `registry`, `a2a`, `wiki`
- Total: 26 MCP tools across 4 groups

**Web UI Enhancements**
- Local web server: POST/PUT/DELETE /api/servers for full CRUD + POST /api/import/:adapter
- Local web server: 5 wiki endpoints (list, search, graph, projects, read page)
- Cloudflare Worker: multi-backend git auth — GitHub, GitLab, Codeberg, self-hosted Gitea (ADR-0025)

**TUI Enhancements**
- D/E/I/P keys: remove server, view details, auto-import, push config
- Arrow keys: navigate server list

**Distribution Infrastructure**
- CI workflow: test, typecheck, lint, coverage, multi-OS build verify (Blacksmith runners)
- Release workflow: 5-platform binaries, SHA-256 checksums, GitHub Release, npm publish
- `install.sh`: POSIX-compliant with checksum verification
- Homebrew formula + npm wrapper

### Bug Fixes
- **P0**: `am apply` now filters entities by active profile
- 11 bugs from multi-agent review (3 HIGH, 5 MEDIUM, 2 LOW)
- Eliminate all `as any` and `err: any` from src/

### Tests
- 1,335 tests across 132 files, 3,901 assertions

### Dependencies
- Added: `minisearch` (7kB, BM25 search for wiki)
- Removed: `chalk` (dead dependency)
