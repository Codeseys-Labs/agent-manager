# Comprehensive Codebase Review — agent-manager

**Date:** 2026-04-15  
**Reviewer:** Fresh-eyes agent review (no prior session context)  
**Scope:** src/ source files, test/ coverage, security, conventions, contributor friction

---

## Summary Verdict

The codebase is in **good shape**. The architecture is well-designed, conventions are consistently applied, and the new modules (acp/, run.ts) are functional and tested at the right level of abstraction. There are no bugs that would cause data loss or silent failures in the main paths. There are a handful of issues worth addressing, rated by severity below.

---

## 1. Bugs and Logic Errors

### MEDIUM — `parsePositiveInt` accepts zero

**File:** `src/lib/output.ts:48`

```typescript
if (Number.isNaN(parsed) || parsed < 0) {
```

The condition `parsed < 0` permits `0` as a valid value. For the timeout use-case in `am run` (`--timeout 0`), this produces a zero-millisecond timeout that silently rejects all agent runs — `setTimeout(reject, 0)` fires immediately. For `--count 0` in `am log`, it requests 0 git entries which is technically valid but useless.

The function is named `parsePositiveInt`, not `parseNonNegativeInt`. Either rename it or change the check to `parsed <= 0`.

**Impact:** `am run claude "fix tests" --timeout 0` will fail instantly with a confusing "Prompt timed out" error rather than a clear validation message.

---

### MEDIUM — `AmAcpClient.prompt()` does not reset collected state before sending

**File:** `src/protocols/acp/client.ts:186-208`

`resetCollected()` is only called from `disconnect()` (line 249), not at the start of `prompt()`. If a caller reuses a session and calls `prompt()` multiple times on the same connection, `this.collectedText` and `this.collectedToolCalls` accumulate across turns.

```typescript
async prompt(sessionId: string, parts: PromptPart[]): Promise<PromptResult> {
  const conn = this.requireConnection();
  // ... sends prompt ...
  return {
    stopReason: response.stopReason,
    text: this.collectedText,          // ← includes text from previous prompt() calls
    toolCalls: [...this.collectedToolCalls],
  };
}
```

The current `am run` command connects, prompts once, and disconnects, so this does not manifest in practice. But it is a latent bug for any multi-turn usage (e.g., `am run session resume`). `resetCollected()` should be called at the start of `prompt()`.

---

### LOW — `as any` cast in `runCommand` breaks type safety

**File:** `src/commands/run.ts:407`

```typescript
await runMainCommand.run!({ args: args as any });
```

This delegates to the inner `runMainCommand` by bypassing citty's arg types. It works at runtime because the outer and inner `defineCommand` have identical `args` definitions. However, if args are ever diverged between the two definitions, this cast will silently pass the wrong shape. The two `args` blocks at lines 68-99 and 356-389 are indeed currently identical — the duplication itself is the underlying design issue.

A cleaner approach: extract the run logic to a standalone `async function runAgent(args, opts)` that both commands call, eliminating the cast entirely.

---

## 2. Dead Code and Unused Imports

### LOW — `runMainCommand` is defined but only used via the `as any` cast

**File:** `src/commands/run.ts:63-216`

`runMainCommand` is a complete, standalone `defineCommand` object that duplicates the args of `runCommand`. It is never registered in `cli.ts` and exists only so that `runCommand` can delegate to it. This is confusing — a new contributor will wonder why there are two nearly identical command definitions. The duplication can be eliminated by extracting the core logic into a shared function.

---

### LOW — `amError` has a vacuous conditional in `output.ts`

**File:** `src/lib/output.ts:26-32`

```typescript
export function amError(err: unknown, opts: OutputOptions): void {
  const formatted = formatError(err, !!opts.json);
  if (opts.json) {
    console.error(formatted);
  } else {
    console.error(formatted);
  }
}
```

Both branches do exactly the same thing. The `if/else` is dead logic — it should just be `console.error(formatted)`. This is a minor cleanup issue but will cause confusion for any contributor who assumes the branches differ.

---

## 3. Type Safety Issues

### LOW — `as any` count: 2 in src/ (acceptable)

The two `as any` occurrences in `src/`:

1. `src/commands/run.ts:407` — described above, MEDIUM severity
2. `src/web/server.ts:581` — `type as any` for wiki page type filtering

Both are in narrow, well-understood callsites. The rest of the codebase uses `as unknown as T` for unavoidable type bridging (TOML parsing returns `unknown`, Bun.spawn stream types, A2A JSON-RPC params). These casts are all legitimate and documented.

The 87-file count of `catch {}` empty catches is high on first glance but is appropriate — the pattern is consistent: catch empty means "this is genuinely optional and failing here should not propagate." Every empty catch I reviewed fell into one of: git commit when there's nothing to commit, skipping unreadable config files, or skipping broken session adapters. None silently swallows errors in main paths.

---

### LOW — A2A server injects task store reference via type assertion

**File:** `src/protocols/a2a/server.ts:481-488`

```typescript
(a2aApp as Hono & { _taskStore: TaskStore })._taskStore = store;
```

The pattern works but is an informal convention for test access. The `getAppTaskStore` helper on line 487 is the right mitigation — it gives tests a typed accessor. The underlying tension is that Hono doesn't have a built-in "app context" for arbitrary data. This is a known limitation, not a bug.

---

## 4. Test Coverage Gaps

### Notable: `test/commands/run.test.ts` covers CLI structure only, not execution

The test file correctly explains its own scope in the header comment:

> We cannot test the actual subprocess spawning in unit tests — those require integration tests with a real ACP agent.

The tests verify: agent resolution, command parsing, JSON output shape, CLI registration, and subcommand structure. These are the right things to test given the constraint.

**What's missing** (not a blocker, but worth noting):

- No test for `parsePositiveInt(0)` — the zero-timeout bug would have been caught with: `expect(() => parsePositiveInt("0", "timeout")).toThrow()`
- No test for the multi-prompt accumulation bug in `AmAcpClient` — a test calling `client._handleSessionUpdate(...)` twice then checking `prompt()` result would catch it
- `test/protocols/acp/client.test.ts` has good coverage of the registry and pre-connection error cases, but no test exercises `_handleSessionUpdate` state accumulation

### Coverage for new modules:

| Module | Test File | Coverage Assessment |
|--------|-----------|---------------------|
| `src/protocols/acp/client.ts` | `test/protocols/acp/client.test.ts` | Good: pre-connection errors, registry, error types. Missing: multi-turn state |
| `src/protocols/acp/registry.ts` | Same file | Excellent: all branches covered |
| `src/commands/run.ts` | `test/commands/run.test.ts` | Structure-only (appropriate) |
| `src/protocols/a2a/server.ts` | `test/protocols/a2a/server.test.ts` | Exists (not reviewed in detail) |
| `src/protocols/a2a/client.ts` | `test/protocols/a2a/client.test.ts` | Exists (not reviewed in detail) |

---

## 5. Convention Violations

### LOW — `require()` pattern in adapters is a convention inconsistency

**Files:** ~87 `require("node:fs")` calls across adapter files (e.g., `src/adapters/claude-code/import.ts:78`, `src/adapters/continue/import.ts:168`)

The top of `config.ts` uses:
```typescript
import { readFileSync } from "node:fs";
```

But most adapter files use inline `require("node:fs")` inside function bodies. CLAUDE.md says "Node `fs/promises` is acceptable" — so neither is wrong — but mixing top-level ESM imports with inline `require()` calls within the same codebase is inconsistent and will confuse new contributors.

The reason appears to be that adapters use synchronous `fs` operations inside try/catch blocks, likely to avoid async complications in the adapter interface. The `require()` pattern was chosen to keep the import lazy (avoid loading `fs` until actually needed). This is legitimate, but worth a CLAUDE.md note explaining the rationale.

### LOW — `src/core/config.ts:36` mixes `Bun.file` and `require("node:fs").accessSync`

```typescript
// Synchronous existence check via Bun.file
const f = Bun.file(candidate);
// Bun.file doesn't throw on missing — check size synchronously won't work.
// Use a simple approach: try require("fs").accessSync
require("node:fs").accessSync(candidate);
```

The comment acknowledges the workaround, but `Bun.file(candidate)` is used and then immediately discarded — it serves no purpose. The variable `f` is unused. This should be simplified to just `require("node:fs").accessSync(candidate)` or `accessSync(candidate)` with a top-level import. The dead `Bun.file()` call will confuse contributors.

---

## 6. Security Concerns

### Informational — ACP client auto-approves all agent permission requests

**File:** `src/protocols/acp/client.ts:308-313`

```typescript
async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
  // Auto-approve all permissions in headless mode.
  // Future: configurable permission policy.
  const allowOption = params.options.find((o) => o.kind === "allow_once");
  return {
    selectedOptionId: allowOption?.optionId ?? params.options[0].optionId,
  };
},
```

This is documented and intentional for headless mode. The comment mentions a future configurable policy. For the current use-case (`am run` headless agent execution), this is acceptable — the user explicitly invoked the command. However:

- There is no way to opt out at the `am run` level (no `--no-auto-approve` flag)
- If a malicious/buggy agent requests destructive permissions, they are silently granted

This is an **informational finding**, not a current bug, since `am run` is opt-in and users know they're executing agents. The future policy hook should be implemented before this is used in unattended/cron contexts.

### Informational — `terminalStore` in ACP client is module-scoped, never cleaned up on process exit

**File:** `src/protocols/acp/client.ts:394`

```typescript
const terminalStore = new Map<string, ReturnType<typeof Bun.spawn>>();
```

Terminal processes added to `terminalStore` are not killed on process exit if the connection is lost before `releaseTerminal` is called (e.g., network disconnect, `SIGKILL`). This is a minor resource leak — orphaned subprocesses will be reparented to PID 1 by the OS and eventually cleaned up, but they may run unexpectedly.

A `process.on('exit', ...)` cleanup or a WeakRef-based approach would close this, but it is low priority for the current use-case.

### Clean — Secret handling is correct

The encryption pattern (`enc:v1:nonce:ciphertext`), `redactSecrets()` in the MCP server, and the `scanServerForSecrets` auto-encrypt on `am add` flow are all correctly implemented. The key loading chain (env → key.txt) is sound. No secrets are logged.

### Clean — A2A bearer token auth is correct

`src/protocols/a2a/server.ts:452-459` — constant-time comparison is not used (`!==` vs `timingSafeEqual`), but for a local/self-hosted bearer token this is not a material concern. If this is ever exposed as a public-facing service, switch to `crypto.timingSafeEqual`.

---

## 7. Contributor Friction

### The two-command definition pattern in `run.ts` will confuse contributors

A new contributor reading `src/commands/run.ts` will encounter `runMainCommand` at line 63 and `runCommand` at line 353 — two `defineCommand` calls with nearly identical args. The delegation at line 407 (`runMainCommand.run!({ args: args as any })`) looks like a bug at first glance. A comment explaining the pattern (or eliminating the duplication) would help significantly.

### `resolveProjectConfig` uses `Bun.file` for no purpose

A contributor debugging the project config walk (`config.ts:27-44`) will see `Bun.file(candidate)` on line 34 and wonder why it's there — it creates a file object but never reads it. The immediately following `require("node:fs").accessSync(candidate)` does the actual work. This is a clarity issue that makes the code harder to understand.

### `addInstruction` in `add.ts` casts away type safety twice

**File:** `src/commands/add.ts:237-244`

```typescript
const instruction: Instruction = {
  scope: scope as Instruction["scope"],
} as Instruction;

if (content) (instruction as Record<string, unknown>).content = content;
if (contentFile) (instruction as Record<string, unknown>).content_file = contentFile;
```

The schema's `superRefine` requires either `content` or `content_file`, but the code constructs the object without either field, then assigns them via `as Record<string, unknown>` casts. This bypasses TypeScript's type checking for the very property validated by the schema.

The correct approach is to build the object conditionally:
```typescript
const instruction: Instruction = {
  scope: scope as Instruction["scope"],
  ...(content ? { content } : { content_file: contentFile! }),
  ...(args.description ? { description: args.description as string } : {}),
  ...(args.globs ? { globs: ... } : {}),
  ...(args.targets ? { targets: ... } : {}),
};
```

This is a LOW-severity code quality issue — the runtime behavior is correct because `writeConfig` will still serialize the object correctly, and Zod validates on `readConfig`. But it is misleading TypeScript.

---

## What's Clean

- **Schema design** (`src/core/schema.ts`): Well-structured. The `superRefine` for content/content_file mutual exclusivity is correct. The `SettingsSchema.passthrough()` is the right call for forward-compatibility.
- **Config merge logic** (`src/core/config.ts:127-138`): The union/shallow-merge strategy is correctly implemented for all entity types.
- **MCP permission tiers** (`src/mcp/server.ts:108-128`): The three-tier system and the `checkPermission` function are clean and testable. `write-remote` requiring explicit opt-in is the right default.
- **A2A task store eviction** (`src/protocols/a2a/server.ts:54-87`): Two-phase eviction (TTL first, then capacity) is thoughtful. The `MAX_TASKS * 0.8` target on capacity cleanup avoids thrashing.
- **ACP registry** (`src/protocols/acp/registry.ts`): Simple, correct, and well-tested. Config overrides taking precedence over built-ins is the right default.
- **Error messages**: Throughout the codebase, error messages include recovery hints (e.g., "Use am_list_servers to see available server names"). This is consistently applied and makes the MCP server surface much more useful for agents.
- **Test coverage for ACP registry**: Comprehensive — covers config override, fallthrough, empty settings, sorting, `parseCommand` edge cases including empty string.

---

## Summary of Issues by Severity

| Severity | Count | Items |
|----------|-------|-------|
| MEDIUM | 2 | `parsePositiveInt` accepts 0; `AmAcpClient.prompt()` accumulates across calls |
| LOW | 6 | `as any` in run.ts delegate; dead `amError` if/else; dead `Bun.file()` in config.ts; `require()` inconsistency; `addInstruction` double cast; `runMainCommand` duplication |
| INFO | 2 | ACP auto-approve permissions; `terminalStore` leak on abrupt exit |

No CRITICAL or HIGH issues found. The codebase is suitable for release with the two MEDIUM issues addressed.
