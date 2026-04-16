# Adapter Modernization Analysis

**Date:** 2026-04-16
**Scope:** 11 un-migrated adapters vs shared utils in `src/adapters/shared/`

## Current State

### Shared Utilities Available

**`shared/utils.ts`** (127 LOC) provides:
- `sortKeys()` / `normalize()` -- deterministic deep comparison
- `compareServerFields()` -- field-level server drift detection (command, args, env)
- `fileExistsSync()` / `readJsonFile()` -- safe file I/O
- `spliceMarkerBlock()` -- am:begin/am:end marker-based content replacement
- `AM_BEGIN` / `AM_END` constants

**`shared/diff-utils.ts`** (109 LOC) provides:
- `compareInstructions()` -- instruction drift detection via managed block extraction

### Migration Status

| Adapter | Uses shared/utils | Uses shared/diff-utils | Status |
|---------|:-:|:-:|--------|
| claude-code | `compareServerFields`, `readJsonFile` | `compareInstructions` | **Migrated** |
| cursor | `compareServerFields`, `readJsonFile` | `compareInstructions` | **Migrated** |
| kilo-code | `compareServerFields`, `normalize`, `sortKeys` | `compareInstructions` | **Partially migrated** (diff.ts only) |
| Other 10 | -- | -- | **Not migrated** |

## Duplication Analysis

### Per-Adapter Line Counts

| Adapter | diff.ts | export.ts | import.ts | Total* | Dup. in diff | Dup. in export | Dup. in import |
|---------|--------:|----------:|----------:|-------:|---:|---:|---:|
| Windsurf | 128 | 135 | 229 | 627 | ~50 | ~18 | ~10 |
| Gemini CLI | 161 | 141 | 155 | 597 | ~50 | ~18 | ~10 |
| Amazon Q | 128 | 103 | 169 | 516 | ~50 | 0 | ~10 |
| ForgeCode | 151 | 140 | 208 | 657 | ~50 | ~30 | ~10 |
| Codex CLI | 175 | 176 | 172 | 1163 | ~50 | ~30 | ~10 |
| Kiro | 174 | 189 | 273 | 898 | ~50 | ~30 | ~10 |
| Copilot | 146 | 140 | 234 | 651 | ~35 | 0 | ~10 |
| Cline | 161 | 104 | 182 | 584 | ~50 | 0 | 0 |
| Roo Code | 178 | 137 | 289 | 759 | ~50 | 0 | 0 |
| Continue | 139 | 143 | 201 | 593 | ~40 | 0 | ~10 |
| Kilo Code | 183 | 190 | 441 | 1178 | 0** | ~30 | ~10 |

*Total includes detect.ts, index.ts, schema.ts, identity.ts, etc.
**Kilo Code diff.ts already imports shared utils.

### Duplicated Patterns (What Shared Utils Can Replace)

**1. `sortKeys()` + `normalize()` in diff.ts** (~20 LOC each)
Duplicated verbatim in: Windsurf, Gemini CLI, Amazon Q, ForgeCode, Codex CLI, Kiro, Copilot, Cline, Roo Code, Continue (10 adapters)

**2. `compareServer()` in diff.ts** (~30 LOC each)
Every un-migrated adapter has a local `compareServer()` that does the same field-by-field comparison as `compareServerFields()` from shared/utils.ts. Most are identical; a few (Copilot, Codex CLI, Kiro) add HTTP URL comparison which `compareServerFields` does not yet handle.

**3. `readNativeServers()` in diff.ts** (~10-15 LOC each)
Most JSON-based adapters have a local `readNativeServers()` that reads JSON and extracts `mcpServers`. This can be replaced by `readJsonFile()` + a one-liner extraction.

**4. `fileExistsSync()` in import.ts** (~8 LOC each)
Duplicated in: Windsurf, Gemini CLI, Amazon Q, ForgeCode, Copilot, Continue (6 adapters)

**5. `AM_BEGIN`/`AM_END` + marker splicing in export.ts** (~20-30 LOC each)
Duplicated in: ForgeCode, Codex CLI, Kilo Code, Kiro. The `spliceMarkerBlock()` from shared/utils.ts replaces `generateAgentsMd()` / `generateClaudeMd()` patterns.

**6. No instruction drift detection in diff.ts**
Only claude-code, cursor, and kilo-code use `compareInstructions()`. The other 8 adapters with instruction support have **no instruction drift detection at all** -- migrating to shared utils would unlock this.

## Per-Adapter Assessment

### Tier 1: Easy Migration (standard JSON, near-identical patterns)

**Windsurf** -- LOW risk
- Config: `~/.codeium/windsurf/mcp_config.json` (standard `mcpServers` JSON)
- diff.ts: Drop-in replacement with `compareServerFields`, `sortKeys`, `normalize`, `readJsonFile`
- export.ts: Replace marker splicing with `spliceMarkerBlock` (not applicable -- uses rules/ dir)
- import.ts: Replace `fileExistsSync` with shared version
- LOC to change: ~55 lines removed, ~5 import lines added
- Unlocks: instruction drift detection (currently missing)

**Gemini CLI** -- LOW risk
- Config: `~/.gemini/settings.json` (standard `mcpServers` JSON)
- diff.ts: Drop-in replacement with `compareServerFields`, `sortKeys`, `normalize`, `readJsonFile`
- import.ts: Replace `fileExistsSync` with shared version
- LOC to change: ~55 lines removed, ~5 import lines added
- Note: export.ts already uses `core/instructions.ts` helpers -- most advanced of un-migrated adapters

**Amazon Q** -- LOW risk
- Config: `~/.aws/amazonq/mcp.json` (standard `mcpServers` JSON)
- diff.ts: Drop-in replacement with `compareServerFields`, `sortKeys`, `normalize`, `readJsonFile`
- import.ts: Replace `fileExistsSync` with shared version
- LOC to change: ~55 lines removed, ~5 import lines added
- Simplest adapter overall (no special instruction format, no skills)

### Tier 2: Moderate Migration (standard JSON with adapter-specific quirks)

**ForgeCode** -- LOW risk
- Config: `.mcp.json` (standard `mcpServers` JSON, project-only)
- diff.ts: Drop-in replacement
- export.ts: Replace local `AM_BEGIN`/`AM_END` + `generateAgentsMd()` with shared `spliceMarkerBlock`
- import.ts: Replace `fileExistsSync`
- LOC to change: ~75 lines removed
- Note: skill reading is adapter-specific and stays

**Cline** -- LOW risk
- Config: VS Code globalStorage `cline_mcp_settings.json` (standard `mcpServers` JSON)
- diff.ts: Drop-in replacement (read path is via `getGlobalStoragePath`, but comparison is standard)
- LOC to change: ~50 lines removed
- Note: import.ts handles `.clinerules` as file-or-directory -- adapter-specific, stays

**Roo Code** -- LOW risk
- Config: VS Code globalStorage + `.roo/mcp.json` (standard `mcpServers` JSON)
- diff.ts: Drop-in replacement
- LOC to change: ~50 lines removed
- Note: import.ts has mode-specific rules + legacy fallbacks -- adapter-specific, stays

**Codex CLI** -- MEDIUM risk
- Config: `.codex/config.toml` (TOML, not JSON!)
- diff.ts: `readNativeServers()` uses TOML parser, but `compareServer` is identical to shared version. Can use `compareServerFields` + `sortKeys` + `normalize` but NOT `readJsonFile`
- export.ts: Replace local `AM_BEGIN`/`AM_END` + `generateAgentsMd()` with shared `spliceMarkerBlock`
- LOC to change: ~70 lines removed
- Risk: TOML dependency makes file I/O adapter-specific

**Continue** -- MEDIUM risk
- Config: `~/.continue/config.json` (JSON but `mcpServers` is an **ARRAY**, not object map)
- diff.ts: `readNativeServers()` converts array to map -- this conversion stays adapter-specific, but `compareServer` can be replaced with `compareServerFields`
- LOC to change: ~40 lines removed
- Risk: Array-to-map conversion is unique; `readJsonFile` alone doesn't work

### Tier 3: Complex Migration (non-standard formats, partial migration already done)

**Copilot** -- MEDIUM risk
- Config: `.vscode/mcp.json` with `servers` key (NOT `mcpServers`)
- diff.ts: `compareServer` has HTTP-specific URL comparison logic not in `compareServerFields`
- Requires: extending `compareServerFields` to handle URL-based servers, or keeping a wrapper
- LOC to change: ~40 lines removed (after extending shared utils)
- Risk: need to modify shared/utils.ts to add HTTP support

**Kiro** -- MEDIUM risk
- Config: `.kiro/settings/mcp.json` (standard `mcpServers` JSON)
- diff.ts: `compareServer` has HTTP URL comparison (same issue as Copilot)
- export.ts: Has marker splicing for steering files -- can use `spliceMarkerBlock`
- LOC to change: ~70 lines removed
- Requires: HTTP URL support in `compareServerFields`

**Kilo Code** -- LOW risk (already partially done)
- diff.ts: Already migrated to shared utils
- export.ts: Replace local `AM_BEGIN`/`AM_END` + `generateAgentsMd()` with shared constants + `spliceMarkerBlock`
- import.ts: No `fileExistsSync` duplication (uses own `readJsoncFile`)
- LOC to change: ~25 lines removed
- Note: JSONC format is adapter-specific (has its own `jsonc.ts`)

## Prioritized Top 3 Migration Candidates

### 1. Windsurf (RECOMMENDED FIRST)

| Metric | Value |
|--------|-------|
| Risk | LOW |
| Effort | ~55 LOC removed, ~5 LOC added |
| Files changed | diff.ts, import.ts |
| Shared utils needed | `compareServerFields`, `sortKeys`, `normalize`, `readJsonFile`, `fileExistsSync` |
| New capabilities unlocked | Instruction drift detection |
| Why first | Simplest standard-JSON adapter with the most direct pattern match. Zero adapter quirks. No HTTP servers. Perfect template for the rest. |

**Specific changes:**
- diff.ts: Remove local `compareServer`, `sortKeys`, `normalize`, `readNativeServers`. Import from shared. Replace `readNativeServers` body with `readJsonFile()` + extraction.
- import.ts: Remove local `fileExistsSync`. Import from shared.
- Optionally: Add `compareInstructions` call to diff.ts for instruction drift.

### 2. Gemini CLI

| Metric | Value |
|--------|-------|
| Risk | LOW |
| Effort | ~55 LOC removed, ~5 LOC added |
| Files changed | diff.ts, import.ts |
| Shared utils needed | `compareServerFields`, `sortKeys`, `normalize`, `readJsonFile`, `fileExistsSync` |
| New capabilities unlocked | Instruction drift detection |
| Why second | Nearly identical pattern to Windsurf. export.ts already uses core helpers (ahead of others). Validates the pattern from Windsurf migration. |

**Specific changes:**
- diff.ts: Same as Windsurf -- remove local helpers, import shared.
- import.ts: Remove local `fileExistsSync`. Import from shared.
- Optionally: Add `compareInstructions` call for GEMINI.md drift.

### 3. ForgeCode

| Metric | Value |
|--------|-------|
| Risk | LOW |
| Effort | ~75 LOC removed, ~8 LOC added |
| Files changed | diff.ts, export.ts, import.ts |
| Shared utils needed | `compareServerFields`, `sortKeys`, `normalize`, `readJsonFile`, `fileExistsSync`, `spliceMarkerBlock`, `AM_BEGIN`, `AM_END` |
| New capabilities unlocked | Instruction drift detection, marker block normalization |
| Why third | Tests both diff AND export migration paths. Uses `AM_BEGIN`/`AM_END` markers in export.ts (unlike Windsurf/Gemini which use separate rule files). Validates `spliceMarkerBlock` adoption. |

**Specific changes:**
- diff.ts: Remove local `compareServer`, `sortKeys`, `normalize`, `readNativeServers`. Import from shared.
- export.ts: Remove local `AM_BEGIN`, `AM_END`, `generateAgentsMd()`. Import shared constants + `spliceMarkerBlock`.
- import.ts: Remove local `fileExistsSync`. Import from shared.
- Optionally: Add `compareInstructions` call for AGENTS.md drift.

## Prerequisite: Extend `compareServerFields` for HTTP

Before migrating Copilot, Kiro, or Codex CLI, extend `compareServerFields` in shared/utils.ts to handle URL-based servers:

```ts
// In compareServerFields, add after command comparison:
if (expected.transport === "streamable-http" || expected.transport === "sse") {
  const expectedUrl = expected.url ?? expected.command;
  const nativeUrl = native.url ?? native.command;
  if (expectedUrl !== nativeUrl) {
    diffs.push({ field: "url", expected: expectedUrl, actual: nativeUrl });
  }
} else {
  // existing command comparison
}
```

This ~10 LOC change unblocks 3 additional adapters (Copilot, Kiro, Codex CLI).

## Format Updates Needed

| Adapter | Issue | Action |
|---------|-------|--------|
| Kilo Code | Uses both legacy `mcpServers` and new `mcp` key formats | No change needed -- adapter correctly handles both |
| Copilot | Uses `servers` key (not `mcpServers`) | Adapter-specific -- stays in copilot/diff.ts |
| Continue | Uses array format for `mcpServers` | Adapter-specific -- stays in continue/diff.ts |
| Cline/Roo Code | VS Code globalStorage path detection | Adapter-specific -- stays in detect.ts |

No adapters need format updates based on recent tool changes. All current native formats match the adapter implementations.

## Summary: Total Duplication Across All 11 Adapters

| Duplicated Pattern | Instances | LOC per Instance | Total Duplicated LOC |
|---|:-:|:-:|:-:|
| `sortKeys()` | 10 | 7 | 70 |
| `normalize()` | 10 | 4 | 40 |
| `compareServer()` / `compareServerFields()` | 10 | 25-35 | ~300 |
| `readNativeServers()` (JSON variant) | 8 | 10-15 | ~100 |
| `fileExistsSync()` | 6 | 7 | 42 |
| `AM_BEGIN`/`AM_END` + marker splice | 4 | 20-30 | ~100 |
| **Total** | | | **~650 LOC** |

Migrating all 11 adapters would eliminate ~650 lines of duplicated code and add instruction drift detection to 8 adapters that currently lack it.
