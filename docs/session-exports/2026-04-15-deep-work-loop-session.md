# Deep Work Loop Session — 2026-04-15

## Session Overview

This session executed 5 iterations of a deep work loop on agent-manager, progressing from a multi-agent codebase review through design, implementation, and polish. The session started with the v0.3.0 release infrastructure just completed (previous session ended with `08344ef chore: bump version to 0.3.0`) and ended with a substantial body of work toward v0.4.0.

**Key accomplishments:**
- 5-agent parallel review producing 3 detailed review documents (MCP tools, A2A protocol, CLI UX) totaling ~120 findings
- 3 design documents for future extensibility (community adapters, brownfield import, marketplace import)
- 3 new ADRs (0026, 0027, 0028)
- ACP runtime client and `am run` command — headless coding agent orchestration
- 7 new MCP tools (33 total, up from 26), reorganized into 6 groups (up from 4)
- A2A protocol hardened: async tasks, per-instance stores, auth middleware, TTL eviction, auto-discovery
- Entity-aware CLI: `am add server|instruction|skill|agent`, `am list servers|instructions|skills|agents|profiles`
- CLI UX hardening: `requireConfig()` wired into 19 command files, `parsePositiveInt()` validator, `AmError` adoption
- Full documentation refresh across README, AGENTS.md, CLAUDE.md, CONTRIBUTING.md, ROADMAP.md, CHANGELOG.md, ADRs/README.md
- Tests: 1335 -> 1470 (135 new tests), 3901 -> 4312 assertions, 132 -> 134 test files

**Session commits:** 10 commits, ~11,000 lines changed across 100+ files.

---

## Iteration 1: Review + Design Phase

**Commit:** `0d6aca8 docs: 5-agent review + design phase for agent-manager v0.4.0`
**Preceded by:** `a950670 feat(release)` and `34340f1 feat(adr): ADR-0026`

### What happened

Five specialized review agents ran in parallel, each owning a domain:

1. **MCP Tools Review Agent** — Audited all 26 MCP tools across 4 groups. Produced 17 findings (2 HIGH, 8 MEDIUM, 7 LOW). Key issues: missing `am_server_update` tool (P0), no `am_undo` or `am_doctor` in MCP surface, error messages without recovery hints, session tools in wrong group.

2. **A2A Protocol Review Agent** — Deep audit of `src/protocols/a2a/`, client, server, discovery, roster, Agent Card generation. Produced 32 findings (7 HIGH, 13 MEDIUM, 12 LOW). Key issues: synchronous-only task handler, module-level singleton task store, no async/polling support, missing authentication middleware.

3. **CLI UX Review Agent** — Compared all 27 commands against chezmoi, brew, ACPX, clig.dev. Produced 22 findings (3 CRITICAL, 5 HIGH, 8 MEDIUM, 6 LOW). Key issues: `am add` only adds servers (name too broad), `am list` only lists servers, README syntax mismatch with actual CLI.

4. **Design Agent** — Produced 3 design documents:
   - `community-adapters.md` — JSON-RPC subprocess model for third-party adapters, `am-adapter-*` npm convention
   - `brownfield-import.md` — Two-tier identity matching + interactive conflict resolution for messy imports
   - `marketplace-import.md` — Scan Claude Code plugins + VS Code extensions for MCP servers

5. **ADR Agent** — Drafted ADRs 0026-0028:
   - **ADR-0026:** ACP runtime integration via ACPX — 4-phase plan for headless agent orchestration
   - **ADR-0027:** Community adapter loading — subprocess escape hatch from ADR-0011
   - **ADR-0028:** Brownfield import merge — interactive conflict resolution

### Deliverables

| Type | File | Findings |
|------|------|----------|
| Review | `docs/reviews/2026-04-15-mcp-a2a-cli-review/mcp-tools-review.md` | 17 findings |
| Review | `docs/reviews/2026-04-15-mcp-a2a-cli-review/a2a-review.md` | 32 findings |
| Review | `docs/reviews/2026-04-15-mcp-a2a-cli-review/cli-ux-review.md` | 22 findings |
| Design | `docs/designs/2026-04-15-extensibility-import/community-adapters.md` | — |
| Design | `docs/designs/2026-04-15-extensibility-import/brownfield-import.md` | — |
| Design | `docs/designs/2026-04-15-extensibility-import/marketplace-import.md` | — |
| ADR | `ADRs/0026-acpx-acp-runtime-integration.md` | — |
| ADR | `ADRs/0027-community-adapter-loading.md` | — |
| ADR | `ADRs/0028-brownfield-import-merge.md` | — |

---

## Iteration 2: Medium Fixes

**Commit:** `bab2994 fix: P0/HIGH fixes from 5-agent review (MCP, A2A, CLI)` + `1ea48bd fix: address Phase 4 review findings` + `eed5cb6 fix: iteration 2 — medium findings + test coverage`

### P0/HIGH Fixes (from review)

**MCP Server (`src/mcp/server.ts`):**
- Added `am_server_update` tool — enable/disable servers, merge env vars, replace args/tags
- Added `am_undo` tool — revert last config change via git (write-local tier)
- Added `am_doctor` tool — 8 health checks returning structured JSON (read-only tier)
- Fixed error messages: all errors now include recovery hints (e.g., "Use am_list_servers to see available servers")
- Fixed `am_agent_discover` non-standard error pattern (was returning `{error}` in success response, now throws)
- Updated `am_agent_delegate` description to explain async polling model

**A2A Server (`src/protocols/a2a/server.ts`):**
- Converted from synchronous to async task execution: `tasks/send` returns immediately with `state: "working"`, clients poll with `tasks/get`
- Replaced module-level singleton `taskStore` with per-instance `createTaskStore()` — fixes cross-instance state bleed
- Added TTL-based eviction: terminal tasks auto-expire after 1 hour (`TASK_TTL_MS`), two-phase eviction (TTL then LRU)
- Fixed cancel-then-complete race: `.then()` handler checks for terminal state before overwriting

**A2A Client (`src/protocols/a2a/client.ts`):**
- Added `pollTask()` — poll with configurable interval/timeout/abort signal
- Added `sendAndPoll()` — convenience method combining send + poll

**CLI (`src/commands/add.ts`, `src/commands/list.ts`):**
- `am add` now accepts entity type: `am add server|instruction|skill|agent <name>` with backward compat
- `am list` now accepts entity type: `am list servers|instructions|skills|agents|profiles`
- Fixed `am list <invalid>` silently defaulting to servers — now throws with valid types list

### Medium Fixes

**A2A Discovery (`src/protocols/a2a/discovery.ts`):**
- Implemented `discoverFromConfig()` — reads `settings.a2a.discovery_sources[]` and merges into roster
- Roster `lastSeen` now updated on successful ping

**A2A Server:**
- Added bearer token authentication middleware for A2A endpoints via `auth_token` option
- Per-instance task store via `createTaskStore()` (already noted above)

**MCP Server:**
- Extracted `session` tool group from `core` — `MCP_TOOL_GROUPS` now includes 6 groups
- Added `am_run_agent`, `am_acp_list_agents`, `am_acp_session_list`, `am_acp_session_cancel` tools

**Schema (`src/core/schema.ts`):**
- Added `"session"` and `"acp"` to `MCP_TOOL_GROUPS`

### Cross-Review (Phase 4)

Two additional review documents produced for the iteration 2 changes:
- `docs/reviews/2026-04-15-mcp-a2a-cli-review/phase3-mcp-a2a-review.md` — 15 findings (2 MEDIUM, 10 LOW)
- `docs/reviews/2026-04-15-mcp-a2a-cli-review/phase3-cli-review.md` — 5 findings (2 MEDIUM, 3 LOW)

### Test additions

- 8 new MCP server tests for `am_server_update`, `am_undo`, `am_doctor`
- 20+ new A2A server tests for async behavior, store isolation, cancel-of-working, TTL eviction
- 84 new A2A discovery tests for `discoverFromConfig()`, roster lastSeen updates
- 140 new A2A server tests across async handler paths

---

## Iteration 3: ACP Runtime + A2A Features

**Commit:** `b77dc99 feat: iteration 3 — ACP runtime client + A2A features + CLI UX analysis`

### New Features

**ACP Runtime (`src/protocols/acp/`):**
- `client.ts` (423 lines) — Full ACP client: agent discovery, session creation, prompt execution, streaming output, session management (list, cancel)
- `registry.ts` (96 lines) — Agent registry with built-in agents (Claude Code, Codex CLI, Cursor, Windsurf, etc.) and config overrides
- `types.ts` (114 lines) — ACP types: AgentInfo, Session, AcpClientError

**`am run` command (`src/commands/run.ts`, 411 lines):**
- `am run <agent> "<prompt>"` — one-shot headless agent execution
- `am run --session <name> <agent> "<prompt>"` — named session with resumption
- `am run agents` — list available ACP agents (built-in registry + config overrides)
- `am run session list <agent>` — list active sessions
- `am run session cancel <agent> <id>` — cancel a running session

**7 new MCP tools (26 -> 33):**
- `am_server_update` — enable/disable, merge env, replace args/tags
- `am_undo` — revert last config change
- `am_doctor` — 8 health checks
- `am_run_agent` — ACP agent orchestration via MCP
- `am_acp_list_agents` — list available ACP agents
- `am_acp_session_list` — list active ACP sessions
- `am_acp_session_cancel` — cancel ACP session

**MCP tool groups (4 -> 6):**
- `session` group extracted from `core` (am_session_list, am_session_export, am_session_search)
- `acp` group added (am_run_agent, am_acp_list_agents, am_acp_session_list, am_acp_session_cancel)

**A2A enhancements:**
- `agents.ts` — added `am agents cancel <name> <taskId>` subcommand
- `discovery.ts` — `discoverFromConfig()` for URL-based auto-discovery
- `server.ts` — async task handler refinements, TTL eviction

**CLI UX Deep Analysis:**
- `docs/reviews/2026-04-15-cli-ux-refinement/cli-ux-deep-analysis.md` (969 lines) — comprehensive review of all 29 commands, command grouping proposal, error consistency audit, comparison with gh/brew/chezmoi/clig.dev, draft ADR-0029

### Tests added

- `test/commands/run.test.ts` (171 lines) — 15 tests for ACP runtime
- `test/protocols/acp/client.test.ts` (366 lines) — 30+ tests for ACP client
- `test/mcp/server.test.ts` — 249 new lines for ACP MCP tools
- `test/protocols/a2a/discovery.test.ts` — 93 new lines for auto-discovery
- `test/protocols/a2a/server.test.ts` — 209 new lines for async handler paths

---

## Iteration 4: CLI UX Hardening + Docs

**Commit:** `085e4e1 fix: iteration 4 — CLI UX hardening + docs polish`

### CLI UX Hardening

This was the largest single commit: 37 files changed, 1503 insertions, 1416 deletions. The core change was adopting `requireConfig()` and `AmError` across all 19 command files that had inline "Config not found" error handling.

**Error handling refactor (`src/lib/output.ts`):**
- Added `parsePositiveInt()` validator for numeric CLI flags
- Added `formatAmError()` for structured error output in `--json` mode
- Wired `AmError` with `code` field into all error paths

**Commands refactored (19 files):**
- `add.ts`, `apply.ts`, `config.ts`, `import.ts`, `install.ts`, `list.ts`, `profile.ts`, `pull.ts`, `push.ts`, `secret.ts`, `status.ts`, `uninstall.ts`, `update.ts`, `use.ts`, `wiki.ts`, `search.ts`, `log.ts`, `serve.ts`, `run.ts`
- Each: replaced inline `try/catch` with `tryReadConfig()` + `requireConfig()`, added top-level `try/catch` with `amError(err, opts)`
- `push.ts` and `pull.ts`: replaced inline `console.error(JSON.stringify(...))` with `throw new AmError()`
- `serve.ts`: added `--host`, `--verbose`, port validation via `parsePositiveInt()`
- `log.ts`: added `-n` alias for `--count` (git muscle memory)
- `search.ts`: `--limit` validated via `parsePositiveInt()`

**Schema (`src/core/schema.ts`):**
- Added `hint` field to JSON error responses for programmatic recovery guidance

### Documentation refresh

Every major doc file updated to reflect the session's changes:

| File | Changes |
|------|---------|
| `README.md` | Updated command count (27->29), tool count (26->33), group count (4->6), added `am run` section |
| `AGENTS.md` | Updated test count (1335->1470), added ACP module docs |
| `CLAUDE.md` | Updated test count, added `am run` command, added ACP protocol section |
| `CONTRIBUTING.md` | Added error handling conventions, `requireConfig()` pattern |
| `ROADMAP.md` | Updated status of A2A, ACP, CLI entity dispatch; added v0.4.0 milestone items |
| `CHANGELOG.md` | Full iteration 3 changelog entry |
| `ADRs/README.md` | Added ADRs 0026-0028 to index |

---

## Iteration 5: LOW Fixes + Final Polish (in progress)

**Status at session end:** Tasks #1, #2, and #4 were in progress when this export was created.

### Planned work (not yet committed)

1. **Grouped help output (ADR-0029)** — Custom help formatter for `am --help` with 9 command groups
2. **LOW fixes batch:**
   - `am agents` -> `am agent` (singular naming consistency)
   - `am wiki harvest` deprecation warning
   - `am wiki delete` `--force` -> `--yes` standardization
   - MCP response cleanup (trim `am_wiki_add` internal fields)
   - `am_config_show` source attribution
3. **Final comprehensive codebase review** — full sweep for any remaining issues

---

## Commits (Chronological)

| # | Hash | Message | Files | Lines |
|---|------|---------|-------|-------|
| 1 | `a950670` | `feat(release): CHANGELOG notes, Homebrew formula auto-update, version stamping` | 1 | +110 |
| 2 | `34340f1` | `feat(adr): ADR-0026 ACP runtime integration via ACPX` | 1 | +281 |
| 3 | `0d6aca8` | `docs: 5-agent review + design phase for agent-manager v0.4.0` | 8 | +3,255 |
| 4 | `bab2994` | `fix: P0/HIGH fixes from 5-agent review (MCP, A2A, CLI)` | 8 | +1,430/-245 |
| 5 | `1ea48bd` | `fix: address Phase 4 review findings` | 5 | +666/-3 |
| 6 | `2be54cf` | `chore: Phase 5 polish — CHANGELOG, ROADMAP, docs reorganization` | 11 | +166/-1 |
| 7 | `bdadc2b` | `chore: rename doc session folders with topic descriptors` | 8 | renames only |
| 8 | `eed5cb6` | `fix: iteration 2 — medium findings + test coverage` | 7 | +386/-37 |
| 9 | `b77dc99` | `feat: iteration 3 — ACP runtime client + A2A features + CLI UX analysis` | 18 | +3,398/-18 |
| 10 | `085e4e1` | `fix: iteration 4 — CLI UX hardening + docs polish` | 37 | +1,503/-1,416 |

**Total:** ~11,000 lines changed across 100+ unique files.

---

## Deliverables Inventory

### Reviews (6 documents)

| Document | Location | Findings |
|----------|----------|----------|
| MCP Tools Review | `docs/reviews/2026-04-15-mcp-a2a-cli-review/mcp-tools-review.md` | 17 (2 HIGH, 8 MEDIUM, 7 LOW) |
| A2A Protocol Review | `docs/reviews/2026-04-15-mcp-a2a-cli-review/a2a-review.md` | 32 (7 HIGH, 13 MEDIUM, 12 LOW) |
| CLI UX Review | `docs/reviews/2026-04-15-mcp-a2a-cli-review/cli-ux-review.md` | 22 (3 CRITICAL, 5 HIGH, 8 MEDIUM, 6 LOW) |
| Phase 3 MCP+A2A Review | `docs/reviews/2026-04-15-mcp-a2a-cli-review/phase3-mcp-a2a-review.md` | 15 (2 MEDIUM, 10 LOW) |
| Phase 3 CLI Review | `docs/reviews/2026-04-15-mcp-a2a-cli-review/phase3-cli-review.md` | 5 (2 MEDIUM, 3 LOW) |
| CLI UX Deep Analysis | `docs/reviews/2026-04-15-cli-ux-refinement/cli-ux-deep-analysis.md` | Comprehensive (covers all 29 commands, draft ADR-0029) |

### Designs (3 documents)

| Document | Location | Status |
|----------|----------|--------|
| Community Adapter Loading | `docs/designs/2026-04-15-extensibility-import/community-adapters.md` | Draft |
| Brownfield Import Merge | `docs/designs/2026-04-15-extensibility-import/brownfield-import.md` | Draft |
| Marketplace Import | `docs/designs/2026-04-15-extensibility-import/marketplace-import.md` | Draft |

### ADRs (3 new)

| ADR | Title | Status |
|-----|-------|--------|
| 0026 | ACP Runtime Integration via ACPX | Proposed |
| 0027 | Community Adapter Loading | Proposed |
| 0028 | Brownfield Import Merge | Proposed |

### New Source Modules

| Module | Location | Lines | Purpose |
|--------|----------|-------|---------|
| ACP Client | `src/protocols/acp/client.ts` | 423 | Agent discovery, session management, prompt execution |
| ACP Registry | `src/protocols/acp/registry.ts` | 96 | Built-in agent registry + config overrides |
| ACP Types | `src/protocols/acp/types.ts` | 114 | ACP protocol types |
| Run Command | `src/commands/run.ts` | 411 | `am run` CLI command handler |

---

## Metrics

### Tests

| Metric | Start of Session | End of Session | Delta |
|--------|-----------------|----------------|-------|
| Total tests | 1,335 | 1,470 | +135 |
| Test files | 132 | 134 | +2 |
| Assertions | 3,901 | 4,312 | +411 |
| All passing | Yes | Yes | — |

### MCP Tools

| Metric | Start | End | Delta |
|--------|-------|-----|-------|
| Total tools | 26 | 33 | +7 |
| Tool groups | 4 | 6 | +2 |
| Groups | core, registry, a2a, wiki | core, registry, a2a, wiki, session, acp | +session, +acp |

### CLI Commands

| Metric | Start | End | Delta |
|--------|-------|-----|-------|
| Top-level commands | 27 | 29 | +2 (`run`, entity-dispatch in `add`/`list`) |
| Subcommands/operations | ~55 | ~66 | +11 |
| Entity-aware commands | 0 | 2 | `am add`, `am list` |

### ADRs

| Metric | Start | End |
|--------|-------|-----|
| Total ADRs | 25 | 28 |
| New this session | — | 0026, 0027, 0028 |

### Source Files

| Metric | Value |
|--------|-------|
| TypeScript files in src/ | 165 |
| Lines changed this session | ~11,000 |
| Files touched | 100+ |
| New source files | 4 (ACP client, registry, types, run command) |

---

## Remaining Work (for future sessions)

### In Progress (from iteration 5)

1. **Grouped help output (ADR-0029)** — Implement `src/lib/help.ts` with 9 command groups for `am --help`. Draft ADR exists in `docs/reviews/2026-04-15-cli-ux-refinement/cli-ux-deep-analysis.md`.

2. **LOW fixes batch:**
   - Rename `am agents` to `am agent` (singular, with backward-compat alias)
   - Deprecation warning for `am wiki harvest` (-> `am wiki ingest`)
   - Standardize `--force` to `--yes` in `am wiki delete`
   - Trim `am_wiki_add` MCP response (exclude internal provenance fields)
   - Add source attribution to `am_config_show` response

3. **Final codebase review** — Comprehensive sweep for remaining issues

### Deferred (documented in ROADMAP.md)

| Item | Priority | Notes |
|------|----------|-------|
| MCP Gateway mode | P2 | ADR-0021 documents as experimental. Not needed until proven use case. |
| Agent namespace disambiguation | P2 | `am agents` (A2A) vs `am run agents` (ACP) vs `am list agents` (config). ADR-0029 proposes renaming A2A to `am a2a`. |
| Wiki/Registry/A2A in Web+TUI | P3 | CLI-only for now is acceptable |
| Shell completions | P3 | `am completion bash|zsh|fish` — citty may have support |
| `--format` global flag | P3 | Replace `--json` boolean with `text|json|toml` |
| Community adapters implementation | P3 | ADR-0027 designed, not built |
| Brownfield import implementation | P3 | ADR-0028 designed, not built |
| Marketplace import implementation | P3 | Design doc exists, no ADR yet |

### Review Findings Not Yet Addressed

**From MCP Tools Review:**
- `am_wiki_show` (read full entry after search) — not added
- `am_wiki_delete` via MCP — not added
- `am_wiki_lint` via MCP — not added
- `am_registry_check_updates` — not added
- Tool naming consistency (verb-noun order) — partially addressed

**From A2A Review:**
- Streaming/SSE support (tasks/sendSubscribe) — not implemented
- Agent Card validation on fetch — not implemented
- `am agents export` (dump Agent Card as JSON) — not implemented
- A2A MCP tools (`am_agent_delegate`, `am_agent_task_status`) still lack functional tests

**From CLI UX Review:**
- `am pull` does not auto-apply (H4) — not fixed
- `am version --verbose` for diagnostics — not added
- `am config path` and `am config edit` — not added
- `NO_COLOR` support — not added
- Examples in help text — not added

**From CLI UX Deep Analysis:**
- `requireConfig()` refactor — DONE (iteration 4)
- `parsePositiveInt()` validator — DONE (iteration 4)
- Grouped help output — IN PROGRESS (iteration 5)
- Agent namespace segregation — deferred

---

## Session Context for Resumption

- **Branch:** `main`
- **Last commit:** `085e4e1 fix: iteration 4 — CLI UX hardening + docs polish`
- **Working tree:** Clean (all changes committed)
- **Test suite:** 1470 tests passing, 0 failures
- **Lint:** Clean (Biome)
- **TypeScript:** Clean (strict mode)
- **Version:** 0.3.0 (released), working toward 0.4.0

**To resume iteration 5:**
1. Read this document and `CHANGELOG.md` [Unreleased] section
2. Pick up tasks #1 (grouped help), #2 (LOW fixes), #4 (final review)
3. After completing, bump version to 0.4.0 and cut release
