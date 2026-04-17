# Adapter Subsystem Deep Audit

**Facet:** Adapter subsystem quality & parity (coverage, feature parity, error handling, community proxy security).
**Scope:** `src/adapters/**`, plus `src/commands/adapter.ts` for community install flow.
**Method:** Read of `types.ts`, `registry.ts`, 3 canonical adapters (claude-code, cursor, codex-cli) deep, spot checks of the other 10 + community proxy/loader/install.

---

## Summary

The adapter surface is clean and the interface (`types.ts`) is well-factored. The 13 built-ins cluster into two shapes: JSON-based (`claude-code`, `cursor`, `amazon-q`, `cline`, `copilot`, `gemini-cli`, `kiro`, `kilo-code`, `roo-code`, `windsurf`, `forgecode`, `continue`) and TOML-based (`codex-cli`). Shared utilities (`adapters/shared/utils.ts`, `adapters/shared/diff-utils.ts`) have been extracted but three adapters (claude-code, cursor, windsurf) still hold private copies of `fileExistsSync`, which is the canary for broader duplication.

Parity is high on the happy path: every adapter reads native configs, filters with a `CORE_FIELDS` set, pushes unknown fields to `adapterExtras`, and warns on missing/malformed files (with a notable cline silent-miss exception). Parity is low on edge cases: **no adapter writes atomically**, every adapter calls `fs.writeFileSync` directly, so a crash or Ctrl-C during export leaves a half-written `~/.claude.json`, `~/.codex/config.toml`, or `mcp.json` on disk. For `claude-code` this is particularly dangerous because `generateClaudeJson` re-reads the existing file to preserve `numStartups` and other Anthropic-owned fields; a torn write will wipe state that is not managed by am.

The community adapter proxy handles the JSON-RPC 2.0 framing correctly (newline-delimited, buffered reassembly, id-based dispatch with a 30 s per-call timeout) but **leaks subprocesses in three ways**: stderr is piped and never drained (can fill the OS pipe buffer and wedge a chatty adapter), `killAllProxies()` is defined in the loader but never wired to `process.on("exit"|"SIGINT"|"SIGTERM")` from any entry point, and dead subprocesses are evicted only on the next `loadCommunityAdapters` call, not when the read loop detects EOF.

Community install (`src/commands/adapter.ts:81-214`) has **two exploitable vectors**: (1) `resolveSource()` accepts any string starting with `git+`, `https://`, `git://` or ending in `.git` and hands it to `git clone` without validation; `https://evil.com/x.git --upload-pack=… --help` style URLs can reach git (less severe since `installCmd` is an array passed to `Bun.spawn` — no shell — but arg injection via `--upload-pack` or protocol-alternate-refs is still possible against git itself), and (2) `local:` sources with a path like `../../../etc/passwd` are resolved to absolute with no containment check and the resulting absolute path is stored as `command` in `adapters.toml`, meaning a later `am adapter verify` or `am apply` will spawn any executable on disk chosen by the source. There is no install-time checksum capture (loader supports it, install does not write one).

Registry design is correct: built-ins always shadow community, which matches the documented policy but surfaces nowhere to the user — `am adapter list` labels the source as "built-in" vs "community" but silently drops shadowed community entries from `listAllAdapters()` (`registry.ts:89`) with no warning.

**Parity score: 7/10** — high structural parity, low edge-case parity, no atomic writes.

---

## Parity Matrix

Behavior across all 13 built-ins plus community proxy.

| Adapter | Missing dir/file warning | Atomic write | Tilde expansion via `homedir()` | Empty import returns `[]` | Malformed JSON/TOML warning format | Diff covers instructions? |
|---|---|---|---|---|---|---|
| claude-code | yes (global + project both warn) | no (`writeFileSync`) | yes | yes | `Malformed JSON: ${path}` | yes (CLAUDE.md managed block) |
| cursor | yes | no | yes | yes | `Malformed JSON: ${path}` | yes (per-file .mdc) |
| codex-cli | yes | no | yes | yes | `Malformed TOML: ${path}` | **no** (servers only) |
| amazon-q | yes (global only, silent on project miss) | no | yes | yes | `Malformed JSON: ${path}` | no |
| cline | **silent null on missing settings** | no | yes | yes | `Malformed JSON: ${path}` | no |
| copilot | yes | no | yes | yes | `Malformed JSON: ${path}` | no |
| continue | conditional (`warnIfMissing=true` for global) | no | yes | yes | `Malformed JSON: ${path}` | no |
| forgecode | yes | no | yes | yes | `Malformed JSON: ${path}` | no |
| gemini-cli | yes | no | yes | yes | `Malformed JSON: ${path}` | no |
| kilo-code | yes | no | yes | yes | `Malformed JSON: ${path}` | partial |
| kiro | **warns via "File not found" in catch** (any read error becomes missing) | no | yes | yes | `Malformed JSON: ${path}` | no |
| roo-code | yes | no | yes | yes | `Malformed JSON: ${path}` | no |
| windsurf | yes | no | yes | yes | `Malformed JSON: ${path}` | no |
| community | remote — depends on adapter implementation | no (pass-through) | yes (relies on loader) | yes | JSON-RPC error propagated | adapter-defined |

Secondary fields:

| Adapter | Supports HTTP servers? | URL detection | Scope partition key |
|---|---|---|---|
| claude-code | via `adapterExtras` only | no dedicated field | `adapters["claude-code"].scope` |
| cursor | yes (`url`, transport=`streamable-http`) | `entry.url` | `adapters.cursor.scope` |
| codex-cli | yes | `entry.url` | `adapters["codex-cli"].scope` |
| kiro | yes | `entry.url` | `adapters.kiro.scope` |
| forgecode | yes (transport=`sse` always) | `entry.url` → always `sse`, never `streamable-http` | project-only |
| others | stdio only in practice | n/a | project/global via file location |

Forgecode hard-codes `transport: "sse"` for any URL (`forgecode/import.ts:126`) — this is a parity bug since newer SSE-variant MCP servers are actually streamable-http; cursor and codex-cli get this right.

---

## Gaps & Issues

Severity legend: **CRITICAL** = data loss or security, **HIGH** = common-path breakage, **MEDIUM** = parity/UX, **LOW** = cleanliness.

### CRITICAL

1. **No atomic writes anywhere in export paths.**
   Every adapter's export follows this pattern (13 copies):
   ```
   src/adapters/claude-code/export.ts:91-94
   src/adapters/codex-cli/export.ts:83-85
   src/adapters/cursor/export.ts:77-79
   src/adapters/gemini-cli/export.ts:92-94
   (+ 9 more — grep writeFileSync in adapters/)
   ```
   A SIGTERM or power loss between `mkdirSync` and the next `writeFileSync` call produces torn writes. For `claude-code`, `generateClaudeJson()` merges `existing` into `output` (export.ts:144) — if the read succeeded but the write was interrupted, `~/.claude.json` ends up partially overwritten with loss of non-MCP fields such as `numStartups`, `userID`, `hasCompletedOnboarding`. There is no `.tmp` + `rename` pattern. Fix: extract `writeFileAtomic(path, content)` into `shared/utils.ts` and route all 13 adapters through it.

2. **Community adapter install does not sanitize git URL or local path.** `src/commands/adapter.ts:436-479` (`resolveSource`).
   - `git` branch: accepts `git+ssh://anywhere/x.git`, `https://github.com/foo/bar.git;rm -rf /`. `Bun.spawn` with array args avoids shell interpolation, but the URL is still passed to `git` which itself supports arg-like URL components; more importantly the `repoName` derivation is `url.split("/").pop()?.replace(/\.git$/, "")`, so an attacker can choose the adapter name by naming their repo `claude-code.git` and then invoking with `--force` to shadow the built-in.
   - `local:` branch (`adapter.ts:133-137`): `resolve(source.replace(/^local:/, ""))` — absolute or `../` paths are accepted without containment; the resolved absolute path is stored as the `command` in `adapters.toml` and invoked on every `am apply`. An attacker with write access to `adapters.toml` (or who convinces a user to `am adapter install local:/tmp/.hidden/malware`) can register `/usr/bin/curl` (or anything) as a "community adapter". This then runs under `Bun.spawn` on every `am` invocation.

3. **Community adapter install never captures a checksum.**
   `installSubcommand` writes a `CommunityAdapterConfig` with `source`, `command`, `installed_at` (`adapter.ts:190-194`) but omits the optional `checksum` field. `loader.ts:32-35` then treats every install as "no checksum" and warns-continues. The loader has all the crypto code; the install path needs to compute and persist it.

### HIGH

4. **Community subprocess lifecycle leaks.** `src/adapters/community/proxy.ts`.
   - **Stderr piped, never drained** (line 64). A community adapter that prints a lot to stderr (e.g., during init) fills the OS pipe buffer (typically 64 KB on macOS/Linux) and stalls. `readLoop()` only reads stdout.
   - **No SIGINT/SIGTERM handler.** `killAllProxies()` (loader.ts:173) is exported but grep shows zero callers. If `am` is interrupted, child processes become orphaned zombies until the parent shell GCs them.
   - **Dead-proxy detection is lazy.** `readLoop`'s catch rejects pending requests (proxy.ts:84-88) but does not set `this.process = null`, so `isAlive()` (line 196) still reports true until the cache is next consulted. `loadCommunityAdapters` does an `isAlive` check (loader.ts:102) but the proxy may have already been handed out of the module-level `adapterCache` in `registry.ts:76`, which is a *second* cache with no liveness check at all.
   - **No max concurrent proxies.** `loadCommunityAdapters` spawns one subprocess per enabled entry unconditionally.

5. **cline import silently returns null when MCP settings missing.**
   `src/adapters/cline/import.ts:52-60`:
   ```ts
   try { fs.accessSync(settingsPath); }
   catch { return null; }   // <-- no warning pushed
   ```
   Every other adapter pushes `File not found: <path>` to `warnings` in this case; cline does not, which makes "I imported cline and got 0 servers" undebuggable.

6. **kiro misreports "File not found" on permission errors.**
   `src/adapters/kiro/import.ts:98-103`: the `fs.readFileSync` is wrapped in a single catch that always emits `File not found: ${filePath}`. A permission error or stale NFS handle produces the same warning as a missing file. Every other adapter distinguishes "missing" (via `fileExistsSync`) from "cannot read" (via a second catch around `readFileSync`).

7. **Forgecode hard-codes `transport: "sse"` for any URL-based server.**
   `src/adapters/forgecode/import.ts:126`. Should detect streamable-http vs sse the way codex-cli does.

8. **`diff()` coverage is uneven across adapters.** Only `claude-code` and `cursor` diff instructions; the other 11 only diff servers. `compareInstructions` in `shared/diff-utils.ts` is ready to be reused everywhere. This means `am status` silently underreports drift on 11 of 13 tools.

9. **Two file-access error classifications.** `claude-code/import.ts:92-102` distinguishes "not found" from "cannot read" via `fileExistsSync` + a second try/catch. `codex-cli/import.ts:105-119` collapses both into the same "File not found" warning. Users can't tell whether the file is missing or un-readable.

### MEDIUM

10. **Duplicated `fileExistsSync` implementations.** `shared/utils.ts:114` has the canonical one. Three adapters reimplement it locally:
    - `claude-code/import.ts:224-232`
    - `cursor/import.ts:285-293`
    - `windsurf/import.ts:324` (per earlier grep)
    These should import from `shared/utils.ts`. There is no functional difference, but drift risk is real (`readAgentsMd` vs `readClaudeMd` logic).

11. **Duplicated TOML parsing.** `codex-cli/import.ts:11`, `codex-cli/export.ts:10`, `codex-cli/diff.ts:10`, `community/loader.ts:11` each import `@iarna/toml` directly. `src/lib/toml.ts` (used for stringify) is the natural place to centralize parsing too.

12. **Duplicated server-partition code.** Every export runs this pattern (6 copies verified):
    ```ts
    for (const [name, server] of Object.entries(config.servers)) {
      if (!server.enabled) continue;
      const adapter = server.adapters?.[<NAME>] ?? {};
      if (adapter.scope === "project") projectServers[name] = server;
      else globalServers[name] = server;
    }
    ```
    Should be `partitionServersByScope(config, adapterName): { global, project }` in `shared/utils.ts`.

13. **Duplicated "read native servers" readers.** Every `diff.ts` has a local `readNativeServers(filePath): Record<string, NativeServer> | null` that does `readJsonFile(filePath)` + `.mcpServers ?? {}`. Centralize as `readNativeMcpServers(path: string, key: string)`.

14. **Registry double-cache.** `registry.ts:76` holds `adapterCache`; `community/loader.ts:20` holds `proxyCache`. Both store the same proxy. Invalidation in one does not invalidate the other. `removeCommunityAdapterConfig` (loader.ts:163-167) clears `proxyCache` but leaves `registry.adapterCache` stale — the next `getAdapter("name")` call returns a dead proxy for that process's lifetime.

15. **Registry shadowing is silent.** `listAllAdapters()` filters out shadowed community adapters with no user-visible warning (`registry.ts:89`). Users who install `am-adapter-claude-code` from npm will see it disappear from the list. `am adapter list` should show shadowed entries with a "(shadowed)" marker.

16. **`force` install does not bypass shadowing.** `adapter.ts:107-114`: `--force` lets you install a name that conflicts with a built-in, but the registry still won't expose it — you've installed a ghost. The CLI message says "built-in adapters always take precedence" but `--force` is offered anyway, which is misleading.

17. **No version compatibility check.** `AdapterManifest.minAmVersion` exists in `community/types.ts:24` but is never consulted during `initialize()` or install. An am 0.5 adapter spawned by am 0.2 will half-work.

### LOW

18. **JSON-RPC framing assumes no embedded newlines.** `processBuffer` (proxy.ts:93-119) splits on `\n`. Adapters that print a debug line containing `\n` inside a JSON string will desync — acceptable because JSON.stringify escapes newlines, but adapters that emit pretty-printed JSON violate the contract silently.

19. **`CommunityAdapterProxy.call` has no cancellation from the caller side.** The 30 s timeout fires but there's no `AbortSignal` integration — `am apply --timeout=5s` can't shorten it.

20. **Unused locals.** `adapter.ts:140-141` computes `pkgName` and `installArg` for the npm branch and uses neither (`installCmd` was pre-computed in `resolveSource`).

21. **`warnings` arg threaded but unused in some paths.** `codex-cli/export.ts:159` `generateAgentsMd(..., _warnings)` — the underscore tells the story; if warnings can't arise, drop the arg.

22. **`extractPackageId` lives in `claude-code/identity.ts` but is imported by cursor, amazon-q, continue, windsurf, copilot, forgecode.** This should live under `shared/` since it is now adapter-agnostic. Cross-adapter import breaks the rule that adapters should not depend on each other's internals.

---

## Community Adapter Security findings

1. **URL injection into `git clone` is partially mitigated by `Bun.spawn` array args (no shell).** The remaining exposure is:
   - Attacker-chosen adapter name (repo-basename becomes adapter name, stored in adapters.toml → `getAdapter()` lookup). Combined with `--force`, this can shadow built-ins in the user's TOML even if the registry rejects the shadow.
   - Protocol-level surprises (`git+file://`, `git+ext::...`) are not filtered — users installing a `git+file:///Users/victim/.ssh/` "repo" could be tricked into content enumeration via git error messages. Low probability, worth a whitelist.
   - Suggested fix: whitelist schemes (`https`, `git+https`, `ssh`, `git+ssh`) and validate the URL parses via `new URL()`.

2. **`local:` source has no containment.** `adapter.ts:136`:
   ```ts
   command = resolve(source.replace(/^local:/, ""));
   ```
   Any absolute path is accepted. Recommendation: require `local:` paths to be inside the project or inside `~/.local/share/am-adapters/` (a dedicated trust root). Minimally, refuse paths outside `$HOME`.

3. **No post-install integrity lockdown.** `adapter install` does not compute a checksum; `adapter update` does not refresh one. An attacker who can write to `~/.config/agent-manager/adapters/<name>/` (e.g., via a symlink attack on `node_modules/.bin/`) can swap the binary and subsequent `am apply` will run it with user privileges. The checksum code in `loader.ts:26-64` is ready; install just needs to `createHash('sha256').update(binary).digest('hex')` after validation and persist it as `checksum: "sha256:..."`.

4. **No sandboxing of the spawned process.** Community adapters run with the full permissions of the am user, including filesystem read/write, network, and access to the user's secrets resolver output. This is inherent to the "adapters as subprocesses" design but should be documented in the ADR — there is no expectation of isolation.

5. **Stderr is piped and never read.** As above, a hostile adapter can force the parent to block on spawn indefinitely by writing >64 KB to stderr and never reading stdin. Combined with no timeout on `CommunityAdapterProxy.create` (only per-call timeouts after the initialize handshake), this blocks `am apply` forever.

6. **No signature or publisher check.** The "source" field stores where the adapter came from but am does not verify any signed manifest. If an adapter is installed via npm, npm's provenance attestations are not consulted.

7. **Subprocess survives am crash.** No `process.on("exit", killAllProxies)` handler is registered. Orphaned child processes continue running until they exit on their own (typical adapters exit when stdin closes, but nothing requires this).

**Verdict: Community adapters work but are trust-the-bundle; there is no defense-in-depth. Ship with a SECURITY.md caveat and a default-deny posture (disable community adapters unless `am adapter install --allow-untrusted` is passed).**

---

## Recommendations

**Priority 1 (fix before v1):**

- Atomic writes in a `writeFileAtomic` helper, used by all 13 adapter exports. Pattern: write to `${path}.am.tmp`, fsync, rename.
- `registerCleanupHandler(killAllProxies)` on startup so SIGINT/SIGTERM/exit kill community subprocesses.
- Drain stderr in `CommunityAdapterProxy.spawn` — read and discard (or log to debug).
- Capture and persist sha256 checksum during `am adapter install`.
- Reject `local:` paths outside `$HOME`; whitelist git URL schemes.
- Add an initialization timeout to `CommunityAdapterProxy.create` (currently unbounded if the adapter hangs before responding to `initialize`).

**Priority 2 (post-v1 polish):**

- Factor the repeated `partitionServersByScope`, `readNativeMcpServers`, and `fileExistsSync` duplicates into `shared/utils.ts`.
- Extend `diff()` to cover instructions for all 11 adapters that currently only diff servers (diff-utils.ts:compareInstructions is ready).
- Fix cline silent-miss and kiro misclassified-error warnings.
- Fix forgecode hard-coded SSE transport.
- Surface shadowed community adapters in `am adapter list` with a marker.
- Unify the two adapter caches (`registry.adapterCache` + `community/loader.proxyCache`) or document why they must be separate.
- Move `extractPackageId` out of `claude-code/identity.ts` into `shared/`.

**Priority 3 (design questions):**

- Does built-in-always-wins match user intent? Consider a per-user override file that lets a community adapter win by name, with the built-in accessible via `<name>@builtin`.
- Add `AdapterManifest.minAmVersion` check on proxy initialize; fail fast with a clear message.
- Consider sandboxing via `Deno.permissions` analog (Bun has none natively), or at minimum document the trust boundary in CLAUDE.md.

---

## Citations

All file:line citations above are against the tree at `/Users/baladita/Documents/DevBox/agent-manager` as of 2026-04-16. Key files reviewed end-to-end:

- `src/adapters/types.ts` (219 lines, Adapter interface)
- `src/adapters/registry.ts` (137 lines, factory dispatch)
- `src/adapters/claude-code/{index,import,export,diff}.ts`
- `src/adapters/cursor/{index,import,export,diff}.ts`
- `src/adapters/codex-cli/{index,import,export,diff}.ts`
- `src/adapters/community/{proxy,loader,types}.ts`
- `src/adapters/shared/{utils,diff-utils}.ts`
- `src/commands/adapter.ts` (486 lines, community install/remove/update/verify)
- Spot checks: `amazon-q/import.ts`, `cline/import.ts`, `forgecode/import.ts`, `kiro/import.ts`, `continue/import.ts`, `windsurf/import.ts`, `amazon-q/diff.ts`, `forgecode/diff.ts`.
