# REV-1 — System-level Structural Health Review (post-rc5)

**Date:** 2026-04-18
**Scope:** agent-manager `main` at HEAD (rc5 landed, IMPL-A catalog-truth pass in flight).
**Method:** Targeted grep + read of the controller/mutex path, ACP client, MCP server,
CLI commands, TUI, marketplace, and the Tier-1/2/3 propagation surface. Cross-checked
against ADR-0031 (pillars), ADR-0032 (glossary), ADR-0033 (tiers), and the four prior
audits on disk.
**Reviewer:** Agent (Opus 4.7 1M). Read-only — no code modified.

Companion reviews already on disk: **REV-2** (security) found the apply-replace issue
independently and flagged a progress-notification redaction gap; **REV-3** (test/CI)
flagged the Windows POSIX-hardcoding and the absent FileSink regression test. This
review focuses on structural health — regressions since iter4, apply-pipeline
consistency, coupling gaps, and the open apply-replace question.

---

## Summary

**Health score: 7.5 / 10 post-rc5.**

The iter4 Wave B controller landed cleanly for MCP and CLI `am apply`. Agent
detection is cached and O(agents + adapters), not O(agents × adapters × detection).
rc5's ACP stdin fix closes the runtime crash cleanly. Tiers ship behind a
`runnable: false` flag that `am run` actually respects.

What holds the score below 9:

1. **`withConfig` is enforced only in MCP + four CLI commands** (`apply`, `add`,
   `import`, `secret`). Eight other mutating surfaces — `install`, `uninstall`,
   `update`, `profile create/delete`, `init`, marketplace install/uninstall, TUI
   — still do raw `readConfig → mutate → writeConfig`, bypassing the mutex. Two
   concurrent `am install foo,bar` processes, or `am install` racing against
   `am_add_server` via MCP, can still lose writes. This is the same hazard class
   the Wave-B mutex was built to close; it's closed for MCP-vs-MCP but open for
   CLI-vs-anything.
2. **`applyResolved` is used by CLI + MCP + web, but TUI has its own copy**
   (`src/tui/index.tsx:157-177`) that loads+interpolates+exports by hand. It
   works, but it's the fourth apply pipeline that ADR-0031 claimed was collapsed
   into one.
3. **`am apply` full-replaces `mcpServers`** — already flagged by REV-2 with the
   same file:line, design question reframed below as §"Apply-replace behavior".
4. **Windows gap is growing.** The new iter4 tests (locks, agent-detection,
   concurrency, agent-invoke) all sit on `test/helpers/tmp.ts:19-20`, which uses
   `mkdir -p` via `Bun.spawn` and splits paths with `/`. These will fail on the
   Windows matrix the moment `continue-on-error` is removed.
5. **`--tier` filter is referenced in error messages but not implemented.** `am
   agent list --tier native` is advertised at `src/commands/agents.ts:536` but
   the `list` command has no such flag.

Nothing blocks rc5 → 0.5.0 GA by itself. Items 1, 2, and 5 are post-release
follow-ups; #4 is a deferred-work tax; #3 is the one design question below that
should be answered before 0.6.

---

## Regressions since iter4 (severity-tagged)

### HIGH-1 — `--tier` filter promised, not implemented

**Severity:** HIGH (user-visible broken promise).
**File:** `src/commands/agents.ts:116, 536`.

The Tier-3 refusal message tells users to run `am agent list --tier native`:

```text
src/commands/run.ts:116
"…For a runnable alternative, see `am agent list --tier native`."

src/commands/agents.ts:536
"…Use its native UI; see `am agent list --tier native` for runnable alternatives."
```

But `am agent list` (`src/commands/agents.ts:30-135`) declares no `--tier` arg
and its handler applies no filter. Users hitting the refusal will run the
suggested command, citty will reject the unknown flag, and the hint becomes
noise. Either implement the flag or reword the hint.

### MEDIUM-1 — TUI has its own apply pipeline

**Severity:** MEDIUM (divergence risk, not correctness — yet).
**File:** `src/tui/index.tsx:157-177`.

The controller docblock (`src/core/controller.ts:178-191`) claims the canonical
apply pipeline replaced three implementations (CLI / MCP / web). In practice:

- CLI (`src/commands/apply.ts:26`), MCP (`src/mcp/server.ts:1572`), and web
  (`src/web/server.ts:462`) all route through `applyResolved`. ✓
- TUI's `handleApply` does its own load → decrypt → resolve → for-each adapter
  export loop. Not behind `configMutex`, no profile override, no structured
  result — duplicate pipeline #4.

Two hazards: (a) TUI export runs while CLI or MCP apply runs, both racing on
`~/.claude.json`; (b) future changes to the canonical pipeline (e.g., per-adapter
error wrapping that REV-2 will need to route through for redaction) will quietly
skip TUI.

### MEDIUM-2 — CLI mutating commands bypass `withConfig`

**Severity:** MEDIUM (depends on multi-process usage pattern).
**Files (raw `writeConfig` call sites without `configMutex`):**

- `src/commands/install.ts:194` — `am install foo,bar,baz`
- `src/commands/uninstall.ts:69` — `am uninstall`
- `src/commands/update.ts:181` — `am update`
- `src/commands/profile.ts:177` — `am profile create`
- `src/commands/profile.ts:244` — `am profile delete`
- `src/commands/init.ts:73` — `am init`
- `src/marketplace/installer.ts:81` — `am marketplace install`
- `src/marketplace/installer.ts:278` — `am marketplace uninstall`
- `src/tui/index.tsx:65, 141` — TUI remove / import

In-process serialization was the explicit scope of Wave B (`src/core/locks.ts:4`:
*"These are in-process only"*), so CLI-vs-CLI across OS processes was always
out of scope. But the hazard that triggered Wave B — `am apply` via MCP racing
an interactive MCP write — now exists between `am_add_server` via MCP and any
of the CLI commands above running in the same session. The Wave-B fix closes
MCP-vs-MCP; it does not close MCP-vs-CLI.

Two mitigations, not mutually exclusive:
- Add `proper-lockfile` on `config.toml` in `writeConfig` itself (all paths get
  it for free). This closes cross-process races and is roughly 40 LOC.
- Route the above commands through `withConfig` so they pick up the in-process
  mutex (10 min each). Addresses in-process but not cross-process.

### LOW-1 — No test covers the FileSink regression that blocked rc5

**Severity:** LOW (issue already fixed; noted for completeness).
**File:** `src/protocols/acp/client.ts:143-163`.

REV-3 flagged this independently. A runtime test would spawn a minimal echo
agent, drive a real `initialize` → `session/new` → `session/prompt` and assert
it comes back. The wrapper in client.ts is subtle enough that a pure unit test
wouldn't catch a future regression on its contract with `ndJsonStream`.

---

## Latent casts that could blow up (grep-verified)

```
$ grep -rn "as unknown as WritableStream\|as unknown as ReadableStream" src/
(no matches)
```

```
$ grep -rn "as ReadableStream\|as WritableStream" src/
src/protocols/acp/client.ts:166:
  const stream = ndJsonStream(writable, proc.stdout as ReadableStream<Uint8Array>);
src/protocols/acp/client.ts:532:
  output = proc.stdout ? await new Response(proc.stdout as ReadableStream).text() : "";
src/adapters/community/proxy.ts:71:
  const stdout = this.process.stdout as ReadableStream<Uint8Array>;
```

All three remaining casts are on `Bun.spawn(...).stdout`, which *is* a
web-standard `ReadableStream<Uint8Array>` per Bun semantics. These are the
correct narrowing casts, not the dangerous `as unknown as …` double-launder
pattern that hid the FileSink bug. No further action needed — but when Phase B
lands the shim-wrapper, it should reuse the same `writable` adapter pattern at
`client.ts:143-163` for its wrapped subprocess stdin. Copy-pasting the
`stdin as WritableStream<Uint8Array>` shortcut would recreate the rc5 crash
verbatim.

---

## Apply pipeline consistency

```
$ grep -rn "applyResolved\(" src/
src/commands/apply.ts:26       ✓ CLI      → applyResolved(configDir, {...})
src/mcp/server.ts:1572         ✓ MCP      → applyResolved(configDir, {...})
src/web/server.ts:462          ✓ Web      → applyResolved(resolveConfigDir(), {...})
src/core/controller.ts:274     ✓ default-wrapper helper
```

Three of the four surfaces route through `applyResolved`. TUI does not (see
MEDIUM-1). `applyResolved` itself takes the `configMutex` for the whole apply
span (`src/core/controller.ts:197`), which is the right call — an apply is a
read-many-files + export-many-files span where a concurrent write in the middle
would produce an incoherent result.

Secondary check: all six callers to `loadResolvedConfig` / `buildResolvedConfig`
outside the controller are read-only consumers (status, list, config show, TUI
data, web status):

- `src/commands/list.ts:63`, `src/commands/config.ts:142`,
  `src/commands/status.ts:29,49`, `src/commands/profile.ts:98`,
  `src/tui/data.ts:48,93`, `src/web/server.ts:121,379,555,567`.

All are intended read paths. None of them write the resolved config back, so
they don't need the mutex. ✓

---

## Coupling / propagation gaps

### Tier / `runnable` propagation — mixed

- `BUILT_IN_AGENTS` (`src/core/agent-registry.ts:76-143`) declares tier for
  every entry. ✓
- `BUILT_IN_ACP_AGENTS` re-exports only tier-1-native (`agent-registry.ts:154-158`).
  Good — keeps spawnable lookups clean. ✓
- `UnifiedAgent.runnable` is populated: tier-3 → false, tier-1 → true
  (`agent-registry.ts:244-260`). ✓
- `am run` honors `runnable === false` with an ADR-0033-quality message
  (`src/commands/run.ts:114-121`). ✓
- `am agent detect <tier-3-name>` honors tier at `agents.ts:534-541`. ✓
- `am flow run`: does NOT consult `runnable`. The flow's `acpExecutor`
  (`src/commands/flow.ts:78-89`) calls `client.connectByName(agentName)`, which
  hits `protocols/acp/registry.resolveAgent` → `BUILT_IN_ACP_AGENTS` (tier-1
  only). A tier-3 name returns `null` and `connectByName` throws
  `AGENT_NOT_FOUND`, which the flow surface catches as "Flow failed: <name>".
  Not the clear catalog-only message ADR-0033 promised, but also not a data
  corruption — the refusal happens, just with a generic error shape.
- `am_agent_invoke` via MCP (`src/mcp/server.ts:2238-2343`): on tier-3 entry it
  falls past both `if (entry.acp)` and `if (entry.a2a)` branches and throws
  *"Agent '<name>' has neither an ACP nor A2A endpoint"* — same generic error
  shape as flow. Works, but doesn't name the tier-3 concept.
- `am apply`: applies regardless of tier. This is correct — tier-3 catalog-only
  agents still need their configs written for `am apply` to be useful.
- `am run --json`: inherits the tier check. ✓

**Verdict:** `runnable: false` is set everywhere it needs to be; the refusal is
modeled twice (explicit in `am run`, implicit via null lookup in flow and
`am_agent_invoke`). A single shared helper
`refuseCatalogOnly(agent: UnifiedAgent): never` would unify the message so all
three surfaces emit the ADR-0033 text. Nice-to-have, not a blocker.

### Shell-wrapper (Phase B) → client.ts coupling

The proposed shim-wrapper at `src/protocols/acp/shell-wrapper.ts` is NOT yet in
tree (verified via `ls src/protocols/acp/`: `client.ts flows.ts registry.ts
types.ts`). When it lands:

- It reuses `client.ts` only as a consumer — shim is an agent, client is a
  client.
- The wrapper will call `Bun.spawn(wrapped-cli)` internally. It MUST copy the
  WritableStream adapter from `client.ts:143-163`, not the cast. Same rc5 bug
  waiting to happen otherwise.
- `registry.resolveAgent` currently reads `BUILT_IN_ACP_AGENTS` — the tier-1
  filter. If Phase B adds tier-2-shim entries with spawn commands, they need
  to appear in `BUILT_IN_ACP_AGENTS` OR `registry.resolveAgent` needs to learn
  about `BUILT_IN_AGENTS[name]` for tier-2-shim entries. Current filter at
  `agent-registry.ts:156` (`.tier === "tier-1-native"`) would silently exclude
  tier-2 shims.
- `connection.ts` does not exist. The review prompt asked about it; rc5 used
  `client.ts` only.

### Session → wiki → context loop (pillar 5)

- Session harvest (pillar 5's sole input per ADR-0031:111) is not touched by
  iter4 Wave B or rc5. The core pipeline (`src/wiki/harvester.ts`) reads
  session adapters; `src/commands/wiki.ts:382` calls `harvestSessionAsPages`;
  `src/mcp/server.ts:1929` exposes it via `am_wiki_harvest_session`. All
  paths work without the controller — harvest is read-side only.
- `src/core/instructions.ts:164` and `src/mcp/server.ts:1863, 1887` import
  `synthesizeContext`/`buildAgentBriefing` — these are pure reads over the
  wiki storage, no config mutation.
- Verdict: session-harvest pipeline unaffected by Wave B. ✓

### `controller.ts` importers

```
$ grep -rn "from.*core/controller" src/
src/web/server.ts:16          applyResolved, withConfig
src/mcp/server.ts:25          applyResolved, withConfig
src/commands/import.ts:5      withConfig
src/commands/secret.ts:6      withConfig
src/commands/add.ts:5         withConfig
src/commands/apply.ts:3       applyResolved
```

Six importers. Matches the Wave-B plan. Not imported from: `install`,
`uninstall`, `update`, `profile`, `init`, `use`, `marketplace/installer`, `tui`
(see MEDIUM-2 above).

---

## Apply-replace behavior (design question or bug?)

**The mechanics:** `src/adapters/claude-code/export.ts:107-147` generates
`~/.claude.json`. Line 145 is the crux:

```ts
const output = { ...existing, mcpServers };
```

Non-MCP fields on the existing `~/.claude.json` (numStartups, firstStartTime,
theme, etc.) are preserved via spread. But `mcpServers` is replaced wholesale
from the catalog — any MCP server present in `~/.claude.json` that isn't in
the am catalog vanishes.

Compare to `import.ts:109-130` which has the inverse problem and lives under
the "brownfield import" semantic in ADR-0028: import walks existing
`mcpServers` and adds them to the catalog.

**Reframe:** this is two operations with two different semantics.

| Op | User intent | Current behavior | ADR-0028 promise |
|----|------------|------------------|--------------------|
| `am import <tool>` | "pull tool's servers INTO my catalog" | intelligent merge | merge ✓ |
| `am apply` | "push my catalog TO tools" | replace | *not explicit* |

The README (line ~35 per REV-2) advertises "intelligent merge" as part of the
brownfield story, without distinguishing the direction. That's the broken-promise
shape — users reasonably read "merge" as bi-directional, find out via data loss
that apply is uni-directional.

**Two coherent answers:**

1. **Keep replace as the default, document it loudly.** Apply is "the catalog
   is the truth" — users who added an `mcpServers` entry in Claude Code outside
   the catalog are *expected* to `am import` first, then `am apply`. Add a
   `--merge` flag for the soft case. Document at export.ts:107 and in README.
2. **Add an `am apply --merge` mode that preserves unknown `mcpServers` keys.**
   Teach export.ts to read `existing.mcpServers`, keep keys not in the resolved
   catalog, and surface a warning ("kept 2 foreign entries"). `am status`
   already surfaces drift; this would treat foreign entries as benign drift.

Option 2 is more work (needs to apply to every `mcpServers`-style adapter:
Claude Code, Cursor, Copilot, Cline, Roo-Code, Kiro, Amazon Q, plus project
`.mcp.json`) but matches user expectation.

Recommendation: option 2 for 0.6, option 1 documentation patch for 0.5.x
(one-line README clarification + changelog note).

---

## Windows gap trend

CI matrix at `.github/workflows/ci.yml:49-54` still has `continue_on_error: true`
on the Windows job. Prior audit
(`docs/reviews/2026-04-16-v1-readiness/v1-readiness-analysis.md:210`) documented
the Windows failure count as "59 pre-existing". Current count per the review
prompt is 342. Delta of 283 failing tests across iter2+iter3+iter4.

**Why the gap grew:** `test/helpers/tmp.ts:13-34` is the common setup helper
used by **110 test files**. It:

1. `path.substring(0, filePath.lastIndexOf("/"))` — splits on POSIX `/` only,
   returns wrong dirname on Windows when given a backslash-joined path.
2. `Bun.spawn(["mkdir", "-p", dir])` — `mkdir -p` exists as `mkdir` in PowerShell
   but accepts different flags; `-p` is silently ignored on recent PowerShell
   and the whole construct is POSIX-centric.

New tests since iter4 that all use this helper:
- `test/core/locks.test.ts`
- `test/core/agent-detection.test.ts`
- `test/commands/agent-detect.test.ts`
- `test/mcp/concurrency.test.ts`
- `test/mcp/agent-invoke.test.ts`

All five were added in the last 48h; all five will POSIX-break on Windows.
`test/helpers/tmp.ts` is also POSIX-hostile, so the fix is **one file, 6 lines**:
replace `mkdir -p` with `node:fs/promises.mkdir(..., { recursive: true })` and
replace `lastIndexOf("/")` with `path.dirname`. That alone drops the 342 number
materially without touching the 110 callers.

**Recommendation:** Fix `test/helpers/tmp.ts` as a single-commit chore. Re-run
Windows matrix. Take the new delta (likely still >59 — there are probably
real path-handling bugs in source). Triage from there.

---

## Recommendations ordered by severity

1. **(HIGH)** Implement `am agent list --tier <native|shim|catalog>` or rewrite
   both refusal messages. Broken user-visible promise, ~30 min fix.
   Files: `src/commands/agents.ts:30-135, 116, 536`; `src/commands/run.ts:116`.

2. **(MEDIUM)** Route the eight CLI mutating commands + TUI through
   `withConfig`. Closes the in-process hazard the Wave-B design targeted.
   Estimated 1-2h total.
   Files: `install.ts`, `uninstall.ts`, `update.ts`, `profile.ts`, `init.ts`,
   `marketplace/installer.ts`, `tui/index.tsx`.

3. **(MEDIUM)** Collapse TUI's apply to `applyResolved`. Matches the pillar-6
   claim in ADR-0031 (*"All three are skins over the same core via
   core/controller.ts — no parallel implementations"*).
   File: `src/tui/index.tsx:157-177`.

4. **(MEDIUM)** Decide apply-replace vs apply-merge. Pick option 1 (document)
   or option 2 (feature) above. At minimum add a README one-liner clarifying
   the direction. Ties to REV-2's HIGH-2.

5. **(MEDIUM)** Fix `test/helpers/tmp.ts` Windows-hostility. One-file chore.
   Re-baseline the Windows failure count. Remove the `continue-on-error: true`
   once below a sane threshold (50-ish).

6. **(LOW)** Add one end-to-end ACP smoke test — spawn a trivial echo agent,
   drive initialize → prompt → response, assert text comes back. Would have
   caught the FileSink regression. File to add: `test/protocols/acp/e2e.test.ts`.

7. **(LOW)** Unify the tier-3 refusal across `am run`, `am flow run`, and
   `am_agent_invoke` via a shared `refuseCatalogOnly(agent)` helper in
   `src/core/agent-registry.ts`. Consistent user message, one source of truth.

8. **(LOW)** Copy the `writable` stdin wrapper from `client.ts:143-163` into
   the Phase B shim-wrapper when it lands. Explicit comment marking it as the
   required pattern for Bun subprocess stdin. Prevents a Phase B re-run of rc5.

9. **(LOW)** Add a negative-case assertion to `am_agent_invoke` A2A-branch
   test (REV-3 noise-B) — replace the "not Unknown agent" negative check with
   a positive connect-refused assertion.

10. **(INFO)** Update ADR-0031 consequence section to acknowledge TUI is a
    fourth apply pipeline OR land the TUI collapse (item #3).

---

## References

- ADR-0031 (product scope and pillars) — esp. pillar 2 "Concurrency-safe" claim.
- ADR-0032 (terminology glossary) — Registry vs Marketplace, catalog vs native.
- ADR-0033 (ACP agent tiers) — the framework this review tests against.
- `docs/reviews/2026-04-17-iter4-system-critique/03-parallel-tool-calling.md`
  — the audit that prompted Wave B.
- `docs/reviews/2026-04-18-acp-shell-wrapper/REV-2-security.md` — security
  sibling review (same window).
- `docs/reviews/2026-04-18-acp-shell-wrapper/REV-3-test-ci.md` — test/CI
  sibling review (same window).
- `src/core/controller.ts` — the canonical controller this review measures
  against.
- `src/core/locks.ts` — the AsyncMutex implementation exercised by Wave B.
