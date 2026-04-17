# Protocol Spec Conformance Audit (Iter 2)

**Date:** 2026-04-16
**Scope:** MCP, ACP, A2A conformance (not correctness)
**Method:** Fetch current specs, enumerate MUST / MUST NOT requirements, grep implementation, verify behavior.

**Spec sources:**
- MCP: https://modelcontextprotocol.io/specification/2025-11-25/basic (version 2025-11-25)
- MCP lifecycle: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- ACP: https://agentclientprotocol.com/protocol/initialization , /protocol/session-setup , /protocol/prompt-turn
- A2A: https://a2a-protocol.org/latest/specification/ (version 0.3+)

---

## Summary

| Protocol | Role | Conformance | Worst gap |
|----------|------|-------------|-----------|
| **MCP (server)** | server | **~70%** | Accepts requests with `jsonrpc` field set to anything (no validation); hardcodes protocolVersion `2024-11-05` and ignores client-requested version (no negotiation). |
| **ACP (client)** | client | **~85%** | Internal `permissionPolicy` is a simplification layer (`auto-approve` / `deny`) — does not match the spec's permission-option taxonomy (`allow_once`, `allow_always`, `reject_once`, `reject_always`). It is a client-side mapping, not a protocol wire value, so not a conformance break, but conflates semantics. |
| **A2A (server)** | server | **~55%** | Missing `tasks/list` method (MUST per v0.3). Does not honor or validate `A2A-Version` header (MUST per v0.3). Agent Card is served at legacy `/.well-known/agent.json`; v0.3 uses `/.well-known/agent-card.json` (discovery SHOULD preserve legacy, but authoritative publish path is wrong). AgentCard schema missing `protocolVersion`, `securitySchemes`, `preferredTransport`, `supportsAuthenticatedExtendedCard` required in v0.3. |

Overall: protocols work for the happy path but do not enforce many of the "reject malformed / unsupported" MUST / MUST NOT clauses the specs require. The server is permissive where the specs demand strictness.

---

## MCP: MUST / MUST NOT table

Spec version: **2025-11-25**. Our `initialize` response hard-codes `"2024-11-05"` (see Version Negotiation section).

| # | Requirement (spec section) | Our behavior | Conforms | File:line |
|---|----------------------------|--------------|:--------:|-----------|
| M1 | "All messages … **MUST** follow the JSON-RPC 2.0 specification" (Base Protocol / Messages) | We parse JSON but do **not** validate that `req.jsonrpc === "2.0"`. A request with `jsonrpc: "1.0"`, `jsonrpc: "3.0"`, or missing `jsonrpc` entirely is dispatched to the method switch the same as a valid 2.0 request. | **No** | `src/mcp/server.ts:2229` (JSON.parse, no shape check); `src/mcp/server.ts:2044` (handleRequest — no jsonrpc guard) |
| M2 | "Requests **MUST** include a string or integer ID." | Our type allows `id?: string \| number \| null` (optional). We do not reject a request with a missing `id` for non-notification methods. `handleRequest` converts missing id to `null`. | **No** | `src/mcp/server.ts:36` (`id?: ... \| null` on the type); `src/mcp/server.ts:2045` (`const id = req.id ?? null`) |
| M3 | "Unlike base JSON-RPC, the ID **MUST NOT** be `null`." | We permit `id: null` for requests (normalizing missing id to null and returning responses with `id: null`). Parse-error branch intentionally returns `id: null` (allowed by spec for malformed input), but we also send `id: null` for other cases. | **No** | `src/mcp/server.ts:2045`, `:2233` (parse error response with id=null is fine); `:2187–2198` (treats `req.id != null` as "is request", but the spec says null id itself is invalid) |
| M4 | "The request ID **MUST NOT** have been previously used by the requestor within the same session." | We don't track previously-seen IDs. We respond to whatever the client sends. This is a client-side MUST, but a strict server could detect and reject. Not required of the server, so acceptable. | **N/A (client rule)** | — |
| M5 | "Result responses **MUST** include the same ID as the request." | Every success branch returns `id` from the request. Verified for `initialize`, `tools/list`, `tools/call`. | **Yes** | `src/mcp/server.ts:2055, 2085, 2156` |
| M6 | "Error responses **MUST** include the same ID … (except where the ID could not be read)". Error codes **MUST** be integers. | Matches. Parse error returns `id: null`, known errors echo `id`. Codes used: -32700, -32601 (integers). | **Yes** | `src/mcp/server.ts:2101–2107, 2189–2196, 2232–2237` |
| M7 | "Notifications **MUST NOT** include an ID." & "The receiver **MUST NOT** send a response." | We handle `notifications/initialized` (line 2067) returning `null` — correct. For unknown methods with no id we also return null (line 2197). | **Yes** | `src/mcp/server.ts:2067–2069, 2187–2198` |
| M8 | "The initialization phase **MUST** be the first interaction …" | We have no ordering enforcement: a client can send `tools/list` or `tools/call` before `initialize` and we will answer. Spec says "SHOULD NOT send requests other than pings before …", but the initialization-first rule is a MUST. | **No (partial)** | `src/mcp/server.ts:2052` — switch has no state guard |
| M9 | "The client **MUST** initiate [initialization] by sending an `initialize` request containing: protocolVersion, client capabilities, clientInfo" | Server-side MUST is to respond. We respond with protocolVersion + capabilities + serverInfo — ok. | **Yes (server side)** | `src/mcp/server.ts:2054–2065` |
| M10 | Version negotiation: "If the server supports the requested protocol version, it **MUST** respond with the same version. Otherwise, the server **MUST** respond with another protocol version it supports." | We **always** respond with `"2024-11-05"` regardless of `params.protocolVersion`. A client requesting `2025-11-25` (current) gets a silent downgrade. No version mismatch error envelope is returned for cases where we can't support the requested version. | **No** | `src/mcp/server.ts:2058` (hardcoded literal); no read of `req.params.protocolVersion` |
| M11 | Clients and servers **MUST** support JSON Schema 2020-12 for schemas without an explicit `$schema` field. | Our tool `inputSchema` objects don't declare `$schema`. Fields like `type: "object"` / `required: [...]` are 2020-12-compatible. Acceptable — no forbidden draft-07-only keywords used. | **Yes** | `src/mcp/server.ts:454–456, 735–743, etc.` (tool schemas) |
| M12 | "Both parties **MUST** respect the negotiated protocol version" and "only use capabilities that were successfully negotiated." | Server declares `capabilities: { tools: {} }`. We then only dispatch `tools/list` and `tools/call` (beyond lifecycle). Conforms. | **Yes** | `src/mcp/server.ts:2059, 2071, 2093` |
| M13 | Error code semantics (JSON-RPC 2.0): -32700 parse, -32600 invalid request, -32601 method not found, -32602 invalid params, -32603 internal error. | We use -32700 (parse) and -32601 (method not found). We never emit -32600 (invalid request) even when the request is malformed — see M1 — because we don't validate. We never emit -32602 for invalid params at the JSON-RPC level (invalid args return a `result.isError:true` envelope instead of an `error` response; see M14). We never emit -32603 for internal errors; we wrap handler exceptions in `result.isError:true`. | **Partial** | `src/mcp/server.ts:2234` (-32700), `:2103, 2192` (-32601), no -32600/-32602/-32603 emission |
| M14 | "Error responses **MUST** include an `error` field with a `code` and `message`." | When a tool handler throws, we do **not** emit a JSON-RPC error. Instead we emit `result: { content: [...], isError: true }`. This is the MCP-level "tool error" convention (spec-defined for tool call errors), so acceptable for tool failures. However, when `tools/call` is invoked with an unknown tool (line 2099) we do correctly emit a JSON-RPC error with -32601. Mixed but compliant. | **Yes** | `src/mcp/server.ts:2099–2107, 2162–2183` |
| M15 | `_meta` key name format MUST be prefix + name with label rules (reverse-DNS). | We read `params._meta.authorization` / `.token` for auth. We don't prefix our own keys under `_meta`. Not emitting any `_meta` fields means we can't violate the reserved-prefix MUST NOT. | **Yes** | `src/mcp/server.ts:135–149` |
| M16 | Batch requests: JSON-RPC 2.0 allows arrays. MCP base spec (2025-11-25) has removed batching requirement; we still implement batch handling. Each request in a batch must have a unique ID (spec inherited from JSON-RPC). | We handle `Array.isArray(req)` and dispatch in parallel (line 2240). We do **not** check for duplicate IDs within a batch. | **Partial** | `src/mcp/server.ts:2240–2249` |
| M17 | Icons: "Clients that support rendering icons **MUST** support `image/png` and `image/jpeg`." | We don't emit or render icons — N/A. | **N/A** | — |
| M18 | "Implementations **SHOULD** establish timeouts for all sent requests" (SHOULD — non-normative MUST, included for completeness). | Server-side we have no per-request timeout. Individual tool handlers can hang; the parent process would be the enforcement boundary. SHOULD only. | **Weak compliance (SHOULD)** | `src/mcp/server.ts` — no timeout scaffolding |

---

## ACP: MUST / MUST NOT table

Our ACP layer is purely a **client** (driving local coding agents). Spec source: https://agentclientprotocol.com.

| # | Requirement | Our behavior | Conforms | File:line |
|---|-------------|--------------|:--------:|-----------|
| A1 | "Clients **MUST** call `initialize` with the latest protocol version they support." | We import `PROTOCOL_VERSION` from `@agentclientprotocol/sdk` and pass it — SDK manages the version number, so we track the installed SDK's "latest." | **Yes** | `src/protocols/acp/client.ts:24, 169` |
| A2 | "Clients **MUST** send `initialize` … before any session can be created." | `connect()` always awaits `initialize()` before returning; `newSession()` calls `requireConnection()` which throws if not connected. Enforced by the SDK's `ClientSideConnection`. | **Yes** | `src/protocols/acp/client.ts:166–180, 255–263, 368–373` |
| A3 | "Clients **MUST** verify `loadSession` capability before attempting to load. If `loadSession` is false or absent, clients **MUST NOT** call `session/load`." | `loadSession()` is unconditional — it does not check `this.connInfo.capabilities.loadSession` before calling `conn.loadSession(...)`. | **No** | `src/protocols/acp/client.ts:308–316` |
| A4 | "Working directory **MUST** be an absolute path." | `newSession({ cwd })` passes `cwd` through untouched. Callers (e.g., `am run_agent` in MCP server: `const cwd = (args.cwd as string) ?? process.cwd()`) can pass a relative path without validation. `process.cwd()` is absolute, but user-supplied `cwd` is not checked. | **No (thin wrapper; callers can leak relative paths)** | `src/protocols/acp/client.ts:255–263`; `src/mcp/server.ts:1857` |
| A5 | "Clients **MUST** respond to all pending `session/request_permission` requests with the `cancelled` outcome" upon cancellation. | `requestPermission()` handler (line 425) returns a selected option in all cases. There is no special path that detects in-flight cancellation and returns `{ outcome: "cancelled" }`. The SDK may handle this internally, but our handler does not. | **No (partial; SDK may paper over)** | `src/protocols/acp/client.ts:425–445` |
| A6 | "Clients **MUST** restrict types of content according to the Prompt Capabilities established during initialization." | `prompt()` only sends `ContentBlock` with `type: "text"` (see line 277–280). Agents MUST support `text` and `resource_link` per ACP spec, so text-only is always safe. | **Yes** | `src/protocols/acp/client.ts:272–295` |
| A7 | Version-agreement MUST — "Clients and Agents **MUST** agree on a protocol version and act according to its specification." | We accept whatever the agent returns in `initResponse.agentCapabilities` without checking the version matches. If the agent responds with an older version we don't support, we don't disconnect (spec SHOULD, not MUST, but related). | **Weak** | `src/protocols/acp/client.ts:167–188` |
| A8 | permissionPolicy values: spec defines option `kind`s: `allow_once`, `allow_always`, `reject_once`, `reject_always`. | Our internal `PermissionPolicy` type is a **meta-mode** (`auto-approve` or `deny`) that we use to pick which spec-defined option to select. We never send a permissionPolicy value on the wire; we respond with the agent-provided optionId. | **Yes (spec-conformant on the wire)** | `src/protocols/acp/client.ts:55, 425–445` |
| A9 | MUST NOT accept permission options outside spec set. | We find options by `kind` from the incoming request payload — we don't mint our own kinds. If the agent omits a matching option we fall back to `options[0]`, which is always an agent-provided option. | **Yes** | `src/protocols/acp/client.ts:429–443` |
| A10 | Agent MUST support stdio transport. | We spawn a subprocess over stdio. Uses `ndJsonStream`. | **Yes** | `src/protocols/acp/client.ts:129–142` |
| A11 | session/prompt streaming: agent emits `session/update` notifications with text chunks + tool calls. Client should collect them. | `_handleSessionUpdate` forwards to user handler and accumulates `agent_message_chunk` + `tool_call`. Resets on each new prompt. | **Yes** | `src/protocols/acp/client.ts:272–295, 376–393` |
| A12 | session/cancel MUST be implemented if the client exposes prompt turns. | Implemented: `cancel(sessionId)` → `conn.cancel({ sessionId })`. | **Yes** | `src/protocols/acp/client.ts:300–303` |
| A13 | Client handler MUST answer agent-initiated `fs/read_text_file` etc. when `fs.readTextFile` capability was declared. | We declared `fs: { readTextFile: true, writeTextFile: true }` (line 173) and handle both. Also declared `terminal: true` and handle terminal lifecycle. | **Yes** | `src/protocols/acp/client.ts:170–175, 455–541` |

---

## A2A: MUST / MUST NOT table

Spec version: **0.3+** (a2a-protocol.org). Our role: **server** (with a client for discovery + delegation).

| # | Requirement | Our behavior | Conforms | File:line |
|---|-------------|--------------|:--------:|-----------|
| T1 | "Clients **MUST** send the `A2A-Version` header with each request." | Our **client** (`A2AClient.rpcCall`) does **not** set `A2A-Version`. Our **server** does not read or validate it. | **No** | `src/protocols/a2a/client.ts:56–66, 132–139`; `src/protocols/a2a/server.ts:626–637` |
| T2 | "Agents **MUST** process requests using the semantics of the requested A2A-Version." / "Agents **MUST** return a `VersionNotSupportedError` for unsupported versions." | We neither read nor version-gate. Every request is treated as the only version we speak. | **No** | `src/protocols/a2a/server.ts:626–637` |
| T3 | "Agents **MUST** interpret empty value as 0.3 version." | N/A since we don't read the header. | **No** | — |
| T4 | Agent Card served at well-known URI (v0.3 standardizes `/.well-known/agent-card.json`). | We serve at `/.well-known/agent.json` (legacy path). Discovery client also only probes that path. Newer A2A-compliant peers serving `agent-card.json` will not be discovered. | **No (legacy path only)** | `src/protocols/a2a/server.ts:608`; `src/protocols/a2a/client.ts:87`; `src/protocols/a2a/discovery.ts` |
| T5 | AgentCard required fields (v0.3 §4.4.1): `protocolVersion`, `name`, `description`, `url`, `version`, `capabilities`, `defaultInputModes`, `defaultOutputModes`, `skills`, `securitySchemes` (if auth), and newer fields like `preferredTransport`, `supportsAuthenticatedExtendedCard`. | Our AgentCard has `name`, `description`, `version`, `url`, `capabilities`, `skills`, `defaultInputModes`, `defaultOutputModes`, `authentication`, `provider`. **Missing**: `protocolVersion`, `securitySchemes`, `preferredTransport`, `supportsAuthenticatedExtendedCard`. Also, we use `authentication: [{type:"bearer"}]` but v0.3 uses OpenAPI-style `securitySchemes` + `security`. | **No** | `src/protocols/a2a/types.ts:11–22`; `src/protocols/a2a/generate-card.ts:141–154` |
| T6 | "Agents **MUST** generate a unique taskId for each new task they create." | We accept client-provided `id` in `tasks/send` and use it directly as the task key — `getOrCreateTask(store, p.id)`. Spec says "Client-provided taskId values for creating new tasks is NOT supported." | **No** | `src/protocols/a2a/server.ts:159–174, 464–474` |
| T7 | "Agents **MUST** return a `TaskNotFoundError` if the provided taskId does not correspond to an existing task." | We return JSON-RPC error code `-32001` with message `"Task not found: <id>"`. This is a custom code, not the spec's named error. Spec expects a structured error (with a `@type` detail). Close enough but not exact. | **Partial** | `src/protocols/a2a/server.ts:488–490, 511–513` |
| T8 | tasks/get: "Servers **MUST** validate all input parameters before processing." | We check `p?.id` presence and reject missing with -32602. We don't validate `historyLength >= 0` (a negative number would `.slice(-n)` returning all history — not dangerous but non-conformant). | **Partial** | `src/protocols/a2a/server.ts:477–501` |
| T9 | tasks/get: "Servers **MUST NOT** distinguish between 'does not exist' and 'not authorized' to prevent information leakage." | We have no per-task authorization model; all tasks in the store are visible to any authenticated caller. Conforms vacuously. | **Vacuous** | `src/protocols/a2a/server.ts:487–501` |
| T10 | tasks/list: section 3.1.4 — cursor-paginated list with `nextPageToken` always present (empty string when done). | **Not implemented.** There is no `tasks/list` case in the switch statement. Clients calling `tasks/list` get `-32601 Method not found`. | **No** | `src/protocols/a2a/server.ts:454–535` (switch has no `tasks/list`) |
| T11 | tasks/cancel: "Cancel operations are idempotent — multiple cancellation requests have the same effect." | We return `-32003 Cannot cancel task in state: completed` if already terminal, instead of succeeding idempotently. Second cancel of a cancelled task would also hit that branch. Non-idempotent. | **No** | `src/protocols/a2a/server.ts:505–530` |
| T12 | tasks/sendSubscribe: "Subscribe stream **MUST** return a Task object as the first event in the stream" and "MUST close when the task reaches a terminal state." | First SSE frame is an `event: status` with `{id, status, final}`. Spec expects the initial frame to be a **Task** object (not a status update). We emit a `TaskStatusUpdateEvent`, not a Task. Stream does close on terminal state. | **Partial** | `src/protocols/a2a/server.ts:705–748` |
| T13 | tasks/sendSubscribe: "MUST deliver events in the order they were generated. Events MUST NOT be reordered." | We use a single in-process `TaskEventEmitter` per task and push synchronously. Order preserved. | **Yes** | `src/protocols/a2a/server.ts:105–118, 719–731` |
| T14 | Capability negotiation: "If streaming not declared, attempts MUST return `UnsupportedOperationError`." | We declare `streaming: true` in our AgentCard (line 129) and do support it. Conforms. | **Yes** | `src/protocols/a2a/generate-card.ts:128–132` |
| T15 | Capability negotiation: "If push notifications not supported, config operations MUST return `PushNotificationNotSupportedError`." | We declare `pushNotifications: false` and do not implement push-notification endpoints. Any client that somehow called one would get -32601 instead of `PushNotificationNotSupportedError`. | **Partial (no push endpoints exist to hit)** | `src/protocols/a2a/generate-card.ts:128–132` |
| T16 | Capability negotiation: MUST NOT accept negotiation of capabilities we don't implement. | We declare only what we implement (streaming=true, pushNotifications=false, stateTransitionHistory=true). No false advertisement. | **Yes** | `src/protocols/a2a/generate-card.ts:128–132` |
| T17 | Error responses "MUST convey" a machine-readable code, human-readable message, and optional `details[]` array where each detail has a `@type` key. | Our errors are `{code, message, data?}` — no `details[]` / `@type`. Close enough for JSON-RPC but not fully A2A-structured. | **Partial** | `src/protocols/a2a/server.ts:377–388` |
| T18 | "Server **MUST NOT** return more messages than the provided `historyLength` value." | We slice `history.slice(-p.historyLength)` — respects the limit. | **Yes** | `src/protocols/a2a/server.ts:491–498` |
| T19 | Servers **MUST** reject requests with invalid or missing authentication credentials. | When `auth_token` is configured, middleware at `/a2a` returns 401. Timing-safe compare used. The Agent Card endpoint is unauthenticated (matches spec — public by design). | **Yes** | `src/protocols/a2a/server.ts:615–623` |
| T20 | `tasks/send` MUST return immediately with task info (or response message). | We synchronously call `startTask` (which mutates state, kicks off async handler) and return the task in `submitted`/`working` state. | **Yes** | `src/protocols/a2a/server.ts:463–474` |
| T21 | Task state transitions: `completed`, `failed`, `canceled`, `rejected` are terminal. `input-required`, `auth-required` are interrupted (non-terminal). | Our `TaskState` type is `"submitted" \| "working" \| "input-required" \| "completed" \| "canceled" \| "failed"`. Missing `"rejected"` and `"auth-required"` from v0.3. `isTerminalState()` covers `completed\|failed\|canceled` but not `rejected`. | **No (schema gap)** | `src/protocols/a2a/types.ts:51–58`; `src/protocols/a2a/server.ts:120–122` |
| T22 | "Agents **MUST** reject messages containing mismatching contextId and taskId." | We don't model `contextId` at all. Messages have no `contextId` field in our types. Can't check a mismatch we don't store. | **No (feature missing)** | `src/protocols/a2a/types.ts:75–79` |
| T23 | JSON-RPC envelope: `jsonrpc === "2.0"`. | We **do** validate: `if (!req.jsonrpc \|\| req.jsonrpc !== "2.0" \|\| !req.method) return jsonRpcError(..., -32600, ...)`. This is stricter than the MCP server. | **Yes** | `src/protocols/a2a/server.ts:635–637` |

---

## Forbidden-thing accept check

Things specs forbid that a lax implementation might still accept. We tested each by reading the dispatch path.

| Forbidden behavior | MCP server | ACP client | A2A server |
|--------------------|:---------:|:----------:|:----------:|
| Accepts `jsonrpc: "1.0"` on incoming request | **YES (bug)** — not validated in `handleRequest`. A request with `{jsonrpc:"1.0", method:"tools/list", id:1}` is dispatched identically to a 2.0 request. | — (we're the client, we only send) | **No** — checked at `src/protocols/a2a/server.ts:635` |
| Accepts request with missing `id` when the method expects one | **YES (bug)** — `req.id ?? null` normalizes missing to null, then we respond with id=null. Spec 2025-11-25 says id MUST NOT be null. | — | **No** — `id: string \| number` in the type, but a missing id in the body would pass through as-is in `A2AJsonRpcRequest`. `jsonRpcError` accepts id=null fallback (line 636). |
| Responds with `id: null` to a real request | **YES** — happens whenever the client sends no id. | — | **Partial** — uses `req?.id ?? null` for invalid-request envelope (matches JSON-RPC: null id allowed only for parse errors / unparseable). |
| Accepts batch with duplicate IDs | **YES (bug)** — `src/mcp/server.ts:2240`, we `Promise.all` with no ID-uniqueness check. | — | — (no batch support on A2A endpoint) |
| Silently coerces an unsupported `protocolVersion` to our version | **YES** — MCP server always returns `"2024-11-05"` regardless of request. | **No** — we pass the SDK's `PROTOCOL_VERSION`; if mismatch the SDK exposes it but we don't disconnect. | **No version read at all** (A2A-Version header ignored). |
| Accepts `permissionPolicy` values outside spec set | — | **No** — we map internal `auto-approve`/`deny` → agent-provided option `kind`s. Never mint non-spec values on the wire. | — |
| Accepts negotiation of capabilities we don't implement | — | — | **No** — Agent Card declares only capabilities we implement (`pushNotifications: false`). |
| Client-provided taskId for new tasks | — | — | **YES (spec violation)** — v0.3 says server MUST generate the taskId; we trust the client's `params.id`. (`src/protocols/a2a/server.ts:464–474`) |
| Method dispatch before `initialize` | **YES (bug)** — `tools/list` / `tools/call` work before `initialize`. | — | — |
| Unknown tool in `tools/call` | **Correct** — -32601 returned (`src/mcp/server.ts:2099–2107`). | — | — |
| Unknown method on server | **Correct** — -32601 returned. | — | **Correct** — -32601 returned. |

**Summary:** the MCP server has four distinct spec-forbidden behaviors it accepts; A2A has two (client-provided taskId, missing A2A-Version enforcement); ACP client is clean.

---

## Version negotiation

| Protocol | Pins a version? | Rejects mismatches? | Silently coerces? | File:line |
|----------|:--------------:|:-------------------:|:-----------------:|-----------|
| **MCP server** | Pins `"2024-11-05"` hard-coded | No | **Yes — silent downgrade** | `src/mcp/server.ts:2058` |
| **ACP client** | Uses SDK's `PROTOCOL_VERSION` (tracks installed SDK) | No (no explicit check of `agentCapabilities` version; relies on SDK) | Possibly (SDK internal) | `src/protocols/acp/client.ts:169` |
| **A2A server** | No version pinned; no header read | No | N/A (no negotiation surface) | `src/protocols/a2a/server.ts:626–637` |
| **A2A client** | Does not send `A2A-Version` header | N/A | N/A | `src/protocols/a2a/client.ts:56–66` |

**Finding:** MCP server silently coerces any requested protocolVersion to `2024-11-05`. A client requesting `2025-11-25` (current) gets `2024-11-05` in response with no indication. Per spec this is a MUST — the server must respond with the matched version if supported, else "another protocol version it supports." Technically we conform if we claim we only support 2024-11-05. But we never read the request's `protocolVersion`, so a client asking for an older version we can't support would get the same "2024-11-05" response — not a mismatch error. The spec sample shows the expected "Unsupported protocol version" error envelope (code -32602); we never emit it.

A2A is worse: the `A2A-Version` header is a MUST per spec 0.3 and we neither send nor read it.

---

## Recommended fixes

Prioritized by severity.

### MCP server (high priority)

1. **Validate `jsonrpc` field** in `handleRequest`. Reject non-`"2.0"` with `-32600 Invalid Request`. (`src/mcp/server.ts:2044`)
2. **Reject `id: null` for non-notification requests.** Per 2025-11-25, id MUST NOT be null. Emit `-32600` with id=null for these. (`src/mcp/server.ts:2045`)
3. **Implement protocolVersion negotiation.** Read `params.protocolVersion`, compare against a supported-list, respond with matched version or fall back to latest we support. If client version is unsupported and we have no overlap, emit `-32602 Unsupported protocol version` per the spec example. (`src/mcp/server.ts:2053–2065`)
4. **Track initialize state.** Reject `tools/list` / `tools/call` before initialize with `-32600` (or at least a clear error). (`src/mcp/server.ts:2052`)
5. **Deduplicate IDs in batch.** Return `-32600` if two requests in the same batch share an id. (`src/mcp/server.ts:2240`)
6. **Emit `-32602` for malformed params** on `tools/call` (currently we wrap Zod failure in `result.isError:true`). This is advisory — the current behavior is MCP-convention-compliant for tool errors but breaks JSON-RPC caller expectations. (`src/mcp/server.ts:2137–2151`)

### A2A server (high priority)

1. **Implement `tasks/list`** with cursor pagination, descending-by-timestamp ordering, and always-present `nextPageToken`. (new case in `src/protocols/a2a/server.ts:454–535`)
2. **Read and validate `A2A-Version` header.** Default missing to `"0.3"` per spec; reject unknown with a `VersionNotSupportedError`. Have the client send it. (`src/protocols/a2a/server.ts:626`; `src/protocols/a2a/client.ts:56`)
3. **Migrate Agent Card path to `/.well-known/agent-card.json`** while keeping `agent.json` as a legacy alias for backward compatibility. Update discovery probing to try both. (`src/protocols/a2a/server.ts:608`; `src/protocols/a2a/client.ts:87`)
4. **Add missing AgentCard fields**: `protocolVersion`, `securitySchemes` (OpenAPI-style), `preferredTransport`, `supportsAuthenticatedExtendedCard`. (`src/protocols/a2a/types.ts:11–22`; `src/protocols/a2a/generate-card.ts:141–154`)
5. **Server-generate `taskId`** for new tasks. Reject `params.id` for new tasks (only honor for continuations). Add `contextId` to messages. (`src/protocols/a2a/server.ts:464–474`)
6. **Make `tasks/cancel` idempotent.** Return the terminal Task (not -32003) if already in a terminal state. (`src/protocols/a2a/server.ts:505–530`)
7. **Add `rejected` and `auth-required` task states** to `TaskState` and `isTerminalState()`. (`src/protocols/a2a/types.ts:51–58`)
8. **Change `sendSubscribe` first frame to a `Task` object**, not a `TaskStatusUpdateEvent`. (`src/protocols/a2a/server.ts:705–712`)

### ACP client (low priority — mostly compliant)

1. **Gate `loadSession()` on `agentCapabilities.loadSession`.** Throw if the agent didn't advertise. (`src/protocols/acp/client.ts:308–316`)
2. **Validate `cwd` is absolute** before passing to `newSession()`. (`src/protocols/acp/client.ts:255–263`)
3. **Handle in-flight cancellation in `requestPermission`.** If a cancel arrives while a permission is pending, return `{ outcome: { outcome: "cancelled" } }`. The SDK may already do this — verify. (`src/protocols/acp/client.ts:425–445`)

---

## Notes and ambiguities

- **MCP batch requests.** Spec 2025-11-25 retains JSON-RPC batch mechanics but MCP features discourage it; explicit "MUST support batch" is absent. Our support is harmless.
- **MCP tool error convention.** Tool handler exceptions return `result.isError:true` rather than a JSON-RPC `-32603` error. This is spec-endorsed for tool-call errors ("tool errors should be returned as tool results, not protocol errors"), so not a conformance break.
- **A2A spec truncation.** Section 14.3 (well-known URI) and 4.4.1 (AgentCard schema) were truncated in the fetched page. Recommendations here rely on the v0.3 proto and published change notes; a definitive audit requires the full spec document.
- **Agent Card path.** A2A v0.3 migrated from `agent.json` to `agent-card.json`; many deployed peers still serve the legacy path. Dual-publish is the pragmatic answer.
- **ACP permissionPolicy.** The spec has no wire-level `permissionPolicy` enum — the client selects from agent-supplied options. Our internal `auto-approve`/`deny` mode is a convenience abstraction and does not affect wire conformance.

---

**Citations are inline as `file:line` pairs. Spec URLs at the top of this document.**
