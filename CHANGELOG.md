# Changelog

## [Unreleased]

### Added
- **Runtime access-scoping profiles — the keystone (ADR-0055, supersedes ADR-0021).**
  A `Profile` now projects a runtime **Scope** over the MCP tool surface: a
  `[profiles.<name>.scope]` block (`tool_groups` / `allow_tools` / `deny_tools`)
  narrows which tools `am mcp-serve` exposes. Scope composes with the global
  `settings.mcp_serve.tools` ceiling by INTERSECTION — it can never widen the
  ceiling, deny always wins — and is enforced at BOTH `tools/list` (hide) and
  `tools/call` (refuse with `-32601`). The connection selects its profile via the
  `initialize` capability `experimental["am.profile"]` or the `AM_MCP_PROFILE`
  env var. A profile without `scope` behaves exactly as before.
- **Scope auditability (ADR-0055 Decision 6).** `am profile show <name> --tools`
  prints the effective access manifest (ceiling, scope, effective + excluded tool
  names), and a read-only `am_get_scope` MCP tool returns the same manifest to an
  agent — both built from the SAME decision the gateway enforces, so the manifest
  can never drift from what is actually allowed (now 44 MCP tools).
- **URL-embedded credential obfuscation (third secret class).** HTTP MCP servers
  whose credential rides in a URL query param (e.g.
  `?tavilyApiKey=tvly-…`) now follow the same obfuscate-on-ingest → encrypt →
  interpolate-at-apply lifecycle as named env vars and inline command/arg secrets:
  detected across `command`, `args`, and `adapters.<tool>.url` at `am add`/`am
  import`, rewritten to `?key=${VAR}` and encrypted in place. `am apply` refuses
  (fail-closed) to render a native config that would leak a plaintext URL
  credential. Hardened against 6 adversarial-review findings (adapter-url leak,
  scan-fix env-name collision, apply-guard membership bypass, missing-key
  fail-open, betterleaks no-op substitution, report mislabel).
- **Release runbook + version-assert gate.** New `RELEASING.md` (linked from
  AGENTS.md) documents the tag-triggered flow; a CI `assert-version` job fails the
  release before any binary is built unless the tag matches `package.json`, the
  version is dotted SemVer (`-rc.N`), and CHANGELOG `[Unreleased]` is non-empty,
  plus a self-report check that the compiled binary carries the tag.

### Changed
- **`ServerSchema` is a discriminated union on `transport` (ADR-0057).** stdio and
  remote (`streamable-http`/`sse`) server shapes are now mutually exclusive at the
  type level — `url` is structurally forbidden on stdio — replacing the prior
  ad-hoc `superRefine`. `command` stays on both variants (am stores the remote URL
  there today), so adapters are unchanged.
- **`am init` next-steps spell out the full path to working configs.** Both the
  detected-tools and no-tools branches now lead with `am setup` (the guided
  wizard) and always name `am apply` explicitly — import alone writes nothing to
  disk — removing the "init → ??? → working configs" dead end.

### Security
- **Scope boundary fails CLOSED on a broken profile chain (K-CRIT).** An
  unknown-`inherits` or circular profile resolves to an empty (deny-all) scope
  rather than silently exposing the full ceiling.
- **Working pre-commit + CI secret-scanning gate.** lefthook runs betterleaks on
  staged changes; the CI `secret-scan` job scans the working tree
  (`betterleaks dir .`) with a `[[allowlists]]`-based `.betterleaks.toml` that
  allowlists the deliberate redaction-test fixtures while still failing on a real
  secret in any other file. (Repairs a gate that was previously a no-op: a wrong
  release-asset URL hard-failed the job, and the prior CEL allowlist syntax was
  inert under the pinned betterleaks v1.1.1.)
- **Web `POST`/`PUT /api/servers` validate against `ServerSchema` before write**,
  so a malformed request body can no longer persist an unloadable `config.toml`.
- **Secret ingest fails CLOSED on un-obfuscatable findings.** If `substituteSecret`
  cannot rewrite a detected secret to a `${VAR}` reference, `am import`, `am add`,
  and the web write paths now abort the write entirely instead of skipping
  encryption while leaving the raw value in `config.toml` — closing a gap the
  apply guard (URL-credentials only) didn't cover. Substitution also scrubs ALL
  occurrences (`replaceAll`) and verifies the plaintext is gone before reporting
  success, so a value repeated in one arg can't leave a residue.
- **Marketplace install can't write a config-bricking `stdio`+`url` server.** A
  plugin manifest with `url` and no `transport` resolved to stdio; the installer
  copied `url` unconditionally, persisting a server the new union rejects on the
  next read (and `writeConfig` doesn't validate). Now guarded on the resolved
  transport, mirroring the registry path.

### Fixed
- Several review-driven correctness fixes: `am_get_scope`/out-of-scope errors now
  report the connection-resolved profile (not a re-derived default); betterleaks
  `spawnSync` passes `env: process.env` so an in-process `PATH` change is honored;
  cloud-mode web UI table column alignment + hidden local-only CRUD controls;
  `am_config_show` advertises `auth_required` truthfully when a token is set.
- Documentation/stat coherence: tool counts, ROADMAP/AGENTS drift, the marketplace
  runtime notice (now "deferred to v2", matching ADR-0039/0052 supersession), and
  the `am secret generate-key` command name.
- **`scripts/build.ts` Silvery patch no longer cries wolf on rebuilds.** The
  "patch regex did not match — build may fail" warning fired on every rebuild
  (file already stubbed); it now distinguishes already-patched (benign) from a
  genuine upstream format change (the real warning).
- **CI secret-scan survives transient GitHub 504s.** The betterleaks download is
  retried (5 attempts, linear backoff) so a single CDN blip no longer hard-reds
  the HARD secret gate.
- **Registry `LRUCache` TTL is deterministically testable** via a constructor-
  injected clock seam, removing a `Date.now` monkey-patch that the module
  singleton's import-time capture defeated (no production behavior change).

## [0.5.0-rc7] - 2026-06-04

### Added
- **`am setup` — first-run setup wizard (ADR-0053).** A single guided,
  resumable command takes a stranger from "just installed `am`" to "native
  configs written + green health check": detect tools → import their existing
  configs → set up an encryption key (AES) → create a profile → apply → end on
  a green `am doctor`. Fully scriptable (`--yes` / `--json` /
  `--non-interactive` for CI) and `--from <git-url>` clones an existing catalog
  onto a new machine. Idempotent — safe to re-run; resumes/repairs rather than
  clobbering. The granular steps (`am init`, `am import auto`,
  `am secret scan --fix`, `am apply`) remain independently usable.
- **Knowledge as a first-class peer (ADR-0054, wiki R1–R8).** Graph, wikilink,
  and search-index maintenance moved onto the `writePage` write path
  (backlinks/orphans are always current, not batch-rebuilt). NER entities are
  now derived from the resolved catalog (server/agent/skill names) with a static
  fallback. New committed cross-project meta-index (`wiki/meta-index.json`) plus
  `am wiki search --all-projects`. Promotion to `wiki/global/` is gated by an
  explicit `--promote` flag (with a `promote:` frontmatter discovery gate for
  the batch `--auto` path).

### Fixed
- **Cross-platform Windows hardening.** Systematic sweep of Windows
  build-verify failures: env-var coercion footgun (`process.env.X = undefined`
  stringifying to `"undefined"` and poisoning the shared Bun process),
  path-separator assumptions in path assertions (now separator-agnostic via
  `toPosix`), VS Code session-directory de-duplication, and an fsync handle
  opened `r+` for Windows.
- **Fail-closed apply across all surfaces.** The drift gate fails closed when
  `adapter.diff()` throws (SEC-4), and the same `APPLY_SAFE_DEFAULTS` posture is
  shared verbatim by the CLI (`am apply`), MCP (`am_apply`), web
  (`POST /api/apply`), and the TUI apply button — a drifted native config is
  skipped, never silently overwritten.
- **age-secrets apply path (ADR-0042).** The controller routes `enc:v2:age:`
  envelopes through `decodeEnvelope` and fails loud, loading the age backend
  whenever the config selects age or already contains age envelopes — fixing
  prior apply-time corruption. v1 envelopes with no configured key keep the
  ADR-0012 graceful passthrough; v2/unknown envelopes fail loud.
- **Security hardening.** Path-traversal validation, A2A SSRF guards, and an
  MCP buffer fix; BetterLeaks binary pinned by SHA.

### Changed
- **Command-handler test coverage** raised substantially across the CLI surface
  (parent-command help now exits 0, non-interactive guards added for UX-1/UX-2).
- **README first-touch aligned on `am setup`** (the full wizard) rather than
  `am init` (the detect+git-init sub-step); `install.sh`'s "Get started" hint
  now points at `am setup`.
- **Adapter export logic deduplicated** via a shared `export-utils` module.

> npm publish remains deferred until v1.0 (unscoped `agent-manager` name is
> owned by an unrelated package). GitHub Releases (consumed by `install.sh`)
> are the distribution channel.

## [0.5.0-rc6] - 2026-04-20

### Added
- **ADR-0033 three-tier agent model.** `BUILT_IN_AGENTS` replaces the flat
  16-entry `BUILT_IN_ACP_AGENTS` dict with three tiers: tier-1-native
  (claude/codex/gemini/kiro — verified end-to-end), tier-2-shim
  (aider/amazon-q/cody — opt-in via `am agent enable-shim`), and
  tier-3-catalog-only (cline/continue/copilot/cursor/kilo-code/roo-code/
  windsurf — `am apply` writes config, `am run` returns a helpful refusal).
- **`am agent enable-shim <name>`** — opt-in path for Tier-2 wrappers with a
  prominent security caveat. Requires `--yes` or interactive confirmation.
- **`am-acp-shell <name>`** — second bin shipped alongside `am`. Runs a
  minimal ACP server that spawns the wrapped CLI one-shot per prompt.
- **`am agent list --tier native|shim|catalog|--runnable`** — filter the
  unified registry by tier. The refusal messages that already referenced
  this flag now work.
- **Agent tier column** in `am agent list` text + JSON output; tier + runnable
  surface through `am_agent_list` MCP tool.
- **`resolveInstalledBuiltInAgentLaunch`** — prefer a locally-installed
  binary over npx cold-start for claude and codex (2–5s startup win per
  invocation). Borrowed from openclaw/acpx; see
  `docs/references/openclaw-acpx.md` for attribution.

### Fixed
- **ACP subprocess env-scrubbing.** `sandboxEnv()` allowlists PATH/HOME/
  LANG/TERM/etc. and strips AM_*, AWS_*, GITHUB_TOKEN, OPENAI_*,
  ANTHROPIC_*, GOOGLE_*, and any var matching `*_(TOKEN|SECRET|KEY|
  PASSWORD|CRED|SESSION)` before spawning. Closes REV-2 HIGH-3.
- **MCP progress redaction.** `notifications/progress` payloads now run
  through `redactSecretish` before the sink sees them. An agent streaming
  `sk-ant-...` in a chunk no longer leaks it to every third-party IDE
  tailing MCP traffic. Closes REV-2 HIGH-1.
- **Concurrency: route install/uninstall/update/profile/init/marketplace
  install/uninstall through `withConfig`.** The Wave B mutex now covers
  8 more CLI surfaces that previously did raw `writeConfig`. Closes
  REV-1 MEDIUM-2.
- **Enable-shim → resolveAgent path.** `enable-shim` previously wrote to
  `adapters.acp.command` but `resolveAgent` reads `acp.command` directly
  — the entire tier-2 opt-in flow was silently broken. Fixed to write the
  correct path; test now asserts the resolved route, not just the write.
  Closes REV-4 CRIT-1.
- **Tier-2-specific refusal.** `am run aider` (before `enable-shim`) used
  to claim aider was a VSCode extension. Now emits a recovery-path hint
  pointing at `am agent enable-shim aider --yes`. Closes REV-4 HIGH-1.

### Changed
- **Unified tier refusal across `am run`, `am flow run`, and
  `am_agent_invoke`.** Three surfaces now emit the same ADR-0033 message
  via `tierRefusalMessage` / `shimNotEnabledMessage` helpers.
- **README.md:** added "direction matters" note clarifying that `am apply`
  uni-directionally pushes catalog → tool (with `mcpServers` replace
  semantics), and dropped the stale "16 agents" claim.

### Security
- Tier-2 wrapped agents inherit the wrapped CLI's trust posture (e.g.
  `aider --yes` auto-approves file mutations without am's UI). Documented
  in `am agent enable-shim`'s security caveat and the README tier matrix.

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
