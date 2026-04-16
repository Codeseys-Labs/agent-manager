# A2A Protocol Implementation Review

**Date:** 2026-04-14
**Reviewer:** Claude Opus 4.6 (agent-managed review)
**Scope:** `src/protocols/a2a/`, `src/commands/agents.ts`, A2A MCP tools in `src/mcp/server.ts`, `test/protocols/a2a/`, ADR-0017

---

## Executive Summary

The A2A implementation is a solid Phase 1/3 hybrid: it delivers AgentCard generation, a working JSON-RPC server, client-side discovery and delegation, a TOML-based roster, CLI commands, and MCP tool exposure. The code is clean, well-structured, and consistent with agent-manager's patterns. However, several gaps exist around error handling, the delegation UX, missing A2A spec compliance, and test coverage for async/streaming scenarios. The biggest structural concern is the synchronous-only task handler — tasks complete or fail in a single request/response, which limits real-world delegation to trivially fast operations.

---

## 1. Agent Discovery Flow

**Verdict:** Good foundation, but discovery is purely manual.

### Strengths

- `discoverFromUrl()` correctly fetches `/.well-known/agent.json` per A2A v0.3.0 spec (`client.ts:83-109`).
- 404 returns `null` rather than throwing — clean for "check if agent exists" use cases.
- Trailing slash normalization (`client.ts:66-68`) prevents double-slash URL bugs.
- Authentication headers (bearer token, API key) are included in discovery requests (`client.ts:53-63`).
- `discoverFromRoster()` fetches cards in parallel with a concurrency limit of 5 (`discovery.ts:148-161`) — good backpressure.

### Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1.1 | **MEDIUM** | **No auto-discovery from `settings.a2a.discovery_sources`**. ADR-0017 Phase 1b specifies a `[settings.a2a.discovery_sources]` config, but nothing reads it. The roster is the only discovery mechanism. Agents cannot find each other unless manually added via `am agents add`. | `discovery.ts` — no `discoverFromConfig()` function |
| 1.2 | **LOW** | **No Agent Card validation on fetch.** `discoverAgent()` casts the JSON response directly to `AgentCard` (`client.ts:108`) without validating required fields (`name`, `url`, `capabilities`, `skills`). A malformed card will propagate silently until something downstream fails. | `client.ts:108` |
| 1.3 | **LOW** | **Discovery timeout inconsistency.** `discoverFromUrl()` uses 15s (`discovery.ts:28`), `discoverFromRoster()` uses 10s (`discovery.ts:142`), client default is 30s (`client.ts:85`), and `am agents add` inherits 30s. The different timeouts for the same operation are confusing. | Multiple files |
| 1.4 | **LOW** | **No cache for discovered Agent Cards.** Every `am agents ping` or `am agents delegate` rediscovers the card. The roster stores the card at add-time (`agents.ts:87`) but never refreshes it, and the stored card is not used for delegation — the client always resolves the endpoint from the URL. | `agents.ts:86-87`, `discovery.ts:63-69` |

### Suggestions

- Implement a `discoverFromConfig()` that reads `settings.a2a.discovery_sources[]` and merges discovered agents into the roster. Wire it into `am agents list --discover` or a background refresh.
- Add lightweight validation (check `name` and `skills` exist) in `discoverAgent()` before returning. Use Zod or a manual check.
- Unify discovery timeouts to a single configurable value.

---

## 2. `am agents delegate` UX

**Verdict:** Functional but limited. Synchronous-only execution makes it unsuitable for real agent delegation.

### Strengths

- Simple, intuitive syntax: `am agents delegate <name> <task>` — ergonomic for quick operations.
- Generates unique task IDs with timestamp + random suffix (`agents.ts:232`).
- 60s timeout for delegation (vs 30s default) shows awareness that tasks take longer.
- JSON output mode (`--json`) enables scripting/piping.
- Error messages include available agent names when lookup fails (`mcp/server.ts:997-998`).

### Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 2.1 | **HIGH** | **No async/polling support.** `sendTask()` blocks until the task completes or the 60s timeout fires. There is no `--async` flag to fire-and-forget, no `--poll` to check status later. For tasks that take >60s (which most real agent tasks do), delegation simply times out. The `am_agent_task_status` MCP tool exists for polling but there is no CLI equivalent (`am agents status <taskId>`). | `agents.ts:234-276`, `client.ts:172-180` |
| 2.2 | **HIGH** | **Task text is a single positional arg.** Shell quoting makes multi-word tasks painful: `am agents delegate my-agent "review the PR and check for security issues in the auth module"`. If the user forgets quotes, citty parses only the first word. There is no `--file` or `--stdin` option for longer prompts. | `agents.ts:208` |
| 2.3 | **MEDIUM** | **No task cancellation from CLI.** `cancelTask()` exists in the client and server, but there is no `am agents cancel <taskId>` subcommand. If a delegation hangs, the user's only option is Ctrl-C. | `agents.ts` — no cancel subcommand |
| 2.4 | **MEDIUM** | **No progress indication.** During the 60s wait, the user sees only "Delegating to <name> (<url>)..." with no spinner, no status updates, no indication of whether the remote agent is working. | `agents.ts:229` |
| 2.5 | **LOW** | **FilePart and DataPart responses are not rendered.** The delegate response handler only renders TextPart and DataPart (`agents.ts:253-259`). FilePart responses (file attachments from agents) are silently ignored. | `agents.ts:253-259` |

### Suggestions

- Add `--async` flag that sends the task, prints the task ID, and exits. Add `am agents status <name> <taskId>` subcommand (mirrors the MCP tool).
- Accept task text from `--file <path>` or `--stdin` (read from pipe). Consider making `task` a rest arg so `am agents delegate my-agent review the PR` works without quotes.
- Add `am agents cancel <name> <taskId>` subcommand.
- Add a spinner or periodic "still working..." output during synchronous delegation.

---

## 3. Roster Management

**Verdict:** Clean TOML format, intuitive CRUD, but lacks important metadata.

### Strengths

- TOML is the right format — consistent with the rest of agent-manager's config philosophy.
- Deduplication by name on add (`discovery.ts:105`) prevents duplicate entries.
- `removeFromRoster` returns a boolean for "not found" rather than throwing — ergonomic.
- Roster operations are atomic (read all, modify, write all) — no partial-write corruption risk.

### Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 3.1 | **MEDIUM** | **No health status in roster.** The roster stores `lastSeen` but nothing ever updates it after the initial add. `am agents ping` fetches the card but does not update `lastSeen` in the roster file. Stale agents accumulate silently. | `agents.ts:160-200` — ping does not write back |
| 3.2 | **MEDIUM** | **Roster name collisions with Agent Card names.** `am agents add` uses the Agent Card's `name` field as the roster key (`agents.ts:83`). If two different agents at different URLs have the same `name` in their Agent Card, the second silently overwrites the first. There is no `--name` override. | `agents.ts:82-83` |
| 3.3 | **LOW** | **No `am agents update` subcommand.** To refresh an agent's URL or description, the user must `am agents remove` then `am agents add`. An `am agents update <name> --url <new-url>` would be more ergonomic. | `agents.ts` — no update subcommand |
| 3.4 | **LOW** | **Stored Agent Card in roster is never used.** `AgentRosterEntry.card` is populated on add (`agents.ts:87`) but `loadRoster()` does not deserialize it back — the `RosterToml` interface does not include a `card` field (`discovery.ts:34-44`). The card is written to TOML but lost on reload. | `discovery.ts:34-44` vs `types.ts:159-166` |

### Suggestions

- Update `lastSeen` in the roster after successful ping.
- Add `--name <alias>` to `am agents add` so users can override the Agent Card name.
- Include `card` in `RosterToml` interface so cached cards survive roster reload.

---

## 4. Agent Card Generation

**Verdict:** Well-designed mapping from am config to A2A AgentCard. The skill hierarchy is the standout feature.

### Strengths

- Three-tier skill exposure: built-in skills (6), whole-agent skills (agents with `adapters.a2a`), and per-skill entries (agents with `adapters.a2a.skills.*`). This is well-thought-out (`generate-card.ts:84-118`).
- Built-in skills map cleanly to am operations (`config.read`, `config.write`, `registry.search`, `registry.install`, `adapter.apply`, `adapter.status`).
- Provider metadata is optional and clean — `organization` gates `provider` inclusion (`generate-card.ts:133-138`).
- Version sourced from `BUILD_VERSION` env with `0.1.0` fallback (`generate-card.ts:145`).

### Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 4.1 | **MEDIUM** | **Built-in skill `config.write` and `registry.install` are advertised but not handled.** The server's `defaultTaskHandler` (`server.ts:108-226`) only handles `status`, `config`, `servers`, `agents`, and `apply`. Sending "config.write" or "registry.install" to the A2A endpoint returns "Unrecognized command." The AgentCard promises capabilities the server cannot deliver. | `generate-card.ts:37-60` vs `server.ts:108-226` |
| 4.2 | **LOW** | **No AgentCard export CLI command.** ADR-0017 Phase 2a specifies `am a2a export` to export AgentCards as JSON. This does not exist yet. The card is only available via the HTTP endpoint `/.well-known/agent.json`. | ADR-0017 vs implemented commands |
| 4.3 | **LOW** | **`streaming: false` is hardcoded.** The capability is always false (`generate-card.ts:128`) regardless of agent config. If agents declare `streaming = true` in their `adapters.a2a`, it is not reflected in the composite card. | `generate-card.ts:127-130` |
| 4.4 | **LOW** | **No `securitySchemes` field.** A2A v0.3.0 allows richer security scheme definitions beyond the basic `type` field. The current `authentication` array always contains a single `"bearer"` entry (`generate-card.ts:150`) regardless of actual auth configuration. | `generate-card.ts:150` |

### Suggestions

- Either implement handlers for `config.write` and `registry.install` in `defaultTaskHandler`, or remove them from `BUILTIN_SKILLS`. Advertising unhandled capabilities violates the principle of least surprise.
- Add `am agents card` or `am agents export` to dump the generated AgentCard as JSON.
- Aggregate `streaming` capability from agent configs rather than hardcoding false.

---

## 5. A2A Server Robustness

**Verdict:** Solid JSON-RPC compliance for the happy path. The eviction strategy and error handling need attention.

### Strengths

- Correct JSON-RPC 2.0 error codes: -32700 (parse error), -32600 (invalid request), -32602 (invalid params), -32601 (method not found), and application-level -32001 (task not found) and -32003 (cannot cancel).
- Task state machine is simple and correct: submitted -> working -> completed/failed/canceled.
- History tracking: both user and agent messages are recorded in `task.history`.
- `historyLength` parameter for `tasks/get` allows clients to limit history retrieval (`server.ts:299-301`).
- Eviction triggers after every `tasks/send`, cleaning completed/failed/canceled tasks first (`server.ts:35-58`).

### Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 5.1 | **HIGH** | **Module-level singleton task store.** `taskStore` is a module-global `Map` (`server.ts:33`). If `createA2ARoutes()` is called multiple times (e.g., test isolation, hot reload), all instances share the same store. The `clearTaskStore()` export mitigates this for tests, but in production this could cause cross-request state bleed. The store should be per-server-instance. | `server.ts:33` |
| 5.2 | **MEDIUM** | **Eviction races under concurrent load.** `evictStaleTasks()` iterates and deletes from the Map while other requests may be reading it. JavaScript is single-threaded for CPU-bound work, but `handleJsonRpc` is async — if two `tasks/send` calls are in-flight, one could trigger eviction while the other is mid-handler. The 80% watermark (`server.ts:39`) helps but does not eliminate the race. | `server.ts:35-58` |
| 5.3 | **MEDIUM** | **No TTL-based eviction.** Eviction only triggers when the store exceeds 1000 tasks. A task that completed 3 days ago but was never evicted (because the store stayed under 1000) persists forever in memory. There is no timestamp-based cleanup. | `server.ts:35-58` |
| 5.4 | **MEDIUM** | **`tasks/send` always completes synchronously.** The handler awaits the entire task execution inline (`server.ts:271-281`). Per A2A v0.3.0, `tasks/send` should be able to return a task in `working` state and let the client poll with `tasks/get`. The current implementation forces synchronous completion, making it impossible to handle long-running tasks. | `server.ts:259-284` |
| 5.5 | **LOW** | **No JSON-RPC batch support.** A2A v0.3.0 inherits from JSON-RPC 2.0 which supports batch requests (array of requests). The server only handles single request objects. | `server.ts:365-379` |
| 5.6 | **LOW** | **`tasks/cancel` cannot cancel in-flight tasks.** Since `tasks/send` blocks until completion, a task is either "submitted" (never reachable from outside), "working" (blocked in the handler), or terminal. Cancel only works on tasks in non-terminal states, but there is no way to reach a task while it is working because the send handler holds the response. | `server.ts:307-328` |

### Suggestions

- Make `taskStore` a property of the server instance (pass it through `A2AServerOptions` or create it inside `createA2ARoutes`). Export the store via a getter if tests need access.
- Add TTL-based cleanup: any task older than N minutes (configurable) is eligible for eviction regardless of state.
- For async task support: `tasks/send` should return immediately with `state: "working"`, then the handler runs in the background and updates the task store. Clients poll with `tasks/get`. This is the A2A-idiomatic pattern.

---

## 6. Missing Capabilities

| # | Severity | Capability | Notes |
|---|----------|-----------|-------|
| 6.1 | **HIGH** | **Streaming (SSE)** | A2A v0.3.0 defines `tasks/sendSubscribe` for server-sent events. The capability is advertised as `false` in the AgentCard, but there is no path to enabling it. For long-running tasks, streaming is essential. |
| 6.2 | **HIGH** | **Async task execution** | As detailed in 5.4 — the server cannot handle tasks that take more than the HTTP timeout. This fundamentally limits the A2A server to trivial operations. |
| 6.3 | **MEDIUM** | **Authentication middleware** | The server has no auth. `buildAuthHeaders()` in the client sends credentials, but the server's Hono routes (`server.ts:354-383`) accept any request. For a multi-agent network, bearer token validation is essential. |
| 6.4 | **MEDIUM** | **Session state / multi-turn conversations** | A2A supports multi-turn via `tasks/send` with the same task ID. The server supports this mechanically (same ID reuses the task), but the `defaultTaskHandler` is stateless — it processes each message independently with no memory of prior turns. |
| 6.5 | **MEDIUM** | **Push notifications** | A2A defines `tasks/pushNotification/set` and `tasks/pushNotification/get`. Neither is implemented. Capability is advertised as `false`. |
| 6.6 | **LOW** | **`tasks/sendSubscribe`** | The streaming variant of `tasks/send`. Not implemented, not planned in current code. |
| 6.7 | **LOW** | **Agent Card versioning** | No `If-None-Match`/ETag support on `/.well-known/agent.json`. Clients must always fetch the full card. |

---

## 7. Test Coverage

**Verdict:** Good unit coverage for the happy path. Missing tests for edge cases and integration scenarios.

### What's Covered

| Module | Tests | Coverage Assessment |
|--------|-------|-------------------|
| `client.ts` | 12 tests | Good: discovery (success, 404, 500, network failure, auth headers), sendTask, getTask, cancelTask, error class |
| `server.ts` | 13 tests | Good: Agent Card endpoint, tasks/send, tasks/get, tasks/cancel, eviction, malformed JSON-RPC (4 variants) |
| `generate-card.ts` | 14 tests | Excellent: basic structure, capabilities, auth, I/O modes, built-in skills, agent-derived skills (with/without a2a, sub-skills, multiple), provider metadata, URL, version, total count |
| `discovery.ts` | 8 tests | Good for roster CRUD: loadRoster (empty), save+load roundtrip, addToRoster (dedup, multiple), removeFromRoster (success, not-found). Also tests `resolveProjectName` (unrelated). |
| `agents.test.ts` | 8 tests | Adequate: exercises roster CRUD via the discovery module. Does NOT test the actual CLI subcommands (list, add, remove, ping, delegate) end-to-end. |
| `mcp/server.test.ts` | 3 assertions | Minimal: only checks that A2A tools appear in the tool list with correct group configuration. No functional tests for the 4 A2A MCP tools. |

### Missing Test Scenarios

| # | Severity | Missing Test | Relevant Code |
|---|----------|-------------|---------------|
| 7.1 | **HIGH** | **No functional test for MCP tools `am_agent_delegate` or `am_agent_task_status`.** These are the most complex tools (network calls, roster lookup, task creation) and have zero test coverage. | `mcp/server.ts:972-1047` |
| 7.2 | **HIGH** | **No test for `tasks/send` with a failing handler.** The server catches handler errors and transitions to `failed` state (`server.ts:275-281`), but no test verifies this path. | `server.ts:275-281` |
| 7.3 | **MEDIUM** | **No test for `tasks/cancel` on a cancelable task.** The cancel test (`server.test.ts:243-306`) only tests the "cannot cancel completed task" path. There is no test for successfully canceling a task in `submitted` or `working` state (which is impossible with the current synchronous handler, but should be tested if async is added). | `server.test.ts:243-306` |
| 7.4 | **MEDIUM** | **No test for `discoverFromRoster()`.** This function fetches Agent Cards in parallel with backpressure — it is untested. | `discovery.ts:132-162` |
| 7.5 | **MEDIUM** | **No test for `historyLength` trimming.** The server supports `historyLength` in `tasks/get` but no test exercises it. | `server.ts:299-301` |
| 7.6 | **MEDIUM** | **CLI subcommands are not tested end-to-end.** `agents.test.ts` only tests the discovery module functions. The actual citty subcommands (`listSubcommand`, `addSubcommand`, `pingSubcommand`, `delegateSubcommand`) are never invoked in tests. | `agents.ts` |
| 7.7 | **LOW** | **No test for `buildAuthHeaders()` with both bearer and API key.** When both are set, bearer takes precedence — this behavior is untested. | `client.ts:53-63` |
| 7.8 | **LOW** | **No test for concurrent eviction.** Creating 1005 tasks sequentially does not test race conditions. | `server.test.ts:362-387` |

---

## 8. Comparison with ACPX's Agent Registry

ACPX (`@openclaw/acpx`) provides a very different model for agent discovery and delegation. Comparing the two reveals gaps and design opportunities.

| Dimension | am A2A | ACPX |
|-----------|--------|------|
| **Discovery** | Manual `am agents add <url>` fetches Agent Card from `/.well-known/agent.json` | 16 built-in agents with hardcoded spawn commands; `--agent <name>` escape hatch for any custom command |
| **Registry format** | TOML roster file (`agents.toml`) with URL + metadata | Hardcoded TypeScript map + config override in `.acpxrc.json` |
| **Delegation model** | A2A JSON-RPC over HTTP (`tasks/send`) | ACP stdio JSON-RPC (`session/prompt`) — agents are local subprocesses |
| **Session state** | Stateless per-message (same task ID reuses task object) | Full session persistence, crash recovery, named sessions |
| **Config override** | Agent profiles in `config.toml` with `adapters.a2a` metadata | `.acpxrc.json` overrides built-in registry |
| **Multi-agent** | Roster-based, any URL | Name-based, assumes local spawn |
| **Auth** | Bearer token / API key in client | None (local subprocess trust model) |
| **Streaming** | Not implemented | NDJSON streaming from agent subprocess |

### Key Takeaways

| # | Severity | Observation |
|---|----------|-------------|
| 8.1 | **MEDIUM** | **ACPX's built-in registry is an ergonomic win am should learn from.** When a user types `acpx claude "do something"`, it just works because ACPX knows how to spawn Claude. In am, `am agents delegate claude "do something"` fails unless the user has previously run `am agents add https://...` — a URL they probably don't know. Consider a well-known agents registry (built-in or fetched from a URL) for common agents. |
| 8.2 | **MEDIUM** | **ACPX's `--agent` escape hatch is missing in am.** ACPX allows `--agent "any-command --flag"` to delegate to an arbitrary agent command without registering it. am requires roster registration for every agent. Consider `am agents delegate --url <url> <task>` for one-off delegation without roster. |
| 8.3 | **LOW** | **ACPX's session persistence model highlights am's gap.** am's A2A server loses all task state on restart (in-memory Map). For a coordinator that manages multi-turn conversations, persistence is eventually essential. ADR-0026 (ACP integration) proposes this for ACP sessions; A2A tasks should get the same treatment. |

---

## Summary of Findings by Severity

### CRITICAL (0)

None.

### HIGH (5)

| # | Finding |
|---|---------|
| 2.1 | No async/polling support — delegation times out for real tasks |
| 2.2 | Single positional arg for task text — shell quoting pain |
| 5.1 | Module-level singleton task store — shared state across instances |
| 6.1 | No streaming (SSE) support |
| 6.2 | Synchronous-only task execution |
| 7.1 | No functional tests for A2A MCP tools |
| 7.2 | No test for handler failure path |

### MEDIUM (13)

| # | Finding |
|---|---------|
| 1.1 | No auto-discovery from `settings.a2a.discovery_sources` |
| 2.3 | No `am agents cancel` subcommand |
| 2.4 | No progress indication during delegation |
| 3.1 | `lastSeen` never updated after initial add |
| 3.2 | Name collisions between Agent Card names |
| 3.4 | Stored Agent Card lost on roster reload |
| 4.1 | Built-in skills advertised but not handled |
| 5.2 | Eviction races under concurrent load |
| 5.3 | No TTL-based eviction |
| 5.4 | `tasks/send` always completes synchronously |
| 6.3 | No authentication middleware on server |
| 6.4 | No session state for multi-turn |
| 6.5 | No push notifications |
| 7.3-7.6 | Various missing test scenarios |
| 8.1 | No built-in agent registry |
| 8.2 | No `--url` escape hatch for one-off delegation |

### LOW (12)

Various minor issues documented in sections above.

---

## Recommended Priority Order

1. **Fix the singleton task store** (5.1) — Correctness issue, break production state isolation.
2. **Add async delegation** (2.1, 5.4, 6.2) — The single biggest usability gap. Without it, the A2A server and `am agents delegate` are limited to sub-60s operations.
3. **Align advertised skills with handled commands** (4.1) — Either implement handlers or remove skills from the card. This is a protocol contract violation.
4. **Add functional tests for MCP tools and failure paths** (7.1, 7.2) — These are the highest-risk untested code paths.
5. **Improve task text input** (2.2) — `--file`, `--stdin`, or rest arg parsing.
6. **Add `am agents cancel` and `am agents status` subcommands** (2.3) — Complete the CLI surface.
7. **Fix roster `lastSeen` and card caching** (3.1, 3.4) — Data correctness.
8. **Add server auth middleware** (6.3) — Required before any non-localhost deployment.
9. **Streaming/SSE** (6.1) — Phase 2 concern, but essential for real-world use.
10. **Built-in agent registry** (8.1) — Ergonomic improvement for v1.0.
