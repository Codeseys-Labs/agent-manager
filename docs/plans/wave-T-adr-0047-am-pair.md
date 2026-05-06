# Wave T — ADR-0047 `am pair accept` / `am pair finalize` CLI implementation

**Status:** ready-to-execute (plan only; no code in this doc)
**Source ADRs:** [0047](../../ADRs/0047-am-pair-cross-device-key-handoff.md), [0042](../../ADRs/0042-universal-secrets-strategy.md)
**Source reference implementations:** `src/commands/secrets-revoke.ts` (recipient-management verb pattern), `src/core/secrets-age.ts` (`addRecipient` / `listRecipients` / rewrap mechanics)
**Estimated total:** 3 sub-tasks, ~650 LOC, ~$5 OpenRouter cost at 2-way parallel

## Goal

Ship the two CLI verbs specified in ADR-0047:

```
am pair accept <name>      # new device: generate identity, publish .pub, push
am pair finalize           # original device: pull, detect new .pub, rewrap, push
```

After Wave T, a user can add a new laptop to their config repo using only git and the two new verbs — no pairing token, no QR code, no PAKE relay. The flow is the one worked through in ADR-0047 §Flow, §Implementation sketch.

## Non-goals

- PAKE rendezvous (Magic Wormhole / SPAKE2) — rejected by ADR-0047 §Rationale.
- QR-bridge pairing — rejected by ADR-0047 §Rationale.
- Hardware-token-bound pairing (YubiKey, Secure Enclave) — ADR-0047 §Out of scope #2.
- Signature verification on `.pub` files — ADR-0047 §Out of scope #3; ACL is the trust boundary for Phase-1.
- Browser-only first-device bootstrap — ADR-0047 §Out of scope #1; covered by ADR-0043.
- Dedicated `am pair revoke` verb — deferred per ADR-0047 §Out of scope #4 (existing `am secrets revoke` covers the functionality).

## Acceptance criteria (test-first, executable)

Each test names the file + describe + it. All must pass to call Wave T done.

1. `test/commands/pair-accept.test.ts` `describe("am pair accept")`:
   - `it("generates identity.age, writes recipients/<name>.pub, appends to .am-secrets.toml")`
   - `it("commits with 'am: pair device <name>' and pushes to origin")` (uses a local bare-repo fixture)
   - `it("fails cleanly when origin push is rejected (read-only remote)")` — asserts instruction text to commit `.pub` manually via another device
   - `it("disambiguates with random suffix on recipient-name collision (laptop → laptop-a3f9)")`
   - `it("--dry-run prints planned file writes + commit message without mutating disk or repo")`
   - `it("--json envelope matches the shared CLI schema (status, output, errors)")`

2. `test/commands/pair-finalize.test.ts` `describe("am pair finalize")`:
   - `it("detects new recipients from pulled refs and prompts before rewrap")`
   - `it("on confirm, rewraps every enc:v2:age value, commits 'am: rewrap for <name>', pushes")`
   - `it("on refuse, leaves repo untouched (no rewrap, no commit)")`
   - `it("rejects a malicious .pub that is syntactically invalid (not age1...)")`
   - `it("aborts atomically when any ciphertext fails to decrypt; no partial rewrap committed")`
   - `it("--dry-run lists recipients that would be rewrapped without mutating envelopes or repo")`
   - `it("--json envelope matches the shared CLI schema")`

Total: 13 acceptance tests across 2 test files. (Plus T3 wires them through the router; no additional tests at that layer beyond a smoke test that `am pair --help` lists both subcommands.)

## File-ownership map

Three sub-tasks. T1 + T2 are parallelizable (they touch independent files and share no state beyond existing `AgeSecretsBackend`). T3 sequences after both and is trivial wiring.

### T1 — `am pair accept` command (~270 LOC, no deps within Wave T)

**Owns:**
- `src/commands/pair-accept.ts` (NEW, ~150 LOC)
  - Citty `defineCommand` matching the pattern in `src/commands/secrets-revoke.ts`.
  - Positional arg: `<name>` (the hostname / device label).
  - Flags: `--repo <url>` (optional; otherwise requires `git remote get-url origin` success), `--dry-run`, `--json`, `--force` (skip confirmation prompt).
  - Flow (mirroring ADR-0047 §Implementation sketch Step 1):
    1. Resolve config dir via `resolveConfigDir()`.
    2. If no local git repo present in config dir, clone from `--repo` or fail with instruction to set `origin`.
    3. Invoke `AgeSecretsBackend.init()` / equivalent to generate `~/.config/agent-manager/identities/identity.age`, prompting for master passphrase (via existing `PassphraseProvider`).
    4. Compute `age1...` recipient via `identityToRecipient()` (imported from `age-encryption`).
    5. Check for `recipients/<name>.pub` collision; if present, append 4-hex-char suffix and warn.
    6. Write `recipients/<name>.pub` with recipient line + `# id: <name>` comment.
    7. Edit `.am-secrets.toml` `[age].recipients` list — append `"recipients/<name>.pub"`. Use existing `@iarna/toml` helper (already a dep).
    8. `git add recipients/<name>.pub .am-secrets.toml`, `git commit -m "am: pair device <name>"`, `git push origin HEAD`.
    9. On push failure, surface ADR-0047 §Implementation sketch Step 1 fallback text verbatim.
  - `--dry-run` short-circuits after step 4 and prints the planned changes (file list + commit message) without mutating disk or repo.
  - `--json` wraps output in the shared CLI envelope (existing `output` / `amError` helpers from `src/lib/output.ts`).
- `test/commands/pair-accept.test.ts` (NEW, ~120 LOC) — 6 tests from acceptance §1.

**Uses:**
- Existing: `AgeSecretsBackend`, `PassphraseProvider`, `resolveConfigDir`, `atomicWriteFile`, `output`/`amError`, `@iarna/toml`, `simple-git` (or existing git helper if present; search before adding).
- No new npm deps.

### T2 — `am pair finalize` command (~330 LOC, no deps within Wave T)

**Owns:**
- `src/commands/pair-finalize.ts` (NEW, ~180 LOC)
  - Citty command with no positional args.
  - Flags: `--dry-run`, `--json`, `--yes` (skip confirmation).
  - Flow (mirroring ADR-0047 §Implementation sketch Step 2):
    1. `git pull` (fast-forward only) from `origin`.
    2. `listRecipients()` via `AgeSecretsBackend`.
    3. Walk every TOML under management (via existing `discoverTomlFiles` from `secrets-rewrap-helpers.ts`) and collect the union of recipient fingerprints referenced by existing `enc:v2:age:` ciphertexts. (Heuristic: a recipient `.pub` whose fingerprint is NOT in the wrapped-recipient union is "new".)
    4. Print the new-recipient list (name + 10-hex fingerprint + file path).
    5. Prompt `Rewrap N encrypted values to include <names>? [Y/n]` unless `--yes`.
    6. On confirm, call `rewrapMany()` from `secrets-rewrap-helpers.ts`. Abort atomically if any single ciphertext fails to decrypt — revert all in-memory edits, log the offending file, exit non-zero.
    7. `git add -A && git commit -m "am: rewrap for <comma-joined-names>" && git push origin HEAD`.
    8. Invoke `bestEffortCommitSecretsChanges` if a committed state is desired; otherwise the explicit commit above is authoritative.
  - Validation: reject any `.pub` that does not start with `age1` (syntactic check; ADR-0047 §trade-offs acknowledges no cryptographic binding in Phase-1).
  - `--dry-run` prints the new-recipient list and the rewrap plan without mutating envelopes or repo.
- `test/commands/pair-finalize.test.ts` (NEW, ~150 LOC) — 7 tests from acceptance §2.

**Uses:**
- Existing: `AgeSecretsBackend.listRecipients`, `secrets-rewrap-helpers` (`discoverTomlFiles`, `rewrapMany`), `bestEffortCommitSecretsChanges` from `secrets-commit-helper.ts`, `output`/`amError`.
- No new npm deps.

### T3 — `am pair` router + schema integration (~50 LOC, deps: T1 + T2)

**Owns:**
- `src/commands/pair.ts` (NEW, ~30 LOC)
  - Citty `defineCommand` with `subCommands: { accept: pairAcceptCommand, finalize: pairFinalizeCommand }`.
  - `meta.description` references ADR-0047 one-liner.
- `src/cli.ts` — register `pair` subcommand (~5 LOC edit).
- `src/core/config-schema.ts` — no change expected (recipient list already defined by ADR-0042 work); add a smoke-test assertion in a new test that `parseConfig({...})` accepts the shape produced by `pair accept`. ~15 LOC.
- Optional: `README.md` verb table update, `docs/cli.md` if it exists — T3 keeps doc edits minimal; final polish in Phase-9 documentation pass.

**Tests:** one integration smoke test `test/commands/pair-router.test.ts` (~20 LOC) verifies `am pair --help` lists `accept` and `finalize` and that each delegates correctly.

## Risks + rollback

| Risk | Likelihood | Impact | Mitigation / rollback |
|------|------------|--------|-----------------------|
| `am pair accept` and `am secrets rotate` run concurrently → wrap race | Med | Partial rewrap / missing recipient | ADR-0047 §Trade-offs documents the workflow-discipline expectation; T2 uses `git pull --ff-only` pre-rewrap, rejects if local HEAD diverged since pull; operator retries. |
| New device reuses an existing hostname → silent impersonation | Low | One device's identity overwrites another's | T1 collision check + random-suffix fallback (ADR-0047 §Collision handling). |
| `rewrapMany` partial failure leaves repo in an inconsistent state | Med | Mixed old/new recipient sets across files | T2 performs decrypt-all-first then re-encrypt-all; abort before writing on any decrypt error; no partial writes. |
| Network push failure mid-flow | Med | Local state ahead of remote | Standard git behavior: local commit stays; operator re-runs push manually. T1/T2 surface explicit remediation text. |
| Malicious collaborator commits a `recipients/*.pub` with a valid-looking age1 key | Low (Phase-1) | Unwanted read access after finalize | ADR-0047 §trade-offs: ACL is the trust boundary. `finalize` prompt surfaces the new name; operator can refuse. Out-of-scope for Phase-1 is cryptographic countersignature. |
| `.am-secrets.toml` TOML formatting drift after T1 edit | Low | Merge conflicts | Use existing `@iarna/toml` serialize round-trip helper (same one used by `secrets-revoke`); add a fixture test in T1 asserting byte-stable output for unchanged sections. |

**Rollback plan:** Single git revert of Wave T merge commit. `src/commands/pair*.ts` disappear; `am pair` exits "unknown command". Users who had already run `pair accept` on a branch keep their generated identity and `.pub` file — both are valid independent of the verb; `am secrets rewrap` remains available as the manual fallback path that ADR-0047 §Rationale already documents.

## Budget estimate

- Total LOC: ~360 (impl) + ~290 (tests) = ~650 LOC.
- Estimated subagent cost: 3 sub-tasks × ~$1.5 each = ~$4-5 in OpenRouter spend.
- Wall-clock at 2-way parallel: T1 ∥ T2 (~30 min) → T3 (~15 min) = ~45 min.

## Verification gates (Phase-1 done = ALL green)

Maps directly to ADR-0047 §Verification gates (the ADR is design-only; Wave T implements it, so these are Wave T's own gates):

1. ✅ All 13 acceptance tests pass (`bun test test/commands/pair-*.test.ts`).
2. ✅ `bun run lint` clean.
3. ✅ `bun run typecheck` clean (no new errors under `src/commands/pair*`).
4. ✅ Manual two-device smoke test: on laptop A run `am pair accept laptop-b` against a throwaway repo; on laptop B run `am pair finalize`; laptop A can read values written by laptop B post-rewrap. Log to `docs/runbooks/pair-smoke-2026-05-06.md`.
5. ✅ `--help` output for `am pair`, `am pair accept`, `am pair finalize` matches the UX shown in ADR-0047 §Flow.
6. ✅ `--json` envelope for both verbs validates against the shared CLI output schema (existing tests in `test/lib/output.test.ts` pattern).
7. ✅ ADR-0042 §Verification gate 5 (`am pair` command surface **designed AND implemented**) — ADR-0047 closed the "designed" half; Wave T closes the "implemented" half. Update ADR-0042 footer.

## Sequencing

```
Round 1 (parallel, 2 subagents): T1 (pair-accept) ∥ T2 (pair-finalize)
Round 2 (sequential, 1 subagent): T3 (router + schema + smoke test)
Round 3 (sequential, 1 subagent): Phase-8 cross-family review (3 reviewers)
Round 4 (sequential, 1 subagent): Documentation (README verb table, ADR-0042 gate 5 footer update)
```

Total: 4 subagent rounds, ~$5 cost, ~1 hour wall-clock at 2-way parallel.

## DEPENDENCY

**None.** Wave T is entirely CLI-side. No web dependencies, no browser dependencies, no asset-pipeline dependencies. It depends only on existing stable surfaces:

- `AgeSecretsBackend` (shipped)
- `secrets-rewrap-helpers` (shipped)
- `secrets-commit-helper` (shipped)
- `@iarna/toml`, `citty`, `age-encryption` (existing deps)

Can land in parallel with Wave Q / Wave R / Wave S without coordination.

## How to execute

In a future deep-work-loop run:

```
delegate_task(tasks=[
  { goal: "Wave T sub-task T1: am pair accept command",
    context: "<this plan + ADR-0047 + secrets-revoke.ts reference + acceptance tests §1>",
    model: "anthropic/claude-opus-4.7", provider: "openrouter",
    toolsets: ["file", "terminal"] },
  { goal: "Wave T sub-task T2: am pair finalize command",
    context: "<this plan + ADR-0047 + secrets-rewrap-helpers reference + acceptance tests §2>",
    model: "anthropic/claude-opus-4.7", provider: "openrouter",
    toolsets: ["file", "terminal"] },
])
```

Wait for both T1 + T2 to land + commit. Then dispatch T3.

Phase-8 review prompt template lives in the deep-work-loop skill's `references/PHASES.md`. Each reviewer model from a different family (suggested: anthropic + openai + deepseek).

## What this plan does NOT solve

- Cryptographic countersignature on `.pub` files (ADR-0047 §Out of scope #3 — deferred until multi-tenant adoption).
- Browser-only first-device bootstrap (ADR-0047 §Out of scope #1 — covered by ADR-0043).
- Dedicated `am pair revoke` verb (ADR-0047 §Out of scope #4 — existing `am secrets revoke` suffices).
- CI-bot self-pairing (ADR-0047 §Trade-offs — deliberately disallowed).

## When to invoke this plan

User says one of:
- "Ship `am pair`"
- "Wave T"
- "Implement ADR-0047"
- "Close ADR-0042 gate 5"

Do NOT execute partially. T1 without T2 leaves a new device that can publish its `.pub` but no original device can rewrap to grant it access — users will think the CLI is broken. Either run all 3 sub-tasks to completion or revert the lot.
