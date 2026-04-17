# MCP Server Deep Review

**Scope:** `/Users/baladita/Documents/DevBox/agent-manager/src/mcp/server.ts` (1911 LOC, single file) plus `/Users/baladita/Documents/DevBox/agent-manager/test/mcp/server.test.ts` (1580 LOC).
**Facet:** MCP protocol compliance, tool design, input validation, error handling, security.
**Date:** 2026-04-16.

---

## Summary

The MCP server is a hand-rolled JSON-RPC 2.0 / MCP 2024-11-05 implementation over stdio, with **33 tools across 6 groups** and a 3-tier permission model (`read-only` / `write-local` / `write-remote`). Protocol framing (`initialize`, `tools/list`, `tools/call`, notifications) is correct and the error envelope (`isError: true` + `content[]`) is consistent on handler failures.

**Strengths:**
- Clean tool-group gating (ADR-0021) with selective enablement, tested.
- `write-remote` opt-in flow (`mcp_serve.allow_push`) is correct and tested.
- Settings are re-read on every `tools/call` so permission changes are not stale.
- Error envelope is structured (`{error, hint}`) with period-split hint extraction.
- Secret redaction on `am_config_show` (`enc:v1:` prefix → `[encrypted]`).
- Batch JSON-RPC arrays are handled.

**Weaknesses:**
- **No input validation layer.** Schemas are declarative-only; handlers just cast (`as string`, `as string[]`) without runtime checks. Wrong types will either produce confusing error messages or silently succeed with bad data.
- **No path-traversal protection** on `cwd`, `session_id`, `sessionId`, `adapter`, `source`. `am_acp_session_cancel` uses `rm({recursive: true})` after a naive `join(sessionDir, sessionId)` — a crafted `sessionId` like `../../../etc` would resolve outside the session dir.
- **Command injection via `am_run_agent`.** `agentName` is resolved to an `entry.acp.command` string that is then passed to `parseCommand()` (space-split) and `Bun.spawn`. A config-sourced agent whose command contains `;` or `$(...)` won't be shell-interpreted (good, no shell) but a malicious agent *name* cannot inject — the real attack surface is `cwd`, which is forwarded verbatim.
- **Secret leakage risk** in `am_apply` error path: when export fails, `errorMessage(e)` is passed through. If an adapter's error embeds the value of an env var (e.g., `"failed to write token=sk-abc..."`), it is surfaced to MCP clients. No scrub layer.
- **No rate limiting or concurrency protection.** `am_run_agent` spawns subprocesses; a client that calls it in a loop can fork-bomb. `am_session_search` fan-outs across all adapters and loads every session — an O(N * M) scan with no cap.
- **Test coverage gaps:** `am_apply` non-dryRun, `am_sync_push`, `am_sync_pull`, `am_import` merge behavior, `am_registry_*`, all 4 A2A tools, all 5 wiki tools, and `am_run_agent` success path are not exercised by unit tests. ACP tool tests are mostly tier/schema checks rather than handler integration.

**Overall health: 6.5/10.** The protocol plumbing is solid and the permission model is well-designed, but handler-level input validation and process-spawning hygiene haven't caught up with the recent feature expansion (ACP, registry, wiki). Not blocker-level for v1 internal use; would block external exposure.

---

## Tool Inventory

Legend: *Input Validation* — "schema only" = JSON schema declared but no runtime check; "none" = no required fields declared. *Error Handling* — "envelope" = returns `isError: true` content (good); "uncaught" = relies on outer `try/catch` in `handleRequest`. *Tests* — unit tests in `test/mcp/server.test.ts`.

| # | Tool | Group | Tier | Required Fields | Input Validation | Error Handling | Has Tests |
|---|------|-------|------|------|------|------|------|
| 1 | `am_list_servers` | core | read-only | none | schema only | envelope | yes (2) |
| 2 | `am_list_profiles` | core | read-only | none | schema only | envelope | yes (1) |
| 3 | `am_status` | core | read-only | none | schema only | envelope (per-adapter try/catch) | yes (1) |
| 4 | `am_config_show` | core | read-only | none | schema only | envelope | yes (1) |
| 5 | `am_doctor` | core | read-only | none | schema only | envelope (per-check) | yes (2) |
| 6 | `am_session_list` | session | read-only | none | schema only | envelope (silent skip on adapter fail) | yes (3) |
| 7 | `am_session_export` | session | read-only | `id`, `adapter` | schema only + throws | envelope | yes (3) |
| 8 | `am_session_search` | session | read-only | `query` | schema only | envelope | yes (3) |
| 9 | `am_add_server` | core | write-local | `name`, `command` | schema only | envelope | yes (2) |
| 10 | `am_remove_server` | core | write-local | `name` | schema only | envelope | yes (2) |
| 11 | `am_server_update` | core | write-local | `name` | schema only | envelope | yes (4) |
| 12 | `am_undo` | core | write-local | none | schema only | envelope | yes (2) |
| 13 | `am_use_profile` | core | write-local | `profile` | schema only | envelope | yes (2) |
| 14 | `am_import` | core | write-local | `source` | schema only | envelope (silent skip on adapter fail) | yes (3) |
| 15 | `am_apply` | core | write-local | none | schema only | envelope (per-adapter try/catch) | yes (1, dryRun only) |
| 16 | `am_sync_push` | core | write-remote | none | schema only | envelope | permission only |
| 17 | `am_sync_pull` | core | write-remote | none | schema only | envelope | no |
| 18 | `am_registry_search` | registry | read-only | `query` | schema only | envelope | no |
| 19 | `am_registry_install` | registry | write-local | `name` | schema only | envelope | no |
| 20 | `am_registry_list_installed` | registry | read-only | none | schema only | envelope | no |
| 21 | `am_agent_discover` | a2a | read-only | `url` | schema only | envelope | no |
| 22 | `am_agent_list` | a2a | read-only | none | schema only | envelope | no |
| 23 | `am_agent_delegate` | a2a | write-remote | `name`, `message` | schema only | envelope | no |
| 24 | `am_agent_task_status` | a2a | read-only | `name`, `taskId` | schema only | envelope | no |
| 25 | `am_wiki_search` | wiki | read-only | `query` | schema only | envelope | no |
| 26 | `am_wiki_add` | wiki | write-local | `entity_type`, `content` | schema (enum) only | envelope | no |
| 27 | `am_wiki_synthesize` | wiki | read-only | `query` | schema only | envelope | no |
| 28 | `am_wiki_briefing` | wiki | read-only | `agent_id` | schema only | envelope | no |
| 29 | `am_wiki_harvest` | wiki | write-local | `adapter`, `session_id` | schema only | envelope | no |
| 30 | `am_run_agent` | acp | write-remote | `agent`, `prompt` | schema only | envelope | permission only |
| 31 | `am_acp_list_agents` | acp | read-only | none | schema only | envelope | yes (1) |
| 32 | `am_acp_session_list` | acp | read-only | none | schema only | envelope | yes (1) |
| 33 | `am_acp_session_cancel` | acp | write-remote | `sessionId` | schema only | envelope | yes (2, nonexistent + permission) |

**Coverage counts:**
- Fully tested (handler exercised, at least one error path): 11 / 33 (33%).
- Schema/tier only (no handler exercise): 10 / 33 (30%).
- Zero tests: 12 / 33 (36%): all `am_registry_*`, all `am_agent_*`, all `am_wiki_*`, `am_sync_pull`.

---

## Protocol Compliance Findings

### COMPLIANT
1. **Protocol version handshake.** `initialize` returns `"protocolVersion": "2024-11-05"` with `capabilities.tools` — matches spec.
2. **Error codes.** Parse errors use `-32700`; unknown method/tool use `-32601`. These match JSON-RPC 2.0.
3. **Notification handling.** `notifications/initialized` returns `null` (no response). `handleRequest` returns `null` for any notification (no `id`) and the server skips writing it to stdout. Correct.
4. **Error envelope semantics.** Handler failures are returned as `result: { content: [{type: "text", text: "..."}], isError: true }` rather than a JSON-RPC `error` object. This is the MCP-recommended pattern: protocol-level errors (malformed JSON, unknown method/tool) use `-32xxx` codes; tool-execution failures use `isError: true`. The server gets this right.
5. **Batch requests.** Arrays of requests are processed via `Promise.all` and responses are collected into an array — JSON-RPC 2.0 batch spec.
6. **NDJSON framing on stdio.** Uses `\n`-delimited JSON with partial-chunk buffering — correct for MCP stdio transport.

### MINOR DEVIATIONS

1. **`tools/list` is not paginated.** MCP spec supports `cursor` / `nextCursor` for tool listings. With 33 tools this is fine, but the server ignores any `cursor` param silently rather than echoing it back or rejecting.
2. **No `tools/list` change notification.** When `am_add_server` / `am_remove_server` modify the catalog, the tool *list* does not change (tool definitions are static), but if `mcp_serve.tools` is changed in config mid-session, the server silently starts returning different tools on the next `tools/list` call without sending a `notifications/tools/list_changed` message. Low impact (no reasonable client will reconfigure mid-session) but worth noting.
3. **`JsonRpcRequest.params` typed as `Record<string, unknown>`.** JSON-RPC allows `params` to be an array. The server never handles positional params. In practice MCP clients always use named params, so this is fine.
4. **`handleRequest` for `notifications/*` with an `id`.** If a client erroneously sends `notifications/initialized` *with* an id, the server still returns `null` and the client will block waiting for a response. Spec-compliant clients don't do this, but a defensive implementation would log and return an error. Low-severity.
5. **Parse error response has `id: null`.** Correct per JSON-RPC 2.0 ("If there was an error in detecting the id… the value of id MUST be Null.").
6. **Stderr is silent.** No log channel to stderr for MCP debugging. Operators have no way to see *why* a request failed beyond the client-facing message.

### VIOLATION (single)
- **None at the protocol level.** (See input validation and security sections for behavioral issues that are not spec violations.)

---

## Input Validation Gaps

All severity tags are assigned on the assumption that the MCP server may be exposed to a semi-trusted client (IDE, shared with teammates, etc.), not an untrusted network peer.

### HIGH

**H1. No type-runtime-check on any input.** The entire tool surface uses pattern `args.foo as string` with no runtime guard. A client that sends `{"agent": 123, "prompt": null}` to `am_run_agent` will get `promptText === null`, be passed to `client.prompt(sessionId, [{type:"text", text: null}])` where behavior is undefined.

- **Fix class:** wrap each handler in a Zod schema parse, or add a `validateArgs(def.inputSchema, args)` helper that throws with a structured error. Zod is not even imported in `server.ts` (confirmed — `grep zod` returns no matches).
- **Affected:** all 33 tools.

**H2. Path traversal in `am_acp_session_cancel`.** `sessionId` is joined naively to `sessionDir` and then `rm({recursive: true})` is called:

```ts
// server.ts:1683-1688
const sessionDir = config.settings?.acp?.session_dir ?? join(resolveConfigDir(), "sessions");
const sessionPath = join(sessionDir, sessionId);
await rm(sessionPath, { recursive: true });
```

A `sessionId` of `"../../../tmp/important"` would compute a path outside `sessionDir` and recursively delete it. Since the call is gated by `write-remote` opt-in (`allow_push`), the blast radius is limited, but if an operator has enabled `allow_push` for their own use, any MCP client they connect to could trigger directory deletions.

- **Fix:** canonicalize with `realpath` and verify `sessionPath` starts with `sessionDir`, or constrain `sessionId` to `^[a-zA-Z0-9_-]+$`.
- **Severity:** HIGH if `allow_push` is ever enabled.

**H3. `cwd` in `am_run_agent` is passed verbatim to subprocess.** The agent subprocess will read/write files from whatever `cwd` the client passes. If `allow_push` is enabled, a client can effectively read `~/.ssh/` contents by setting `cwd=/Users/baladita/.ssh` and prompting `cat id_rsa`.

- **Fix:** validate `cwd` against an allowlist in `settings.acp.allowed_paths`, or refuse paths outside the current `process.cwd()` subtree.

### MEDIUM

**M1. `am_registry_install.env` is a `Record<string, string>` but not type-checked.** A client that sends `env: {API_KEY: ["array"]}` will silently coerce to `"array"` or fail inside `writeConfig` (depending on the TOML lib). Low user harm, but produces confusing errors.

**M2. `am_wiki_add.confidence` range unchecked.** Schema says `0.0–1.0` in the description, but `-99` or `10e5` would be accepted. Storage likely tolerates it but downstream scoring could break.

**M3. `am_session_export.role` values unchecked.** The handler does `roles: [args.role as "user" | "assistant" | "system" | "tool"]` — if the caller passes `"administrator"`, the filter silently matches nothing and returns an empty export. No hint given.

**M4. `am_session_export.format` default silently falls back to "md".** Schema declares `enum: ["md", "json"]` but the handler does `(args.format as string) ?? "md"` — if someone passes `format: "yaml"`, it hits the `else` branch and returns markdown without warning.

**M5. `am_agent_discover.url` not validated.** Accepts any string, feeds it to `discoverFromUrl`. If the underlying client does not reject `file://` or `localhost`, this becomes an SSRF vector (especially if the server ever runs on behalf of a different principal).

**M6. `am_import.source` not sanitized.** Passed to `getAdapter(source)` — probably safe (adapter registry uses a fixed map), but the error message echoes the user value: `` `Adapter "${source}" not found...` `` — if `source` is multi-line or contains control chars, error echo could be confusing but not exploitable.

**M7. `am_registry_install` passes provided `env` values straight into config without interpolation.** If the client supplies a literal secret, it lands in `config.toml` unencrypted. There is no `encrypt: true` flag or automatic secret-detection hook before write. The `am_doctor` secret-audit will warn *after the fact*.

### LOW

**L1. `am_wiki_add.tags` / `am_add_server.tags` are `string[]` but not deduped or length-limited.** Could be a DoS vector for wiki storage if an attacker sends 10k tags. Not exploitable over MCP stdio today, but worth a soft limit.

**L2. `am_registry_search.limit` accepts any number.** `limit: -1` or `limit: 1e9` flows to the registry client. Registry probably bounds it, but defensive clamping in the MCP layer would be cleaner.

**L3. `am_session_search` does full-table scan across every adapter.** No `limit` parameter on the results; only the *matches-per-session* is clamped to 5 in the output. With thousands of sessions this is slow and allocates heavily.

**L4. `am_agent_delegate.message` has no size limit.** A 10 MB message would be forwarded to an A2A agent and the whole response buffered in memory.

---

## Security Findings

### HIGH

**S1. `rm --recursive` without path validation (H2 above).** Reclassifying here because this is a security issue, not just an input-validation gap.

**S2. Arbitrary subprocess spawn via `am_run_agent`.** The command string comes from `entry.acp.command` which itself comes from:
- The hardcoded built-in registry (`./protocols/acp/registry.ts`) — trustworthy.
- **`settings.acp.agents.*.acp.command` in config** — trusted if config.toml is trusted.
- The default fallback which resolves from `parseCommand(agentCommand)` — no shell involvement, so `; rm -rf /` in a command is not interpreted.

Attack surface: if an attacker can write to `config.toml` they already have local RCE, so this is not a net new vector. But the `cwd` escape (H3) is real.

**S3. Secret leakage through error messages.** `am_apply` catches `export()` errors with `errorMessage(e)` and returns the string verbatim:

```ts
// server.ts:1134-1140
} catch (e: unknown) {
  results.push({
    adapter: adapter.meta.name,
    files: 0,
    warnings: [errorMessage(e) || "export failed"],
  });
}
```

If an adapter throws with a message like `"EACCES writing /path: token=sk-…"`, the token is surfaced to the MCP client. Same risk in `am_agent_delegate` (A2A client errors) and `am_run_agent` (ACP client errors, which re-throw verbatim).

- **Fix:** run errors through a redactor (reuse `redactSecrets` generalized to scan for common patterns — `sk-[a-z0-9]+`, `Bearer [A-Za-z0-9\-_.]+`, `[A-Z0-9]{20}=` AWS keys).

**S4. `checkPermission` return unreachable branch.** The permission check has `if (tier === "write-remote")` inside a function that already returned for `read-only` / `write-local`. The `return { allowed: true }` at the end is dead code (unless a future ToolTier string sneaks in). If a typo tier like `"write-remote "` is ever assigned, it would default to `allowed: true`. Low risk but brittle.

### MEDIUM

**S5. `process.cwd()` in handlers.** `am_import`, `am_apply`, `am_run_agent` all use `process.cwd()` as the project path. If the MCP server is started in `$HOME`, it picks up any `.agent-manager.toml` in `$HOME` — probably the right behavior. But if a user `cd`s into a sibling project, the MCP server (long-running) still uses its startup cwd. Not a bug per se but surprising.

**S6. No rate limiting on `am_run_agent` or `am_agent_delegate`.** A malicious or buggy client can spawn unlimited subprocesses (ACP) or fire off unlimited A2A requests. The `A2AClient` has a 60 s timeout, but during those 60 s connections pile up.

- **Fix:** add a per-tool concurrency limit (e.g., `p-limit`) keyed by tool name.

**S7. Git operations run without lock.** `am_add_server`, `am_remove_server`, `am_server_update`, `am_import`, `am_registry_install`, `am_undo` all do `readConfig → mutate → writeConfig → commitAll`. Two concurrent MCP calls will race on `config.toml` and produce a merge-conflict state or lose writes.

- **Fix:** wrap write-local handlers in a single async mutex; the MCP server is single-process, so a module-level `AsyncLock` would suffice.

**S8. `am_run_agent` leaks agent subprocess on error path.**

```ts
// server.ts:1589-1592
} catch (err) {
  await client.disconnect().catch(() => {});
  throw err;
}
```

If `client.connect` itself throws after spawning the subprocess but before `this.subprocess` is assigned, there may be an orphan. Hard to hit in practice but worth an `ACP` client audit (out of scope for this review).

**S9. `am_acp_session_list` shows `agent: "unknown"` for every session.** The handler doesn't read a sidecar JSON to recover the actual agent name. This is a functionality gap, not a security issue, but the tool effectively returns directory listings, which could double as a reconnaissance channel if `session_dir` ever contains sensitive filenames.

### LOW

**S10. Config-dir env var (`AM_CONFIG_DIR`) honored without validation.** `resolveConfigDir()` reads `process.env.AM_CONFIG_DIR` and joins it to `config.toml`. If the env has `../`, everything still works because `join` normalizes, but a hostile parent process can redirect the config to `/tmp`. Expected Unix behavior; not an MCP issue.

**S11. No structured logging of permission denials.** When a `write-remote` tool is denied, the client gets a nice message but the server doesn't log it anywhere. Makes audit / forensics harder.

**S12. `redactSecrets` only catches `enc:v1:` prefixed values.** Plaintext secrets in `env` that never got encrypted are returned verbatim by `am_config_show`. The tool is read-only but its output may be copied to logs or AI context.

---

## Tool-Naming Consistency Findings

The user asked specifically about naming. The current conventions are:

| Pattern | Examples | Count |
|---------|----------|-------|
| `am_<noun>_<verb>` | `am_server_update`, `am_session_export`, `am_session_search`, `am_session_list`, `am_registry_install`, `am_registry_search`, `am_registry_list_installed`, `am_wiki_search`, `am_wiki_add`, `am_wiki_harvest`, `am_agent_discover`, `am_agent_list`, `am_agent_delegate`, `am_agent_task_status`, `am_acp_list_agents`, `am_acp_session_list`, `am_acp_session_cancel` | 17 |
| `am_<verb>_<noun>` | `am_list_servers`, `am_list_profiles`, `am_add_server`, `am_remove_server`, `am_use_profile`, `am_run_agent` | 6 |
| `am_<noun>` (single verb) | `am_status`, `am_apply`, `am_doctor`, `am_undo`, `am_import` | 5 |
| `am_<noun>_<subnoun>` | `am_config_show`, `am_sync_push`, `am_sync_pull`, `am_wiki_synthesize`, `am_wiki_briefing` | 5 |

**Observation.** The most recent additions (`am_server_update`, `am_undo`, `am_run_agent`, `am_acp_*`) bounce between all three conventions. The old core tools (`am_add_server`, `am_remove_server`, `am_list_servers`) are `verb_noun` but `am_server_update` (added recently) flips to `noun_verb`. Externally facing tool names are hard to change after release, so standardizing now is cheap.

**Recommendation.** Pick one and rename:
- `am_add_server` → `am_server_add`
- `am_remove_server` → `am_server_remove`
- `am_list_servers` → `am_server_list`
- `am_list_profiles` → `am_profile_list`
- `am_use_profile` → `am_profile_use`
- `am_run_agent` → `am_agent_run`

…giving a uniform `am_<group>_<verb>` hierarchy that maps cleanly to the tool-group structure (ADR-0021). Aliasing via a second entry in `defineTools()` would preserve backward compat.

---

## Tool-Description Error-Enumeration Findings

The user asked: do tool descriptions enumerate errors they can return? Short answer: **no**, descriptions are prose-style. Examples:

- `am_session_export.description`: *"Export an AI coding session by ID. Supports filtering by role, stripping tool/system messages, and markdown or JSON output."* — Does not mention: session-not-found, adapter-not-found, adapter-without-session-reader, invalid format.
- `am_run_agent.description`: mentions the prerequisite (agent must be registered) but not the error envelope shape.
- `am_acp_session_cancel.description`: *"Cancel an active ACP session by session ID."* — omits that cancellation is destructive (removes persisted state) and may fail with "not found."

**Best-in-class exception:** `am_apply.description` actually contains *"WARNING: writes files outside the am config directory"* which is excellent. This pattern should be replicated.

**Recommendation.** Append an `Errors:` section to each description, e.g.:

> `am_session_export`: … Errors: `NotFound` if session or adapter missing; `Unsupported` if adapter has no sessionReader.

This is particularly important for LLM clients that decide whether to invoke a tool based on its description alone.

---

## projectPath Audit (Regression Check)

The user flagged: earlier bug where `adapter.import({})` was called without `projectPath`. Verification:

```
server.ts:239  await adapter.diff(resolved);                    // diff() takes no options — OK
server.ts:887  await adapter.import({ projectPath: process.cwd() });  // FIXED
server.ts:1125 await adapter.export(resolved, {
                 projectPath: projectFile ? join(projectFile, "..") : undefined,
                 dryRun: !!args.dryRun,
               });                                              // OK but see note
```

**Findings:**
1. `am_import` (line 887) correctly passes `projectPath: process.cwd()`. Fix confirmed.
2. `adapter.diff()` in `am_status` (line 239) does *not* take `projectPath` per the `Adapter` interface — not a regression.
3. `am_apply` (line 1125) passes `projectPath: projectFile ? join(projectFile, "..") : undefined`. This is the **directory containing** `.agent-manager.toml`, not the file itself. That's intentional and correct. But note: `undefined` is passed when there's no project file, which is valid per `ExportOptions.projectPath?: string`. All adapters must tolerate `undefined` — if any adapter dereferences it unconditionally, there'll be a crash. Adapter audit is out of scope here, but worth flagging.
4. Test coverage: `am_import with 'auto'` and `am_import with specific adapter` verify the *call* succeeds but do not assert that `projectPath` equals `process.cwd()` in the adapter. A mock-adapter test would catch a regression.

---

## Undo / Log-Entry Audit

User asked: does each write tool produce an undo-able git commit?

| Tool | Commits? | Commit Message | Recoverable via `am_undo`? |
|------|----------|----------------|---------------------------|
| `am_add_server` | yes | `add server: <name>` | yes |
| `am_remove_server` | yes | `remove server: <name>` | yes |
| `am_server_update` | yes | `update server: <name>` | yes |
| `am_use_profile` | **no** | (only writes `.active-profile`) | **NO** |
| `am_import` | yes, only if `totalImported > 0` | `import: <source> (<N> servers)` | partial |
| `am_apply` | no — writes to IDE configs outside config repo | n/a | **NO** |
| `am_sync_push` | no (pushes existing) | n/a | n/a |
| `am_sync_pull` | yes (fast-forward) | remote commits | yes (but can't redo push) |
| `am_registry_install` | yes | `registry install: <name>` | yes |
| `am_wiki_add` | **no** | wiki storage lives outside git-tracked files (needs verification in `wiki/storage.ts`) | **NO** |
| `am_wiki_harvest` | **no** | same | **NO** |
| `am_acp_session_cancel` | no — filesystem delete | n/a | **NO** (destructive) |
| `am_agent_delegate` | no — runtime dispatch | n/a | n/a |
| `am_run_agent` | no — runtime execution | n/a | n/a |

**Gaps:**
- `am_use_profile` changes state (active profile) but can't be rolled back via `am_undo`. User must call `am_use_profile` with the old name (which they may not remember). Recommendation: write a `HEAD` note or include active-profile in git-tracked file.
- Wiki writes are opaque to `am_undo`. Either bring wiki storage under git, or add a separate `am_wiki_undo`.
- `am_apply` is especially dangerous: it writes to IDE configs that are not under `am`'s git control. If an apply goes wrong, undoing the *config* commit doesn't restore the IDE files. `am_apply` should (a) stash existing IDE configs before overwriting or (b) document clearly that it's not reversible via `am_undo`.
- `am_acp_session_cancel` is irreversible by design — fine, but the tool description doesn't warn.

---

## Test Coverage Gaps (Ranked by Risk)

### HIGH (write-path untested)
1. **`am_registry_install` handler:** no test exercises the actual install path, env-var defaulting, or `_registry` provenance writing. High risk — it writes to config AND emits a commit.
2. **`am_sync_push` / `am_sync_pull` handlers:** only permission-denial is tested. Actual push/pull code paths (with/without remote) are untested.
3. **`am_apply` non-dry-run:** only `dryRun: true` is tested. The actual file-writing branch is never exercised.
4. **`am_run_agent` success path:** only tier and permission. Actual ACP spawn → prompt → result-shape is untested. Would need a mock ACP client.

### MEDIUM (runtime tool paths untested)
5. **All 4 A2A tools** (`am_agent_discover`, `am_agent_list`, `am_agent_delegate`, `am_agent_task_status`) have no handler tests.
6. **All 5 wiki tools** (`am_wiki_search`, `am_wiki_add`, `am_wiki_synthesize`, `am_wiki_briefing`, `am_wiki_harvest`) have no handler tests.

### LOW (error-path coverage)
7. `am_registry_search`: not tested at all.
8. `am_registry_list_installed`: not tested at all.
9. `am_import` with real adapter producing servers: only "no tools detected" and structural shape tests. Merge-into-existing logic not asserted.
10. `am_session_list` without adapter filter: not tested.
11. `am_doctor` failure-path tests: only the happy path (setupConfig creates healthy state). Tests for missing config dir, missing git, etc. would strengthen the contract.

---

## Recommendations

### P0 — Ship-Blocking for External Exposure
1. **Add runtime input validation.** Adopt Zod and wrap each handler. Even a 50-line helper that reads `inputSchema.required` and type-checks each field would close H1 for zero dependencies.
2. **Sanitize `sessionId` in `am_acp_session_cancel`.** Require `^[a-zA-Z0-9_-]+$` and canonicalize + contain. Close H2.
3. **Constrain `cwd` in `am_run_agent`.** Refuse paths that aren't under a configured allowlist. Close H3.

### P1 — Before v1 GA
4. **Scrub errors through a redactor** before placing in the MCP envelope. Close S3.
5. **Serialize write-local handlers via an async mutex.** Close S7.
6. **Add concurrency limits to `am_run_agent` and `am_agent_delegate`** (e.g., max 3 in-flight). Close S6.
7. **Standardize tool names on `am_<group>_<verb>`** with backward-compat aliases. Rename `am_run_agent` → `am_agent_run`; `am_add_server` → `am_server_add`; etc.
8. **Append `Errors:` to every tool description** so LLM clients know failure modes without probing.

### P2 — Hygiene & Coverage
9. **Add handler-level tests** for all 12 currently-untested tools. Wiki + registry + A2A especially.
10. **Add mock-adapter tests** that assert `projectPath === process.cwd()` in `am_import` / `am_apply`.
11. **Bring wiki writes under git** or add `am_wiki_undo`.
12. **Bring active-profile under git** so `am_undo` reverses `am_use_profile`.
13. **Log permission denials to stderr** in structured form.
14. **Document in the tool description** that `am_apply` writes outside the am config dir and cannot be rolled back by `am_undo`.
15. **Clamp `am_registry_search.limit`, `am_wiki_add.confidence`, `am_agent_delegate.message` size, `am_wiki_*.tags` length.**

### P3 — Nice-to-Have
16. **Add optional `cursor` support** to `tools/list` for spec-completeness.
17. **Emit `notifications/tools/list_changed`** when `mcp_serve.tools` changes at runtime.
18. **Factor `defineTools()`** (currently a 1500-line function) into per-group modules (`core.ts`, `session.ts`, `registry.ts`, `wiki.ts`, `a2a.ts`, `acp.ts`). Each exports a `ToolEntry[]`. Makes future review and test ownership cleaner.

---

## Appendix A — Key Line References

| Concern | File:Line |
|---------|-----------|
| Tool group map | server.ts:73-99 |
| `checkPermission` | server.ts:108-129 |
| `redactSecrets` | server.ts:133-140 |
| `am_doctor` handler | server.ts:282-426 |
| `am_apply` error path (secret leak) | server.ts:1134-1140 |
| `am_import` projectPath pass (fixed) | server.ts:887 |
| `am_run_agent` handler | server.ts:1549-1594 |
| `am_acp_session_cancel` path traversal risk | server.ts:1683-1688 |
| `parseCommand` (no shell, no escape) | protocols/acp/registry.ts:87-93 |
| `errorMessage` (no secret redaction) | lib/errors.ts:6-9 |
| `handleRequest` error envelope | server.ts:1805-1824 |
| stdio loop | server.ts:1859-1899 |

## Appendix B — Test File Structure

`test/mcp/server.test.ts` is organized into 7 `describe` blocks:
1. `MCP server` — core + server_update + doctor + undo + session tool structure (~20 tests).
2. `MCP error response structure` — hint field presence (4 tests).
3. `MCP am_import passes projectPath to adapters` — regression test (2 tests).
4. `MCP am_list_profiles handler` — 1 test.
5. `MCP am_use_profile handler` — 1 test.
6. `MCP session tools — core function integration` — tests pure functions `filterMessages`, `formatJson`, `formatMarkdown` directly, **not** the MCP handlers. (11 tests). Good coverage of session *primitives*, weaker coverage of the MCP wrapper.
7. `MCP ACP tools` — registration, tier, schema-shape, and one handler test for `am_acp_list_agents`. (12 tests).

**Notable absence:** no describe block for registry, wiki, or A2A tools.
