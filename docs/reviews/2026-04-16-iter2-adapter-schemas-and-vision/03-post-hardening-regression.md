---
title: Post-hardening regression audit — 8 hardening commits on main
date: 2026-04-16
audit_targets:
  - 3ca72fa feat(safety)  atomic writes
  - eddf12b fix(protocols) ACP subprocess/bridge/SSE
  - 69f4027 feat(security) move master key out of git dir
  - 14280e8 fix(adapters)  checksum + --ignore-scripts + name regex
  - c58c2bf fix(mcp)       zod / redactor / bearer / traversal
  - 892fd5b feat(marketplace) URL/SHA/TOFU/traversal
  - 0fdbcf3 chore(tidy)    ACP registry collapse, AM_VERSION, ADRs, docs
tests_passing: 2202/2202
auditor_stance: "every feature ships with its hardening deferred one step behind"
---

## Summary

The 8 hardening commits plug the concrete holes the prior multi-agent audit
flagged (Theme A-H in `docs/reviews/2026-04-16-multi-agent-deep-analysis/`).
All 2202 tests pass. That said — and in the spirit of the user's brief —
**the hardening itself introduces a second-order set of risks**. They fall
into four rough buckets:

1. **Secondary code paths that are themselves unhardened.** The redactor
   (`src/lib/redact.ts`) is now on every error path in the MCP server — and it
   has silent false negatives for at least three credential formats (generic
   JWT, `xoxp-` user tokens that don't match the `-[A-Za-z0-9-]{10,}` tail,
   and the new `_am_token` field itself).
2. **Defaults that look safe but aren't.** `McpServer` constructor defaults
   to `allowUnsafeLocal: true` — the default path is still the old unsafe
   path, only the CLI path is strict. Anyone embedding `McpServer` from
   `src/web/server.ts` or the A2A bridge inherits the unsafe default.
3. **Migrations that can silently regress.** The legacy key "new wins on
   conflict" branch warns but does not delete, and several code paths
   (`am init`, `commitAll`) can *recreate* the legacy path. Over time a
   user's config repo can re-accumulate `.agent-manager/key.txt` even after
   the migration. The `.gitignore` defensive entries help but only if
   `init` is re-run.
4. **Interfaces that became stricter than the ecosystem.** `--ignore-scripts`
   is correct for hostile supply chains but breaks legitimate adapters that
   use `prepare` (native binding compile, TypeScript transpile, Husky setup).
   The adapter name regex `^[a-z0-9][a-z0-9_-]{0,63}$` rejects scoped npm
   packages (`@org/am-adapter-foo`) after the scope strip — anything whose
   unscoped basename starts with `am-adapter-` works but anything that's
   e.g. `@org/Adapter-Foo` does not (uppercase).

The riskiest single commit is **`c58c2bf` (MCP zod/redactor/bearer)**
because it (a) changes a public constructor's default in a security-weakening
direction for backward compatibility, (b) puts a redactor on every outbound
error string (the redactor must now be bug-free forever), and (c) introduces
three bearer-token ingress points, each an independent attack surface.

Per-commit analysis and cross-cutting risks follow. All paths are relative
to `/Users/baladita/Documents/DevBox/agent-manager/`.

---

## Per-commit analysis

### 1. `3ca72fa` feat(safety): atomic writes

**What it changed.** Introduces `src/core/atomic-write.ts:54` (sync) and
`src/core/atomic-write.ts:95` (async) implementing the standard
tmp-sibling → fsync → rename pattern. Threaded through all 13 adapter
`export()` paths, `src/core/config.ts`, `src/core/secrets.ts`,
`src/commands/use.ts`, `src/adapters/community/loader.ts`,
`src/commands/secret.ts`, `src/marketplace/client.ts`, and
`src/web/server.ts`.

**What it might have introduced.**

- **Symlink targets become file replacements.** `renameSync(tmp, target)`
  follows `target` if `target` is a symlink and replaces the *symlink
  itself*, not the file it points to. Before, a `writeFileSync` to a symlink
  would follow and overwrite the underlying file. Users who `ln -s` their
  `~/.claude.json` into a dotfiles repo (common pattern) will find their
  symlink silently replaced by a regular file after the first `am apply`.
  Not audit-tested in `test/core/atomic-write.test.ts`.
- **tmp file disclosure.** `src/core/atomic-write.ts:31` names the tmp
  `.{basename}.{randomhex}.tmp` in the same dir. For
  `~/Library/Application Support/agent-manager/key`, this means a tmp copy
  of the master key (0600) lives on disk between write and rename. If the
  process crashes *between* `writeFileSync` and `renameSync`, the tmp is
  leaked to the filesystem with mode 0600 but named
  `.key.<hex>.tmp`. Cleanup is best-effort in the catch block only —
  no sweeper on next startup.
- **Permission preservation regression.** The new code applies `options.mode`
  to the *tmp* file before rename, so the final file has the requested mode.
  But pre-existing permissions on `target` (e.g. a user who chmod 600'd
  their own config) are **discarded** — after rename the mode is whatever
  `writeFile` defaults to (0644 via umask) unless the caller passes `mode`
  explicitly. Inspection of call sites:
  - `src/core/secrets.ts:180` — passes `0o600`. OK.
  - `src/web/server.ts` auth token — passes `0o600`. OK.
  - All 13 adapter `export()` paths — **do not pass a mode**. User-chmodded
    IDE configs silently widen to 0644 after first export. The prior audit
    did not catch this because `writeFileSync` had the same behavior; but
    the hardening was a "touch every write path" moment where preserving
    mode on existing files would have been a trivial add.
- **No directory fsync.** The doc-comment at `src/core/atomic-write.ts:46`
  is honest about this. APFS/ext4 are fine; other FSes (some NFS mounts,
  some network shares) may lose the rename across a power cut. This is
  a known weaker guarantee — the comment should arguably downgrade to
  "best-effort on non-APFS/ext4".
- **tmp name collisions on Windows.** `basename(target)` may include
  characters that are legal in the file name but, combined with leading
  dot, create a hidden dotfile that Windows Explorer treats specially. Low
  risk but the naming pattern is POSIX-biased.

**What it missed.**

- No clean-up sweeper for orphaned `.{basename}.<hex>.tmp` files from
  prior crashes. A machine that crashed 10 times mid-write has 10 orphan
  tmps in the config dir.
- No cross-filesystem detection. If a user has `~/.claude.json` as a
  bind-mount / symlink onto a different volume, the rename silently
  degrades to copy+unlink (non-atomic) and the code does not warn.
- The sync variant holds the fd between `fsyncSync` and `closeSync`; if
  a signal interrupts `fsyncSync` on a large write, the error catch
  closes fd and unlinks tmp — good — but the original stack trace from
  `fsyncSync` is rethrown with no context (`err.message` is just
  `EINTR`).
- `test/core/atomic-write.test.ts` (134 lines) tests happy paths +
  write-then-rename semantics, but has **no test for symlink target**,
  no test for mode preservation on existing target, no test for tmp
  cleanup on crash mid-write.

---

### 2. `eddf12b` fix(protocols): ACP subprocess leak, bridge perms, SSE heartbeat

**What it changed.** Multiple concrete fixes:
- `src/protocols/acp/client.ts:133` wraps `initialize()` in try/catch and
  kills the subprocess (SIGTERM → 2 s grace → SIGKILL) on failure.
- `src/protocols/acp/client.ts:79` adds per-instance `terminalStore` +
  `terminalOutputCache` (was module-level `Map` at old line 542, shared
  across every client — cross-contamination).
- `src/protocols/bridge.ts:135` wires `permissionPolicy` and
  `allowedPaths` into `AmAcpClient` before `connect()` (default flipped
  from `auto-approve`/`[]` to `deny`/`[cwd]`).
- `src/protocols/acp/registry.ts:67` replaces the naive
  `split(/\s+/)` tokenizer with a proper shell-style parser respecting
  single/double quotes and POSIX backslash escapes.
- `src/protocols/a2a/server.ts:686` adds 30 s `:heartbeat` SSE comment
  frames and makes the initial frame `final: true` for already-terminal
  tasks.
- Replaces a runtime `require("../bridge")` with a static ESM import.

**What it might have introduced.**

- **`parseCommand` still allows metacharacters through as literals.** The
  doc comment at `src/protocols/acp/registry.ts:73` correctly says this
  is the intended contract. But a command like
  `npx claude-agent "--flag=$HOME"` tokenizes into `[npx, claude-agent,
  --flag=$HOME]`. If an agent binary internally passes `argv[2]` to a
  shell (many do, via `bash -c`), the `$HOME` expands there. The
  tokenizer cannot prevent downstream shell use; the comment should
  document this explicitly so callers know they must also run agents in
  a no-shell context.
- **`terminalStore` now resolves to `new Map()` default in the handler
  closure.** `src/protocols/acp/client.ts:418` — if a caller constructs
  `createClientHandler` without passing `terminalStore`, a fresh Map is
  created per call. But `createClientHandler` is only called from one
  place (`AmAcpClient.connect` at line 149) which always passes the
  instance's Map. So default is dead code — but it's dangerous dead code
  because anyone writing a test or a second call site will get a
  per-handler Map and the double-drain cache won't work as advertised.
- **Heartbeat masks legitimate client disconnects.** A 30 s heartbeat on
  a TCP socket keeps the OS thinking the connection is alive even after
  the client has silently gone away (phone in a tunnel, laptop closed).
  The SSE listener only cleans up on a real event through
  `resetIdleTimer`, which heartbeats intentionally do not reset
  (`src/protocols/a2a/server.ts:694` comment). So the stream idles for
  `SSE_IDLE_TIMEOUT_MS = 5 min` *even with a dead client*, whereas
  before it would have died on the next TCP write. Net: ~5 minutes of
  extra resident task state and a leaked `EventEmitter` listener per
  abandoned client. Mitigated by the idle timer but the bound moved
  from "first network error" to 5 minutes.
- **SIGKILL bypasses the adapter's own cleanup.** The 2 s grace before
  SIGKILL is aggressive for agents that write session state on exit
  (Claude agent, codex-acp). Some agents persist state on SIGTERM via a
  flush-and-exit handler that can take ≥ 2 s on slow disks. Under
  SIGKILL, the session file is truncated. `disconnect()` should probably
  be 5-10 s for graceful paths and 2 s only for the crash recovery
  path.
- **`--force` flag on disconnect reaping.** `killSubprocess` is called
  unconditionally from `disconnect`, which now also reaps terminals. If
  `disconnect` is called during normal shutdown and the user's SIGTERM
  handler in their spawned agent hasn't completed, we race against it.
  Before, `disconnect` was a no-op on already-dead processes; now it
  always does the SIGTERM → SIGKILL dance (with `proc.exited` undefined
  on already-dead procs).

**What it missed.**

- `parseCommand` throws on unterminated quotes but does not reject
  empty executable (`"" args`) or executables with path separators
  (`/usr/bin/rm agent`) — the tokenizer's job, but the caller (ACP
  registry resolution) doesn't defend against it either.
- Bridge's new `allowedPaths` default of `[cwd]` is sensible but if `cwd`
  is something like `/` (container with root cwd) the restriction is
  nominal but useless. No warning.
- No test that confirms `permissionPolicy` set on the client *before*
  `connect()` is actually captured in the handler closure (the whole
  HIGH-2 bug was that it wasn't). `test/protocols/hardening-wave-1b.test.ts`
  does test the end-to-end denial but not the wiring-before-connect
  invariant specifically.

---

### 3. `69f4027` feat(security): move master key out of git-tracked config dir

**What it changed.** Key now lives at OS-appropriate data dir:
`~/Library/Application Support/agent-manager/key` (macOS),
`$XDG_DATA_HOME/agent-manager/key` (Linux), `%APPDATA%/agent-manager/key`
(Windows). `AM_KEY_PATH` env override. Migration logic in
`src/core/secrets.ts:86` (moved in 3ca72fa; this commit adds
`doctor` check, `.gitignore` hardening, and `SECURITY.md`). Crypto
unchanged.

**What it might have introduced.**

- **Legacy file is *not* deleted on conflict.** The `conflict` branch of
  `migrateLegacyKey` (`src/core/secrets.ts:95`) warns and returns — it
  does **not** delete the legacy file. Every `loadKey()` call thereafter
  re-emits the warning, but the file sits in the git-tracked config dir
  forever. The user has to manually `rm` and may forget. A user who had
  `commitAll` run once between migration and cleanup already pushed the
  key to their remote. The migration is idempotent but the *exposure
  window* is open until manual cleanup.
- **`migrateLegacyKey` doesn't `commitAll` the deletion.** When migrate
  succeeds (`kind: migrated`, line 108), the legacy file is `unlink`ed
  from the working tree — but the git index still has it if it was
  already committed in a prior session. A subsequent `commitAll` will
  stage the deletion, good, but it will appear as an unrelated change in
  whatever the user's next commit happens to be.
- **`.gitignore` entries are only applied on fresh `init`.** New
  `.gitignore` additions at `src/core/git.ts:7` (`key`, `key.*`,
  `**/key.txt`) ship with `initRepo()`. An **existing** vault that
  was initialized before the fix has the old `.gitignore`. Running
  `am doctor` flags the stray file but does not amend `.gitignore`. A
  user who migrates, runs `am add some-server`, triggers `commitAll` —
  if for any reason a legacy file re-appears (e.g. `AM_KEY_PATH`
  unset after it was set, or a downgraded install), the old
  `.gitignore` won't stop it.
- **`AM_KEY_PATH` takes precedence over both.** If set to a path inside
  the config dir (user testing, fat-fingered env var), the security
  guarantee is silently reverted. No warning, no check that the path is
  outside the config dir.
- **macOS sandboxing.** `~/Library/Application Support/` is
  Full-Disk-Access protected in recent macOS. Headless launchd jobs
  (the ADMINISTRIVIA pattern) that don't have FDA may fail to read the
  key with cryptic `EACCES`. The old `.agent-manager/key.txt` under
  the project dir did not have this constraint.
- **Cross-user migration bug.** If a user switches Unix users
  (e.g. `su` into a service account) and re-runs `am`, `homedir()`
  returns the new user's home, not the original. Migration sees no
  legacy file, no new file — and silently starts with no encryption
  key, effectively losing access to any encrypted secrets.
- **`migrateLegacyKey` reads legacy as utf-8 then writes utf-8.** Fine
  for a b64 key, but if the legacy file is corrupt (partial write from
  pre-atomic-write era) the migration quietly writes the corrupt
  content to the new path and unlinks legacy — silent data loss.

**What it missed.**

- No mechanism to warn/refuse if `AM_KEY_PATH` points inside the config
  dir.
- No "please delete legacy" prompt or auto-delete-after-N-days policy.
- `SECURITY.md` documents rotation but not the "what if I accidentally
  pushed the legacy to GitHub" flow (rotate the key, decrypt-with-old,
  re-encrypt-with-new, force-push + invalidate-remote — none of this is
  in the doc).
- No audit log of migration events.
- 62 new tests in `test/core/key-path.test.ts` cover path resolution and
  migration happy/conflict/none branches, but no test for the
  "AM_KEY_PATH points inside config dir" case or the "corrupt legacy
  file" case.

---

### 4. `14280e8` fix(adapters): enforce checksums, --ignore-scripts, validate names

**What it changed.**
- Adapter name regex `^[a-z0-9][a-z0-9_-]{0,63}$` enforced at
  `src/commands/adapter.ts:472` (`validateAdapterName`), called from
  `resolveSource` for all three source types (npm/git/local).
- `npm install ... --ignore-scripts` on all install + update paths
  (`src/commands/adapter.ts:163`, `:325`, `:541`).
- SHA256 of the adapter `command` file hashed post-install and stored
  in `adapters.toml` (`computeChecksum` at line 566). Loader refuses to
  spawn non-local adapters without a pinned checksum
  (`src/adapters/community/loader.ts:44`).

**What it might have introduced.**

- **`--ignore-scripts` breaks legitimate adapters.** Adapters that ship
  with TypeScript sources and use a `prepare` script to transpile
  (common for pure-JS npm packages that ship TS), or that have a
  `postinstall` native-binding build step (`node-gyp`), or that use
  Husky (many dev dependencies pull it in transitively) will fail to
  work. The adapter binary may not exist at the expected `command` path
  after install because `prepare` never ran to create it. The install
  succeeds, checksum is written against a stub or missing file, and
  runtime spawn fails with `ENOENT`. No test in
  `test/commands/adapter-install-sec.test.ts` exercises the
  "package needs prepare" case — it's all security tests, not
  compatibility tests.
- **Checksum is taken on the `command` file only.** If an adapter is
  split across multiple JS files (it almost always is — `main.js`
  requires `lib/foo.js`), we hash only the entrypoint. An attacker who
  tampers with a transitive dep inside `node_modules/` after install
  passes the loader's checksum check. `computeChecksum` at line 566
  would need to hash the adapter's effective closure (via e.g. a
  tree hash of its `node_modules/` subset) to catch this.
- **`validateAdapterName` rejects uppercase.** The npm ecosystem allows
  uppercase in package names (older packages). Deprecated, but valid.
  `@OldOrg/am-adapter-Foo` strips the scope to `am-adapter-Foo`, which
  then fails the regex. Error message is "lowercase letters/digits,
  dash, underscore; start with alnum; 1–64 chars" — actionable, but
  the user has to rename their package.
- **`deriveMarketplaceName` (not touched) still allows paths that
  `validateAdapterName` would reject.** Marketplace names and adapter
  names use different rules. Not obviously a problem, but two regexes
  with overlapping scope is the kind of thing iteration 3 will find.
- **`--force` still shadows built-ins.** The commit message claims
  "and --force let attackers shadow built-in names" was fixed. Looking
  at `src/commands/adapter.ts` — the name regex validates *shape* but
  does not check against the built-in adapter list. An adapter named
  `claude-code` (13 chars, lowercase, valid regex) passes
  `validateAdapterName` and, with `--force`, is registered in
  `adapters.toml`. The loader prioritization between built-ins and
  community adapters becomes the only thing keeping the right one on
  top. This is a partial fix.
- **Checksum re-pinning on update is unconditional.** `updateSubcommand`
  at `src/commands/adapter.ts:353` validates the proxy (spawns it,
  reads its `meta`) and then re-pins the checksum. If an attacker can
  get a bad version of the adapter to pass `proxy.meta` validation
  (returning the correct name/version strings), the new bad hash is
  pinned and the user has no rollback. TOFU inverts into TOFL —
  trust-on-first-use becomes trust-on-latest.

**What it missed.**

- No allow-list for adapter names that cannot be registered by community
  packages (the 13 built-ins).
- No package-tree hashing — only entrypoint file.
- No `--ignore-scripts` override for adapters that legitimately need
  `prepare` (e.g. `am adapter install --allow-scripts trusted-pkg`).
- Test `test/commands/adapter-install-sec.test.ts` tests
  `validateAdapterName` thoroughly but does not assert the built-in
  shadowing protection (which as noted above isn't there).

---

### 5. `c58c2bf` fix(mcp): Zod validation, error redactor, bearer auth, traversal fix

**What it changed.**
- `TOOL_SCHEMAS` map (`src/mcp/server.ts:324`) with zod schemas for
  all 33 tools; validated at dispatcher (`:2145`).
- `resolveSessionPathSafely` (`src/mcp/server.ts:268`) for the
  `am_acp_session_cancel` handler's `sessionId` → `path.join` → `rm`
  chain.
- `src/lib/redact.ts` (85 lines) — `redactConfigSecrets` (structural,
  walks tree) and `redactSecretish` (regex on string). Applied via
  `safeErrorMessage` at all MCP error exits.
- Bearer auth gate: `AM_MCP_TOKEN` env, `AM_MCP_ALLOW_UNSAFE_LOCAL=1`
  escape hatch, token accepted at three locations (`_meta.authorization`
  Bearer header, `_meta.token`, `arguments._am_token`), constant-time
  compare (`src/mcp/server.ts:115`).
- `McpServer` constructor now takes `{ auth }` but **defaults to
  `allowUnsafeLocal: true`** for backward compatibility with in-process
  consumers.

**What it might have introduced.**

- **Constructor default is security-weakening.** `src/mcp/server.ts:2007`
  — any code that does `new McpServer()` without passing `auth` runs
  the old unsafe path. `am mcp-serve` CLI (`src/commands/mcp-serve.ts`)
  explicitly wires strict mode, but: (a) `src/web/server.ts`, (b) any
  test that spins up an `McpServer` for convenience, (c) any future
  integration that `new McpServer()` — each bypasses the whole gate.
  Grep the repo for `new McpServer(` to know the blast radius; the
  default should have been strict with an explicit
  `{ auth: { allowUnsafeLocal: true } }` for legacy callers.
- **Three ingress points for bearer token.** `_meta.authorization`,
  `_meta.token`, `arguments._am_token` — each line of
  `extractBearerToken` (`src/mcp/server.ts:132`) adds surface. The
  `_am_token` fallback means every tool's `arguments` object is
  inspected; zod schemas correctly allow the field via `withAuth()` but
  if a future tool handler does `JSON.stringify(args)` in an error
  path, the token leaks into the error envelope (which goes through
  the redactor — but the redactor doesn't know about `_am_token` yet;
  the generic key=value pattern at `src/lib/redact.ts:64` requires the
  key to match `/api[_-]?key|apikey|secret|password|token|bearer|authorization|auth/`
  — `_am_token` matches `token`, so redaction works — but only because
  of a coincidence).
- **Redactor false negatives.**
  - **JWT.** No pattern for `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`.
  - **Slack user tokens.** `xoxp-` may have `xoxp-`-prefixed tokens
    that include dots (per recent Slack changes). Current regex is
    `/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g` — the allowed character class
    excludes `.` and `_`, so newer tokens slip through.
  - **Private keys.** PEM `BEGIN PRIVATE KEY` blocks / `ssh-rsa AAAA...`
    not caught.
  - **Raw AES key material.** A base64-encoded 256-bit key is 44 chars
    of `[A-Za-z0-9+/=]` — no pattern.
  - **Bearer pattern requires `\b[Bb]earer\s+`** — `Authorization: bearer X`
    works, but `auth: X` where X is a bare token does not match the
    Bearer pattern, only the key=value pattern, which requires the key
    to hint at a secret.
- **Zod `.passthrough()`** at `src/mcp/server.ts:320` allows unknown
  fields. Intentional for `_am_token`, but any future typo'd field
  (e.g. `_am_toekn`) silently passes — no typo protection, no way to
  log "unexpected field X on tool Y". Strict would have been safer.
- **`extractBearerToken` trims whitespace** (`:142`). Leading/trailing
  whitespace in the token is silently stripped, so `" secret "` and
  `"secret"` compare equal after extraction — but the stored token
  (`AM_MCP_TOKEN` env) is also trimmed in `loadAuthConfig`. OK, but
  means a user who chose a token with intentional spaces loses them.
  Not a security issue, just a minor gotcha.
- **Constant-time compare is real constant-time only for equal lengths.**
  `constantTimeEq` at `src/mcp/server.ts:118` short-circuits on length
  mismatch. An attacker can learn the token *length* via timing (the
  length-mismatch branch returns fast). Normally fine — the token is a
  secret, not the length — but combined with `_am_token` being passed
  in `arguments` (many MCP clients log the arguments), the length can
  leak to logs too. Low severity.
- **`resolveSessionPathSafely` is solid** but the containment check
  (`src/mcp/server.ts:306`) uses `candidate.startsWith(baseResolved +
  sep)`. On Windows, `sep = "\\"` and `baseResolved` may be
  `C:\...\sessions` — the startsWith check is correct but case-
  sensitive, while NTFS is case-insensitive. `SESSION_ID` vs `session_id`
  as same-dir siblings would be case-distinct in `candidate`
  construction; probably fine because both resolve under the same base
  prefix, but worth a Windows-specific test (no test exists in the 64
  new tests).

**What it missed.**

- No rate-limit / lockout on bad bearer attempts. An attacker with
  stdio access can brute-force a short token.
- No defense-in-depth around secret decryption *success*. Even with
  auth, a successful `am_apply` call decrypts every secret into memory
  and returns results. There's no "decrypt on demand, only the requested
  server" path.
- Tests verify the auth gate rejects — but I don't see a test for
  "constructor with no opts defaults to unsafe" documenting the
  backward-compat contract. Silent default changes slip past CI.

---

### 6. `892fd5b` feat(marketplace): URL validation, SHA pinning, TOFU, path traversal scrub

**What it changed.** New `src/marketplace/security.ts` (289 lines):
- `validateMarketplaceUrl` (https-only, no creds, std ports) — `:72`
- `safeResolveInsidePlugin` (trailing-sep containment) — `:128`
- `enforceCloneSize` (100 MiB default) — `:180`
- `withCloneTimeout` (60 s default) — `:195`
- `resolveHeadSha` via isomorphic-git — `:212`
- `promptTrustOnFirstUse` / `promptShaChange` TOFU via clack — `:225`,
  `:262`

`src/marketplace/installer.ts:61` calls `verifyMarketplacePin` before
`applyPlugin`. `src/marketplace/client.ts` rewires `addMarketplace` +
`updateMarketplace` to run the pipeline.

**What it might have introduced.**

- **TOFU name collision.** The TOFU prompt at
  `src/marketplace/security.ts:235` prompts "Trust marketplace
  `<url>`?" — the *name* under which it gets registered is either
  `--name` or `deriveMarketplaceName(url)`. A user with
  `marketplace-a` already trusted can then add a different URL that
  happens to derive the same name (e.g. `github.com/evil/marketplace-a`
  vs `gitlab.com/trusted/marketplace-a`) — the name collision is
  caught at `src/marketplace/client.ts:117` (`already exists`) but
  only if the first one is still registered. If the user removed it
  and added the second, TOFU fires for the new URL but the trusted
  decision is tied to the URL, not the name — so this is actually
  correct. **However:** there is no protection against the user
  typing the wrong URL at add-time and confirming TOFU; the SHA pin
  locks it but the user already trusts a URL they didn't intend.
- **Trust-on-first-use has no expiry.** Once accepted, the entry lives
  in `marketplaces.json` forever. No `trusted_at` re-prompt after N
  days, no per-repo key-pinning (the SHA is pinned, but if the repo
  is force-pushed and the user accepts `--yes`, new SHA becomes the
  permanent trust without a re-prompt).
- **`safeResolveInsidePlugin` uses `startsWith(baseResolved + sep)`.**
  This is correct and guards against the `/plugin` vs `/plugin-evil`
  classic. But: it does NOT follow symlinks inside the clone. An
  attacker who commits `skills/inside.md → ../../../etc/passwd` as
  a symlink has the manifest path resolve fine (to a path inside
  `pluginDir`), then the loader reads the symlink and escapes. The
  check is on the path string, not on the real resolved target. No
  `realpath` or `lstat` check.
- **`enforceCloneSize` measures after clone.** The clone runs to
  completion (up to the timeout), which can deliver a 10 GiB payload
  before the size check fires. Size is enforced *retrospectively* —
  the 100 MiB cap does not save bandwidth or disk during the clone
  itself. Combined with `--depth 1`, probably bounded in practice,
  but not architecturally bounded.
- **`measureDirectorySize` skips symlinks** (`src/marketplace/security.ts:159`)
  which is correct for counting actual bytes, but means a huge file
  reachable via symlink is not counted. Probably fine for size, but
  note that the clone itself won't include symlinks from outside the
  repo anyway.
- **TTY detection.** `promptTrustOnFirstUse` at `:237` checks
  `process.stdin.isTTY && process.stdout.isTTY`. A user running under
  `script(1)` or a CI harness that fakes a TTY will get the interactive
  prompt and hang. A user running with a non-TTY stdin (piped from
  another command) without `--yes` is silently refused — but the
  error message only fires after the UX delay of trying to start the
  prompt.
- **`--allow-http` exists**. Reasonable for local testing, but the flag
  name suggests it's a dev-only knob. No warning emitted when used.
  A CI pipeline that accidentally templates `--allow-http` into
  production will silently accept http URLs.
- **Non-pinned path is permanent.** If `resolveHeadSha` returns `null`
  for a local symlink (by design), the entry has no `commit`, no
  `pinned: true`. Subsequent `verifyMarketplacePin` is a no-op
  (`src/marketplace/client.ts:347`). A local marketplace can be
  silently edited by any process on the machine — fine for local
  testing, but not flagged as "unpinned" in `am marketplace list`.

**What it missed.**

- No symlink realpath check in `safeResolveInsidePlugin`.
- No upper bound on clone *time* separate from the wall clock (a
  60 s timeout on a slow network may legitimately need to be 300 s;
  a 300 s timeout on a fast network gives an attacker more
  exfiltration time).
- No GPG signature verification on the pinned SHA. SHA pinning defends
  against post-install tampering, not against the marketplace
  maintainer being compromised (which is what signature verification
  would help with).
- `promptShaChange` always accepts with `--yes`; no "--yes only for
  already-trusted" distinction.
- Tests (46 new across 4 files) cover URL validation, traversal, SHA
  pin, TOFU happy paths — but I don't see a symlinked-skill test or a
  `measureDirectorySize` stress test on a pathological layout.

---

### 7. `0fdbcf3` chore(tidy): collapse ACP registries, unify AM_VERSION, flip ADRs

**What it changed.**
- `src/protocols/acp/registry.ts:11` now imports `BUILT_IN_ACP_AGENTS`
  from `core/agent-registry` (was duplicated 16-entry literal).
- `src/lib/version.ts` — new single source: `AM_VERSION =
  process.env.BUILD_VERSION ?? "0.0.0-dev"`. Replaces four separate
  `process.env.BUILD_VERSION ?? "0.1.0"` sites.
- ADRs 0026/0027/0028/0030 flipped `proposed` → `accepted`.
- New `docs/community-adapter-authoring.md` (326 lines).
- CI job asserts `./dist/am-linux-x64 --version` matches
  `package.json` version.

**What it might have introduced.**

- **`AM_VERSION` fallback `0.0.0-dev` flows into HTTP user-agents,
  JSON-RPC handshake `clientInfo.version`, A2A cards, wiki exports.**
  The A2A card generator at `src/protocols/a2a/generate-card.ts:5`
  (line 3 diff in `eddf12b`) was already refactored to use a unified
  version. A card published to a registry with `version: 0.0.0-dev`
  is indistinguishable from any other dev build. Not a security
  issue, a discoverability issue.
- **`test/commands/version.test.ts` loosened.** The diff replaces
  `expect(output).toContain("0.1.0")` with
  `expect(output).toMatch(/^\d+\.\d+\.\d+(-\w+)?$/)`. The new regex
  accepts `0.0.0` — so a test that could catch "BUILD_VERSION was
  not injected" now passes in dev and in CI. The CI job (new step)
  specifically asserts the binary version matches package.json — so
  the CI gate is real. But the *unit* test is now a shape check only.
  That is, the test became less meaningful; its role is now performed
  by the CI integration job.
- **Import path fragility.** `src/adapters/community/proxy.ts:152`
  uses `await import("../../lib/version")` (a dynamic import). In the
  Bun-compiled binary, dynamic imports resolve at runtime against the
  embedded module graph — works for this case, but it's a departure
  from the unified-version theme. A static import would be simpler.
- **Implicit contract change for ADR-0030.** Accepting 0030 means the
  unified registry is the canonical source. Any third-party code that
  still imports from `src/protocols/acp/registry.ts` BUILT_IN_REGISTRY
  gets the import at module-init time — if `core/agent-registry`
  introduces a circular dep later, the lookup can return `undefined`.
  A test that imports in both orders would catch this.

**What it missed.**

- No ADR status check in CI (e.g. "if file has `status: proposed` but
  the described code shipped, fail").
- No check that the `docs/community-adapter-authoring.md` hello-world
  actually runs (a docs test). Docs drift is the next audit iteration.

---

## Cross-cutting new risks (answers to check #3)

### 3a. Master key migration — does it ever re-create the legacy file?

Short answer: **yes, in two scenarios.**

1. `AM_KEY_PATH` pointed at the legacy location. `saveKey` at
   `src/core/secrets.ts:177` calls `resolveKeyPath()` which returns
   whatever `AM_KEY_PATH` says — no validation that it's outside
   `configDir`. A user testing with `AM_KEY_PATH=./.agent-manager/key.txt`
   (or one that resolves there) re-creates the legacy file. On the
   next run without the env, the conflict branch fires — the bad file
   lives on.
2. `migrateLegacyKey` at line 94 returns `kind: conflict` without
   deleting. The warning prints once per session. A user who doesn't
   see stderr (JSON mode, launchd job) never notices. The file stays
   under the git-tracked dir and `commitAll` can stage it if
   `.gitignore` is older than the fix (see next risk).

### 3b. Zod validation — does it allow extra properties by default?

**Yes.** `withAuth(shape)` at `src/mcp/server.ts:317` wraps every tool
schema in `.passthrough()`. Extra properties silently pass through the
validator and arrive at the handler. Handlers that do
`JSON.stringify(args)` in error messages will include the extras; the
redactor catches most secret-shaped extras but not all (JWT, raw base64,
arbitrary user names that happen to coincide with paths, etc.).

**Suggestion:** Switch to `.strict()` for all tools except the few that
document a meta-passthrough. Or keep `.passthrough()` but strip unknown
fields before passing to the handler.

### 3c. Bearer auth — can a user enumerate valid token lengths via timing?

**Yes, trivially.** `constantTimeEq` at `src/mcp/server.ts:118`
short-circuits on length mismatch:

```
if (a.length !== b.length) return false;
```

Any request with the wrong length returns in O(1); the correct length
runs the full XOR loop. An attacker with stdio access can send tokens
of increasing length and observe timing to determine the exact token
length before beginning the character-by-character attack.

**Mitigation:** Run the comparison loop over `max(a.length, b.length)`
bytes regardless; the loop cost is trivial. Or normalize both to a
fixed buffer size.

### 3d. Marketplace TOFU — can a user accidentally trust two different URLs with the same name?

**Partially.** `src/marketplace/client.ts:117` catches the name
collision at add-time. **However**, if the user `am marketplace remove
foo` and then `am marketplace add https://evil/foo`, the second is a
fresh TOFU — they confirm (or `--yes`), and the name-to-URL binding
is silently updated. A user who scripted `am` with a cached name
reference now trusts the new URL.

Additionally, `deriveMarketplaceName(url)` is just basename stripping —
`github.com/trusted/foo` and `github.com/evil/foo` both derive `foo`.
The TOFU prompt shows the URL, but the stored name is the identity the
user refers to in scripts. A single-line typo in a script
(`github.com/trusted/foo` → `github.com/trustred/foo`) bootstraps a
new TOFU — one accept later, an attacker's repo owns the name.

### 3e. Atomic writes — do they correctly handle the target being a symlink?

**No, they replace the symlink with a regular file.** `renameSync(tmp,
target)` on POSIX replaces the name `target` entirely — if `target` was
a symlink, the symlink is gone and a regular file sits at that path.
Users who `ln -s ~/dotfiles/claude.json ~/.claude.json` lose the link
after the first `am apply`. The test suite does not cover this case.

**Mitigation:** Before `renameSync`, `lstat(target)` and if it's a
symlink, either (a) follow to the real target and rename into that
directory (atomic on same FS), or (b) write directly to the target
(non-atomic) with an explicit warning.

### 3f. `--ignore-scripts` — does it survive when `prepare` or other critical scripts are needed?

**No. It breaks legitimate adapters.** npm `prepare` is the canonical
build-before-publish step. Adapters that ship TypeScript source, use
native bindings, or depend on any package whose install requires
`prepare` are silently broken. The install succeeds, the binary path
doesn't exist, the spawn fails at runtime. No warn during install, no
actionable error at runtime.

**Mitigation:** Add `--allow-scripts <adapter-name>` as an explicit
opt-in for adapters that need it. Or, require adapters to ship the
compiled artifact (reject packages whose `package.json` has a
`prepare` script pointing at their build system).

---

## Riskiest commit + why

**`c58c2bf` (MCP zod/redactor/bearer/traversal) is the riskiest.**

Three independent reasons:

1. **Default changed in the wrong direction.** `McpServer` constructor
   defaults `allowUnsafeLocal: true` for backward compat. Anyone who
   instantiates `new McpServer()` without arguments gets the old unsafe
   path. Only the `am mcp-serve` CLI binds strict mode explicitly. This
   is the exact opposite of "secure by default" — the primary entry
   point is locked down, all side entry points are wide open.

2. **Every error path now depends on the redactor.** The redactor has
   known false negatives (JWT, raw base64 keys, new Slack formats,
   SSH keys). Any future bug that lets an error bubble through a
   non-redacted path leaks secrets; any future change to the redactor
   regex has to be absolutely right because it's now on the critical
   path for secret disclosure across 33 tools.

3. **Three bearer-token ingress points** (`_meta.authorization`,
   `_meta.token`, `arguments._am_token`) triple the surface. The
   constant-time comparator has a length-oracle. The token is sent
   through `arguments` for clients that can't set `_meta` — these
   arguments are routinely logged by MCP clients, leaking the token to
   log sinks outside the agent-manager trust boundary.

The other commits each have one concrete second-order risk; `c58c2bf`
has three that compound.

---

## Recommended follow-ups

**Priority 1 (security):**

1. **Flip `McpServer` default to strict.** Require
   `{ auth: { allowUnsafeLocal: true } }` at construction for legacy
   callers. Update `src/web/server.ts` + tests to pass the flag
   explicitly.
2. **Fix `constantTimeEq` length oracle.** Compare over a fixed buffer
   size regardless of input length.
3. **Guard `AM_KEY_PATH` against config-dir paths.** If the resolved
   key path is inside `configDir`, refuse with an error (or warn
   loudly).
4. **Delete legacy key on conflict after explicit user confirmation.**
   `am doctor --fix-legacy-key` or an automated prompt on next
   `am` run. Leaving it in place indefinitely is the long-tail leak.
5. **Extend redactor patterns** — JWT, raw base64 (≥43 chars), SSH keys
   (`-----BEGIN`), and the new `xoxp-`-with-dots Slack format.

**Priority 2 (correctness):**

6. **Atomic-write symlink test + fix.** `lstat` the target first;
   follow-through or warn.
7. **Preserve mode of existing target.** All call sites that don't
   pass `mode` should `stat(target)` first and re-apply.
8. **`--allow-scripts <name>` opt-in** for adapters that legitimately
   need `prepare`. Document the tradeoff.
9. **`safeResolveInsidePlugin` realpath check.** Add `lstat` +
   `realpath` for paths that resolve into the plugin dir; refuse if
   the symlink target escapes.
10. **Tree-hash adapter binaries.** Hash the full adapter directory
    (minus `node_modules` subtrees we separately verify via
    lockfile), not just the entrypoint.

**Priority 3 (UX / observability):**

11. **CI gate that greps for `new McpServer(` without `{ auth }`.**
    Static check to prevent regression of Priority-1 item 1.
12. **`am marketplace list --show-trust`.** Show `pinned|unpinned|local`
    per entry; callers can audit their trust graph.
13. **Orphan tmp sweeper.** On startup, scan common config dirs for
    `.{basename}.*.tmp` older than N minutes and unlink.
14. **ADR status linter.** CI rule that fails when an ADR is
    `proposed` but the described code path has shipped (heuristic:
    grep the ADR for file paths, check git log).
15. **Test the default behavior.** Every security-weakening default
    deserves an explicit test that *documents* the default, so a
    future reviewer sees it before flipping.
