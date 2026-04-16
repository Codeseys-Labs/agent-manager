# Cross-Review: Iterations 9–10 New Modules

**Reviewer:** cross-review agent  
**Date:** 2026-04-16  
**Scope:** 8 new/modified modules from the last two implementation iterations

---

## Severity Scale

| Label | Meaning |
|-------|---------|
| CRITICAL | Correctness bug or security issue that will cause failures in production |
| HIGH | Logic error, missing guard, or convention violation with real impact |
| MEDIUM | Edge case gap, test coverage hole, or sub-optimal behaviour |
| LOW | Style, naming, minor inconsistency |
| INFO | Observation with no actionable defect |

---

## 1. `src/protocols/acp/flows.ts` — Flows Engine

**Overall:** Well-structured, good separation of concerns, clean error types. The injected-executor pattern (AcpNodeExecutor, CheckpointHandler) is the right call — keeps the engine testable without a real ACP runtime. State persistence is solid.

### Findings

#### CRITICAL — No cycle detection; infinite loop on cyclic edges

`runFlow` follows edges in an unbounded `while` loop. If a flow graph contains a cycle (A→B→A), the loop never terminates, consumes all memory via ever-growing `executionOrder`, and writes a run-state file on every iteration.

```
// flows.ts:317 — while (currentId !== null)
// Nothing prevents re-visiting nodes
```

No cycle guard, no max-steps limit. A malformed or adversarially crafted flow TOML that reaches here (via `am flow run`) will hang the process.

**Fix:** Track visited node IDs in the current run; detect re-entry and throw a `FlowError` with code `CYCLE_DETECTED`. Or enforce a configurable `maxSteps` cap.

---

#### HIGH — `findEntryNode` silently falls back to first node when all nodes have incoming edges (cyclic graph)

```ts
// flows.ts:250-253
for (const id of nodeIds) {
  if (!allTargets.has(id)) return id;
}
// Fallback: first node
return nodeIds[0];
```

If every node is targeted by an edge (cycle), the entry detection falls through to `nodeIds[0]`. Combined with no cycle detection above, the runner will start from an arbitrary node and loop forever. The fallback comment says "Fallback: first node" with no error. This should throw rather than silently pick a node.

---

#### HIGH — `executeCheckpointNode` passes wrong first argument to `checkpointHandler`

```ts
// flows.ts:458-459
return opts.checkpointHandler(node.message ?? "checkpoint", node.message);
```

`CheckpointHandler` signature (line 201):
```ts
type CheckpointHandler = (nodeId: string, message: string | undefined) => ...
```

The first parameter is `nodeId` but the implementation passes `node.message ?? "checkpoint"`. The actual `nodeId` is not in scope inside `executeCheckpointNode` — it's only available in `runFlow`. This means a checkpoint handler that routes on `nodeId` (to replay or distinguish checkpoints) will always receive the *message* string instead of the node ID.

**Fix:** Thread `nodeId` through `executeCheckpointNode(node, _input, opts, nodeId)` and pass it as the first argument to the handler.

---

#### MEDIUM — Run state files accumulate indefinitely; no cleanup or cap

`saveRunState` writes one JSON file per run to `~/.agent-manager/flows/runs/` and `listRuns` reads all of them. There is no pruning, no max-run count, and no TTL. A project that runs many flows will accumulate unbounded disk usage and increasingly slow `listRuns` reads.

**Suggestion:** Add a `maxRuns` option (default 100) to `runFlow` / `listRuns`, or a standalone `pruneRuns(olderThanDays)` export.

---

#### MEDIUM — Action node `executeActionNode` does not apply input interpolation to `cwd`

The `command` string supports `{{key}}` interpolation, but the `cwd` override on `ActionNode` does not:

```ts
const actionCwd = node.cwd ?? flowCwd;      // no interpolation
const command = interpolateTemplate(node.command, input); // interpolated
```

A user who writes `cwd: "{{projectDir}}"` in a flow node will see a literal `{{projectDir}}` path, which will fail silently (the shell will use the literal string as cwd).

---

#### LOW — `interpolateTemplate` regex allows only `\w+` keys (no hyphens/dots)

`/\{\{(\w+)\}\}/g` — keys with hyphens (`{{my-key}}`) or nested paths (`{{a.b}}`) are silently left unreplaced. This is acceptable for the current contract (`Record<string, unknown>` flat keys) but the comment says "Use `{{key}}` for input interpolation" without documenting the restriction. Document it.

---

### Test Coverage Assessment

Coverage is thorough: linear flows, data passing, non-object output wrapping, action failures, ACP mock executor, checkpoint pause/resume, conditional routing (with and without default), entry node detection, all persistence paths, both error types. 

**Missing tests:**
- Cycle detection (once a guard is added)
- `executeCheckpointNode` passing correct `nodeId` to handler (regression for the HIGH bug above)
- `maxSteps` / runfile accumulation behavior if/when added

---

## 2. `src/core/merge.ts` — Brownfield Import Merge

**Overall:** Clean implementation of ADR-0028. Two-tier matching logic is sound, field-level diff and merge strategies are correct, encrypted-ref preservation is well handled.

### Findings

#### HIGH — `identifyDuplicates` does not deduplicate when multiple existing servers share the same basename or identity

`basenameMap` and `nameMap` are built via a plain `Map.set`, which means if two existing servers have the same command basename (e.g., two different `uvx mcp-server-fetch` entries with different names), the last one wins silently. The first one is dropped from the map and can never be matched.

This is an edge case in practice but is not documented as a known limitation and produces silent data loss in `basenameMap`.

---

#### HIGH — `commandBasename` strips `@version` using `lastIndexOf("@")`, which breaks package-scoped names

```ts
const atIdx = pkg.lastIndexOf("@");
const bare = atIdx > 0 ? pkg.substring(0, atIdx) : pkg;
```

For `@anthropic-ai/claude-mcp@1.0.0`, `lastIndexOf("@")` correctly finds the version `@`. But for `@anthropic-ai/claude-mcp` with no version, `lastIndexOf("@")` returns `0`, which the `atIdx > 0` guard catches correctly.

However for `@scope/pkg@1.0.0`, after stripping the version you get `@scope/pkg`. The subsequent slash strip then takes `pkg` as the basename — correct.

But for `@scope/pkg` (no version, idx == 0 because the first char is `@`), the guard `atIdx > 0` is false, so `bare = "@scope/pkg"`. Then `lastIndexOf("/")` gives `bare = "pkg"` — also correct.

Actually this is fine. Mark as INFO — no bug, but the double-negative logic is fragile and worth a comment.

---

#### MEDIUM — `runMergePipeline` with `strategy = "force"` applies force to *exact and fuzzy* matches, but `mergeServers("force")` does not preserve `adapters` field

```ts
// mergeServers force branch (line 347-358):
return {
  command: incoming.command,
  args: incoming.args,
  env: incoming.env,
  transport: incoming.transport ?? "stdio",
  description: incoming.description,
  tags: incoming.tags,
  enabled: incoming.enabled ?? true,
  _registry: existing._registry,
  // adapters: NOT INCLUDED
};
```

In `auto` mode the result preserves `existing.adapters` (line 369). In `force` mode it is silently dropped. If an existing server has adapter-specific overrides (e.g., cursor-specific config in the `adapters` section), a `force` import will delete them without warning.

---

#### MEDIUM — No test for `runMergePipeline` with strategy `"interactive"` returning *both* compatible and conflicting entries

The test at line 674 tests interactive mode only with an env diff (compatible boundary). There is no test verifying that a fuzzy match is also returned as a conflict in interactive mode (it is, because the pipeline hits the `strategy === "interactive"` branch before the fuzzy check, but this is only implicitly covered).

---

#### LOW — `recordsEqual` is defined but never called

`recordsEqual` (line 163) exists but `computeFieldDiffs` doesn't use it — it manually iterates `allEnvKeys`. It appears to be a dead helper. Either use it or remove it.

---

### Test Coverage Assessment

Excellent coverage of the happy paths. Gaps:
- `force` strategy dropping `adapters` field (regression for the MEDIUM above)
- `identifyDuplicates` with duplicate basenames in existing
- No test for `commandBasename` in isolation (it handles several edge cases)
- Interactive mode with a fuzzy match

---

## 3. `src/adapters/community/` — Community Adapter Loader + Proxy + Types

**Overall:** Solid subprocess-as-adapter pattern. JSON-RPC framing with timeout is correct. The cache and kill lifecycle are well-designed. The synchronous stubs are a pragmatic interface compatibility shim.

### Findings

#### CRITICAL — `CommunityAdapterProxy.create` executes an arbitrary command from `adapters.toml` with no integrity check at load time

`loader.ts:62`:
```ts
const proxy = await CommunityAdapterProxy.create(config.command);
```

`config.command` is read directly from the TOML file on disk. While `CommunityAdapterConfig` has a `checksum` field, it is stored but **never verified** anywhere in `loader.ts` or `proxy.ts`. The field is `optional` and its verification is entirely absent from the implementation.

An attacker who can write to `~/.config/agent-manager/adapters.toml` (or who convinces a user to install a malicious adapter) can execute arbitrary code silently the next time `loadCommunityAdapters` is called — which happens on every `am` command that uses an adapter-aware path.

This was flagged as CRITICAL in the security ADR (ADR-0019). The checksum field should either be verified against the binary before spawning, or the code should refuse to load adapters lacking checksums in non-dev mode.

---

#### HIGH — Module-level `proxyCache` is a process-global singleton; leaks between tests and prevents garbage collection

```ts
// loader.ts:19
const proxyCache = new Map<string, CommunityAdapterProxy>();
```

`proxyCache` is a module-level singleton. Test isolation requires either `killAllProxies()` after each test or accepting that a proxy spawned in one test persists through subsequent tests. The existing tests call `proxy.kill()` on the direct proxy instance but never clear the module-level cache, so `loadCommunityAdapters` calls in later tests may return stale cached proxies from earlier tests.

More practically, if `loadCommunityAdapters` is called twice in the same process (e.g., during `am apply` on multiple adapters), the second call skips re-initialization, which is the desired behaviour. But if the first proxy's subprocess died (crash, OOM), the cached dead proxy will be silently returned.

**Fix:** In `loadCommunityAdapters`, detect dead proxies (check `proxy.process?.exitCode !== null`) before returning from cache, and evict + respawn if dead.

---

#### HIGH — `CommunityAdapterProxy.spawn()` starts `readLoop()` but never awaits it; read errors are silently swallowed

```ts
private spawn(): void {
  // ...
  this.readLoop(); // fire-and-forget async
}
```

`readLoop` is an `async` function called without `await`. Errors in the read loop that escape the `try/catch` bubble into an unhandled promise rejection. The inner `catch` rejects all pending requests (correct), but the outer rejection is unhandled. Under Bun's strict unhandled-rejection policy this terminates the process.

---

#### MEDIUM — `loader.ts` passes only `config.command` but not `config.args` to `CommunityAdapterProxy.create`

`CommunityAdapterConfig` has both `command` and an implicit `args`-like path in `source`, but the `create` call only passes `command`:

```ts
const proxy = await CommunityAdapterProxy.create(config.command);
// args = [] implicitly
```

Adapters that need arguments to start (e.g., `my-adapter --transport stdio --mode strict`) cannot be configured via `adapters.toml`. The `CommunityAdapterConfig` type should include an `args` field and the loader should pass it.

---

#### LOW — `initialize()` does not verify that `initResult.protocolVersion` matches `PROTOCOL_VERSION`

```ts
if (!initResult?.protocolVersion) {
  throw new Error("Community adapter did not return a valid initialize response");
}
```

A protocol version mismatch (e.g., adapter at v2.0, host at v1.0) is silently accepted as long as the field is non-empty. Add a version compatibility check.

---

### Test Coverage Assessment

`proxy.test.ts` uses a real mock subprocess (mock-adapter.ts), which is the correct pattern. It covers all async methods and the synchronous stubs.

**Missing tests:**
- What happens when the subprocess exits mid-operation (pending request rejection)
- `loadCommunityAdapters` with a dead cached proxy (the HIGH bug above)
- Checksum verification once implemented
- `loader.ts` with `enabled: false` entries being skipped

---

## 4. `src/adapters/claude-code/marketplace.ts` — Plugin Scanner

**Overall:** Clean, focused, does exactly what it says. The inline `require("node:fs")` pattern is consistent with other adapters per CLAUDE.md convention.

### Findings

#### HIGH — Plugin IDs from `enabledPlugins` are used as path components without validation; path traversal possible

```ts
// marketplace.ts:53
const pluginDir = join(home, ".claude", "plugins", pluginId);
```

`pluginId` comes from the parsed `settings.json` file. A `settings.json` with a malicious entry like `"../../../etc"` as a plugin ID would result in reading files from arbitrary paths. While this file is user-owned, it can be tampered with by another process, and a defense-in-depth check is expected per ADR-0019.

**Fix:** Validate that `pluginId` is a safe directory name (alphanumeric, hyphens, dots only — no path separators, no `..`).

---

#### MEDIUM — `manifest.mcpServers` entries are trusted without any command allowlist check

Skill paths and MCP server commands from plugin manifests are returned as-is as `ImportedServer` entries. If a plugin manifest declares `command: "rm"` with `args: ["-rf", "/"]`, `scanClaudePlugins` will surface it as a valid server to import. The caller (import pipeline) may apply secret detection but there is no command sanity check here.

This is a defense-in-depth issue; the import command should not blindly trust marketplace-sourced server commands without at least warning.

---

#### MEDIUM — `skill.path` is joined with `pluginDir` but not validated as relative

```ts
skills.push({
  name: skill.name,
  path: join(pluginDir, skill.path),
  // ...
});
```

If `skill.path` is an absolute path (`/etc/passwd`) or contains `..`, `join` will allow it to escape the plugin directory. Validate that `skill.path` is a relative path with no `..` components.

---

#### LOW — No test for the case where `enabledPlugins` contains a non-string entry

If `settings.json` has `"enabledPlugins": [42, null]`, the `for...of` loop will pass `42` and `null` as `pluginId` to `join()`, producing paths like `.../.claude/plugins/42`. The subsequent `readFileSync` will fail, caught by the inner try/catch, but a warning will be pushed that contains the coerced value rather than a useful message. Add a `typeof pluginId === "string"` guard.

---

### Test Coverage Assessment

Need to verify the test file covers path traversal and non-string plugin ID inputs. Based on the test file name (`marketplace.test.ts`), the standard happy path is likely covered. The security edge cases noted above are expected to be missing.

---

## 5. `src/adapters/shared/marketplace-vscode.ts` — VS Code Extension Scanner

**Overall:** Well-designed shared utility that avoids code duplication across Copilot, Cursor, Kiro, and Windsurf adapters. The `resolveExtensionVars` function is correct and well-tested in concept.

### Findings

#### HIGH — `EXTENSION_DIRS` has no `windows` paths; silently returns `undefined` on Windows

```ts
const EXTENSION_DIRS: Record<string, { darwin: string; linux: string }> = { ... }
// getExtensionsDir: const plat = process.platform === "darwin" ? "darwin" : "linux";
```

Windows maps to `"linux"`, which produces the Linux path. On Windows the actual extension directories are under `%APPDATA%\Code\User\extensions` etc. This means the scanner returns no results on Windows — which is silent, not an error.

Given the project targets Windows (`bun-windows-x64` is a build target), this is a real gap.

**Fix:** Add `windows` paths to the `EXTENSION_DIRS` map and select via `process.platform`.

---

#### MEDIUM — `resolveExtensionVars` only handles `${extensionPath}` but VS Code extensions can use other variables

VS Code extension `contributes.mcpServers` may use `${userHome}`, `${workspaceFolder}`, or other VS Code variables. These are currently passed through unresolved. This is unlikely to break anything (unresolved vars will just fail at runtime), but should be documented.

---

#### MEDIUM — Extension tag uses `${pkg.publisher}.${pkg.name}` but both may be `undefined`

```ts
tags: [`extension:${pkg.publisher}.${pkg.name}`],
```

If `pkg.publisher` or `pkg.name` is undefined (both are optional in `ExtensionPackageJson`), the tag becomes `extension:undefined.undefined`. This corrupts tagging. Add a guard to use a fallback value (e.g., the directory name).

---

#### LOW — No test for Windows path resolution once Windows paths are added

---

### Test Coverage Assessment

The shared scanner pattern is well-tested via the adapter-specific test files (`copilot`, `cursor`, etc.). The `resolveExtensionVars` function should have dedicated unit tests covering `${extensionPath}` replacement and edge cases with no variables.

---

## 6. `src/commands/completion.ts` — Shell Completions

**Overall:** Clean, stateless, pure string generation. The fish completion function helpers are correct. No security surface.

### Findings

#### MEDIUM — `TOP_LEVEL_COMMANDS` is a static list that will drift from `src/cli.ts` as commands are added

The list in `completion.ts` is not derived from `src/cli.ts`'s `subCommands` registry — it is hardcoded. When a new command is added to the CLI, a developer must remember to update `completion.ts` separately. This has already diverged: `flow` is registered in `cli.ts:53` but is **not in `TOP_LEVEL_COMMANDS`**.

```ts
// cli.ts:53
flow: () => import("./commands/flow").then((m) => m.flowCommand),

// completion.ts TOP_LEVEL_COMMANDS — "flow" is absent
```

`am flow` will not complete in any shell.

**Fix:** Either export `subCommands` from `cli.ts` and import it in `completion.ts`, or add a CI/lint check that the two lists match. At minimum, add `"flow"` to `TOP_LEVEL_COMMANDS` immediately.

---

#### MEDIUM — `SUBCOMMANDS` for `"run"` lists `["agents", "session"]` but `am run` only has these if registered; `flow` subcommands are missing

`SUBCOMMANDS` has no entry for `"flow"`:
```ts
// flow has: run, list, status
// None of these will complete
```

---

#### LOW — Bash completion: `compgen -W "$flags"` at depth-3+ runs regardless of context

In the bash script, the depth-2 subcommand case returns early with `return 0`, but the depth-1 and final flag fallback code always runs. This is standard bash completion behaviour but means the fallback always offers flags even for subcommand positions. Benign but imprecise.

---

#### LOW — Fish completion: `complete -l '${flag.replace(/^--/, '')}'` strips the leading `--` but `--profile` becomes `-l 'profile'` (long flag, correct) while `-q` alias flags from subcommands are not included

Minor UX issue, no functional bug.

---

### Test Coverage Assessment

The existing test covers constants membership and that generator functions return strings containing expected snippets. 

**Missing:**
- `completion.test.ts` should assert that every command registered in `cli.ts` appears in `TOP_LEVEL_COMMANDS` (the drift regression)
- Generated bash script should be validated with `bash -n` (syntax check) — currently tests only check string containment

---

## 7. `src/commands/flow.ts` — Flow CLI

**Overall:** Straightforward CLI wrapper. Uses `output` helpers correctly. JSON mode is supported throughout. `process.exitCode = 1` (not `process.exit(1)`) is the correct citty pattern.

### Findings

#### HIGH — `am flow run` uses dynamic `import(flowName)` with a user-supplied path; arbitrary module execution

```ts
// flow.ts:52
flowModule = await import(flowName);
```

`flowName` is the raw positional CLI argument. On Bun, `import()` resolves relative paths from `process.cwd()` and absolute paths as-is. A user running `am flow run /tmp/malicious.ts` will execute that module. While this is intentional (the command is designed to run flow modules), there is no documentation, no sandbox, and no warning that this executes arbitrary code. 

For a tool that manages secrets and MCP configs, the implicit trust is significant. At minimum, add a prominent warning in the help text and validate that the path has a `.ts` or `.js` extension before importing.

---

#### MEDIUM — `am flow run` validates structure with `"nodes" in flowDef && "edges" in flowDef` but does not validate with Zod

The validation:
```ts
if (!flowDef || typeof flowDef !== "object" || !("nodes" in flowDef) || !("edges" in flowDef))
```

...is insufficient. A module that exports `{ nodes: null, edges: 42 }` passes this check but will immediately fail at `Object.keys(flow.nodes)` with a cryptic error. Add a proper Zod schema for `FlowDefinition` and validate before running.

---

#### MEDIUM — `am flow status` iterates `Object.keys(state.nodes)` for display, which is insertion order — may differ from `executionOrder`

```ts
for (const nodeId of Object.keys(state.nodes)) { ... }
```

All nodes (including pending ones) are shown in insertion order (initialisation order from `runFlow`), not execution order. The output can be confusing when a conditional flow skips some nodes. Consider iterating `executionOrder` first (to show what ran), then the remainder.

---

#### LOW — `am flow list` truncates `flowName` at 20 chars with `padEnd(20)` — names longer than 20 chars will misalign the table

No truncation is applied. `"my-very-long-flow-name-that-exceeds-column"` will push all subsequent columns to the right.

---

### Test Coverage Assessment

No `test/commands/flow.test.ts` is present (it was not in the test directory listing). This command has zero test coverage. Given that it performs dynamic module import and state file I/O, this is a significant gap.

**Missing tests (entire file):**
- `am flow list` with no runs
- `am flow list` with multiple runs (column output)
- `am flow status` with valid run ID
- `am flow status` with missing run ID (exit code 1)
- `am flow run` with invalid JSON `--input` (exit code 1)
- `am flow run` with missing module (exit code 1)
- `am flow run` with invalid flow structure (exit code 1)

---

## 8. `src/protocols/bridge.ts` — A2A-ACP Bridge

**Overall:** This is the keystone connecting A2A to ACP (ADR-0026 Phase 4). The double-parse pattern (`createBridgedTaskHandler` calls `parseBridgeRequest` and then `createBridgeTaskHandler` calls it again) is a minor inefficiency but not a bug. `client.disconnect()` in `finally` is correct. Error handling returns graceful error messages rather than throwing, which is appropriate for the A2A response contract.

### Security review status

The previous security review flagged issues in this file. Based on the current code:

- `parseBridgeRequest` validates agent name is `\S+` (non-whitespace); prompt comes from the message body and is passed to the ACP subprocess directly. No shell-injection risk since ACP sends structured messages, not shell commands.
- `client.disconnect()` is in `finally` — correct resource cleanup.
- The `resolveUnifiedAgent` check ensures only registry-known agents are invoked.

No new security findings beyond what was previously flagged.

### Findings

#### MEDIUM — `createBridgeTaskHandler` returns an error-shaped *success* response (not `null`) when the message doesn't match the bridge pattern

```ts
// bridge.ts:99-109
if (!request) {
  return {
    message: { role: "agent", parts: [{ type: "text", text: "Bridge: message does not match bridge pattern..." }] },
  };
}
```

The docstring for `createBridgeTaskHandler` says "If the message doesn't match the bridge pattern, returns null so the caller can fall through to another handler." But it returns a message response, not `null`. 

The `createBridgedTaskHandler` works around this by calling `parseBridgeRequest` *before* delegating:
```ts
const request = parseBridgeRequest(userMessage);
if (request) return bridgeHandler(userMessage, config);
return defaultHandler(userMessage, config);
```

So the behaviour is correct via the composite handler. But if a caller uses `createBridgeTaskHandler` directly (as the bridge test does), non-bridge messages return a "does not match" error message rather than `null`. The docstring is wrong. Fix the comment.

---

#### MEDIUM — Timeout race uses `Promise.race` with a bare `setTimeout` that is never cleared on success

```ts
const result = await Promise.race([
  client.prompt(sessionId, [...]),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Bridge: ACP prompt timed out")), timeout),
  ),
]);
```

When the prompt resolves before the timeout, the `setTimeout` callback is left registered but calls `reject` on an already-settled promise — harmless but leaks a timer reference. In environments where the process runs multiple bridge tasks concurrently, many orphaned timers can accumulate.

**Fix:** Use `AbortController` or wrap in a helper that clears the timer on resolution.

---

#### LOW — Agent name in error messages reflects the original request, not the resolved registry name

When an agent resolves to an ACP entry with a different canonical name, error messages still use `request.agent` (the user-supplied name). Minor UX inconsistency.

---

### Test Coverage Assessment

`test/protocols/bridge.test.ts` is comprehensive:
- `parseBridgeRequest`: 9 cases including edge cases (empty message, missing fields, case-insensitive, data-part priority)
- `createBridgeTaskHandler`: non-existent agent, non-bridge message, real binary not installed
- `createBridgedTaskHandler`: routing logic for bridge vs. fallthrough
- A2A server integration: bridge-enabled routing, fallthrough, bridge-disabled, data-part routing

**Missing:**
- The timeout path (would require a slow mock ACP executor)
- Concurrent bridge calls (timer accumulation scenario)

---

## Summary Table

| Module | CRITICAL | HIGH | MEDIUM | LOW | Test Gap |
|--------|----------|------|--------|-----|----------|
| `protocols/acp/flows.ts` | 1 (cycle) | 2 | 2 | 1 | missing cycle, nodeId tests |
| `core/merge.ts` | — | 2 | 2 | 1 | force/adapters, duplicate basename |
| `adapters/community/proxy.ts` | — | 1 (readLoop) | 1 | 1 | subprocess exit mid-op |
| `adapters/community/loader.ts` | 1 (checksum) | 1 (dead proxy) | 1 (no args) | — | dead proxy, enabled:false |
| `adapters/community/types.ts` | — | — | — | — | — |
| `adapters/claude-code/marketplace.ts` | — | 1 (path traversal) | 2 | 1 | security edge cases |
| `adapters/shared/marketplace-vscode.ts` | — | 1 (Windows) | 2 | 1 | Windows paths |
| `commands/completion.ts` | — | — | 2 (drift, flow missing) | 2 | drift regression test |
| `commands/flow.ts` | — | 1 (arbitrary import) | 2 | 1 | no test file at all |
| `protocols/bridge.ts` | — | — | 2 | 1 | timeout path |

### Top Priorities (must fix before release)

1. **CRITICAL — `flows.ts` cycle detection** — unbounded loop on cyclic graphs, no guard at all
2. **CRITICAL — `loader.ts` checksum never verified** — community adapter binary integrity not checked despite checksum field existing
3. **HIGH — `flows.ts` checkpoint handler receives message instead of nodeId** — silent API contract violation
4. **HIGH — `completion.ts` missing `flow` command** — `am flow` never tab-completes in any shell
5. **HIGH — `marketplace.ts` plugin ID path traversal** — unsanitized path component from settings file
6. **HIGH — `commands/flow.ts` zero test coverage** — CLI command with dynamic import and I/O has no tests
