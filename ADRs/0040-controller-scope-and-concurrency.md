---
status: accepted
date: 2026-05-05
---

# ADR-0040: Controller Scope & Concurrency Model (`withConfig` + AsyncMutex)

## Context

Iter4 Wave B introduced `src/core/controller.ts` as the single
admission point for read-modify-write (RMW) and apply operations
against agent-manager's config. The shipped surface — `withConfig<T>`
and `applyResolved` — has been load-bearing since 2026-04-17, but no
ADR documents (a) what it covers, (b) what it intentionally does NOT
cover, and (c) why a single-process mutex is adequate.

The 2026-05-05 parallel-critique architecture lens flagged this as a
spec-hygiene gap (synthesis Union-Architecture, "Missing ADRs worth
writing: Controller scope/concurrency"). This ADR closes that gap by
documenting the already-shipped design.

### Forcing function for the original work

On 2026-04-15 a concurrent-write race in the legacy code path wiped a
user's `~/.claude.json` mid-`am apply`. The contemporaneous comment
header in `src/core/controller.ts` records the incident. Two parallel
RMW callers reading the same config, each producing a divergent
post-mutation snapshot, last-writer-wins on disk → entire IDE config
overwritten with a stale view. The controller layer was built
specifically to prevent this class of failure.

Pre-controller, there were ~20 ad-hoc RMW sites and three parallel
apply pipelines (CLI, MCP, web). All have since been collapsed onto
the controller primitives.

## Decision

### Two primitives

**`withConfig<T>(configDir, options, fn)`** — serialized RMW with
optional auto-commit. Internally:

1. Acquires the process-wide `configMutex: AsyncMutex` via
   `configMutex.withLock(...)`.
2. Reads current config + (optionally) project config.
3. Invokes `fn(currentConfig)` which returns
   `{ result, updated?, changed? }`.
4. If `changed`, writes the updated config to disk (atomically via
   `writeConfig`) and optionally `commitAll()`s.
5. Releases the mutex.

**`applyResolved(configDir, options)`** — serialized apply pipeline.
Internally:

1. Acquires the same `configMutex`.
2. `loadResolvedConfig` → builds the resolved view by merging global
   + project + profile + `.local.toml`.
3. `interpolateEnvAsync` decrypts secrets via the master key.
4. For each detected adapter, calls `adapter.export(resolved, ...)`
   to write native IDE config files.
5. Releases the mutex.

Both primitives share the **same mutex**. This means a `withConfig`
mutation cannot interleave with an `applyResolved` and vice versa —
the resolved view passed into `export(...)` always reflects a config
on disk that no concurrent writer is mid-modifying.

### What the controller covers

- **All write paths to `config.toml` and `.local.toml`.** No caller in
  `src/commands/`, `src/tui/`, `src/web/`, or `src/mcp/` bypasses
  `withConfig` to call `writeConfig` directly.
- **All apply paths.** CLI `am apply`, MCP `am_apply`, web `POST
  /api/apply`, and TUI's `handleApply` all funnel through
  `applyResolved` (or `applyResolvedDefault`).
- **Auto-commit semantics.** Durable mutations (creates, deletes,
  edits) commit through the controller's commit path, preserving
  ADR-0002's "git-backed everything."

### What the controller intentionally does NOT cover

- **Reads.** `buildResolvedConfig`, `loadResolvedConfig`,
  `tryReadConfig`, and the read-tier MCP tools take the file as-is.
  Reads are not serialized because filesystem-level read atomicity
  on TOML files (small, single-write `writeConfig`) is sufficient for
  consistency — readers either see the pre-commit or post-commit
  view, never a partial write.
- **Non-config logic.** `run`, `agents`, `flow`, `wiki`, `session`,
  `import`, and `secret` commands have significant work outside the
  mutex (subprocess spawning, network I/O, search, transcript
  parsing). The controller does not gate these. When such commands
  do mutate config — e.g. `am import` writes new servers — they
  enter the controller for that segment only.
- **Cross-process contention.** The mutex is an in-process
  `AsyncMutex`, not a filesystem lock. Two `am` processes started in
  parallel (e.g. one from a shell, one from a TUI on a different
  terminal) **can** still race against each other. This is an
  accepted limitation; see Alternatives Considered.

### Invariant (load-bearing for this ADR)

> **No caller of config mutations may bypass `withConfig`.**
> Specifically, raw `writeConfig(...)` calls are forbidden in
> `src/commands/`, `src/tui/`, `src/web/`, and `src/mcp/`. The only
> legitimate `writeConfig` callers are inside `withConfig` itself,
> inside test fixtures, and inside one-shot bootstrap paths
> (`am init`, key migration) that run before the mutex's correctness
> assumptions matter.

Future contributors: if you need to mutate `config.toml`, the
question is "what closure goes inside `withConfig`?" not "where do I
call `writeConfig`?"

## Consequences

### Positive

- Concurrent-write races (`~/.claude.json` 2026-04-15 incident class)
  are eliminated within a single `am` process. CLI, MCP, web, and
  TUI cannot step on each other.
- Apply always sees a consistent resolved view — no
  config-mid-mutation export.
- The audit surface for "is this write safe?" collapses from "every
  write site" to "every `withConfig` callback." That's a 20-to-1
  reduction in attention surface.
- The shared mutex makes auto-commit semantics simple: a write that
  did not happen because the mutex was held simply waits, rather
  than racing for the same git index.

### Negative

- **Process-wide serialization is a throughput ceiling for the
  config layer.** Two concurrent `am import` calls in the same
  process serialize even if they would touch disjoint sections.
  Acceptable: writes are infrequent (human-scale) and short.
- **Cross-process is unprotected.** Two `am` processes can still
  race. The ADR-0040 mitigation is a pillar 6 *convention* (the user
  is expected to drive only one editor surface at a time), not a
  guarantee. A user running `am tui` and `am apply` from a second
  shell can in principle reproduce the original bug class.
  Mitigated in practice by writes being short and the apply pipeline
  being the last consumer; a future iteration can layer a file lock
  on top without changing the in-process API.
- **The "controller covers writes only" boundary is non-obvious to
  new readers.** It is intuitive to assume `core/controller.ts` is
  "the controller for everything." This ADR's "What the controller
  intentionally does NOT cover" section is the canonical disclaimer.

### Neutral

- `core/locks.ts` exposes `AsyncMutex`. Same primitive is reused for
  the `am mcp-serve` write-tier serialization (iter4 Wave B), which
  composes correctly because both grab `configMutex`.
- Test surface: ~30 controller-targeted tests. Tests for individual
  command happy-paths exercise the controller transitively.

## Alternatives Considered

**Option A — single-process AsyncMutex (the shipped design).**
Selected. Cheapest, fastest to implement, eliminates the
2026-04-15-class race for the dominant use case (one user, one shell
or one TUI session at a time). Cross-process is a known and
documented limitation.

**Option B — file-lock-based cross-process mutex.** Layer a
`flock(2)` (or `proper-lockfile`-style) lock on `config.toml`'s
parent directory so two `am` processes cannot interleave. Rejected
for this iteration:

- Adds platform variance (Windows lockfile semantics differ from
  POSIX `flock`; `proper-lockfile` is a workable abstraction but
  introduces a dependency).
- Adds startup cost to every `am` invocation, including the
  read-only ones, unless the lock is conditional on
  controller-entry — which doubles the code paths.
- The bug it prevents (two terminals, one user, simultaneous edits)
  is rare and recoverable (drift detection + git history make
  recovery tractable).
- The in-process mutex closes the dominant case (TUI + web server
  + MCP server all in one process via `am tui` / `am serve` /
  `am mcp-serve`) which was where the original incident occurred.

This option remains a documented future hardening. If we see a
second cross-process race incident in the wild, this is the next
step.

**Option C — per-section locks (servers, instructions, skills,
profiles independently lockable).** Rejected. Cross-section
invariants exist (profiles reference servers; tag activation crosses
section boundaries). Per-section locks would either need a
section-graph dependency analysis at write time — material complexity
— or accept inconsistency at section boundaries. Single mutex pays
~zero cost for human-scale writes.

**Option D — optimistic concurrency with retry.** Read config → write
modified config under "expected mtime/etag" precondition; retry on
conflict. Rejected for a config layer where conflicts are rare and
human-driven; the simple mutex has lower latency variance and
simpler failure semantics.

## References

- `src/core/controller.ts` — implementation
- `src/core/locks.ts` — `AsyncMutex`
- [ADR-0001 Layered core + adapter extensions](0001-layered-core-plus-adapter-extensions.md) — controller is the seam at the layered-core boundary
- [ADR-0002 Git-backed everything](0002-git-backed-everything.md) — auto-commit semantics
- [ADR-0015 Stateless web UI](0015-stateless-web-ui.md) and
  [ADR-0031a](0031a-pillar-6-amendment.md) — why CF Worker is
  out-of-scope for this controller
- `docs/reviews/2026-04-17-iter4-system-critique/01-system-structure.md`
- `docs/reviews/2026-04-17-iter4-system-critique/03-parallel-tool-calling.md`
- `docs/reviews/2026-05-05-parallel-critique/synthesis.md` — Union-Architecture missing-ADR finding
