# Adapter Test Suite Audit

**Date:** 2026-04-16
**Scope:** test/adapters/ (76 files, 680 tests, 1807 assertions across 13 adapters + shared/ + community/)
**Baseline:** All 680 tests passing before audit

## Summary

The adapter test suite is **well-structured and consistent**. All 13 adapters follow the same
test pattern (detect, import, export, diff, roundtrip) and use real filesystem operations via
`createTestDir()`. No mock-only tests were found for filesystem operations.

### Fixes Applied

| Fix | File | Issue |
|-----|------|-------|
| Capability list stale | test/adapters/registry.test.ts | Listed 9 capabilities, actual type has 10 (`marketplace` missing) |
| DiffChange entity list stale | test/adapters/registry.test.ts | Listed 4 entity types, actual type has 5 (`agent` missing) |

### Key Findings (no fix required)

| Finding | Impact | Recommendation |
|---------|--------|----------------|
| Marketplace tests exist but only at shared level | Low | Correct pattern: copilot/cursor/kiro/windsurf delegate to `scanVSCodeExtensions()` which is thoroughly tested in shared/marketplace-vscode.test.ts. claude-code has its own marketplace.test.ts. No per-adapter marketplace tests needed. |
| Agent profile import not yet implemented | None | Adapters declare "agents" capability for export/detect only. Import is not yet implemented in source. Tests correctly reflect current scope. |
| No fixture-based tests for amazon-q, cline, roo-code, continue | Low | These adapters construct test data inline, which is more maintainable. Other adapters (forgecode, claude-code) have fixture files. Both approaches work. |

---

## Per-Adapter Audit

### 1. Detect Tests

**Methodology check:** Do tests use real filesystem paths or mock returns?

| Adapter | Real FS | projectPath tested | Notes |
|---------|---------|-------------------|-------|
| claude-code | Yes | Yes | Tests global config, project .mcp.json, CLAUDE.md, settings, skills |
| codex-cli | Yes | Yes | Tests global, project config.toml, agents dir |
| copilot | Yes | Yes | Tests .vscode/mcp.json, instructions dir |
| cursor | Yes | Yes | Tests global, project .cursor/mcp.json, rules, agents |
| forgecode | Yes | Yes | Tests project .mcp.json, AGENTS.md |
| gemini-cli | Yes | Yes | Tests global, project settings.json |
| kilo-code | Yes | Yes | Tests global kilo.jsonc, project kilo.jsonc, agents |
| kiro | Yes | Yes | Tests global, project mcp.json, steering, agents, skills |
| windsurf | Yes | Yes | Tests global mcp_config.json, rules, skills |
| cline | Yes | Yes | Tests VS Code globalStorage path, .clinerules dir/file |
| roo-code | Yes | Yes | Tests VS Code globalStorage, .roo/ dirs |
| amazon-q | Yes | Yes | Tests .aws/amazonq/, project .amazonq/ |
| continue | Yes | Yes | Tests .continue/config.json |

**Verdict:** All detect tests use real filesystem. No mocking. Excellent.

### 2. Import Tests - projectPath Pattern

**Methodology check:** Do import tests pass `projectPath` to exercise project-level config reading?

| Adapter | projectPath tested | Scopes verified | Notes |
|---------|-------------------|----------------|-------|
| claude-code | Yes | global + project | Tests .mcp.json (project), .claude.json (global), CLAUDE.md, skills |
| codex-cli | Yes | global + project | Tests .codex/config.toml (project), AGENTS.md |
| copilot | Yes | project-only | Copilot is project-scoped by design (.vscode/mcp.json) |
| cursor | Yes | global + project | Tests global ~/.cursor/mcp.json + project .cursor/mcp.json |
| forgecode | Yes | project-only | ForgeCode uses .mcp.json (project-scoped) |
| gemini-cli | Yes | global + project | Tests global + project .gemini/settings.json |
| kilo-code | Yes | global + project | Tests global kilo.jsonc + project .kilo/kilo.jsonc |
| kiro | Yes | global + project | Tests global + project mcp.json + steering + skills |
| windsurf | Yes | global + project | Tests mcp_config.json (global) + .windsurf/rules + skills |
| cline | Yes | global + project | Tests globalStorage (global) + .clinerules (project) |
| roo-code | Yes | global + project | Tests mcp_settings.json + .roo/mcp.json + rules |
| amazon-q | Yes | global + project | Tests global .aws/amazonq/mcp.json + project .amazonq/mcp.json |
| continue | Yes | global + project | Tests global + project .continue/config.json |

**Verdict:** All 13 adapters test projectPath. No adapter is missing project-level config tests.
The projectPath bug pattern we hypothesized does NOT exist in the current codebase.

### 3. Export Tests - Format Verification

**Methodology check:** Do export tests verify the output matches the actual IDE config format?

| Adapter | Format verified | Key assertions |
|---------|----------------|----------------|
| claude-code | Yes | JSON structure of .claude.json, mcpServers shape, adapter extras (alwaysAllow), CLAUDE.md markers, disabled server filtering, field preservation |
| codex-cli | Yes | TOML output for .codex/config.toml, AGENTS.md markers, project-scoped config |
| copilot | Yes | .vscode/mcp.json servers key, .github/instructions/*.md, HTTP server type field |
| cursor | Yes | .cursor/mcp.json mcpServers, .cursor/rules/*.mdc, URL servers, agent files |
| forgecode | Yes | .mcp.json mcpServers, AGENTS.md, .forge/skills/ |
| gemini-cli | Yes | .gemini/settings.json mcpServers, GEMINI.md markers |
| kilo-code | Yes | kilo.jsonc new format (mcp key), AGENTS.md, project config |
| kiro | Yes | .kiro/settings/mcp.json, .kiro/steering/*.md, .kiro/agents/*.json |
| windsurf | Yes | mcp_config.json mcpServers, .windsurf/rules/*.md, skills |
| cline | Yes | cline_mcp_settings.json, .clinerules/* |
| roo-code | Yes | mcp_settings.json, .roo/rules/* |
| amazon-q | Yes | .aws/amazonq/mcp.json, .amazonq/rules/*.md |
| continue | Yes | .continue/config.json array format, rules export |

**Verdict:** All export tests validate the native IDE config format. Strong format fidelity.

### 4. Diff Tests - Real Drift Scenarios

| Adapter | Scenarios tested |
|---------|-----------------|
| claude-code | in-sync, added-locally, removed-locally, modified fields, unmanaged, key order normalization, env changes |
| codex-cli | in-sync, added-locally, removed-locally, modified, unmanaged |
| copilot | in-sync, added-locally, removed-locally, modified, unmanaged, instruction drift |
| cursor | in-sync, added-locally, removed-locally, modified, instruction drift |
| forgecode | in-sync, added-locally, removed-locally, modified, unmanaged, instruction drift |
| gemini-cli | in-sync, added-locally, removed-locally, modified, unmanaged |
| kilo-code | in-sync, added-locally, removed-locally, modified, new vs legacy format |
| kiro | in-sync, added-locally, removed-locally, modified, HTTP servers, instruction drift |
| windsurf | in-sync, added-locally, removed-locally, modified, unmanaged |
| cline | in-sync, added-locally, removed-locally, modified, unmanaged |
| roo-code | in-sync, added-locally, removed-locally, modified, instruction drift |
| amazon-q | in-sync, added-locally, removed-locally, modified, unmanaged |
| continue | in-sync, added-locally, removed-locally, modified, unmanaged |

**Verdict:** All adapters test the core drift scenarios. Instruction drift is tested for adapters that support marker-based instructions.

### 5. Shared Utils Post-Migration

**Question:** After shared utils migration, do tests validate adapter-specific behavior or just that shared functions are called?

| Shared utility | Tests | Notes |
|---------------|-------|-------|
| `compareServerFields()` | Direct tests in shared/utils.test.ts (3 scenarios) | Covers stdio vs HTTP, identical servers, missing fields |
| `compareInstructions()` | Direct tests in shared/diff-utils.test.ts (8 scenarios) | Covers added, removed, modified, matching, no markers |
| `spliceMarkerBlock()` | Direct tests in shared/utils.test.ts (4 scenarios) | Insert, append, replace, preserve |
| `scanVSCodeExtensions()` | Direct tests in shared/marketplace-vscode.test.ts (12 scenarios) | All 4 VS Code adapters, malformed JSON, no extensions |
| `sortKeys()`, `normalize()`, `fileExistsSync()`, `readJsonFile()` | Direct tests | Utility coverage |

**Verdict:** Shared utils have their own comprehensive tests. Per-adapter tests exercise adapter-specific
behavior (config path resolution, format parsing, adapter extras) while delegating common logic to shared tests. This is the correct architecture.

### 6. Marketplace Tests

| Adapter | Has marketplace capability | Test coverage |
|---------|--------------------------|---------------|
| claude-code | Yes | claude-code/marketplace.test.ts (10 tests: plugins, skills, multiple, missing, path traversal security) |
| copilot | Yes | Covered by shared/marketplace-vscode.test.ts (tests copilot source specifically) |
| cursor | Yes | Covered by shared/marketplace-vscode.test.ts (tests cursor source specifically) |
| kiro | Yes | Covered by shared/marketplace-vscode.test.ts (tests kiro source specifically) |
| windsurf | Yes | Covered by shared/marketplace-vscode.test.ts (tests windsurf source specifically) |

**Verdict:** All 5 marketplace adapters have test coverage. The shared scanner tests explicitly verify
per-adapter source tagging (e.g., `cursor-extension`, `kiro-extension`). Security test for path traversal exists in claude-code marketplace test.

### 7. Community Adapter Tests

| File | Tests | Notes |
|------|-------|-------|
| community/loader.test.ts | 9 tests | Reads adapters.toml, lazy proxy cache, checksum verification |
| community/proxy.test.ts | 7 tests | JSON-RPC subprocess lifecycle, error handling |
| community/types.test.ts | 5 tests | Type validation for CommunityAdapterConfig |
| community/registry-integration.test.ts | 4 tests | Integration with main adapter registry |

**Verdict:** Community adapter subsystem is well-tested. Checksum verification (tamper detection) is tested.

### 8. Roundtrip Tests

All 13 adapters have roundtrip.test.ts files that verify import -> export -> diff cycle.
These are the highest-fidelity tests as they exercise the full adapter pipeline.

---

## Stale Fixtures Check

| Fixture dir | Files | Current format | Stale? |
|------------|-------|----------------|--------|
| claude-code | sample-claude.json, sample-mcp.json, sample-CLAUDE.md | Yes | No |
| codex-cli | sample-config.toml, sample-AGENTS.md | Yes | No |
| copilot | sample-mcp.json, instructions files | Yes | No |
| cursor | global-mcp.json, project-mcp.json, .mdc rules, .cursorrules, agents | Yes | No |
| forgecode | sample-mcp.json, sample-AGENTS.md | Yes | No |
| gemini-cli | sample-settings.json, sample-GEMINI.md | Yes | No |
| kilo-code | sample-kilo.jsonc, sample-legacy.json, sample-project.jsonc | Yes (both formats) | No |
| kiro | mcp.json, steering files, SKILL.md, agent.json | Yes | No |
| windsurf | sample-mcp_config.json, sample-rule.md, sample-windsurfrules | Yes | No |

**Verdict:** No stale fixtures detected. Kilo-code correctly includes both new (kilo.jsonc) and legacy (mcpServers) format fixtures.

---

## Test Counts by Adapter

| Adapter | detect | import | export | diff | roundtrip | marketplace | session | Total |
|---------|--------|--------|--------|------|-----------|-------------|---------|-------|
| claude-code | 10 | 14 | 7 | 7 | 3 | 10 | 3 | 54 |
| codex-cli | 7 | 8 | 8 | 5 | 3 | - | 3 | 34 |
| copilot | 5 | 8 | 10 | 6 | 3 | - | - | 32 |
| cursor | 8 | 11 | 9 | 8 | 3 | - | - | 39 |
| forgecode | 7 | 8 | 8 | 8 | 4 | - | - | 35 |
| gemini-cli | 6 | 8 | 10 | 6 | 3 | - | - | 33 |
| kilo-code | 11 | 15 | 10 | 7 | 5 | - | - | 48 |
| kiro | 9 | 15 | 8 | 8 | 4 | - | - | 44 |
| windsurf | 7 | 12 | 10 | 6 | 3 | - | - | 38 |
| cline | 5 | 10 | 8 | 5 | 7 | - | - | 35 |
| roo-code | 7 | 9 | 7 | 6 | 5 | - | - | 34 |
| amazon-q | 4 | 8 | 6 | 5 | 3 | - | - | 26 |
| continue | 5 | 8 | 10 | 6 | 3 | - | - | 32 |
| shared | - | - | - | - | - | 12 | - | 41 |
| community | - | - | - | - | - | - | - | 25 |
| registry | - | - | - | - | - | - | - | 17 |

**Total: 680 tests across 76 files**

---

## Conclusions

1. **No projectPath bug found.** All 13 adapters correctly test project-level config import.
2. **Registry test was stale** -- fixed: Capability list (9 -> 10, added `marketplace`) and DiffChange entity list (4 -> 5, added `agent`).
3. **Marketplace testing is solid** -- coverage exists at the shared utility level with per-adapter source verification, plus Claude Code has its own dedicated marketplace tests.
4. **Shared utils migration is clean** -- adapter tests focus on adapter-specific behavior, shared tests cover common logic.
5. **All tests use real filesystem** -- no mock-only patterns detected for filesystem operations.
6. **Fixture files are current** -- all match the adapter's current native config format.
