# 06 — ACP/A2A functionality as MCP tools

Part of: `docs/reviews/2026-04-17-iter4-system-critique/`
Date: 2026-04-17
Status: proposal

## Summary

`am mcp-serve` currently exposes 33 tools (see `src/mcp/server.ts`, lines 485–2037).
Seven of those touch ACP or A2A: `am_run_agent`, `am_acp_list_agents`,
`am_acp_session_list`, `am_acp_session_cancel` (all group `acp`), and
`am_agent_discover`, `am_agent_list`, `am_agent_delegate`, `am_agent_task_status`
(all group `a2a`).

The surface is **functional but incoherent**:

- Two separate namespaces (`am_acp_*` and `am_agent_*`) do the same thing from a
  consuming agent's viewpoint — "talk to another agent." The difference is pure
  transport, which is exactly what a good control plane should hide.
- `am_agent_list` lists only the A2A roster, while `am_acp_list_agents`
  misleadingly returns the **unified** config+ACP+A2A view (see server.ts:1549
  and its own description acknowledging the naming debt from ADR-0031 M2).
- A2A is severely under-mapped: **no MCP tool wraps `tasks/sendSubscribe` or
  `tasks/list`**, even though `A2AClient.sendSubscribe` and the server-side
  `tasks/list` handler both exist (client.ts:260, server.ts:573 in
  `src/protocols/a2a/`).
- ACP is also under-mapped: **no tool for `loadSession` (resume), no explicit
  `cancel` for a running ACP prompt**, no way to set a permission policy per
  call, no way to list sessions via the agent's own `listSessions` RPC.
- Streaming is collapsed: `am_run_agent` (server.ts:1911) awaits the full ACP
  prompt and returns a single string. No progress notifications are emitted,
  so a consumer sees a black box for N seconds. Same for A2A — there is no
  MCP tool that wraps `tasks/sendSubscribe` at all.

This document proposes:

1. A unified `am_agent_*` namespace that a consuming agent learns once.
2. Full coverage of the protocol surface: connect, session (new/load/cancel/list/status),
   invoke (one-shot + streaming), for both ACP and A2A transparently.
3. **MCP progress notifications** (`notifications/progress`) as the bridge for
   streaming partial responses and A2A `tasks/sendSubscribe` events. This is the
   only MCP-native streaming mechanism and it fits both protocols cleanly.
4. Per-agent ACL for delegation (environment + settings-driven) so that
   plumbing `am-mcp` into an untrusted client does not turn it into an
   unrestricted agent launcher.
5. A staged migration: keep the legacy names as aliases for one minor version
   (v0.2 → v0.3), then remove.

## Current tool inventory

Each row is one ACP or A2A operation. Columns: does an `am_acp_*` tool exist,
does an `am_a2a_*` (or `am_agent_*`) tool exist, is there a unified tool?

| Operation | Underlying client call | ACP-tool today | A2A-tool today | Unified? | Gap? |
|---|---|---|---|---|---|
| Enumerate agents | `loadRoster` / built-in registry | `am_acp_list_agents` (server.ts:1933 — actually unified) | `am_agent_list` (server.ts:1549 — roster-only, mislabeled) | partial (via `am_acp_list_agents`) | **Confusing naming.** Unified logic hidden under `am_acp_*` prefix. |
| Discover remote agent card | `A2AClient.discoverAgent` | n/a | `am_agent_discover` (server.ts:1523) | n/a | A2A-only op; OK. |
| Connect to local agent | `AmAcpClient.connect` | Implicit in `am_run_agent` (no standalone tool) | n/a | no | No way to open and keep a session open from an MCP consumer. |
| Create new session | `AmAcpClient.newSession` / A2A has no explicit newSession | Implicit in `am_run_agent` (server.ts:1910) | n/a | no | Cannot create a session without immediately prompting. |
| Load / resume existing session | `AmAcpClient.loadSession` | **MISSING** | n/a | no | **Major gap** — can't resume a durable ACP session. |
| Invoke / prompt (one-shot) | `AmAcpClient.prompt` / `A2AClient.sendTask` | `am_run_agent` (server.ts:1860) | `am_agent_delegate` (server.ts:1573) | no (two tools, same shape) | Two names for the same intent. |
| Invoke with streaming | `onSessionUpdate` / `A2AClient.sendSubscribe` | **MISSING** (returns final text only) | **MISSING** (no wrapper for `sendSubscribe`) | no | **Big gap** — consumer waits blind. |
| Cancel running session | `AmAcpClient.cancel` / `A2AClient.cancelTask` | `am_acp_session_cancel` (server.ts:2003 — actually deletes persisted state, does not call `conn.cancel`) | **MISSING** (no wrapper for `cancelTask`) | no | ACP tool is wrong semantics; A2A has nothing. |
| Get task/session status | `A2AClient.getTask` / n/a for ACP text buffer | **MISSING** (have `am_acp_session_list` but no single-get) | `am_agent_task_status` (server.ts:1617) | no | ACP side cannot poll a session's progress. |
| List sessions | `AmAcpClient.listSessions` / `tasks/list` on server | `am_acp_session_list` (server.ts:1958 — lists the on-disk dir, NOT the agent's `listSessions` RPC) | **MISSING** | no | ACP tool shows filesystem, not the agent's view. A2A missing. |
| Disconnect | `AmAcpClient.disconnect` | Implicit (called at end of `am_run_agent`) | n/a (stateless HTTP) | no | No way for an MCP consumer to force cleanup. |

**Net coverage count:** of the 11 operation rows, 4 are fully covered, 3 are
partially/incorrectly covered, and **4 are missing entirely**. The namespace
split (`am_acp_*` vs `am_agent_*`) produces an additional coherence debt.

## UX from a consuming agent's perspective

A Claude-Code-style consumer sitting on top of `am mcp-serve` sees this (grep of
`name: "am_` in server.ts, filtered to agent-related tools):

```
am_agent_discover        ← A2A: fetch /.well-known/agent.json
am_agent_list            ← A2A roster only (not unified despite the name)
am_agent_delegate        ← A2A sendTask, fire-and-forget
am_agent_task_status     ← A2A getTask
am_run_agent             ← ACP prompt (blocking, returns full text)
am_acp_list_agents       ← unified list (config + ACP builtin + A2A roster)
am_acp_session_list      ← filesystem enumeration of ~/.am/sessions/
am_acp_session_cancel    ← rm -rf on a session dir (NOT protocol-level cancel)
```

Usability problems a consuming agent will hit:

1. **"Which list tool?"** — `am_agent_list` suggests "all agents" but only
   shows A2A. To see the complete picture the agent must call
   `am_acp_list_agents`, whose name suggests ACP-only.
2. **"How do I invoke an agent by name?"** — two tools (`am_run_agent`,
   `am_agent_delegate`). The consumer has to understand ACP vs A2A to pick,
   defeating the point of a control plane.
3. **"Can I stream?"** — no. `am_run_agent` blocks for the entire prompt; there
   is no way to watch tokens roll in. `am_agent_delegate` returns a taskId but
   the consumer has to poll `am_agent_task_status` in a loop, which burns MCP
   round trips.
4. **"Can I cancel?"** — `am_acp_session_cancel` sounds right but it just
   deletes a directory. The underlying ACP subprocess is not signalled (it was
   already exited, because `am_run_agent` disconnects before returning).
5. **"Where are progress updates?"** — there are none. MCP supports
   `notifications/progress`, but the server does not emit any.

Conclusion: the surface is adequate for one-shot delegation but hostile to
anything more sophisticated. An agent that wants to "stream a plan from claude
locally, then fan out to two A2A agents with different prompts, and cancel one
mid-stream" cannot express that today without orchestrating subprocesses
manually.

## Gaps

Concrete missing functionality:

1. **No unified invoke.** `am_run_agent` and `am_agent_delegate` do the same
   thing over different transports. A caller should not need to know.
2. **No streaming.** MCP has `notifications/progress` (MCP spec 2025-06-18,
   §6.3); neither `am_run_agent` nor `am_agent_delegate` emits any.
3. **No `am_a2a_send_subscribe`.** The client-side implementation exists
   (`src/protocols/a2a/client.ts:260`) and is wired into the CLI, but has no
   MCP tool wrapper.
4. **No `am_a2a_cancel`.** `A2AClient.cancelTask` exists (client.ts:230) but
   no MCP tool calls it. The only "cancel" tool, `am_acp_session_cancel`, is
   ACP-only and does the wrong thing.
5. **No `am_acp_load_session`.** `AmAcpClient.loadSession` exists (client.ts:308)
   but is unreachable from MCP — an agent cannot resume a named session.
6. **No `am_acp_cancel` that actually calls the protocol.** The current
   `am_acp_session_cancel` only unlinks the on-disk session directory
   (server.ts:2028); it does not call `conn.cancel({sessionId})`.
7. **No `am_agent_status` unified status.** A2A has `am_agent_task_status`;
   ACP has nothing (the `am_run_agent` flow returns final text, no concept of
   an in-flight status read).
8. **No per-agent ACL.** Any caller that can hit the MCP socket can invoke any
   ACP agent on the host, inheriting the host's permissions. ACP's `auto-approve`
   policy (client.ts:79) is applied blindly per subprocess. A guard like
   `settings.mcp_serve.agents.allow = ["claude", "codex"]` does not exist.
9. **Naming inconsistency.** `am_run_agent` vs `am_agent_delegate` vs
   `am_acp_list_agents` vs `am_agent_list` — no single naming scheme. Either
   all `am_agent_*` or split cleanly into `am_acp_*`/`am_a2a_*`.
10. **No capability probe.** Consumers cannot ask "does this agent support
    streaming?" without discovering the A2A card (for remote) or connecting
    (for ACP). A unified `am_agent_capabilities` would avoid transport-specific
    probes.

## Streaming design options

The core tension: MCP `tools/call` returns a single `CallToolResult`. ACP
`prompt` and A2A `tasks/sendSubscribe` both stream intermediate events.

### Option (a) — Block and return final result only (status quo)

**Pros:** simplest; already works for `am_run_agent`.
**Cons:** no partial output, no tool-call visibility, no cancellation handle.
Long prompts make the consuming agent look frozen.

### Option (b) — MCP `notifications/progress` (recommended)

MCP defines `notifications/progress` for exactly this case. Flow:

1. Consumer passes `params._meta.progressToken = "<opaque>"` on `tools/call`.
2. Server emits `notifications/progress` messages during the call:
   ```
   { jsonrpc: "2.0", method: "notifications/progress",
     params: { progressToken: "<opaque>", progress: 0.3, total: 1.0,
               message: "<partial text chunk>" } }
   ```
3. Server returns the final `CallToolResult` when the ACP/A2A stream terminates.

This maps naturally onto both protocols:

- **ACP:** the existing `AmAcpClient.onSessionUpdate` handler fires for every
  `agent_message_chunk` and `tool_call`. Wire that to a progress emitter keyed
  by the progressToken.
- **A2A:** `A2AClient.sendSubscribe` already has `SubscribeCallbacks.onStatus`
  and `onArtifact`. Same wiring.

**Pros:** MCP-native, no polling, no new transport, correctly timed
cancellation via `notifications/cancelled`. Every modern MCP client supports
it.
**Cons:** server must track in-flight invocations keyed by progressToken and
clean up on disconnect. Adds one module of state; a few hundred LOC.

### Option (c) — Return session id, poll

Tool returns `{sessionId}` immediately; consumer calls `am_agent_status`
repeatedly. This is what `am_agent_delegate` + `am_agent_task_status` already
do, and it works. But it forces at least one MCP round trip per update, is
client-burdensome, and there is no standard way for the consumer to tell the
server "stop polling, cancel."

**Pros:** works today, no MCP progress support needed.
**Cons:** wasteful; ~1 s minimum granularity; doesn't map cleanly to ACP's
fine-grained token stream.

### Option (d) — SSE over an alternate transport

Not applicable: `am mcp-serve` is stdio JSON-RPC. SSE would require running an
HTTP surface, which is a different product.

### Recommendation

**Option (b), with (c) as a graceful fallback.**

- The unified `am_agent_invoke` tool accepts a `stream: true` hint AND a
  `params._meta.progressToken`. When the token is present, the server emits
  `notifications/progress` for every ACP session update and every A2A SSE
  event. When absent, the tool blocks and returns the final text (today's
  behavior).
- `am_agent_invoke_async` returns `{sessionId}` immediately for consumers that
  genuinely cannot handle progress notifications (Option c). They poll via
  `am_agent_status`.

This gives us modern streaming without breaking older MCP clients.

## Security surface for delegation

Exposing ACP/A2A via MCP means an agent on the other end of the stdio socket
can, today, spawn arbitrary ACP subprocesses and hit arbitrary A2A URLs. Two
attack surfaces:

1. **Local process escalation.** `am_run_agent "claude" "<prompt>"` spawns
   `claude-agent-acp` with `auto-approve` permission policy
   (client.ts:79/437). The prompt can instruct the spawned agent to read/write
   files, run terminals, etc., all inheriting the invoking user's permissions.
2. **Outbound SSRF.** `am_agent_delegate` sends HTTP POSTs to whatever URL is
   in the roster. A malicious roster entry (added before `am mcp-serve` was
   started) points at an internal endpoint.

Mitigations (layered):

### (1) Reuse existing write-tier auth

Both `am_run_agent` and `am_agent_delegate` are `write-remote` tier
(server.ts:1885, server.ts:1585). Under `AM_MCP_TOKEN`, they already require a
bearer token (server.ts:189 `checkWriteAuth`). Good default; keep.

### (2) Per-agent allow-list

Add `settings.mcp_serve.agents.allow: string[]` and
`settings.mcp_serve.agents.deny: string[]`. Empty `allow` means "default
behavior"; non-empty means an invocation of any agent not in the list returns
a structured `AUTHZ_DENIED` error. Pattern mirrors the existing `allow_push`
gate for sync tools (server.ts:270).

### (3) URL allowlist for A2A

Add `settings.mcp_serve.a2a.allow_hosts: string[]` (host or host:port).
`am_agent_discover` and `am_agent_delegate` refuse URLs outside the list. RFC
1918 / loopback / link-local go in a deny-by-default list unless explicitly
allowed (SSRF hardening in line with `src/lib` conventions).

### (4) Permission-policy pass-through

Let the MCP call set `permissionPolicy: "auto-approve" | "deny"` per
invocation, default `"deny"` when running under MCP. The existing
`AmAcpClient.setPermissionPolicy` (client.ts:101) supports both. Today
`am_run_agent` never sets it, so the client defaults to `auto-approve`, which
is wrong for a delegated call.

### (5) Audit trail

Log every invoke with `{caller token hash, agent name, protocol, session id,
status, duration}` to the existing session dir. This already exists for ACP
sessions on disk (ADR-0026); extend to A2A so every delegation leaves a trace.

## Proposed unified invoke tool

New tool surface (all under `am_agent_*`):

```
am_agent_list              ← enumerate ACP built-ins + A2A roster + config overrides
am_agent_discover          ← A2A-only: fetch agent card
am_agent_capabilities      ← ACP: probe supported methods; A2A: summarize card
am_agent_invoke            ← unified prompt, ACP or A2A, blocking by default,
                             streams via notifications/progress when progressToken present
am_agent_invoke_async      ← unified fire-and-forget; returns {sessionId}
am_agent_status            ← unified get (ACP session view + A2A tasks/get)
am_agent_session_list      ← unified list (ACP listSessions RPC + A2A tasks/list)
am_agent_session_cancel    ← unified cancel (ACP cancel RPC + A2A tasks/cancel)
am_agent_session_resume    ← ACP loadSession (A2A: alias to invoke with same id)
am_agent_disconnect        ← ACP-specific: tear down subprocess (no-op on A2A)
```

### `am_agent_invoke` schema

```json
{
  "name": "am_agent_invoke",
  "description": "Invoke an agent with a prompt. Routes to ACP (local subprocess) or A2A (remote HTTP) based on the agent's registry entry. Supports streaming via notifications/progress when params._meta.progressToken is set.",
  "inputSchema": {
    "type": "object",
    "required": ["agent", "prompt"],
    "properties": {
      "agent":    { "type": "string",  "description": "Agent name from am_agent_list." },
      "prompt":   { "type": "string",  "description": "Prompt text." },
      "session":  { "type": "string",  "description": "Named session to create or resume. Omit for anonymous." },
      "cwd":      { "type": "string",  "description": "Working directory for ACP agents (ignored for A2A)." },
      "stream":   { "type": "boolean", "description": "Request progress notifications. Requires params._meta.progressToken. Default: auto (true if token present).", "default": false },
      "timeout":  { "type": "number",  "description": "Overall timeout ms. Default: 120000." },
      "permissionPolicy": { "enum": ["auto-approve", "deny"], "default": "deny", "description": "ACP only: how to respond to agent-initiated permission requests." }
    }
  }
}
```

### Semantics

1. Resolve `agent` via `listAllAgentsAsync` (src/core/agent-registry.ts:238).
2. If the resolved entry has `.acp`, use the ACP path; if it has `.a2a`, use
   A2A; if both, prefer the explicit `transport` arg (add it as an optional
   input) with ACP as the default for local-first.
3. Check ACL: `settings.mcp_serve.agents.allow` and `.deny` (see Security
   section).
4. For ACP:
   - `createAcpClient()` → `connect(entry.acp.command)` → `newSession({cwd})`
     → `prompt(sessionId, [{type:"text",text:prompt}])`.
   - If `progressToken` present: install an `onSessionUpdate` handler that
     emits `notifications/progress` for every chunk and tool call.
   - `disconnect()` at end (finally block). **Apply `setPermissionPolicy(policy)`
     before `prompt`.**
5. For A2A:
   - If `progressToken` present: call `A2AClient.sendSubscribe(url, params,
     {onStatus, onArtifact})` and map each event to `notifications/progress`.
   - Else: `A2AClient.sendTask` then `pollTask` (exists at client.ts:247).
6. Return `{sessionId, agent, protocol, text, toolCalls[], usage?}`.

### Progress notification payload shape

```json
{
  "progressToken": "<caller-supplied opaque>",
  "progress": 0.0,
  "total": 1.0,
  "message": {
    "kind": "agent_message_chunk" | "tool_call" | "a2a_status" | "a2a_artifact",
    "data": { ...event-specific... }
  }
}
```

We do not try to compute a meaningful `progress` number (no way to know how
much work remains). Clients that care only about the message stream ignore
the `progress` field, which the spec permits.

## Migration path from old tools

Target: unified `am_agent_*` surface in v0.3. Keep the old names as aliases
through v0.3, remove in v0.4.

| Old tool | New tool | Migration |
|---|---|---|
| `am_run_agent` | `am_agent_invoke` | Alias in v0.3 (same handler). Deprecation warning in description. Remove v0.4. |
| `am_agent_delegate` | `am_agent_invoke_async` | Alias in v0.3. Remove v0.4. |
| `am_agent_task_status` | `am_agent_status` | Alias in v0.3. Remove v0.4. |
| `am_acp_list_agents` | `am_agent_list` | Swap bodies: `am_agent_list` becomes unified (not roster-only); `am_acp_list_agents` becomes alias. Remove v0.4. |
| `am_agent_list` (old, roster-only) | part of `am_agent_list` | Protocol becomes a column in the output. New output format is additive; consumers that only read `agents[].name` are unaffected. |
| `am_acp_session_list` | `am_agent_session_list` | Alias in v0.3. Also **fix** semantics to call the agent's `listSessions` RPC rather than just reading the on-disk dir. Add a `scope: "protocol" \| "disk"` arg that defaults to `"protocol"`. |
| `am_acp_session_cancel` | `am_agent_session_cancel` | Alias in v0.3, but the new implementation ALSO calls `conn.cancel({sessionId})` (the current one only rm's the dir). Document behavior change in CHANGELOG under "Bug fix." |
| (none — new) | `am_agent_discover` | Unchanged — A2A specific. |
| (none — new) | `am_agent_capabilities` | New. |
| (none — new) | `am_agent_session_resume` | New — wraps `AmAcpClient.loadSession`. |
| (none — new) | `am_agent_disconnect` | New — explicit teardown. |

Tool-group assignment (for `settings.mcp_serve.tools`, ADR-0021):

- Drop the `acp` group. Merge into `a2a` → rename the group to `agents`.
- `TOOL_GROUP_MAP` (server.ts:225) gets simpler; documented as single group.

Docs impact:

- Update `ADRs/0021-mcp-tool-grouping-and-gateway.md` to show `agents` group.
- Update `ADRs/0026-acpx-acp-runtime-integration.md` to reference the unified
  tools.
- `AGENTS.md` and `README.md` examples use the new names.

## Implementation sequence

Ordered, each step independently landable and testable:

**Step 1 — Progress notification plumbing (foundation).**
Add `emitProgress(progressToken, payload)` to the MCP server. Hook the stdio
writer so a mid-call emit is serialized and not interleaved with another
response. Wire through `ToolHandler` context (today handlers receive only
args; they need a `ctx` with `emitProgress`, `abortSignal`, `authHash`).
Add a `notifications/cancelled` handler that sets the signal. Two new tests:
one emits progress during a mock tool, one cancels mid-call.
_Scope:_ ~300 LOC in `src/mcp/server.ts`, ~150 LOC tests.

**Step 2 — Unified `am_agent_invoke` (blocking path).**
Land the new tool as an alias for `am_run_agent` with protocol auto-detection
and unified handler. No streaming yet; blocking only. Keep `am_run_agent`
working identically. Add E2E test that calls `am_agent_invoke` against both an
ACP mock and an A2A mock. Verify identical output shape.
_Scope:_ ~200 LOC, 2 new tests.

**Step 3 — Streaming via progress.**
Wire `AmAcpClient.onSessionUpdate` and `A2AClient.sendSubscribe` callbacks to
`ctx.emitProgress`. Add `params._meta.progressToken` extraction (mirror
`extractBearerToken` at server.ts:169). Test: mock ACP emits 10 chunks,
consumer sees 10 `notifications/progress` + 1 final result.
_Scope:_ ~250 LOC, 3 tests (happy, cancellation, fallback-when-no-token).

**Step 4 — Fill in the gaps: capabilities, resume, disconnect, cancel, status,
session_list.**
Land the remaining unified tools. Fix `am_acp_session_cancel` to call
`conn.cancel` (bug fix). Wire `am_agent_session_list` to `AmAcpClient.listSessions`
and `A2AClient.getTask`-based listing (A2A has a `tasks/list` server-side
handler at server.ts:573, but no client wrapper; add `A2AClient.listTasks`).
_Scope:_ ~400 LOC across client + server, 6 tests.

**Step 5 — Security surface.**
Add `settings.mcp_serve.agents.{allow, deny}` and
`settings.mcp_serve.a2a.{allow_hosts, deny_hosts}`. Default
`permissionPolicy` to `"deny"` in all agent-invoke tools (breaking behavior
for existing write-remote callers that relied on auto-approve; documented as a
security bug fix). Add per-invoke audit log entry.
_Scope:_ ~200 LOC, 4 tests covering allow/deny/ACL/SSRF.

**Step 6 — Deprecation aliases + docs.**
Keep old tool names as aliases with description prefix `[DEPRECATED, use
am_agent_* — removal in v0.4]`. Update ADR-0021 and ADR-0026. Update README
and AGENTS.md.
_Scope:_ small, mostly descriptions + docs.

**Step 7 — Removal (v0.4 release).**
Delete the aliases. Delete the `acp` tool group. Collapse `TOOL_GROUP_MAP`
into the `agents` group. Final ADR note.

Total estimated scope for Steps 1–6: ~1,400 LOC + ~20 tests. All steps are
CI-gated and backward-compatible until Step 7.

## References

- `src/mcp/server.ts:485–2037` — current tool registry.
- `src/mcp/server.ts:1860–2037` — the four ACP-related tools.
- `src/mcp/server.ts:1523–1648` — the four A2A-related tools.
- `src/protocols/acp/client.ts:71–394` — `AmAcpClient` surface (connect,
  newSession, prompt, cancel, loadSession, listSessions, disconnect).
- `src/protocols/a2a/client.ts:80–316` — `A2AClient` surface (discoverAgent,
  sendTask, getTask, cancelTask, pollTask, sendSubscribe).
- `src/protocols/a2a/server.ts:524–622` — server-side routing for `tasks/send`,
  `tasks/get`, `tasks/list`, `tasks/cancel`.
- `src/core/agent-registry.ts:238` — `listAllAgentsAsync`, already produces the
  unified protocol view the new `am_agent_list` should expose.
- ADR-0017 (Agent Communication Protocol selection), ADR-0021 (MCP tool
  grouping), ADR-0026 (ACP runtime integration), ADR-0030 (Unified agent
  registry), ADR-0031 (Product scope and pillars).
- MCP specification 2025-06-18 §6.3 — `notifications/progress`.
- A2A specification v0.3 — `tasks/sendSubscribe` (SSE framing).
