---
status: draft
date: 2026-05-01
relates-to: issue #2 (post-v0.5.0-rc6), ADR-0033 Phase G, .github/workflows/ci.yml:54-56
tmp.ts-fix: commit a064fa4
---

# Windows CI Re-baseline Plan

## Goal

Snapshot the true Windows test failure count after the `tmp.ts` POSIX fix
(commit a064fa4), decide whether the count is below the ~50 threshold that
unlocks removing `continue-on-error: true`, and produce a ranked follow-up task
list if it is not.

## Acceptance Criteria

1. A CI run on `blacksmith-2vcpu-windows-2025` completes and the exact failure
   count is recorded in this document under "Re-baseline Result".
2. If count < 50: `.github/workflows/ci.yml` lines 54-56 have `continue-on-error`
   removed. Windows is a first-class CI target.
3. If count ≥ 50: a ranked follow-up task list (one issue per hazard cluster)
   is filed and linked here. `continue-on-error` remains until a subsequent run
   drops below 50.
4. ADR-0033 Phase G is explicitly deferred — this is a snapshot, not the
   systematic portability pass.

## Pre-run Audit Findings

Hazards found by reading `src/` and `test/`. None require code changes before
the re-baseline run — recorded so post-run triage can map failures to causes.

### 1. `src/adapters/shared/marketplace-vscode.ts` — no Windows path in `EXTENSION_DIRS`

Lines 28-45. `EXTENSION_DIRS` maps adapter names to `{ darwin, linux }` only.
`getExtensionsDir` at line 70 falls back to `linux` for any non-darwin platform.
On Windows, that returns a POSIX-style path rather than `%APPDATA%\Code\User\extensions`.
Any test exercising `scanVSCodeExtensions` on Windows will either use the wrong
directory or fail an assertion. Affects copilot, cursor, kiro, windsurf adapters.

### 2. `test/core/config.test.ts` — hardcoded POSIX path assertion

Line ~36: `expect(result).toEndWith("/.config/agent-manager")`. On Windows the
separator is `\`; the assertion will always fail. Note: `resolveConfigDir()`
does not special-case `win32` — it always uses `~/.config/agent-manager`.

### 3. `src/adapters/claude-code/session.ts` — POSIX-only `encodeProjectPath`

Lines 52-53: strips leading `/` and replaces `/` with `-`. Windows paths use
backslashes and drive letters; the leading-slash strip is a no-op and
backslashes aren't replaced. Test fixtures pass POSIX strings explicitly, so
tests pass on Linux/macOS and silently break on real Windows paths.

### 4. `test/core/atomic-write.test.ts` — `chmod`/file-mode test

`atomicWriteFileSync(target, "...", { mode: 0o600 })` then
`expect(statSync(target).mode & 0o777).toBe(0o600)`. Windows NTFS does not
honour POSIX chmod via Node's fs; the test fails on Windows.

### 5. `src/protocols/acp/env-sandbox.ts` — `TMPDIR` only, not `TEMP`/`TMP`

Default allow-list includes POSIX `TMPDIR` but not Windows `TEMP`/`TMP`.
Subprocess child won't get the temp dir via the expected var name.

### 6. `src/protocols/acp/client.ts` — `Bun.spawn` executable resolution

`parseCommand` splits the agent command; Bun.spawn on Windows may need `.cmd`
suffix handling for `npx`/`node`-adjacent commands. Likely a source of ACP
integration test failures.

### 7. `src/protocols/acp/shell-wrapper.ts` — stdin pipe lifecycle

Default `promptTemplate: "stdin"` writes to `proc.stdin`. Bun's Windows stdin
pipe has had edge cases with subprocess exit timing; shim tests using `stdin`
may flap on Windows.

### 8. `src/wiki/storage.ts` — `symlinkSync` requires Developer Mode

Lines 20 (import), 93-110 (`createProjectWikiLink`). Unprivileged symlink
creation on Windows requires Developer Mode. CI runner may not have it;
`EPERM` on any wiki-link test.

### 9. `src/core/git.ts` — `.gitignore` newline convention

Writes LF-only line endings. Likely fine since isomorphic-git is a pure-JS
implementation that doesn't depend on system git conventions. Audit note only.

### 10. `src/commands/run.ts` + ACP tests — `ENOENT` error message text

Windows `ERROR_FILE_NOT_FOUND` wording differs from POSIX `ENOENT`. Tests
asserting error message text may fail.

## Steps for the CI Re-run

### Step 1 — Trigger the run

```bash
git commit --allow-empty -m "ci: trigger Windows re-baseline post a064fa4 tmp.ts fix"
git push origin main
```

No workflow changes needed — `continue-on-error: true` at `ci.yml:54-56`
already allows the job to fail and still report.

### Step 2 — Capture the failure count

In the Actions run, expand the "Run tests" step for the Windows job. The script
at `ci.yml:65-74` extracts the count:

```bash
FAIL_LINE=$(echo "$OUTPUT" | grep -E '^ [0-9]+ fail$' | tail -1)
FAIL_COUNT=$(echo "$FAIL_LINE" | awk '{print $1}')
```

Record as `NEW_FAIL_COUNT`.

### Step 3 — Record the result

Update "Re-baseline Result" below with run date, commit SHA, `NEW_FAIL_COUNT`,
and Actions run URL.

## Decision Tree

```
If NEW_FAIL_COUNT < 50:
  Remove `continue-on-error: true` from .github/workflows/ci.yml:54-56.
  Commit: "ci: remove continue-on-error Windows gate — below 50 failures"
  Close issue #2's Windows CI re-baseline line item with a link to the run.

If NEW_FAIL_COUNT >= 50:
  File one issue per hazard cluster (prioritized by likely failure impact):
    A. [Windows] Fix EXTENSION_DIRS — marketplace-vscode.ts wants win32 paths
       (affects copilot/cursor/kiro/windsurf tests in bulk)
    B. [Windows] config.test.ts toEndWith POSIX assertion — 1-line fix
    C. [Windows] atomic-write chmod test — skip or branch on win32
    D. [Windows] sandboxEnv — add TEMP/TMP to allow-list
    E. [Windows] wiki symlinkSync — guard with try/catch + warn, or skip on win32
    F. [Windows] encodeProjectPath — handle backslash + drive letters
    G. [Windows] npx/.cmd resolution in ACP client spawn
  Leave continue-on-error: true; record NEW_FAIL_COUNT as new baseline.
  Re-run after each cluster lands.
```

The 50-threshold is issue #2's documented target. Do not remove
`continue-on-error` above that threshold regardless of perceived test quality.

## Risks

1. **Runner availability.** `blacksmith-2vcpu-windows-2025` is paid.
   Mitigation: continue-on-error prevents timeout from blocking other jobs.

2. **Bun version delta.** Workflow pins `bun-version: 1.3.11` for all
   matrix entries. Confirm pinning is identical before the run.

3. **CRLF line-ending contamination.** Git checkout on Windows with
   `core.autocrlf=true` may produce CRLF in fixture files. If suspected,
   add `.gitattributes` with `* text=auto eol=lf` as pre-step.

4. **Developer Mode / symlink privilege.** Wiki symlink tests will fail without
   Developer Mode. Expected; covered by Issue E. Don't block
   continue-on-error removal if symlink failures are all that remain.

5. **Count variance between runs.** Timing-sensitive tests may flap. Take
   the average of two runs if consecutive counts differ by more than 5.

## When to Invoke Phase G

Phase G (ADR-0033 systematic portability pass) is scheduled when ALL hold:

1. `NEW_FAIL_COUNT < 50` and `continue-on-error` already removed.
2. At least one Windows user has filed a bug traceable to a code path not
   covered by Issues A-G above.
3. Team has bandwidth for a 2-3 day grep-and-fix sweep without displacing a
   Pillar 1-3 milestone.

Phase G is NOT this plan. This plan is snapshot-and-reconsider.

Until Phase G is scheduled, track Windows failure count as a metric in the
`build-verify` job summary:
```yaml
echo "## Windows: $FAIL_COUNT failures" >> $GITHUB_STEP_SUMMARY
```

## Re-baseline Result

_(To be filled in after the CI run.)_

- **Run date:**
- **Commit SHA tested:**
- **Windows failure count (NEW_FAIL_COUNT):**
- **Actions run URL:**
- **Decision taken:**
- **Follow-up issues filed:** (if count ≥ 50)
