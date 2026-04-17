# Parallel / Concurrent Tool Calling in `am mcp-serve`

**Date:** 2026-04-17
**Scope:** `src/mcp/server.ts` (33 tools) and the shared state each tool touches.
**Question:** Can a modern MCP client (Claude Code, Cursor) safely parallelize `tools/call` requests against `am mcp-serve`?

---

## Summary

**Concurrency safety rating: 3 / 10.**

The server is *protocol-level parallel* (batch elements are dispatched with `Promise.all`, and stdio requests are not serialized by a queue) but *business-level unsafe* (no mutex guards the read-modify-write cycles on `~/.config/agent-manager/config.toml`, `~/.claude.json`, the wiki index, the git repo, or the A2A roster). No test exercises concurrent handler execution.

The reason this hasn't bitten yet is accidental: Claude Code typically serializes MCP calls per-server for its own reasons, and real-world request rates are low. The moment an agent decides to parallelize — Cursor with its batch mode, any autonomous loop, a test harness — a corrupt TOML, a lost server, or a torn JSON is one or two requests away.

Fix is cheap: add a single per-server async mutex and classify the 33 tools into `read-only | config-rmw | filesystem-rmw | wiki-rmw | git-rmw`. See **Recommendations** at the end.

---

## Current behavior

### Protocol dispatch

`McpServer.handleRequest()` is `async` and **does not await a lock** — `src/mcp/server.ts:2161`. Each call is dispatched independently the moment it enters the function.

The stdio loop (`serve()`, `src/mcp/server.ts:2432-2495`) reads lines from stdin and calls `handleRequest()` **without `await`ing completion before reading the next line** — wait, let me re-check:

```ts
// src/mcp/server.ts:2488-2492
const resp = await this.handleRequest(req);
if (resp) {
  process.stdout.write(`${JSON.stringify(resp)}\n`);
}
```

Actually the stdio loop *does* `await handleRequest` before processing the next line. So single-request-per-line stdin is **effectively serialized at the transport layer** — a client that sends one request, waits for the response, then sends the next, will see serial execution.

However:

1. **Batch requests run in parallel.** `handleBatch()` at `src/mcp/server.ts:2133-2158` uses `Promise.all(tasks)` where each task is `this.handleRequest(r)`. A client that sends `[req1, req2, req3]` as a single JSON-RPC batch gets all three handlers running concurrently.
2. **Streamable HTTP transport is unaffected.** If a future HTTP transport is added (per MCP spec 2025-11-25), multiple HTTP requests would invoke `handleRequest` concurrently with no mutex.
3. **A fast client can still pipeline.** The stdio loop buffers incoming data. If two newline-delimited requests arrive in the same chunk, the second starts the moment the first completes — but nothing prevents a misbehaving client from interleaving with a stdio pipe that flushes partial writes across request boundaries (the buffered decoder at `src/mcp/server.ts:2449` handles partial reads, not partial writes).

**Conclusion:** serialization is an accidental property of the stdio loop and the "one request at a time" convention most clients follow. Neither the code nor the tests enforce it.

### Locking

There is **no mutex, semaphore, or request queue** anywhere in `src/mcp/`, `src/core/`, or `src/adapters/`. `rg -i "mutex|semaphore|lock|serialize" src/` returns no primitives, only unrelated word matches (e.g. "alwaysAllow" in adapter code, "lock" in gitignore comments).

---

## Shared state inventory

For each of the 33 tools, the state it touches and whether access is guarded:

| Tool | Tier | Config TOML (RMW) | `~/.claude.json` / adapter files | Wiki MD + index | Git repo | Other | Guarded? |
|---|---|---|---|---|---|---|---|
| `am_list_servers` | RO | read | — | — | — | — | n/a (read) |
| `am_list_profiles` | RO | read + `.agent-manager/state.toml` read | — | — | — | — | n/a |
| `am_status` | RO | read | read (via adapter.diff) | — | read | — | n/a |
| `am_config_show` | RO | read | — | — | — | — | n/a |
| `am_doctor` | RO | read | read (detect) | — | read (status) | reads key path | n/a |
| `am_session_list` | RO | — | — | — | — | reads adapter session dirs | n/a |
| `am_session_export` | RO | — | — | — | — | reads one session file | n/a |
| `am_session_search` | RO | — | — | — | — | reads all session files | n/a |
| `am_add_server` | WL | **RMW** | — | — | **commit** | — | **no** |
| `am_remove_server` | WL | **RMW** | — | — | **commit** | — | **no** |
| `am_server_update` | WL | **RMW** | — | — | **commit** | — | **no** |
| `am_undo` | WL | — (tree-restore) | — | — | **revert HEAD** | — | **no** |
| `am_use_profile` | WL | read + **`.agent-manager/state.toml` RMW** | — | — | — | — | **no** (atomic write, but no mutex) |
| `am_import` | WL | **RMW** (multi-adapter merge) | read (via adapter.import) | — | **commit** | — | **no** |
| `am_apply` | WL | read | **RMW across up to 13 adapter files** incl. `~/.claude.json`, `.mcp.json`, `.cursor/mcp.json`, etc. Uses `atomicWriteFileSync` per file. | — | — | **decrypts via `loadKey()` each call** | **no mutex** — atomic write prevents torn bytes but NOT torn merges |
| `am_sync_push` | WR | — | — | — | **push** | network | **no** |
| `am_sync_pull` | WR | — (but pull can mutate) | — | — | **pull → fast-forward** | network | **no** |
| `am_registry_search` | RO | — | — | — | — | HTTP fetch | n/a |
| `am_registry_install` | WL | **RMW** | — | — | **commit** | HTTP fetch | **no** |
| `am_registry_list_installed` | RO | read | — | — | — | — | n/a |
| `am_agent_discover` | RO | — | — | — | — | HTTP fetch | n/a |
| `am_agent_list` | RO | — (reads agents.toml) | — | — | — | — | n/a |
| `am_agent_delegate` | WR | — | — | — | — | HTTP POST | n/a (stateless) |
| `am_agent_task_status` | RO | — | — | — | — | HTTP GET | n/a |
| `am_wiki_search` | RO | — | — | read (MiniSearch) | — | — | n/a |
| `am_wiki_add` | WL | — | — | **RMW page + index** (rebuilds MiniSearch) | — | — | **no** |
| `am_wiki_synthesize` | RO | — | — | read | — | — | n/a |
| `am_wiki_briefing` | RO | — | — | read | — | — | n/a |
| `am_wiki_harvest` | WL | — | — | **RMW many pages + index** | — | — | **no** — worst offender, long loop |
| `am_run_agent` | WR | read | — | — | — | spawns subprocess, ACP client | per-call client, but shared cwd |
| `am_acp_list_agents` | RO | read + `agents.toml` read | — | — | — | — | n/a |
| `am_acp_session_list` | RO | — | — | — | — | reads session dir | n/a |
| `am_acp_session_cancel` | WR | — | — | — | — | **`rm -rf` session dir** | path-traversal guarded, **not race guarded** |

Legend: RO = read-only tier, WL = write-local, WR = write-remote, RMW = read-modify-write.

### What "RMW" means concretely

**`am_add_server`** (`src/mcp/server.ts:993-1023`) is the canonical RMW:

```ts
const config = await readConfig(configPath);        // READ
...
config.servers[name] = { ... };                      // MODIFY
await writeConfig(configPath, config);               // WRITE (atomic per write, not per RMW)
await commitAll(configDir, `add server: ${name}`);   // COMMIT
```

Two concurrent `am_add_server` calls with names `A` and `B` interleave like this in the bad case:

1. Call A: read → `config = {}`
2. Call B: read → `config = {}`
3. Call A: write → `{ servers: { A: ... } }`
4. Call B: write → `{ servers: { B: ... } }` ← **A is lost**
5. Call A: commit → OK
6. Call B: commit → OK (but the commit has only B)

`atomicWriteFile` (`src/core/atomic-write.ts:158-187`) guarantees no torn bytes but does nothing about torn merges. The last writer wins and the first writer's server silently vanishes.

### `am_apply` — the multi-file hazard

`am_apply`'s handler (`src/mcp/server.ts:1432-1479`) iterates adapters **sequentially within one call** (`for (const adapter of adapters)`), and each adapter writes its own set of files via `atomicWriteFileSync`. Within a single call this is fine.

**Between two concurrent calls**, the hazard is the `~/.claude.json` merge in `generateClaudeJson()` (`src/adapters/claude-code/export.ts:107-147`):

```ts
const text = fs.readFileSync(existingPath, "utf-8");   // READ existing
existing = JSON.parse(text);
...
const output = { ...existing, mcpServers };            // MERGE
return `${JSON.stringify(output, null, 2)}\n`;         // caller will write
```

The read-merge-write spans a `Promise` boundary (the inner `adapter.export` is async). If two apply calls race, one call reads `~/.claude.json` at time T1, the other reads it at T2 (before T1 writes), both merge against an outdated baseline, and the second writer clobbers the first's mcpServers. This is the exact failure mode that the user flagged in reference `reference_agent_manager.md` ("2026-04-15 config wipe incident, Issue #1").

### Git repo contention

All three `commitAll` sites (`am_add_server`, `am_remove_server`, `am_server_update`, `am_registry_install`, `am_import`) stage and commit in the same repo. `isomorphic-git`'s `statusMatrix` + `add` + `commit` sequence (`src/core/git.ts:44-66`) is not reentrant-safe: two concurrent `commitAll`s will interleave their `statusMatrix` reads, both stage, and both commit — possibly with the second commit including files the first was trying to revert. `am_undo` (`src/mcp/server.ts:1128-1145`) concurrently with any committer is worst: `revertHead` (`src/core/git.ts`) reads HEAD, rebuilds tree from parent, and commits — a concurrent `commitAll` in between the read and the commit creates a lost update.

### Secrets — no cache to corrupt, but expensive

`loadKey()` (`src/core/secrets.ts:141-168`) **does not cache** the imported `CryptoKey`. Every `am_apply` call re-reads the key file and re-imports. Two concurrent `am_apply`s do two imports, which is safe (`crypto.subtle.importKey` is pure) but wasteful. No race on the key material itself.

`migrateLegacyKey()` (`src/core/secrets.ts:86-109`) is called from every `loadKey()`. Two concurrent `loadKey()` racing the migration could both try to `unlink` the legacy file — one wins, the other gets ENOENT, which is swallowed. Safe by accident.

---

## Hazard analysis — what CANNOT safely run in parallel

### Critical hazards (data loss)

1. **Two `am_add_server` / `am_remove_server` / `am_server_update` / `am_registry_install` / `am_import` calls racing.** Classic TOML lost-update. One server disappears. Code: `src/mcp/server.ts:993-1251`. No mutex.

2. **Two `am_apply` calls racing.** Each reads `~/.claude.json` (and 12 other adapter files), merges, writes. The second writer overwrites the first's mcpServers with a merge based on stale data. This is the **already-observed incident** (user reference: `~/.claude.json` config wipe, 2026-04-15). Atomic writes do not help here — the tear is in the merge, not in the bytes. Code: `src/adapters/claude-code/export.ts:107-147`.

3. **`am_wiki_harvest` concurrent with itself or with `am_wiki_add`.** Each call loops `addEntry` → `writePage` → `updateSearchIndex` → `rebuildSearchIndex` when the index is missing. Two loops racing will both `loadSearchIndex` → `vacuum` → `add` → `saveSearchIndex`, clobbering each other's additions. Also the fallback rebuild in `loadSearchIndex` (`src/wiki/storage.ts:492-510`) runs unconditionally on parse failure — two concurrent rebuilds duplicate work and race on `saveSearchIndex`. Code: `src/wiki/storage.ts:484-537`.

4. **Any writer racing `am_undo`.** `revertHead` reads HEAD message, reconstructs parent tree, commits. If `commitAll` from another tool lands between those steps, the revert can undo the wrong commit or leave the working tree inconsistent. Code: `src/core/git.ts` (revertHead region).

5. **`am_use_profile` racing `am_apply`.** `am_apply` reads the active profile via `readActiveProfile` at call start. If `am_use_profile` flips the pointer mid-apply, adapters that queried the resolved config early will use the old profile while adapters that run later use the new profile — an incoherent cross-adapter state.

6. **`am_sync_pull` racing any writer.** A fast-forward that advances HEAD while another tool is staging produces a merge conflict or a partial commit. No mutex between sync and write tools.

### Moderate hazards (inefficiency, user confusion)

7. **`am_acp_session_cancel` racing `am_run_agent`.** If the agent creates the session directory while cancel is recursively `rm`-ing, one process sees ENOENT mid-tree. The traversal guard (`resolveSessionPathSafely`) prevents escaping the session dir but does not serialize cancel vs. create.

8. **Two `am_agent_delegate` calls to the same agent.** A2A task IDs are generated with `Date.now()` + 6 random hex chars (`src/mcp/server.ts:1602`) — collision probability is low but non-zero across concurrent calls within the same millisecond. Not a corruption risk, but a task-tracking mix-up risk.

### Safe-in-parallel tools

The 10 read-only tools (`am_list_servers`, `am_list_profiles`, `am_status`, `am_config_show`, `am_doctor`, `am_session_list`, `am_session_export`, `am_session_search`, `am_registry_search`, `am_wiki_search`, `am_wiki_synthesize`, `am_wiki_briefing`, `am_registry_list_installed`, `am_acp_list_agents`, `am_acp_session_list`, `am_agent_list`, `am_agent_discover`, `am_agent_task_status`) are safe to parallelize with each other and with themselves. They do not mutate disk.

Caveat: a reader can observe intermediate state from a concurrent writer (e.g. `am_status` reading `config.toml` mid-`writeConfig` — fine because `atomicWriteFile` is atomic, the reader sees either the old or new file, never a half-written one).

---

## Batch request handling

**Batches run fully in parallel.** `handleBatch` (`src/mcp/server.ts:2133-2158`):

```ts
async handleBatch(reqs: JsonRpcRequest[]): Promise<(JsonRpcResponse | null)[]> {
  const seenIds = new Set<string | number>();
  const tasks: Promise<JsonRpcResponse | null>[] = [];
  for (const r of reqs) {
    ...
    tasks.push(this.handleRequest(r));      // no await
  }
  return Promise.all(tasks);                  // all in flight concurrently
}
```

Duplicate-id detection is synchronous (tasks array gets a pre-resolved error response for dupes), but the non-duplicates fire simultaneously. **Each handler must be reentrant — and today they are not.** A client that sends a batch like `[am_add_server A, am_add_server B, am_apply]` gets all three handlers racing on the config TOML and on `~/.claude.json`.

The code does not document this assumption. There is no comment in `handleBatch` warning that handlers are non-reentrant, and there is no test that stresses it.

**Spec reference:** MCP 2025-11-25 inherits JSON-RPC 2.0 batch semantics (https://www.jsonrpc.org/specification#batch). The spec says a server MAY process batch elements concurrently and MUST return all responses in a single array; it does not mandate parallel execution. The reference TypeScript SDK (`@modelcontextprotocol/sdk`) processes batches sequentially in its default stdio transport — our server is more aggressive than the reference.

---

## Test coverage for concurrency

**None.** `test/mcp/` contains 7 test files (auth-gate, error-redaction, protocol-conformance, server, session-cancel-traversal, timing-safe-compare, zod-validation). A full-text search for `concurrent|parallel|Promise\.all.*handle|race|simultaneous` in `test/` produces no match that exercises handler concurrency.

The closest test is `protocol-conformance.test.ts:282-324` which exercises `handleBatch` for duplicate-id detection but uses only `initialize` and `ping` — both no-ops for shared state.

**What is missing:**

- No test sends two `am_add_server` calls concurrently and asserts both land in `config.toml`.
- No test stresses `am_apply` against itself, or `am_apply` vs. `am_use_profile`.
- No test exercises `am_wiki_add` × N in parallel.
- No test exercises `am_wiki_harvest` concurrently with `am_wiki_add`.
- No test verifies `commitAll` reentrance or `am_undo` vs. writer races.

---

## Recommendations

### 1. Add a per-server async mutex (small, cheap, correct)

Introduce one `AsyncMutex` in `McpServer` and classify tools:

```ts
// src/mcp/server.ts
class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(() => {}, () => {});
    return next;
  }
}

private writeLock = new AsyncMutex();
```

In `tools/call` (`src/mcp/server.ts:2323`), wrap the handler dispatch:

```ts
const runHandler = () => tool.handler(toolArgs);
const result = tool.tier === "read-only"
  ? await runHandler()
  : await this.writeLock.run(runHandler);
```

This serializes every non-read-only tool behind one lock — simple, correct, and slower only when two writes collide (which should be rare). Read-only tools remain fully parallel, which matches their safety profile.

### 2. Classify tools explicitly (make the contract visible)

Add a fourth field to `ToolEntry`:

```ts
type Concurrency = "parallel-safe" | "exclusive" | "config-writer" | "wiki-writer" | "git-writer";
```

and route each to its own lock:

- `config-writer`: `am_add_server`, `am_remove_server`, `am_server_update`, `am_registry_install`, `am_import`, `am_use_profile`, `am_apply`, `am_undo`, `am_sync_pull`
- `wiki-writer`: `am_wiki_add`, `am_wiki_harvest`
- `git-writer`: `am_sync_push`, `am_undo` (also a git writer)
- `exclusive`: anything that touches multiple categories (e.g. `am_apply` reads config AND writes adapter files)
- `parallel-safe`: all read-only tools, `am_agent_delegate`, `am_agent_task_status`

Separate locks let `am_wiki_add` and `am_add_server` run in parallel (they don't share state) while still serializing within each category.

### 3. Tighten `handleBatch` — or document that handlers are reentrant

Option A (minimum): add a comment in `handleBatch` noting that handlers may race and the caller must either ensure handlers are reentrant or wrap them in a lock. Today neither is true.

Option B (preferred): process batch elements **sequentially** unless a profiling flag says otherwise. The MCP reference SDK does this. It removes an entire class of hazards for the cost of latency on a rarely-used batch feature.

```ts
async handleBatch(reqs: JsonRpcRequest[]): Promise<(JsonRpcResponse | null)[]> {
  const responses: (JsonRpcResponse | null)[] = [];
  for (const r of reqs) {
    responses.push(await this.handleRequest(r));
  }
  return responses;
}
```

### 4. Cache the `CryptoKey` behind the write lock

Today every `am_apply` re-reads and re-imports the AES key. After introducing a mutex, cache the imported key in `McpServer` and invalidate on `am_secret_*` calls. Saves one disk read and one WebCrypto import per apply.

### 5. Add concurrency tests

Five small tests cover the critical paths:

1. `handleBatch([am_add_server A, am_add_server B])` → assert both `A` and `B` exist in `config.toml` after.
2. `Promise.all([handleRequest(am_add_server C), handleRequest(am_add_server D)])` via direct API (no batch) → assert both exist.
3. `Promise.all([am_apply, am_apply])` → assert `~/.claude.json` contains a full mcpServers map, not a partial one.
4. `Promise.all([am_wiki_add × 10])` → assert 10 pages on disk and 10 entries in the MiniSearch index.
5. `Promise.all([am_sync_pull, am_add_server])` → assert no "index locked" or "partial commit" errors (or, if serialized, assert ordered success).

All five fit in a single `test/mcp/concurrency.test.ts` under 200 lines.

### 6. Compare to reference implementation

Per the MCP TypeScript SDK (https://github.com/modelcontextprotocol/typescript-sdk), the reference server processes requests sequentially on stdio and does not run batch elements in parallel. Our server is more aggressive on batches — an intentional choice would deserve a comment; an accidental one deserves a fix.

---

## Citations

- `src/mcp/server.ts:2133-2158` — `handleBatch` parallel dispatch
- `src/mcp/server.ts:2161-2430` — `handleRequest` (no locking)
- `src/mcp/server.ts:2432-2495` — stdio `serve` loop (serializes per-line, not per-batch)
- `src/mcp/server.ts:993-1023` — `am_add_server` RMW
- `src/mcp/server.ts:1432-1479` — `am_apply` iterates adapters sequentially within one call
- `src/adapters/claude-code/export.ts:107-147` — `generateClaudeJson` read-merge-write on `~/.claude.json`
- `src/core/atomic-write.ts:98-187` — atomic per-write, not per-RMW
- `src/core/secrets.ts:141-168` — `loadKey` has no cache
- `src/core/git.ts:44-66` — `commitAll` non-reentrant
- `src/wiki/storage.ts:484-537` — `loadSearchIndex` + `updateSearchIndex` non-atomic against concurrent writers
- `test/mcp/protocol-conformance.test.ts:282-324` — only concurrency-adjacent test (batch id dedup, no state mutation)
