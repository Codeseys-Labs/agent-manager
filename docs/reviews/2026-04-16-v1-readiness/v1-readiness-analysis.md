# v1.0 Readiness Analysis — agent-manager

**Date:** 2026-04-16  
**Reviewer:** Team analysis agent  
**Scope:** v1.0 release readiness — test coverage, security, API stability, documentation, CLI completeness  
**Version analyzed:** 0.3.0 (Unreleased / Iteration 3)

---

## Executive Summary

agent-manager is in **strong shape for a v1.0 release** with targeted fixes. The architecture is sound, the 1470-test suite covers all critical paths, and the two MEDIUM bugs identified in the prior comprehensive review (2026-04-15) have already been fixed. The remaining gaps before calling this v1.0 are: three focused code quality fixes, shell completion support, an error codes reference, and a stability signal on the ADR-0027 community adapter feature (which should be clearly marked experimental or deferred to v1.1).

---

## 1. Test Coverage for New Modules

### `src/protocols/bridge.ts` — Well-Tested

`test/protocols/bridge.test.ts` covers the full surface:

- `parseBridgeRequest`: 9 cases — text format, data part format, data-wins-over-text precedence, null returns for missing fields, empty messages, missing colon separator
- `createBridgeTaskHandler`: 3 cases — unknown agent error, non-matching message guidance, ACP connect failure path
- `createBridgedTaskHandler`: 2 cases — routing to bridge vs. falling through to default
- A2A server integration with `enableBridge: true/false`: 4 cases — routing, fallthrough, explicit disable, data part format

**Missing edge cases** (not blocking v1.0, but worth adding in v1.1):
- Bridge with multi-part messages containing both text and data parts where the text also matches bridge pattern
- Bridge with `prompt` field containing newlines or special characters
- `createBridgeTaskHandler` with a custom `bridgeConfig.timeout` to verify timeout is passed through

**Assessment:** Good coverage for a v1 release. Bridge is simple enough that the 9 parse tests plus 4 integration tests provide high confidence.

---

### `src/protocols/acp/client.ts` — Adequate, One Gap

`test/protocols/acp/client.test.ts` covers:

- Registry: all `resolveAgent` branches, `listAgents`, `parseCommand` edge cases (empty, whitespace, multi-space)
- Pre-connection errors: all methods that require a connection (`newSession`, `prompt`, `cancel`, `loadSession`, `listSessions`)
- `connectByName` with unknown agent
- Disconnect safety when not connected
- Schema validation for ACP settings (8 cases)

**State accumulation test was added** in response to the prior review — `_handleSessionUpdate` state accumulation is now tested in the `"resets collected text/toolCalls between prompts"` test. The fix (`resetCollected()` at line 188 of `client.ts`) is confirmed in place.

**Missing:** No integration tests for a real ACP subprocess. The comment in `run.test.ts` correctly documents this as out of scope for unit tests. This is acceptable.

---

### `src/protocols/a2a/server.ts` — Thoroughly Tested

`test/protocols/a2a/server.test.ts` has 36 tests across 8 describe blocks:

- Agent Card: valid structure, field presence
- `tasks/send`: async response shape, history recording, handler error → failed state
- `tasks/get`: polling while working, not-found error, missing id, historyLength trimming (0 and 1)
- `tasks/cancel`: cancels working task, cannot cancel completed, cancel-then-complete race (handler completion does NOT overwrite canceled state)
- Unknown method: -32601 error
- Store isolation: two createA2ARoutes calls have independent stores
- Store eviction: >1000 tasks triggers eviction, TTL backdating, no eviction within TTL, working tasks never evicted
- `TaskEventEmitter`: emit, no cross-task emit, off, removeAll
- `tasks/sendSubscribe` SSE: status stream, failure stream, artifact events, missing params error, non-streaming path still works, bearer token auth on SSE

**The cancel-then-complete race condition test** is particularly valuable — it directly validates the `TERMINAL_STATES.includes(task.status.state)` guard in `startTask()`.

**Missing (not blocking):**
- No test for `tasks/sendSubscribe` with client disconnect (abort signal path at line 639)
- No test for concurrent `tasks/send` calls with the same task ID (second send reuses existing task)

---

## 2. Security Audit of the Bridge

### A2A → ACP Agent Name Validation

**Finding: Agent name passes through `resolveAgent()` without additional sanitization, but is safe.**

The flow when an A2A request routes to the bridge:
1. `parseBridgeRequest()` extracts `agent` from text pattern `(\S+)` or from a data part field
2. `resolveAgent(request.agent, acpSettings)` looks up the name in the built-in registry (hardcoded map) or config overrides
3. If not found, returns an error message — the command is **never executed**
4. If found, `client.connect(entry.command, ...)` spawns the registered command

**No arbitrary command execution is possible via the agent name field.** The registry acts as an allowlist. An attacker who controls the A2A request can specify any agent name, but can only trigger execution of commands that are:
- In the built-in `BUILT_IN_REGISTRY` (hardcoded at compile time), or
- In `acpSettings.agents` from the local TOML config (controlled by the local user)

The `parseCommand()` function splits on whitespace — quoted arguments with embedded spaces would be split incorrectly, but this only affects user-defined config commands, not attacker-supplied names.

**Verdict: Safe.** The agent name is effectively an allowlist lookup, not a shell eval.

---

### Can a Remote A2A Client Execute Arbitrary Commands?

**No, with one caveat.**

The attack surface:
1. `tasks/send` with bridge enabled: agent name → `resolveAgent()` allowlist lookup → safe
2. `tasks/send` with bridge disabled: routes to `defaultTaskHandler` which handles only hardcoded commands ("status", "config", "servers", etc.) — no execution
3. The `prompt` passed to the ACP agent is forwarded verbatim to the spawned agent subprocess

**The caveat:** The prompt text itself is passed to the agent. If an attacker can reach the A2A endpoint, they can send arbitrary prompts to whichever ACP agent is invoked. This is inherent to the feature — driving an agent headlessly means the agent will act on the prompt. The bearer token auth (`auth_token` option) is the correct mitigation: without it, anyone who can reach the A2A server port can drive local agents.

**Recommendation for documentation:** The README and `am serve` help text should explicitly state that `enableBridge: true` should always be paired with `auth_token`. This is currently described in code but not in user-facing docs.

---

### Input Sanitization on "run <agent>: <prompt>" Pattern

The regex in `parseBridgeRequest()`:
```typescript
const match = part.text.match(/^run\s+(\S+):\s*(.+)$/is);
```

- `(\S+)` captures the agent name: no whitespace, no path separators, no shell metacharacters in a typical agent name. This is fine.
- `(.+)$` captures the prompt: allows anything including newlines (`s` flag), shell metacharacters, etc. This is expected — it's forwarded to the agent as a text prompt, not to a shell.

**The prompt is NOT passed to `sh -c`** — it goes to `conn.prompt()` as a `ContentBlock[]`. The ACP protocol handles it as structured data, not as a shell string. No shell injection risk on this path.

---

### Timing Attack on Bearer Token

`src/protocols/a2a/server.ts:454`:
```typescript
if (!authHeader || authHeader !== `Bearer ${auth_token}`) {
```

String comparison is not constant-time. For a locally hosted service this is acceptable (same-machine timing attacks are impractical). If this endpoint is ever exposed publicly, switch to `crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(...))`.

**Not a blocker for v1.0 given local-first design principle.**

---

## 3. v1.0 Blocking Items

### Confirmed Fixed Before This Review

The comprehensive review (2026-04-15) identified two MEDIUM bugs:

1. `parsePositiveInt` accepted 0 — **Fixed.** `parsed <= 0` is now the check (line 44, `src/lib/output.ts`).
2. `AmAcpClient.prompt()` did not reset collected state — **Fixed.** `resetCollected()` is called at line 188 of `client.ts`.

### Remaining Issues (Prioritized)

#### BLOCKER — `runMainCommand` double-definition in `run.ts`

**File:** `src/commands/run.ts`

Two `defineCommand` blocks with identical args exist: `runMainCommand` (inner, line ~63) and `runCommand` (outer, line ~353). The delegation `runMainCommand.run!({ args: args as any })` at line ~407 uses an `as any` cast. This pattern:
- Confuses contributors (two command definitions, one never registered in `cli.ts`)
- Uses the only remaining `as any` cast in command code
- Will silently break if args diverge between the two definitions

Fix: Extract the run logic to a shared `async function executeRun(args, opts)` that both the direct invocation and the subcommand delegation call.

**Why it's a blocker:** The `as any` cast specifically bypasses citty's runtime arg validation, and `run` is a high-value new command in iteration 3.

---

#### HIGH — Dead `Bun.file()` call in `config.ts`

**File:** `src/core/config.ts` (~line 34)

A `Bun.file(candidate)` call creates a file object that is immediately discarded. The actual existence check is done by the following `require("node:fs").accessSync(candidate)`. The dead call misleads contributors into thinking `Bun.file` throws on missing files (it doesn't).

Fix: Remove the `Bun.file()` line. The `accessSync` call is sufficient and already present.

---

#### HIGH — `addInstruction` bypasses type safety in `add.ts`

**File:** `src/commands/add.ts` (~lines 237-248)

An `Instruction` object is constructed without its required `content` or `content_file` field, then those fields are assigned via `as Record<string, unknown>`. The runtime behavior is correct (Zod validates on read), but the pattern teaches contributors a bad pattern and produces misleading TypeScript.

Fix: Use conditional spread:
```typescript
const instruction: Instruction = {
  scope: scope as Instruction["scope"],
  ...(content ? { content } : { content_file: contentFile! }),
  // ...other optional fields
};
```

---

#### MEDIUM — `amError` dead if/else in `output.ts`

**File:** `src/lib/output.ts` (~lines 26-32)

Both branches of the if/else call `console.error(formatted)` with identical code. The conditional is dead.

Fix: `console.error(formatError(err, !!opts.json))` directly.

---

#### LOW — `require()` pattern in adapters should be documented

Adapters use inline `require("node:fs")` while `config.ts` uses top-level imports. This is intentional (lazy loading for synchronous operations in try/catch), but confuses contributors. Add a comment to CLAUDE.md explaining the rationale. No code change needed.

---

### Not Blocking v1.0

- ADR-0027 (community adapter loading) and ADR-0028 (brownfield import merge): well-documented as future work, not yet implemented. Their ADRs exist but no corresponding code ships in v1. Mark them "proposed" status in the ADR front matter if not already done.
- Windows path separator failures (59 pre-existing, CI `continue-on-error`): documented, acceptable for v1.
- `terminalStore` module-scope leak: low-priority resource management issue, not data-loss or security risk.
- Remaining `require()` inconsistency: documentation fix only.

---

## 4. ROADMAP Accuracy

### What is Correctly Marked "Done"

All items in the ROADMAP "Implementation Status" sections accurately reflect the code:

- Core Engine (8 items) — All verified present in `src/core/`
- IDE Adapters 13 — All verified in `src/adapters/`
- Platform Adapters 3 — Verified in `src/platforms/`
- CLI 28 commands — Verified in `src/commands/` and `src/cli.ts`
- MCP Server 33 tools — Matches `src/mcp/server.ts` tool count
- A2A Protocol — All components verified in `src/protocols/a2a/`
- ACP Agent Orchestration — All components verified in `src/protocols/acp/` and bridge.ts
- Distribution — CI/release workflows verified

### ROADMAP Accuracy Gaps

**ADR count mismatch:** ROADMAP says "28 ADRs" in the stats block, but the ADR index lists 29 (ADR-0029 is command grouping, dated 2026-04-15). The ROADMAP ADR Index only goes to ADR-0028. ROADMAP stats need updating to say 29 ADRs.

**ADR-0029 (Command Grouping) not in ROADMAP ADR Index.** It should be added.

**Phase 2 A2A item marked done but in "Planned" list:**
```markdown
- [x] A2A agent authentication (Bearer tokens for roster entries) — done in iteration 3
```
This item is correctly checked off but still appears in the "Planned — Next Sessions" section. The section header is misleading — this item is done and should be moved to the "Implementation Status" section or removed from Planned.

**Community adapters (ADR-0027) and brownfield import (ADR-0028)** exist as ADRs but have no corresponding implementation. The ROADMAP does not list them under any status section — they should appear under "Deferred — Future Sessions" with a note that the ADR has been accepted.

---

## 5. Missing Features for a CLI Release

### Shell Completions — Missing

No shell completion scripts exist for bash, zsh, or fish. For a tool with 28 commands and multiple subcommands (wiki, agents, run, secret, profile each have 3-13 subcommands), tab completion significantly reduces the learning curve.

**Recommended path:** citty-based CLIs can add completions via a hidden `am completions bash/zsh/fish` command that outputs the completion script. This is a one-session implementation and matters more than most other polish items.

**Blocking for v1.0?** No, but should be in v1.1 scope. Add to ROADMAP.

---

### Man Pages — Missing

No man pages exist. For a single-binary CLI targeting developers, this is a nice-to-have for Linux/macOS users but not a strict requirement for v1.0. The `--help` output is well-structured (grouped via ADR-0029).

**Blocking for v1.0?** No.

---

### Error Codes Documentation — Partially Missing

`src/lib/errors.ts` defines the `AmError` class and helper functions. The MCP server JSON errors include `code` fields (JSON-RPC codes: -32700, -32600, -32601, -32602, -32001, -32003) and application-level `hint` fields.

However, there is no user-facing documentation of:
- What exit codes the CLI uses (`process.exitCode = 1` is the only non-zero exit, used uniformly for errors)
- What JSON error shapes `--json` mode produces for scripting consumers
- The JSON-RPC error codes for A2A server callers

The MCP tool error format is documented indirectly via ADR-0009 but not in a standalone reference.

**Recommendation:** Add an "Error Reference" section to the README or a `docs/error-reference.md` covering: CLI exit codes, `--json` error shape, and A2A JSON-RPC error codes. This is important for scripting users and AI agents using the MCP server.

**Blocking for v1.0?** The JSON error shape from `--json` mode is undocumented — this affects users who build scripts against `am`. Add at minimum a brief section to the README.

---

### Version Command — Present and Correct

`am version` and `am version --json` both work. The `--json` output is correct.

---

### `am doctor` — Present and Thorough

8 health checks covering: git init, config parse, encryption key, adapters, BetterLeaks, MCP, git remote, and push permission. This is a good first-run experience.

---

## v1.0 Checklist

### Blockers (must fix before v1.0 tag)

- [ ] **Fix `runMainCommand` double-definition** in `src/commands/run.ts` — extract shared function, eliminate `as any` cast
- [ ] **Remove dead `Bun.file()` call** in `src/core/config.ts`
- [ ] **Fix `addInstruction` double type cast** in `src/commands/add.ts` — use conditional spread
- [ ] **Fix dead `amError` if/else** in `src/lib/output.ts`
- [ ] **Document `--json` error output shape** — add to README or docs/error-reference.md
- [ ] **Add ROADMAP entry** for ADR-0029 (command grouping, already done)
- [ ] **Move done A2A auth item** from "Planned" to "Implementation Status" in ROADMAP
- [ ] **Document bridge + auth_token security requirement** in README's A2A section

### Should-Have (v1.0 polish, not strict blockers)

- [ ] Document `require()` pattern rationale in CLAUDE.md
- [ ] Add ADR-0027 and ADR-0028 to ROADMAP "Deferred" section (ADRs exist but no code)
- [ ] Fix ROADMAP stats: "28 ADRs" → "29 ADRs"

### Can Defer to v1.1

- [ ] Shell completions (`am completions bash/zsh/fish`)
- [ ] Man pages
- [ ] `tasks/sendSubscribe` client disconnect test (SSE abort signal path)
- [ ] Concurrent `tasks/send` with same task ID test
- [ ] Bridge edge case tests (multi-part messages, newlines in prompt)
- [ ] Constant-time bearer token comparison (`crypto.timingSafeEqual`)
- [ ] `terminalStore` module-scope cleanup on process exit
- [ ] LLM-powered wiki extraction (Phase 2)
- [ ] Full skill/agent drift detection across all 13 adapters

### Release Criteria Met

- [x] 1470 tests passing, 4312 assertions
- [x] Zero `as any` in protocol modules (bridge, a2a/server, acp/client)
- [x] Zero `catch (err: any)` in src/
- [x] AES-256-GCM secret encryption
- [x] Bearer token auth on A2A server
- [x] TTL + capacity eviction on task store
- [x] Cancel-then-complete race condition covered by test
- [x] Per-instance task store (no global singleton)
- [x] Two MEDIUM bugs from 2026-04-15 review confirmed fixed
- [x] CI workflow covers: typecheck, lint, test coverage, 5-platform build
- [x] Release workflow covers: binaries, checksums, npm, Homebrew

---

## Overall Verdict

**Ready for v1.0 with the 8 blockers addressed.** The architecture is clean, the test suite is comprehensive for the complexity level, and the two previously identified MEDIUM bugs are confirmed fixed. The remaining blockers are all small, targeted fixes (30-60 minutes of work total) plus documentation additions. No architectural rework is needed.

The biggest open question for v1.0 positioning is whether ADR-0027 (community adapters) and ADR-0028 (brownfield merge) should be described as v1.1 roadmap items in the README. The ADRs exist and are well-written, but the code does not exist. Making this explicit in the README sets accurate user expectations.
