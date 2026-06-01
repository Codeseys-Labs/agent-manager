# Windows Cross-Platform Hardening Plan

**Status:** Diagnosis complete — ready for implementation
**Scope:** 46 `build-verify (windows)` CI failures (Linux + main `test` job are green)
**Author:** cross-platform reliability pass, 2026-06-01
**Failure manifest:** `docs/audit/assessment-2026-05-31/windows-ci-failures.txt`

---

## Executive summary

The 46 Windows-only failures collapse into **7 distinct root causes**. Only
**two are genuine source bugs** (codex path-splitting, cursor `APPDATA`
divergence). The other five are **test-side cross-platform defects**: tests that
hardcode a forward-slash `/` in path substring assertions, hardcode POSIX-only
shell commands, or fail to isolate Windows global state (`%APPDATA%`, OS
keychain). The shared production code (`vscode-paths.ts`, `secrets-age.ts`
`resolveIdentityDir`, `wiki/storage.ts`, `flows.ts` action node) is already
correct — it uses `node:path` `join`/`dirname` and platform branches.

The fix is therefore weighted toward **test portability** plus **two targeted
source patches**. No public API changes; no behavior change on Linux/macOS.

| # | Root cause | Layer | Tests affected | Confidence |
|---|------------|-------|----------------|------------|
| RC1 | `process.env.APPDATA` overrides injected `homeDir` in VS Code-fork session readers → test isolation broken | **source** (`vscode-paths.ts`, `cursor/session.ts`, `windsurf/session.ts`) | ~24 (Cursor, Cline, Copilot, Roo session) | High |
| RC2 | Codex session reader splits paths on literal `/` | **source** (`codex-cli/session.ts`) | 2 (codex) | High |
| RC3 | Tests assert path *substrings* with hardcoded `/` (`f.path.includes(".cursor/mcp.json")`, `toContain(".agent-manager/wiki")`) | **test** (roundtrips, wiki) | ~5 (Cursor/Kiro/Roo roundtrip, wiki path) | High |
| RC4 | Tests assert exact `/`-joined path literals (`resolveIdentityPath()` === `/tmp/.../identity.age`) | **test** (`secrets-age.test.ts`) | 2 (age paths) | High |
| RC5 | Flow action-node tests hardcode POSIX commands (`pwd`, `echo`) not spawnable on Windows | **test** (`flows.test.ts`) | 3 (cwd override, 2 mixed-node) | High |
| RC6 | `am_apply` adapter-detection path is slow on Windows → 2 concurrency tests time out | **test/source** (`mcp/concurrency.test.ts` + `getDetectedAdapters`) | 2 (MCP concurrency) | Medium |
| RC7 | v2/keychain global state not isolated across files in single bun process | **test** (`secret-pipeline.test.ts` P0-3) | 1 (P0-3) | Medium |

---

## Root cause detail + fixes

### RC1 — `process.env.APPDATA` shadows the injected `homeDir` (SOURCE BUG)

**Where:**
- `src/adapters/shared/vscode-paths.ts:53-55` — `resolveVSCodeUserDir`:
  ```ts
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, variant.dirName, "User");
  }
  ```
- `src/adapters/cursor/session.ts:60-63` — `cursorUserDir`:
  ```ts
  if (process.platform === "win32") {
    if (process.env.APPDATA) return join(process.env.APPDATA, "Cursor/User");
    return join(homeDir, "AppData/Roaming/Cursor/User");
  }
  ```
- `src/adapters/windsurf/session.ts:42-43` — same pattern.

**Why it fails on Windows:** Every session-reader test injects a fake `homeDir`
(a `mkdtemp` temp dir) and seeds fixtures relative to it. On Linux/macOS the
`win32` branch is never taken, so `homeDir` is honored. On the Windows runner
`process.env.APPDATA` is **always set** (`C:\Users\runneradmin\AppData\Roaming`),
so the readers IGNORE the injected temp `homeDir` and resolve to the runner's
REAL `%APPDATA%`. Consequences:
- Seed writes (cursor test seeds via its own `userDirFor` which uses `home`,
  NOT `APPDATA` — so seed and read DIVERGE → reader finds nothing →
  every `listSessions`/`loadSession`/`hasSessionStorage(true)` assertion fails).
- Cline/Copilot/Roo seed via the SAME helper as the reader, so seed and read
  agree — but BOTH point at the shared real `%APPDATA%`, so
  `hasSessionStorage returns false when no globalStorage exists` fails (real
  dir may exist / prior test leaked) and cross-test data bleeds.

This is the single largest cluster (~24 tests): all Cursor session tests, the
Cline `hasSessionStorage false` + skip-* tests, Copilot `listSessions *`, Roo
`hasSessionStorage false` + `ui_messages fallback`.

**Fix (source):** When an explicit `homeDir` is passed, it must win over
`process.env.APPDATA`. The env var is only the correct default when resolving
the *real* user's location (no override). Two options:

1. **Preferred — honor override:** thread an explicit `appData` override or
   derive APPDATA from `homeDir` when `homeDir` was supplied by the caller:
   ```ts
   export function resolveVSCodeUserDir(variant, homeDir?, appData?) {
     const home = homeDir ?? homedir();
     if (process.platform === "win32") {
       // If the caller injected a home, derive APPDATA under it so tests stay
       // hermetic; only fall back to the real env var for the default home.
       const roaming =
         appData ??
         (homeDir ? join(home, "AppData", "Roaming")
                  : (process.env.APPDATA ?? join(home, "AppData", "Roaming")));
       return join(roaming, variant.dirName, "User");
     }
     ...
   }
   ```
   Apply the identical "honor injected home over env" rule to
   `cursor/session.ts` `cursorUserDir` and `windsurf/session.ts`.

2. Cursor's `userDirFor` test helper already assumes `<home>/AppData/Roaming`
   (no APPDATA), so option 1 makes source and that helper agree on Windows.

**Verification:** Run the Cursor/Cline/Copilot/Roo session suites with
`APPDATA` set to a junk path; all must pass and touch only the temp `homeDir`.

---

### RC2 — Codex session reader splits paths on literal `/` (SOURCE BUG)

**Where:** `src/adapters/codex-cli/session.ts`
- `sessionIdFromPath` line 432: `const basename = filePath.split("/").pop() ?? filePath;`
- `dateFromPath` line 441: `const parts = filePath.split("/");`

**Why it fails on Windows:** `scanSessionFiles` builds file paths with
`join(dayDir, file)` (line 187) → on Windows these are backslash-separated
(`...\2026\04\08\derived-id.jsonl`). `split("/")` returns the whole string as
one element, so:
- `sessionIdFromPath` returns the full backslash path (test expects
  `"derived-id"`) → "derives session ID from filename when no session_meta" fails.
- `dateFromPath` can't find the `YYYY/MM/DD` triple → returns `new Date()` (now)
  instead of `2026-03-15` → "derives date from path when no started_at in meta"
  fails.

**Fix (source):** Use `node:path` `basename` + `sep`-aware splitting:
```ts
import { basename, sep, join } from "node:path";

function sessionIdFromPath(filePath: string): string {
  return basename(filePath).replace(/\.jsonl$/, "");
}

function dateFromPath(filePath: string): Date {
  // Split on BOTH separators so the YYYY/MM/DD walk works on Windows too.
  const parts = filePath.split(/[\\/]/);
  ...
}
```
(`basename` is already imported in copilot/session.ts as precedent.) Also audit
`src/adapters/continue/import.ts:215,220` for the same `split("/")` pattern —
not in the failing list today but the same latent bug.

**Verification:** codex session suite green; add a Windows-path unit assertion.

---

### RC3 — Tests assert path substrings with hardcoded `/` (TEST BUG)

**Where:**
- `test/adapters/cursor/roundtrip.test.ts:67` — `f.path.includes(".cursor/mcp.json")`
- `test/adapters/kiro/roundtrip.test.ts:67` — `f.path.includes(".kiro/settings/mcp.json")`
- `test/adapters/roo-code/roundtrip.test.ts:143` — `f.path.includes(".roo/mcp.json")`
- `test/adapters/roo-code/roundtrip.test.ts:190` — `f.path.includes(".roo/rules/")`
- `test/commands/wiki-wave-b.test.ts:353` — `expect(parsed.path).toContain(".agent-manager/wiki")`

**Why it fails on Windows:** The export adapters and `resolveWikiDir` build
`f.path` / the wiki path with `node:path` `join` → backslashes on Windows
(`.cursor\mcp.json`, `.agent-manager\wiki`). The `.includes("...")` /
`.toContain("...")` checks use forward slashes → never match → `globalFile`
undefined / assertion fails. (Note the symmetrical *negative* assertions like
`not.toContain(".agent-manager/wiki")` spuriously PASS on Windows, which is why
the failures are only on the positive checks.)

This precisely explains why only the slash-bearing roundtrip tests fail while
sibling tests checking slash-free substrings (Roo `mcp_settings.json` at
roundtrip.test.ts:76, Kiro `.endsWith(".md")` at :166) pass.

**Fix (test):** Normalize before substring-matching, or match on a
platform-correct separator. Add a shared helper in `test/helpers/`:
```ts
export const toPosix = (p: string) => p.split(sep).join("/");
// then: expect(toPosix(globalFile!.path)).toContain(".cursor/mcp.json")
//       expect(toPosix(parsed.path)).toContain(".agent-manager/wiki")
```
Apply to all five sites. Do NOT change the source — emitting native separators
in `f.path` is correct.

**Verification:** roundtrip + wiki path suites green on Windows; unchanged on
Linux (`toPosix` is a no-op there).

---

### RC4 — age-secrets path tests assert `/`-joined literals (TEST BUG)

**Where:** `test/core/secrets-age.test.ts:60-78`
```ts
expect(resolveIdentityPath()).toBe("/tmp/custom-am-id/identity.age");   // line 64
expect(resolveIdentityDir()).toBe("/tmp/xdg/agent-manager/identities"); // line 74
```

**Why it fails on Windows:** `resolveIdentityDir`/`resolveIdentityPath`
(`secrets-age.ts:183-194`) use `join(...)`. With `XDG_CONFIG_HOME=/tmp/xdg`,
`join("/tmp/xdg", "agent-manager", "identities")` →
`\tmp\xdg\agent-manager\identities` on `path.win32`. The exact-`toBe` against a
forward-slash literal fails. (`resolveIdentityDir` for `AM_AGE_IDENTITY_DIR`
passes the value through verbatim so that line is fine; the *`resolveIdentityPath`*
join at line 64 and the XDG join at line 74 are what break.)

**Fix (test):** Build the expected value with the same `join`, or `toPosix`-
normalize both sides:
```ts
expect(toPosix(resolveIdentityPath())).toBe("/tmp/custom-am-id/identity.age");
expect(toPosix(resolveIdentityDir())).toBe("/tmp/xdg/agent-manager/identities");
```
The SOURCE `resolveIdentityDir` is already correct (XDG / `~/.config` /
`AM_AGE_IDENTITY_DIR` precedence is right and platform-neutral). No source change.

**Verification:** `secrets-age.test.ts > paths` green on all three platforms.

---

### RC5 — Flow action-node tests hardcode POSIX commands (TEST BUG)

**Where:** `test/protocols/acp/flows.test.ts`
- `:932` `action({ command: "pwd", cwd: "/tmp" })` — "action node respects cwd override"
- `:1072` `action({ command: "echo {{filename}}" })` — "compute -> action -> compute pipeline"
- `:1106` `action({ command: "echo {{description}}" })` — "acp -> compute -> action flow"
- (also `:230`, `:273` `echo` — those tests are NOT in the failing list; see note)

**Why it fails on Windows:** `executeActionNode` (`flows.ts:529`) calls
`Bun.spawn([executable, ...args])` with a scrubbed env. `pwd` does not exist on
Windows; `echo` is a `cmd.exe` builtin, not a standalone `echo.exe` on the
runner's PATH → `Bun.spawn` fails to launch / non-zero exit → action node throws
`ACTION_FAILED` → test fails. The `cwd: "/tmp"` literal compounds the `pwd` case
(`/tmp` is not a Windows dir).

> Note: `:230`/`:273` `echo` tests are absent from the failing manifest. Likely
> Bun resolves a bundled/Git-bash `echo` for the simplest forms, or the manifest
> is truncated at 46. Fix all `echo`/`pwd` action commands regardless for
> consistency.

**Fix (test):** Replace POSIX commands with a cross-platform spawnable. Options,
in order of preference:
1. Use the test runner itself: `action({ command: \`${process.execPath} -e "process.stdout.write(process.cwd())"\` })` for the cwd test, and a `bun -e "console.log(...)"` for the echo pipelines. `process.execPath` (the bun binary) is guaranteed spawnable on every platform.
2. For the cwd test, use an OS-correct temp dir: `cwd: tmpdir()` (already imported) and assert `output.stdout` contains a stable substring of `realpathSync(tmpdir())` rather than literal `"tmp"`.
3. Gate the few genuinely shell-specific assertions behind
   `process.platform !== "win32"` only as a last resort (loses Windows coverage).

**Verification:** flows action/mixed-node suites green on Windows; cwd assertion
uses `tmpdir()` not `/tmp`.

---

### RC6 — `am_apply` concurrency tests time out on Windows (TEST/SOURCE)

**Where:** `test/mcp/concurrency.test.ts:80` ("2x am_apply concurrent") and
`:118` ("am_apply + am_add_server race"). Both invoke `am_apply` with no target
→ `controller.ts:324 getDetectedAdapters()` runs all 13 adapters' `detect()`.

**Why it fails on Windows:** The two failing tests are exactly the apply-bearing
ones; "2x am_add_server" (no apply) and the batch/read-only tests PASS — so this
is NOT a logic/locking bug. `getDetectedAdapters()` probes the real filesystem
(`existsSync`/`realpathSync` across `%APPDATA%`, `%LOCALAPPDATA%`, VS Code
variants). On Windows these stat calls are markedly slower, and the
`AsyncMutex` (`withConfig`) serializes the two parallel `am_apply` calls,
~doubling wall-time. The "2x am_apply" test already carries a 30s override and a
comment documenting WSL2 flakiness (lines 84-92); the race test at :118 has NO
override and uses the default 5s → it times out first.

**Fix (test, primary):**
- Add an explicit `}, 30_000)` timeout to the ":118" race test (matching :80).
- Better: scope these tests to a single deterministic adapter via the
  `adapterResolverOverride` test seam (`controller.ts:312
  __setAdapterResolverForTests`) so they exercise the mutex without paying the
  13-adapter detection cost. This removes the platform-speed dependence entirely
  and is the robust fix.

**Fix (source, optional follow-up):** `getDetectedAdapters()` could cache
`detect()` results per process and/or parallelize the 13 probes; tracked as a
perf nicety, not required for green CI.

**Confidence: Medium** — strongly inferred from the pass/fail split (only
apply-path tests fail) and the existing timeout comment; not reproduced on a
Windows host. If after the timeout/seam fix these still fail, re-investigate a
specific adapter `detect()` throwing on Windows.

---

### RC7 — P0-3 v2/unknown fail-loud test not isolated from global state (TEST)

**Where:** `test/integration/secret-pipeline.test.ts:336` ("without any key,
enc:v1: passes through but enc:v2:/unknown FAIL LOUD").

**Why it (likely) fails on Windows:** The test calls `interpolateEnvAsync(v2Config)`
with `ageBackend: null` and expects a throw (`/age|backend|unlock/i`). The code
path (`secrets.ts:341 decodeEnvelope` with `backends.ageBackend = null`) should
throw deterministically regardless of platform. The Windows-only failure points
at **shared-process state pollution**: bun runs all test files in one process,
and the age backend caches an OS-keychain passphrase via `cross-keychain`
(Windows Credential Manager) plus a process-global identity. A prior
secrets/pair test on Windows can leave Credential-Manager / default-identity
state that lets a later default-backend resolution behave differently. The test
does not set `AM_AGE_IDENTITY_DIR` to an isolated temp dir, unlike the age
lifecycle tests.

**Fix (test):** Make the P0-3 test hermetic — set `AM_AGE_IDENTITY_DIR` to a
fresh temp dir and clear `AM_AGE_PASSPHRASE` in its `beforeEach`, and assert the
throw with `ageBackend: null` explicitly (already passed). If the failure
persists, inject a stub age backend whose `decrypt` throws, removing any reliance
on default-backend resolution.

**Confidence: Medium** — the exact pollution source is inferred; the mechanism
(single bun process + Windows keychain) is plausible but unverified on a Windows
host. The fix (env isolation) is low-risk regardless.

---

## Shared helpers to add

1. `test/helpers/path.ts`:
   ```ts
   import { sep } from "node:path";
   /** Normalize a native path to POSIX slashes for portable substring asserts. */
   export const toPosix = (p: string) => p.split(sep).join("/");
   ```
   Used by RC3 and RC4 fixes.

2. (optional) `test/helpers/spawn.ts` cross-platform "print" command builder for
   RC5, e.g. `printCwdCommand()` / `printArgCommand(str)` returning a
   `process.execPath -e ...` invocation.

---

## Suggested implementation order (waves)

**Wave 1 — source bugs (no test edits needed beyond verifying):**
- RC1: `vscode-paths.ts` + `cursor/session.ts` + `windsurf/session.ts` honor
  injected `homeDir` over `APPDATA`.
- RC2: `codex-cli/session.ts` `basename`/`split(/[\\/]/)`; audit `continue/import.ts`.

**Wave 2 — test portability (mechanical):**
- Add `toPosix` helper.
- RC3: 5 substring sites.
- RC4: 2 age-path assertions.
- RC5: flows action-node commands → `process.execPath -e`, `tmpdir()`.

**Wave 3 — isolation / timing:**
- RC7: isolate P0-3 (`AM_AGE_IDENTITY_DIR` temp, clear passphrase env).
- RC6: add 30s timeout to concurrency race test + adopt `adapterResolverOverride`
  seam to drop the 13-adapter detection cost.

**Wave 4 — verify:** run the full suite under a Windows runner (or
`process.platform` shim where feasible) and confirm 0 failures; re-run Linux +
main `test` job to confirm no regression (`toPosix` and `basename` are no-ops on
POSIX).

---

## What is explicitly NOT broken (verified clean)

- `src/core/secrets-age.ts` `resolveIdentityDir` precedence — correct.
- `src/wiki/storage.ts` path construction — uses `join`/`dirname`; emits native
  separators (correct), only the *test* substring assert is wrong.
- `src/protocols/acp/flows.ts` action node `cwd` plumbing — correct; passes
  `actionCwd` to `Bun.spawn`.
- `src/adapters/shared/vscode-paths.ts` Linux/macOS branches and the
  Linux-case-sensitivity candidate emission — correct.
- The `withConfig` AsyncMutex serialization (ADR-0040) — correct; RC6 is timing,
  not locking.
