# REV-3 — Test Coverage and CI Health

**Date:** 2026-04-18
**Scope:** agent-manager iter1-iter4 + rc1-rc5 — post-iter4 test quality audit,
shim-wrapper test plan for Phase B (IMPL-B), Windows gap analysis, deep-probe design
for Tier-1 ACP agents, and release-pipeline guards.

## Summary

**Test quality score: 7.5/10.**

- Strong fundamentals: the iter4-added AsyncMutex and MCP concurrency tests exercise
  real serialization via `Promise.all` on the actual `McpServer.handleRequest` surface
  (not mocks). FIFO-fairness, lock-poison, and cross-key independence are all proven
  against real behaviour — not against the mock scaffold.
- Anti-pattern from iter2 (mock-then-assert-on-mock) has been largely cleaned up.
  `agent-detection` uses a clean `__setWhichFn` dependency-injection seam; the
  assertions then run real code against the injected seam. This is the right shape.
- Meaningful weaknesses: (1) no test would catch the rc5 `FileSink` cast regression,
  (2) the integration suite is one file of 443 LOC covering ~40% of golden paths,
  (3) Tier-1 ACP deep-probe is entirely absent (ADR-0033 Phase A commitment unmet),
  (4) Windows 342 failures are largely real POSIX-hardcoding, not environmental noise,
  (5) release workflow has zero post-artifact smoke — the Bun 1.3.12 macho regression
  was caught manually.

The sample looks good, but the three gaps (FileSink, Tier-1 probe, Windows paths)
pull the score from a 9 down to 7.5. Land Phase B with a failing-before test for the
wrapper, and add a deep-probe fixture test, and this becomes a 9.

## Recent anti-patterns sampled

Ten files sampled (AsyncMutex + MCP concurrency + agent-invoke + agent-detection).
All file:line citations relative to repo root.

### Signal (tests worth keeping, doing the right thing)

| # | Test | File:Line | Verdict | Why it's good |
|---|---|---|---|---|
| 1 | `AsyncMutex — serializes concurrent callers` | `test/core/locks.test.ts:19-44` | SIGNAL | Uses three real workers with `setTimeout`-based delays, asserts **the actual interleaving pattern** (enter/exit pair must be adjacent). Detects actual non-serialization regressions, not just "the mock was called." |
| 2 | `AsyncMutex — FIFO fairness` | `test/core/locks.test.ts:46-76` | SIGNAL | Holds the lock via a deferred promise, enqueues three waiters with micro-yields so queue ordering is deterministic, asserts `[0,1,2,3]`. Would catch a LIFO regression. |
| 3 | `AsyncMutex — releases lock on throw` | `test/core/locks.test.ts:78-91` | SIGNAL | Proves the mutex is not poisoned by a throwing callback. Asserts `isHeld=false` and `waiting=0` after the recovery call. Three independent assertions; no mocking. |
| 4 | `KeyedMutex — different keys run concurrently` | `test/core/locks.test.ts:101-134` | SIGNAL | Uses dual deferred gates to prove keys `a` and `b` both reach `enter` without either blocking the other. If the keyed mutex were global, this test hangs (timeout). |
| 5 | `MCP concurrency — 2x am_add_server` | `test/mcp/concurrency.test.ts:62-78` | SIGNAL | End-to-end: uses real `McpServer.handleRequest` via `Promise.all`, reads the TOML from disk, asserts both writes survived. Comment (line 11-15) documents that running this against HEAD^^ actually fails — meaning the test was **first written to fail**, then verified against the fix. TDD proof. |
| 6 | `MCP concurrency — batch writers, 3 servers` | `test/mcp/concurrency.test.ts:131-166` | SIGNAL | Exercises `server.handleBatch(...)` (the real protocol-layer batcher), verifies all three config writes land. Catches the "last write wins" regression if the withConfig mutex is removed. |
| 7 | `am_agent_invoke routes to ACP branch` | `test/mcp/agent-invoke.test.ts:89-115` | SIGNAL (with caveat) | Clever trick: when `amazon-q` isn't installed, the error's **shape** (not "Unknown agent") proves the router chose the ACP branch. Caveat: the assertion is "error message doesn't match /Unknown agent/i", which is a negative check — could pass if error is empty. Could be stronger with a specific spawn-error message check. |
| 8 | `am_agent_session_cancel calls cancel RPC` | `test/mcp/agent-invoke.test.ts:139-193` | SIGNAL | Registers a mock client with a spy `cancel(sid)` method, proves the real handler **invokes the cancel RPC before rm** — the exact R6 bug. Asserts `calls` array + `content.cancelled === true` + dir removed + session unregistered. Four independent assertions on four observable effects. Excellent TDD-for-bug-fix. |
| 9 | `detectAgentByPath caches results` | `test/core/agent-detection.test.ts:69-82` | SIGNAL | Mocks `which` with a call counter, asserts count is `1` after two calls. The seam (`__setWhichFn`) is injected for test but exercised for real by the production code path. |
| 10 | `detectAllAgents prefers PATH over adapter` | `test/core/agent-detection.test.ts:121-128` | SIGNAL | Asserts priority ordering with real dispatch. Would catch a regression where adapter results override PATH hits. |

### Minor noise (caveats, not anti-patterns)

| # | Test | File:Line | Concern |
|---|---|---|---|
| A | `am_agent_invoke routes to A2A` | `test/mcp/agent-invoke.test.ts:117-136` | Same negative-check structure as #7. Relies on "error does not contain 'Unknown agent'" — could pass on empty error or network error. Consider asserting error matches `/connect|refused|ECONNREFUSED|fetch/i` to positively pin the A2A branch. |
| B | `progressToken monkeypatch` | `test/mcp/agent-invoke.test.ts:298-350` | Test swaps a real tool's handler mid-flight to a synthetic one that calls `ctx.emitProgress`. Works but brittle if any other test runs in parallel and observes the swapped handler. Uses `try/finally` to restore — OK, but an alternative would be to add a dedicated `am_test_emit_progress` tool under a test flag. |
| C | `adapters are invoked but not blocking` | `test/commands/agent-detect.test.ts:128-149` | The assertion at line 146-147 is `expect(typeof d.installed).toBe("boolean")` — a type-shape check, not a value check. This test is protective against "adapter errors out and throws" but doesn't prove the output is correct. Comment on line 142-143 acknowledges it. |

### No anti-patterns found

Nothing in the ten-file sample reproduces the iter2 "mock-then-assert-on-mock"
pattern. The iter4 tests land on the healthy side: inject a real seam, exercise real
code, observe real effects.

**One request for IMPL-B and beyond:** the existing pattern of writing a failing-first
assertion (see `concurrency.test.ts:11-15` — "run against HEAD^^ to verify it fails")
is the gold standard. The Phase B shim-wrapper tests must include a failing-before
run recorded in the commit message or review log.

## Shim-wrapper test plan (for IMPL-B)

Phase B lands `src/protocols/acp/shell-wrapper.ts` and a `ShimConfig` adapter.
Tests MUST cover the six surfaces below. File location: `test/protocols/acp/shell-wrapper.test.ts`.

### 1. Happy path — one-shot chunk + stop (MUST land)

**Scenario:** Wrap a mock CLI (`/bin/echo` or a tiny bash fixture) that echoes the
prompt to stdout. Drive ACP initialize → session/new → session/prompt. Assert
exactly one `agent_message_chunk` arrives with the echoed text, followed by one
`stop` with `stopReason: "end_turn"`.

```ts
test("shim wrapper emits one chunk + one stop for a successful one-shot", async () => {
  const shim = new ShellWrapper({
    command: ["/bin/bash", "-c", "cat - && echo done"],
    promptTemplate: "{prompt}",
    responseExtractor: "stdout",
  });
  const updates: SessionUpdate[] = [];
  shim.onSessionUpdate((u) => updates.push(u));

  await shim.initialize();
  const sid = await shim.newSession({ cwd: process.cwd() });
  const result = await shim.prompt(sid, [{ text: "hello" }]);

  const chunks = updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
  expect(chunks).toHaveLength(1);
  expect((chunks[0] as any).content.text).toContain("hello");
  expect(result.stopReason).toBe("end_turn");
});
```

**Why this test:** proves the wrapper is spec-legal (the "zero intermediate updates"
allowance from ACP `protocol/prompt-turn.md`). Would catch a regression where the
wrapper emits two chunks or forgets the stop.

### 2. Failure path — wrapped command exits non-zero (MUST land)

**Scenario:** Wrap a command that exits with code 1 (`/bin/bash -c 'echo err >&2; exit 1'`).
Assert an ACP error is emitted (session/error or stopReason: "error") and the
error message surfaces the wrapped stderr.

```ts
test("shim wrapper emits an error when the wrapped command fails", async () => {
  const shim = new ShellWrapper({
    command: ["/bin/bash", "-c", "echo oops 1>&2; exit 1"],
    responseExtractor: "stdout",
  });
  await shim.initialize();
  const sid = await shim.newSession({ cwd: process.cwd() });
  const result = await shim.prompt(sid, [{ text: "trigger" }]);
  expect(result.stopReason).toBe("error");
  // Stderr MUST be observable in the emitted diagnostic.
  expect(result.error).toContain("oops");
});
```

### 3. Security — sensitive env vars don't leak (MUST land)

**Scenario:** Wrap a command that dumps its env (`/bin/bash -c 'env'`). Set
`AWS_ACCESS_KEY_ID`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` in the parent process.
Assert those values are **not** present in the captured output unless explicitly
allowlisted in `ShimConfig.env`.

```ts
test("shim does not leak parent-process secrets by default", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-leak-canary-XYZ";
  const shim = new ShellWrapper({
    command: ["/bin/bash", "-c", "env"],
    responseExtractor: "stdout",
    // default env policy: allowlist only
  });
  const sid = await shim.newSession({ cwd: process.cwd() });
  const result = await shim.prompt(sid, [{ text: "x" }]);
  expect(result.text).not.toContain("sk-leak-canary-XYZ");
  expect(result.text).not.toContain("ANTHROPIC_API_KEY");
});
```

**Rationale:** iter4 R6 flagged that `Bun.spawn({ env: { ...process.env } })` leaks
EVERY parent env var into the child. For shim wrappers running third-party CLIs,
this is a supply-chain risk (the wrapped agent could exfil API keys). The default
MUST be an allowlist; this test pins that contract.

### 4. Streaming — exactly one chunk, exactly one stop (MUST land)

**Scenario:** Wrap a command producing multi-line stdout. Assert the wrapper
produces exactly one `agent_message_chunk` (buffered) and exactly one `stop`,
per ADR-0033's explicit decision to batch output. A future "streaming wrapper"
variant would change this contract, but Tier-2 v1 is buffered.

```ts
test("multi-line stdout is delivered as a single chunk", async () => {
  const shim = new ShellWrapper({
    command: ["/bin/bash", "-c", "printf 'line1\\nline2\\nline3\\n'"],
    responseExtractor: "stdout",
  });
  const updates: SessionUpdate[] = [];
  shim.onSessionUpdate((u) => updates.push(u));
  const sid = await shim.newSession({ cwd: process.cwd() });
  await shim.prompt(sid, [{ text: "x" }]);
  const chunks = updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
  expect(chunks).toHaveLength(1);
  expect((chunks[0] as any).content.text).toBe("line1\nline2\nline3\n");
});
```

### 5. Timeout — hanging wrapped command is killed (MUST land)

**Scenario:** Wrap a command that sleeps forever (`/bin/bash -c 'sleep 60'`).
Configure `ShimConfig.timeoutMs = 500`. Assert the prompt returns with
`stopReason: "error"` within ~1s (not 60s), AND the subprocess is actually reaped
(use `ps` or check `.exited` resolved with a signal).

```ts
test("shim kills a hanging wrapped command after timeoutMs", async () => {
  const shim = new ShellWrapper({
    command: ["/bin/bash", "-c", "sleep 60"],
    responseExtractor: "stdout",
    timeoutMs: 500,
  });
  const sid = await shim.newSession({ cwd: process.cwd() });
  const t0 = Date.now();
  const result = await shim.prompt(sid, [{ text: "x" }]);
  const dt = Date.now() - t0;
  expect(dt).toBeLessThan(2000); // killed within 4x budget
  expect(result.stopReason).toBe("error");
  expect(result.error).toMatch(/timeout|killed/i);
});
```

**Rationale:** This is the "zombie process prevention" contract. Missing this test
means a hanging aider/q invocation will orphan a subprocess indefinitely.

### 6. Cancellation — session/cancel actually kills the subprocess (MUST land)

**Scenario:** Start a long-running wrapped command (`sleep 30`), call
`shim.cancel(sessionId)` after 100ms, assert the subprocess exits with SIGTERM
and the prompt returns with `stopReason: "cancelled"`.

```ts
test("session/cancel kills the wrapped subprocess", async () => {
  const shim = new ShellWrapper({
    command: ["/bin/bash", "-c", "sleep 30"],
    responseExtractor: "stdout",
  });
  const sid = await shim.newSession({ cwd: process.cwd() });
  const promptP = shim.prompt(sid, [{ text: "x" }]);
  await new Promise((r) => setTimeout(r, 100));
  await shim.cancel(sid);
  const result = await promptP;
  expect(result.stopReason).toBe("cancelled");
});
```

### 7. Session isolation — concurrent sessions don't share subprocess state (SHOULD land)

**Scenario:** Call `newSession` twice to get two sids, fire `prompt(sid1)` and
`prompt(sid2)` in parallel, assert their outputs do not cross-contaminate.

### 8. Registry integration (SHOULD land)

**Scenario:** Register a shim in `BUILT_IN_SHIMS` (e.g. `aider`), call
`resolveAgent("aider", {})` from the agent-registry, assert the returned command
is the shim wrapper + aider template (not raw `aider --acp`).

### 9. Security — `--yes` warning shown (SHOULD land)

**Scenario:** A shim config with `--yes` in its command MUST print a warning on
connect (per ADR-0033 security posture). Assert stderr contains "inherits trust
posture" message.

### 10. Loading — pinned version vs @latest (NICE-TO-HAVE)

**Scenario:** For shims that wrap npx targets (unlikely in v1 but possible),
assert the command prefers pinned versions.

## Windows gap: fixable or permanent-xfail?

**Verdict: mostly fixable POSIX-hardcoding, ~30-50 of 342 are genuinely
Windows-hostile.**

### Spot checks

Grep results flagged 32 `/tmp/`, `~/`, or POSIX-separator occurrences across 30
test files. Representative samples:

1. **`test/integration/lifecycle.test.ts:276-317`** — "am apply writes native
   config files (not dry-run)" uses `const fakeHome = join(testDir.path, "fakehome")`.
   The `join()` is fine, BUT the subprocess env `HOME: fakeHome` is a POSIX
   convention. On Windows the equivalent is `USERPROFILE`. **Fix:** set both
   `HOME` and `USERPROFILE` in the env. Low effort, ~10 sites.

2. **`test/adapters/community/loader-checksum.test.ts:90`** — hard-writes a
   `#!/bin/sh` binary and chmods it executable, then tries to spawn it. On
   Windows there's no shebang support. **Fix:** either skip on Windows via
   `describe.skipIf(process.platform === "win32", ...)` or use a `.bat` file.
   Medium effort, ~5 sites.

3. **`test/core/config.test.ts:31`** — `process.env.AM_CONFIG_DIR = "/tmp/custom-am"`.
   Assertion is `expect(resolveConfigDir()).toBe("/tmp/custom-am")`. This is a
   string-equality test that ignores platform. **Fix:** use `tmpdir()` from
   `node:os` and stop hardcoding `/tmp`. Low effort, ~15 sites.

4. **`test/mcp/session-cancel-traversal.test.ts:57-99`** — path-traversal tests
   hardcoded `/tmp/sessions` as the base. Fair for a unit test (the function
   doesn't need the path to exist), but the assertion on line 66
   `resolveSessionPathSafely("/tmp/sessions", "a\\b")).toThrow()` only tests
   the separator is rejected. On Windows this would throw regardless because
   `\\` is the native separator. **Fix:** parameterize with `path.posix` / `path.win32`.
   Medium effort.

5. **`test/core/key-path.test.ts:45-85`** — actually handles platforms correctly:
   overrides `process.platform` and tests macOS/Linux/Windows branches explicitly.
   **Good pattern, adopt more broadly.** This file is the template.

6. **`test/integration/lifecycle.test.ts` — shebang dependency** — the integration
   suite's `Bun.spawn(["bun", "run", "src/cli.ts", ...])` relies on `bun` being on
   PATH. On the Windows runner bun is installed by setup-bun@v1 and should be on
   PATH, but if PATH-resolution fails the test hangs instead of erroring cleanly.

### Estimated fix effort

| Category | Occurrences | Fix | Effort |
|---|---|---|---|
| `/tmp/` hardcodes in string-only assertions | ~15 | Replace with `tmpdir()` / `join(tmpdir(), ...)` | Low (2h) |
| `HOME` env without `USERPROFILE` | ~5 | Add both | Low (30m) |
| `#!/bin/sh` fixture binaries | ~3 | `describe.skipIf` on win32 | Low (30m) |
| POSIX path separator in test data | ~5 | Parameterize with `path.sep` | Medium (2h) |
| Genuinely POSIX-only (fs perms, symlinks, fork) | ~20 | Mark `skipIf(win32)` with rationale | Low (1h) |
| Real Windows-hostile code in src/ | unknown | Requires re-triage after above | Unknown |

**Recommendation:** spend 6 hours migrating to `tmpdir()` and normalizing env +
shebang patterns. Expect Windows failures to drop from 342 to ~50-80 (the real
gaps). At that point, flip `continue_on_error: false` on the Windows job so
regressions are caught.

**Do NOT declare "permanent-xfail":** `continue_on_error: true` is the CI
equivalent of commenting out a test. It gives false confidence. After the
path-hardening pass, the Windows job should fail the build on real breakage.

## Integration test gaps

Currently there are **four** integration test files:
- `test/integration/lifecycle.test.ts` (443 LOC — what the user's question
  called out)
- `test/integration/error-handling.test.ts` (253 LOC — error path coverage for
  pre-init commands)
- `test/integration/secret-pipeline.test.ts` (423 LOC — secret encryption
  pipeline)
- `test/integration/wiki-pipeline.test.ts` (620 LOC — wiki sync pipeline)

**So the user's framing was wrong — three pipelines have integration coverage.**
But the question of "which golden paths are NOT tested end-to-end by spawning
the real CLI binary" has a real answer.

### Golden paths covered

| Path | Where | Verdict |
|---|---|---|
| `am init` | `lifecycle.test.ts:42-57` | COVERED |
| `am add server` | `lifecycle.test.ts:59-77` | COVERED |
| `am apply --dry-run` | `lifecycle.test.ts:130-137` | COVERED |
| `am apply` (real write) | `lifecycle.test.ts:276-317` | COVERED |
| `am import claude-code` | `lifecycle.test.ts:319-363` | COVERED |
| `am status/log/undo` | `lifecycle.test.ts:139-192` | COVERED |
| Full lifecycle round-trip | `lifecycle.test.ts:194-257` | COVERED |
| Pre-init error paths | `error-handling.test.ts` | COVERED |
| Secret encryption/decryption E2E | `secret-pipeline.test.ts` | COVERED |
| Wiki sync E2E | `wiki-pipeline.test.ts` | COVERED |

### Golden paths NOT covered

| Path | Why important | Priority |
|---|---|---|
| `am mcp serve` (batch requests) | The MCP server is the primary gateway. No E2E test spawns the binary and drives it with a real stdio JSON-RPC client. | **HIGH** |
| `am marketplace install` (real clone) | Marketplace is a security-sensitive surface (URL validation, SHA pinning). Unit tests exist; no E2E test does a real clone against a fixture git repo. | **HIGH** |
| `am adapter install` (community adapter) | Community adapters run arbitrary subprocess binaries. Unit tests cover the loader; no E2E for the full install → run cycle. | **HIGH** |
| `am run <agent>` (ACP spawn) | Spawning a real ACP agent is the protocol surface we care most about. Currently only mocked. Would be a natural target for the deep-probe fixture below. | **HIGH** |
| `am flow run <flow>` (flows engine) | Flows are a TOML-defined multi-step DAG. No E2E smoke. | MEDIUM |
| `am push` / `am pull` (git sync) | Git-backed config is a core pillar. No E2E test does a push to a local bare repo and a pull back. | MEDIUM |
| `am profile switch` (profile isolation) | Profile config isolation is security-relevant. Unit tests exist; no full E2E. | MEDIUM |
| `am wiki sync` (wiki ingestion) | The wiki-pipeline test covers most of this, but specifically the `am wiki sync` entry point (vs direct `syncWiki()` call) is not E2E-driven. | LOW (covered adjacent) |
| `am agent detect` (Tier-1 CI) | Per ADR-0033 Phase A — the commitment is that `am agent detect <tier-1-name>` passes in CI. No test currently enforces this. | **HIGH** (ADR commitment) |

### Recommendation

Add `test/integration/mcp-serve.test.ts`, `test/integration/marketplace-install.test.ts`,
and `test/integration/agent-detect-tier1.test.ts`. The latter is the ADR-0033
Phase A commitment.

## Deep-probe design for Tier-1 CI

ADR-0033 says (line 46): "A live deep-probe test in CI (`am agent detect <name>`
returns `verified`)." Currently, zero tests enforce this.

### Requirements for a production-quality deep probe

1. **No network dependency** (CI must not require npm/github at runtime).
2. **No platform dependency** (works on Linux/macOS/Windows runners).
3. **Fast** (under 30s for all Tier-1 agents combined).
4. **Actual protocol exercise** (not a mock) — must speak real JSON-RPC over stdio.
5. **Deterministic failure** (a regression in the deep-probe code path must fail the
   test, not silently pass).

### Proposed design — fake ACP agent fixture

Create `test/fixtures/fake-acp-agent.ts`: a **real, minimal ACP agent server** that
responds to `initialize`, `session/new`, and `session/prompt` with canned results.
Compile it to a standalone binary once per CI run (`bun build --compile
test/fixtures/fake-acp-agent.ts --outfile dist/fake-acp-agent`).

Then write `test/integration/deep-probe.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AmAcpClient } from "../../src/protocols/acp/client";
import { BUILT_IN_ACP_AGENTS } from "../../src/core/agent-registry";

const FAKE_AGENT_BIN = join(import.meta.dir, "../../dist/fake-acp-agent");

describe("Tier-1 deep probe (ADR-0033 Phase A)", () => {
  // Replace the command in BUILT_IN_ACP_AGENTS at test time with the fake
  // binary. Each Tier-1 entry is exercised by the same handshake, proving
  // the registry entry is well-formed (parseable command, spawn works, ACP
  // initialize completes).
  for (const name of ["claude", "codex", "gemini", "kiro"]) {
    test(`${name}: initialize handshake via fake ACP binary`, async () => {
      const client = new AmAcpClient();
      const conn = await client.connect(FAKE_AGENT_BIN, { initTimeout: 5000 });
      expect(conn.agentInfo).toBeDefined();
      expect(conn.capabilities).toBeDefined();
      await client.disconnect();
    }, 10_000);
  }
});
```

This proves:
- Our `AmAcpClient.connect()` works end-to-end against a real ACP-speaking binary.
- The command-parsing (`parseCommand(entry.command)`) doesn't fail for any Tier-1
  entry shape.
- The SDK's `ClientSideConnection.initialize()` survives a real JSON-RPC round-trip.

**What it does NOT prove:** that `claude` specifically, or `codex` specifically,
is reachable on the user's machine — but that's the `am agent detect` user-side
check, not CI's job. CI's job is proving the am-side protocol implementation.

### Separate: real-upstream probe as a manual workflow

For verifying the actual upstream binaries still speak ACP (catching upstream
regressions like `augment-cli → auggie`), add a `.github/workflows/acp-canary.yml`
triggered weekly on cron. It installs claude/codex/gemini/kiro via npm, runs `am
agent detect`, and opens an issue if any fail. Out of scope for commit-time CI.

## Release-pipeline guards missing

The Bun 1.3.12 macho regression was caught **manually** when you ran `gh release
download` after rc4-rc5. Three automated guards would have caught it:

### Guard 1 — existing (retained): version-gate

`ci.yml:89-103` — builds with `VERSION=<package.json>`, asserts
`./dist/am-linux-x64 --version` matches. **Useful but insufficient** — catches
version drift, not execution breakage. The Bun 1.3.12 binary would have printed
the right version before SIGKILL on an actual command.

### Guard 2 — MISSING: post-artifact cross-platform smoke

After the release job uploads `am-darwin-arm64`, `am-darwin-x64`,
`am-linux-x64`, `am-linux-arm64`, and `am-windows-x64`, run a **download-and-exec**
smoke on EACH platform:

```yaml
post-release-smoke:
  needs: release
  strategy:
    matrix:
      include:
        - { os: blacksmith-6vcpu-macos-latest, bin: am-darwin-arm64 }
        - { os: ubuntu-latest, bin: am-linux-x64 }
        - { os: blacksmith-2vcpu-windows-2025, bin: am-windows-x64.exe }
  runs-on: ${{ matrix.os }}
  steps:
    - name: Download released artifact
      run: |
        gh release download "$GITHUB_REF_NAME" --pattern "${{ matrix.bin }}"
        chmod +x "${{ matrix.bin }}" || true
    - name: Exec smoke — version + help + init
      run: |
        ./${{ matrix.bin }} version
        ./${{ matrix.bin }} --help | grep -q "Config"
        TMPDIR=$(mktemp -d)
        AM_CONFIG_DIR="$TMPDIR" ./${{ matrix.bin }} init --yes
        test -f "$TMPDIR/config.toml"
```

Had this existed, the Bun 1.3.12 SIGKILL would have been caught as exit 137.

### Guard 3 — MISSING: codesign verification in release job

`release.yml:48-57` signs the darwin binaries, but the signature is **stripped
when `actions/upload-artifact` zips them** (noted in release.yml:82-92 as a TODO).
Add a post-download re-sign step on macOS runner, OR accept the ad-hoc sig and
run `codesign -vv` on the downloaded artifact to fail loudly if broken:

```yaml
- name: Verify darwin signatures
  if: runner.os == 'macOS'
  run: |
    for bin in am-darwin-*; do
      codesign -vv "$bin" || (echo "::error::$bin has no valid signature"; exit 1)
    done
```

### Guard 4 — MISSING: SBOM diff vs previous release

On every release, generate an SBOM (`bunx @cyclonedx/bun-plugin` or similar) and
diff against the previous release's SBOM. Flag any new transitive dependency.
Would catch supply-chain surprises like "release bumped node-tar from 6.1 to
7.0 because sub-dep drifted."

Not a Bun-bug catcher, but a separate axis of release discipline.

### Guard 5 — MISSING: Bun version sanity

Current CI pins `bun-version: 1.3.11`. But there's no assertion that
`dist/am-*` was actually built with 1.3.11. A drift (someone local-builds with
1.3.12 and pushes a release tag) goes undetected. Simple fix: have `scripts/build.ts`
embed the Bun version used to build into the binary, and verify post-build:

```ts
// scripts/build.ts
const BUN_VERSION = Bun.version;
// embed via --define BUILT_WITH_BUN=...
// verify via: ./am-* version --bun-version | grep -F "$(bun --version)"
```

### Recommended fix priority

1. **Guard 2 (post-artifact smoke)** — highest impact, would have caught Bun 1.3.12.
2. **Guard 5 (Bun version sanity)** — cheap insurance against local-vs-CI drift.
3. **Guard 3 (codesign verify)** — macOS distribution path is already fragile per
   the existing blacksmith-macos-signing review.
4. Guard 4 (SBOM diff) — nice-to-have, not urgent.

## Recommendations

### Must land with Phase B (IMPL-B is working on it now)

1. **Shim-wrapper tests 1-6 above** — happy path, failure path, env leak, single
   chunk, timeout, cancel. These are non-negotiable. File: `test/protocols/acp/shell-wrapper.test.ts`.

2. **The rc5 FileSink regression test** — add to `test/protocols/acp/client.test.ts`.
   Proof:

```ts
test("connect() wraps Bun.spawn's FileSink stdin in a real WritableStream", async () => {
  // The regression: `proc.stdin as unknown as WritableStream<Uint8Array>`
  // compiled fine but blew up at runtime when the SDK called .getWriter().
  // This test proves our wrapper exposes a real WritableStream.
  const client = new AmAcpClient();
  // Spawn a process that stays alive long enough to connect. `cat` reads
  // stdin indefinitely — perfect foil for the handshake (which will time
  // out because cat doesn't speak ACP, but the WritableStream wiring must
  // succeed BEFORE the timeout).
  await expect(
    client.connect("cat", { initTimeout: 200 })
  ).rejects.toThrow(); // times out, but only AFTER successful stdin wiring
  // If the bug were present, it would throw a TypeError("... getWriter is
  // not a function") at setup time, synchronously, not wait for the timeout.
  // We can distinguish: the thrown error MUST match the timeout message,
  // not "getWriter is not a function".
});
```

Or more directly, assert the wrapped object has `getWriter`:

```ts
test("stdin wrapper implements WritableStream contract (getWriter exists)", async () => {
  // Drive connect(), catch the setup error (cat doesn't speak ACP), and
  // reach into the wrapper via a test seam.
  // See src/protocols/acp/client.ts:143-163 for the wrapper we need to probe.
  // ...
});
```

The existing skill `bun-spawn-stdin-not-writable-stream` documents the whole
pattern. The test should be named so a future engineer grepping for
"FileSink" finds it.

### Must land in iter5 (not Phase B, but soon)

3. **Deep-probe test for Tier-1 ACP agents** (fake-agent fixture + handshake
   loop). ADR-0033 Phase A is explicitly blocked on this. See design above.

4. **Integration tests for `am mcp serve`, `am marketplace install`, `am run
   <agent>`, `am agent detect`.** These are the four highest-value golden paths
   currently only covered by unit tests.

5. **Windows path-hardening pass** — replace `/tmp/` hardcodes with `tmpdir()`,
   set both `HOME` and `USERPROFILE` in integration env, skip-if-win32 on
   shebang fixtures. Target: reduce 342 failures to under 80, then flip
   `continue_on_error` off.

### Must land in iter6 or rc7

6. **Release pipeline Guard 2 (post-artifact smoke)** — highest-value automated
   guard, would have caught the Bun 1.3.12 regression.

7. **Release pipeline Guards 3 and 5** — codesign verify + Bun version sanity.

### Soft recommendations

8. The negative-assertion pattern in `agent-invoke.test.ts:86, 135` (`expect(err).not.toMatch(/Unknown/i)`) is usable but weaker than a positive
pin. Upgrade to `expect(err).toMatch(/connect|refused|spawn|ENOENT/i)` so the
test fails on an empty error or unexpected error shape.

9. The `process.platform` override pattern in `test/core/key-path.test.ts:45-75`
is the right template for platform-branching tests. Consider adopting it in
`config.test.ts` and `atomic-write.test.ts` instead of assuming POSIX.

10. Add `failing-before-fix` evidence to commits that land new tests. The
precedent in `test/mcp/concurrency.test.ts:11-15` ("run this against HEAD^^ to
see it fail") is the right discipline — every new regression test should cite
which commit it would fail against.
