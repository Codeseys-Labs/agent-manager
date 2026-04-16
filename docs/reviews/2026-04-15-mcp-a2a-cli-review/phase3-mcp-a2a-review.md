# Phase 3 Review: MCP Tools + A2A Protocol

**Date:** 2026-04-14
**Scope:** Changes in the most recent commit across:
- `src/mcp/server.ts` — `am_server_update`, `am_undo`, `am_doctor` + error recovery hints
- `src/protocols/a2a/server.ts` — async `tasks/send`, per-instance task store via `createTaskStore()`
- `src/protocols/a2a/client.ts` — `pollTask()` and `sendAndPoll()`
- `test/mcp/server.test.ts` — 8 new tests (44 total)
- `test/protocols/a2a/server.test.ts` — 20+ new/updated tests (68 total)

**Prior reviews addressed:** `docs/reviews/mcp-tools-review.md` findings #2, #3, #4, #9; `docs/reviews/a2a-review.md` findings 5.1, 5.4, 7.1, 7.2, 7.3.

---

## Summary

The implementation correctly addresses the highest-priority issues from both prior reviews. The three new MCP tools (`am_server_update`, `am_undo`, `am_doctor`) are well-implemented. The async A2A task model and per-instance task store fix the most significant correctness and usability gaps. The new tests cover the critical paths.

**No critical bugs found.** There are several medium and low severity issues documented below, most of them pre-existing or edge cases rather than regressions.

---

## MCP Server (`src/mcp/server.ts`)

### 1. `am_undo` — Error message inconsistency with hint splitter

**Severity: LOW**

The error recovery hint system introduced in this commit splits error messages on the first `. ` (period-space) to separate the error from the hint:

```typescript
// server.ts:1615-1617
const dotIdx = msg.indexOf(". ");
const error = dotIdx > 0 ? msg.slice(0, dotIdx + 1) : msg;
const hint = dotIdx > 0 ? msg.slice(dotIdx + 2) : undefined;
```

The `am_undo` handler throws:

```typescript
throw new Error("Nothing to undo — only the initial commit exists");
```

This message has no `. ` delimiter, so the entire message ends up in `error` with no `hint`. That is fine — the behavior is correct. However, the `am_server_update` "not found" error (`server.ts:755`) also lacks a hint:

```typescript
throw new Error(`Server "${name}" not found`);
```

The original review finding #9 listed `am_remove_server` as having a recovery hint added (`Use am_list_servers to see available server names`), and that was implemented. But `am_server_update`'s "not found" error (the new tool) was not given the same treatment. An agent calling `am_server_update` with a wrong name gets no guidance to use `am_list_servers`.

**Fix:** Change the error to:

```typescript
throw new Error(
  `Server "${name}" not found. Use am_list_servers to see available server names.`
);
```

**Line ref:** `server.ts:755`

---

### 2. `am_undo` — Security: no check that `configDir` is the am config directory

**Severity: MEDIUM**

`am_undo` calls `revertHead(configDir)` where `configDir = resolveConfigDir()`. The `revertHead` function in `src/core/git.ts` operates on the git repo at that path: it reads the last two commits, writes files from the parent tree into the working directory, stages everything, and creates a new revert commit.

`resolveConfigDir()` reads from `AM_CONFIG_DIR` or defaults to `~/.config/agent-manager`. In normal operation this is correct. However, `AM_CONFIG_DIR` is an environment variable that MCP clients can influence in some setups. If an attacker controls `AM_CONFIG_DIR` to point at an arbitrary git repo, `am_undo` would overwrite files in that directory with content from the previous git commit, which could be anything.

This is a pre-existing concern across all write-local tools that call `resolveConfigDir()`, not introduced by this commit. But `am_undo`'s use of `revertHead` (which writes arbitrary file content from git history) makes it the highest-risk instance of this pattern.

**Severity context:** This requires the ability to set environment variables before the MCP server starts — not trivially exploitable, but worth noting given that `am_undo` writes files from git history.

**Line refs:** `server.ts:783-800`, `src/core/git.ts:92-145`

---

### 3. `am_server_update` — `am_agent_delegate` is `write-remote` but description doesn't mention it

**Severity: LOW (documentation gap, not a bug)**

`am_agent_delegate` is `write-remote` (requires `allow_push` opt-in). The description says "The agent must be in the local roster (use am_agent_list to see available agents)" but doesn't mention the tier requirement. An agent with only write-local permission that tries `am_agent_delegate` will get a cryptic "Write-remote tools require opt-in" error.

This is a pre-existing issue, but it's relevant because `am_agent_delegate` was a focus of this phase and `am_agent_task_status` (which is read-only) pairs with it — agents will naturally try both without realizing the tier difference.

**Line ref:** `server.ts:1228`

---

### 4. `am_doctor` — Secret scan runs on `configPath` (raw config) but skips project config

**Severity: LOW**

The secret audit in `am_doctor` only scans `configPath` (the global `config.toml`), not the merged resolved config or any project-level `.agent-manager.toml`. Secrets placed in a project config file are not checked.

This is a scope limitation rather than a bug, but since agents are likely to call `am_doctor` as an "all-clear" check, the result may falsely report zero secrets when secrets exist in project config.

**Line ref:** `server.ts:391-413`

---

### 5. `am_doctor` — `listAdapters()` returns all 13 adapters; check is slow

**Severity: LOW (performance note)**

The `am_doctor` handler iterates all 13 adapters, calling `getAdapter(name)` for each (which imports the adapter module lazily). On cold start with all 13 adapters, this check alone does 13 dynamic imports and 13 detection calls. For a health check tool called by agents, this is noticeable latency.

No functional bug, but relevant if `am_doctor` is called frequently in automation.

**Line ref:** `server.ts:320-338`

---

### 6. MCP batch request handling: `req.method` accessed before null check

**Severity: LOW (defensive code quality)**

In the `serve()` loop, the code correctly handles arrays (JSON-RPC batch) at line 1689:

```typescript
if (Array.isArray(req)) {
  const responses = await Promise.all(
    req.map((r: JsonRpcRequest) => this.handleRequest(r)),
  );
```

However, the batch path does not validate that each element in the array has a valid `jsonrpc` field or `method`. `handleRequest` will eventually handle a missing `method` by falling through to the default case (which returns -32601 for requests with an `id`), but a notification without `id` or `method` would return `null` and be silently dropped, which is correct JSON-RPC 2.0 behavior.

No bug here, but noting that the batch path added no validation that was not already there — acceptable given JSON-RPC 2.0's permissiveness.

---

## A2A Server (`src/protocols/a2a/server.ts`)

### 7. Async handler: canceled-then-completed race condition

**Severity: MEDIUM**

This is the most significant new issue introduced by the async task model.

The async handler runs like this:

```typescript
// tasks/send sets state to "working" and fires handler async
updateTaskState(task, "working");

handler(p.message, config)
  .then((result) => {
    task.artifacts = result.artifacts ?? task.artifacts;
    updateTaskState(task, "completed", result.message);  // (A)
  })
  .catch((err) => {
    updateTaskState(task, "failed", ...);                // (B)
  })
  .finally(() => {
    evictStaleTasks(store);
  });

return jsonRpcSuccess(id, task);  // returns "working"
```

A client can call `tasks/cancel` while the handler is running (line 337-346). The cancel handler sets state to `"canceled"`. But there is no mechanism to stop the async handler from running to completion and then calling `updateTaskState(task, "completed", ...)` at (A), which **overwrites the "canceled" state** with "completed".

The handler has no knowledge that the task was canceled, and the cancel only mutates the in-memory task state — it does not abort the handler's execution.

**Result:** A client that cancels a running task, receives `state: "canceled"` in the cancel response, but then polls with `tasks/get` may find the task in `state: "completed"` once the handler finishes. This is misleading and violates client expectations.

**Fix options:**
1. Check task state before `updateTaskState` in the `.then()` handler — if the task is already in a terminal state (including "canceled"), skip the update:
   ```typescript
   .then((result) => {
     if (!TERMINAL_STATES.has(task.status.state)) {
       task.artifacts = result.artifacts ?? task.artifacts;
       updateTaskState(task, "completed", result.message);
     }
   })
   ```
2. Use an `AbortSignal` passed to the handler so handlers can self-cancel (more complete but requires handler cooperation).

Option 1 is a minimal, correct fix for the cancel race. Option 2 is the A2A-idiomatic approach.

**Line refs:** `server.ts:286-299`, `server.ts:337-346`

---

### 8. `handleJsonRpc` is synchronous but calls async code via promise chain

**Severity: LOW (design note, no current bug)**

`handleJsonRpc` is declared as `function handleJsonRpc(...)` (synchronous), but it fires `handler(p.message, config).then(...).catch(...)` — a promise chain — without `await`. This is intentional (fire-and-forget for async execution) and JavaScript's single-threaded event loop makes this safe in the current implementation.

However, if `evictStaleTasks(store)` were ever made async, the `.finally()` would need to `await` it. The current `evictStaleTasks` is synchronous, so no bug exists today.

Note for future maintainers: `handleJsonRpc` should either be made `async` explicitly (with `await handler(...).then(...).catch(...)` where the outer await is on the full chain) or the intent should be documented.

**Line ref:** `server.ts:264-304`

---

### 9. `evictStaleTasks` called in `.finally()`: runs after every task completion, including very fast handlers

**Severity: LOW**

`evictStaleTasks` is a no-op when `store.size <= MAX_TASKS`. The check is O(1). Moving it to `.finally()` means it runs after every single task handler, even when the store has 5 tasks. The guard at line 49 (`if (store.size <= MAX_TASKS) return;`) means this is effectively free, but it is an unnecessary call in the common case.

No functional issue. The prior review finding 5.2 noted eviction races under concurrent load — the fix here (moving eviction to `.finally()`) is correct because it runs in the same microtask queue as handler completions, avoiding the prior inline eviction-after-every-send pattern.

---

### 10. `getAppTaskStore` uses property injection on Hono instance

**Severity: LOW**

```typescript
(a2aApp as Hono & { _taskStore: TaskStore })._taskStore = store;
```

This attaches a non-standard `_taskStore` property to the Hono instance via a type assertion. It works but is fragile: if Hono ever seals its instances, or if a proxy/wrapper is used, the property access would fail silently at runtime and `getAppTaskStore` would return `undefined`.

A cleaner approach would be to return `{ app, store }` from `createA2ARoutes` rather than encoding the store on the app. However, this would be a breaking API change for callers.

For now, the approach is acceptable given the narrow use case (primarily test access), but the naming convention `_taskStore` (underscore-prefixed) is correct idiomatic signaling of an internal/unstable property.

**Line ref:** `server.ts:412`

---

## A2A Client (`src/protocols/a2a/client.ts`)

### 11. `pollTask` / `sendAndPoll`: abort signal listener is not removed on successful completion

**Severity: LOW**

In `pollTaskImpl`, the abort signal listener is registered with `{ once: true }` which means it auto-removes after firing. However, on the _success path_ (when the poll loop exits normally via `return task`), the `addEventListener` call with `once: true` leaves an unconsumed listener registered on the signal that will remain until the signal fires or is GC'd.

In practice this is harmless because `AbortSignal` objects are short-lived and the `{ once: true }` flag ensures the listener never fires more than once. But for completeness:

```typescript
// Current (within the setTimeout callback)
const onAbort = () => {
  clearTimeout(timer);
  reject(new A2AClientError("Polling aborted"));
};
opts.signal.addEventListener("abort", onAbort, { once: true });
```

If the poll succeeds before the signal fires, `onAbort` is still registered. A more complete implementation would call `opts.signal.removeEventListener("abort", onAbort)` in the `resolve` path of the Promise constructor, or use `AbortSignal.reason` checks instead.

Minor issue, no practical impact given typical usage patterns.

**Line ref:** `client.ts:271-278`

---

### 12. `sendAndPoll`: uses `task.id` from `sendTask` response — relies on server echoing back the same ID

**Severity: LOW (A2A protocol correctness)**

```typescript
export async function sendAndPoll(...): Promise<Task> {
  const task = await client.sendTask(baseUrl, params);
  if (TERMINAL_STATES.has(task.status.state)) {
    return task;
  }
  return pollTaskImpl(client, baseUrl, task.id, pollOpts);
}
```

`task.id` comes from the server's response. The A2A spec allows servers to reassign task IDs. If a server returns a different ID than the one in `params.id`, `sendAndPoll` will poll the server-assigned ID, which is correct A2A behavior. This is fine.

However, the prior `am_agent_delegate` MCP tool (`server.ts:1257-1264`) calls `client.sendTask` directly and does NOT use `sendAndPoll`. It also does not call `pollTask`. The `sendTask` call with 60s timeout will now return immediately with `state: "working"` (since the A2A server now returns async). The MCP tool will return `{ agent, task }` where `task.status.state === "working"` — not the final result. Agents calling `am_agent_delegate` now need to follow up with `am_agent_task_status` to get the actual result.

This is by design (delegation is now async, per ADR-0017), but the `am_agent_delegate` description was not updated to reflect this change:

```typescript
description: "Send a task to a registered A2A agent. The agent must be in the local roster..."
```

The original `mcp-tools-review.md` finding #12 noted this exact gap ("am_agent_delegate Should Explain Async Model"). Now that the A2A server is actually async, this documentation gap becomes a correctness concern: agents calling `am_agent_delegate` may not understand they always need to poll.

**Fix:** Update the description to say:
```
"Send a task to a registered A2A agent and return immediately with state 'working'.
Use am_agent_task_status with the returned task ID to poll for the final result."
```

**Line ref:** `server.ts:1228`

---

## Test Coverage

### 13. New tests are well-structured and cover the right paths

The A2A server tests added in this commit directly address the highest-priority gaps from the prior review:
- Handler failure path (finding 7.2): covered by "task state transitions to failed on handler error"
- Async behavior / working state (finding 5.4): covered by "returns immediately with state working" + "task completes asynchronously after send returns"
- Store isolation (finding 5.1): covered by "separate createA2ARoutes calls have independent stores"
- Cancel of working task (finding 7.3): covered by "cancels a working task"
- `historyLength` (finding 7.5): NOT yet covered — the `tasks/get` test doesn't exercise the `historyLength` trimming path

The `waitForTask` helper (polling with 10ms intervals, 2s timeout) is a sound approach for testing async handlers without flakiness.

### 14. `historyLength` trimming is still untested

**Severity: LOW**

`tasks/get` with a `historyLength` parameter trims the returned history. This code path (`server.ts:318-321`) exists in the current commit but remains untested. The original review finding 7.5 flagged this and it was not addressed.

**Missing test:** Send a task, wait for completion (which produces a 2-message history: user + agent), then call `tasks/get` with `historyLength: 1` and verify only 1 message is returned.

---

### 15. `am_agent_delegate` and `am_agent_task_status` MCP tools still have no functional tests

**Severity: MEDIUM**

The original review finding 7.1 flagged no functional test for these two MCP tools. The new MCP server tests (8 tests) cover the three new tools thoroughly but do not add tests for the A2A MCP tools. These tools (network calls, roster lookup, task creation) remain the highest-risk untested code paths in the MCP server.

---

## Conventions Check

| Convention | Status |
|------------|--------|
| TDD: failing test first | Tests exist alongside implementation — cannot verify order from code alone |
| `bun:test` for all tests | Correct throughout |
| Structured output via `output.ts` | N/A (MCP tools use return values, not output.ts) |
| Write-remote requires opt-in | `am_agent_delegate` is write-remote — correct |
| Read-only tools never modify state | `am_doctor`, `am_agent_discover`, `am_agent_list`, `am_agent_task_status` — all correct |
| No system git dependency | All git ops via isomorphic-git — correct |
| Error messages use `errorMessage()` | Used consistently in catch blocks |

---

## Summary by Severity

### MEDIUM (2)

| # | Finding | Location |
|---|---------|----------|
| 7 | Canceled-then-completed race: async handler overwrites "canceled" state | `server.ts (a2a):286-299` |
| 12 | `am_agent_delegate` description not updated for async model — agents won't know to poll | `server.ts (mcp):1228` |
| 15 | `am_agent_delegate` / `am_agent_task_status` MCP tools still have no functional tests | `test/mcp/server.test.ts` |

### LOW (10)

| # | Finding | Location |
|---|---------|----------|
| 1 | `am_server_update` "not found" error missing recovery hint | `server.ts (mcp):755` |
| 2 | `am_undo` security: no guard against attacker-controlled `AM_CONFIG_DIR` | `server.ts (mcp):783-800` |
| 3 | `am_agent_delegate` write-remote tier not mentioned in description | `server.ts (mcp):1228` |
| 4 | `am_doctor` secret scan skips project config | `server.ts (mcp):391-413` |
| 5 | `am_doctor` iterates all 13 adapters on every call | `server.ts (mcp):320-338` |
| 8 | `handleJsonRpc` fires async handler without `await` — future maintenance trap | `server.ts (a2a):264` |
| 9 | `evictStaleTasks` called in `.finally()` on every completion | `server.ts (a2a):298-300` |
| 10 | `getAppTaskStore` uses property injection on Hono instance | `server.ts (a2a):412` |
| 11 | `pollTask` abort listener not cleaned up on successful completion | `client.ts:271-278` |
| 14 | `historyLength` trimming still untested | `test/protocols/a2a/server.test.ts` |

---

## Recommended Actions (Priority Order)

1. **Fix the canceled-then-completed race** (finding #7) — one-line guard in `.then()`:
   ```typescript
   .then((result) => {
     if (!TERMINAL_STATES.has(task.status.state)) {
       task.artifacts = result.artifacts ?? task.artifacts;
       updateTaskState(task, "completed", result.message);
     }
   })
   ```
   Add a test: send task with blocking handler, cancel it, unblock handler, verify state stays "canceled".

2. **Update `am_agent_delegate` description** (finding #12) — the server is now async and clients must poll.

3. **Add `am_agent_delegate` / `am_agent_task_status` functional tests** (finding #15) — these require mocking the HTTP client or starting a test A2A server.

4. **Add recovery hint to `am_server_update` "not found" error** (finding #1) — one line.

5. **Add `historyLength` test** (finding #14) — straightforward to add.
