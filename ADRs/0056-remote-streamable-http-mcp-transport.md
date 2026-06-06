---
status: accepted
date: 2026-06-04
accepted: 2026-06-05
---

# ADR-0056: Remote Streamable-HTTP MCP Transport

## Context

`am mcp-serve` is STDIO-ONLY (mcp-serve.ts entry calls `new McpServer().serve()`
which reads `Bun.stdin.stream()` at server.ts:3212; there is NO `Bun.serve`/HTTP
listener anywhere in src/mcp or src/commands/mcp-serve). This blocks three vision
goals: (1) the aggregation gateway (`am` as a server-that-is-also-a-client of N
downstream MCP servers), (2) `am`-as-provider / AWS AgentCore-as-provider, and
(3) true multi-profile-from-one-process runtime scoping (ADR-0056 is the unlock
ADR-0055 Phase 2 depends on).

Ground truth that makes this CHEAP:

- `McpServer.handleRequest(req)` (server.ts:2882) is already fully
  transport-agnostic: parsed JSON-RPC in, response object out (null for
  notifications); `handleBatch` (server.ts:2854) handles arrays. The stdio loop
  is just byte-plumbing around it.
- `am` already ships a production JSON-RPC-over-Hono-with-SSE template:
  `createA2ARoutes()` (src/protocols/a2a/server.ts:736) does bearer auth with
  constant-time `safeTokenCompare` (a2a/server.ts:787), JSON-RPC parse + -32700/
  -32600 errors (798-809), and an SSE ReadableStream with heartbeats
  (`:heartbeat`), idle timeout, and `c.req.raw.signal` abort cleanup (835-917).
- The web server already runs ONE `Bun.serve` (serve.ts:93, loopback default
  LOOPBACK_HOST='127.0.0.1', --lan opt-in) and mounts sub-apps via
  `app.route('/', a2aApp)` (web/server.ts:664).
- `am` does NOT depend on @modelcontextprotocol/sdk (none in package.json/
  node_modules); the server is hand-rolled and shell-wrapper.ts:6-20 explicitly
  rejects the SDK as house style.
- GAP: the global auth middleware (web/server.ts:153-183) only enforces on
  `/api/*`; a `/mcp` sub-app would be UNAUTHENTICATED unless it brings its own
  middleware. `am` validates NO Origin header anywhere today.

## Decision

**Add a hand-rolled Streamable-HTTP MCP endpoint as a Hono sub-app mounted on
the EXISTING `Bun.serve` listener. Do NOT adopt @modelcontextprotocol/sdk.**

### Decision 1 — Mount, don't fork a listener

Create `createMcpHttpRoutes()` modeled on `createA2ARoutes` (a2a/server.ts:736)
and mount it `app.route('/mcp', mcpApp)` next to the A2A mount (web/server.ts:664),
behind an opt-in flag (settings.mcp_serve.http or a serve.ts `--mcp` flag, like
`--bridge`). One process, one port, loopback by default. Rationale over a second
standalone listener: reuses serve.ts's loopback bind, token bootstrap, and
shutdown; avoids a second port/auth surface.

### Decision 2 — Phase 1: stateless JSON mode (CHEAP, unblocks gateway + AgentCore)

POST-only, `enableJsonResponse`-style. Parse body, call the EXISTING
`handleRequest`/`handleBatch`, then: notification/response (no id) -> 202 Accepted
empty body; request -> Content-Type: application/json with the single result.
No session map, no SSE, no event store. This alone unblocks the aggregation
gateway and AgentCore-as-provider.

### Decision 3 — Three security controls (one genuinely new)

(a) Origin-header validation middleware (NEW — the single most important control;
`am` has none today). Reject cross-origin browsers to stop DNS-rebinding against
the localhost endpoint; protection ON by default, --lan/--host widens the
allowlist (mirror serve.ts host model). (b) Reuse the loopback-default bind from
serve.ts. (c) The /mcp sub-app MUST carry its OWN bearer middleware (copy
a2a/server.ts:787 safeTokenCompare; reuse AM_MCP_TOKEN) because the global
/api/* middleware does not cover /mcp.

### Decision 4 — Phase 2: sessions + SSE (HARD, additive, deferred)

Introduce `Mcp-Session-Id` (randomUUID) assigned on the InitializeResult
response header, a `transports[sessionId]` map, and the spec-correct status
split: MISSING header on a non-init request -> 400 {-32000 'Session ID
required'}; PRESENT-but-unknown/expired -> 404 {-32001 'Session not found'} (the
SDK's own reviewers flag conflating these). Add GET-SSE + Last-Event-ID
resumability and POST-SSE progress streaming by copying the A2A SSE machinery
(heartbeats, idle timeout, abort cleanup). Add a SIGINT handler that closes
Bun.serve and drains the transports map (serve.ts has no shutdown today).

### Decision 5 — Per-session statefulness isolation

`McpServer` holds per-session state (`this.initialized` server.ts:2782,
`this.settings`, `this.progressSink`). Under stateful HTTP, use ONE McpServer
instance PER session (the universal SDK convention) or refactor session state
out of the instance — a shared instance cross-contaminates init state and (per
ADR-0055 Phase 2) per-session Scope.

### Decision 6 — Protocol-version header

`handleRequest` only sees the JSON-RPC body, never HTTP headers, so the
`MCP-Protocol-Version` header (and Mcp-Session-Id, Last-Event-ID, Origin) is
handled in the Hono layer AROUND handleRequest. Add 2025-03-26/2025-06-18 to
SUPPORTED_MCP_PROTOCOL_VERSIONS (today ['2025-11-25','2024-11-05'], preferred
'2024-11-05'), or document that the HTTP transport speaks streamable-HTTP
regardless of the negotiated logical version.

## Consequences

### Positive
- Unblocks the aggregation gateway, AgentCore-as-provider, and ADR-0055 Phase 2
  per-session runtime Scope.
- Phase 1 reuses handleRequest verbatim -> the tool-count test contract is
  untouched; new tests drive `app.fetch(new Request(...))` like the A2A/web
  tests and assert 202-on-notification, json-on-request, 400-missing-session,
  404-unknown-session, 403-bad-Origin, 401-bad-bearer.

### Negative
- Adds an HTTP attack surface; the Origin control is mandatory and easy to
  forget because loopback FEELS safe (a same-machine browser can still hit it).
- Phase 2 sessions + SSE + resumability + shutdown is real work; keep it
  additive and deferred behind the flag.

### Neutral
- stdio `mcp-serve` remains the default and unchanged; HTTP is opt-in.

## Alternatives Considered
- **Adopt @modelcontextprotocol/sdk StreamableHTTPServerTransport.** Rejected:
  adds a dependency tree (the v2 SDK split into @modelcontextprotocol/server|
  node|express with renamed classes) and would require rewriting tool
  registration; porting the ~80-line shim onto the existing handleRequest is
  strictly cheaper and keeps the test contract.
- **A second standalone Bun.serve listener for MCP.** Rejected: duplicates
  bind/auth/shutdown; one listener with sub-app routing (the proven A2A mount)
  is simpler.
- **Sub-path-per-profile routing (/mcp/<profile>, mcp-proxy style) as the scope
  channel now.** Deferred to ADR-0055 Phase 2: valid and robust, but it depends
  on this transport existing first; do not bundle.
- **Build the full SSE/session/resumability layer in Phase 1.** Rejected:
  inverts dependency order and stalls the cheap stateless win that already
  unblocks the gateway and AgentCore.

## References
- Enables ADR-0055 Phase 2 (per-session runtime Scope).
- src/mcp/server.ts:61(versions),2782,2854,2882,3003,3212 ; src/protocols/a2a/
  server.ts:736,787,798-809,835-917 ; src/web/server.ts:153-183,664 ;
  src/commands/serve.ts:19,93 ; src/commands/mcp-serve.ts ; package.json (no
  @modelcontextprotocol/sdk).
- MCP spec 2025-06-18 basic/transports (Streamable HTTP: single endpoint,
  POST/GET/DELETE, 202/400/404/405, Mcp-Session-Id, Last-Event-ID, Origin +
  loopback + auth security warning).
