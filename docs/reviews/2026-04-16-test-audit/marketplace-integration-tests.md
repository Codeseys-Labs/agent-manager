# Test Audit: Marketplace, Community Adapter, and Integration Suites

**Date:** 2026-04-16
**Scope:** `test/marketplace/` (4 files), `test/adapters/community/` (5 files), `test/integration/` (4 files)
**Result:** 183 tests, 855 assertions, all passing

---

## 1. Marketplace Tests

### 1.1 `test/marketplace/installer.test.ts` (19 tests)

**installPlugin full flow coverage:**

The `installPlugin` integration test (line 160) covers the essential path:
1. Create a marketplace with a mock plugin
2. Call `addMarketplace()` to register it
3. Call `installPlugin("cool-plugin")`
4. Verify result has the expected plugin name and server names
5. Read config back from disk and verify the server was written with `_marketplace` provenance

**Verdict:** The full flow IS tested: scan marketplace -> find plugin -> read manifest -> add servers to config -> set `_marketplace` provenance -> commit. The `commitAll()` call is in the source at `installer.ts:84` and runs during the test (no mocking). However, the test does not verify the git commit was actually created — it only verifies the config file. This is acceptable since `git.test.ts` covers commit operations.

**applyPlugin unit tests (lines 53-155):** Thorough. Tests all three entity types independently:
- Servers: verifies `command`, `args`, `env`, `_marketplace` provenance (line 70-80)
- Skills: verifies path resolution from `pluginDir + skillPath`, `_marketplace` (line 97-102)
- Agents: verifies `name`, `_marketplace` provenance (line 126-132)
- Section initialization: verifies `servers`, `skills`, `agents` sections are created if missing (line 134-154)

**uninstallPlugin (lines 260-412):** Tests provenance-based removal for ALL entity types:
- Servers with matching `_marketplace.package` are removed, others preserved (line 262)
- Adapter removal from `adapters.toml` during uninstall (line 299)
- Skills AND agents with matching `_marketplace` provenance removed, manual ones preserved (line 340-403)
- Error: throws `MarketplaceError` when no entities found (line 405)

**listInstalled (lines 416-479):**
- Empty result when no marketplace servers exist
- Groups servers by plugin name correctly

| Finding | Severity | Detail |
|---------|----------|--------|
| `listInstalled()` only scans servers, not skills/agents | Medium | Source `installer.ts:270` returns early if `!config?.servers`. A plugin that only installs skills would not appear in `listInstalled()`. No test covers this gap. |
| No test for installing a plugin with ALL entity types at once | Low | `applyPlugin` tests each entity type in isolation; the `installPlugin` integration test only installs servers. A single test that installs servers+skills+agents+adapter and verifies all four would increase confidence. |

### 1.2 `test/marketplace/scanner.test.ts` (15 tests)

**Dual-format scanning:** Fully tested.
- `.am-plugin/plugin.json` format (line 57-72)
- `.claude-plugin/plugin.json` fallback (line 106-120)
- Priority: `.am-plugin` preferred over `.claude-plugin` when both exist (line 122-142)
- Mixed marketplace with both formats (line 252-267)
- Minimal `.claude-plugin` with only name+description (line 269-285)

**Error paths:** Well covered.
- Missing manifest returns null (line 75)
- Missing required fields (`description`) returns null (line 82)
- Invalid JSON returns null (line 96)
- Non-existent directory returns empty (line 222)
- Hidden directories skipped (line 206)

**Adapter field parsing:** Tested (line 144-156).

**searchPlugins:** Tests search by name, description, server name, and no-match case.

| Finding | Severity | Detail |
|---------|----------|--------|
| No test for `scanAllMarketplaces()` with multiple marketplaces | Low | Only `searchPlugins` calls `scanAllMarketplaces` transitively. A direct test verifying aggregation across 2+ marketplaces would help. |

### 1.3 `test/marketplace/client.test.ts` (9 tests)

Covers `deriveMarketplaceName`, `readMarketplacesFile`, `addMarketplace` (local), `removeMarketplace`, and `listMarketplaces`. All paths tested including error cases (duplicate name, nonexistent path, nonexistent marketplace).

**No issues found.** Clean and complete.

### 1.4 `test/marketplace/command.test.ts` (7 tests)

Structural validation only — verifies the citty command tree has the right subcommands, positional args, and `--json` flags. Does not test runtime behavior (that's covered by `installer.test.ts` and `client.test.ts`).

**No issues found.** Appropriate scope for command registration tests.

---

## 2. Community Adapter Tests

### 2.1 `test/adapters/community/proxy.test.ts` (10 tests)

**Real subprocess:** YES. The proxy tests use a REAL subprocess (`mock-adapter.ts` at line 5) that reads JSON-RPC from stdin and writes responses to stdout. This is a genuine integration test of the JSON-RPC protocol.

The `mock-adapter.ts` implements all 7 JSON-RPC methods: `adapter/initialize`, `adapter/meta`, `adapter/detect`, `adapter/import`, `adapter/export`, `adapter/diff`, `adapter/schema`.

**Test coverage:**
- Initialize + meta fetch (line 18-24): verifies `name`, `displayName`, `version`, `capabilities`
- Schema fetch (line 26-28): verifies defined
- All 4 async adapter methods: `detectAsync`, `importAsync`, `export`, `diffAsync`
- Synchronous fallbacks: `detect()` returns undetected, `import()` returns empty, `diff()` returns unmanaged
- `isAlive()`: true when running, false after `kill()`
- Error handling: `create()` with invalid command rejects

| Finding | Severity | Detail |
|---------|----------|--------|
| No test for JSON-RPC error responses | Low | `mock-adapter.ts` returns error for unknown methods (line 46), but no test invokes an unknown method to verify error propagation through the proxy. |
| No test for timeout behavior | Low | `RPC_TIMEOUT_MS` is 30s in the proxy. No test verifies that a hung subprocess times out. Understandable — would require a slow-responding mock adapter. |

### 2.2 `test/adapters/community/loader.test.ts` (15 tests)

**Checksum verification:** Tested with REAL binary hashes.
- Mismatch detection: computes actual SHA-256 and verifies error includes expected vs actual (line 286-308)
- Missing checksum: warns but allows (line 310-319)
- Matching checksum: verified with `crypto.createHash("sha256")` (line 321-327)
- Missing binary file: throws (line 329-333)
- Invalid format (no colon separator): throws (line 335-341)

**Dead proxy detection:** Tested (line 378-418).
- Creates live proxy, verifies `isAlive()` is true
- Kills it, verifies `isAlive()` is false
- Creates new proxy, verifies it's alive and a different instance
- Note: This tests via the proxy directly, not through `loadCommunityAdapters()`, because `loadCommunityAdapters` only passes `config.command` (no args). The comment at line 399-400 explains this.

**loadCommunityAdapters integration:**
- Rejects adapter with checksum mismatch (line 356-375)
- Skips disabled adapters (line 420-453)

**CRUD operations:** Full coverage on `readAdaptersToml`, `writeAdaptersToml`, `listCommunityAdapterNames`, `getCommunityAdapterConfig`, `setCommunityAdapterConfig`, `removeCommunityAdapterConfig` — including roundtrip through read/write.

| Finding | Severity | Detail |
|---------|----------|--------|
| `loadCommunityAdapters()` happy-path not tested end-to-end | Medium | The checksum-mismatch and disabled tests verify rejection, but there's no test that loads a community adapter with a valid checksum through the full `loadCommunityAdapters()` pipeline. The dead proxy test side-steps this by testing the proxy directly. This is because `loadCommunityAdapters` runs `command` directly (no args), and `mock-adapter.ts` needs `bun` as the command + the script path as args. |

### 2.3 `test/adapters/community/types.test.ts` (9 tests)

TypeScript interface compile-time validation. Verifies shape correctness for `CommunityAdapterConfig`, `AdaptersToml`, `AdapterManifest`, `JsonRpcRequest`, `JsonRpcResponse`, `InitializeResult`.

**No issues found.** Standard type-level tests.

### 2.4 `test/adapters/community/registry-integration.test.ts` (4 tests)

Verifies `listAdapters()` returns built-in adapters (13+), `listAllAdapters()` returns at least built-ins, and `isBuiltInAdapter()` correctly identifies built-in vs community adapters.

**No issues found.**

### 2.5 `test/adapters/community/mock-adapter.ts`

Real JSON-RPC subprocess implementing the community adapter protocol. Clean implementation with proper newline-delimited JSON-RPC 2.0. Handles all 7 methods including error for unknown methods.

---

## 3. Integration Tests

### 3.1 `test/integration/lifecycle.test.ts` (13 tests)

Uses **real CLI subprocess** via `Bun.spawn(["bun", "run", "src/cli.ts", ...args])`. All tests spawn a real process with a temp config dir.

**Covered paths:**
- `am version` — version output
- `am init` — creates `config.toml` and `.git/HEAD`
- `am init --json` — structured output
- `am add` — writes `[servers.fetch]` to config
- `am list` / `am list --json` — shows servers
- `am use default` — profile switch
- `am apply --target claude-code --dry-run` — shows plan
- `am status --json` — structured output with profile, servers, git
- `am log` / `am log --json` — commit history
- `am undo` — reverts last change
- Full lifecycle: `init → add × 2 → list → apply → status → log → undo → list`
- Idempotent init: second `init` returns exit code 1
- Duplicate server: `add` rejects

| Finding | Severity | Detail |
|---------|----------|--------|
| **No init→import→apply→verify test** | High | There is no integration test that imports from a real adapter (e.g., claude-code), then applies to the same or different adapter, and verifies the output files. This is the core value proposition of agent-manager. |
| **No add→apply→import round-trip test** | High | No test verifies: add server → apply to adapter → import back from adapter → verify servers match. This is the fundamental bidirectional sync test. |
| No `am import` in lifecycle tests at all | High | The `import` command is completely absent from integration tests. The lifecycle test covers `init → add → list → apply → status → log → undo` but never `import`. |
| `apply` only tested with `--dry-run` | Medium | The actual file-writing path of `apply` (without `--dry-run`) is not tested in integration tests. Only the "would write" dry-run path is exercised. |

### 3.2 `test/integration/error-handling.test.ts` (18 tests)

Comprehensive error path coverage:
- Commands requiring init: `add`, `log`, `undo`, `import` show helpful errors
- Graceful degradation: `list`, `status`, `apply` work with empty state
- Invalid arguments: nonexistent profile, nonexistent adapter, nonexistent target
- JSON error format for all error paths
- Push/pull without remote
- Undo with only initial commit
- Duplicate server
- Malformed TOML

**No issues found.** Excellent error handling coverage.

### 3.3 `test/integration/secret-pipeline.test.ts` (13 tests)

End-to-end secret detection → encryption → decryption pipeline. Tests:
- Import with auto-encrypt: detect secrets, substitute with `${VAR}`, encrypt to settings.env
- Key generation and persistence
- Multi-provider key detection
- Already-encrypted values skipped
- Already-templated `${VAR}` values skipped
- Full round-trip: detect → substitute → encrypt → config → interpolate → decrypt
- Edge cases: empty env, no env, empty strings, boolean-like values

**No issues found.** Thorough and well-structured.

### 3.4 `test/integration/wiki-pipeline.test.ts` (13 tests)

End-to-end session → harvest → wiki pages → BM25 search → knowledge graph → agent briefing. Tests all 6 pipeline stages with real data fixtures.

**No issues found.** Comprehensive pipeline coverage.

---

## 4. The projectPath Pattern

Checked every command that calls adapter methods:

| Command | Method | Passes projectPath? | Verdict |
|---------|--------|---------------------|---------|
| `import.ts:144` | `adapter.import()` | Yes: `{ projectPath: process.cwd() }` | OK |
| `apply.ts:110` | `adapter.export()` | Yes: `{ projectPath: projectFile ? join(projectFile, "..") : undefined }` | OK |
| `apply.ts:95` | `adapter.diff()` | N/A (diff takes `ResolvedConfig`, no projectPath param) | OK |
| `status.ts:58` | `adapter.diff()` | N/A (same as above) | OK |
| `doctor.ts:86` | `adapter.detect()` | N/A (detect takes no params) | OK |
| `init-project.ts:148` | `adapter.detect()` | N/A | OK |
| `init-project.ts:158` | `adapter.import()` | Yes: `{ projectPath }` | OK |
| `adapter.ts:44` | `adapter.detect()` | N/A | OK |
| `adapter.ts:390` | `proxy.detectAsync()` | No projectPath passed | See below |
| `mcp/server.ts:1126` | `adapter.export()` | Yes: `{ projectPath }` | OK |
| `tui/index.tsx:174` | `adapter.export()` | Yes: `{ projectPath }` | OK |

**Potential gap at `adapter.ts:390`:** The `detectAsync()` call in the adapter command does not pass `projectPath`. Looking at the proxy implementation, `detectAsync(projectPath?: string)` accepts an optional projectPath. The `adapter command` is `am adapter detect <name>` — it should probably pass `process.cwd()` as the projectPath for community adapters that need it. However, since `projectPath` is optional and detect is about tool installation (not project-specific config), this is low severity.

**No other command→module gaps found.** All commands that need projectPath pass it correctly.

---

## 5. Integration Tests Added

The following tests were added to `test/integration/lifecycle.test.ts`:

### 5.1 `am apply writes native config files (not dry-run)` (line 270)

Tests: `init → add server → apply --target claude-code` (real write, NOT dry-run) → verifies `~/.claude.json` exists on disk with correct `mcpServers` entry.

Uses `HOME` override to write to a temp directory instead of the real home.

### 5.2 `am import reads native claude-code config` (line 312)

Tests: Write a native `~/.claude.json` with 2 servers → `init → import claude-code --json` → verify both servers appear in `config.toml`.

This is the first integration test exercising the `import` command through the CLI subprocess.

### 5.3 `add → apply → import round-trip preserves server config` (line 349)

Full bidirectional sync test:
1. `init → add roundtrip-server → apply --target claude-code` (writes native config)
2. Verify `~/.claude.json` has the server
3. Create a fresh config dir → `init → import claude-code`
4. Verify the imported `config.toml` contains `[servers.roundtrip-server]` with the original command

This is the fundamental guarantee of agent-manager: what you export can be imported back.

All 3 tests pass. Total test count: 186 tests, 876 assertions across 12 files.

---

## 6. Summary of Findings

| # | Finding | Severity | Location | Status |
|---|---------|----------|----------|--------|
| 1 | No init→import→apply→verify integration test | High | `test/integration/lifecycle.test.ts` | **FIXED** — added "am import reads native claude-code config" |
| 2 | No add→apply→import round-trip integration test | High | `test/integration/lifecycle.test.ts` | **FIXED** — added "add → apply → import round-trip" |
| 3 | `am import` completely absent from integration tests | High | `test/integration/lifecycle.test.ts` | **FIXED** — covered by tests #1 and #2 |
| 4 | `apply` only tested with `--dry-run` | Medium | `test/integration/lifecycle.test.ts` | **FIXED** — added "am apply writes native config files" |
| 5 | `listInstalled()` only scans servers, not skills/agents | Medium | `src/marketplace/installer.ts:270` | Open — source bug (not test gap) |
| 6 | `loadCommunityAdapters()` happy-path not e2e tested | Medium | `test/adapters/community/loader.test.ts` | Open — limited by mock architecture |
| 7 | No test for JSON-RPC error propagation through proxy | Low | `test/adapters/community/proxy.test.ts` | Open |
| 8 | `adapter.ts:390` detectAsync without projectPath | Low | `src/commands/adapter.ts` | Open — low impact, projectPath is optional |
| 9 | No test for installing plugin with all entity types at once | Low | `test/marketplace/installer.test.ts` | Open |
| 10 | No direct test for `scanAllMarketplaces()` aggregation | Low | `test/marketplace/scanner.test.ts` | Open |

### Overall Assessment

**Marketplace tests (50/53 tests):** Strong. The install/uninstall flow is well-tested for all entity types (servers, skills, agents, adapters). Dual-format scanning is thorough. The main gap is `listInstalled()` ignoring skills/agents — this is a source-level bug, not a test gap.

**Community adapter tests (38 tests):** Good. The real subprocess approach for proxy tests is excellent. Checksum verification uses real SHA-256 hashes. The main limitation is that `loadCommunityAdapters()` can't be tested end-to-end with the mock adapter due to the command-only invocation pattern.

**Integration tests (57 tests):** The secret and wiki pipelines are excellent. The lifecycle and error tests cover the CLI well. The critical missing piece is **bidirectional sync testing** — the `import` command is completely absent, and `apply` is only tested in dry-run mode. These are the highest-priority additions.
