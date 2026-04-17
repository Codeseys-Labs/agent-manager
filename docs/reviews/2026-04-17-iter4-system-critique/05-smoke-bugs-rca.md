# Smoke Bug RCA — agent-manager 0.5.0-rc1 (darwin-arm64)

Five live-smoke bugs found running the compiled `am` binary against a scratch
config directory. Each is root-caused below to a specific `file:line`, with a
proposed minimal fix (code sketch only — no implementation), the reason the
2313-test suite missed it, and trade-offs where multiple fixes are viable.

---

## Bug 1: `am run <agent> <prompt>` collision — citty treats `claude` as a subcommand

### Location
`src/commands/run.ts:368-413` — the `runCommand` definition.

```ts
export const runCommand = defineCommand({
  meta: { name: "run", ... },
  args: {
    agent:  { type: "positional", required: true },  // ← line 374
    prompt: { type: "positional" },                  // ← line 379
    ...
  },
  subCommands: {
    agents:  () => Promise.resolve(agentsSubcommand),   // ← line 411
    session: () => Promise.resolve(sessionSubcommand),  // ← line 412
  },
  async run({ args }) { /* ... */ },
});
```

### Cause
citty resolves subcommands **before** positional-arg binding. When the user runs
`am run claude "hello"`, citty inspects the first token (`claude`) against
`subCommands` keys (`agents`, `session`). Not a match — but instead of falling
through to the parent `run` handler, citty errors out with `Unknown command
claude.` whenever a command has any `subCommands` at all.

The citty contract is effectively: **"a command can have `args` (including
positionals) XOR `subCommands`, not both."** The current code violates that
contract. The root handler at line 414 is therefore unreachable for the
`<agent> <prompt>` positional form — which is the documented primary usage
(`src/commands/run.ts:5-8`).

Verified at `node_modules/citty/dist/index.mjs:390-395` — subcommand dispatch
happens in the outer argv-parse pass; positional binding only runs if no
subcommand key matches.

### Fix options

**A. Move to explicit `am run agent <name> <prompt>` subcommand.**
```ts
const runAgentSubcommand = defineCommand({
  meta: { name: "agent", description: "Run one prompt against an ACP agent" },
  args: { agent: positional required, prompt: positional required, ... },
  async run({ args }) { await runAgent({ ... }); },
});
// runCommand: only subCommands, NO positional args.
export const runCommand = defineCommand({
  meta: { name: "run", ... },
  subCommands: {
    agent:   () => Promise.resolve(runAgentSubcommand),
    agents:  ...,   // deprecated alias
    session: ...,
  },
  // no args.agent, args.prompt, no run() handler
});
```
- Pros: citty-clean. Discoverable via `am run --help`. Aligns with gh CLI style.
- Cons: breaking CLI surface change (`am run claude "hi"` → `am run agent claude "hi"`).
  ADR-0031 M2 has already flagged `am run agents` as deprecated — shuffling the
  top-level again will churn users.

**B. Remove `agents` subcommand, keep positional args, move `session` to top level.**
```ts
// delete `agentsSubcommand` entirely (it's already deprecated per ADR-0031 M2)
// delete `sessionSubcommand` from runCommand; move it to a top-level `am acp session ...`
export const runCommand = defineCommand({
  meta: { name: "run", ... },
  args: { agent, prompt, ... },
  // NO subCommands — positional form works
  async run({ args }) { ... },
});
```
- Pros: preserves the documented primary form (`am run claude "..."`). Deletes
  dead weight (deprecated `run agents`). Forces a clean separation between
  "one-shot agent run" and "live session management."
- Cons: needs a new home for `session list`/`session cancel`. Candidates:
  `am acp session list` (new top-level `acp` namespace) or fold into `am agent
  session list`. Both are reasonable but are new ADR territory.

**C. Keep both with a discriminator flag.**
```ts
// require --agent/-a flag instead of positional #1
args: { agent: { type: "string", alias: "a", required: true }, prompt: positional, ... }
```
- Pros: no restructuring. Users write `am run -a claude "hello"`.
- Cons: violates the ergonomics goal. The headline in the file comment is
  `am run claude "fix the failing tests"` — a flag makes that `am run -a claude
  "..."`. Losing the "just say the agent name" affordance defeats the
  purpose of a `run` verb.

### Recommendation
**Option B.** The `agents` subcommand is already formally deprecated; accelerate
its removal. Move `run session` to a top-level `am acp` group (or fold under
`am agent session ...`) so the primary `am run <agent> "<prompt>"` form — the
one in every doc example — works as documented. This also matches ADR-0031's
"canonical surface" stance: `am agent list` replaces `am run agents`, so `am
acp session list` parallel-structures the live-session management that `am
session` (transcripts) intentionally doesn't cover.

Estimated effort: 1–2h (delete `agentsSubcommand`, re-home `sessionSubcommand`,
update one ADR, update 4 test blocks in `test/commands/run.test.ts:189-245`,
update the doc comment at the top of `run.ts`).

### Test gap
`test/commands/run.test.ts:131-137` asserts `subCommands.agents` and
`subCommands.session` *exist* on the citty definition, and `test/commands/
run.test.ts:139-151` asserts the positional args are defined — but **no test
actually invokes citty's dispatch loop**. The tests verify the DSL shape of the
command, not its runtime behavior. A fix would be to add an integration test
that spawns the built binary (or calls `runMain(main, ...)`) with argv `["run",
"claude", "hi"]` and asserts the `runAgent` code path executes (not a
"Unknown command" error).

---

## Bug 2: `am run session list` requires `AGENT` positional — no cross-agent listing

### Location
`src/commands/run.ts:260-269` — `sessionListSubcommand`:

```ts
const sessionListSubcommand = defineCommand({
  meta: { name: "list", description: "List active ACP sessions for an agent" },
  args: {
    agent: { type: "positional", description: "Agent name", required: true },  // ← line 263
    cwd:   { type: "string", description: "Filter by working directory" },
    ...
  },
  ...
});
```

### Cause
The subcommand requires an agent positional because its implementation at
lines 271-283 resolves a single agent, connects to it over ACP, and calls
`client.listSessions(cwd)` — a *live* JSON-RPC call into one subprocess. There
is no "list sessions across every ACP agent" code path. The CLI shape reflects
that single-agent limitation, but the shape is visible to users who just want
a directory of active sessions.

This is a design gap, not a parsing bug: listing across agents requires either
(a) fanning out `connect + listSessions` to every registered agent, or (b)
reading persisted session state from disk (the MCP server already does this at
`src/mcp/server.ts:1964-1999` via `readdir(sessionDir)`).

### Fix options

**A. Make `agent` optional; when omitted, fan out across all agents.**
```ts
args: { agent: { type: "positional", required: false }, ... }
async run({ args }) {
  if (args.agent) { /* existing path */ return; }
  // New path: list all agents, connect to each, merge sessions.
  const agents = await listAllAgentsAsync(registryConfig, configDir);
  for (const a of agents.filter(a => a.acp)) {
    // connect + listSessions with short timeout, swallow failures
  }
}
```
- Pros: matches the user mental model ("show me all sessions").
- Cons: spawns N subprocesses; slow (seconds per agent); failure modes
  (agent not installed → subprocess exits) become noisy. Needs per-agent
  timeout + graceful degradation.

**B. Read from disk (session-dir) like MCP `am_acp_session_list` does.**
```ts
async run({ args }) {
  if (args.agent) { /* existing live path */ return; }
  // Read ~/.agent-manager/sessions/* directly, like src/mcp/server.ts:1964
  const sessions = await readdir(sessionDir);
  ...
}
```
- Pros: fast, no subprocesses. Consistent with MCP tool behavior.
- Cons: only sees persisted state; agents that don't persist (most don't
  today) won't show up. Creates two different definitions of "active
  session" depending on whether `--agent` is passed.

**C. Keep required, add a sibling command `am run session list-all` (or
  `am acp session list` as proposed in Bug 1).**
- Pros: explicit; no ambiguity about fan-out vs. single-agent.
- Cons: verbose; discoverability suffers.

### Recommendation
**Option A** for the UX win, but with a `--fast` flag that falls back to
**Option B**'s disk-only view for users who want snappy output. Keep `agent`
required when neither the fan-out nor the disk-read is possible (e.g., legacy
scripts can pass an explicit agent and get today's behavior unchanged).

Estimated effort: 2–3h including a per-agent 2s timeout and a clear "3 of 16
agents reachable" summary line.

### Test gap
`test/commands/run.test.ts:160-181` tests that `session` has `list` and
`cancel` subcommands — but doesn't invoke `run({ args: {} })` with no agent.
A single unit test that drives the `run()` callback with `args = { agent:
undefined }` would surface the "Missing required positional" error before
release. More importantly: **no CLI integration test** exercises
`am run session list`.

---

## Bug 3: MCP `serverInfo.version` hardcoded `"0.1.0"` (stale since ADR-0031)

### Location
`src/mcp/server.ts:2283-2286`:

```ts
serverInfo: {
  name: "agent-manager",
  version: "0.1.0",              // ← hardcoded
},
```

Also: `src/protocols/acp/client.ts:170` — `clientInfo: { ..., version: "0.1.0" }`
(same anti-pattern, adjacent file). Similarly `src/web/server.ts:136` and
`src/web/worker.ts:171`.

### Cause
ADR-0031 unified version reporting under `src/lib/version.ts` exporting
`AM_VERSION` (reading from compile-time `BUILD_VERSION` define). The `version`
CLI command at `src/commands/version.ts:12` already migrated. The MCP server
literal was missed during the migration — a classic "grep for the string that
moved, not the string that stayed" gap.

Because the `serverInfo.version` field is wire-visible (any MCP client — Claude
Code, Cursor, Codex — sees it during handshake), it is a user-observable lie:
the binary says it is `0.5.0-rc1` via `am --version`, but tells MCP clients
it's `0.1.0`.

### Fix
```ts
import { AM_VERSION } from "../lib/version";
// ...
serverInfo: {
  name: "agent-manager",
  version: AM_VERSION,
},
```

Also fix the sibling sites:
- `src/protocols/acp/client.ts:170`
- `src/web/server.ts:136`
- `src/web/worker.ts:171`

Estimated effort: 15 minutes, one import per file, plus updating the test
expectation at `test/mcp/server.test.ts:46` to assert the version field
matches `AM_VERSION` (not a literal `"0.1.0"`).

### Test gap
`test/mcp/server.test.ts:46` **asserted the wrong value as correct**:

```ts
expect(resp?.result).toMatchObject({
  protocolVersion: "2024-11-05",
  capabilities: { tools: {} },
  serverInfo: { name: "agent-manager", version: "0.1.0" },  // ← pins the bug
});
```

This is a classic "snapshot coverage rather than semantic coverage" failure:
the test was generated from the observed output and pinned the literal
instead of asserting the invariant "MCP serverInfo.version equals the binary's
advertised version." The correct assertion is `expect(resp.result.serverInfo
.version).toBe(AM_VERSION)`. Add a higher-level invariant test: "every
wire-level `version` field equals `AM_VERSION`" — a single test that imports
every server entry point and checks.

---

## Bug 4: `am agent list --json` omits `protocol` field

### Location
`src/commands/agents.ts:62-65`:

```ts
if (args.json) {
  output({ agents, ...(args.discover ? { discovered } : {}) }, opts);
  return;
}
```

The `agents` array here is the direct output of `listAllAgentsAsync` from
`src/core/agent-registry.ts:238`. Its return type `UnifiedAgent[]` at
`src/core/agent-registry.ts:19-25` is:

```ts
export interface UnifiedAgent {
  name: string;
  description?: string;
  source: "config" | "acp-builtin" | "a2a-roster";
  acp?: { command: string };
  a2a?: { url: string };
}
```

Note: **no `protocol` field**. The text table at line 78 computes it ad-hoc:
```ts
const protocol = agent.acp && agent.a2a ? "ACP/A2A" : agent.acp ? "ACP" : "A2A";
```

But this derivation is thrown away — only shown, not attached to the object.
The JSON branch dumps the raw `UnifiedAgent[]` with `acp` and `a2a` fields
but no resolved `protocol` string.

### Cause
The registry data model intentionally stores each protocol endpoint as an
optional sub-object (matching the TOML shape). The CLI text formatter
computes a human-readable summary. The JSON formatter skipped the derivation
step and emits the raw internal type directly. Compare the MCP server at
`src/mcp/server.ts:1949` which *does* derive the same protocol field for
wire output:

```ts
protocol: a.acp && a.a2a ? "both" : a.acp ? "acp" : "a2a",
```

Inconsistency: `am_acp_list_agents` (MCP) has it; `am agent list --json`
(CLI) does not.

### Fix
Two reasonable shapes. Both require mapping the agents array in the JSON
branch.

**A. Compute `protocol` only in the CLI formatter:**
```ts
if (args.json) {
  const enriched = agents.map(a => ({
    ...a,
    protocol: a.acp && a.a2a ? "both" : a.acp ? "acp" : "a2a",
  }));
  output({ agents: enriched, ...(args.discover ? { discovered } : {}) }, opts);
  return;
}
```

**B. Add `protocol` as a computed property on `UnifiedAgent` in the
   registry layer** — single source of truth, consistent with MCP:
```ts
// agent-registry.ts
export interface UnifiedAgent {
  ...
  protocol: "acp" | "a2a" | "both";  // derived at construction
}
```
Then the text table, JSON output, and MCP handler all read the same field.

### Recommendation
**Option B.** Putting the protocol as a first-class field in the registry
type eliminates three separate derivations (`src/commands/agents.ts:78`,
`src/commands/run.ts:247`, `src/mcp/server.ts:1949`) that all compute the
same thing with subtly different strings ("ACP/A2A" vs "ACP" vs "both"/"acp").
Use the MCP naming ("acp"/"a2a"/"both") as the canonical form; the CLI
formatter can uppercase for the table. One source of truth, no silent drift.

Estimated effort: 30 minutes. Add field to interface + 2 constructor sites in
`listAllAgents` at `src/core/agent-registry.ts:184-233`, update 3 consumers,
update tests.

### Test gap
There is no test that asserts `am agent list --json` output *shape*. Tests
likely assert data is present (count of agents) but not that `protocol` is
derivable by the consumer. Add:
```ts
const parsed = JSON.parse(stdout);
for (const a of parsed.agents) {
  expect(["acp", "a2a", "both"]).toContain(a.protocol);
}
```

---

## Bug 5: `am run --help` shows `v"0.5.0-rc1"` — literal quotes in version

### Location
`scripts/build.ts:97`:

```ts
`--define=process.env.BUILD_VERSION='"${version}"'`,
```

### Cause
The `--define` flag in `bun build --compile` substitutes its RHS as a **JS
expression**, not a string. The expression is then inlined verbatim at every
`process.env.BUILD_VERSION` reference in the compiled source.

Walk-through with `version = "0.5.0-rc1"`:

1. TS template-literal interpolation produces the argv string:
   `--define=process.env.BUILD_VERSION='"0.5.0-rc1"'`
2. Bun.spawn passes this as a single argv element (no shell involved; the
   outer single-quotes are literal characters, not shell quoting).
3. Bun's `--define` parser splits on `=`: key = `process.env.BUILD_VERSION`,
   value = `'"0.5.0-rc1"'`.
4. Bun evaluates the value as JS. `'"0.5.0-rc1"'` is a valid JS string
   literal — value is the 10-character string `"0.5.0-rc1"` (quotes
   included).
5. Every `process.env.BUILD_VERSION` reference in the bundle becomes that
   10-character string.
6. `src/lib/version.ts:9` then reads `AM_VERSION = process.env.BUILD_VERSION
   ?? "0.0.0-dev"` → `AM_VERSION === '"0.5.0-rc1"'` (with quotes).
7. `src/cli.ts:9` sets `meta.version = AM_VERSION`. citty at
   `node_modules/citty/dist/index.mjs:401` interpolates:
   `v${version}` → `v"0.5.0-rc1"`.

The outer single-quotes in the build flag were added for shell-safety copy-
paste, but this code path never sees a shell — `Bun.spawn` takes an argv
array. The quotes leak into the JS expression.

### Fix

**Smallest correct fix:**
```ts
`--define=process.env.BUILD_VERSION=${JSON.stringify(version)}`,
```

`JSON.stringify("0.5.0-rc1")` produces the string `"0.5.0-rc1"` with proper
escaping. Bun's `--define` evaluates that as a JS string literal. Result:
`AM_VERSION === "0.5.0-rc1"` (no extra quotes). Same fix applies to line 98
for `BUILD_TIME`.

Alternative (less robust):
```ts
`--define=process.env.BUILD_VERSION="${version}"`,
```
— works only if `version` contains no `"` or special JS chars. `JSON.stringify`
is the correct escape hatch.

Estimated effort: 5 minutes — two lines in `scripts/build.ts`.

### Test gap
`test/commands/version.test.ts:28` comments mention the default dev fallback
is `"0.0.0-dev"` but the test apparently validates the `am --version`
output which goes through `src/commands/version.ts:12` where `AM_VERSION` is
logged directly. Because `console.log('"0.5.0-rc1"')` would print `"0.5.0-rc1"`
*with* the quotes, this *is* visible — but likely no test asserts the version
string character set (e.g., `expect(version).not.toContain('"')`).

The CI version gate at `.github/workflows/ci.yml:97` checks `echo "$REPORTED"
| grep -q "$PKG_VERSION"` — `grep` matches a substring, so `v"0.5.0-rc1"`
matches `0.5.0-rc1` and the gate passes. A stricter regex (`^am v[0-9.]`)
would catch it.

**Separate issue found while investigating:** CI line 87 sets `VERSION=ci-test`
and line 95 sets `BUILD_VERSION="$PKG_VERSION"` — but `scripts/build.ts:3`
only reads `process.env.VERSION`. The second build in CI therefore gets
`version = "0.0.0-dev"` (fallback). Worth a separate fix.

---

## Test coverage gaps — why did 2313 tests miss these?

1. **Shape-only assertions, not behavior.** `test/commands/run.test.ts` asserts
   the DSL (which args, which subcommands, which descriptions) but never
   executes citty's dispatch loop with real argv. Unit tests of
   `defineCommand` objects cannot catch citty's "subcommand vs positional"
   collision — only running `runMain` or `parseArgs` on a full argv line
   does.

2. **Snapshot pinning of buggy values.** `test/mcp/server.test.ts:46` pinned
   the literal `"0.1.0"` that was already wrong. The test was generated from
   observed output, not from a semantic invariant. This pattern recurs wherever
   version strings are compared literally.

3. **Missing CLI integration tier.** The test pyramid jumps from unit tests of
   individual functions directly to (presumed) manual smoke tests. There is
   no "build the binary, spawn it, assert stdout/exit-code for 20 common
   invocations" layer. All five bugs here would be caught by a half-hour
   integration test harness.

4. **Format-specific gaps.** `am agent list --json` JSON output has no schema
   test. The text formatter is tested (visual inspection), the JSON formatter
   isn't. Every `--json` code path in every command deserves a shape
   assertion against a published schema (zod or JSON Schema).

5. **Wire-level invariants not tested.** Bug 3 (MCP serverInfo.version)
   and Bug 5 (help quote leak) would both be caught by a single "every place
   the binary advertises a version, the value equals `AM_VERSION`" invariant
   test. No such test exists.

6. **Build-time vs. runtime split.** `scripts/build.ts` is executed only in
   release/CI. No test asserts that the compiled binary's runtime `AM_VERSION`
   equals the `VERSION` env passed to the build. Add: spawn the built binary,
   run `--version`, compare byte-for-byte to the input.

---

## Recommended fix order (impact × effort)

| # | Bug | Impact | Effort | Rationale |
|---|-----|--------|--------|-----------|
| 1 | **Bug 3** (MCP serverInfo 0.1.0) | HIGH — wire-visible lie to every MCP client | 15 min | Trivial one-line change per site (4 sites). Fix first to restore version integrity across all surfaces. |
| 2 | **Bug 5** (quoted version in help) | HIGH — user-visible cosmetic, looks broken | 5 min | One-line `JSON.stringify` fix in `scripts/build.ts`. Do atomically with Bug 3 — both are "version reporting hygiene". |
| 3 | **Bug 1** (run `<agent>` collision) | CRITICAL — primary command fully broken | 1–2 h | Blocks the documented flagship verb. Prefer Option B (remove `agents`, move `session` under a new top-level). Requires a short ADR. |
| 4 | **Bug 4** (`--json` missing protocol) | MEDIUM — JSON consumers (scripts, agents) lose info silently | 30 min | Good moment to promote `protocol` to a first-class field on `UnifiedAgent` (Option B) and retire three duplicate derivations. |
| 5 | **Bug 2** (session list requires agent) | LOW-MEDIUM — workaround exists (pass agent); annoyance | 2–3 h | Not blocking. Bundle with Bug 1's restructure — if `session` migrates to `am acp session`, add fan-out as part of the same change. |

**Total effort estimate:** 4–6 hours including one small ADR for Bug 1 restructuring
and the CLI integration-test harness that would have caught Bugs 1, 2, 3, and 5.

**Suggested sequence:**
1. Ship Bugs 3 + 5 as one release-hygiene PR (20 min, no design churn).
2. Draft ADR-0032 proposing "move `am run {agents,session}` subcommands to
   `am agent` and a new `am acp` namespace; collapse `am run` to just
   `<agent> <prompt>`." Merge Bug 1 + Bug 2 restructure under that ADR.
3. Promote `protocol` to the `UnifiedAgent` type (Bug 4).
4. Backfill: add CLI-integration test tier that spawns the built binary and
   drives 20 argv permutations with stdout assertions.
