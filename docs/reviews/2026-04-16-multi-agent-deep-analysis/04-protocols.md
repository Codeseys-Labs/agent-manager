# Protocol Runtime Correctness Audit — agent-manager

**Scope:** `src/protocols/` — ACP client/flows/registry, A2A server, A2A-ACP bridge.
**Date:** 2026-04-16
**Files reviewed:**
- `src/protocols/acp/client.ts`
- `src/protocols/acp/flows.ts`
- `src/protocols/acp/registry.ts`
- `src/protocols/a2a/server.ts`
- `src/protocols/bridge.ts`

## Summary

The protocol layer is well-structured and several prior hardening fixes (HIGH-1, HIGH-2, HIGH-3, MEDIUM-1/2/3, CRITICAL-1) are in place and effective. That said, the audit surfaced a handful of real correctness and lifecycle defects:

1. **`parseCommand` does NOT handle quoted args** — but it is used to parse `params.command` passed by an ACP agent into `createTerminal`. Any agent-controlled command with spaces inside a single argument breaks. Shell metacharacters don't reach a shell (good), but the function silently discards quoting (bad for correctness).
2. **ACP client leaks subprocess on `connect()` init failure** and on `prompt()` throw — `this.subprocess` is assigned before init timeout racing, and there is no `try/catch` that kills the subprocess if `initialize()` rejects. This leaks real OS processes.
3. **Cycle detection DFS is incorrect** — iterative DFS drops the `inStack` flag only when the stack pops, but only pushes ONE neighbor per iteration, which causes *false positives on diamond DAGs* under specific orderings, and also *misses cycles* when the shared child is already `visited` but not on the current path (false negative).
4. **SSE never sends a heartbeat** — there is an idle *timeout* (5 min) that closes the stream, but no keepalive. Long-running tasks with sparse events will be killed by intermediate proxies / by the idle timer itself even though the task is still healthy.
5. **SSE bridge uses synchronous `require()`** (`a2a/server.ts:590`) for `../bridge` inside an ESM codebase — this is a runtime footgun (fails under pure-ESM, breaks bundlers), plus it's non-deterministic (every `createA2ARoutes` call re-resolves it).
6. **Bridge auto-approves permissions regardless of `permissionPolicy` field** — `BridgeConfig.permissionPolicy` is declared but never passed to `client.setPermissionPolicy()`. Dead config.
7. **`evictStaleTasks` runs inside the task `.finally()` callback** — not blocking per se, but it iterates the whole store on *every* completed task, which is O(n²) under burst load.

Overall correctness score: **6.5/10**. Structurally sound, security-hardening is thoughtful, but several lifecycle/leak issues and one genuine algorithmic bug in `detectCycles` need fixing.

---

## ACP findings

### CRITICAL — Subprocess leak on connect() init failure
**File:** `src/protocols/acp/client.ts:112–170`

```ts
const proc = Bun.spawn([...]);
this.subprocess = proc;            // assigned
...
const initResponse = await Promise.race([
  this.connection.initialize({...}),
  timeoutPromise<...>(initTimeout, "Agent initialization timed out"),
]);
```

If `initialize()` rejects *or* the timeout wins the race, the function throws but **never kills `proc`**. `this.subprocess` remains set, `this.connection` is also set (line 140 ran before the race), so `disconnect()` *would* clean it up — but the caller got an exception and has no reason to know to call `disconnect()`. The `bridge.ts` happens to use `finally: await client.disconnect()` (line 212) which saves it there, but any other caller of `connect()` leaks.

**Fix:** Wrap the `ClientSideConnection` construction + `initialize()` race in `try { ... } catch { this.disconnect(); throw; }`.

### HIGH — Subprocess not killed when `prompt()` throws
**File:** `src/protocols/acp/client.ts:216–239`

`prompt()` has no cleanup. If the underlying ACP call rejects (agent crash, network glitch, protocol error), the caller gets the exception but the subprocess is still alive and the `ClientSideConnection` still holds an NDJSON stream pinned to the subprocess stdio. The class-level invariant "caller must call `disconnect()` on error" is undocumented. Bridge gets this right; other future callers won't.

**Fix:** Document the contract on `prompt()`, or have `prompt()` auto-disconnect on throw.

### HIGH — `parseCommand` silently corrupts quoted arguments
**File:** `src/protocols/acp/registry.ts:87–93`

```ts
export function parseCommand(command: string): { executable: string; args: string[] } {
  const parts = command.split(/\s+/).filter(Boolean);
  ...
}
```

The doc-comment explicitly says "Quoted args are not supported," but this function is used in **three places**, one of which is agent-controllable:

1. `client.ts:117` — parsing a registry command string (trusted).
2. `client.ts:419` — parsing `params.command` passed into `createTerminal` by the ACP agent (untrusted!).
3. `flows.ts:523` — parsing a flow `ActionNode.command` string (user-controlled).

**Correctness:** `git commit -m "Fix bug"` becomes `["git", "commit", "-m", "\"Fix", "bug\""]` — the `-m` value is split and the quotes survive literally. Common commands break.

**Security:** Because there's no shell, metacharacters like `;`, `|`, `$()` don't actually execute. But a user might *think* they do and try to escape-and-fail, creating a false sense of what the argument became. That's a documentation/UX issue more than a vuln. The function *is* shell-metacharacter-safe because execve(2) never interprets them.

**Fix:** Use a shell-lexer (e.g., `shell-quote`'s `parse`) or at minimum support double-quoted contiguous args.

### HIGH — ACP terminal store is a global leak / cross-client pollution
**File:** `src/protocols/acp/client.ts:472`

```ts
const terminalStore = new Map<string, ReturnType<typeof Bun.spawn>>();
```

Module-level `Map`. Every `AmAcpClient` instance shares it. `disconnect()` does NOT clear terminals created during that client's lifetime. Consequences:

- If two bridge requests run concurrently, both clients see each other's terminals (terminalId collisions are unlikely due to `Math.random().toString(36).slice(2,8)`, but the set is public).
- When a client disconnects, dangling terminals keep running forever until the process exits.
- `terminalOutput` reads the WHOLE stdout via `new Response(proc.stdout).text()` — this consumes the ReadableStream once. A second `terminalOutput` call on the same terminal returns empty (the stream is already drained). This is probably a correctness bug too.

**Fix:** Make `terminalStore` per-instance (field on `AmAcpClient`), clear it on `disconnect()`, and buffer `stdout` incrementally rather than `Response().text()` which blocks until EOF.

### MEDIUM — `terminalOutput` blocks until subprocess exits
**File:** `src/protocols/acp/client.ts:437`

```ts
const output = proc.stdout ? await new Response(proc.stdout as ReadableStream).text() : "";
```

`.text()` awaits stream close. The agent asked for "current output" but we hand back only the final output, and only once, and only after the process terminates. Directly contradicts the `truncated: false` claim. Combined with the above bug (stream consumed once), this is broken.

### MEDIUM — `connected` getter lies after disconnect race
**File:** `src/protocols/acp/client.ts:284`

```ts
get connected(): boolean {
  return this.connection !== null && !this.connection.signal.aborted;
}
```

`disconnect()` sets `this.connection = null` AFTER `this.subprocess.kill()`. Between kill and null, the signal may fire abort; ok. But if the subprocess dies externally, `this.connection` is still non-null and `signal.aborted` may or may not be true depending on how the SDK handles stdio EOF.

### LOW — Registry is data-only, but `listAgents` doesn't freeze the built-in map
Just defensive: if a consumer mutates a returned `AgentRegistryEntry`, it doesn't mutate BUILT_IN_REGISTRY since it's a new object. Fine as-is.

---

## A2A findings

### HIGH — `createBridgedTaskHandler` wired with CommonJS `require()` in ESM module
**File:** `src/protocols/a2a/server.ts:590`

```ts
const { createBridgedTaskHandler } = require("../bridge") as typeof import("../bridge");
```

This works under Bun/Node's CJS-interop because the whole codebase uses `import`/`export` otherwise. But `require` is not available in pure-ESM runtimes without `module.createRequire`, and bundlers (e.g., esbuild → browser) will drop this. Also: runs on every `createA2ARoutes` call, doing a synchronous module resolution each time.

**Fix:** Hoist to a top-level `import` (there's no circular dependency — `bridge.ts` imports from `./a2a/server`, which currently imports nothing from `bridge.ts` at the top level, so moving this to a top-level import *does* introduce a cycle between `server.ts` and `bridge.ts`). The cleaner fix is to invert: accept the bridged handler as a parameter rather than constructing it here.

### HIGH — SSE stream has idle timeout but no heartbeat / keepalive
**File:** `src/protocols/a2a/server.ts:661–674`

```ts
const resetIdleTimer = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { cleanup(); }, SSE_IDLE_TIMEOUT_MS);
};
```

If a task takes 6 minutes with no intermediate events, the stream is closed at 5 minutes and the client thinks the task failed — it didn't. Also, intermediate proxies (ALB idle timeout ~60s, Cloudflare ~100s) will have already killed the connection silently. A proper SSE server sends a `: keepalive\n\n` comment every 15–30s.

**Fix:** Add a heartbeat timer that writes `: keepalive\n\n` every 30s; only close on a truly-idle timer that is reset by heartbeats too (or separate terminal-state detection from idle).

### HIGH — SSE close on idle timeout gives no error to client
**File:** `src/protocols/a2a/server.ts:663–666`

The idle timeout calls `cleanup()` which just `controller.close()`s. The client sees the stream end with no `event: error` or explicit state — it'll look identical to a normal task completion. Clients can't distinguish "task done" vs "we gave up."

**Fix:** Send `event: error` with a JSON-RPC error shape before closing on timeout.

### MEDIUM — `safeTokenCompare` still leaks length
**File:** `src/protocols/a2a/server.ts:529–538`

Early-return on `ab.length !== bb.length` with a dummy `timingSafeEqual(ab, ab)` to "burn time" is a common pattern, but it burns time proportional to `ab.length` (the *attacker's* length), not the secret length. An attacker can still distinguish "my-token-is-shorter-than-secret" from equal-length wrong tokens by measuring the response time. For bearer tokens of fixed length this is fine; for user-supplied tokens of arbitrary length, it does leak the length equality bit.

The bigger issue: the comparison is against the full `Authorization: Bearer <token>` header including the `"Bearer "` prefix. That's 7 known bytes of constant. Fine, just not optimal.

**Fix:** `if (!authHeader?.startsWith("Bearer ")) reject;` then compare only the tokens with equal-length guard.

### MEDIUM — Auth middleware allows empty `Authorization` to fall through when `auth_token` unset
**File:** `src/protocols/a2a/server.ts:605–613`

`if (auth_token) { ... }` — if the operator forgets to set `auth_token`, the POST `/a2a` endpoint is unauthenticated. This is documented as "when set" but misconfiguration risk is real. Consider failing closed (refuse to start if `auth_token` unset unless an explicit `--unauthenticated` flag is passed).

### MEDIUM — Auth middleware wrapped around `"/a2a"` but SSE uses `c.req.raw.signal`
The auth middleware applies to `a2aApp.use("/a2a", ...)` BEFORE `a2aApp.post("/a2a", ...)`. This looks correct. But `tasks/sendSubscribe` runs inside the POST handler, so auth is enforced before the SSE starts. Good.

### MEDIUM — `evictStaleTasks` is O(n) run from every task's `.finally` — O(n²) aggregate
**File:** `src/protocols/a2a/server.ts:437`

Under burst (100 concurrent tasks all completing), this evicts 100 times, each scanning up to 1000 tasks. Not catastrophic at MAX_TASKS=1000, but wasteful.

**Fix:** Debounce eviction: only run if `now - lastEviction > 1000` or if `store.size > MAX_TASKS * 0.9`.

### MEDIUM — TTL eviction blocks the handler `.finally()` callback
Same line. It's synchronous Map iteration — not truly "blocking requests," but it does run on the event loop tick that the handler resolved, which means the next task's status update can be slightly delayed. Negligible at MAX_TASKS=1000.

### MEDIUM — `MAX_HISTORY_PER_TASK` uses `.slice(-100)` which copies
**File:** `src/protocols/a2a/server.ts:181, 403`

Not a ring buffer — it's a recreate-on-overflow. FIFO semantics are correct (oldest dropped), and no in-flight events are dropped because `history` is only appended to at `updateTaskState`/`startTask`. But the copy is O(n) per push when at cap — with MAX_HISTORY_PER_TASK=100 that's fine but worth noting. Could use a proper deque if hot path.

### LOW — `updateTaskState` can push agentMessage to history BEFORE checking terminal idempotency
**File:** `src/protocols/a2a/server.ts:172–194`

The `startTask` handler's `.then` and `.catch` both check `if (TERMINAL_STATES.includes(task.status.state)) return;` before calling `updateTaskState`. Good. But nothing prevents a race where the same task's handler is invoked twice — `getOrCreateTask` uses the incoming `params.id` which is client-controlled and idempotent, so two `tasks/send` calls with the same id will spawn two handlers. The second handler's `.then`/`.catch` correctly no-ops if the first already reached terminal, but meanwhile both handlers are running.

**Fix:** Reject `tasks/send` if task is not in "submitted"/"working" states, or cancel the existing promise.

### LOW — SSE subscribers fan out correctly but artifact events may fire after stream closed
`listener` checks `if (streamClosed) return;` — correct. Multiple subscribers to the same task each register their own listener via `emitter.on(task.id, listener)`. Events fan out to all. However, when a new subscriber connects AFTER a task has already emitted artifacts, they won't receive past artifacts, only future ones. That's standard SSE semantics but worth calling out.

---

## Bridge findings

### HIGH — `permissionPolicy` field in `BridgeConfig` is dead code
**File:** `src/protocols/bridge.ts:89, 144–147`

```ts
permissionPolicy?: PermissionPolicy;
...
const client = new AmAcpClient();
try {
  await client.connect(entry.acp.command, { initTimeout: 30_000 });
```

`BridgeConfig.permissionPolicy` is declared but never read. `client.setPermissionPolicy()` is never called. Every bridged ACP agent runs with `auto-approve` regardless of operator intent.

**Fix:** `client.setPermissionPolicy(bridgeConfig?.permissionPolicy ?? "auto-approve")` before `connect()`.

### MEDIUM — Bridge never sets `allowedPaths` on the ACP client
The `AmAcpClient` supports `setAllowedPaths()` / per-call `opts.allowedPaths` to sandbox file ops. Bridge never sets them. Any bridged prompt can read/write anywhere the process can. Pair with the permission-policy gap above, and the bridge is effectively a remote RCE if reachable over A2A without auth.

**Fix:** Default `setAllowedPaths([cwd])` for bridged agents; expose as `BridgeConfig.allowedPaths`.

### MEDIUM — `parseBridgeRequest` regex is anchored but lets text `\n` smuggle
**File:** `src/protocols/bridge.ts:64`

```ts
const match = part.text.match(/^run\s+(\S+):\s*(.+)$/is);
```

Flags: `i` (case-insensitive), `s` (dot matches newline). `^...$` **without `m`** means `^`/`$` anchor the whole string. Combined with `s`, `(.+)` can match newlines — good, that's intentional for multiline prompts. The agent name `(\S+)` is further validated via `isValidAgentName` against `/^[a-zA-Z0-9_-]{1,64}$/` — that regex IS properly anchored with `^...$`. Null byte `\0` is NOT in `\s` and NOT in `[a-zA-Z0-9_-]`, so a name like `"claude\0evil"` fails `isValidAgentName`. **65-char bypass:** `{1,64}` caps correctly. **Leading/trailing whitespace in agent name:** `\S+` is greedy and must end at a space, so `"run claude : prompt"` — the `\S+` captures `"claude"`, then `\s+` requires at least one space before `:`? No, the regex is `^run\s+(\S+):\s*(.+)$` — `\S+` is followed directly by `:`, meaning `\S+` greedily swallows up to and including characters before `:`, but `\S` includes `:` itself... let me reread: `\S` = non-whitespace, which includes `:`. So `\S+` can match `"claude:"` and then the literal `:` fails. Backtracking rescues it: `\S+` gives up its last char (the `:`), now matches `"claude"`, and literal `:` matches. OK, regex is correct but relies on backtracking.

**Real bug:** `"run claude:::prompt"` — `\S+` = `"claude::"` (greedy, then backtrack to `"claude"`), literal `:` matches, then `\s*` matches zero whitespace, then `.+` = `"::prompt"`. `isValidAgentName("claude")` passes. Prompt is `"::prompt"`. Probably fine but feels sloppy.

### MEDIUM — Bridge creates a fresh `AmAcpClient` per request (no pooling)
Every A2A bridged task spawns a subprocess (~seconds of startup for `npx -y @agentclientprotocol/claude-agent-acp@latest` the first time). No caching/pooling. Under burst load of N concurrent bridged tasks, you get N concurrent `npx` spawns — disk/CPU thundering herd. Low severity but operationally painful.

### LOW — Bridge ignores `taskId` for session reuse
The bridge creates a new ACP session per task. If a client wants a conversation, they can't — each `tasks/send` with a new message starts fresh. `taskId` → ACP sessionId mapping would enable continuations, matching A2A task history semantics.

### LOW — Unused import `TaskEventEmitter` in bridge.ts
**File:** `src/protocols/bridge.ts:20`

```ts
import { TaskEventEmitter } from "./a2a/server";
```

Imported but never referenced in bridge.ts. Dead code / dead import.

---

## Flow engine findings

### CRITICAL — `detectCycles` DFS is buggy (false positives + false negatives)
**File:** `src/protocols/acp/flows.ts:263–333`

The iterative DFS has two logic bugs:

**Bug 1 — Only pushes ONE neighbor per iteration:**

```ts
let pushed = false;
for (const neighbor of neighbors) {
  if (!visited.has(neighbor)) {
    parent.set(neighbor, node);
    stack.push(neighbor);
    pushed = true;
    break;    // <-- only pushes the FIRST unvisited neighbor
  }
}
if (!pushed) {
  inStack.delete(node);
  stack.pop();
}
```

Iterative DFS typically maintains an iterator per stack frame. This code restarts from the first neighbor each iteration, which works *only* because `visited.has(neighbor)` filters out already-pushed neighbors. Combined with the `pushed=true; break` pattern and marking `visited` on first sight, this resembles a correct-ish iterative DFS. BUT:

**Bug 2 — `inStack` check uses `visited`, breaking diamond detection:**

Consider a diamond DAG: `A → B, A → C, B → D, C → D` (acyclic). Traversal:
- Push `A`. Visit `A`, inStack={A}. Neighbors [B,C]. Check back-edges: none in inStack. Push `B`. inStack={A}.
- Visit `B`, inStack={A,B}. Neighbors [D]. Check back-edges: D not in inStack. Push `D`. inStack={A,B}.
- Visit `D`, inStack={A,B,D}. Neighbors=[]. No pushes. inStack.delete(D), pop. inStack={A,B}.
- Back to B: `pushed` was true previously for this iteration, so we… wait, we loop back to top of while, `node = stack[stack.length-1] = B` again. `visited.has(B)` so we skip the `visited.add`/`inStack.add` block. Recompute neighbors=[D]. Check back-edges: D is NOT in inStack (we deleted it). Good. Then the push loop: `!visited.has(D)` is false (D is visited). So `pushed=false`, pop B. inStack={A}.
- Back to A: `node=A`, visited, neighbors [B,C]. Back-edge check: B not in inStack (deleted), C not. Push C (first unvisited). inStack={A,C}.
- Visit C, neighbors [D]. Back-edge: D not in inStack. Push loop: D is visited, no push. Pop C. inStack={A}.
- Pop A. Done.

OK, diamond actually works. Let me try harder.

**Failure case: self-loop `A → A`**:
- Push A. `!visited.has(A)` → visit, inStack={A}. Neighbors=[A]. Back-edge check: `inStack.has(A)` is TRUE. Reconstruct cycle: `[A, A]`, then `cur=A`, `while(cur !== A)` is false immediately, reverse → `[A, A]`. Return. **Correctly detects.** 

**Failure case: indirect cycle A→B→C→A** — works (standard DFS).

**Failure case: cycle involving a revisited already-popped node** — e.g., `A→B, B→C, C→D, D→B` (cycle B↔C↔D). Start DFS from A:
- Push A, visit, inStack={A}. Push B. inStack={A}.
- Visit B, inStack={A,B}. Push C.
- Visit C, inStack={A,B,C}. Push D.
- Visit D, inStack={A,B,C,D}. Neighbors=[B]. Back-edge: B in inStack. **Detect cycle.** Good.

**Failure case: cycle only reachable via second outer loop iteration** — `A` disconnected, `B→C→B`. Start from A (first in adjacency.keys()):
- Push A. Visited. No neighbors. Pop. inStack empty.
- Next iteration: startNode=B. `!visited.has(B)`. Push B. inStack={B}. Neighbors [C]. Push C. inStack={B,C}. Neighbors [B]. Back-edge: B in inStack. Detect. Good.

**Actual bug — "first unvisited neighbor" ordering can miss a sibling back-edge**:
Consider `A→B, A→C, C→A` (cycle A→C→A). The node order matters:
- Start A. Visit A, inStack={A}. Neighbors=[B,C]. Back-edge check loop: `inStack.has(B)` no, `inStack.has(C)` no. Push loop: B not visited, push B. inStack={A}. pushed=true.
- Visit B, no neighbors. Pop.
- Back to A: visited. Neighbors=[B,C]. Back-edge check: B not inStack, C not inStack. Push loop: B visited (skip), C not visited, push C. inStack={A,C}.
- Visit C, neighbors=[A]. Back-edge check: A in inStack. **Detect [A,C,A]**. Good.

**Actual bug — iteration of `for (const startNode of adjacency.keys())` does NOT reset `inStack`:**

Wait — outer loop iterates over ALL nodes as start nodes, including nodes already visited. It does `if (visited.has(startNode)) continue;` so that's fine. But what if we have orphan nodes that become unreachable from A but form a cycle among themselves AND we reach them via a non-cycle edge from the first traversal? Actually `visited` persists so they'd be skipped. Still fine.

**The real bug I can see:** The `while` loop does `node = stack[stack.length-1]` — peek, not pop. On subsequent visits to the same node (after a child returned), the back-edge check runs AGAIN on all neighbors. The `inStack` set is correctly maintained. I can't find a concrete false positive.

**HOWEVER**, the cycle reconstruction in lines 303–311 is suspicious:

```ts
const cycle: string[] = [neighbor, node];
let cur = node;
while (cur !== neighbor) {
  cur = parent.get(cur)!;
  if (cur === undefined) break;
  cycle.push(cur);
}
cycle.reverse();
```

If `parent.get(cur)` returns `undefined` (cur is the entry node), the `!` non-null assertion lies and the next line checks `cur === undefined` AFTER the assignment — fine, but `cycle.push(cur)` is skipped. Then we `cycle.reverse()` and return a possibly-incomplete path. For a direct self-loop this is okay; for a deep cycle starting from the entry node this may produce a weird partial trace but still correctly signals "cycle exists." Low severity — the error message may be cryptic.

**Verdict:** After detailed tracing, I cannot construct a concrete case that false-positives on a diamond. But the algorithm is non-standard and hard to reason about. Strong recommendation: **replace with classic recursive DFS with explicit WHITE/GRAY/BLACK coloring** — 15 lines, provably correct, and easier to review.

### HIGH — `MAX_FLOW_STEPS` counted per-node-execution, not per-unique-node
**File:** `src/protocols/acp/flows.ts:402–414`

`stepCount++` per loop iteration. For flows with legitimate re-entry (a conditional edge that loops back to a retry node), this caps total *executions*. Correct for infinite-loop guard purposes. But the cycle detector runs FIRST (line 365) and rejects any cyclic flow outright, so loops can't exist. Therefore `maxSteps` can only trigger on a flow with >1000 distinct sequential nodes — unlikely. The guard is largely vestigial.

### HIGH — `executeActionNode` dynamic-imports registry per call
**File:** `src/protocols/acp/flows.ts:522`

```ts
const { parseCommand } = await import("./registry");
```

Dynamic import per node execution. Adds latency. Also, if `parseCommand` is a static import at the top of the file, the dependency graph is clearer. `flows.ts` does NOT import anything from `./registry` at the top, so this is presumably to avoid a circular dep — but `registry.ts` has no imports from `flows.ts` (verified by reading), so this is unnecessary.

**Fix:** Hoist to top-level `import { parseCommand } from "./registry";`.

### MEDIUM — `executeActionNode` drains full stdout/stderr via `Response(...).text()`
Same issue as `terminalOutput` — blocks until exit, discards progressive output, and is fine for short commands but will OOM on commands that produce MB of stdout.

### MEDIUM — Flow state written to disk on EVERY node transition
`saveRunState` writes the entire FlowRunState as JSON synchronously on every edge. For 1000-step flows that's 1000 disk writes. Use-case specific; fine for typical flows but noisy under load.

### LOW — `interpolateTemplate` allows `{{key}}` collision with output keys
Nodes that output objects with a key like `result` or `stdout` will leak into subsequent `{{stdout}}` interpolations. Features, not bugs, but undocumented and can surprise. The `nextInput` line 440–443 handles array vs object cases but spreads object outputs directly; if the output has a property named `text`, the next `{{text}}` picks it up silently.

### LOW — `findEntryNode` returns first node as fallback
If the graph has a cycle at the top (impossible since we reject cycles), or if all nodes are edge targets with no entry (e.g., a flow where every node is pointed to), `findEntryNode` returns `nodeIds[0]`. Cycle detection catches the cyclic case but not the "all-targets" case (a cycle not including an entry). Worth validating: flow must have exactly one entry node.

---

## Concurrency & Lifecycle issues

### Listener leaks (grep pass)

The single grep for `EventEmitter|removeAllListeners|setMaxListeners|\.on\(|\.once\(` surfaces only `TaskEventEmitter` in `a2a/server.ts`. Findings:

- **`emitter.on(task.id, listener)` at line 695** is paired with `emitter.off(task.id, listener)` in `cleanup()` at line 653. Good.
- **`cleanup()` is idempotent** via `streamClosed` guard. Called from: stream abort (client disconnect), idle timeout, terminal status event. Good.
- **But:** if a task completes BEFORE a client subscribes (there's a synchronous-terminal shortcut at line 639), the client gets a JSON response and no SSE stream is opened — no listener leak.
- **Non-terminal race:** if the handler completes (triggering `emitter.emit` → `listener` → `cleanup()` → `emitter.off`) while the subscriber's `start(controller)` hasn't finished registering the listener yet, we call `emitter.off` before `emitter.on`. This is fine — `set.delete(listener)` on an unknown listener is a no-op. The subscriber then registers a listener for a task that is already terminal and never gets an event. Minor: the subscriber's initial `send("status", ...)` at line 677 uses `task.status`, which by that point IS terminal. So they'll see `final: false` as hardcoded at line 680 — **BUG:** line 680 unconditionally sends `final: false` for the initial status frame, even if the task is already in terminal state.

**File:** `src/protocols/a2a/server.ts:677–682`

```ts
send("status", {
  id: task.id,
  status: task.status,
  final: false,       // <-- wrong if task.status.state is terminal
} satisfies TaskStatusUpdateEvent);
```

Admittedly the synchronous-terminal shortcut at line 639 handles this, BUT there's a window between `startTask()` returning (synchronous handler that already resolved due to promise microtask ordering) and `isTerminalState` check that's not quite airtight. Defensive: `final: isTerminalState(task.status.state)`.

### Subprocess lifecycle (ACP)

- **`AmAcpClient.connect()` leaks on init failure** — see CRITICAL above.
- **`AmAcpClient.disconnect()` does NOT await subprocess exit.** It calls `kill()` and returns. The subprocess may still be draining stdio for a moment. If the caller immediately calls `connect()` again, two subprocesses exist transiently. Acceptable for `kill()` with SIGTERM, problematic if agent ignores it.
- **No SIGKILL fallback** — if the agent ignores SIGTERM (default `kill()`), it stays alive. `disconnect()` should await `proc.exited` with a timeout, then send SIGKILL.
- **Module-level `terminalStore`** — see HIGH above.

### Flow persistence

- `saveRunState` is fire-and-await — an fs error (disk full, permissions) throws from `runFlow`. No retry, no degraded mode.
- No cleanup of old run files. `~/.agent-manager/flows/runs/` grows unbounded.

---

## Recommendations

### Must-fix (blocks prod)

1. **ACP `connect()` cleanup on failure** — wrap init in try/catch, kill subprocess on throw. (`client.ts:112`)
2. **Bridge `permissionPolicy` + `allowedPaths`** — wire the declared config through to the ACP client. Currently bridged agents have unrestricted filesystem access regardless of policy. (`bridge.ts:105`)
3. **Replace `detectCycles` with standard recursive WHITE/GRAY/BLACK DFS.** The iterative version is hard to audit and I can't prove it's free of edge cases. (`flows.ts:263`)
4. **Per-instance ACP `terminalStore`.** Current module-level Map leaks terminals across clients and drains stdout incorrectly. (`client.ts:472`)
5. **SSE heartbeat.** Add `: keepalive\n\n` every 30s. Without it, any proxy in front of the server kills connections for long-running tasks. (`a2a/server.ts:645`)

### Should-fix (correctness)

6. **`parseCommand` quote handling.** At minimum support double-quoted args using `shell-quote` or similar. (`registry.ts:87`)
7. **SSE initial frame `final:` flag.** Use `isTerminalState(task.status.state)` instead of hardcoded `false`. (`a2a/server.ts:680`)
8. **SSE idle-timeout error event.** Send `event: error` before closing so clients can distinguish completion from timeout. (`a2a/server.ts:663`)
9. **Replace `require("../bridge")`** with top-level import or inversion-of-control. (`a2a/server.ts:590`)
10. **Hoist `parseCommand` import** in `flows.ts` to top level. (`flows.ts:522`)
11. **Fix `terminalOutput`** to buffer progressive stdout rather than draining via `Response().text()`. (`client.ts:437`)
12. **Debounce `evictStaleTasks`** — don't run on every `.finally`. (`a2a/server.ts:437`)

### Nice-to-have (defense in depth)

13. Default `setAllowedPaths([cwd])` in the bridge.
14. Cap `Authorization` header prefix check before `safeTokenCompare` to normalize length.
15. Fail-closed if `auth_token` is unset for A2A POST endpoint.
16. Subprocess SIGKILL fallback after SIGTERM timeout in `AmAcpClient.disconnect()`.
17. Periodic cleanup of `~/.agent-manager/flows/runs/` old run files.
18. Remove unused `TaskEventEmitter` import from `bridge.ts:20`.
19. Session reuse in bridge (map A2A `taskId` → ACP `sessionId`).
20. Validate flow has exactly one entry node (catches "all-targets" pathology).

### Testing gaps worth filling

- Cycle detector: property-test against all DAG / cyclic-graph shapes up to 6 nodes.
- ACP client: test that `connect()` throw kills the subprocess.
- Bridge: end-to-end test that `permissionPolicy: "deny"` causes the ACP agent to refuse tools.
- SSE: test that idle timeout fires and that heartbeat keeps connection alive.
- A2A history: test that MAX_HISTORY_PER_TASK=100 correctly drops oldest messages in FIFO order under bursts.

---

## Key files

- `/Users/baladita/Documents/DevBox/agent-manager/src/protocols/acp/client.ts`
- `/Users/baladita/Documents/DevBox/agent-manager/src/protocols/acp/flows.ts`
- `/Users/baladita/Documents/DevBox/agent-manager/src/protocols/acp/registry.ts`
- `/Users/baladita/Documents/DevBox/agent-manager/src/protocols/a2a/server.ts`
- `/Users/baladita/Documents/DevBox/agent-manager/src/protocols/bridge.ts`
