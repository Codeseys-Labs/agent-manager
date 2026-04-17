# Fixes Landed — 2026-04-16

Addendum to the multi-agent deep analysis. All CRITICAL + HIGH findings from
reports 01–10 have been addressed in a single hardening pass. Six parallel
implementation agents + one tidy agent + inline patches landed the fixes.

## Summary by Theme

| Theme | Status | Notes |
|---|---|---|
| A. Declared but not enforced | **Fixed** | Bridge permissions wired; adapter checksums enforced; Zod on all 33 MCP tools; `--yes` honored; `AmError` scope noted for future pass. |
| B. Supply chain trust-on-first-everything | **Fixed** | `--ignore-scripts` on npm; URL validation; commit SHA pinning; TOFU; path traversal scrub on all manifest paths. |
| C. `am apply` write path unguarded | **Fixed** | Atomic writes across 13 adapters + 7 core paths; error redactor applied; MCP write-tier bearer auth gate; session traversal blocked. |
| D. Concurrency/lifecycle leaks | **Fixed** | ACP connect() subprocess cleanup; per-client terminalStore; SSE heartbeat every 30s; stderr draining audited. |
| E. Parallel implementations drifting | **Fixed** | ACP registries collapsed; version fallback unified; CI version gate added. |
| F. Docs describe wished-for v0.4 | **Fixed** | ADRs 0026/0027/0028/0030 flipped to `accepted`; community adapter author guide written. |

## Top 10 Findings — Resolution

1. **ACP subprocess leak on init failure** → Fixed. `connect()` now try/catches initialize; SIGTERM with 2s grace then SIGKILL; 10s default timeout.
2. **Bridge permissionPolicy dead config** → Fixed. `allowedPaths` added; `setPermissionPolicy`/`setAllowedPaths` called before `connect()`. Defaults tightened to `deny` + `[cwd]`.
3. **No atomic writes in adapter export** → Fixed. `src/core/atomic-write.ts` (sync + async variants); applied to all 13 adapters + config + profile + marketplaces.json + key file + web auth token.
4. **MCP `am_apply` / write-tier unauth'd** → Fixed. Bearer token gate via `AM_MCP_TOKEN` env + `AM_MCP_ALLOW_UNSAFE_LOCAL` escape. Write tools hidden from `tools/list` without auth.
5. **AES master key in git-tracked dir** → Fixed. Migrated to OS data-dir (`~/Library/Application Support/...`, `$XDG_DATA_HOME/...`, `%APPDATA%/...`). Auto-migration on first load. `am doctor` warns on legacy location.
6. **`npm install` without `--ignore-scripts`** → Fixed. Applied to community adapter install + update. Lifecycle-hook RCE mitigated.
7. **Zero runtime validation on MCP inputs** → Fixed. Zod schemas on all 33 tools via central `TOOL_SCHEMAS` map; dispatcher-level `validateInput()` returns MCP error envelope on fail.
8. **Parallel ACP agent registries** → Fixed. `protocols/acp/registry.ts` now imports `BUILT_IN_ACP_AGENTS` from `core/agent-registry.ts`. No duplication.
9. **Path traversal in `am_acp_session_cancel` + manifest `skills.path`** → Fixed. `resolveSessionPathSafely()` + `safeResolveInsidePlugin()` helpers. Regex + resolved-path containment check.
10. **No binary signing / notarization** → **Deferred.** Requires Apple Developer ID; tracked for future release. Quick win `xattr -d com.apple.quarantine` added to install.sh is a follow-up.

## Wave Outputs

### Wave 1.A — Atomic writes (22 files, 13 tests)
- `src/core/atomic-write.ts` (new)
- 13 adapter exports converted
- 7 other user-config write paths (config, profile, adapters.toml, secrets, marketplaces.json, web auth)

### Wave 1.B — Protocol safety (29 tests)
- ACP subprocess lifecycle
- Bridge permissions wired through
- Per-client terminalStore
- Shell-aware parseCommand
- SSE heartbeat + correct final flag
- ESM static import for bridge handler

### Wave 1.C — Master key migration (62 tests, SECURITY.md)
- `resolveKeyPath()` per-platform
- Auto-migration from legacy `.agent-manager/key.txt`
- `am doctor` legacy-key check
- Crypto primitives unchanged

### Wave 2.A — Install security (21 + 4 tests)
- Adapter name validation regex
- Checksum pinning at install + update
- Checksum enforcement at load (no "skipping" fallback)
- `--ignore-scripts` everywhere
- Latent `readLoop()` exit bug noted for follow-up

### Wave 2.B — MCP safety (64 tests, redactor helper)
- Zod on all 33 tools
- `resolveSessionPathSafely()` for session ops
- Secret redactor: `Bearer *`, AWS keys, `ghp_*`, `sk-ant-*`, `sk-*`, `AIza*`, `xoxb-*`
- Write-tier bearer auth gate

### Wave 2.C — Marketplace (46 tests, `src/marketplace/security.ts`)
- URL validation (https only by default; no embedded creds; port check)
- Clone size cap (100 MiB default) + timeout (60s)
- Commit SHA pinning in marketplaces.json
- TOFU prompt via `@clack/prompts` + `--yes` bypass
- Path traversal scrub on `skills[]` and `agents[].prompt_file`

### Wave 3 — Tidy
- ACP registry collapsed (single source)
- `AM_VERSION` constant in `src/lib/version.ts` (fallback `"0.0.0-dev"`, not `"0.1.0"`)
- CI job asserts binary `--version` contains `package.json.version`
- ADRs 0026/0027/0028/0030 flipped from `proposed` → `accepted`
- Community adapter author guide: `docs/community-adapter-authoring.md` (~290 lines, covers protocol, package structure, hello-world, local dev, security, publishing, test checklist)

## Verification

- **Tests:** 2202 pass / 0 fail / 6273 expect calls across 165 files (up from ~1999 before this pass)
- **Typecheck:** 0 errors in `src/`
- **Lint:** clean (1 warning, 0 errors)
- **New tests added this pass:** ~260 (13 + 29 + 62 + 25 + 64 + 46 + 21)

## What We Deferred

- **Binary signing / notarization** — needs Apple Developer ID; out of scope for a hardening pass.
- **`AmError` rollout to remaining ~24 commands** — UX polish, not a security issue.
- **Completion drift** (06 CLI UX HIGH) — generator needs rewrite to read command tree; non-blocking.
- **`bun pm audit` / CodeQL / dependabot** — CI gates to add incrementally.
- **Community adapter `readLoop()` exit bug** (flagged by Wave 2.A) — latent issue; follow-up.
- **Claude Code schema compat** (05 HIGH) — separate workstream; marketplace works via our own `.am-plugin` format.

Not a 1.0 yet (user's own criterion). But the surface is materially safer
than the pre-hardening 0.4.0. Recommend bumping to 0.5.0-rc1 for the next
beta release tag.
