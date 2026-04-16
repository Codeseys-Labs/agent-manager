# MCP + Command Test Audit

**Date:** 2026-04-16
**Scope:** `test/mcp/server.test.ts` (33 tools) + `test/commands/` (31 files)
**Baseline:** 312 tests passing | **After fixes:** 322 tests passing

---

## MCP Server Tests (`test/mcp/server.test.ts`)

### Coverage Summary (33 tools)

| Tool | Handler Tested | Error Path | Hint Field |
|------|:---:|:---:|:---:|
| am_list_servers | YES (2 tests: all + active filter) | - | - |
| am_list_profiles | **YES (added)** | - | - |
| am_status | YES | - | - |
| am_config_show | YES | - | - |
| am_doctor | YES (2 tests: health + read-only tier) | - | - |
| am_add_server | YES (write + verify) | **YES (added: duplicate)** | **YES (added)** |
| am_remove_server | YES | **YES (added: not found)** | **YES (added)** |
| am_server_update | YES (4 tests: props, env merge, args, error) | YES | - |
| am_undo | YES (2 tests: success + nothing-to-undo) | YES | - |
| am_use_profile | **YES (added)** | **YES (added: nonexistent)** | - |
| am_import | **YES (added: auto + specific + projectPath regression)** | **YES (added: bad adapter)** | **YES (added)** |
| am_apply | YES (dry-run, write-local tier check) | - | - |
| am_sync_push | YES (rejected without opt-in, 2 tests) | YES | - |
| am_sync_pull | - (only permission test) | YES (opt-in) | - |
| am_session_list | YES (2 tests: adapter filter + empty) | - | - |
| am_session_export | YES (3 tests: no reader, missing session, bad adapter) | YES | - |
| am_session_search | YES (2 tests: results structure + role filter) | - | - |
| am_registry_search | NO (tested via command tests) | - | - |
| am_registry_install | NO (tested via command tests) | - | - |
| am_registry_list_installed | NO (tested via command tests) | - | - |
| am_agent_discover | NO (requires network) | - | - |
| am_agent_list | NO (tested via command tests) | - | - |
| am_agent_delegate | NO (requires network) | - | - |
| am_agent_task_status | NO (requires network) | - | - |
| am_wiki_search | NO (tested via wiki command tests) | - | - |
| am_wiki_add | NO (tested via wiki command tests) | - | - |
| am_wiki_synthesize | NO (tested via wiki command tests) | - | - |
| am_wiki_briefing | NO (tested via wiki command tests) | - | - |
| am_wiki_harvest | NO (tested via wiki command tests) | - | - |
| am_run_agent | YES (tier check, rejected without opt-in) | YES | - |
| am_acp_list_agents | YES (returns agents from registry) | - | - |
| am_acp_session_list | YES (empty when no dir) | - | - |
| am_acp_session_cancel | YES (2 tests: error + permission) | YES | - |

### Key Findings

1. **14 core tools tested with real handler invocations** (not just registration). The remaining 19 tools that lack direct MCP handler tests are covered indirectly via command-level tests or require network/subprocess access.

2. **Tests set up real config state** via `setupConfig()` which creates temp dirs, initializes git repos, and writes real `config.toml` files. This is high-quality test setup.

3. **Session tools tested with both mocked and real data.** The `MCP session tools -- core function integration` describe block tests `filterMessages`, `formatMarkdown`, `formatJson` with realistic session data including tool calls.

4. **ACP tools have good tier and schema validation** but no subprocess-level integration (expected -- ACP requires real agents).

### Bug Fixed

**`am_import` missing `projectPath`:** The MCP server's `am_import` handler called `adapter.import({})` instead of `adapter.import({ projectPath: process.cwd() })`. This meant project-level configs (`.mcp.json`, `.cursor/mcp.json`, etc.) were silently skipped when importing via MCP. Fixed in `src/mcp/server.ts:887`. Regression test added in both `test/mcp/server.test.ts` and `test/commands/import.test.ts`.

### Tests Added (MCP)

| Test | What it verifies |
|------|-----------------|
| Error hint field on am_remove_server | `hint` field populated from "sentence. Recovery." error pattern |
| am_add_server duplicate error + hint | Error on duplicate server includes actionable hint |
| am_use_profile nonexistent error | Error shows available profiles |
| am_import nonexistent adapter error + hint | Error includes hint to list adapters |
| am_import auto structured result | Import with 'auto' returns action/imported fields |
| am_import specific adapter result | Import with 'claude-code' passes projectPath |
| am_list_profiles handler | Returns profiles with active indicator and inheritance |
| am_use_profile handler | Switches active profile via MCP handler |

---

## Command Tests (`test/commands/`, 31 files)

### Classification by Test Quality

**Tier 1: Real handler tests with config state** (18 commands)
These tests create temp dirs, write real configs, and invoke actual logic:

| File | Tests | Key patterns |
|------|-------|-------------|
| add.test.ts | 3 | Writes server to config, verifies on disk |
| apply.test.ts | 3 | Resolved config, encrypted env, adapter passthrough |
| config.test.ts | 5 | Validate, show raw, show merged with local override |
| doctor.test.ts | 5 | Health checks: config dir, git, adapters, key, remote |
| import.test.ts | 8+2 | extractServerIdentity (8), **projectPath regression (2 added)** |
| init.test.ts | 3 | Creates .git, config.toml, idempotent detection |
| init-project.test.ts | 8 | Scans project configs, dedup, instructions, env vars |
| install.test.ts | 5 | Registry install, dry-run, env placeholders, 404 |
| list.test.ts | 2 | Lists servers from config, empty config |
| log.test.ts | 5 | formatLogEntry prefix symbols (+, -, arrow, revert, dot) |
| profile.test.ts | 7 | List, show (inheritance), create, delete, dependents |
| pull.test.ts | 5 | No remote, uninit, reject, addRemote, network error |
| push.test.ts | 5 | No remote, uninit, reject, addRemote, network error |
| search.test.ts | 6 | Mock fetch, table/JSON output, empty, error, tag filter |
| secret.test.ts | 6 | Generate key, import, encrypt/decrypt roundtrip, list, wrong key |
| status.test.ts | 3 | Clean/dirty status, server count |
| undo.test.ts | 2 | Revert commit, fail on single commit |
| uninstall.test.ts | 5 | Remove, not found, dry-run, preserves others, JSON output |
| update.test.ts | 5 | Detect updates, skip manual, dry-run, registry error, up-to-date |
| use.test.ts | 3 | Write/read state.toml, overwrite, null when missing |

**Tier 2: Tests with real logic but no config setup** (7 commands)

| File | Tests | What they actually test |
|------|-------|----------------------|
| adapter.test.ts | 5 | Registry listing, lazy loading, interface methods, detect |
| agents.test.ts | 8 | Roster CRUD via discovery module (not CLI runner) |
| completion.test.ts | Many | Generated shell completions for bash/zsh/fish |
| help.test.ts | 8 | COMMAND_GROUPS correctness, renderGroupedHelp output |
| session.test.ts | 18 | Session core functions (filter, format, parse), subcommand structure |
| version.test.ts | 2 | Prints semver format via CLI runner |
| wiki.test.ts | 11 | Storage CRUD, search (MiniSearch), page lifecycle |

**Tier 3: Registration-only tests (ZERO handler tests)** (4 commands)

| File | Tests | Problem |
|------|-------|---------|
| mcp-serve.test.ts | 2 | `meta.name === 'mcp-serve'` and description exists |
| serve.test.ts | 7 | meta check + port validation (no server startup) |
| run.test.ts | ~15 | Agent resolution, command parsing, JSON shape -- but no actual `run` handler invocation |
| flow.test.ts | ~15 | Subcommand structure checks + flows engine integration -- but no CLI handler invocation |

**Missing test file entirely:**
- `marketplace.test.ts` -- the `marketplace` command (add, list, install, update, remove, search, uninstall) has NO test file at all.

### Critical Pattern: Commands with Only Export/Registration Checks

The `mcp-serve.test.ts` file is the worst offender:
```typescript
test("meta name is 'mcp-serve'", () => {
  expect(mcpServeCommand.meta?.name).toBe("mcp-serve");
});
```
This tests nothing useful. The MCP server is actually well-tested in `test/mcp/server.test.ts`, but the command runner (`mcp-serve.ts`) that wires stdin/stdout to the McpServer class has zero handler coverage.

Similarly, `serve.test.ts` only validates port argument parsing, not actual server behavior.

### Stale Fixture Data

No stale fixtures detected. The test files use `createTestDir()` for temporary isolation and write configs inline. The `test/fixtures/` directory contains static native config samples used by adapter tests, not command tests.

### Commands Testing Only Happy Path

| Command | Missing error paths |
|---------|-------------------|
| list.test.ts | No test for `--json` or `--active` flag behavior |
| status.test.ts | No test for missing config dir or invalid config |
| adapter.test.ts | No test for adapter detect failures or import errors |
| agents.test.ts | No test for CLI subcommand runner (all tests use discovery module directly) |

---

## Summary of Changes

### Fixed
- **`src/mcp/server.ts:887`**: `am_import` handler now passes `{ projectPath: process.cwd() }` to `adapter.import()` instead of `{}`

### Tests Added (10 new tests)
- `test/mcp/server.test.ts`: 8 new tests (error hints, am_list_profiles, am_use_profile, am_import)
- `test/commands/import.test.ts`: 2 new tests (projectPath regression via MCP handler)

### Recommendations for Future Work
1. **Add `test/commands/marketplace.test.ts`** -- the marketplace command is entirely untested
2. **Add real handler tests to `mcp-serve.test.ts`** -- test the stdin/stdout JSON-RPC wire-up
3. **Add server startup test to `serve.test.ts`** -- currently only validates port parsing
4. **Add CLI runner tests for `run.test.ts`** -- currently only tests resolution, not execution
5. **Test `--json` output format** for `list`, `status`, `adapter` commands
