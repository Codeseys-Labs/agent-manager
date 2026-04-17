# 07 — New Test Quality Audit (Hardening Wave 1.B / 1.C / 2.A / 2.B)

Audit scope: the ~260 tests added by the eight hardening commits across these files:

- `test/core/atomic-write.test.ts` (13)
- `test/protocols/hardening-wave-1b.test.ts` (29)
- `test/core/key-path.test.ts` (62 assertions across ~14 tests)
- `test/adapters/community/loader-checksum.test.ts` (5) + `test/adapters/community/loader.test.ts` new sections (10+) + `test/commands/adapter-install-sec.test.ts` (20)
- `test/mcp/zod-validation.test.ts` (28)
- `test/mcp/session-cancel-traversal.test.ts` (10)
- `test/mcp/error-redaction.test.ts` (12)
- `test/mcp/auth-gate.test.ts` (22)
- `test/marketplace/url-validation.test.ts` (18)
- `test/marketplace/path-traversal.test.ts` (11)
- `test/marketplace/sha-pinning.test.ts` (8)
- `test/marketplace/tofu.test.ts` (7)

This audit is strictly read-only — no test file was modified.

---

## Summary

The hardening suite is **above average** for fast-written security tests. The majority exercise real code paths against real temp filesystems and JSON-RPC envelopes rather than mocked surrogates. Path-traversal, zod, and redaction tests especially hit the integration layer correctly.

**However** I found **14 distinct anti-patterns or gaps** across the sampled tests. The most concerning clusters:

1. **Atomic-write tests never simulate a crash.** The entire point of `atomicWriteFile` is crash-safety (SIGKILL between tmp-write and rename), but no test fork-kills a child mid-write, injects a rename failure while the tmp file still exists and is readable by another process, or asserts the target remains the *old* contents (not empty, not partial). Coverage is happy-path + rename-to-directory-fails. The `fsync` call is never verified.
2. **Auth-gate tests do not verify timing-safe comparison.** `src/mcp/server.ts::constantTimeEq` exists and is called, but every test asserts only the boolean result. A regression to `a === b` would pass every test in `auth-gate.test.ts`. There is no "equal-length wrong prefix vs different-length wrong prefix should take similar time" test, no explicit assertion that `constantTimeEq` is the function being called.
3. **TOFU tests conflate "refuses" with "prompt was skipped."** Every TOFU test forces non-TTY or `yes: true`. The interactive branch (`clack.confirm` + cancel) is **untested**. Since bun test runs non-TTY, the prompt code path is dead-dark — a regression that breaks `initialValue: false` or the cancel-handling would ship undetected.
4. **Several tautology-shaped tests assert their own setup.** See `validateInput helper returns structured success` (test harness asserts `r.ok === true` after passing valid input — load-bearing only if the helper is broken *and* every other test is broken, since all other tests use the helper). Similarly `heartbeat comment frame arrives during long-running task` commits to an elaborate comment-essay then asserts only that a constant (`SSE_HEARTBEAT_INTERVAL_MS === 30_000`) equals its own declaration.
5. **Environment pollution is handled inconsistently.** `zod-validation.test.ts` and `auth-gate.test.ts` use `process.env.AM_CONFIG_DIR = undefined` (which sets the string `"undefined"`, not deletes the var) — this is a real bug in the cleanup path. `key-path.test.ts` does it correctly (uses `delete`).
6. **Platform-mocking in `key-path.test.ts` mutates the process-global `platform` via `Object.defineProperty`.** Cleanup is in `afterEach`, but if a test inside the block crashes before afterEach runs, subsequent files see the wrong platform. No try/finally on individual `setPlatform` calls.
7. **Checksum-absent-local test asserts on `console.error` text,** which is an implementation detail: a refactor that logs the warning via `logger.warn` or redirects to stderr directly would break the test without changing behaviour.

The sampled tests are useful; few are outright wrong. The biggest risk is the **scope of coverage** — the authors tested the parts that were easy to exercise (zod schema rejection, validator pure functions, TOML parsing) and skipped the parts that matter most operationally (crash-safety, timing-safety, interactive prompts, the "arguments redaction" surface).

---

## Anti-pattern sightings

### A1. Happy-path-only for atomic-write (CRITICAL gap)

**File:** `test/core/atomic-write.test.ts:22-134`

Every test writes successfully or fails *before* the tmp file is created. The crash window — tmp created, fsync not yet completed, renameSync not yet called — is never exercised. Concretely missing:

- Kill -9 a child process between `writeFileSync(tmp, ...)` and `renameSync(tmp, target)` and assert `readFileSync(target)` returns the *old* bytes (not empty, not corrupted).
- Stub `renameSync` to throw, assert target still contains previous contents, tmp cleaned up.
- Stub `fsyncSync` to throw, assert tmp is cleaned up and target untouched.

Quote (line 56):
```ts
test("cleans up tmp file on rename failure", () => {
    // Target dir does not exist -> writeFileSync on tmp fails (parent missing)
```

This test is mis-titled. The comment admits the *writeFile* fails — **rename was never reached**. It doesn't test rename failure; it tests "parent-dir-missing causes writeFile to throw." The actual rename-failure cleanup path (tmp created successfully, rename throws) is only hit by the "target is a directory" test on line 66, and even then the assertion only checks tmp is gone — never checks that the target data was preserved.

**Why it's bad:** The whole value proposition of atomic-write is "target stays consistent on mid-write failure." Not a single test asserts target-integrity after a mid-operation failure.

### A2. No timing-safe-comparison assertion

**File:** `test/mcp/auth-gate.test.ts:112-167`

Quote (line 155):
```ts
test("checkWriteAuth rejects mismatched token", () => {
    const r = checkWriteAuth(
      "write-local",
      { token: "secret", allowUnsafeLocal: false },
      {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { _meta: { authorization: "Bearer wrong" } },
      },
    );
    expect(r.allowed).toBe(false);
```

The production code uses `constantTimeEq` (src/mcp/server.ts:122). No test verifies:

- Length-mismatch is rejected without leaking length (already returns early on length-mismatch — but no assertion that this is the behaviour, not a silent regression to `===`).
- Equal-length tokens differing in the first byte vs last byte take approximately the same time. (Micro-benchmark is flaky but possible with 10k iterations and tolerance.)
- A regression to `if (supplied === auth.token)` would not be caught.

**Why it's bad:** The comment in the source explicitly says "Constant-time string compare to avoid trivial timing oracles." If the compare regresses to `===`, the test suite still passes. The test could at minimum `spyOn(module, 'constantTimeEq')` and assert it was called.

### A3. TOFU interactive branch is untested

**File:** `test/marketplace/tofu.test.ts:29-51`

Quote (line 37):
```ts
test("refuses in non-TTY environment without --yes", async () => {
  // Bun tests run under a non-TTY stdin by default.
  const trusted = await promptTrustOnFirstUse("https://example.com/x.git", "abc123", {
    yes: false,
  });
  expect(trusted).toBe(false);
});
```

The interactive TTY branch — `clack.confirm({ message, initialValue: false })` with user-chosen cancel vs confirm — is never exercised. Coverage is:
- `yes: true` → returns true (tautology — the function's *first line* is `if (opts.yes) return true`)
- `force: true` → returns true (same — second line)
- non-TTY + no `yes` → returns false (not really testing a decision, the function bails at line 4)

**Why it's bad:** A bug in `initialValue: false`, a regression where confirm on a cancel returns `true` instead of `false`, or a failure to handle `clack.isCancel`, would ship silently. The tests effectively check only the three short-circuit branches.

### A4. validateInput tautology

**File:** `test/mcp/zod-validation.test.ts:61-73`

Quote (line 61):
```ts
test("validateInput helper returns structured success", () => {
    const schema = z.object({ name: z.string() });
    const r = validateInput(schema, { name: "ok" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.name).toBe("ok");
});
```

This tests that a trivial zod schema accepts a matching object. If this test fails, every other test in the file has already failed because they all route through `validateInput`. The test is load-bearing only if the wrapper is broken in a way that mis-sets `ok` — but `validateInput` itself is three lines. This reduces to "zod v4 works."

**Why it's bad:** Low-information test. Either delete or replace with a test that verifies the wrapper's value-add: does it strip internal properties? Does it normalize zod's error format? Does it handle `ZodError` thrown outside `.safeParse`?

### A5. Heartbeat "test" that asserts its own constant

**File:** `test/protocols/hardening-wave-1b.test.ts:323-351`

Quote (line 350):
```ts
// ... 25 lines of essay comment explaining why a real heartbeat test is hard ...
expect(SSE_HEARTBEAT_INTERVAL_MS).toBe(30_000);
```

The 29-line comment block honestly admits that this test does not, in fact, verify heartbeats are emitted — it asserts a constant equals its own declaration. A regression where the heartbeat *interval* is correct but the heartbeat is never written to the SSE stream would pass.

**Why it's bad:** Self-aware dead test. The very next test (line 353, "heartbeat timer is installed") does the right thing (spies on `setInterval`, verifies the cadence was registered) — this test should either be deleted or replaced with an assertion that reads bytes from the SSE response body and finds `:heartbeat`.

### A6. `process.env.X = undefined` sets string "undefined"

**Files:** `test/mcp/zod-validation.test.ts:27`, `test/mcp/auth-gate.test.ts:37`, `test/mcp/session-cancel-traversal.test.ts:44`, `test/protocols/hardening-wave-1b.test.ts:54`

Quote (zod-validation.test.ts:26):
```ts
afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      process.env.AM_CONFIG_DIR = undefined;   // ← sets string "undefined"
    }
```

Node/Bun behavior: `process.env.X = undefined` assigns the *string* `"undefined"`, not deletes the key. `process.env.AM_CONFIG_DIR` becomes literally `"undefined"`, which downstream readers will happily use as a path. `key-path.test.ts` does this correctly with `delete process.env[key]`.

**Why it's bad:** Environment leak between test files. A test file that runs after `zod-validation.test.ts` and checks `if (process.env.AM_CONFIG_DIR) {...}` gets a falsy-looking but truthy value, or worse, writes to `./undefined/` literally. Subtle, intermittent, hard to diagnose.

### A7. `setPlatform` without per-test restore guard

**File:** `test/core/key-path.test.ts:47-54`

Quote (line 47):
```ts
function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, "platform", {
      value: platform,
      configurable: true,
    });
}

afterEach(() => {
    env.restore();
    setPlatform(origPlatform);
});
```

If any assertion inside a test throws *before* the test function returns (it does — `expect()` throws), `afterEach` runs fine — but if `setPlatform` itself throws (e.g. `configurable: false` from a prior test that used `Object.freeze`), `origPlatform` leaks. Also: this pattern is defined inside one `describe`, applied only inside that `describe`. If another file in the same bun run imports this test file or runs after it and happens to mutate `process.platform`, there's no global guard.

**Why it's bad:** Process-global mutation with one-tier restore. Brittle. A `try { setPlatform(p); ... } finally { setPlatform(origPlatform); }` per-test would be safer.

### A8. `process.env.AM_CONFIG_DIR` leaked at afterAll

**File:** `test/protocols/hardening-wave-1b.test.ts:53-56`

Quote (line 53):
```ts
afterAll(async () => {
  process.env.AM_CONFIG_DIR = undefined;   // ← same "undefined" string bug as A6
  await rm(tmpDir, { recursive: true, force: true });
});
```

Same issue as A6. Also note: this test mutates `AM_CONFIG_DIR` in `beforeAll` — so every `describe` block in this *same file* that expects a fresh env inherits the set value, and all tests running *after* this file see `AM_CONFIG_DIR="undefined"`.

### A9. Spy-on-console pattern is fragile

**File:** `test/adapters/community/loader-checksum.test.ts:58-66`, `loader.test.ts:321-331, 380-387`

Quote (loader-checksum.test.ts:58):
```ts
const stderrSpy = spyOn(console, "error");
const loaded = await loadCommunityAdapters(dir.path);

expect(loaded.size).toBe(0);
expect(stderrSpy).toHaveBeenCalled();
const joined = stderrSpy.mock.calls.map((c) => c[0] as string).join("\n");
expect(joined).toContain("no checksum");
expect(joined).toContain("am adapter verify");
```

**Why it's bad:** The test asserts:
- exact warning text ("no checksum", "am adapter verify")
- exact logging channel (`console.error`, not `stderr.write`, not `logger.warn`)

A refactor that routes the warning through a logger, changes the message to "checksum missing — run `am adapter verify`", or emits to `process.stderr.write` directly, would break the test without changing behaviour. Implementation-detail brittleness.

Better: spy on the loader's result object for a `.skipped` or `.warnings` array, or expose a structured warning emitter.

### A10. Silent `spyOn` without `.mockRestore()` in one branch

**File:** `test/adapters/community/loader-checksum.test.ts:66`

The `.mockRestore()` happens only on success. If any earlier `expect` throws, the spy stays installed, leaking into subsequent tests that import `console`. Should be in a `finally` or `afterEach` that restores all spies.

### A11. `connect() can be retried after a failed init` test has non-deterministic assertion

**File:** `test/protocols/hardening-wave-1b.test.ts:110-123`

Quote (line 110):
```ts
test("connect() can be retried after a failed init", async () => {
    const client = new AmAcpClient();
    try {
      await client.connect("sleep 30", { initTimeout: 200 });
    } catch {
      // expected
    }
    // Second attempt must not throw ALREADY_CONNECTED
    try {
      await client.connect("sleep 30", { initTimeout: 200 });
    } catch (err) {
      expect((err as Error).message).not.toContain("Already connected");
    }
});
```

**Why it's bad:** The test passes if:
- second `connect` succeeds (no assertion runs; test silently passes), OR
- second `connect` throws anything that isn't "Already connected" (passes).

A regression where the second call throws `undefined` or never resolves would not be detected. The test has no positive assertion path — it relies on the absence of a specific error message. Should be:

```ts
await expect(secondConnect()).rejects.toThrow(/(?!Already connected).*/);
// or better:
await expect(secondConnect()).rejects.toThrow(/timeout|init/i);
```

### A12. Monkey-patching `AmAcpClient.prototype` without full test isolation

**File:** `test/protocols/hardening-wave-1b.test.ts:137-201`

Quote (line 137):
```ts
const origSetPolicy = AmAcpClient.prototype.setPermissionPolicy;
const origSetPaths = AmAcpClient.prototype.setAllowedPaths;
const origConnect = AmAcpClient.prototype.connect;

AmAcpClient.prototype.setPermissionPolicy = function (policy) { seen.policy = policy; ... };
```

The finally block restores, but: if `handler(...)` throws synchronously *before* the `try` (it can't here, but the pattern is unsafe to generalize), or if the test file is re-imported, the prototype stays patched. Also: two `describe` blocks later (Fix 3 tests, line 206+) create new `AmAcpClient()` instances — if any test in Fix 2 fails between the monkey-patch and the restore, Fix 3's assertions about `terminalStore` being a Map are moot because the prototype now has stub methods. The test ordering dependency is implicit.

**Why it's bad:** Prototype mutation + sibling-describe dependencies. Fragile. Should use a local subclass or a mock library with automatic teardown.

### A13. `am_acp_session_cancel` traversal test accepts "not found" as pass

**File:** `test/mcp/session-cancel-traversal.test.ts:122-124`

Quote (line 122):
```ts
expect(
  /Invalid (arguments|sessionId)/.test(content.error) || /not found/i.test(content.error),
).toBe(true);
```

**Why it's bad:** The third branch, "not found," accepts the case where the traversal *succeeded past the guard* but happened to hit an empty dir. If a regression makes the guard silently accept `../../victim.txt` but the resolved path doesn't contain a session, the error becomes "not found" — and this test passes. Traversal got silently allowed; the test still greens.

The final `stat(victim)` assertion at line 128 is a safety net, but the payloads chosen don't all target `victim.txt` — e.g. `"../../../../tmp/x"` tests /tmp/x which the suite didn't create, and `"/etc/passwd"` is an absolute path that the guard rejects on different grounds. The dragnet is leaky.

Better: for each payload that *would* resolve to a real file, assert both the guard fired AND the real file still exists.

### A14. `adapter-install-sec.test.ts` is pure unit test — no spawn chain assertion

**File:** `test/commands/adapter-install-sec.test.ts`

Quote (line 55):
```ts
test("rejects a git URL whose basename would traverse", () => {
    expect(() => resolveSource("https://evil.example.com/..")).toThrow(/Invalid adapter name/);
});
```

The test verifies `resolveSource` (validation function) rejects. It does NOT verify that the `install` command, when given this URL end-to-end, refuses to spawn npm/git and refuses to create the target dir. The actual security boundary — "no filesystem write, no subprocess spawn for a bad name" — is not asserted.

**Why it's bad:** A future refactor could bypass `resolveSource` in the install command's entry point (hand-wired URL → spawn chain) and this test suite would miss it. Should have at least one E2E test: "calling install with `../evil` does not create any directory under adapters/".

---

## Coverage shape: what the tests actually protect vs what they claim to protect

| Wave / Area | Claimed coverage | Actual coverage | Gap |
|---|---|---|---|
| **Wave 1.B — ACP subprocess leak on init failure** | "subprocess is killed within initTimeout" | Asserts `subprocess === null` reference clearing + fail-fast timing. | No assertion that the OS-level process actually terminated (`kill -0 pid` or wait for exit). Test only checks the client's internal bookkeeping field. |
| **Wave 1.B — SSE heartbeat** | "heartbeat comment frame arrives during long-running task" | Verifies `setInterval` is called at `SSE_HEARTBEAT_INTERVAL_MS`. Never reads bytes from the stream after idle period. | End-to-end observation. With a 30s interval on bun's fast clock, this is hard — but the fix is to make the interval injectable. |
| **Wave 1.B — parseCommand** | "respects single/double quotes and escapes" | **Solid.** 13 tests, including unterminated-quote error, whitespace-only, empty args. | The one gap: no "single `\\` at end of input" and no "CRLF line terminator at end" test. Minor. |
| **Wave 1.C — key storage** | "key at OS data-dir, legacy migrated out, mode 0600" | **Solid.** Migration happy path, conflict path, mode assertion. | No test for "legacy file is readable-by-other" → "new file should be mode 0600 even if legacy was 0644" IS covered (line 183). Good. One gap: no test that migration cleans up an *empty* or *corrupt* legacy file. |
| **Wave 2.A — adapter checksum** | "refuses to spawn without pinned checksum (non-local)" | Loader asserts `loaded.size === 0` and stderr contains text. Never asserts no subprocess was spawned. | `ps` or process count assertion after load would catch a regression where the loader logs the warning but spawns anyway. |
| **Wave 2.A — adapter name validation** | "rejects traversal, bad chars, oversize" | 10 invalid cases + 4 valid. Covers regex boundary at 64. | No test that rejected names *do not reach* the filesystem or network. All tests stop at the validator. |
| **Wave 2.B — zod validation for 33 tools** | "every tool rejects malformed args at the dispatcher" | 18 explicit per-tool tests. One coverage-guard test asserts `tools.length === 33` and names start with `am_`. | Not every tool is individually exercised. Tools with `properties: {}` are essentially untested (the coverage guard acknowledges this). A schema-drift regression in an untested tool would ship. |
| **Wave 2.B — session-cancel path traversal** | "guard refuses traversal, victim file untouched" | `resolveSessionPathSafely` unit tests (6) + handler E2E with 7 payloads + happy-path session delete. | The "victim untouched" assertion is weak (A13). Should assert every payload that points to a real file leaves that file. |
| **Wave 2.B — error redaction** | "bearer tokens, AWS keys, OpenAI keys redacted in error messages" | 10 pattern tests + 2 `safeErrorMessage` tests. Covers the canonical shapes. | No test that redaction survives JSON-stringification of a nested error (e.g. `{ cause: new Error("Bearer sk-foo") }`), no test for multi-line stack traces with secrets on every line. |
| **Wave 2.B — auth gate** | "write-tier tools require token; read-only unauthenticated" | Excellent coverage of policy decisions, tools/list filtering. | Missing timing-safe assertion (A2). No replay-attack test ("same token can be used twice"). No test for token rotation (`setAuth` twice). |
| **Wave 2.B — marketplace URL validation** | "scheme, port, creds enforced" | Good coverage. | No IDN/homograph test (`https://github.сom/foo/bar.git` with Cyrillic 'c'). Pragmatic to omit, but worth noting. |
| **Wave 2.B — marketplace path traversal** | "skills and agent.prompt_file rejected when escaping plugin dir" | 7 unit tests + 3 E2E. Covers the obvious cases + sibling-prefix attack. | No test for Windows separator (`..\\..\\..\\windows\\system32`) path traversal on a Linux host. Not critical but a known pattern. |
| **Wave 2.B — marketplace SHA pinning** | "refuse install when HEAD drifts from pin; allow when matches" | Good: real git repos, isomorphic-git, full install path. | No test for "pinned SHA is a valid-length hex but points to a non-existent commit" (resolveHeadSha returns a different SHA, the mismatch is caught — but what if the SHA is malformed? Nothing asserts the format). |
| **Wave 2.B — TOFU** | "prompt required for remote, --yes bypasses, local skips" | Three short-circuit branches tested. See A3. | **Interactive branch is a black box.** No test exercises `clack.confirm` with a fake TTY. |
| **Atomic write** | "tmp-then-rename, cleanup on failure" | Happy path + rename-to-dir-fails + cleanup checks. | **Crash-mid-write is not tested.** See A1. No test for the fsync call (if fsync is removed, the test suite passes). |

### Summary: the tests protect the happy path and the pure-function validation layer. They do NOT protect:

- Subprocess lifecycle (OS-level process termination)
- Crash-safety of atomic-write
- Timing-safety of token comparison
- Interactive prompts (TOFU confirm dialog)
- The end-to-end "bad input never reaches the filesystem/network" contract

---

## Missing tests (critical paths not covered by the new suite)

1. **`atomic-write`: SIGKILL-mid-write preserves target.** Fork a child that writes a large file via `atomicWriteFileSync`, SIGKILL it during the write (use a `SIGUSR1` handler in the child that pauses after `writeFileSync(tmp)` but before `renameSync`), from parent observe that `target` still has old contents and tmp cleanup is not possible (orphan tmp files are OK — assert target is consistent). Bun supports this via `Bun.spawn`.
2. **`atomic-write`: fsync is actually called.** Mock `fs.openSync`/`fsyncSync`, assert it was called before `renameSync`. Currently a PR removing the `openSync/fsyncSync/closeSync` block would pass all tests.
3. **`auth-gate`: constantTimeEq is used, not `===`.** Spy on the function export or use a token whose `===` with the expected returns true but `constantTimeEq` returns false (impossible with primitives, but a test that asserts `constantTimeEq` is imported and called via a module-spy works).
4. **`auth-gate`: token-rotation.** Call `setAuth({ token: "a" })`, make a write call with token "a" — allowed. `setAuth({ token: "b" })`, call with "a" — rejected. "b" — allowed.
5. **`auth-gate`: write-remote tier.** All tests focus on `write-local`. The `write-remote` tier (e.g. `am_sync_push`) has stricter rules — no test verifies they hold.
6. **`tofu`: interactive TTY confirm=true path.** Mock `process.stdin.isTTY`/`process.stdout.isTTY` to true, mock `@clack/prompts.confirm` to return `true`. Assert `promptTrustOnFirstUse` returns true.
7. **`tofu`: interactive TTY cancel path.** Same setup, mock confirm to return `Symbol` (the cancel sentinel clack uses). Assert `promptTrustOnFirstUse` returns false.
8. **`tofu`: `promptShaChange` is completely untested.** Same four-branch coverage (yes, force, non-TTY, TTY+confirm, TTY+cancel).
9. **`zod-validation`: valid-args positive path for every tool.** The coverage guard (line 372) only asserts names; it skips tools with empty schemas. Add a parameterized positive test: "every tool with a known-valid input shape routes through validation and returns a non-error result OR an expected business-logic error (not `Invalid arguments`)."
10. **`zod-validation`: zod v4 error format has not drifted.** The `isInvalidArgsError` helper parses `content.error` and checks the prefix "Invalid arguments". If zod v5 drops that prefix, every test silently flips to `false` and passes. A schema-introspection test that round-trips a ZodError through `validateInput` and asserts the exact shape would pin the format.
11. **`error-redaction`: JSON-stringified nested error.** `safeErrorMessage(new Error("wrap", { cause: new Error("Bearer secret") }))` — does the cause get redacted? Currently, `err.message` only returns the outer string; if the handler serializes `err.stack` or `err.cause`, secrets leak.
12. **`error-redaction`: multi-line input.** A stack trace with a bearer token on line 2 of 10 — are all lines redacted, or only the first match per pattern? The `g` flag is used, so it should be all, but no test asserts multiple matches in one string.
13. **`session-cancel-traversal`: symlink-based traversal.** Create a symlink inside `sessions/` that points outside. The current `resolveSessionPathSafely` is purely string-based — does `rm` follow the symlink? A real defense-in-depth test would realpath-resolve before rm'ing.
14. **`sha-pinning`: malformed pinned SHA.** `commit: "not-a-sha"` or `commit: "abc"` (too short) — does `verifyMarketplacePin` reject the entry, or silently compare against HEAD and see a mismatch?
15. **`adapter-install-sec`: npm install is not invoked for a bad name.** Currently unit-tested at the validation layer; no test asserts the filesystem and subprocess are not touched.
16. **`hardening-wave-1b` Fix 1: OS-level process is dead.** The `subprocess === null` assertion only checks internal bookkeeping. Actually verify with `process.kill(pid, 0)` — throws if process is gone, nothing if alive.
17. **`path-traversal`: null byte + traversal together.** `../\0../etc/passwd` — does the combination pass either check in isolation but fail the combined check?
18. **`loader-checksum`: concurrent load does not spawn on one of N when checksum fails.** If a race spawns both, then fails the bad one after spawn, the damage is done. Need a "no spawn before verify" assertion.

---

## Recommendations

### Rewrite

1. **`atomic-write.test.ts:56-64` ("cleans up tmp file on rename failure")** — the test is mis-titled and tests the wrong thing. Replace with a test that:
   - Stubs `renameSync` to throw after the tmp write + fsync have succeeded.
   - Pre-seeds target with old contents.
   - Asserts target still has old contents after the failed write.
   - Asserts tmp file is unlinked.

2. **`hardening-wave-1b.test.ts:323-351` (heartbeat constant assertion)** — delete or replace with a real SSE byte-reading test. If the 30s interval is too long for CI, expose `SSE_HEARTBEAT_INTERVAL_MS` as a parameter to `createA2ARoutes` and pass a shortened value in tests. The structural test on line 353 is good; the essay-test is noise.

3. **`hardening-wave-1b.test.ts:110-123` (retry after failed init)** — add a positive assertion: `await expect(secondConnect).rejects.toThrow(/timeout|init failed/)`. Current test passes even if second connect silently succeeds with a bogus connection.

4. **`auth-gate.test.ts:155-167`** — add a length-safe assertion: with `token = "aaaaaaaa"` (8 chars) and `supplied = "bbbbbbbb"` (8 chars), both pass — then assert via `spyOn` that `constantTimeEq` was called, not `===`.

5. **`session-cancel-traversal.test.ts:122-124`** — drop the `/not found/i.test()` escape hatch. For each payload, either:
   - Pre-create the file the payload resolves to and assert it still exists after the call (true traversal failure).
   - Assert the error regex is strictly `/Invalid (arguments|sessionId)/` — no "not found" fallback.

6. **`zod-validation.test.ts:61-73` (validateInput helper tests)** — delete or replace with tests that exercise the wrapper's invariants beyond zod's behaviour: does it normalize nested path errors, does it truncate long error strings, does it strip stack traces, etc.

### Add (in priority order)

1. **Timing-safe assertion test for bearer token comparison** (auth-gate).
2. **TOFU interactive-branch test with mocked TTY + mocked `clack.confirm`** (tofu).
3. **Crash-during-atomic-write test using `Bun.spawn` + SIGKILL** (atomic-write).
4. **OS-level process liveness check after ACP init failure** (hardening-wave-1b Fix 1).
5. **End-to-end "bad name does not spawn npm"** test (adapter-install-sec).
6. **`promptShaChange` test coverage** (marketplace/tofu).
7. **Write-remote tier auth tests** (auth-gate).
8. **Symlink-based traversal test for session-cancel** (session-cancel-traversal).
9. **Nested error cause redaction test** (error-redaction).
10. **Schema-drift pin for zod error format** (zod-validation).

### Hygiene

1. Replace every `process.env.X = undefined` with `delete process.env.X` across `zod-validation.test.ts`, `auth-gate.test.ts`, `session-cancel-traversal.test.ts`, `hardening-wave-1b.test.ts`. Currently setting the string `"undefined"` as a value.
2. Wrap all `spyOn(console, 'error')` in `afterEach` cleanup or `try/finally`, so an early `expect` failure doesn't leak the spy into the next test.
3. Replace the prototype-monkey-patch pattern in `hardening-wave-1b.test.ts:137-201` with a `bun:test` `mock.module()` or a local subclass to eliminate sibling-test pollution risk.
4. Remove the double-`if (originalEnv)` pattern and consolidate the env-sandbox helper from `key-path.test.ts` into a shared `test/helpers/env.ts` utility. Import from one place.

---

## Appendix: sampling notes

Tests I read in full (roughly 15 sampled):

- atomic-write.test.ts — all 13
- hardening-wave-1b.test.ts — all 29 (scanned deeply)
- key-path.test.ts — all (resolveKeyPath 8, legacy 1, migrate 4, loadKey happy 4)
- loader-checksum.test.ts — all 5
- adapter-install-sec.test.ts — all 20
- zod-validation.test.ts — all 28 (scanned; deep-read 8)
- session-cancel-traversal.test.ts — all 10
- error-redaction.test.ts — all 12
- auth-gate.test.ts — all 22 (deep-read 8)
- url-validation.test.ts — all 18
- path-traversal.test.ts — all 11
- sha-pinning.test.ts — all 8
- tofu.test.ts — all 7
- loader.test.ts — the new verifyChecksum and checksum-integration sections (lines 275-388)

Total tests sampled: ~200 of the ~260 new tests.
