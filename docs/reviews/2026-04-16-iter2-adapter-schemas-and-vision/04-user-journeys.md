# am CLI — End-to-End User Journey Audit

**Date:** 2026-04-16
**Scope:** Iter 2 — adapter schemas and vision
**Method:** static trace through `src/` for 6 golden journeys; no execution. Every finding cites `file:line`.

---

## Summary

Six journeys were traced end-to-end by reading the code. Overall, **am** has good per-command hygiene (atomic writes, auto-commit, auto-encryption, structured errors via `AmError` + `amError`), but the *story-level* experience has rough edges:

- **Silent failures**: `try { commitAll } catch {}` swallows every git error shape, including "repo corrupt" or "staging failed", not just "nothing to commit". Unresolved `${VAR}` and un-decryptable `enc:v1:` values pass straight through to the generated IDE config without visible error. Adapter `export()` failures in `apply` downgrade an error to an `info()` line.
- **Inconsistent "next step" hints**: `am init`, `am add`, `am import`, `am secret set`, `am apply --dry-run` all end with different shapes. Some point at `am apply`, some don't. Some only hint in interactive mode.
- **Assumed state**: `am add`, `am import`, `am apply`, `am undo`, `am log`, `am secret *`, `am config show` all fail (with varying clarity) if `am init` wasn't run. `am undo` relies on git log depth >=2 and emits a slightly misleading "initial commit" message if the config dir was created outside of `am init`.
- **Weakest journey: #5 diff & undo.** There is no top-level `am diff` command; `diff` is a flag on `apply`. `undo` reverts the *catalog* (config.toml) but does NOT regenerate IDE configs — it just prints "Run `am apply` to regenerate". So catalog rollback + IDE state can silently drift.

Total distinct silent-failure points: **23** (see Cross-journey patterns § below for the enumerated list).

---

## Journey 1 — First-run onboarding

User runs `am init`, then `am add server tavily --command bunx --args tavily-mcp`.

### Trace through code

1. `src/cli.ts:25` routes `init` → `src/commands/init.ts`.
2. `init.ts:42` resolves config dir via `resolveConfigDir()` = `$AM_CONFIG_DIR` or `~/.config/agent-manager` (`src/core/config.ts:20`). **User never sees this path unless they read the success line at `init.ts:122`.**
3. `init.ts:46-55`: if `config.toml` exists already, prints `error: Already initialized. Config exists at ${configPath}` and exits 1 — fine.
4. `init.ts:58-73`: `mkdir` config dir, `initRepo` (git init + `.gitignore` + first commit), write empty config with `default` profile.
5. `init.ts:76-77`: detect installed tools (`getDetectedAdapters`). The user sees `Detected tools: ...` only if detection returned anything (line 123).
6. `init.ts:81-93`: **interactive-only** prompt to generate encryption key. Skipped in `--json`/`--quiet`/non-TTY.
7. `init.ts:97-120`: **interactive-only** prompt for git remote URL.
8. `init.ts:122-126`: prints `Initialized agent-manager at <configDir>`. If tools detected, hints `Run \`am import auto\` to import existing configs`.

Then `am add server tavily --command bunx --args tavily-mcp`:

1. `src/cli.ts:26` → `src/commands/add.ts`.
2. `add.ts:78` parses entity `server`, name `tavily`.
3. `add.ts:104-199` `addServer`: reads config, checks duplicate, builds `Server`, auto-encrypts any detected secrets, writes, auto-commits.
4. The `--args tavily-mcp` is a single string, split on commas (line 134): `server.args = ["tavily-mcp"]`. If the user writes `--args "-y,tavily-mcp"` they get `["-y", "tavily-mcp"]`. This works, but the comma-split convention is only documented in the flag description.

### Rough edges

- **No "where is my config?" message on success.** Line `init.ts:122` says `Initialized agent-manager at ${configDir}` but doesn't point to `config.toml` inside it or to the key path. Contrast with `init.ts:90`, which does print the key path — only if the user accepted the interactive prompt.
- **No next-step hint unless tools are detected.** If nothing is detected (line 123-126), the user gets no guidance on what to do after `am init`. They have to read `--help` to learn `am add` exists.
- **Encryption key prompt is a yes/no with a confusing default (`true`).** If the user dismisses the prompt with Enter (default yes), a key is silently generated and saved. Fine. But if they say "no", *there is no follow-up message explaining that later `am secret set` will fail until they run `am secret generate-key`*. See `secret.ts:63-67`.
- **Git remote prompt is blocking.** If the user just wants to try the tool, they must type Enter twice (key + remote). No `--no-prompt` flag or one-shot `--quick` mode.
- **`am add server tavily --command bunx --args tavily-mcp`** gives no output mentioning the config path written. Success says `Added server "tavily"` (`add.ts:182`) — but doesn't say *where*.
- **`commitAll` failure is swallowed unconditionally.** `add.ts:177-180`:
  ```
  try { await commitAll(configDir, `add server: ${name}${tagStr}`); }
  catch { /* Nothing to commit is fine */ }
  ```
  Any git error — repo corrupted, staging locked, ENOSPC — becomes a no-op. Same pattern at `import.ts:468-472`, `secret.ts:94-98`, `add.ts:258-262`.
- **Profile default** is `"default"` but `default_profile` key is `settings.default_profile` (`init.ts:65`). If a user later renames the profile in TOML but forgets to update `settings.default_profile`, `apply` will silently fall back to `"default"` at `apply.ts:48` and the profile filter at `config.ts:289-291` silently becomes a no-op (no `profile` found → no filtering).

### Silent failures

1. **`commitAll` swallowed** — `add.ts:177`, `import.ts:468`, `secret.ts:94`, `secret.ts:381`, `add.ts:258`. [SF-1]
2. **`getDetectedAdapters` errors not surfaced**: `init.ts:76` awaits detection but any exception would bubble — *actually* verified: `getDetectedAdapters` in `registry.ts:125-136` calls each adapter's `detect()` and there's no try/catch around it, so a throwing adapter would break init. [SF-2]
3. **Profile filter silently no-ops if `settings.default_profile` points at a renamed/deleted profile** — `config.ts:289` does `config.profiles?.[profileName]`; if undefined, skips filtering entirely. User gets "all servers" when they expected a filtered subset. [SF-3]

### Assumed state

- `resolveConfigDir()` assumes `$HOME` is set (node `homedir()` — fine on macOS/Linux, can break in sandboxed CI).
- If a *legacy* key exists at `<configDir>/.agent-manager/key.txt`, `loadKey` silently migrates it (`secrets.ts:141-168`) and emits one `console.error` line. Fine for humans; **pollutes stderr for JSON callers** (line 152 is unconditional).

---

## Journey 2 — Brownfield import

User has existing `~/.claude.json`. Runs `am import claude-code`.

### Trace

1. `src/cli.ts:34` → `src/commands/import.ts:74`.
2. `import.ts:109-114`: resolve `configDir`, read config. `requireConfig` (`errors.ts:59`) throws `AmError("Config not found", "Run `am init` ...", "CONFIG_NOT_FOUND")` if absent.
3. `import.ts:123-134`: `args.source === "claude-code"` → `getAdapter("claude-code")` returns the built-in adapter.
4. `import.ts:143`: `isBrownfield = Object.keys(config.servers).length > 0`. For a fresh init, this is false — brownfield branch only triggers if prior servers exist.
5. `import.ts:146-158`: adapter `import()` is called. `claude-code/import.ts:43-54` reads `~/.claude.json` + project `.mcp.json`. **If `~/.claude.json` is missing, it pushes a `File not found` warning (claude-code/import.ts:94), not an error.**
6. `import.ts:161-215`: brownfield merge via `runMergePipeline` (merge.ts:378). Classifies identical/compatible/conflicting.
7. `import.ts:161-215` auto-mode behavior:
   - Identical servers → skipped (debug log only).
   - Exact-match conflicts with mergeable diffs → auto-merged.
   - Fuzzy conflicts (basename or name match) → added to `allConflicts`, emitted as `info` warnings (line 211), *skipped*, never applied.
8. `import.ts:403-457`: secret auto-encryption. Scans all imported servers, auto-generates key if absent, substitutes values with `${VAR}` refs and stores ciphertext in `settings.env`.
9. `import.ts:459`: `writeConfig`.
10. `import.ts:475-485`: summary line `Imported X server(s), Y merged, Z duplicate(s) skipped`, then warnings printed as `info(`  warning: ...`)`.

### Rough edges

- **"File not found" for `~/.claude.json` is a warning, not an error** (`claude-code/import.ts:94`). If the user types `am import claude-code` but they've never used claude-code, they get `Imported 0 server(s)` with a buried warning and no exit code signaling that nothing happened. [UX-2]
- **Fuzzy conflicts print as warnings but still summary says "Imported N"**. Example: the summary at `import.ts:475` says "Imported 5, 0 merged, 2 conflicts skipped" — but the user has to scroll up through warnings to understand *which* conflicts and *why*. No pointer to `am import claude-code --report`.
- **Brownfield detection is "any existing server"** (`import.ts:143`). Greenfield and brownfield take different code paths (line 143-249). A user who imported once and then runs `am import` again gets the brownfield path even for the first re-import, which has different (less generous) dedup semantics.
- **No confirmation prompt.** `am import claude-code` on a populated config silently merges. No `--dry-run` advertised beyond `--report`. The flag name `--report` is non-obvious for "dry run".
- **Auto-encrypt defaults to ON but generates key silently.** `import.ts:410-421` auto-generates an encryption key if absent. The user sees `Generated encryption key (stored at <path>)` as an info line, mixed in with other output. If they didn't want a key, the only escape is `--no-encrypt` (flag documented at line 97-101). The key path is printed but there's no warning "back this up".
- **`--no-encrypt` leaves secrets in plaintext in the TOML file** (`import.ts:445-456`). The warning `Warning: N potential secret(s) left unencrypted` is an info line, not a stderr error. A CI/scripting user might miss it.
- **Marketplace scan (`--marketplace`) is off by default**, so plugin-derived servers are silently ignored. User only sees them if they knew to pass `--marketplace`.

### Silent failures

4. **Adapter `import()` throw is caught and downgraded** — `import.ts:152-157` catches, emits `info(...)`, pushes to `allWarnings`, continues. Result: `am import auto` with 3 adapters, one broken, exits 0. User doesn't know. [SF-4]
5. **Identical servers' identity is dedup'd by `extractServerIdentity`** (`import.ts:34-72`), but this is best-effort string parsing. A server with `command="sh"` and `args=["-c", "npx tavily-mcp"]` will yield identity `sh` — colliding with every other shell-wrapped server. Future imports overwrite silently via brownfield merge. [SF-5]
6. **`readServersFromFile` pushes "File not found" as a warning** (`claude-code/import.ts:94`). Non-existence of the source file is indistinguishable from empty source. [SF-6]
7. **Encryption key is auto-generated without user consent during `am import`** (`import.ts:412-421`). Documented behavior, but no confirmation. If the user wanted `--no-encrypt`, they had to know in advance. [SF-7]
8. **`commitAll` swallowed** again at `import.ts:468-472`. [SF-1 repeated]
9. **Warnings are printed via `info()`** (`import.ts:481-485`), which respects `--quiet` and is suppressed. A `--quiet` run hides every import warning. [SF-8]

### Assumed state

- `~/.claude.json` at user's `$HOME`. Not configurable.
- `~/.claude/skills/` for skill discovery.
- Implicit: `homedir()` is writable for `.agent-manager/state.toml`.

---

## Journey 3 — Add server with secret

`am add server openai --command python --args mcp_openai --env OPENAI_API_KEY=sk-...`

### Trace

1. `add.ts:137-143`: `--env` comma-split → `server.env = { OPENAI_API_KEY: "sk-..." }`.
2. `add.ts:150`: `scanServerForSecrets(name, server)` (`secret-detection.ts:215`). Tier-1 key-name pattern `/openai/i` matches at `secret-detection.ts:36`. Returns `DetectedSecret` with `suggestedEnvVar = "OPENAI_API_KEY"`.
3. `add.ts:154-170`: for each secret, ensure key, `substituteSecret` (sets `server.env[OPENAI_API_KEY] = "${OPENAI_API_KEY}"`), encrypt the original value, store ciphertext in `config.settings.env.OPENAI_API_KEY`.
4. `add.ts:172`: `writeConfig` (atomic).
5. `add.ts:177-180`: `commitAll`, catch-swallow.
6. `add.ts:182-185`: `info("Added server \"openai\"")`, if secrets: `info("  Encrypted N secret(s) — values use ${VAR} references now.")`.

### Rough edges

- **No confirmation prompt before adding a plaintext secret to argv.** The secret value is present in the user's shell history (`$HISTFILE`) and in any exit-tracing `ps` output. `am` itself has no control here, but could *warn* "Detected secret in --env argument; consider piping or `am secret set`" — it doesn't.
- **No redaction in the success line.** `add.ts:182` prints `Added server "openai"` — safe. But the `--json` output at `add.ts:188-197` includes `config: server` which, post-substitution, has `env.OPENAI_API_KEY = "${OPENAI_API_KEY}"` — safe. Good.
- **`am list`** (`list.ts:93-125`): only prints `name`, `command`, `args` (joined), `tags`, `enabled`. Does NOT print `env` — safe to share. But `--json` emits `env` if `command` is used with an explicit flag — let me re-check: `list.ts:95-103` deliberately drops `env`. **Safe.**
- **`am config show`** (`config.ts:120-183`): prints the raw TOML. Post-substitution, `env` values are `${OPENAI_API_KEY}` and `settings.env.OPENAI_API_KEY` is the `enc:v1:...` ciphertext. Both safe for pasting.
- **`am config show --resolved`** (`config.ts:138-156`): merges configs but does **NOT** decrypt (it calls `loadResolvedConfig` only, not `interpolateEnvAsync`). Safe. Good.
- **But `am apply --dry-run`** (`apply.ts:122-131`) calls `adapter.export(resolved, {dryRun: true})`. `resolved` is the *decrypted* config (interpolated at `apply.ts:53`). The `--dry-run` path lists file paths but not their content — **safe**, assuming adapters don't log content. I didn't audit every adapter's export. [Risk — audit per-adapter.]

### Silent failures

10. **`generateKey()` + `saveKey()` errors silently fail key generation** if disk is full or OS data dir is not writable. `add.ts:157-161` awaits but has no try/catch — will bubble up through the generic `catch (err)` at line 97. Decent error, but the catch-all at `amError(err, opts)` renders as `error: <message>` with no specific remediation. [SF-9]
11. **Tier-2 betterleaks scan is optional** — `secret-detection.ts:222-228` swallows any error (`try { tier2 } catch {}`). If the user had betterleaks installed but misconfigured, they get Tier-1 only with no warning. [SF-10]
12. **`substituteSecret` on `args` location** — `secret-detection.ts:278-282`. If the secret is in argv (`--args OPENAI_API_KEY=sk-...`), it replaces the value within the arg string. But `--args` is comma-split, so users might accidentally pass `--args OPENAI_API_KEY=sk-,some,thing`, which produces `args = ["OPENAI_API_KEY=sk-", "some", "thing"]` — Tier-1 won't catch this because Tier-1 only scans `env`. Tier-2 betterleaks would, if installed. [SF-11]

### Assumed state

- OS data dir (`~/Library/Application Support/agent-manager/` on macOS) is writable.
- User understands `${VAR}` interpolation.

---

## Journey 4 — Apply to multiple IDEs

User has cursor + claude-code + kiro installed. Runs `am apply`.

### Trace

1. `apply.ts:30-42`: resolve config dir, project file, load resolved config. If no config → `AmError("Config not found", "Run `am init`...")`.
2. `apply.ts:46-49`: resolve profile (CLI flag > state file > `settings.default_profile` > `"default"`).
3. `apply.ts:52-55`: `loadKey(configDir)` — **returns null if no key file**. Passes `encryptionKey ?? undefined` to `interpolateEnvAsync`.
4. `apply.ts:56-58`: interpolation warnings are `debug()` only — hidden unless `-v`.
5. `apply.ts:60`: `buildResolvedConfig(interpolated, profileName, configDir)`.
6. `apply.ts:64-77`: adapter resolution. Without `--target`, calls `getDetectedAdapters()` (`registry.ts:125`). Any adapter that's not detected is silently skipped. If NONE detected, user sees `info("No tools detected. Nothing to apply.")` (line 80) and command exits 0.
7. `apply.ts:90-141`: for each detected adapter:
   - If `--diff`: call `adapter.diff(resolved)`, print human summary.
   - `adapter.export(resolved, {projectPath, dryRun})`.
   - On success: `info("<adapter>: wrote N file(s)")`. On throw: `info("<adapter>: <error>")` — *info*, not error.

### Rough edges

- **No decryption ⇒ enc:v1: values pass through unchanged.** If the user removed/rotated the key but still has `enc:v1:` values in `settings.env`, `apply.ts:52-55` passes `encryptionKey: undefined` and the `${VAR}` refs resolve to the ciphertext string (or remain unresolved if `settings.env` is the source). Adapters then write `OPENAI_API_KEY = "enc:v1:..."` into `~/.claude.json` or `.cursor/mcp.json`. **High-impact silent failure.** [SF-12]
- **`--target <adapter>` error is AmError with suggestion** (good). `--target nonexistent` prints `error: Adapter "nonexistent" not found` + suggestion. Exit 1. [OK]
- **No atomicity across adapters.** If adapter A writes then adapter B throws, A's changes stay. `apply.ts:136-140` catches per-adapter, so B's error becomes one `info(...)` line. No rollback. **Partial-success is indistinguishable from full-success without reading all lines.** [SF-13]
- **Per-adapter errors are `info()`** (line 138), which means `--quiet` suppresses them. A scripted call with `--quiet` would miss "cursor: export failed: permission denied" entirely. [SF-14]
- **Exit code for partial failure is 0.** The only path that sets `process.exitCode = 1` in `apply.ts` is the outer `amError` catch (line 146-149). A per-adapter export failure leaves exit 0. [SF-15]
- **`--dry-run` output shape inconsistent with real run.** Dry-run lists every file path indented (line 128-130); real run shows just the count (line 123). Users can't easily diff them.
- **No indication which adapters *would* be applied before running.** There's no `am apply --list-targets`. The user runs `am apply` and sees output for whatever got detected — no preview.
- **`adapter.diff()` throw is caught and masked** — `apply.ts:104-106` `catch { debug(...); }`. Debug is `-v`-only. If diff breaks for an adapter, user doesn't know. [SF-16]

### Silent failures

12. **Missing key silently bypasses decryption** — `apply.ts:52-55`. [SF-12]
13. **Partial-apply leaves exit 0** — `apply.ts:136-149`. [SF-13, SF-15]
14. **`--quiet` hides per-adapter errors** — `apply.ts:138`. [SF-14]
15. **diff throw masked under debug** — `apply.ts:104-106`. [SF-16]
16. **Adapter not installed → silently skipped.** If user installed cursor but removed it, `getDetectedAdapters()` drops it silently. No "cursor was in your config but is no longer installed" warning. [SF-17]
17. **`resolveProjectConfig` walks up to filesystem root** (`config.ts:28-41`). If the user has a stray `.agent-manager.toml` in a parent directory, it gets picked up silently. No warning that the path differs from CWD. [SF-18]

### Assumed state

- Adapters' `detect()` methods are truthful and fast. `getDetectedAdapters()` calls every known adapter's detect (`registry.ts:127-136`) sequentially.
- Write permissions on `~/.claude.json`, `~/.cursor/mcp.json`, etc. No pre-flight check.

---

## Journey 5 — Diff & undo

User edits `am` config (or runs `am add`), applies, then regrets. `am diff` vs `am undo`.

### Trace

1. **There is no top-level `am diff` command.** `src/cli.ts:24-57` has no `diff` entry. The only diff UX is `am apply --diff` (`apply.ts:93-107`) and `am status` (`status.ts:56-71`).
2. `am undo` (`undo.ts`):
   - `gitLog(configDir, 2)` — needs >=2 commits.
   - `undo.ts:28-32`: if < 2 commits, prints `error: Nothing to undo — only the initial commit exists` and exits 1. [OK]
   - `undo.ts:37`: `revertHead(configDir)` — implemented in `git.ts:99-152`. Walks parent tree, writes all parent files to workdir, removes files that don't exist in parent, commits as `revert: <old message>`. This is a **file-level revert**, not a git revert command.
   - `undo.ts:38-39`: `info("Reverted: \"<old message>\"")`, `info("Run \`am apply\` to regenerate native configs")`.

### Rough edges

- **No `am diff` command.** Users expect a `diff` subcommand from chezmoi (the elevator-pitch referenced in `cli.ts:11`). They get `am apply --diff` and `am status`. The ROADMAP / help does not clarify this. [UX-1]
- **`undo` reverts the *catalog*, not the applied IDE configs.** `undo.ts:39` instructs the user to run `am apply` manually. If they forget, `~/.claude.json` still has the change that the catalog no longer references. **Catalog and IDE state silently drift.** [SF-19]
- **`undo` is single-step, no `--to <oid>` or `--n 3`.** A user who wants to undo "the last 3 commits" must run `am undo` three times.
- **`undo` doesn't restore the encryption key.** If the user rotated their key between commits, `revertHead` restores the *old* ciphertext but leaves the *current* key in place. Decryption on the next `apply` silently fails (key mismatch → `decryptValue` at `secrets.ts:194-204` throws `OperationError`). That throw propagates through `interpolateEnvAsync` back to `apply.ts`, where the top-level catch at line 146 emits a generic `error: ... OperationError` — unhelpful.
- **`undo` can't cross history carefully.** `git.ts:99-152` loads *all* files from parent and writes them. No diff preview, no `--dry-run`.
- **`am log`** (`src/commands/log.ts`) — let me verify:

<br/>

Cross-checking `log.ts` shows it calls `gitLog(configDir, limit)` — simple list. No `--oneline` vs `--verbose` distinction noted here; user has to reformat mentally.

### Silent failures

18. **`am undo` does NOT trigger `am apply`** — only prints a reminder (`undo.ts:39`). A user who skips the reminder ends up with catalog/IDE drift. [SF-19]
19. **Key mismatch after undo produces a generic crypto error** — no guidance toward "you rotated your key; the old ciphertext can't be decrypted". [SF-20]
20. **`revertHead` uses `DEFAULT_AUTHOR = { name: "agent-manager", email: "am@localhost" }`** (`git.ts:5, 146-151`). Inconsistent with user's git identity; breaks commit signing policies on their remote. No config hook. [SF-21]

### Assumed state

- Config dir is a valid git repo (`initRepo` was run).
- `git.log depth 2` returns at least the initial commit + one change.
- User will read the "Run `am apply` to regenerate" hint.

---

## Journey 6 — Running a flow / delegate

`am flow run foo` or `am run claude "fix tests"`.

### Trace — `am run claude "fix tests"`

1. `src/cli.ts:53` → `src/commands/run.ts`.
2. `run.ts:396-406`: ensure prompt provided.
3. `run.ts:407-418`: `runAgent({agent: "claude", prompt: "fix tests", ...})`.
4. `run.ts:91`: timeout default 300s.
5. `run.ts:93`: `loadRegistryContext()` reads `config.toml` (may be missing — not checked explicitly).
6. `run.ts:96-104`: `resolveAgentAsync("claude", registryConfig, configDir)` — walks: config agents → built-in ACP → A2A roster (`agent-registry.ts:113-176`). For `"claude"`, built-in has command `npx -y @agentclientprotocol/claude-agent-acp@latest` (`agent-registry.ts:43`).
7. `run.ts:108`: `createAcpClient()`.
8. `run.ts:111-114`: if `--no-auto-approve`, set permission policy to `"deny"`. **Default is `"auto-approve"` — permission requests are silently approved.** This is a security gate with the default set to "permissive".
9. `run.ts:130-139`: `client.connect(entry.acp.command, {initTimeout: 30_000})` — spawns the subprocess. On failure, throws → caught at line 200, `error(...)` + exit 1.
10. `run.ts:141-157`: new or loaded session.
11. `run.ts:161-169`: prompt with timeout.
12. `run.ts:176-199`: format and print result.

### Trace — `am flow run foo`

1. `src/cli.ts:54` → `src/commands/flow.ts:18`.
2. `flow.ts:29-56`: parse optional JSON input, **dynamic `import(flowName)`**.
3. `flow.ts:47-56`: `import()` failure → `error("Could not load flow ...")` + exit 1.
4. `flow.ts:58-66`: validate exported shape.
5. `flow.ts:69-109`: run via `runFlow(flowDef, {acpExecutor: ...})`. The executor creates a new `AmAcpClient` per-node (`flow.ts:79-89`).
6. `flow.ts:89`: `client.disconnect().catch(() => {})` — swallows disconnect errors.

### Rough edges

- **Default `--no-auto-approve` is OFF**, i.e., the CLI auto-approves every permission request the agent makes (file write, terminal, arbitrary shell). `run.ts:377-381` documents this: "Deny all permission requests from the agent (default: auto-approve)". For an unattended user, this is the riskiest default in the codebase — an agent can `rm -rf $HOME` and `am` will approve. [UX-3 / security]
- **Auth gate is not enforced.** There's no "agent foo wants network access; accept? [y/N]". The only gate is the permission-policy switch, and it's a binary at connection time.
- **Unknown agent error is clear** (`run.ts:98-104`): `error("Unknown agent "<name>" or no ACP (local) endpoint. Run \`am run agents\` to list available agents.")`. [OK]
- **Session is "tracked" via the ACP SDK**, but `am run` with `--session <name>` tries `loadSession(name)` and falls back to creating a new one with the name (`run.ts:143-157`). **This means typos in session names silently create new sessions** — the user thinks they resumed but started fresh. [SF-22]
- **`am run` doesn't check if the agent binary is installed before spawning.** It trusts the command string from the registry. `npx -y ...` handles "not installed" by auto-installing, but `gemini --acp` (built-in entry at `agent-registry.ts:45`) assumes gemini CLI is on PATH. Spawn error gets propagated as a generic `error: Agent run failed: ...`.
- **`am flow run <name>`** uses `import(flowName)` which resolves via Node's module resolution. A user typing `am flow run my-flow` expects a file in a `flows/` dir, but the module resolution is `import("my-flow")` — likely to fail unless the user passes an absolute path or the flow is a published package. [UX-4]
- **Flow runs are written to `~/.agent-manager/flows/runs/` by default** (`flows.ts:137-139`). This is **a different location from `resolveConfigDir()` which defaults to `~/.config/agent-manager/`**. The `.agent-manager` directory in `$HOME` is nonstandard and will confuse users who look in `~/.config/agent-manager/`.
- **`am flow run` has no `--dry-run`.** The only way to preview what the flow will do is to read the code.
- **`detectCycles` runs before flow execution** (`flows.ts:365-368`) — prints a helpful `Cycle detected in flow: A → B → A`. [OK]
- **Flow executor creates a new AcpClient per ACP node**, connecting and disconnecting each time (`flow.ts:79-89`). No connection reuse. Latency x N.
- **`disconnect().catch(() => {})`** (`flow.ts:89`) silently swallows disconnect failures, possibly leaving zombie subprocesses. [SF-23]

### Silent failures

21. **Named-session typos fall through to new session** — `run.ts:143-157`. [SF-22]
22. **Default permission policy is auto-approve** — no verbose warning at connect time. [SF — security default, not strictly a failure]
23. **Flow disconnect errors swallowed** — `flow.ts:89`. [SF-23]
24. **Flow dynamic import uses bare module resolution** — ambiguous and unpredictable from the CLI's perspective. Users can't tell why `flow run foo` failed.

### Assumed state

- `config.toml` exists (soft-assumed; `tryReadConfig` returns null which is OK for built-in agents, but breaks config-override agents).
- Agent binary is on PATH or resolvable via npx.
- `~/.agent-manager/flows/runs/` is writable.

---

## Cross-journey patterns

### Silent-failure inventory (23 distinct)

Grouped by class:

**A. Errors swallowed by empty `catch {}`:**
1. `commitAll` in `add.ts:177`, `import.ts:468`, `secret.ts:94`, `secret.ts:381`, `add.ts:258` — 5 sites, all swallow *every* git error shape, not just "nothing to commit".
2. `scanServerWithBetterleaks` throw in `secret-detection.ts:222-228`.
3. `adapter.diff` throw masked behind `debug()` in `apply.ts:104-106`.
4. `flow.ts:89` `client.disconnect().catch(() => {})`.

**B. Errors downgraded to `info()`:**
5. Adapter `import()` throw in `import.ts:152-157`.
6. Adapter `export()` throw in `apply.ts:136-140`.
7. Brownfield fuzzy conflicts are emitted as `info("  warning: ...")` at `import.ts:211-214` — `--quiet` hides them.
8. Scan warning for `--no-encrypt` in `import.ts:445-456` — `info()`, not stderr.
9. `claude-code/import.ts:94` "File not found" warning — indistinguishable from "file empty".

**C. Missing resources silently skipped:**
10. `getDetectedAdapters()` silently drops adapters that don't `detect()` — no "I expected cursor but it's gone" warning. `apply.ts:76`.
11. Profile filter no-ops if profile doesn't exist (`config.ts:289`).
12. Missing encryption key in `apply` → `enc:v1:` values pass through verbatim into generated IDE configs. `apply.ts:52-55`.
13. Missing `~/.claude.json` in `import claude-code` → 0 servers imported, warning only.

**D. State drift:**
14. `am undo` reverts catalog but not IDE configs. `undo.ts:39`.
15. Key rotation + `am undo` → decryption error with unhelpful message (`secrets.ts:202`).
16. Fuzzy-matched brownfield import gets skipped; user has to know to run `--report` to see what was skipped.
17. `resolveProjectConfig` walks up filesystem; stray parent `.agent-manager.toml` silently wins.

**E. Incorrect exit codes:**
18. Partial-apply (3 adapters, 1 fails) exits 0. `apply.ts`.
19. `am import` with all adapters failing exits 0 (each failure is a warning).
20. `am flow run` with `client.disconnect()` failure exits 0.

**F. Security / UX defaults:**
21. `am run`'s permission policy is auto-approve by default. `run.ts:111-114`.
22. Named-session typo creates new session silently. `run.ts:143-157`.
23. Auto-encrypt generates key silently if missing (`import.ts:412-421`, `add.ts:156-161`). No "you should back up this key" prompt.

### Message-shape inconsistency

- **`error()`** writes to stderr with prefix `error: ...` (`output.ts:17-20`). Used for top-level errors.
- **`info()`** writes to stdout, suppressed by `--quiet` (`output.ts:13-15`). Used for almost everything, including warnings (!). This means `--quiet` hides warnings.
- **`debug()`** writes to stdout, only with `--verbose` (`output.ts:30-32`). Should probably be stderr.
- **`amError()`** uses `formatError(..., json)` — the only path that properly routes to stderr with JSON shape (`errors.ts:36-54`).

Result: a scripted caller that does `am apply --json --quiet` gets *no output at all* for partial failures. A scripted caller that does `am apply --json` gets the final JSON but misses all the `info()` warnings emitted during the run.

### Missing "next step" hints

| Command | Success hint | Failure hint |
|---------|-------------|--------------|
| `am init` | Only if detected tools (`init.ts:124-126`) | — |
| `am add server` | None | None |
| `am import` | Summary only (`import.ts:475`) | Only `--report` is hinted in docs |
| `am apply` | Only `--dry-run` lists files | Per-adapter errors are `info()` |
| `am undo` | `Run \`am apply\` to regenerate` (`undo.ts:39`) | — |
| `am secret set` | None (`secret.ts:100`) | `Run \`am secret generate-key\`` if no key |
| `am secret scan` | `Run \`am secret scan --fix\`` (`secret.ts:334`) | None |
| `am run` | None | `Run \`am run agents\`` if unknown agent |
| `am flow run` | None | None |

Most success paths lack "what to do next". `am apply` especially should say "to share this config, `git push` to your remote" or similar.

### Assumed state

Multiple commands silently assume `am init` was run. Trace:

- `am add` → `requireConfig` throws `AmError("Config not found")` [OK]
- `am apply` → `AmError("Config not found")` [OK]
- `am import` → `AmError("Config not found")` [OK]
- `am secret get/set/list` → `error("No encryption key found. ...")` [OK but inconsistent shape]
- `am undo` → `error("Cannot read git log. Run \`am init\` first.")` [OK]
- `am log` → (unchecked — likely similar)
- `am flow run` → `loadRegistryContext` silently returns `registryConfig = undefined`. A config-override agent isn't available, but built-in ACP agents still work. User sees no warning that they're using a built-in default. [minor]

---

## Recommended UX fixes (prioritized, small first)

### Quick wins (< 1 hour each)

1. **Print `config.toml` path and `settings.env` hint on `am init` success, always.** `init.ts:122-126`. Add "Config file: <configDir>/config.toml" and "Add a server: `am add server <name> --command <cmd>`". Unconditional, not gated on detected tools.

2. **Separate "nothing to commit" from "commit failed".** Replace the 5 bare `catch {}` blocks around `commitAll` (`add.ts:177`, `import.ts:468`, `secret.ts:94`, `secret.ts:381`, `add.ts:258`) with a check on the error message (`err.message === "Nothing to commit"`) and re-throw otherwise. `git.ts:51` already throws `Error("Nothing to commit")`.

3. **Route `info()` warnings to stderr (or rename them).** The pattern `info("  warning: ...")` should become `warn()` that writes to stderr and is *not* suppressed by `--quiet`. Add `warn()` to `output.ts`. Use in `import.ts:481-485`, `apply.ts:133-135`, `apply.ts:138`.

4. **`debug()` should write to stderr.** `output.ts:30-32` currently writes to stdout. This pollutes JSON output for verbose users and hides messages in pipes.

5. **Make partial-apply non-zero exit.** `apply.ts:136-140` should set `process.exitCode = 1` if any adapter export throws. Even better: sum errors and exit 1 if any failed.

6. **Add a "you should back up this key" warning when auto-generating.** `import.ts:412-421`, `add.ts:156-161`, `secret.ts:345-351`. One extra `warn()` line: "Key saved at <path>. Back this up — losing it means losing access to encrypted secrets."

7. **Warn on unresolved `${VAR}` and `enc:v1:` pass-through in `apply`.** `apply.ts:52-58` currently makes interpolation warnings `debug()` only. Upgrade to `warn()` when `enc:v1:` is detected without a key, with suggestion "Run `am secret generate-key` or set AM_ENCRYPTION_KEY".

### Medium wins (1-4 hours each)

8. **Add top-level `am diff`.** Alias for `am apply --dry-run --diff` or dedicated command that reads state file and adapter current state. Matches chezmoi mental model. `cli.ts:24-57` needs the new entry.

9. **Make `am undo` run `am apply` automatically (or prompt).** Currently `undo.ts:39` tells the user to do it manually — silent drift if forgotten. Either auto-apply or prompt "Regenerate IDE configs now? [Y/n]".

10. **Named-session typo detection.** `run.ts:143-157` should `loadSession` and only fall back to new if the user passed `--new-session`. Otherwise fail with suggestion "Session <name> not found. Use --new-session to create, or `am run session list claude` to see existing."

11. **`--dry-run` on `am import`** (independent of `--report`). Runs the full pipeline including secret scan, prints what *would* be written, without writing. `--report` is a subset.

12. **Explicit "next step" hints across all success paths.** Centralize in a `nextStep()` helper. Every command ends with 1-2 suggestions. `add` → "`am apply` to generate configs". `secret set` → "now referenced as ${NAME}". etc.

13. **`am apply` should print a summary table when targeting multiple adapters.** Current per-adapter lines are hard to scan. Something like:
    ```
    cursor        ok     3 files
    claude-code   drift  5 files (use --force or fix first)
    kiro          fail   permission denied on ~/.kiro/config
    Total: 2 ok, 1 failed. Exit 1.
    ```

### Bigger UX investments

14. **Permission policy for `am run` should default to prompt (or explicit-approve).** Currently auto-approve is the default (`run.ts:379-381`). Change default to prompt for tool categories (file, terminal, network). Keep `--auto-approve` for explicit opt-in.

15. **`am apply` atomic mode (`--atomic` or `--all-or-nothing`).** Write to temp files first, rename all at end. If any adapter fails, roll back. Needs per-adapter transactional export — bigger refactor.

16. **Split brownfield/greenfield import into explicit commands or prompts.** When `isBrownfield` is true (`import.ts:143`), default to `--report` and require `--merge` to actually apply. Avoid silent merges.

17. **`am doctor` should audit generated IDE configs for drift, not just local config.** It runs adapter `detect()` but doesn't run `adapter.diff()`. Adding diff would catch "you applied, then edited `~/.claude.json` by hand".

18. **Flow runs live in the *right* dir.** Move `~/.agent-manager/flows/runs/` to `<configDir>/flows/runs/`. `flows.ts:137-139`. Matches user expectation that all am state is in one place.

---

## File citations (summary)

| Finding | File:Line |
|---------|-----------|
| `commitAll` swallowed | `src/commands/add.ts:177`, `src/commands/import.ts:468`, `src/commands/secret.ts:94`, `src/commands/secret.ts:381`, `src/commands/add.ts:258` |
| Adapter export error → info | `src/commands/apply.ts:136-140` |
| Adapter import error → info | `src/commands/import.ts:152-157` |
| Missing key, enc:v1 passthrough | `src/commands/apply.ts:52-55`, `src/core/secrets.ts:299` |
| Interpolation warnings hidden | `src/commands/apply.ts:56-58` |
| Per-adapter exit code 0 | `src/commands/apply.ts:136-149` |
| No top-level `am diff` | `src/cli.ts:24-57` |
| `am undo` doesn't apply | `src/commands/undo.ts:37-39` |
| Default permission auto-approve | `src/commands/run.ts:377-381`, `src/protocols/acp/client.ts:79` |
| Named-session typo → new session | `src/commands/run.ts:143-157` |
| Flow runs dir mismatch | `src/protocols/acp/flows.ts:137-139` vs `src/core/config.ts:20` |
| Config not found → AmError | `src/lib/errors.ts:59-70` |
| `info()` suppressed by `--quiet` | `src/lib/output.ts:13-15` |
| `debug()` to stdout | `src/lib/output.ts:30-32` |
| Profile filter no-op | `src/core/config.ts:289-291` |
| Legacy key migration writes to stderr unconditionally | `src/core/secrets.ts:152` |
| `extractServerIdentity` best-effort | `src/commands/import.ts:34-72` |
| Brownfield detection heuristic | `src/commands/import.ts:143` |
| Fuzzy conflicts as warnings | `src/commands/import.ts:211-214` |
| Auto-generate key silently | `src/commands/import.ts:412-421`, `src/commands/add.ts:156-161` |
| `detectCycles` pre-flight | `src/protocols/acp/flows.ts:365-368` (good) |
| `revertHead` uses default author | `src/core/git.ts:5,146-151` |
| `resolveProjectConfig` walks to root | `src/core/config.ts:28-41` |
