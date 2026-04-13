# Changelog

All notable changes to agent-manager are documented in this file.

## [Unreleased]

### Multi-Agent Review + Implementation Session (2026-04-10)

#### Bug Fixes (11 bugs from multi-agent review)
- **HIGH**: `writeConfig` now preserves `agents` section through write cycles
- **HIGH**: `loadTuiData()` uses `buildResolvedConfig()` instead of hand-rolled config
- **HIGH**: Local web server requires Bearer token authentication on all API endpoints
- **MEDIUM**: Add `subagent_type` to `AgentProfileSchema` (removes phantom field reference)
- **MEDIUM**: Apply `redactSecrets()` to `/api/config` web response
- **MEDIUM**: MCP server refreshes settings per request (no stale permission cache)
- **MEDIUM**: Narrow Worker OAuth scope from `repo` to `contents:read contents:write`
- **MEDIUM**: Kilo-code export maps `env` to `env` (not `headers`) for remote servers
- **MEDIUM**: `doctor.ts` uses `tryReadConfig()` via core config layer
- **LOW**: Remove dead `checkPushPermission()` function
- **LOW**: Add instruction drift detection to adapter diff system

#### Type Safety
- Eliminate all `as any` casts from src/ (20 → 0)
- Replace all `catch (err: any)` with `catch (err: unknown)` (25 → 0)
- Add `src/lib/toml.ts` typed wrapper for TOML stringify
- Add `src/lib/errors.ts` with `errorMessage()`, `isNotFound()`, `errorCode()` helpers
- Remove dead `chalk` dependency

#### New Features

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
- Auto-generate encryption key if none exists
- `am secret scan` — audit with `--fix` to auto-substitute
- `am secret install-scanner` — download BetterLeaks binary from GitHub releases
- `am doctor` reports BetterLeaks availability

**MCP Tool Grouping (ADR-0021)**
- Profiles control which MCP tool groups are exposed via `settings.mcp_serve.tools`
- Default: `["core"]` (14 tools). Optional: `registry`, `a2a`, `wiki`
- Total: 26 MCP tools across 4 groups

**Distribution Infrastructure**
- CI workflow: test, typecheck, lint, coverage, multi-OS build verify
- Release workflow: 5-platform binaries, SHA-256 checksums, GitHub Release, npm publish
- `install.sh`: POSIX-compliant with checksum verification, --dry-run, --version
- `Formula/am.rb`: Homebrew formula with per-platform binary support
- `bin/am.js`: npm wrapper resolving platform binary or bun fallback
- `scripts/bump-version.sh`: version bump → git tag → trigger release

#### Improvements
- Extract shared adapter utilities to `src/adapters/shared/utils.ts`
- Add `profile delete` confirmation prompt
- Fix `process.exitCode = 1` in 6 command error paths
- Fix `am version` for `--json`/`--quiet` flags
- Fix `projectToConfig` dropping `proj.env`
- Cap A2A server task store at 1000 with LRU eviction
- Add `agent` variant to `DiffChange.entity`
- Windows junction point fallback for wiki symlinks
- Extract MiniSearch options constant (deduplicate 3×)
- Update ADR-0013 with Codeberg, Gitea, Forgejo future adapters

#### Documentation
- Comprehensive README rewrite with 13-adapter support matrix
- Full CLI reference for all 27 commands
- AGENTS.md updated: 24 ADRs, 1134 tests, new modules documented
- 6 new/updated ADRs: 0021 (tool grouping), 0022 (wiki location), 0023 (secret detection), 0024 (MCP registry), 0017 (accepted), 0020 (accepted)

#### Test Coverage
- 1134 tests across 118 files (up from 1031/110)
- New test files for: wiki storage, NER, graph, harvester, registry client, A2A discovery, secret detection, BetterLeaks
- All tests use real filesystem I/O with temp directory isolation

#### Dependencies
- Added: `minisearch` (7kB, BM25 search for wiki)
- Removed: `chalk` (dead dependency, zero imports)

### Session 2 (2026-04-13)

#### Critical Fix
- **P0**: `am apply` now filters entities by active profile — `buildResolvedConfig()` calls `resolveProfile()` to subset servers/instructions/skills/agents

#### Web UI Enhancements
- Local web server: POST/PUT/DELETE /api/servers for full CRUD + POST /api/import/:adapter
- Local web server: 5 wiki endpoints (list, search, graph, projects, read page)
- Cloudflare Worker: 3 wiki endpoints via GitHub API (list, projects, read page)
- Cloudflare Worker: multi-backend git auth — GitHub, GitLab, Codeberg, self-hosted Gitea (ADR-0025)
- Worker provider abstraction: `GitProvider` interface normalizes OAuth + API across backends

#### TUI Enhancements
- D key: remove selected server with y/n confirmation
- E key: view server details (command, args, tags, transport)
- I key: auto-import from all detected adapters with secret encryption
- P key: push config to remote
- Arrow keys: navigate server list

#### Wiki Pipeline
- Verified end-to-end: session harvest → NER → wiki pages → BM25 index → knowledge graph → symlink → agent access
- 20 integration tests covering full pipeline
- Wiki browsable from web UI (local + worker)

#### Tests
- 1335 tests across 132 files, 3901 assertions (up from 1134/118/2967)

#### Documentation
- ADR-0025: Worker Multi-Backend Git Authentication
- All docs updated: AGENTS.md, ROADMAP.md, CHANGELOG.md
