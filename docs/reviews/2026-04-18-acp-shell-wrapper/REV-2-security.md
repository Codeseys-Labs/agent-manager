# REV-2: Post-rc5 Security Review

**Date:** 2026-04-18
**Scope:** New/changed code since iter4 Wave B–D, plus Phase B (shim-wrapper) prelaunch risk.
**Reviewer:** Agent (Opus 4.7 1M).
**Method:** Targeted read of `src/protocols/acp/client.ts`, `src/mcp/server.ts`, `src/core/secrets.ts`,
`src/core/atomic-write.ts`, `src/core/agent-detection.ts`, `src/lib/redact.ts`,
`src/marketplace/{installer,security,client}.ts`, `src/commands/mcp-serve.ts`,
`src/adapters/claude-code/export.ts`, and the Phase-B ADR (`ADRs/0033-acp-agent-tiers-and-shim-wrapper.md`).

---

## Summary

**Security posture score: 7 / 10.**

The iter2-Wave 2.B/2.C/2.A hardening is holding. Master-key relocation, marketplace SHA
pinning + TOFU, Zod input validation on MCP tools, and the path-traversal checks in
`safeResolveInsidePlugin` are all intact. rc5's ACP stdin wrapper closes the runtime
crash that blocked end-to-end use.

What drops the score below "confident ship":

1. **Progress notifications bypass redaction** — raw ACP/A2A update objects are serialised
   straight into `notifications/progress` frames (`src/mcp/server.ts:2843-2854`). An ACP
   agent that echoes a `sk-ant-…` key in a text chunk leaks it to every streaming MCP
   client. The per-call error path (line 2867) redacts; the streaming path does not.
2. **`am apply` silently deletes sibling `mcpServers` entries** — `{...existing, mcpServers}`
   at `src/adapters/claude-code/export.ts:145` replaces the whole object, and the
   existing test (`test/adapters/claude-code/export.test.ts:173`) bakes that behaviour
   in. Users are told by README L35 that am does "intelligent merge" of IDE configs.
   This is a broken promise with real data-loss potential when secret-bearing MCP
   servers were added manually.
3. **Env-var leakage into ACP subprocesses** — `Bun.spawn` at
   `src/protocols/acp/client.ts:133` and `createTerminal` at line 511-513 inherit
   agent-manager's full env, including `AM_MCP_TOKEN`, `AM_ENCRYPTION_KEY`, and any
   bearer tokens configured upstream. Phase B shim-wrapper makes this materially worse
   because the wrapped target (aider, q, cody) is a **separate** tool whose log verbosity
   is outside our control.

No CRITICAL findings. The score would be 8 with (1) fixed, 9 with (1)+(2) fixed, and
9–10 once the Phase-B env-scrubbing recommendation in §"Shim-wrapper prelaunch concerns"
lands before the wrapper ships.

---

## New findings since iter4

### HIGH-1 — Progress notifications relay un-redacted agent output

**Severity:** HIGH.
**File:** `src/mcp/server.ts:2254-2257, 2310-2313, 2843-2854`, default sink at 2480-2486.

```ts
// src/mcp/server.ts:2252-2257 — ACP update forwarder
client.onSessionUpdate((update: unknown) => {
  ctx.emitProgress({
    message: { kind: "acp.session_update", sessionId, agent: agentName, data: update },
  });
});
```

```ts
// src/mcp/server.ts:2843-2854 — sink construction
emitProgress: (payload) => {
  if (progressToken === undefined) return;
  sink({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: {
      progressToken,
      ...(payload.message !== undefined ? { message: payload.message } : {}),
    },
  });
},
```

```ts
// src/mcp/server.ts:2480-2486 — default sink
private progressSink: ProgressSink = (notif) => {
  try {
    process.stdout.write(`${JSON.stringify(notif)}\n`);
  } catch { /* ... */ }
};
```

The ACP `update` object contains `agent_message_chunk` content with arbitrary text
written by the agent (which in turn may be echoing `~/.claude.json`, the contents of
`.env`, or a prompt paste from the user that includes credentials). The MCP error
path at line 2867 calls `safeErrorMessage` (which applies `redactSecretish`); the
success-plus-progress path does not touch the `update` payload.

**Attack scenario.** User runs `am run claude "print my AWS creds file"` over an
`am mcp-serve` session from a third-party IDE. The agent streams the file contents
as a sequence of `agent_message_chunk`s. Each chunk becomes a
`notifications/progress` frame on stdout without any filtering. The third-party IDE
logs MCP traffic to a debug file, and the AKIA key ends up on disk outside am's
trust boundary. Even more concretely: the A2A streaming path (line 2310-2313)
forwards raw task-status/artifact events that can contain auth headers from the
remote agent's side channel (e.g., echoed back by a misbehaving agent).

**Fix.** Apply `redactSecretish` to the `message` payload before emitting. The
simplest place is in `emitProgress` itself — walk the payload once and replace any
string that matches a secret pattern. Because `update` can be deeply nested, reuse
the `redactConfigSecrets`-style walker but feed strings through `redactSecretish`
rather than the encrypted-sentinel check.

**Test.** Extend `test/mcp/mcp-progress.test.ts` (if present) to emit an
`agent_message_chunk` containing a fake `sk-ant-FAKE…` and assert the emitted
progress frame carries `[REDACTED_ANTHROPIC_KEY]`.

---

### HIGH-2 — `am apply` silently deletes unmanaged MCP server entries

**Severity:** HIGH (data-loss / secret-exposure reversal).
**File:** `src/adapters/claude-code/export.ts:145`.

```ts
const output = { ...existing, mcpServers };
```

The `existing` read at line 117 captures every field from `~/.claude.json` including
user-added `mcpServers`. The merge replaces the whole `mcpServers` object with the
one derived from the am catalog. Any server the user added directly via
`claude mcp add`, a manual edit, or from another tool's wizard is dropped. The test
at `test/adapters/claude-code/export.test.ts:173` asserts this behaviour
(`expect(parsed.mcpServers.old).toBeUndefined()`), so it is intentional — but the
README (L35) advertises "intelligent merge." The two do not agree.

**Security relevance.** Users frequently have one-off, secret-bearing MCP servers in
`~/.claude.json` that they deliberately did *not* store in the am catalog
(encrypted or not) — e.g., a personal Slack token for a personal workspace. Running
`am apply` deletes that entry. A subsequent `am sync push` stores only the managed
set, so the dropped entry is unrecoverable from the git history. Users report this
as a "config wipe" (see the 2026-04-15 incident referenced in project memory).

**Fix.** One of:
- Merge strategy: `mcpServers: { ...(existing.mcpServers ?? {}), ...mcpServers }` so
  unmanaged entries survive. Risk: stale managed entries the user removed from the
  catalog linger. Acceptable if `am uninstall` cleans them explicitly.
- Scoped replace: only remove entries whose name matches `_marketplace.package` of
  something we manage, leaving untagged entries alone.
- Document the current behaviour in `docs/apply.md` and emit a warning before
  overwriting non-empty sibling entries with `--dry-run`/`--force` gating.

I recommend option 2 (provenance-gated replace) because option 1 turns uninstall
into a multi-step operation and option 3 still leaves the default footgun armed.

---

### HIGH-3 — Env leak from parent into ACP subprocess and terminals

**Severity:** HIGH (pre-Phase-B); critical once Phase B lands without a fix.
**Files:** `src/protocols/acp/client.ts:133` and `:511-513`.

```ts
// client.ts:129-134 — agent subprocess
const proc = Bun.spawn([executable, ...args, ...extraArgs], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
  env: { ...process.env, ...opts?.env },    // full inherit
});
```

```ts
// client.ts:507-516 — agent-requested terminal
async createTerminal(params: CreateTerminalRequest) {
  const { executable, args } = parseCommand(params.command);
  const proc = Bun.spawn([executable, ...args], {
    cwd: params.cwd ?? undefined,
    env: params.env
      ? Object.fromEntries(params.env.map((e) => [e.name, e.value]))
      : undefined,                          // undefined => full inherit
    stdout: "pipe",
    stderr: "pipe",
  });
```

When `am mcp-serve` is started with `AM_MCP_TOKEN=…` and launches a tool call that
resolves to the ACP route, the spawned agent subprocess receives
`AM_MCP_TOKEN`, `AM_ENCRYPTION_KEY`, `AWS_SESSION_TOKEN`, and every other secret
that was in the parent environment. If the agent logs its env for debugging
(claude-agent-acp currently does not, but we can't rely on that across Tier-2
wrappers), the bearer token that was supposed to gate write-tier tools is now in
a logfile outside am's trust boundary.

**Attack scenario.** A user enables Tier-2 `aider` wrapper in Phase B. They run
`am run aider "edit foo.ts"`. aider's default logging (`--verbose` or its crash
dump) writes `env: {…}` to `~/.aider.chat.history.md`. `AM_MCP_TOKEN` is now
pasteable from that file by anyone who reads the user's chat history, and an
attacker who got RCE on the user box could use it to turn `am mcp-serve`'s
write-local tools into a config-wipe vector.

`createTerminal` is even worse because the agent controls what to spawn — an
agent that wants to exfiltrate credentials can issue
`createTerminal({ command: "printenv", env: undefined })`, collect the output,
and send it anywhere via a subsequent `writeTextFile`.

**Fix.**

1. **Scrub before spawn.** Add an explicit allowlist in `client.ts:connect()`:
   start from `{ PATH, HOME, USER, LANG, TMPDIR, SHELL }` plus whatever the agent
   genuinely needs, then overlay `opts?.env`. Drop everything else.
2. **Same fix for `createTerminal`.** When `params.env` is `undefined`, pass a
   scrubbed env — not the parent's full env. Agents that need a var should pass
   it explicitly.
3. **Explicit deny-list for am vars.** Always strip `AM_MCP_TOKEN`,
   `AM_ENCRYPTION_KEY`, `AM_KEY_PATH`, `AWS_SESSION_TOKEN`, `ANTHROPIC_API_KEY`,
   and anything matching `^(.*_)?(TOKEN|SECRET|KEY|PASSWORD|CRED)$` before
   handing env to a spawned process.

Option 3 is a minimum; option 1+3 is the right shape.

---

### MEDIUM-1 — PATH-resolved agent binary trusted without location check

**Severity:** MEDIUM.
**File:** `src/core/agent-detection.ts:111-114, 137`.

```ts
let whichFn: WhichFn = (name: string) => (Bun.which(name) as string | null) ?? null;
// …
const resolved = whichFn(binary);
const hit: AgentDetection = resolved
  ? { installed: true, source: "path", binary: resolved }
  : { installed: false, source: "none" };
```

`Bun.which` honours the inherited `PATH`. A hostile `.envrc`
(direnv), shell function, or per-directory PATH shim (e.g., a project `bin/`
folder added by `make setup`) can put a fake `claude` binary first on PATH. The
detection layer records it as `installed`, and a subsequent `am run claude` spawns
it via `parseCommand(entry.command)` + `Bun.spawn`.

For Tier-1 agents this matters because the user thinks "am run claude" runs their
vetted claude-agent-acp; a project-local shim instead gets the full subprocess
environment (including secrets per HIGH-3) and speaks ACP to our client with
whatever lies it wants.

**Mitigation options.**

1. Warn on first use when the resolved binary is outside a "known-good" root:
   `/usr/local`, `/opt/homebrew`, `~/.npm-global`, `~/.volta`, `~/.local`,
   `~/.cargo/bin`, `%ProgramFiles%`. Everything else prints a one-line stderr
   warning and requires `--allow-shim` to proceed.
2. Pin the absolute path on first detect, store in `~/.local/share/agent-manager/
   agent-paths.json`, and refuse to spawn a different path on subsequent
   invocations without `--update-path` flag.
3. Surface `binary` in `am agent detect <name>` output so the user can eyeball it.

Option 2 is the highest-confidence fix and composes with Phase B's shim config.
Option 1 is the cheap first pass.

**Attack scenario.** User `git clone`s a malicious repo that includes
`direnv` setup adding `./.bin` to PATH. The repo ships `./.bin/claude` that speaks
ACP, claims to be real claude, and uses its privileges as an ACP agent to write
`~/.ssh/authorized_keys` (subject to HIGH-3 env-leak compounding the damage).

---

### MEDIUM-2 — `applyPlugin` is exported without a pin-verification gate

**Severity:** MEDIUM.
**File:** `src/marketplace/installer.ts:108`.

The `installPlugin` function (line 49) calls `verifyMarketplacePin` before
`applyPlugin`. But `applyPlugin` itself is `export function` — callers outside
this module can invoke it without the pin check. Today nobody does; a future
contributor might.

**Fix.** Rename `applyPlugin` to `_applyPluginUnchecked`, keep it internal, or
add a paranoid runtime check at the top: if `plugin.marketplace` resolves to a
registered entry, `verifyMarketplacePin` is called; otherwise throw. Cheap
insurance against a future refactor.

Also double-check: `pluginDir` is derived from the scanner; if the scanner ever
starts pointing at untrusted paths (e.g., a future local-filesystem marketplace),
`safeResolveInsidePlugin` still protects each path-valued field, but an attacker
could still register arbitrary servers/agents through `applyPlugin` because
nothing else reads the manifest's `command`/`args` fields critically. That's
out of scope for this review but worth tracking.

---

### MEDIUM-3 — `am mcp-serve --allow-unsafe-local` is silently enabled in test/in-process paths

**Severity:** MEDIUM (user-facing docs) / LOW (runtime).
**File:** `src/mcp/server.ts:2522-2546`.

```ts
// Wave B (2026-04-16) flipped the default to strict.
constructor(opts?: { auth?: AuthConfig; enforceInitGate?: boolean }) {
  this.tools = defineTools();
  this.auth = opts?.auth ?? { token: undefined, allowUnsafeLocal: false };
  // …
}
```

The default is secure (write tools refused). `am mcp-serve` wires through
`loadAuthConfig()` so the CLI path is correct. However:

1. The `--allow-unsafe-local` flag (`src/commands/mcp-serve.ts:10-15`) has a
   **quiet** description and no prominent on-startup warning. A user who runs
   `am mcp-serve --allow-unsafe-local` sees no loud stderr banner; nothing tells
   them "write-tier tools are now accessible without a bearer token". Compare
   with `claude --dangerously-skip-permissions` which prints a visible warning.
2. `SECURITY.md` mentions the flag in a single line (L85-86). There is no README
   callout, no startup banner, and no CLI flag "are you sure" gate.
3. No path auto-enables it — good. But anyone instantiating
   `new McpServer({ auth: { allowUnsafeLocal: true } })` programmatically gets
   the full write-tool surface with no auth. Tests legitimately do this; the
   risk is that a future library integration copies the pattern.

**Fix.**

- Print a visible stderr banner when `am mcp-serve --allow-unsafe-local` starts.
  Recommended text: `[am] WARNING: --allow-unsafe-local — any process talking
  stdio to this server can decrypt secrets, invoke am_apply, and edit your
  config. Use AM_MCP_TOKEN for any non-throwaway setup.`
- Add a `SECURITY.md` section "When to NOT use --allow-unsafe-local" with
  concrete examples of threats (agents with write-to-disk capability, CI jobs,
  shared-tty environments).

---

### LOW-1 — ACP stdin wrapper has no backpressure guard against chunk flooding

**Severity:** LOW.
**File:** `src/protocols/acp/client.ts:148-163`.

```ts
const writable = new WritableStream<Uint8Array>({
  write(chunk) {
    stdinSink.write(chunk);
    stdinSink.flush?.();
  },
  // …
});
```

The Web Streams `WritableStream` API supports a `highWaterMark` + `size` strategy
to backpressure upstream producers. The current wrapper ignores that — every
`chunk` is immediately `write`+`flush`'d. If the subprocess's stdin buffer fills
up, Bun's `FileSink.write` returns the number of bytes buffered, but the wrapper
discards that signal. A malicious agent that stops reading (returns data very
slowly while our side keeps sending prompt content in a loop) could force the
wrapper to buffer unbounded chunks in the Bun FileSink's internal queue.

That said: in our architecture, the producer is the ACP SDK, not an attacker.
The SDK is serialising JSON-RPC requests to stdin one at a time, and each
request is small. The theoretical risk becomes real only if we ever accept
user-supplied streamed input (e.g., piping a huge file via `am run claude -f
bigfile`). Worth flagging so the fix is on the roadmap before that feature
lands.

**Abort path check.** The `abort` branch calls `stdinSink.end?.()` which
closes the pipe. `killSubprocess` (line 225) then SIGTERMs and falls back to
SIGKILL after 2 s. The aborting WritableStream → closed stdin → child sees EOF
chain is sound. No leak found on the rc5 error path.

**Fix.** Set `new WritableStream(..., new CountQueuingStrategy({
highWaterMark: 16 }))` and have `write` return a promise that awaits the Bun
FileSink's internal drain. Revisit when we stream large inputs.

---

### LOW-2 — Master-key file mode 0600 honoured on POSIX; Windows semantics differ

**Severity:** LOW (documentation gap).
**File:** `src/core/secrets.ts:102, 180` calling `atomicWriteFile(..., { mode: 0o600 })`.

`atomicWriteFile` (src/core/atomic-write.ts:158) passes the mode through to
`writeFile`. Node's `writeFile` honours `mode` on Windows *only* if the file
doesn't already exist; existing files keep their ACL. On POSIX it's subject to
the process umask but 0600 is strict enough that umask `0o022` still leaves us
at `0o600`.

Two real concerns:

1. **Windows ACLs.** On NTFS, the POSIX mode value translates to a limited ACL
   via Node's abstraction, but group `Users` often retains read access by
   default — especially when the file is created in `%APPDATA%` which inherits
   from the user profile. SECURITY.md L41 claims "The file is always written
   with mode `0600`" which is POSIX-accurate but not quite right on Windows.
2. **umask interaction on Linux.** A pathological umask (`0o000`) still ends
   up at 0600 because `0o600 & ~0` is 0o600, so POSIX is fine.

**Fix.** On Windows, after writing the key, apply a restrictive ACL via
`icacls "%APPDATA%\\agent-manager\\key" /inheritance:r /grant:r "%USERNAME%:R,W"`
or the equivalent N-API / `@napi-rs/icacls` helper. Update SECURITY.md to
clarify the Windows story. Not urgent — Windows support is experimental per
SECURITY.md's tone — but worth a line in a v1 release note.

---

### LOW-3 — Read-only MCP tools still un-auth'd; assume untrusted stdio parent

**Severity:** LOW.
**File:** `src/mcp/server.ts:238-259` (auth gate is tier-scoped).

The bearer-token gate applies only to `write-local` and `write-remote`. Read-only
tools (`am_list_servers`, `am_list_profiles`, `am_status`, etc.) pass through
unauthenticated. The rationale is reasonable — read-only tools don't mutate
anything — but they **do** leak topology information: server names, agent
registrations, A2A endpoints, and (transitively through their output) can
enumerate env-var names that appear in `command`/`args`/`env` fields even if
the values are encrypted.

This is acceptable for a local-only tool with an assumed-trusted user, which
is the documented threat model. If we ever expose `am mcp-serve` over a
network socket the assumption breaks. Worth noting in the README alongside
Phase B so users don't get the wrong idea.

---

## Shim-wrapper prelaunch concerns (for Phase B)

Phase B wraps non-ACP CLIs (aider, q, cody, gh-copilot, cursor-agent, plandex)
behind a headless-CLI shim. Each invocation spawns `aider --yes --message-file -`
or similar, collects stdout, returns one chunk. Security concerns in priority
order:

### PB-1 — Env scrubbing is MANDATORY before Phase B ships

This is the single item that MUST land before the shim wrapper is enabled.

The wrapped tool is not claude-agent-acp — it's somebody else's CLI, written
without the shim's threat model in mind. aider writes `.aider.chat.history.md`
by default and is willing to log its subprocess env when `--verbose` is set.
`q chat` logs to AWS region defaults. Every one of these tools has a different
relationship with `stdout`/`stderr`/`--log-file`.

**Required:** the shim subprocess gets a **minimum-viable** env. Allow-list:
`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `SHELL`, tool-specific
vars the user opts in via `am agent configure <name> --env KEY=value`. Everything
else is scrubbed. No `AM_MCP_TOKEN`, no `AM_ENCRYPTION_KEY`, no wider AWS/GitHub
creds unless the user explicitly opts in per-wrapper.

Wire this in `src/protocols/acp/shell-wrapper.ts` (not yet written). Add a
`SECURITY.md` section for Phase B that calls out: "Tier-2 wrappers do **not**
inherit your shell environment. If your wrapped tool needs `ANTHROPIC_API_KEY`
or `AWS_PROFILE`, add it via `am agent configure aider --env
ANTHROPIC_API_KEY=ref:secret.aider_key`."

### PB-2 — `--yes` / auto-approve bypass ADR-0033 caveat is present but weak

ADR-0033 (L75-80) notes that wrapped flags bypass am's permission UI. Good. But
the ADR does not specify **where** that caveat surfaces to users. `am run
aider` should refuse to execute unless:

1. The user has explicitly `am agent enable-shim aider` (ADR says this already;
   verify it lands in Phase B).
2. `am agent enable-shim` prints the caveat text, requires `--i-understand` or
   an interactive confirmation, and records acknowledgement in
   `~/.local/share/agent-manager/shim-acknowledgements.json` with timestamp +
   am version.
3. Every `am run <tier-2>` prints a one-line reminder the first N times.

Without those, the security caveat in the ADR is a document nobody reads.

### PB-3 — Argv template injection

The ADR describes `aider --message-file - --yes --no-stream --no-pretty <
prompt`. If any flag in that template is a user-controllable string (e.g., the
user's prompt is piped via `--message`-style args instead of a file), argv
injection is possible. Phase B MUST use file-based prompt delivery
(`--message-file /tmp/…`) or stdin — never interpolate user input into argv.

The existing `parseCommand` tokenizer is already hardened against shell
metacharacters. Phase B should reuse it: build the argv as an array, never
`sh -c "$cmd"`.

### PB-4 — Wrapper stdout is untrusted; chunk content must be redacted before MCP emission

Phase B wrappers relay the wrapped tool's stdout as an `agent_message_chunk`.
That stdout is **guaranteed** to contain diagnostic output not intended for an
MCP client — file contents, error traces, auth failures with tokens in them
(aider prints `Authentication failed: AWS_SESSION_TOKEN=…` in some error paths).

This is HIGH-1 (progress notification leakage) applied to the wrapped-CLI
surface, where the risk is higher because we don't control the tool. The fix
from HIGH-1 (redact progress payloads) covers Phase B too if done at the
`emitProgress` boundary.

### PB-5 — Tier-2 wrappers must share the `allowedPaths` restriction

`client.ts:setAllowedPaths` exists for Tier-1 agents' file-read/write requests.
A Tier-2 wrapper that spawns aider has no such guard rails — aider reads and
writes anything the user can. This is not a Phase-B-introduced regression (aider
does this standalone), but the Phase-B plan should document that enabling a
Tier-2 wrapper neutralises the `allowed_paths` setting for that agent. Or: the
wrapper spawns the tool with `cwd` limited to `allowed_paths[0]` and warns when
the tool cd's elsewhere (defence-in-depth, not a real guarantee).

---

## Progress-notification payload handling

Summary: **not redacted today, must be before Phase B ships.**

Grep `grep -rn "emitProgress\|notifications/progress" src/`:

```
src/mcp/server.ts:99   ToolContext.emitProgress definition
src/mcp/server.ts:2254 ACP session updates forwarded verbatim
src/mcp/server.ts:2310 A2A status events forwarded verbatim
src/mcp/server.ts:2312 A2A artifact events forwarded verbatim
src/mcp/server.ts:2480 Default progress sink writes JSON.stringify(notif) to stdout
src/mcp/server.ts:2843 Per-call emitter — no redaction on payload.message
```

The redactor (`src/lib/redact.ts`) is invoked in exactly two places in the MCP
surface:

- `src/mcp/server.ts:2867` — `safeErrorMessage(err)` on the tools/call error path.
- Everywhere that touches `redactConfigSecrets` — config dumps, not progress.

The gap: `emitProgress({ message: { kind: 'acp.session_update', data: update }})`
is serialised straight into JSON-RPC frames. `update.content.text` can be a
string like `Your API key is sk-ant-api03-…` streamed from claude. The frame
reaches the upstream MCP client with the key intact.

**Fix sketch.**

```ts
// src/mcp/server.ts, near line 2843
const redactMessage = (m: unknown): unknown => {
  if (typeof m === "string") return redactSecretish(m);
  if (Array.isArray(m)) return m.map(redactMessage);
  if (m && typeof m === "object") {
    return Object.fromEntries(
      Object.entries(m as Record<string, unknown>)
        .map(([k, v]) => [k, redactMessage(v)])
    );
  }
  return m;
};

emitProgress: (payload) => {
  if (progressToken === undefined) return;
  const safeMessage = payload.message !== undefined
    ? redactMessage(payload.message)
    : undefined;
  sink({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: {
      progressToken,
      ...(payload.progress !== undefined ? { progress: payload.progress } : {}),
      ...(payload.total !== undefined ? { total: payload.total } : {}),
      ...(safeMessage !== undefined ? { message: safeMessage } : {}),
    },
  });
},
```

Cost: O(size of update). For typical chunk sizes (tens to hundreds of bytes),
this is negligible. For the full-file-read case it's still < 1 ms per chunk.

---

## PATH-spoofing mitigations

Summary: **no mitigation today.** `Bun.which` takes whatever PATH the process
has. On developer machines with direnv / asdf / volta / mise / rtx this is
actively dangerous because per-project `PATH` shims are common.

Three additive defences, in increasing order of user friction:

1. **Record + surface binary path.** `am agent detect <name>` already returns
   `binary` (src/core/agent-detection.ts:139). Add it to `am agent list --verbose`
   and show the resolved path in the CLI output so users see *which* claude they
   invoked. Zero friction, gives users a chance to notice a shim.
2. **Known-good-prefix warning.** When the resolved path does not start with
   one of `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `~/.local/bin`,
   `~/.npm-global/`, `~/.volta/`, `~/.bun/bin`, `~/.cargo/bin`, or (Windows)
   `%ProgramFiles%`, emit a one-line stderr warning on first `am run` of that
   binary. Low friction, catches the direnv footgun.
3. **First-use pinning.** Persist `{agent: claude, binary: /opt/homebrew/bin/claude, sha256: …}`
   in `~/.local/share/agent-manager/agent-paths.json` the first time an agent
   is invoked. Subsequent runs warn if the path or hash changed and require
   `am agent refresh <name>` to update. High friction, strongest guarantee,
   fits well with Phase B's wrapper-config model.

Defence 1 can ship immediately. Defence 2 before Phase B. Defence 3 when Phase
B lands because by then the agent catalog has enough structure to store the
pin alongside the wrapper config.

**Attack recap.** A malicious dotfile puts `~/work/badproject/bin` first in
PATH via direnv. User runs `am run claude "summarize this repo"`. Our PATH
lookup resolves `claude` to the bad binary. It speaks ACP, inherits the full
env (HIGH-3), reads secrets, and exfiltrates via `writeTextFile` to
`~/.cache/badproject/exfil.json` (which is inside the project's `allowed_paths`
because cwd == project root, subject to MEDIUM-3 of iter2). Three defences
combined stop the chain at step 1 or 2.

---

## Recommendations

Before next release:

1. **HIGH-1 — Add redaction to `emitProgress`.** `src/mcp/server.ts:2843-2854`.
   Re-use `redactSecretish` on every string in `payload.message` before the
   sink emits. Add a test that asserts a fake AKIA key in an
   `agent_message_chunk` comes out as `[REDACTED_AWS_KEY]` in the emitted
   progress frame.

2. **HIGH-3 — Env allow-list in `client.ts:connect()` and `createTerminal`.**
   Start from `{ PATH, HOME, USER, LANG, LC_*, TERM, TMPDIR, SHELL }` and
   explicitly strip any env var matching
   `/^(AM_|.*_(TOKEN|SECRET|KEY|PASSWORD|CRED))$/i`. This lands before Phase B
   and is the largest single risk reduction available.

3. **HIGH-2 — Decide the `am apply` merge story in writing.** Either (a)
   provenance-gated replace — only remove `mcpServers` entries the am catalog
   manages — or (b) loudly document the current full-replace behaviour in
   README, update the iter2 test to explicitly test the "external entries are
   deleted" case, and add a warning in `am apply --dry-run` output listing
   entries that will be lost. Shipping silently is the worst of both worlds.

4. **Phase B prelaunch gate.** Do not enable any Tier-2 wrapper without:
   - PB-1 env scrubbing in place.
   - PB-2 `am agent enable-shim` requiring explicit acknowledgement.
   - PB-4 progress-notification redaction (same as rec 1).

5. **MEDIUM-1 — Surface resolved binary path in `am agent list`** (1-line
   change; defence 1 above). Consider defence 2 (known-good-prefix warning)
   as a follow-up in the same PR.

6. **MEDIUM-3 — Loud startup banner for `am mcp-serve --allow-unsafe-local`**
   and a dedicated SECURITY.md section.

7. **LOW-2 — Windows key-file ACL** — schedule alongside any Windows-support
   ticket; not blocking.

8. **Documentation — README L35 "intelligent merge" claim.** Either make it
   true (HIGH-2 fix) or remove the claim.

**Must-land-before-Phase-B:** recommendations 1 (HIGH-1) and 2 (HIGH-3) gate
the shim wrapper. Without them, Phase B turns a documented caveat ("wrappers
inherit the tool's trust posture") into an undocumented secret-exfiltration
path.

---

## Files cited

- `src/protocols/acp/client.ts:129-134, 143-163, 507-516`
- `src/mcp/server.ts:99-101, 238-259, 420, 2254-2257, 2310-2313, 2480-2486, 2522-2546, 2843-2854, 2867`
- `src/core/secrets.ts:30-51, 102, 180`
- `src/core/atomic-write.ts:158-187`
- `src/core/agent-detection.ts:111-143`
- `src/lib/redact.ts:49-103`
- `src/marketplace/installer.ts:49-102, 108`
- `src/marketplace/security.ts:74-160`
- `src/commands/mcp-serve.ts:10-28`
- `src/adapters/claude-code/export.ts:107-147`
- `test/adapters/claude-code/export.test.ts:150-176`
- `ADRs/0033-acp-agent-tiers-and-shim-wrapper.md` (Phase B scope)
- `README.md:35` (intelligent-merge claim)
- `SECURITY.md:41, 85-86`
