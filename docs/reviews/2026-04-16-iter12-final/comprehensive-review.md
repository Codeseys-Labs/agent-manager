# Comprehensive Final Review — agent-manager iter12

**Reviewer:** Fresh eyes (no prior context on this codebase)
**Date:** 2026-04-16
**Scope:** New modules from recent iterations + security-critical code + test coverage

---

## Executive Summary

The codebase is in strong shape overall. Architecture is clean, conventions are consistently applied, and security-critical paths have visible hardening comments that demonstrate intent. There are **two real bugs** (one security-relevant), **one architectural inconsistency** in the community adapter proxy, and **two gaps in the `am flow run` command** that will produce confusing behavior at runtime. No manufactured findings.

---

## Severity Ratings

| ID | Severity | Location | Summary |
|----|----------|----------|---------|
| F-1 | HIGH | `src/protocols/acp/flows.ts:518` | Action nodes use `sh -c` — contradicts explicit HIGH-2 fix in acp/client.ts |
| F-2 | MEDIUM | `src/commands/flow.ts:72` | `am flow run` never wires `acpExecutor` — all ACP nodes fail at runtime |
| F-3 | LOW | `src/adapters/community/proxy.ts:173-209` | `detect()` / `import()` / `diff()` synchronous stubs return wrong defaults; callers that don't know to use the async variants silently get bad data |
| F-4 | LOW | `src/protocols/acp/flows.ts:298-316` | Iterative DFS cycle detection has a neighbor-ordering bug that can miss cycles |
| F-5 | INFO | `src/commands/completion.ts:51` | `init-project` missing from `TOP_LEVEL_COMMANDS`; shell completion omits it |

---

## F-1 (HIGH) — Action nodes use `sh -c` in flows.ts

**File:** `src/protocols/acp/flows.ts:518`

```typescript
const proc = Bun.spawn(["sh", "-c", command], {
```

The ACP client (`src/protocols/acp/client.ts:410`) explicitly avoids `sh -c` and documents this as a **HIGH-2 fix** to prevent shell metacharacter injection:

```typescript
// Headless terminal support: spawn the command directly (no shell).
// HIGH-2 fix: avoid sh -c to prevent shell metacharacter injection.
const { executable, args } = parseCommand(params.command);
```

Flow action nodes do the opposite: they pass the templated command string directly to `sh -c`. Since the command is interpolated from flow input data (`interpolateTemplate(node.command, input)`), any user-controlled value that reaches a `{{key}}` placeholder in an action node command can inject arbitrary shell commands.

**Concrete attack path:** A flow definition like `action({ command: "git clone {{repo}}" })` where `repo` comes from external input could be exploited with `repo = "x; rm -rf ~"`.

**Fix:** Use `parseCommand()` from `acp/registry.ts` (already available in the codebase) to split the command string, then spawn `[executable, ...args]` directly — the same pattern as `createClientHandler`. Interpolated values that could come from external input should be passed as separate arguments or validated.

---

## F-2 (MEDIUM) — `am flow run` never provides acpExecutor

**File:** `src/commands/flow.ts:72`

```typescript
const result = await runFlow(flowDef as FlowDefinition, {
  cwd: (args.cwd as string) ?? process.cwd(),
  input: initialInput,
  runsDir: args.runsDir as string | undefined,
  // acpExecutor: ??? — never set
});
```

`runFlow` requires `acpExecutor` to be provided if the flow contains any `acp` nodes. Without it, `executeAcpNode` throws `FlowError("NO_ACP_EXECUTOR")`. The CLI command never wires this up, so any flow that uses `acp()` nodes will always fail at runtime when invoked via `am flow run`.

The flows engine has the infrastructure to inject an executor (`FlowRunnerOptions.acpExecutor`), and the `AmAcpClient` exists in `src/protocols/acp/client.ts`. The CLI command just never connects them.

**Fix:** Create an `acpExecutor` in `flow.ts` that instantiates `AmAcpClient`, calls `connectByName`, creates a session, sends the prompt, and disconnects. This is the expected production wiring.

---

## F-3 (LOW) — Community adapter proxy synchronous stubs are misleading

**File:** `src/adapters/community/proxy.ts:173-209`

The `CommunityAdapterProxy` implements the `Adapter` interface but three methods return stubbed values synchronously:

```typescript
detect(): DetectResult {
  return { installed: false, paths: {} };  // Always says "not installed"
}

import(options: ImportOptions): ImportResult {
  return { servers: [], instructions: [], skills: [], warnings: [] };  // Always empty
}

diff(config: ResolvedConfig): DiffResult {
  return { status: "unmanaged", changes: [] };  // Always "unmanaged"
}
```

The async versions (`detectAsync`, `importAsync`, `diffAsync`) do the right thing. But any caller that uses the standard `Adapter` interface — which is synchronous for `detect`, `import`, `diff` — will silently get wrong results: `detect()` always reports the tool as not installed, `import()` always returns empty, `diff()` always reports unmanaged.

This is documented in comments ("use detectAsync() instead"), but the Adapter interface contract is broken. Code paths in the rest of the system that iterate over all adapters calling `detect()` will silently skip community adapters. The `am status` and `am adapter list` commands will misreport community adapter state.

**Fix:** Either (a) change `detect`, `import`, `diff` in the `Adapter` interface to return `Promise<...>` (breaking but correct), or (b) document prominently that `CommunityAdapterProxy` only partially implements `Adapter` and ensure all call sites in the adapter registry use the async variants when dealing with community adapters.

---

## F-4 (LOW) — Iterative DFS cycle detection can miss cycles

**File:** `src/protocols/acp/flows.ts:298-316`

The iterative DFS implementation has a subtle ordering issue. When processing a node's neighbors:

```typescript
for (const neighbor of neighbors) {
  if (!visited.has(neighbor)) {
    parent.set(neighbor, node);
    stack.push(neighbor);
    pushed = true;
    break;           // <-- stops after pushing first unvisited neighbor
  }
  if (inStack.has(neighbor)) {
    // ... return cycle
  }
}
```

The loop pushes the first unvisited neighbor and **breaks**, then checks `inStack` only for neighbors encountered before finding an unvisited one. If a node has neighbors `[A, B]` where `A` is unvisited and `B` is in the stack, the cycle via `B` is not detected in this iteration — the algorithm pushes `A` and moves on. The cycle will only be found if the DFS happens to reach `B` again via a different path.

More specifically: when `pushed = true`, the algorithm breaks without checking remaining neighbors for back edges. A cycle `X → Y → X` where `X` also has an unvisited neighbor `Z` that comes first in adjacency order will initially push `Z` instead of detecting the `X → Y` back edge at `X`.

In practice this is partially mitigated because the traversal will eventually revisit those nodes, but it may terminate early through a different path leaving cycles undetected. The test suite has a `detectCycles` diamond test and a conditional cycle test, but no test exercises a node with both an unvisited neighbor (listed first) and an in-stack neighbor.

**Fix:** In the inner loop, scan **all** neighbors for `inStack` membership before pushing any unvisited neighbor. Return the cycle immediately on first back edge found.

---

## F-5 (INFO) — `init-project` missing from completion command

**File:** `src/commands/completion.ts:15-47`

`cli.ts` registers `init-project` (implicitly — the command file exists at `src/commands/init-project.ts` and is not in the subcommands list visible in cli.ts, confirmed absent). More clearly: the `TOP_LEVEL_COMMANDS` list in `completion.ts` does not include `init-project`. Users will not get tab completion for this command.

This is cosmetic — shell completion is advisory — but worth a one-line fix.

**Fix:** Add `"init-project"` to the `TOP_LEVEL_COMMANDS` array in `completion.ts`.

Note: `cli.ts` registers both `agent` and `agents` as aliases (lines 50-51) but `completion.ts` only lists `agent`. Minor but consistent.

---

## Security Code — Passes Review

### bridge.ts — Agent name validation
`AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/` is tight and correct. `parseBridgeRequest` validates before any downstream use. Data parts are checked before text parts (correct precedence). Test coverage for path traversal, shell metacharacters, null bytes, length limits, and dot/slash variants is thorough.

### a2a/server.ts — Auth, TTL, SSE
- `safeTokenCompare` uses `timingSafeEqual` correctly. The constant-time padding (comparing `ab` against itself when lengths differ) burns cycles as intended.
- Task TTL eviction (1 hour) and capacity cap (1000) are both implemented, with two-phase cleanup (TTL first, then capacity).
- SSE idle timeout (5 minutes) fires `cleanup()` which calls `controller.close()` inside a try/catch — safe.
- `MAX_HISTORY_PER_TASK = 100` caps unbounded history growth on both write paths (both in `startTask` and `updateTaskState`).

### acp/client.ts — Path restriction and terminal spawn
- `isPathAllowed` uses `path.resolve()` on both sides before prefix comparison — correctly neutralizes `../` traversal.
- Terminal spawn correctly uses `parseCommand` to avoid `sh -c`.
- `terminalStore` is module-scoped (not instance-scoped). This is acceptable for a CLI tool where one `AmAcpClient` instance exists per process, but would be a resource leak in test environments that create multiple instances. The existing ACP client tests should verify cleanup.

---

## Dead Code / Unused Imports

None found in the reviewed modules. All imports in the new files are used.

---

## Type Safety

- `src/adapters/community/proxy.ts:170`: `schemaResult as unknown as AdapterSchema` — necessary because community adapters return JSON Schema, not Zod. The comment explains this is a known compromise.
- `src/adapters/community/loader.ts:65`: `TOML.parse(raw) as unknown as AdaptersToml` — standard TOML parse pattern used throughout the codebase.
- `src/protocols/a2a/server.ts:580`: `require("../bridge")` — synchronous CJS-style require inside an ES module factory. This works in Bun but is inconsistent with the rest of the codebase which uses dynamic `import()`. Low risk but worth flagging for maintainability.

---

## Test Coverage Assessment

| Module | Coverage | Notes |
|--------|----------|-------|
| `src/protocols/acp/flows.ts` | Excellent | All node types, conditional routing, persistence, cycle detection, max-steps guard, mixed flows |
| `src/protocols/bridge.ts` | Excellent | Agent name sanitization (11 security tests), parse variants, composite handler, A2A integration |
| `src/protocols/a2a/server.ts` | Good | Auth, TTL, SSE, task lifecycle — covered in existing server.test.ts |
| `src/marketplace/client.ts` | Good | `test/marketplace/client.test.ts` exists |
| `src/marketplace/scanner.ts` | Good | `test/marketplace/scanner.test.ts` exists |
| `src/marketplace/installer.ts` | Good | `test/marketplace/installer.test.ts` exists |
| `src/core/merge.ts` | Good | `test/core/merge.test.ts` exists |
| `src/adapters/community/proxy.ts` | Good | `test/adapters/community/proxy.test.ts` exists |
| `src/adapters/community/loader.ts` | Good | `test/adapters/community/loader.test.ts` exists |
| `src/commands/completion.ts` | Not found | No `test/commands/completion.test.ts` — only module missing tests |
| `src/commands/flow.ts` | Not found | No `test/commands/flow.test.ts` |
| `src/commands/marketplace.ts` | Present | `test/marketplace/command.test.ts` |

Two command files lack tests: `completion.ts` and `flow.ts`. `completion.ts` is pure string generation (low risk). `flow.ts` is more complex and F-2 would have been caught by a command-level test.

---

## Convention Compliance

All reviewed files follow CLAUDE.md conventions:
- Bun-native (`Bun.spawn`, `Bun.file`, `Bun.write`)
- `--json` output via `src/lib/output.ts` helpers
- `defineCommand()` from citty with global flags
- No top-level ESM imports of adapter/community code (lazy factories)
- Error handling sets `process.exitCode = 1` rather than throwing from commands

---

## Summary by Priority

**Fix before release:**
1. **F-1** — `sh -c` in flow action nodes is a shell injection vector, inconsistent with the explicit HIGH-2 fix elsewhere. Use `parseCommand` + direct spawn.
2. **F-2** — `am flow run` with ACP nodes always fails. Wire up `AmAcpClient` as the `acpExecutor`.

**Fix soon:**
3. **F-3** — Document or fix the synchronous stub methods on `CommunityAdapterProxy`. Current state silently returns wrong data through the standard `Adapter` interface.
4. **F-4** — The DFS cycle detection may miss cycles when a node has both an unvisited and an in-stack neighbor. Scan all neighbors for back edges before pushing.

**Cosmetic:**
5. **F-5** — Add `init-project` to shell completion command list.
