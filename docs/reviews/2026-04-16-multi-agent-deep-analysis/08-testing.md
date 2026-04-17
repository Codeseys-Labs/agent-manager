# 08 — Test Quality Audit

**Facet:** Test meaningfulness, assertion quality, critical-path coverage, flakiness, integration gaps
**Scope:** `test/` (151 `.test.ts` files, 36,618 LOC) + `.github/workflows/ci.yml`
**Date:** 2026-04-16

---

## Summary

The test suite is **large and mostly well-constructed**, but has a meaningful
tail of low-value tests. 1999 passing tests with 5876 `expect()` calls means
~2.94 assertions/test — on paper healthy. However, assertion *quality* is
uneven:

- **Strengths:** `test/mcp/server.test.ts` (1580 LOC, 269 asserts) and
  `test/protocols/a2a/server.test.ts` (1760 LOC, 171 asserts) are
  exemplary — real subprocess IPC, auth, SSE streaming, TTL eviction,
  concurrency guards (terminal-state overwrite), error paths. Schema tests
  (`core/schema.test.ts`), merge resolution, secret detection, and integration
  tests that `bun run src/cli.ts` in a subprocess all exercise real behavior.
- **Weaknesses:** A substantial fraction of `test/commands/*.test.ts` do NOT
  actually test the command under audit. They test the underlying primitives
  (`readConfig`, `loadResolvedConfig`, `revertHead`) the command uses, then
  claim the command is covered. CLI registration tests (`mod.fooCommand`
  exists, has expected sub-args) are tautological. One file
  (`test/adapters/community/types.test.ts`, 21 asserts) is 100% literal
  construction and echo-back — zero behavior tested.
- **Gaps:** No concurrency tests (multi-client SSE, parallel installs,
  parallel MCP tool calls). No test coverage for `src/commands/marketplace.ts`
  (299 LOC) or `src/commands/tui.ts` (10 LOC). `mock-adapter.ts` returns
  empty-array stubs for every method; the proxy tests are verifying the
  pipe, not the protocol.
- **No flaky indicators** — zero `setTimeout` in production-test code paths
  (only used as polling helper `waitForTask` with bounded timeout).
  Zero skipped/todo tests. No snapshots.

**Test-quality score (meaningfulness): 6.5 / 10**
(High for MCP, A2A, adapters, core; drags from command-layer & community-adapter tests.)

---

## Statistics

| Metric | Value |
|---|---|
| Total tests | 1,999 |
| Test files | 151 |
| Total `expect()` calls | 5,876 |
| Total test LOC | 36,618 |
| Avg assertions / test | 2.94 |
| Avg LOC / test file | 242 |
| Files with `toBeDefined()` (weak assertion signal) | 30 files / 175 occurrences |
| Files with `.toThrow()` / `rejects.toThrow` | 20 files / 46 occurrences |
| Skipped / todo tests | **0** |
| Snapshot tests | **0** |
| `setTimeout` in tests | 3 files (all bounded polling helpers; no sleeps) |
| Tests with `rmSync`/`mkdirSync`/`writeFileSync` (raw fs, possible leak) | 5 files |

**Biggest test files (by LOC):**

| File | LOC | `expect` |
|---|---|---|
| `test/protocols/a2a/server.test.ts` | 1760 | 171 |
| `test/mcp/server.test.ts` | 1580 | 269 |
| `test/protocols/acp/flows.test.ts` | 1123 | 154 |
| `test/protocols/a2a/client.test.ts` | 977 | 94 |
| `test/core/merge.test.ts` | 812 | 99 |
| `test/protocols/acp/client.test.ts` | 678 | 126 |
| `test/web/worker.test.ts` | 625 | 130 |
| `test/integration/wiki-pipeline.test.ts` | 624 | 79 |
| `test/core/config.test.ts` | 610 | 97 |

**Commands without a matching test file in `test/commands/`:**

- `src/commands/marketplace.ts` (299 LOC) — tests exist at
  `test/marketplace/{client,command,installer,scanner}.test.ts` but they
  exercise the module API, not the CLI registration/output.
- `src/commands/tui.ts` (10 LOC, pure loader — acceptable).

---

## Sampled Anti-Patterns

Ten files sampled across subsystems. Each finding cites `file:line` and
quotes the offending code.

### 1. `test/adapters/community/types.test.ts` — **tautological literal/echo** (21 asserts, zero value)

Every test constructs a literal object and asserts its fields equal the
literal values it was just assigned.

```ts
// types.test.ts:14-22
const config: CommunityAdapterConfig = {
  source: "npm:am-adapter-zed@0.2.0",
  command: "~/.config/agent-manager/adapters/zed/bin/adapter.js",
  installed_at: "2026-04-14T10:30:00Z",
};
expect(config.source).toBe("npm:am-adapter-zed@0.2.0");
expect(config.command).toContain("adapter.js");
expect(config.installed_at).toMatch(/^\d{4}-/);
```

**Why bad:** TypeScript already proves this at compile time. The test cannot
fail unless someone rewrites the test itself. 100% coverage-padding.
Recommendation: delete the whole file — type-level verification is already
enforced by `tsc --noEmit` in CI.

### 2. `test/adapters/community/proxy.test.ts` — **over-mocked / mock returns triviality** (proxy.test.ts:37-71)

The `mock-adapter.ts` stub returns `[]` for every RPC call:

```ts
// mock-adapter.ts:32-39
case "adapter/import":
  result = { servers: [], instructions: [], skills: [], warnings: [] };
case "adapter/export":
  result = { files: [], warnings: [] };
case "adapter/diff":
  result = { status: "in-sync", changes: [] };
```

And `proxy.test.ts` asserts those empties round-trip:

```ts
// proxy.test.ts:37-43
it("calls import() via async IPC", async () => {
  const result = await proxy.import({});
  expect(result.servers).toEqual([]);
  expect(result.instructions).toEqual([]);
  expect(result.skills).toEqual([]);
  expect(result.warnings).toEqual([]);
});
```

**Why bad:** This validates *that the IPC pipe carries bytes*, not that
the adapter protocol works with realistic input. No test verifies the
proxy handles: a manifest with servers/instructions, an adapter returning
warnings, large payloads, malformed JSON from subprocess stdout,
subprocess crash mid-request, stdin backpressure, or concurrent request
IDs. Community-adapter error paths are almost completely uncovered.

### 3. `test/commands/run.test.ts:91-118` — **mock-then-assert-on-mock**

```ts
test("expected result shape matches output contract", () => {
  const mockResult = {
    agent: "claude",
    sessionId: "session-abc-123",
    stopReason: "end_turn" as const,
    text: "I fixed the tests by updating the assertion.",
    toolCalls: [{ id: "tc-1", title: "...", status: "completed", kind: "edit" }],
    usage: null,
  };
  expect(mockResult.agent).toBe("claude");
  expect(mockResult.sessionId).toMatch(/^session-/);
  ...
});
```

**Why bad:** The literal is declared inline and asserted against its own
literal values. Nothing in `src/commands/run.ts` is exercised. This tests
the test author's ability to type JSON.

### 4. `test/commands/run.test.ts:123-158` — **CLI-registration tautology**

```ts
test("run command is registered in cli.ts", async () => {
  const mod = await import("../../src/commands/run");
  expect(mod.runCommand).toBeDefined();
});
test("run command has expected args", async () => {
  const args = mod.runCommand.args;
  expect(args!.agent).toBeDefined();
  expect(args!.prompt).toBeDefined();
  expect(args!.session).toBeDefined();
  ...
});
```

**Why bad:** The import succeeding and exporting a symbol proves
nothing about the command's behavior. The arg-shape assertions are
already guaranteed by the citty `ArgsDef` type check at build time.
This pattern is repeated in `flow.test.ts:25-120` (see below),
`serve.test.ts:5-18`, and others — roughly **8 command test files**
primarily test that the citty command exports exist.

### 5. `test/commands/flow.test.ts:44-47` — **same anti-pattern, explicit**

```ts
test("flow command is registered in cli.ts", async () => {
  const mod = await import("../../src/commands/flow");
  expect(mod.flowCommand).toBeDefined();
});
```

Literally just checks the import works. One expect.

### 6. `test/commands/undo.test.ts` — **testing primitives, not the command**

```ts
// undo.test.ts:16-45
test("undo creates a revert commit", async () => {
  ...
  await revertHead(configDir);  // calls git primitive
  const entries = await gitLog(configDir, 1);
  expect(entries[0].message).toContain("revert");
```

**Why bad:** Never imports `undoCommand` from `src/commands/undo.ts`.
Tests the git primitive directly. If `undoCommand.run()` stopped calling
`revertHead` (e.g., a refactor broke the wire-up), this test would still
pass. The MCP server test `am_undo reverts the last config change`
(`test/mcp/server.test.ts:531-579`) does test the behavior correctly —
it's the CLI command binding that is untested.

### 7. `test/commands/list.test.ts` — **testing `loadResolvedConfig`, not `list`**

```ts
// list.test.ts:46-58
const loaded = await loadResolvedConfig({ configDir, configFile: "config.toml" });
const servers = loaded.servers ?? {};
expect(entries.length).toBe(3);
```

Same pattern: the CLI command `listCommand` is never imported or invoked.
The "list servers" behavior (the command's output formatting, json vs
human-readable, filter flags, exit code) is entirely untested at the
command layer. Fortunately the CI `integration` job exercises
`./dist/am list servers --json` end-to-end.

### 8. `test/commands/profile.test.ts:36-42` — **same shape**

```ts
const loaded = await readConfig(join(configDir, "config.toml"));
const profiles = loaded.profiles ?? {};
expect(names).toContain("base");
```

Doesn't test `profileCommand` — tests `readConfig`.

### 9. `test/commands/adapter.test.ts` — **mislabeled**

File name says it tests `am adapter list`, but body tests the adapter
**registry**, not the CLI command:

```ts
// adapter.test.ts:4-16
describe("am adapter list", () => {
  test("lists all registered adapters", () => {
    const names = listAdapters();
    expect(names).toContain("claude-code");
```

`adapterCommand` is never imported. Same story.

### 10. `test/commands/version.test.ts:28` — **brittle hardcoded version**

```ts
test("version string includes semver format", async () => {
  ...
  expect(output).toContain("0.1.0");
});
```

**Why bad:** When `package.json` version bumps to `0.2.0`, this test
fails unrelated. The regex check one line above (`/\d+\.\d+\.\d+/`) is
the right pattern; the hardcoded string is a trap.

### 11. `test/commands/serve.test.ts:5-17` — **meta/arg-shape tests**

```ts
test("meta name is 'serve'", () => {
  expect(serveCommand.meta?.name).toBe("serve");
});
test("port arg exists with default '3456'", () => {
  expect(serveCommand.args?.port?.default).toBe("3456");
});
```

These are OK as *smoke tests* but three of the five tests never run
`serveCommand.run()`. The port-validation tests (lines 37-56) are good
and do exercise behavior.

### Summary count: 8 anti-pattern hotspots across 10 sampled files.

**Aggregate:** roughly **15–20 of 30 files in `test/commands/`**
follow the same "import primitive, test primitive, file is named after
command" shape. They are NOT worthless (the primitives need tests) but
they are miscategorized — they should live in `test/core/` or the
relevant subsystem, and `test/commands/` should test command handlers
(argument parsing, `--json` output structure, exit codes, error
formatting). Prior audit (iteration 13) flagged this; it is not yet
resolved.

---

## Coverage Gaps (by subsystem)

### MCP Server (`src/mcp/server.ts`, 1911 LOC)

**Covered (strong):**
- Tool registration, tier gating (read-only / write-local / write-remote),
  opt-in requirements
- `tools/list` group filtering (core, registry, wiki, a2a, session, acp)
- `am_list_servers`, `am_add_server`, `am_remove_server`, `am_server_update`,
  `am_doctor`, `am_undo`, `am_import`, `am_sync_push`
- Error response shape (`isError`, `hint` field)
- Session tool filter logic (roles, query, noTools, noSystem)
- ACP tool registration & tier

**Gaps:**
- **Subprocess/spawn failure** for `am_run_agent` — the write-remote tier
  gate is tested, but no test exercises the agent subprocess failing to
  start, crashing mid-turn, or producing invalid ACP JSON.
- **Concurrent tool calls** — no test issues two `tools/call` in flight
  against the same server instance.
- **`am_wiki_*` handlers** — group membership tested, but handler behavior
  (search, add, synthesize, briefing, harvest) for MCP transport is not
  directly exercised; relies on wiki-module tests for behavioral coverage.
- **Transport-level framing** — `server.ts` has 21 `throw` sites; only
  the handful that surface as JSON-RPC errors are verified.

### A2A Protocol (`src/protocols/a2a/server.ts`, 735 LOC)

**Covered (strong):** agent card, `tasks/send`, `tasks/get` with
`historyLength`, `tasks/cancel`, SSE `tasks/sendSubscribe` (status,
artifact, failure events), bearer-token auth, `safeTokenCompare`
timing-safe check, TTL eviction (old + within-TTL + working-state),
MAX_HISTORY_PER_TASK cap, task-store isolation across app instances,
malformed JSON, missing jsonrpc/method, cancel-while-working guard.

**Gaps:**
- **Multi-client SSE on same task** — no test subscribes two clients and
  verifies both receive events. The `TaskEventEmitter` tests only cover
  single-listener add/remove.
- **SSE client disconnect mid-stream** — no test verifies listener
  cleanup when the client closes the connection before terminal state.
- **Auth token rotation** — `auth_token` is fixed; no test for
  hot-reload or `null → set` transitions.
- **SSE idle timeout** — the constant is exported and asserted
  (`SSE_IDLE_TIMEOUT_MS === 5 * 60 * 1000`), but no test actually waits
  the timeout or injects a short timeout for verification
  (`server.test.ts:1700-1758` explicitly acknowledges "we verify the
  exported constant" as a workaround).

### Community Adapter Proxy (`src/adapters/community/proxy.ts`)

**Gaps (significant):**
- `mock-adapter.ts` returns empty arrays for every method — the protocol
  is never exercised with realistic data.
- No test for: adapter subprocess crash after initialize, stdout chunking
  (partial JSON), stderr channel contents, concurrent requests with
  overlapping IDs, large payloads (>1MB), `adapter/schema` returning
  something non-trivial, `minAmVersion` enforcement, checksum verification
  failures end-to-end (the warning appears in test output but no
  assertion on the code path).

### Command Layer (`src/commands/*.ts`)

**Gaps:** As documented above in the anti-pattern section, approximately
half of the "command" tests don't exercise the command handlers. Things
not tested at the handler level:
- `--json` output shape (only a handful of commands verify this; many
  do not)
- Exit codes on partial failure (e.g., `am import` when 1 of 3 adapters
  fails)
- Flag combinations (`--json --quiet`, `--verbose --json`, conflicting
  flags)
- Stdin/piped-input handling
- Ctrl-C / signal handling

Mitigation: CI's `integration` job does exercise many flags against the
compiled binary, closing some of this gap for the critical paths
(init, import, list, add, status, completion, undo).

### Marketplace

**Covered:** `client.ts`, `scanner.ts`, `installer.ts` (plugin apply,
install, uninstall with provenance, adapter registration).

**Gaps:**
- No test for `src/commands/marketplace.ts` (299 LOC) — CLI
  orchestration, search formatting, interactive confirm prompts, JSON
  output shape.
- No test for **concurrent `installPlugin` calls** against the same config
  file — race on `writeConfig` / `adapters.toml`.
- No test for **partial-failure rollback** — install fails after writing
  config but before writing `adapters.toml`.
- No test for **checksum mismatch handling** in full install flow (only
  the loader warning is emitted; no assertion on refused install).

### Web (`src/web/server.ts`, `src/web/worker.ts`)

**Covered:** routes, auth, multi-provider (github, gitlab, codeberg,
gitea).

**Gaps:** no tests exercise WebSocket/SSE endpoints if any exist,
session expiry, CSRF handling (if any).

### Wiki / Knowledge Base

**Covered:** storage, graph, harvester, synthesizer, NER, storage roundtrip.

**Gaps:** `harvester.test.ts` has only 12 asserts — light. No end-to-end
test of `wiki harvest` picking up live session data.

---

## Integration Test Gaps

CI `integration` job (`.github/workflows/ci.yml:76-204`) seeds IDE
configs and runs `./dist/am-linux-x64` through a fixed script. It covers:

**Covered end-to-end:**
- `version`, `--help` (grouped), `init --yes`, `doctor`, `import claude-code`
  (global + project .mcp.json merge), `list servers --json` + tag check,
  `add server` + list round-trip, `add instruction`, `list
  instructions/skills/agents/profiles`, `status --json`, `completion
  {bash,zsh,fish}`, `marketplace list`, `flow list`, `adapter list`,
  `undo --json`.

**NOT covered end-to-end by CI integration:**

1. **`am apply`** — the core export pipeline that writes configs to
   real adapter paths. Only dry-run inside MCP test
   (`mcp/server.test.ts:632-649`). A bug that corrupts every adapter's
   config on apply would slip past CI.
2. **`am push` / `am pull`** — git sync with remote. `sync-push` is
   tested for opt-in rejection in MCP but never actually pushes to a
   remote in integration.
3. **`am run <agent>`** — ACP subprocess spawning. No integration test
   invokes the real ACP flow.
4. **`am mcp-serve` and `am serve`** — the servers themselves are not
   started and queried by CI. Unit tests exercise their handlers, but
   nothing proves the binary-started process binds a port and responds.
5. **`am wiki` pipeline** — no harvest → synthesize → search loop in
   integration. `test/integration/wiki-pipeline.test.ts` covers this
   inside Bun but not against the compiled binary.
6. **`am marketplace install <plugin>`** and `am marketplace uninstall` —
   `marketplace list` is tested but install/uninstall are not. Plugin
   manifest errors in a fresh install could ship broken.
7. **`am install` / `am uninstall` (registry package installs)** — not
   run against the binary in CI.
8. **`am search`** — not exercised by CI integration.
9. **`am session` subcommands** — not exercised by CI.
10. **`am secret`** — secrets flow entirely absent from CI integration;
    only unit-tested.
11. **`am config set / get`** — `config show` isn't run; writes untested
    against binary.
12. **Cross-platform parity** — `build-verify` matrix runs on
    macOS/Ubuntu/Windows but only runs `bun test` (not the integration
    flow). The integration job is Ubuntu-only.

**Concurrency in integration:** zero. The script runs commands
sequentially. A real user may run `am apply` in one terminal while
`am push` runs in another — neither conflict detection nor file-locking
has an integration test.

---

## Flakiness Risks

**None observed in test output** (1999 pass, 0 fail, 51s). That said,
several latent flake sources exist:

1. **`waitForTask` polling** (`test/protocols/a2a/server.test.ts:61-70`,
   `test/protocols/bridge.test.ts:57-70`): 10ms poll with 2–10s
   timeout. Under CI load, 2s can be tight for eviction tests that
   create 1005 tasks. Set to 10s specifically for the eviction test
   (line 714) — if GC pauses cause a miss, this will flake.

2. **`test/commands/init-project.test.ts`** — the `bun test --dry-run`
   output at the head of this audit shows this file *raising* an
   error during discovery:
   ```
   test/commands/init-project.test.ts:
   error: Already initialized. .agent-manager.toml exists at /var/folders/vm/.../my-app/.agent-manager.toml
   ```
   This implies a previous test run left a tmpdir file (or two
   describe blocks share the same dir). Not a flake yet because a
   different test variant covers the path, but the pre-test error is
   a warning sign. The test passes, but this message during `--dry-run`
   suggests a side-effect leaking from another test.

3. **`test/adapters/community/loader.test.ts`** — `--dry-run` also
   emits warnings about checksum mismatches and missing checksums.
   These are intentional test fixtures, but the warnings suggest the
   loader writes to stderr during normal tests; noise that can mask
   real failures.

4. **`test/protocols/a2a/server.test.ts:693-718`** — creates 1005 tasks
   in sequence with `waitForTask` at 10s. On a slow runner this is
   right on the edge. Also, each `tasks/send` call is sequential; a
   small delay per request × 1005 could approach 30s total.

5. **Raw `fs` sync writes in 5 files** (`test/wiki/storage.test.ts`,
   `test/integration/*`, `test/core/{config,instructions}.test.ts`):
   these use `writeFileSync`/`rmSync` inside tmpdirs. Cleanups appear
   correct via `afterEach`, but any `beforeAll`/`beforeEach` writing
   outside a tmpdir would leak. Spot-checked samples — looks clean.

6. **No `process.env` isolation helper** — many tests set and restore
   `AM_CONFIG_DIR` manually with `beforeEach`/`afterEach`. If a test
   throws before `afterEach`, the env var leaks into the next test.
   This is a latent cross-test contamination source but has not
   manifested.

**Net:** flakiness posture is good right now, but the 1005-task
eviction test and the init-project stale-dir warning are watchlist items.

---

## Recommendations (prioritized)

### P0 — Action now (high leverage, low risk)

1. **Delete `test/adapters/community/types.test.ts`** (21 asserts, zero
   behavior value). TypeScript already proves everything this file
   claims. -136 LOC, -7 tests; no coverage loss because there was no
   coverage to begin with. Or: rewrite it to exercise `parsePluginManifest`,
   `parseAdaptersToml`, schema validation errors.

2. **Replace `test/adapters/community/mock-adapter.ts` with a real
   protocol participant.** It should at minimum:
   - Return non-empty `servers`/`instructions` for `adapter/import`
     (so round-trip assertions mean something)
   - Emit warnings
   - Have a flag to simulate crash mid-request
   - Have a flag to produce malformed JSON
   Add proxy.test.ts cases: `crashDuringImport`, `malformedStdout`,
   `concurrentRequests`.

3. **Rename / relocate misleading "command" tests.** Files like
   `test/commands/{list,profile,adapter,undo}.test.ts` that test
   primitives, not commands, should either:
   - Be moved to `test/core/` / `test/adapters/registry.test.ts`
     (where they test their actual target), OR
   - Be extended to actually invoke the citty `command.run({ args })`
     handler and assert on stdout/exit code/JSON output.

   Good model: `test/commands/version.test.ts`, `test/commands/serve.test.ts`
   port-validation tests, `test/commands/init-project.test.ts`, and
   `test/integration/lifecycle.test.ts` all show what a true
   command-handler test looks like.

4. **Fix hardcoded version** (`test/commands/version.test.ts:28`) — use
   the regex-only assertion; drop the `0.1.0` literal.

### P1 — This sprint (medium leverage)

5. **Add integration coverage for `am apply`** (highest-risk untested
   workflow — it writes every configured adapter's config files to
   disk). Build the binary in CI and run:
   ```
   ./dist/am-linux-x64 apply --dry-run --json > out.json
   # assert writes include claude-code/cursor/copilot/windsurf paths
   ./dist/am-linux-x64 apply --yes
   # assert the expected files exist with expected content
   ```

6. **Add integration coverage for `marketplace install` + `uninstall`**
   — given the 299 LOC command with no test, and a live marketplace
   (could be a fixture path in the repo), this is a likely source of
   regressions.

7. **Add multi-client SSE test** for A2A `tasks/sendSubscribe`: two
   concurrent subscribers to the same task ID, both must see all
   status+artifact events in order. Covers `TaskEventEmitter.emit`
   against multiple listeners — currently only unit-tested with a
   single listener.

8. **Add concurrent write test for marketplace installer** — two
   `installPlugin()` calls against the same config file. Verify
   neither corrupts `adapters.toml`. If a lock doesn't exist, this
   test will demonstrate the bug.

9. **Integration test `am run <agent>`** with a stub ACP agent. The
   stub can live in `test/fixtures/stub-acp-agent.ts`. This closes
   the biggest subprocess-spawn gap.

### P2 — Next quarter (systemic)

10. **Adopt a `command-testing` helper** under `test/helpers/` that
    invokes `command.run({ args })` with a captured stdout/stderr/exitCode,
    so all 30 command-test files can use the same shape. This
    systematizes command-handler testing and makes misclassified tests
    easy to spot.

11. **Add an SSE idle-timeout test** with an injected short timeout
    (e.g., `createA2ARoutes({ sseIdleTimeoutMs: 50 })`) — currently the
    test acknowledges it can't verify the 5-minute value and just
    asserts the constant. This is a coverage illusion.

12. **Add a `--ci --concurrent` mode** to the integration job that
    runs a selection of commands in parallel to flush out
    file-lock / race issues early.

13. **Enforce a min-assertion-per-test lint rule** — e.g., `3+ expect`
    per `test()` or `it()` block, warning-only to start. The current
    avg of 2.94 hides the long tail of 1-assert CLI-registration tests.

14. **Guard against `AM_CONFIG_DIR` leakage** with a global
    `beforeEach` in a shared setup file that snapshots and restores
    the env.

15. **Consider integrating coverage threshold**. CI runs
    `bun test --coverage` but doesn't fail on a threshold. Setting a
    minimum (e.g., 75% branch coverage on `src/mcp/server.ts`,
    `src/protocols/a2a/server.ts`) would catch regressions like a
    new error branch introduced without a test.

---

## Appendix — Sampled files

1. `test/adapters/community/proxy.test.ts` — 92 LOC, 7 tests, 20
   expects; anti-pattern: trivial mock.
2. `test/adapters/community/mock-adapter.ts` — not a test, but the
   fixture that makes (1) hollow.
3. `test/adapters/community/types.test.ts` — 136 LOC, 7 tests, 21
   expects; anti-pattern: 100% tautological.
4. `test/mcp/server.test.ts` — 1580 LOC, ~80 tests, 269 expects;
   **exemplary**.
5. `test/protocols/a2a/server.test.ts` — 1760 LOC, ~60 tests, 171
   expects; **exemplary**, minor gaps (multi-client SSE).
6. `test/commands/version.test.ts` — 30 LOC, 2 tests, 3 expects;
   partially good, one brittle assertion.
7. `test/commands/help.test.ts` — 114 LOC, 9 tests, 15 expects; good
   (tests `renderGroupedHelp`).
8. `test/commands/init-project.test.ts` — 241 LOC, 7 tests, 24 expects;
   **good**, tests real behavior.
9. `test/commands/run.test.ts` — 172 LOC, mixed; 5 out of ~13 tests
   are anti-pattern.
10. `test/commands/flow.test.ts` — 120+ LOC sampled; ~8 of 10 tests
    are CLI-registration shape checks.
11. `test/commands/list.test.ts` / `profile.test.ts` / `adapter.test.ts`
    / `undo.test.ts` — miscategorized: they test primitives, not
    commands.
12. `test/commands/serve.test.ts` — mixed: meta-tests weak, port
    validation good.
13. `test/marketplace/installer.test.ts` — 481 LOC, excellent coverage
    of plugin install/uninstall.
14. `test/adapters/amazon-q/detect.test.ts` — compact (55 LOC), good
    behavior coverage.
15. `test/adapters/copilot/export.test.ts` — good, tests the
    `servers` key vs `mcpServers` concern directly.
16. `test/integration/lifecycle.test.ts` — spawns the CLI as a
    subprocess; this is the right pattern for command tests.
17. `test/web/server.test.ts` / `test/web/worker.test.ts` — cover
    routes; good.

---

*End of audit.*
