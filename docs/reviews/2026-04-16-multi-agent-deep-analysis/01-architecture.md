# Architecture Coherence Review — agent-manager (2026-04-16)

Facet: layer boundaries, dependency direction, abstraction leaks, circular
deps, module cohesion.

Scope: `src/` at version 0.4.0. ADRs 0001–0030 read for stated intent.
This report is descriptive, not prescriptive fixes — flags only.

## Summary

agent-manager exhibits a mature, mostly clean three-layer architecture
(`commands -> core + adapters`) that stays faithful to ADR-0001
(Layered Core + Adapter Extensions). All 13 built-in adapters implement the
same `Adapter` interface uniformly (`src/adapters/types.ts:209-218`), adapter
registration is lazily loaded through a single factory in
`src/adapters/registry.ts`, and no adapter imports from `commands/`, `mcp/`,
`web/`, `tui/`, `protocols/`, `marketplace/`, or `registry/`. The core does
not reach into any specific adapter (only `adapters/types.ts` for shared
types), and the dependency graph is acyclic at the top level. Dynamic
`await import(...)` is used deliberately as a startup-perf optimisation for
`cli.ts` sub-commands and as a circular-import guard in a few specific
call sites; the pattern is applied consistently.

The main coherence gaps are: (1) a hard **layering violation** — `core/merge.ts`
imports `extractServerIdentity` from `commands/import.ts`, and four modules
(`mcp/server.ts`, `web/server.ts`, `tui/index.tsx`, `tui/data.ts`) reach
back into `commands/use.ts` for `readActiveProfile`/`writeActiveProfile`
— both of which are core-shaped primitives mis-located in the command layer;
(2) **two parallel agent registries** (`core/agent-registry.ts` with
`BUILT_IN_ACP_AGENTS` and `protocols/acp/registry.ts` with `BUILT_IN_REGISTRY`)
with the same 16 entries duplicated verbatim; (3) **kitchen-sink files**
— `mcp/server.ts` at 1911 lines contains all 33 tool definitions inline,
`commands/wiki.ts` at 981 lines nests 15 subcommands, `wiki/storage.ts` at
770 lines combines three concerns (pages, knowledge entries, search index);
(4) **repeated `homeDir ?? homedir()` resolution** in every adapter module
(~40 sites) instead of injecting a home-directory service. No circular imports
were found at runtime. No CRITICAL issues. Overall: strong bones, a few
fixable cross-cutting tangles.

## Strengths

- **Uniform Adapter contract.** All 13 adapter `index.ts` files (e.g.
  `src/adapters/claude-code/index.ts:32-63`, `src/adapters/continue/index.ts`,
  `src/adapters/gemini-cli/index.ts`) match the same pattern: `meta`,
  `detect()`, `import()`, `export()`, `diff()`, `schema`, optional
  `sessionReader`, optional `scanMarketplace`. Optional capabilities are
  truly optional per `Adapter` (`src/adapters/types.ts:209-218`).
- **One-way dependency from core to adapters is *types-only*.**
  `src/core/config.ts:6-12`, `src/core/instructions.ts:10`,
  `src/core/merge.ts:8` all use `import type` from `../adapters/types`.
  Core never imports an adapter *implementation*.
- **Lazy adapter loading.** `src/adapters/registry.ts:21-74` uses per-adapter
  async factories with a `Map<string, Adapter>` cache. Startup cost scales
  with *used* adapters, not *installed*.
- **CLI is a thin dispatcher.** `src/cli.ts` (60 lines) does nothing but
  route sub-command names to `() => import(...)` modules. No business logic,
  no fs, no config parsing at the top level.
- **Acyclic top-level deps.** A grep for `../commands` from `core/` and
  `adapters/` returns only one hit (see below). No adapter imports another
  adapter *except* for `identity.ts` re-exporting from `claude-code/identity.ts`
  (intentional shared helper, see MEDIUM-2).
- **Protocols isolated.** `src/protocols/{a2a,acp,bridge.ts}` only
  back-depends on `../adapters/types` (types-only) and `../core/agent-registry`;
  no web/tui/mcp/cli imports leak in.
- **Deliberate lazy imports at known fan-in points.** `mcp/server.ts`,
  `web/server.ts`, `core/instructions.ts` use `await import(...)` to avoid
  pulling heavy subsystems (wiki, A2A, secrets, registry) into the CLI
  cold path. Documented in `src/commands/flow.ts:68` ("Lazy import runFlow
  to avoid loading ACP deps at CLI parse time") and
  `src/core/instructions.ts:155` ("Dynamically import wiki modules to avoid
  circular dependencies").
- **TypeScript-enforced boundaries.** All layer-crossing imports are
  `import type` when possible. `src/adapters/types.ts:2`
  (`SessionReader` from core) is types-only.
- **Platforms pattern is clean.** `src/platforms/registry.ts` applies the
  same adapter-registry pattern to git hosts (github/gitlab/bare) with a
  specificity-ordered list — easy to extend.
- **ADR-0030 unified registry is the *right* architectural target** for
  agents (config + acp-builtin + a2a-roster). It just needs to finish
  displacing the pre-ADR version (see HIGH-1).

## Gaps & Issues

### CRITICAL

None found. No circular imports, no adapter-specific code in core, no
cross-layer type sharing that would make the build unstable.

### HIGH

#### HIGH-1 — Parallel agent registry implementations

- **Severity:** HIGH
- **Location:** `src/core/agent-registry.ts:42-59` vs
  `src/protocols/acp/registry.ts:16-33`
- **Explanation:** Two files hold the same dictionary of 16 built-in
  ACP-compatible agents under different names. `core/agent-registry.ts`
  exports `BUILT_IN_ACP_AGENTS` (ADR-0030, "unified" view merging
  config + acp-builtin + a2a-roster) and `protocols/acp/registry.ts` exports
  `BUILT_IN_REGISTRY` (ADR-0026, ACP-only). Both are hard-coded with
  identical entries (`claude`, `codex`, `gemini`, `cursor`, `copilot`,
  `kiro`, `aider`, `amazon-q`, `amp`, `augment`, `cline`, `roo-code`,
  `goose`, `windsurf`, `devin`, `sourcegraph`). Both expose
  `resolveAgent()` and `listAgents()` with overlapping but non-identical
  semantics. Callers pick one or the other: `src/protocols/acp/client.ts:43`
  uses the protocol-local one; `src/protocols/bridge.ts:17` uses the core
  unified one; `src/commands/run.ts:349`, `src/commands/agents.ts:16` and
  `src/mcp/server.ts:1552` each pick differently.
- **Consequence:** Adding a new ACP agent requires editing two dictionaries.
  Drift is inevitable. The "unified" registry is not actually unified.
- **Suggested fix:** Delete `protocols/acp/registry.ts`'s `BUILT_IN_REGISTRY`
  and have `resolveAgent`/`listAgents` in that file delegate to
  `core/agent-registry.ts`. Keep `parseCommand` (it's an ACP-protocol
  concern). Migrate `protocols/acp/client.ts:43` to call the unified path.

#### HIGH-2 — Layering violation: `core/merge.ts` depends on `commands/import.ts`

- **Severity:** HIGH
- **Location:** `src/core/merge.ts:9`
  (`import { extractServerIdentity } from "../commands/import"`)
- **Explanation:** `core/` must not depend on `commands/` — commands are the
  CLI-shaped orchestration layer that *uses* core. `extractServerIdentity`
  is defined at `src/commands/import.ts:27-65` as a pure function
  (no citty, no fs, no I/O) for canonical package-identity derivation.
  It is then consumed by `core/merge.ts:86,97` (a pure function module
  that implements ADR-0028 brownfield-import merge). Two of the five
  largest command files use it, and core's merge engine re-imports it
  back *up* the stack.
- **Consequence:** Any cycle-detector tightening will flag this.
  `core/merge.ts` carries a transitive dependency on citty,
  `lib/errors`, `lib/output`, `core/git`, `core/secret-detection`,
  `core/secrets` through `commands/import.ts`'s top-of-file imports,
  which inflates the core import surface unnecessarily.
- **Suggested fix:** Move `extractServerIdentity` to
  `src/core/server-identity.ts` (it is pure and belongs to the canonical
  identity concern already sibling to `core/merge.ts`'s `commandBasename`
  helper on lines 56-68). Re-export from `commands/import.ts` for
  backwards compat if external tests consume it.

#### HIGH-3 — Layering violation: `readActiveProfile` / `writeActiveProfile` live in `commands/use.ts`

- **Severity:** HIGH
- **Location:** `src/commands/use.ts:17-42` (declaration); imported by:
  - `src/mcp/server.ts:13`
  - `src/web/server.ts:6`
  - `src/tui/index.tsx:5`
  - `src/tui/data.ts:2`
- **Explanation:** These two functions read/write
  `<configDir>/.agent-manager/state.toml` to persist the active profile.
  That is *state management* — a core concern. Four non-command consumers
  (MCP server, web server, TUI, TUI data layer) import them back across
  the `commands/` boundary. The `StateConfig` interface at
  `commands/use.ts:12-15` is also a core-shaped data type. The use-command
  itself is only a thin CLI shell around these primitives
  (`commands/use.ts:44-` onward).
- **Consequence:** Four layer violations. Every presentation surface
  pulls in citty + error output helpers transitively just to read one
  TOML key. Future state fields (last_apply, pinned_versions, etc.)
  will amplify the leak.
- **Suggested fix:** Move `StateConfig`, `readActiveProfile`, and
  `writeActiveProfile` to `src/core/state.ts`. The `useCommand` citty
  wrapper stays in `commands/use.ts` and delegates.

#### HIGH-4 — `src/mcp/server.ts` is a 1911-line kitchen sink

- **Severity:** HIGH
- **Location:** `src/mcp/server.ts:1-1911`
- **Explanation:** A single file contains JSON-RPC types, tool-group map
  (73-99), permission checks (106-129), secret redaction (133-140),
  config loader (144-155), `defineTools()` (159-1698 — 1540 lines!) with
  all 33 tool handlers inline, and the `McpServer` class (1702-end).
  Individual handlers are 20-80 lines each and reach into nearly every
  subsystem: `../adapters/registry`, `../core/config`, `../core/git`,
  `../core/secrets`, `../core/session`, `../commands/use`, plus 18 lazy
  `await import(...)` calls for wiki/A2A/ACP/registry integration
  (lines 403, 945, 977, 1201, 1220, 1251, 1252, 1294, 1295, 1334, 1371,
  1432, 1455, 1456, 1498, 1499, 1551, 1552, 1604, 1628, 1629, 1680, 1681).
- **Consequence:** Tool audits, permission policy changes, and new-tool
  additions must all touch the same file. Tests for individual tools are
  hard to scope. Tool-group mapping (lines 73-99) and `defineTools()`
  list can drift.
- **Suggested fix:** Split by tool group (the map at `server.ts:73-99`
  already names the groups: core, registry, a2a, wiki, session, acp).
  One file per group exporting `ToolEntry[]`, assembled by `defineTools()`
  in `mcp/server.ts` (~200 lines).

#### HIGH-5 — `src/commands/wiki.ts` at 981 lines is the largest command file

- **Severity:** HIGH
- **Location:** `src/commands/wiki.ts:1-981` with single export at line 964
- **Explanation:** Defines 15 subcommands (search, add, show, delete,
  ingest, synthesize, briefing, export, import, lint, graph, rebuild, etc.)
  inline. Contrast with `src/commands/adapter.ts` (485 lines, 5
  subcommands — within tolerance) and `src/commands/run.ts` (419 lines,
  4 subcommands — tolerable). `commands/wiki.ts` pulls 20+ symbols from
  `../wiki/storage`, graph, harvester, synthesizer, types.
- **Consequence:** Same cohesion/test-scoping problem as HIGH-4.
- **Suggested fix:** One file per subcommand under
  `src/commands/wiki/{search,add,show,...}.ts`, aggregated by
  `src/commands/wiki/index.ts`.

### MEDIUM

#### MEDIUM-1 — `wiki/storage.ts` mixes three concerns in 770 lines

- **Severity:** MEDIUM
- **Location:** `src/wiki/storage.ts:48-767` (26 exports)
- **Explanation:** Three distinct concerns share the file:
  1. Wiki-dir path resolution (`resolveWikiDir`, `getWikiDir`,
     `resolveProjectName`, `getProjectWikiDir`, `createProjectWikiLink`,
     `ensureWikiGitignore`, `ensureWikiDirs`, lines 48-173).
  2. Markdown page CRUD and frontmatter parsing (`parseFrontmatter`,
     `serializeFrontmatter`, `writePage`, `readPage`, `deletePage`,
     `listPages`, `searchPages`, plus MiniSearch index persistence,
     lines 175-616).
  3. KnowledgeEntry (typed records) CRUD (`addEntry`, `getEntry`,
     `updateEntry`, `deleteEntry`, `queryEntries`, `searchEntries`,
     `rebuildIndex`, `getAllEntries`, lines 619-770).
- **Suggested fix:** Split into `wiki/paths.ts`, `wiki/pages.ts`,
  `wiki/entries.ts`, each ~200-300 lines.

#### MEDIUM-2 — Cross-adapter imports of `claude-code/identity.ts`

- **Severity:** MEDIUM
- **Location:** 6 adapters re-import / re-export `extractPackageId` from
  `../claude-code/identity.ts`:
  - `src/adapters/amazon-q/identity.ts:8` (re-export)
  - `src/adapters/copilot/import.ts:11`
  - `src/adapters/cursor/import.ts:11`
  - `src/adapters/forgecode/import.ts:13`
  - `src/adapters/windsurf/identity.ts:8` (re-export)
  - `src/adapters/continue/identity.ts:8` (re-export)
- **Explanation:** `claude-code` is treated as a de-facto shared-helper
  adapter. The helper itself is generic (package-identity extraction)
  and has nothing specific to Claude Code. `src/adapters/shared/` already
  exists (`marketplace-vscode.ts`) — the right home for cross-adapter
  helpers.
- **Consequence:** Deleting or restructuring the claude-code adapter
  would break 6 other adapters. Every new adapter is pressured to also
  depend on claude-code.
- **Suggested fix:** Move `extractPackageId` to
  `src/adapters/shared/identity.ts` and re-export from claude-code for
  backwards compat. (Note: `commands/import.ts:27` *also* exports a
  similar function `extractServerIdentity` — audit whether these are
  duplicates; see HIGH-2 suggestion re: `core/server-identity.ts`.)

#### MEDIUM-3 — `homeDir ?? homedir()` pattern duplicated in ~40 adapter files

- **Severity:** MEDIUM
- **Location:** Every adapter's `detect.ts`, `diff.ts`, `export.ts`,
  `import.ts`, `session.ts` repeats the pattern. Representative sample
  (13 adapters x ~4 files):
  - `src/adapters/claude-code/detect.ts:2,13`
  - `src/adapters/claude-code/diff.ts:9,32`
  - `src/adapters/claude-code/export.ts:8,30`
  - `src/adapters/claude-code/import.ts:8,36`
  - `src/adapters/claude-code/session.ts:12,64,70`
  - `src/adapters/claude-code/marketplace.ts:6,29`
  - `src/adapters/codex-cli/detect.ts:2,13` (same pattern 4x)
  - … same pattern in cline, cursor, kilo-code, amazon-q, copilot,
    roo-code, forgecode, gemini-cli, kiro, windsurf, continue
- **Explanation:** Every function signature accepts an optional `homeDir`
  for test override, then falls back to `os.homedir()`. There is no
  shared helper; each file imports `node:os` and does the `??` dance.
  This also means adapters have a latent dependency on the process
  environment (implicit cwd/home) that is not reflected in the
  `Adapter` interface (`types.ts:209-218`).
- **Consequence:** 40+ sites to change if home-directory resolution
  policy ever changes (e.g., honoring `AM_HOME_DIR`, sandbox fixtures).
  Testing an adapter requires threading `homeDir` through 3-4 function
  signatures.
- **Suggested fix:** Add `resolveHome(override?: string): string` to
  `src/lib/env.ts` (new) or `src/adapters/shared/paths.ts` and have
  adapters call it. Even better: add `cwd` and `home` fields to
  `DetectResult`/`ExportOptions` so they are part of the Adapter contract.

#### MEDIUM-4 — TOML parsing duplicated in `web/worker.ts`

- **Severity:** MEDIUM
- **Location:** `src/web/worker.ts:428-430` and `src/web/worker.ts:461-462`
- **Explanation:** The web worker (Cloudflare Worker target) imports
  `@iarna/toml` directly and parses config.toml files fetched via HTTP
  — effectively a parallel path to `src/core/config.ts:readConfig` /
  `buildResolvedConfig`. The worker can't use core/config.ts because
  that file uses `node:fs`. But the *parsing* logic could be extracted.
- **Consequence:** Schema drift between worker and CLI. ServerSchema
  validation (`src/core/schema.ts`) is skipped in the worker path.
- **Suggested fix:** Extract a pure-function `parseConfigString(raw):
  Config` (Zod-validated) to `src/core/config-parse.ts` with no `node:fs`
  imports, and reuse in both the CLI and worker paths.

#### MEDIUM-5 — Marketplace concept overloaded

- **Severity:** MEDIUM
- **Location:** `src/marketplace/*.ts` vs `Adapter.scanMarketplace?()` in
  `src/adapters/types.ts:217`, implemented by
  `src/adapters/claude-code/marketplace.ts`,
  `src/adapters/shared/marketplace-vscode.ts`, etc.
- **Explanation:** The term "marketplace" is used for two distinct
  concepts:
  1. Git-cloned *plugin marketplaces* (Claude Code-compatible git repos
     cloned to `~/.config/agent-manager/marketplaces/<name>/`) managed
     by `src/marketplace/client.ts:66` `addMarketplace(url)`.
  2. Per-tool *installed-plugin scanners* that read e.g.
     `~/.claude/settings.json` `enabledPlugins` and return
     `MarketplaceResult` (`src/adapters/claude-code/marketplace.ts:28`
     `scanClaudePlugins`).
- **Consequence:** Readers conflate the two. `MarketplaceItem`,
  `MarketplaceResult`, `MarketplaceSource` in `adapters/types.ts:178-205`
  belong to concept (2) while the types in `src/marketplace/types.ts`
  belong to concept (1). They do not interoperate despite shared naming.
- **Suggested fix:** Rename one. Concept (2) is really "installed-plugin
  inventory" — consider `InstalledPluginResult` or `BundledInventory`.
  Keep "marketplace" for the git-cloned registries.

#### MEDIUM-6 — `protocols/a2a/server.ts` (735 lines) combines transport, task store, and SSE

- **Severity:** MEDIUM
- **Location:** `src/protocols/a2a/server.ts:1-735`
- **Explanation:** File contains the task store (`TaskStore` interface,
  in-memory impl, TTL eviction), the Hono routes (`/a2a`,
  `/.well-known/agent.json`), SSE streaming, idle-timeout logic,
  agent-card generation glue, and auth. `MAX_HISTORY_PER_TASK`,
  `SSE_IDLE_TIMEOUT_MS`, `TASK_TTL_MS` are all inline constants
  (lines 38-42).
- **Suggested fix:** Split `task-store.ts`, `routes.ts`, `sse.ts`.
  `server.ts` becomes the Hono-wiring shell.

#### MEDIUM-7 — `core/config.ts` uses `require("node:fs").accessSync` instead of `existsSync`

- **Severity:** MEDIUM (style)
- **Location:** `src/core/config.ts:32`
- **Explanation:** `require()` mid-function inside `resolveProjectConfig`
  instead of using `import { existsSync } from "node:fs"`. Works, but
  defeats static analysis and bundlers.
- **Suggested fix:** Hoist the import.

### LOW

#### LOW-1 — `commands/adapter.ts` spawns install commands with `Bun.spawn`

- **Severity:** LOW
- **Location:** `src/commands/adapter.ts:142,154`
- **Explanation:** The `adapter install` subcommand spawns `npm install`
  / `bun install` in the adapter directory. That is correct behavior but
  is implemented inline; compare with `src/platforms/{github,gitlab}.ts`
  which have a small `runCommand` helper. Minor duplication.
- **Suggested fix:** Promote `runCommand` to `src/lib/spawn.ts` and reuse.

#### LOW-2 — `core/config.ts:29-39` walks the filesystem synchronously

- **Severity:** LOW
- **Location:** `src/core/config.ts:27-40` `resolveProjectConfig`
- **Explanation:** Synchronous `accessSync` walk from `startDir` to
  filesystem root. Fine for CLI but noticeable for the MCP server
  which calls `loadConfigAndProfile()` per tool invocation
  (`mcp/server.ts:150`).
- **Suggested fix:** Cache the resolved project-file path per-process
  once stable, or memoise by `startDir`.

#### LOW-3 — Web server re-imports core modules lazily inside route handlers

- **Severity:** LOW
- **Location:** `src/web/server.ts:190`, `299`, `554`, `580`, `601`,
  `621`, `639`, `640`, `648-650`, `660`
- **Explanation:** Ten `await import(...)` calls inside Hono route
  handlers. Matches the CLI startup-perf philosophy but defers failure
  surface: a malformed wiki module only breaks when `/api/wiki/search`
  is hit. For a long-running server, these should be top-level imports
  so startup validates them.
- **Suggested fix:** Hoist to top of file. Startup may slow by
  milliseconds; reliability gain is worth it.

#### LOW-4 — `scanMarketplace` is sync, others async

- **Severity:** LOW (contract consistency)
- **Location:** `src/adapters/types.ts:217`
  `scanMarketplace?(): MarketplaceResult` (no `Promise`)
- **Explanation:** All other `Adapter` methods are `T | Promise<T>`.
  `scanMarketplace` is sync-only. Some concrete implementations
  (`scanClaudePlugins` at `claude-code/marketplace.ts:28`) use
  `require("node:fs")` inside to do sync reads. Makes future async
  (e.g., fetching plugin metadata from a URL) impossible without
  contract change.
- **Suggested fix:** Widen to `MarketplaceResult | Promise<MarketplaceResult>`.

#### LOW-5 — `Capability` enum string-typed, not validated against adapter `capabilities` array

- **Severity:** LOW
- **Location:** `src/adapters/types.ts:6-16` and each
  `adapters/*/index.ts` `CAPABILITIES` array
- **Explanation:** Nothing prevents an adapter from claiming
  `"marketplace"` capability but not implementing `scanMarketplace`.
  Type system only enforces string-literal membership.
- **Suggested fix:** Add an `assertAdapter(adapter)` helper used in
  `registry.ts` cache-on-load to verify declared capabilities map to
  defined methods.

#### LOW-6 — `core/betterleaks.ts` has runtime `spawnSync` sitting in `core/`

- **Severity:** LOW
- **Location:** `src/core/betterleaks.ts:1,26,40,55,122,159,192`
- **Explanation:** `core/` is almost entirely pure except for this one
  file that shells out to `betterleaks` binary. Defensible (secret
  detection integrates an external tool), but the name puts it in core
  when it is really a third-party integration. Compare:
  `core/secrets.ts`, `core/secret-detection.ts` are pure; the external
  tool wrapper sits next to them.
- **Suggested fix:** Move to `src/integrations/betterleaks.ts`, keep
  `core/secret-detection.ts` pure. `commands/doctor.ts:201` already
  dynamically imports it, so the move is safe.

#### LOW-7 — `instructions.ts` lazy-imports wiki modules inside a try/catch

- **Severity:** LOW
- **Location:** `src/core/instructions.ts:155-175`
- **Explanation:** Comment says "Dynamically import wiki modules to
  avoid circular dependencies". Verified: `wiki/` does not import from
  `core/instructions.ts`, so the circular-import justification is not
  true today. The real reason is probably "wiki is optional and may
  error; swallow errors". That's fine but the comment misleads readers.
- **Suggested fix:** Replace the comment with "Wiki modules are
  optional — swallow errors when wiki dir/entries are absent." If
  there is in fact a latent cycle, make it explicit.

#### LOW-8 — `protocols/acp/flows.ts` at 587 lines

- **Severity:** LOW
- **Location:** `src/protocols/acp/flows.ts`
- **Explanation:** Second-largest protocol file after
  `a2a/server.ts`. Mixes flow-run state, persistence, orchestration.
  Not yet problematic, but trending toward kitchen sink.

#### LOW-9 — `TOOL_GROUP_MAP` and `ToolEntry.tier` are duplicated per-tool metadata

- **Severity:** LOW
- **Location:** `src/mcp/server.ts:73-99` (group map) and per-tool
  `tier: "read-only"` fields in the `defineTools()` array
- **Explanation:** Each tool has its group (sparse map lookup) and tier
  (inline). Adding a tool requires both. Easy to forget the map entry
  — then the tool defaults silently to "core" group.
- **Suggested fix:** Store `group` directly on `ToolEntry` alongside
  `tier`, delete the sparse map. Co-located metadata is harder to drift.

## Recommendations (prioritized)

1. **Relocate layer-misplaced primitives** (HIGH-2, HIGH-3). Single
   commit each:
   - `extractServerIdentity` -> `src/core/server-identity.ts`
     (check for duplication with `adapters/*/identity.ts` extractPackageId
     while there; MEDIUM-2).
   - `readActiveProfile` / `writeActiveProfile` / `StateConfig` ->
     `src/core/state.ts`.
   Re-export from the old locations for one release, then delete.
2. **Unify the agent registries** (HIGH-1). Keep
   `core/agent-registry.ts` as the single source; make
   `protocols/acp/registry.ts` a thin `resolveAgent` adapter that
   filters the unified registry for ACP-capable entries.
3. **Split `mcp/server.ts`** (HIGH-4) by ADR-0021 tool groups:
   `src/mcp/tools/{core,registry,a2a,wiki,session,acp}.ts`. Keep
   `mcp/server.ts` for JSON-RPC wiring and the `McpServer` class.
4. **Split `commands/wiki.ts`** (HIGH-5) one-file-per-subcommand.
5. **Split `wiki/storage.ts`** (MEDIUM-1) into `paths.ts`, `pages.ts`,
   `entries.ts`; split `protocols/a2a/server.ts` (MEDIUM-6) into
   `task-store.ts`, `routes.ts`, `sse.ts`.
6. **Introduce `src/lib/env.ts` with `resolveHome()`** (MEDIUM-3) and
   migrate adapters incrementally.
7. **Unify "marketplace" naming** (MEDIUM-5): rename
   `Adapter.scanMarketplace` -> `scanInstalledPlugins`, and
   `MarketplaceResult` -> `InstalledPluginResult`. The `src/marketplace/`
   module keeps the marketplace name.
8. **Extract pure `parseConfigString(raw): Config`** (MEDIUM-4) for
   reuse between CLI and web worker.
9. **Hoist lazy imports** in long-running processes
   (`web/server.ts`, LOW-3) to surface breakage at startup.
10. **Defensive tooling**: add a lint rule `no-import-from-commands` for
    `core/`, `adapters/`, `protocols/`, `wiki/` directories to prevent
    HIGH-2/HIGH-3 regressions.

## Not a problem (verified)

- **No circular imports at runtime.** Grep confirms no module in
  `core/` or `adapters/` imports from `commands/` except HIGH-2; no
  adapter imports another adapter except the claude-code shared helper
  (MEDIUM-2). Dynamic `await import()` uses are startup-perf
  optimisations, not cycle-breakers (except `core/instructions.ts`
  whose comment is slightly misleading — see LOW-7).
- **Adapter interface is the right boundary.** All 13 built-in adapters
  conform uniformly. Optional fields (`sessionReader`, `scanMarketplace`)
  are correctly optional in the type and at the call sites
  (`registry.ts`, `mcp/server.ts` feature-flag checks).
- **Commands dispatch cleanly from `cli.ts`.** 60 lines, pure router.
- **Adapter detection encapsulated.** Each adapter owns its
  `detect()` call; registry only orchestrates.
- **Protocols layer is isolated.** No reverse dependencies from
  `adapters/` or `core/` into `protocols/`.
