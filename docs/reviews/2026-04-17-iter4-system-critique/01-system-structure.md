# iter4 / Facet 01 — Whole-system Architectural Health (post-ADR-0031)

**Scope.** Fresh structural read of agent-manager **as a six-pillar control plane**,
not as a per-surface audit. Everything here is new lens — iter1 hardened the
primitives, iter2 caught adapter schema drift, iter3 reframed the vision
(ADR-0031). This pass asks: *does the system, viewed as one machine, still
hang together?*

All file:line references are at HEAD on branch `main` (0.5.0-rc1, 2313 tests
passing).

## Summary

**Whole-system coherence score: 6.5 / 10.**

The six pillars are defensible. The primitives they rest on
(`core/atomic-write`, `core/git`, `core/agent-registry`, `core/session`) are
small, focused, reusable. ADR-0030's unified agent registry closed the iter1
"two ACP registries" wound cleanly; `src/protocols/acp/registry.ts:11-17`
imports the single dictionary from `src/core/agent-registry.ts:42`, no
duplicate truth.

But the **upper half of the system has not been refactored to match the
reframe**. Three surfaces (CLI, MCP, web) each re-implement the `apply`
pipeline end-to-end. Eight commands each roll their own
`tryReadConfig → mutate → writeConfig → commitAll` sequence with zero
reconciliation, zero file locking, and uneven error handling. State-store
functions (`readActiveProfile`, `writeActiveProfile`) live inside a command
module and are cross-imported by `mcp`, `web`, and `tui` — a layer
violation. Checksum primitive duplicated across two files. No
"controller" layer between commands and core. No progress-event bus.

**Health is good where primitives are small and old. Health sags where the
shape of a control plane (reconcile loop, one store, one admission
pipeline) hasn't been extracted yet.** Most of this is achievable by lifting
~6 small helpers into `core/`, not by rewriting.

## Data flow map

```mermaid
flowchart TB
  subgraph User["User surfaces"]
    CLI["am apply (CLI)"]
    MCP["am_apply (MCP)"]
    WEB["POST /apply (web)"]
    TUI["TUI apply key"]
  end

  subgraph Core["core/"]
    CFG["config.ts<br/>loadResolvedConfig<br/>buildResolvedConfig"]
    SEC["secrets.ts<br/>loadKey<br/>interpolateEnvAsync"]
    AR["agent-registry.ts<br/>BUILT_IN_ACP_AGENTS"]
    AW["atomic-write.ts<br/>atomicWriteFile"]
    GIT["git.ts<br/>commitAll<br/>isNothingToCommitError"]
  end

  subgraph Adapters["adapters/"]
    REG["registry.ts<br/>getDetectedAdapters"]
    A1["claude-code/index.ts"]
    A2["cursor/index.ts"]
    A3["...12 more"]
    COMM["community/loader.ts<br/>CommunityAdapterProxy"]
  end

  subgraph Store["Config store"]
    TOML["~/.config/agent-manager/<br/>config.toml<br/>adapters.toml<br/>state.toml<br/>key.txt"]
    WIKI["wiki/ (markdown + index)"]
  end

  subgraph Targets["Native IDE files (data plane)"]
    T1["~/.claude.json"]
    T2["~/.cursor/..."]
    T3["...13 more tools"]
  end

  CLI --> CFG
  MCP --> CFG
  WEB --> CFG
  TUI --> CFG

  CFG --> SEC
  CFG --> TOML
  SEC --> TOML
  MCP -.also reads state.toml via.-> USE["commands/use.ts<br/>readActiveProfile"]
  WEB -.also reads state.toml via.-> USE
  TUI -.also reads state.toml via.-> USE
  USE --> TOML

  CFG -->|ResolvedConfig| REG
  REG --> A1 & A2 & A3 & COMM
  A1 --> T1
  A2 --> T2
  A3 --> T3

  subgraph SessLoop["Session → wiki → context loop (pillar 5)"]
    SR["adapter.sessionReader<br/>(per-adapter)"]
    HARV["wiki/harvester.ts<br/>harvestSession"]
    WS["wiki/storage.ts<br/>addEntry / writePage"]
    SYN["wiki/synthesizer.ts<br/>synthesizeContext / buildAgentBriefing"]
  end

  T1 -.session files.-> SR
  T2 -.session files.-> SR
  SR --> HARV
  HARV --> WS
  WS --> WIKI
  SYN --> WIKI
  MCP -->|am_wiki_search<br/>am_wiki_synthesize<br/>am_wiki_briefing| SYN
```

### Prose walkthrough — `am apply` end-to-end

1. User invokes `am apply` (or calls `am_apply` via MCP, or POSTs `/apply`
   in the web UI). **Three independent entry points.**
2. Each entry point resolves `configDir` via `resolveConfigDir()` in
   `src/core/config.ts:20` (one source of truth — good).
3. Each entry point reads the project config via `resolveProjectConfig()`
   (`src/core/config.ts:28`) — also one source of truth.
4. Each entry point then **re-implements** the rest of the pipeline:
   - `loadResolvedConfig` (global → local → project → project-local merge)
   - active profile lookup via `readActiveProfile` imported from
     `src/commands/use.ts:18`
   - `loadKey(configDir)` from `core/secrets`
   - `interpolateEnvAsync(config, { encryptionKey })`
   - `buildResolvedConfig(interpolated, profile, configDir)`
   - `getDetectedAdapters()` (or `getAdapter(target)`)
   - per-adapter `adapter.export(resolved, { projectPath, dryRun })`
   - result aggregation and error reporting

   See:
   - CLI: `src/commands/apply.ts:30-146`
   - MCP: `src/mcp/server.ts:1432-1479` (tool `am_apply`)
   - Web: `src/web/server.ts:439-477` (`POST /apply` handler)

5. Each adapter's `export()` method calls `atomicWriteFile` or
   `atomicWriteFileSync` (`src/core/atomic-write.ts:114, 158`) on its
   native IDE targets (`~/.claude.json`, `~/.cursor/...`, etc.). Good.
6. The CLI path commits to `~/.config/agent-manager/` via `commitAll`.
   The MCP path commits. The web path commits. The TUI path commits. **No
   single place that says "after a successful mutation, commit."**

### Where the flow breaks down

- **Three apply pipelines.** Any bug fix (e.g., "also check for
  secret-detection before export") has to land in three places. This is
  the iter2 vision-audit "redundant surfaces" problem, *still present*
  after ADR-0031 because the ADR only formalized the pitch; it did not
  yet compact the implementation.
- **Shared state via imports from a command module.** `commands/use.ts`
  exports `readActiveProfile` / `writeActiveProfile`. Three non-command
  surfaces (`mcp/server.ts:15`, `web/server.ts:6`, `tui/index.tsx:5`)
  import them. `tui/data.ts:2` also imports. If `commands/use.ts` is
  renamed, refactored, or gets a new side effect, four unrelated files
  break. `core/merge.ts:9` imports `extractServerIdentity` from
  `commands/import.ts` — same inverted dependency.
- **Unnecessary hop for active profile.** Every surface re-reads
  `state.toml` once per invocation even though the resolved config was
  just computed. A memoised "current context" would help (see
  recommendations).
- **"Nothing to commit" handled inconsistently.** 9 call sites of
  `commitAll` use `isNothingToCommitError`; the other ~14 use bare
  try/catch that swallows ENOSPC or a corrupt repo as silently as a
  clean tree (e.g., `src/marketplace/installer.ts:96-99`,
  `src/mcp/server.ts:1018`). The primitive exists; the discipline to use
  it everywhere does not.

## Pillar sharing matrix

| Pillar | Uses `atomicWriteFile` | Uses `commitAll` | Uses `isNothingToCommitError` | Uses `BUILT_IN_ACP_AGENTS` | Uses sha256 helper | Comment |
|---|---|---|---|---|---|---|
| 1. Catalog + git sync | ✅ `core/config.ts:94, 114` | ✅ (commands) | ~mixed~ | — | — | Clean. Primitives live in `core/`. |
| 2. MCP gateway | ✅ via core/config | ✅ `mcp/server.ts:1018, 1053, 1113, 1244, 1362` | ❌ bare try/catch | via agent-registry import | **separate impl** `mcp/server.ts:160-162` (auth, not content) | Re-implements apply pipeline internally. |
| 3. Protocol router | indirect | — | — | ✅ single import `protocols/acp/registry.ts:11` | — | Cleanest pillar post-ADR-0030. |
| 4. Marketplace | ✅ via `community/loader.ts:12` | ✅ `marketplace/installer.ts:96, 280` | ❌ bare try/catch | — | Distinct concept: git SHA pinning (`marketplace/security.ts:229`) | Imports community adapter loader — cross-pillar coupling. |
| 5. LLM-wiki | via `wiki/storage.ts` using core/config path resolution | — (wiki has its own git remote via `core/git`) | — | — | — | Relies on `resolveConfigDir` + `resolveProjectConfig`. Good. |
| 6. UIs (TUI, web, CF worker) | ✅ via core | ✅ `tui/index.tsx:67, 143`, `web/server.ts:210, 240, 262, 322` | ❌ bare try/catch | via agent-registry | — | Three surfaces each re-import state helpers from `commands/use.ts`. |
| *(cross-cutting)* Community adapter install | ✅ | via commands | — | — | **duplicate impl** `adapters/community/loader.ts:76` and `commands/adapter.ts:569` | Same SHA-256 algorithm, two copies. |

**Legend:** ✅ = uses shared primitive. ❌ = repeats pattern locally. — = not applicable.

### Observations

- `atomicWriteFile` is well-centralised. No duplicate implementations.
  That primitive is doing its job.
- `BUILT_IN_ACP_AGENTS` is correctly a single source of truth. ADR-0030
  paid off.
- **`sha256:<hex>` compute has two copies**:
  `src/commands/adapter.ts:567-571` and
  `src/adapters/community/loader.ts:76`. Same three-line pattern
  (`createHash('sha256').update(data).digest('hex')`). Should live
  alongside `atomicWriteFile` in `core/` (e.g., `core/hash.ts`).
- **`isNothingToCommitError` is underused.** The helper exists at
  `src/core/git.ts:38-42` but only 9 of ~23 `commitAll` callers use it.
  The rest either omit error handling or use a bare try/catch that
  conflates "nothing to commit" with "git is actually broken."

## Control-plane vs data-plane findings

A real control plane has three invariants:

1. **One store.** Kubernetes has etcd behind the apiserver. Terraform has
   the state file. All writes go through one admission pipeline.
2. **Admission → desired-state → reconcile loop.** Writes are
   validated, persisted, and then reconciled toward the desired state.
   The reconcile loop is idempotent and has observability.
3. **Control plane is distinct from data plane.** The thing that stores
   intent is separate from the thing that executes it.

### Where am matches this model

- **One config store.** `~/.config/agent-manager/config.toml` (+
  layered overrides). ✅
- **Validation before persist.** `ConfigSchema.parse(parsed)` in
  `src/core/config.ts:47`. ✅
- **Control / data separation at the adapter edge.** `am` writes to its
  own store; adapters propagate to native IDE files. Per ADR-0031
  non-goal: "am is not a hosted inference product." ✅ conceptually.

### Where it doesn't

- **No admission pipeline.** Every command rolls its own:
  ```
  const config = await tryReadConfig(configPath);
  // mutate
  await writeConfig(configPath, config);
  await commitAll(configDir, message);
  ```
  This sequence appears 4 times in `src/commands/add.ts` (lines 139-198,
  258-282, 426-452, 501-526) and parallel variants in `install.ts`,
  `uninstall.ts`, `profile.ts`, `secret.ts`, `update.ts`, `use.ts`,
  `init.ts`, `import.ts`, `mcp/server.ts`, `web/server.ts`, `tui/index.tsx`,
  and `marketplace/installer.ts`. No centralised helper.
- **No reconcile loop.** `am apply` is a one-shot push. There is no
  "watch my config and keep IDEs in sync" mode, no idempotent tick. That
  is probably fine for v1 — users don't expect Kubernetes — but the
  product framing ("control plane") invites the expectation, and there is
  currently no abstraction on which a future controller could be layered
  without rewriting every command.
- **No file lock.** `grep -rn "flock\|FileLock\|lockfile\|proper-lockfile"
  src/` returns **zero matches**. Two `am` processes, two MCP clients, or
  `am apply` racing with a TUI-driven edit will both `tryReadConfig`,
  both `writeConfig` (atomic per-file, so no corruption — good), and the
  second write wins silently. For a tool whose tagline is "control
  plane," this is a real gap. `atomicWriteFile` gets us durability; it
  does not get us serialisability.
- **Three admission paths, not one.** `apply` is duplicated across
  CLI / MCP / web (see Data flow map above). A controller would fold
  these into one function.

### The shape of the missing piece

The natural extraction is a `core/controller.ts` (or `core/admission.ts`)
exposing:

```ts
// Read-modify-write with implicit lock, validation, commit.
export async function withConfig<T>(
  fn: (config: Config) => T | Promise<T>,
  opts: { commitMessage: string; configDir?: string }
): Promise<{ result: T; committed: boolean }>;

// Apply the resolved desired state to detected (or targeted) adapters.
// Used by CLI, MCP, and web.
export async function applyResolved(
  resolved: ResolvedConfig,
  opts: { target?: string; dryRun?: boolean; projectPath?: string }
): Promise<ApplyResult>;

// Resolve the current context (configDir, profile, project, key).
// Memoised per-process.
export async function currentContext(): Promise<Context>;
```

With these three helpers:
- `commands/add.ts` shrinks from 4 near-identical blocks to 4 calls to
  `withConfig`.
- CLI / MCP / web `apply` all call `applyResolved` — one pipeline.
- `readActiveProfile` moves out of `commands/use.ts` into `core/state.ts`
  (or into `currentContext`).

## Session → wiki → context loop (is it real?)

**Short answer: yes, the plumbing is end-to-end real, but the feedback
loop closes only when a human invokes it.**

### Trace

1. **Session capture.** Adapters expose `sessionReader` (`SessionReader`
   interface in `src/core/session.ts:47-56`). 4 adapters implement it:
   claude-code, codex-cli, cursor, kiro (per iter2 audit of adapter
   capabilities).
2. **Harvest.** `src/wiki/harvester.ts:359-379` turns a `Session` into
   `KnowledgeEntry[]` via pattern-based extractors (procedures, error
   resolutions, preferences, capabilities, facts). Deduplicates via
   Jaccard similarity on tokens (`harvester.ts:20-34`).
3. **Storage.** `harvestSessionAsPages` (line 385) writes `WikiPage`
   objects via `wiki/storage.ts:writePage`. Content goes to
   `$configDir/wiki/global/` or `$configDir/wiki/projects/<project>/`
   (`wiki/storage.ts:90`).
4. **Search index.** MiniSearch BM25 index rebuilt on every ingest
   (`commands/wiki.ts:383, 437`). Readable via `searchPages` /
   `searchEntries`.
5. **Exposure to agents.** MCP server exposes 5 wiki tools
   (`mcp/server.ts:236-240, 440-457, 1653-1854`):
   - `am_wiki_search` — BM25 search (read-only)
   - `am_wiki_add` — manual entry (write-local)
   - `am_wiki_synthesize` — generate context block for query
   - `am_wiki_briefing` — agent-specific briefing
   - `am_wiki_harvest` — run extraction on a session id

### So is the loop closed?

- **Input side.** ✅ Sessions land on disk (from each adapter's native
  session storage). The reader knows how to parse them.
- **Extraction side.** ✅ `harvestSession` is wired and produces
  `KnowledgeEntry[]`.
- **Storage side.** ✅ Wiki pages are written atomically, indexed for
  BM25.
- **Read side for agents.** ✅ MCP tools are exposed; any agent plumbed
  into `am mcp-serve` can call `am_wiki_search` and `am_wiki_synthesize`.

**The missing piece for "agents have context of what was done
automatically" is the auto-harvest trigger.** Extraction only runs on:
- explicit `am wiki ingest` CLI invocation,
- explicit `am_wiki_harvest` MCP call.

There is no:
- daemon that tails session files,
- post-session hook in each adapter,
- scheduled harvester.

### Verdict

The wiki pillar is **real, not aspirational**, but it is a pull-model
library, not a push-model service. An agent using `am mcp-serve` today
*can* say "what did the user work on yesterday?" and `am_wiki_synthesize`
will return a relevant context block — *if* `am wiki ingest` was run
recently. The README framing "agents using am have context of what was
done" is honest but depends on the user running ingest or configuring
cron.

Gap for pillar-5 graduation to first-class:
- An `am wiki ingest --watch` daemon, or
- A PostToolUse hook pattern that triggers `harvestSession` after each
  session finalises in the underlying adapter.

Neither is a huge build. Both would close the loop to "automatic."

## Non-obvious coupling (3 examples)

### #1 — `commands/use.ts` is a de-facto core module

```
src/commands/use.ts:18  export async function readActiveProfile(configDir)
src/commands/use.ts:28  export async function writeActiveProfile(configDir, profile)
```

Imported by:
- `src/mcp/server.ts:15`
- `src/web/server.ts:6`
- `src/tui/index.tsx:5`
- `src/tui/data.ts:2`
- `src/commands/apply.ts:13` (intra-commands)

**Why it's non-obvious.** The file is named `use.ts` and its stated job
is the `am use <profile>` CLI command. The two exports are stateless
helpers that happen to live there. A reader grepping for "where does the
MCP server read state?" will land in `commands/use.ts` and be
confused — there's no API documentation pointing there, no re-export
through `core/`.

**Breaks if.** Anyone touches the file thinking "this is just the CLI
command" and accidentally makes the helpers command-scoped (e.g., adds a
`clack` prompt into `writeActiveProfile`). All four non-command surfaces
silently break.

**Fix.** Move to `src/core/state.ts`. Two-line change per importer.

### #2 — `core/merge.ts` imports from `commands/import.ts`

```
src/core/merge.ts:9    import { extractServerIdentity } from "../commands/import";
```

**Why it's non-obvious.** Core should not depend on commands. The
dependency graph is supposed to be commands → core → lib. This inverts
it. `extractServerIdentity` is a pure function that lives in the
command module because that's where the author was working when they
wrote it.

**Breaks if.** Someone runs `tsc --isolatedModules` with strict cycle
detection, or splits `commands/` into a separate build target, or adds
a `.subCommands` registration that has side effects at import time.
`core/merge` starts pulling in citty and the rest of the command
harness.

**Fix.** Move `extractServerIdentity` into `src/core/merge.ts` (where
its only caller lives) or `src/core/identity.ts`.

### #3 — `marketplace/installer.ts` imports `adapters/community/loader.ts`

```
src/marketplace/installer.ts:8-13
  import {
    readAdaptersToml,
    removeCommunityAdapterConfig,
    setCommunityAdapterConfig,
    writeAdaptersToml,
  } from "../adapters/community/loader";
```

**Why it's non-obvious.** Pillar 4 (marketplace) importing from pillar 1
(adapters/community). The marketplace must know how to register a
community adapter in `adapters.toml` because a plugin manifest can ship
a community adapter (`plugin.manifest.adapter`).

**Breaks if.** The community adapter schema changes (e.g., a new
required field in `CommunityAdapterConfig`), the marketplace install
path starts writing invalid `adapters.toml` entries — silently, because
`writeAdaptersToml` does a schema-less write
(`adapters/community/loader.ts:99`) and the loader only validates at
spawn time.

**Fix.** Either (a) co-locate the shared write helper in `core/`, or
(b) validate `CommunityAdapterConfig` with zod in `writeAdaptersToml` so
a cross-pillar caller gets a loud error at write-time instead of a
silent broken install.

**Bonus coupling.** `src/core/config.ts:138-153` has `projectToConfig`
which maps `ProjectConfig.env` into `Config.settings.env` (line 149).
Any new field added to `ProjectConfig` but not handled here is silently
dropped during merge. This is a correct-by-construction risk that would
bite a contributor adding a new project-scoped feature.

## Missing primitives

Primitives that recur as free-hand patterns and deserve a home in
`core/` or `lib/`:

### 1. `core/hash.ts` — sha256 of a file

Currently at `src/adapters/community/loader.ts:76` and
`src/commands/adapter.ts:567-571`. Also latent at `src/mcp/server.ts:160`
for token hashing.

```ts
export async function sha256File(path: string): Promise<string>;
export function sha256String(s: string): string;
export function sha256Buffer(b: Uint8Array): string;
```

### 2. `core/controller.ts` — `withConfig` admission helper

As described in the control-plane section. Collapses the 20+ places
that do `tryReadConfig → mutate → writeConfig → commitAll` into one
transactional function with:

- implicit lock (solves the race),
- implicit `isNothingToCommitError` swallow,
- explicit commit message,
- ability to opt out of commit (for `--dry-run`).

```ts
export async function withConfig<T>(
  fn: (draft: Config) => T | Promise<T>,
  opts: {
    commitMessage: string;
    configDir?: string;
    commit?: boolean;  // default true
    scope?: "global" | "project";
  }
): Promise<{ result: T; committed: boolean; warnings: string[] }>;
```

### 3. `core/lock.ts` — advisory file lock

Zero implementations today. For a control plane, a `.lock` file guarded
by `proper-lockfile` or a hand-rolled `O_CREAT | O_EXCL` dance is the
right primitive. Used inside `withConfig`; also used by
`commands/pull.ts` and `commands/push.ts` to prevent concurrent git ops.

```ts
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts?: { timeoutMs?: number }
): Promise<T>;
```

### 4. `core/state.ts` — active-profile state (move out of commands)

`readActiveProfile` / `writeActiveProfile` currently in
`src/commands/use.ts:18-43`. Move unchanged; update 4 importers.

### 5. `core/apply.ts` — one apply pipeline

Collapses `src/commands/apply.ts:93-146`, `src/mcp/server.ts:1432-1479`,
and `src/web/server.ts:439-477`.

```ts
export async function applyResolved(
  resolved: ResolvedConfig,
  adapters: Adapter[],
  opts: { dryRun?: boolean; projectPath?: string }
): Promise<ApplyResult>;
```

Each surface just prepares `resolved` + `adapters` the way it likes and
calls this. Per-surface output formatting stays at the surface (CLI
prints, MCP returns JSON, web returns JSON). Per-surface auth stays at
the surface. The *pipeline* is one function.

### 6. `core/events.ts` — optional progress events

Already latent in `src/protocols/a2a/server.ts:TaskEventEmitter`. The
CLI doesn't need it (info/warn suffices). MCP and web *do* — neither
currently reports progress during a long `apply`. If `applyResolved`
takes an optional `onEvent: (e: ApplyEvent) => void`, the MCP and web
surfaces can stream status via SSE / tool notifications without
re-inventing progress pipes.

### 7. A better `commitAll` — `commitIfChanged`

```ts
export async function commitIfChanged(dir: string, message: string): Promise<{
  committed: boolean;
  sha?: string;
}>;
```

Wraps the current `commitAll` + `isNothingToCommitError` pattern.
Removes the try/catch from 23 call sites. Makes "did we commit?"
observable in tests.

## Recommendations

Ranked by leverage (change effort × surface area impact):

### Highest leverage — do first

**R1. Extract `core/controller.ts` with `withConfig` + `applyResolved`.**
This collapses the three apply pipelines into one and consolidates the
read-modify-write pattern across ~15 command files. Every bug fix after
this lands in one place. Estimated: ~400 LOC added to `core/`, ~800 LOC
removed from commands / mcp / web. Net simplification.

### High leverage

**R2. Move `readActiveProfile` / `writeActiveProfile` to
`core/state.ts`** and rename four importers. 20 LOC change, eliminates
the single biggest upward-dependency violation in the codebase.

**R3. Add `core/hash.ts` and route `adapters/community/loader.ts` +
`commands/adapter.ts` through it.** Removes duplicated sha256 code.
Sets up the pattern for R1's need-a-hash primitive.

**R4. Add `core/lock.ts` and use it inside `withConfig`.** Closes the
race window for concurrent writers. Critical once "control plane" is on
the tin.

### Medium leverage

**R5. Replace all bare `try { await commitAll(...) } catch {}` blocks
with `commitIfChanged` or `isNothingToCommitError`.** 14 call sites.
Makes "git is actually broken" observable instead of being conflated
with "nothing to commit." Worth doing as a single tree-wide sweep.

**R6. Validate `CommunityAdapterConfig` in `writeAdaptersToml`.**
Catches marketplace → community-adapter coupling at write-time. ~10
LOC change.

**R7. Consider moving `extractServerIdentity` out of `commands/import.ts`
into `core/identity.ts` (or co-locate inside `core/merge.ts`).**
Eliminates the `core → commands` import cycle.

### Pillar-5 graduation (separate workstream)

**R8. Ship `am wiki ingest --watch` or a per-adapter post-session hook
for auto-harvest.** Without it, the "agents have context of what was
done" claim in pillar 5 depends on the user running ingest. With it,
pillar 5 becomes automatic and deserves its top-billing.

### Not recommended (for v1.0)

- Splitting into multiple binaries. ADR-0031 already rejected this.
  Agreed — the single-binary story is a feature.
- Full reconciliation loop (K8s-style). The non-goal in ADR-0031 is
  correct: am is not a hosted inference product. One-shot `apply` with
  an optional `--watch` mode (future) is enough.
- Introducing RBAC / multi-tenancy. ADR-0031 explicitly flags these as
  post-v1.0 and would mushroom the surface area for little user value
  at 0.5.0-rc1.

## Appendix — what the ADR-0030/0031 landings got right

Worth calling out because iter4 should not be all critique:

- **ADR-0030's unified agent registry is a model refactor.** Before:
  two copies of `BUILT_IN_ACP_AGENTS`. After: one dict in
  `src/core/agent-registry.ts:42` imported by
  `src/protocols/acp/registry.ts:11` with an explicit comment
  ("Canonical ACP built-in list lives in src/core/agent-registry.ts per
  ADR-0030"). The MCP server, bridge, and config resolver all agree.
  That pattern — **one module owns the dict, everyone else imports** —
  is the pattern the commands/apply, commands/use, and community/loader
  refactors should follow.
- **ADR-0031 gave the audit yardstick.** Before: the iter2 report
  recommended cutting 40% of LOC because it was measuring against the
  wrong pitch. After: pillars are explicit, marketplace/web/wiki are
  *features* not *sprawl*, and future reviews have a cleaner frame. The
  vision doc is doing real work.
- **`atomicWriteFile` is the right primitive at the right level.** Its
  symlink-preserving variant (`resolveEffectiveTarget` at
  `src/core/atomic-write.ts:62-96`) quietly solves the dotfile-repo
  user workflow. No duplicates. Correct scope.

The next refactor (R1-R7) builds on this pattern: small, focused helpers
in `core/`, imported by everything upstream, with a single-line comment
at the re-export site pointing back to the canonical home.
