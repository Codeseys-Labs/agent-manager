# Adapter Storage & Schema Correctness Audit

**Date:** 2026-04-16
**Scope:** All 13 built-in adapters in `src/adapters/`
**Method:** Source inspection + upstream documentation verification via WebFetch
**Goal:** Verify each adapter reads/writes to the ACTUAL file location each tool expects, with the correct schema, on every platform.

---

## Summary

**Overall correctness rating: 6 / 10**

Most terminal-CLI adapters (claude-code, gemini-cli, amazon-q, codex-cli, forgecode) are solid — their storage conventions are well-documented and our paths match upstream. The issues cluster in three places: **(1) stale VS Code extension IDs**, **(2) Continue's migration from `config.json` to `config.yaml`**, and **(3) tools that are available as both a CLI and a VS Code extension (Kilo, Copilot)** where we only cover one surface.

### Top Issues (in priority order)

1. **CRITICAL — Continue adapter reads a deprecated file (`~/.continue/config.json`).** Continue has migrated to `config.yaml` (plus `.continue/mcpServers/*.yaml` block files). Most modern Continue installs will have **no** `config.json` at all, so `import()` returns nothing and `export()` writes to a file Continue ignores. (`src/adapters/continue/{detect,import,export}.ts`)
2. **CRITICAL — Kilo-Code adapter only covers the CLI, not the VS Code extension (`kilocode.Kilo-Code`).** Servers configured in the VS Code UI are invisible to us, and we never write to the extension's globalStorage. This is the exact failure mode the user flagged. (`src/adapters/kilo-code/detect.ts`)
3. **CRITICAL — Copilot user-level MCP path is macOS-only and points to the wrong file.** The code hardcodes `~/Library/Application Support/Code/User/mcp.json` (macOS only, no Linux / Windows branch). VS Code's real user-profile MCP file varies by profile and by install variant (Code, Code - Insiders, VSCodium), which we don't handle. (`src/adapters/copilot/detect.ts:23`)
4. **HIGH — No variant handling for VS Code Insiders / VSCodium anywhere.** All four VS-Code-extension adapters (cline, roo-code, kilo-code, copilot) hardcode the `"Code"` product folder. Users on Insiders / VSCodium / Cursor-with-extension get a false "not installed" result. (`src/adapters/{cline,roo-code}/detect.ts`)
5. **HIGH — Roo Code extension ID casing ambiguity.** Upstream uses `RooVeterinaryInc.roo-cline` (mixed case). We pass `rooveterinaryinc.roo-cline` (lowercased). macOS filesystems are case-insensitive (works) but Linux is case-sensitive — the directory on disk is literally `RooVeterinaryInc.roo-cline` from the VSIX, so our Linux path `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` can silently miss. (`src/adapters/roo-code/detect.ts:16`) Same issue for `kilocode.Kilo-Code`.
6. **MEDIUM — `~/.claude.json` preserves arbitrary existing fields but no validation / migration hook.** Claude Code's `~/.claude.json` is an active file with numStartups, auth, etc. Our code preserves unknown keys on write (good), but on `import()` we don't detect the "per-project nested mcpServers" structure some tools write. Current Claude Code (v2.x) still uses top-level `mcpServers` so we're correct — flagging for future.

### Correctness Score Breakdown

| Adapter | Detect | Import | Export | Schema | Platforms | Score |
|---------|:------:|:------:|:------:|:------:|:---------:|:-----:|
| claude-code | ✅ | ✅ | ✅ | ✅ | ✅ | 9/10 |
| codex-cli | ✅ | ✅ | ✅ | ✅ | ✅ | 9/10 |
| gemini-cli | ✅ | ✅ | ✅ | ✅ | ✅ | 8/10 |
| amazon-q | ✅ | ✅ | ✅ | ✅ | ✅ | 9/10 |
| forgecode | ✅ | ✅ | ✅ | ✅ | ✅ | 8/10 |
| cursor | ✅ | ✅ | ✅ | ✅ | ✅ | 9/10 |
| kiro | ✅ | ✅ | ✅ | ✅ | ✅ | 9/10 |
| windsurf | ✅ | ✅ | ✅ | ✅ | ⚠️ | 7/10 |
| cline | ✅ | ✅ | ✅ | ✅ | ✅ | 8/10 |
| roo-code | ✅ | ✅ | ✅ | ✅ | ⚠️ | 7/10 |
| **kilo-code** | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ | **4/10** |
| copilot | ⚠️ | ✅ | ✅ | ✅ | ❌ | 5/10 |
| **continue** | ❌ | ❌ | ❌ | ❌ | ⚠️ | **2/10** |

---

## Adapter-by-adapter findings

### 1. claude-code

**Files:** `src/adapters/claude-code/{detect,import,export,schema}.ts`

**Stated paths:**
- Global: `~/.claude.json` (detect.ts:17)
- Global settings: `~/.claude/settings.local.json` (detect.ts:37)
- Global skills: `~/.claude/skills/` (detect.ts:43)
- Project: `<project>/.mcp.json`, `<project>/CLAUDE.md`, `<project>/.claude/CLAUDE.md`, `<project>/.claude/settings.local.json`, `<project>/.claude/skills/` (detect.ts:50–75)

**Actual upstream:** https://code.claude.com/docs/en/mcp confirms `~/.claude.json` with top-level `mcpServers` and `.mcp.json` project-scoped file. Matches.

**Schema shape:** Top-level `mcpServers` object keyed by server name → `{ command, args, env, always_allow }`. Our code reads `command/args/env/disabled` and dumps rest into `adapterExtras` (import.ts:80–143). On export we preserve existing non-MCP keys via merging (`...existing, mcpServers` at export.ts:145) — important because `~/.claude.json` contains numStartups, auth, tips history, etc.

**Discrepancies:**
- **LOW:** `disabled` field isn't part of current Claude Code schema (Claude Code doesn't support per-server disable in `~/.claude.json`; it uses `--disable` CLI flag). We read and honor `disabled` which doesn't hurt, but an exported `disabled: true` would be ignored by Claude Code. Flag as informational.
- **LOW:** `always_allow` mapping (export.ts:136) handles both `alwaysAllow` and `always_allow` which is defensive but Claude Code actually reads `alwaysAllow`/`alwaysApprove` depending on version — double-check with a current install.

**Verdict:** 9/10. Very solid. Only concern is the evolving settings layout in `~/.claude/settings.json` (Claude Code v2 introduced `hooks`, `monitors`, `permissions` blocks) — our `claudeCodeGlobalSchema` already covers this.

---

### 2. codex-cli

**Files:** `src/adapters/codex-cli/{detect,import,export}.ts`

**Stated paths:**
- Global: `~/.codex/config.toml` (detect.ts:17, import.ts:65)
- Project: `<project>/.codex/config.toml` (detect.ts:51, import.ts:71)
- Instructions: `~/.codex/AGENTS.md` and `<project>/AGENTS.md` (detect.ts:29, 56)

**Actual upstream:** Confirmed by OpenAI Codex docs (raw.githubusercontent.com/openai/codex). Uses `~/.codex/config.toml` with `[mcp_servers.<name>]` TOML tables.

**Schema shape:** TOML with `mcp_servers` key (snake_case, not `mcpServers`). Our import correctly uses `config.mcp_servers` (import.ts:45) and `stringifyTOML` with `mcp_servers` key on export (export.ts:139). Extensive support for HTTP transport (`url`, `bearer_token_env_var`, `http_headers`), `enabled_tools`/`disabled_tools`, `startup_timeout_sec`, `tool_timeout_sec` — all preserved in `adapterExtras` (import.ts:134–139).

**Discrepancies:**
- **LOW:** Codex has `supports_parallel_tool_calls` per-server flag — preserved via passthrough so fine.
- **LOW:** Codex CLI stores user auth / state in `~/.codex/` as well — we don't touch it (good).

**Verdict:** 9/10. Best-modeled adapter. Correct TOML schema, correct nested-table export, preserves unknown keys.

---

### 3. gemini-cli

**Files:** `src/adapters/gemini-cli/{detect,import,export}.ts`

**Stated paths:**
- Global: `~/.gemini/settings.json` (detect.ts:23, import.ts:41)
- Project: `<project>/.gemini/settings.json` (detect.ts:38, import.ts:47)
- Instructions: `<project>/GEMINI.md` (detect.ts:43, import.ts:126)

**Actual upstream:** Confirmed. Gemini CLI README: "Configure MCP servers in `~/.gemini/settings.json`". Top-level `mcpServers` object.

**Schema shape:** Standard JSON `mcpServers` map → `{ command, args, env, ... }`. We preserve existing fields on export (export.ts:119).

**Discrepancies:**
- **LOW:** Gemini CLI also supports a system-wide settings file (`/etc/gemini/settings.json` or `$GEMINI_CONFIG`) that we don't detect. Rare but real.
- **LOW:** Our `detect` only checks `~/.gemini/` dir existence but doesn't verify `mcpServers` key presence — false positive "installed" if user has an empty `.gemini/` dir. Harmless for import (returns empty list).

**Verdict:** 8/10. Correct. Missing system-wide settings file.

---

### 4. amazon-q

**Files:** `src/adapters/amazon-q/{detect,import,export}.ts`

**Stated paths:**
- Global: `~/.aws/amazonq/mcp.json` (detect.ts:23, import.ts:39)
- Project: `<project>/.amazonq/mcp.json` (detect.ts:33, import.ts:45)
- Rules: `<project>/.amazonq/rules/*.md` (detect.ts:39, import.ts:126)

**Actual upstream:** Confirmed directly against AWS docs (`docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-mcp-configuration.html`): exactly `~/.aws/amazonq/mcp.json` (global) and `.amazonq/mcp.json` (project-level), with project overriding global. Top-level `mcpServers` key.

**Schema shape:** `mcpServers.<name>.{command,args,env}`. Matches.

**Discrepancies:**
- None material.

**Verdict:** 9/10. Exact match to upstream docs.

---

### 5. forgecode

**Files:** `src/adapters/forgecode/{detect,import,export}.ts`

**Stated paths:**
- Project: `<project>/.mcp.json` (detect.ts:46, import.ts:51)
- Project: `<project>/AGENTS.md` (detect.ts:51, import.ts:58)
- Project: `<project>/.forge.toml` (detect.ts:56)
- Global: `~/forge/` (detect.ts:20) and `~/.forge.toml` (detect.ts:26)

**Actual upstream:** Per `forgecode.dev/docs/mcp-integration` — uses `.mcp.json` with `mcpServers` key, same shape as Claude Code. Supports both `command`/`args`/`env` and URL-based (`url` field). Has `disable: true` (NOT `disabled`) for suppressing a server. Our adapter correctly uses `entry.disable !== true` (import.ts:127) ✓

**Schema shape:** Matches Claude Code's `.mcp.json` format.

**Discrepancies:**
- **MEDIUM:** ForgeCode has a user-scope global config path we haven't nailed down — docs say "use `/info` to find the resolved config location." Our hard-coded `~/forge/` and `~/.forge.toml` might not match the actual user-scope `.mcp.json` location (which is the main question). Global MCP servers configured via `forge mcp add --scope user` may live elsewhere.
- **LOW:** `export()` only writes project-scoped `.mcp.json` (no global output), matching the fact that most Forge users configure per-project.

**Verdict:** 8/10. Project-scope is correct. Global-scope is fuzzy — should query `forge --info` at detect time.

---

### 6. cursor

**Files:** `src/adapters/cursor/{detect,import,export}.ts`

**Stated paths:**
- Global: `~/.cursor/mcp.json` (detect.ts:17, import.ts:47)
- Project: `<project>/.cursor/mcp.json` (detect.ts:38, import.ts:53)
- Rules: `<project>/.cursor/rules/*.mdc` (detect.ts:43, import.ts:60)
- Legacy: `<project>/.cursorrules` (detect.ts:48, import.ts:64)
- Agents: `<project>/.cursor/agents/*.md` (detect.ts:53, export.ts:69)

**Actual upstream:** Confirmed via `cursor.com/docs` — `~/.cursor/mcp.json` (global, "tools available everywhere") and `.cursor/mcp.json` (project-specific). Top-level key is `"mcpServers"`. `.mdc` rules under `.cursor/rules/` with YAML frontmatter (`description`, `globs`, `alwaysApply`). All match our implementation.

**Schema shape:** `mcpServers` object with per-server `{ command, args, env, url, headers, disabled }`. Our `CORE_FIELDS` at import.ts:74 correctly captures all five. URL-based (streamable-http) entries handled separately (import.ts:122–128). ✓

**Discrepancies:**
- **LOW:** Cursor-specific `.cursor/agents/` is emitted on export but not imported (only written, never read back). Consider adding to import to round-trip.
- **LOW:** The "Cursor desktop" extensions live at `~/Library/Application Support/Cursor/User/extensions` (see `shared/marketplace-vscode.ts:34`) but that's marketplace scan, not MCP config — no issue.

**Verdict:** 9/10. Correctly models Cursor's native paths.

---

### 7. kiro

**Files:** `src/adapters/kiro/{detect,import,export}.ts`

**Stated paths:**
- Global: `~/.kiro/settings/mcp.json` (detect.ts:23, import.ts:55)
- Project: `<project>/.kiro/settings/mcp.json` (detect.ts:61, import.ts:61)
- Steering (project): `<project>/.kiro/steering/*.md` (detect.ts:66, import.ts:75)
- Steering (global): `~/.kiro/steering/*.md` (detect.ts:29, import.ts:69)
- Agents: `<project>/.kiro/agents/`, `~/.kiro/agents/` (detect.ts:35, 71)
- Skills: `<project>/.kiro/skills/`, `~/.kiro/skills/` (detect.ts:41, 76)

**Actual upstream:** Kiro.dev docs confirm `~/.kiro/settings/mcp.json` and workspace `.kiro/settings/mcp.json`. Steering frontmatter uses `inclusion: always | fileMatch | manual | auto` plus optional `fileMatchPattern`, `name`, `description`. ✓

**Schema shape:** `mcpServers` object with `{ command, args, env, url, headers, oauth, disabled, autoApprove, disabledTools, timeout }`. Kiro is unusual in allowing both stdio (`command`) and streamable-http (`url`) in the same file. Our import correctly branches (import.ts:122–124, 136). ✓

**Discrepancies:**
- **LOW:** We map `inclusion: fileMatch` → scope `glob` (import.ts:183) but Kiro's actual file-pattern field is `fileMatchPattern`, not `globs`. We stash it in `adapterExtras` via passthrough — probably fine on round-trip but export would lose the original field name if not carried explicitly. Our `parseSteeringFrontmatter` only extracts `inclusion` and `description`, not `fileMatchPattern` — so the pattern is silently dropped on import.
- **LOW:** Kiro `auto` inclusion mode requires both `name` and `description` frontmatter per docs; we parse `description` but not `name` (and don't emit `name` on export).

**Verdict:** 9/10. MCP side is perfect; steering frontmatter is slightly lossy on the `fileMatchPattern` and `name` fields.

---

### 8. windsurf

**Files:** `src/adapters/windsurf/{detect,import,export}.ts`

**Stated paths:**
- Global: `~/.codeium/windsurf/mcp_config.json` (detect.ts:23, import.ts:44)
- Global rules: `~/.codeium/windsurf/memories/global_rules.md` (detect.ts:29) — detected but not imported
- Project rules: `<project>/.windsurf/rules/*.md` (detect.ts:40, import.ts:180)
- Project AGENTS.md: `<project>/AGENTS.md` (detect.ts:52, import.ts:55)
- Legacy: `<project>/.windsurfrules` (detect.ts:58, import.ts:61)
- Skills: `<project>/.windsurf/skills/` (detect.ts:46, import.ts:68)

**Actual upstream:** `docs.windsurf.com` confirms `~/.codeium/windsurf/mcp_config.json` with top-level `mcpServers`. `.windsurf/rules/` structure is documented separately (the MCP docs page didn't show rule paths but the adapter code matches community-reported conventions).

**Schema shape:** Standard `mcpServers` object. We map rule frontmatter `trigger: always_on | glob | model_decision | manual` to our scope enum correctly (import.ts:163–175).

**Discrepancies:**
- **MEDIUM:** Global rules file `~/.codeium/windsurf/memories/global_rules.md` is detected (detect.ts:29–32) but NEVER read by `importConfig()` — that's a dead path. Either add it to import or remove from detect.
- **LOW:** Windsurf also supports user-scope MCP via the UI (non-file based) — anything configured that way is invisible to us. Can't fix without calling a Windsurf internal API.

**Verdict:** 7/10. Basic paths correct; global rules detected-but-not-imported is a bug.

---

### 9. cline (VS Code extension)

**Files:** `src/adapters/cline/{detect,import,export}.ts`

**Stated paths (detect.ts:15–27, `getGlobalStoragePath`):**
- macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/`
- Linux: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/`
- Windows: `%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/`
- MCP file: `<globalStorage>/settings/cline_mcp_settings.json`
- Project: `<project>/.clinerules` (file or dir)

**Actual upstream:** Confirmed via Cline GitHub marketplace badge — extension ID is exactly `saoudrizwan.claude-dev`. Per VS Code's globalStorage convention, the paths above are correct.

**Schema shape:** `mcpServers` object with `{ command, args, env, alwaysAllow, disabled }` — matches Cline's internal schema.

**Discrepancies:**
- **HIGH:** No support for **VS Code variants**: Insiders (`Code - Insiders`), VSCodium (`VSCodium`), or when Cline is installed in Cursor (`Cursor` product dir). Users on any variant get "not installed" even though Cline is configured. The globalStorage folder name is hardcoded as `"Code"`.
- **LOW:** `.clinerules` directory format uses `.md` files — we require `.md` extension (import.ts:149), which matches the spec.

**Verdict:** 8/10. Paths correct for stable VS Code; variant handling missing.

---

### 10. roo-code (VS Code extension)

**Files:** `src/adapters/roo-code/{detect,import,export}.ts`

**Stated paths (detect.ts:15–27):**
- macOS: `~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/`
- Linux: `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/`
- Windows: `%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/`
- MCP file: `<globalStorage>/settings/mcp_settings.json`
- Project MCP: `<project>/.roo/mcp.json`
- Project rules: `<project>/.roo/rules/*.md`, `<project>/.roo/rules-<slug>/*.md`
- Legacy: `<project>/.roorules-*`, `<project>/.clinerules-*`

**Actual upstream:** Confirmed Roo Code GitHub + docs.roocode.com. Filename IS `mcp_settings.json` (verified via `globalFileNames.ts`: `"mcp_settings.json"`). Project file IS `.roo/mcp.json`.

**Schema shape:** Matches Cline (both tools share lineage). `mcpServers.<name>.{command, args, env, alwaysAllow, disabled}`.

**Discrepancies:**
- **HIGH — casing:** Upstream marketplace registers as `RooVeterinaryInc.roo-cline` (mixed case). On Linux, the directory created on disk uses the casing VS Code puts there, which may be the registered mixed case. Our lowercased `"rooveterinaryinc.roo-cline"` (detect.ts:16) would miss on a case-sensitive FS. **Test on Linux to confirm.** VS Code's own implementation normalizes to lowercase in many places, so this might be fine — but the safe fix is `existsSync` both cases.
- **HIGH:** Same VS Code variant problem as Cline (no Insiders / VSCodium / Cursor).
- **LOW:** Extension was briefly rumored to be renamed `RooVeterinaryInc.roo-code` — but per the repo's README marketplace badge, `.roo-cline` is still current.

**Verdict:** 7/10. ID matches; casing & variant issues.

---

### 11. kilo-code (VS Code extension + CLI) — **MOST BROKEN**

**Files:** `src/adapters/kilo-code/{detect,import,export}.ts`

**Stated paths (detect.ts:18–119):**
- Global config dir: `~/.config/kilo/`
- Global config: `~/.config/kilo/kilo.jsonc` (or `.json`, `config.json`, `opencode.jsonc`, `opencode.json`)
- Global AGENTS.md: `~/.config/kilo/AGENTS.md`
- Global rules: `~/.kilocode/rules/`
- Global skills: `~/.kilocode/skills/`
- Project config: `<project>/.kilo/kilo.jsonc` OR `<project>/kilo.jsonc`
- Project rules: `<project>/.kilocode/rules/`
- Project skills: `<project>/.kilocode/skills/`

**Actual upstream:** Kilo is **BOTH** a VS Code extension (`kilocode.Kilo-Code`, confirmed via GitHub README) AND a CLI (`@kilocode/cli`). The CLI writes to `kilo.jsonc` (as our adapter assumes). The extension writes MCP servers to VS Code's globalStorage: `~/Library/Application Support/Code/User/globalStorage/kilocode.Kilo-Code/settings/mcp_settings.json` (by analogy to Cline/Roo, since Kilo is a Cline fork).

**Discrepancies:**
- **CRITICAL:** Our adapter completely misses the VS Code extension surface. Any Kilo user who installed the extension (not the CLI) has their MCP servers invisible to us, and `export()` would write a `kilo.jsonc` the extension never reads.
- **CRITICAL:** No `getGlobalStoragePath()` helper and no `"Code/User/globalStorage"` path anywhere in the adapter directory (grep confirmed: zero matches).
- **MEDIUM:** Filename candidate list (detect.ts:27) includes `opencode.jsonc` and `opencode.json` — Kilo forked from OpenCode, but these names are probably legacy and most users have `kilo.jsonc`. Not harmful but confusing.
- **MEDIUM:** New `mcp` key uses `command: string[]` (array) while legacy `mcpServers` uses `command: string, args: string[]`. Adapter handles both (import.ts:254–321) ✓.
- **LOW:** Extension ID casing is `kilocode.Kilo-Code` (mixed case) per marketplace. We'd need to match this exactly when we add the VS Code path.

**Verdict:** 4/10. CLI path is correct and reasonably complete. VS Code extension path is absent — half the users are unsupported.

---

### 12. continue — **SCHEMA IS DEPRECATED**

**Files:** `src/adapters/continue/{detect,import,export}.ts`

**Stated paths (detect.ts:19–38):**
- Global dir: `~/.continue/`
- Global config: `~/.continue/config.json`
- Project config: `<project>/.continue/config.json`

**Actual upstream (docs.continue.dev, verified 2026-04-16):**
- **`config.json` is DEPRECATED.** The docs have a dedicated "config.json Reference (Deprecated)" section.
- **Current canonical format is `config.yaml`** with top-level `name`, `version`, `schema: v1`, and a `mcpServers` array (different shape than `config.json`).
- **Preferred MCP storage:** `.continue/mcpServers/*.yaml` — each server is a separate YAML block file, not a JSON array inside the main config.
- Continue will accept dropped-in JSON MCP files (from Cursor/Claude Desktop/Cline) in `.continue/mcpServers/` as a migration shim, but all new installs write YAML.

**Schema shape (current):**
```yaml
# ~/.continue/config.yaml  OR  <project>/.continue/config.yaml
name: my-assistant
version: 0.0.1
schema: v1
mcpServers:
  - name: My MCP Server
    command: uvx
    args: [mcp-server-sqlite]
```

or

```yaml
# .continue/mcpServers/my-server.yaml
name: My Server
version: 1.0.0
schema: v1
mcpServers:
  - name: my-server
    command: uvx
    args: [...]
```

**Our code:** Reads/writes **only** JSON with `mcpServers` as an array of `{name, command, args, env}`. This was correct for Continue 0.8.x but is now deprecated.

**Discrepancies:**
- **CRITICAL:** Modern Continue installs don't have `~/.continue/config.json`. Our import silently returns 0 servers; our export creates a file Continue reads under "deprecated" mode.
- **CRITICAL:** No YAML support. No `.continue/mcpServers/` directory handling.
- **HIGH:** Rules format also migrated — old JSON `rules` array with `uses:` references is deprecated in favor of `.continue/rules/*.md` (we write to `.continue/rules/<name>.md` on export, which is closer, but the YAML references aren't emitted).

**Verdict:** 2/10. Works for legacy users only. Must be rewritten to emit YAML and read both JSON (legacy) and YAML (current).

---

### 13. copilot (VS Code)

**Files:** `src/adapters/copilot/{detect,import,export}.ts`

**Stated paths:**
- VS Code dir: `~/.vscode/` (detect.ts:18) — just used as a marker
- User MCP (macOS only): `~/Library/Application Support/Code/User/mcp.json` (detect.ts:23)
- Copilot CLI: `~/.copilot/mcp-config.json` (detect.ts:29)
- Project MCP: `<project>/.vscode/mcp.json` (detect.ts:39, import.ts:41)
- Project instructions: `<project>/.github/copilot-instructions.md` (detect.ts:45, import.ts:47)
- Scoped: `<project>/.github/instructions/*.instructions.md` (detect.ts:51, import.ts:54)

**Actual upstream:** Confirmed via `code.visualstudio.com/docs/copilot/chat/mcp-servers`:
- **Key name is `"servers"`, not `"mcpServers"`** — we correctly use this (import.ts:93, export.ts:106). ✓
- **User-level mcp.json lives in the VS Code user profile folder.** The doc deliberately says "Run `MCP: Open User Configuration`" because the path varies by profile and platform.
- Project-level: `.vscode/mcp.json` ✓

**Schema shape:** `{ "servers": { "<name>": { "command"|"url", "args"?, "env"?, "type"? } } }`. ✓

**Discrepancies:**
- **CRITICAL — macOS-only user MCP path:** `detect.ts:23` hardcodes `~/Library/Application Support/Code/User/mcp.json`. On Linux (`~/.config/Code/User/mcp.json`) and Windows (`%APPDATA%/Code/User/mcp.json`), this path will never resolve → installed detection succeeds but user-MCP is invisible. Same file could legitimately exist on Linux / Windows.
- **HIGH — No profile awareness:** VS Code supports multiple user profiles. User MCP file lives in `<profile>/mcp.json` where `<profile>` might be `User/profiles/<profile-id>/` instead of `User/`. We only check the default profile.
- **HIGH — No variant awareness:** Insiders (`Code - Insiders`), VSCodium (`VSCodium`), Cursor (`Cursor`). None handled.
- **LOW — `import()` only reads project `.vscode/mcp.json`, never user-level mcp.json.** Export also only writes `.vscode/mcp.json`. User-level config is detected but not round-tripped.
- **LOW:** `import.ts` imports `extractPackageId` from the `claude-code` adapter (cross-adapter import) — works but creates coupling.

**Verdict:** 5/10. Project-scope works. User-scope is macOS-only and partial.

---

## VS Code Extension Storage Matrix

| Adapter | Upstream extension ID | Expected macOS path | Expected Linux path | Expected Windows path | Our mac path | Our Linux path | Our Win path | Match? |
|---------|----------------------|---------------------|---------------------|----------------------|--------------|----------------|--------------|:------:|
| cline | `saoudrizwan.claude-dev` | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` | ✓ | ✓ | ✓ | **Y** |
| roo-code | `RooVeterinaryInc.roo-cline` (mixed case upstream) | `~/Library/Application Support/Code/User/globalStorage/RooVeterinaryInc.roo-cline/settings/mcp_settings.json` | `~/.config/Code/User/globalStorage/RooVeterinaryInc.roo-cline/settings/mcp_settings.json` | `%APPDATA%\Code\User\globalStorage\RooVeterinaryInc.roo-cline\settings\mcp_settings.json` | `rooveterinaryinc.roo-cline` (lower) | `rooveterinaryinc.roo-cline` (lower) | `rooveterinaryinc.roo-cline` (lower) | **Partial** (mac/win case-insensitive OK; Linux risk) |
| kilo-code | `kilocode.Kilo-Code` | `~/Library/Application Support/Code/User/globalStorage/kilocode.Kilo-Code/settings/mcp_settings.json` | `~/.config/Code/User/globalStorage/kilocode.Kilo-Code/settings/mcp_settings.json` | `%APPDATA%\Code\User\globalStorage\kilocode.Kilo-Code\settings\mcp_settings.json` | — | — | — | **N (absent)** |
| continue | `Continue.continue` | `~/Library/Application Support/Code/User/globalStorage/Continue.continue/` (state/index; config actually at `~/.continue/config.yaml`) | same pattern | same pattern | — (uses `~/.continue/`) | — | — | N/A (config is at home dir, not globalStorage) |
| copilot | `github.copilot` | Config at user-profile `mcp.json` (NOT globalStorage), e.g., `~/Library/Application Support/Code/User/mcp.json` | `~/.config/Code/User/mcp.json` | `%APPDATA%\Code\User\mcp.json` | ✓ (macOS only) | — | — | **N (macOS only)** |

### Variant matrix (VS Code install flavors)

All four VS Code extension adapters (cline, roo-code, kilo-code where applicable, copilot) hardcode `"Code"` as the product directory:

| Variant | Product dir | cline/roo-code handle? | copilot handle? |
|---------|-------------|:----------------------:|:---------------:|
| VS Code stable | `Code` | ✓ | ✓ |
| VS Code Insiders | `Code - Insiders` | ✗ | ✗ |
| VSCodium | `VSCodium` | ✗ | ✗ |
| Cursor (with ext) | `Cursor` | ✗ | ✗ |

A user who prefers Insiders but has Cline installed will see `detect()` return `installed: false`.

---

## Cross-Platform Coverage

| Adapter | macOS | Linux | Windows | Notes |
|---------|:-----:|:-----:|:-------:|-------|
| claude-code | ✅ | ✅ | ✅ | Pure `~/.claude.json` — OS-agnostic |
| codex-cli | ✅ | ✅ | ✅ | `~/.codex/` — OS-agnostic |
| gemini-cli | ✅ | ✅ | ✅ | `~/.gemini/` — OS-agnostic |
| amazon-q | ✅ | ✅ | ✅ | `~/.aws/amazonq/` — OS-agnostic |
| forgecode | ✅ | ✅ | ✅ | `~/forge/`, `~/.forge.toml` — OS-agnostic |
| cursor | ✅ | ✅ | ✅ | `~/.cursor/` — OS-agnostic |
| kiro | ✅ | ✅ | ✅ | `~/.kiro/` — OS-agnostic |
| windsurf | ✅ | ✅ | ✅ | `~/.codeium/windsurf/` — OS-agnostic |
| cline | ✅ | ⚠️ | ⚠️ | `getGlobalStoragePath()` branches on `process.platform`, but no VS Code variant support |
| roo-code | ✅ | ⚠️ | ⚠️ | Same as cline; plus lowercased ID risks Linux mismatch |
| kilo-code | ✅ | ✅ | ✅ | For the CLI surface; VS Code extension surface is unhandled on all OS |
| continue | ✅ | ✅ | ✅ | For the (deprecated) JSON surface only |
| copilot | ⚠️ | ❌ | ❌ | User-level MCP path hardcoded to macOS; Linux/Windows missing |

---

## Recommended fixes (prioritized)

### P0 — CRITICAL (data correctness)

1. **Rewrite `continue` adapter for YAML `config.yaml` + `.continue/mcpServers/*.yaml`.**
   - Add YAML parser dependency (or reuse existing if any; the repo uses `@iarna/toml` but no YAML lib yet).
   - On import: try `config.yaml`, fall back to `config.json` (deprecated). Also enumerate `.continue/mcpServers/*.yaml`.
   - On export: emit `config.yaml` with the `schema: v1` / `name` / `version` envelope. Preserve JSON if the existing file is `config.json` (don't silently migrate).
   - Add `continue/legacy-json.ts` to keep the old shape alive behind a `--format=legacy-json` flag.

2. **Add VS Code extension surface to `kilo-code`.**
   - Extract `shared/vscode-globalStorage.ts` with `getGlobalStoragePath(extensionId, variant?)`.
   - Call it from `kilo-code/detect.ts` alongside the CLI config check. Merge servers from both surfaces (dedupe by name) on import.
   - `export()` needs a flag: `--surface cli` vs `--surface extension`. Default: whichever is detected; if both, require explicit.

3. **Add Linux & Windows branches to `copilot/detect.ts:23`.**
   - Use the same platform-branch pattern as `cline/detect.ts:getGlobalStoragePath`, but without the `globalStorage/<ext>` suffix (user-level `mcp.json` lives directly under `User/`).
   - Add `import()` path for user-level `mcp.json` so it actually round-trips.

### P1 — HIGH (platform coverage)

4. **Introduce `VS_CODE_VARIANTS` list and iterate.** In a new `shared/vscode-paths.ts`:
   ```ts
   const VARIANTS = [
     { name: "Code", env: undefined },
     { name: "Code - Insiders", env: "VSCODE_INSIDERS" },
     { name: "VSCodium", env: "VSCODIUM" },
     { name: "Cursor", env: "CURSOR_EXT_HOST" },
   ];
   ```
   Have `getGlobalStoragePath(extensionId)` return all existing candidates. `detect()` reports the first match; `import()` reads the first non-empty; `export()` defaults to stable but accepts `--variant`.

5. **Fix Roo Code & Kilo Code extension ID casing on Linux.**
   - Try both cases: preferred mixed-case (from marketplace) then lowercase.
   - Or canonicalize via directory listing (`readdirSync` of `globalStorage/` filtered by case-insensitive compare).

### P2 — MEDIUM (completeness)

6. **Hook up Windsurf global rules file** in `windsurf/import.ts`. It's detected but ignored.
7. **Preserve `fileMatchPattern` and `name` in Kiro steering frontmatter** (import + export).
8. **Verify Claude Code `always_allow` vs `alwaysAllow` field name** against a live v2.x install; remove the dual-name mapping if only one is accepted.
9. **Query `forge --info` at ForgeCode detect time** to resolve the actual user-scope config path instead of assuming `~/forge/` / `~/.forge.toml`.

### P3 — LOW (hygiene)

10. **Cross-adapter imports** (`copilot/import.ts:11` imports from `claude-code/identity.ts`) — move `extractPackageId` to `src/adapters/shared/` to remove coupling.
11. **Gemini CLI: also check system-wide `/etc/gemini/settings.json` or `$GEMINI_CONFIG`.**
12. **Remove dead `opencode.jsonc` / `opencode.json` filename candidates** from Kilo detect.ts:27 if Kilo no longer reads them (verify with `@kilocode/cli --help`).

---

## Appendix A — Upstream verification sources

| Adapter | Source | Confirmed |
|---------|--------|:---------:|
| claude-code | https://code.claude.com/docs/en/mcp | `~/.claude.json`, `.mcp.json`, top-level `mcpServers` |
| codex-cli | raw.githubusercontent.com/openai/codex/main/docs/config.md | `~/.codex/config.toml`, `[mcp_servers.*]` TOML tables |
| gemini-cli | github.com/google-gemini/gemini-cli README | `~/.gemini/settings.json`, `mcpServers` key, `GEMINI.md` |
| amazon-q | docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line-mcp-configuration.html | `~/.aws/amazonq/mcp.json`, `.amazonq/mcp.json`, `mcpServers` |
| forgecode | forgecode.dev/docs/mcp-integration | `.mcp.json` with `mcpServers`, `disable` field |
| cursor | cursor.com/docs | `~/.cursor/mcp.json`, `.cursor/mcp.json`, `mcpServers` |
| kiro | kiro.dev/docs/mcp, kiro.dev/docs/steering | `~/.kiro/settings/mcp.json`, `.kiro/steering/*.md`, `inclusion:` frontmatter |
| windsurf | docs.windsurf.com/windsurf/cascade/mcp | `~/.codeium/windsurf/mcp_config.json`, `mcpServers` |
| cline | Cline GitHub README marketplace badge | Extension ID `saoudrizwan.claude-dev` |
| roo-code | github.com/RooCodeInc/Roo-Code, raw globalFileNames.ts | Extension ID `RooVeterinaryInc.roo-cline`, filename `mcp_settings.json` |
| kilo-code | github.com/Kilo-Org/kilocode README, kilo.ai/docs | Extension ID `kilocode.Kilo-Code`, CLI `@kilocode/cli`, `kilo.jsonc` |
| continue | docs.continue.dev/reference, docs.continue.dev/customize/deep-dives/mcp | `config.yaml` (current), `config.json` (deprecated), `.continue/mcpServers/*.yaml` |
| copilot | code.visualstudio.com/docs/copilot/chat/mcp-servers | `.vscode/mcp.json` project, user profile `mcp.json`, `servers` key |

---

## Appendix B — Code references for quick navigation

| Concern | File | Line |
|---------|------|:----:|
| Cline globalStorage path logic | `src/adapters/cline/detect.ts` | 15–27 |
| Roo Code globalStorage path logic | `src/adapters/roo-code/detect.ts` | 15–27 |
| Copilot user MCP path (macOS-only!) | `src/adapters/copilot/detect.ts` | 23 |
| Kilo Code missing VS Code path | `src/adapters/kilo-code/detect.ts` | entire file |
| Continue deprecated `config.json` read | `src/adapters/continue/import.ts` | 51, 57 |
| Continue deprecated `config.json` write | `src/adapters/continue/export.ts` | 28 |
| Windsurf global rules detected-but-unused | `src/adapters/windsurf/detect.ts:29`, never referenced in `import.ts` | — |
| Copilot cross-adapter import | `src/adapters/copilot/import.ts` | 11 |
| VS Code marketplace product dirs | `src/adapters/shared/marketplace-vscode.ts` | 30–42 |
| Kiro steering frontmatter parser | `src/adapters/kiro/import.ts` | 155–200 |
| Forgecode `.mcp.json` with `disable` field | `src/adapters/forgecode/import.ts` | 73, 127 |
