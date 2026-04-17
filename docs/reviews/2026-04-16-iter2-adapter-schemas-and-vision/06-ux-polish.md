# agent-manager — Cross-cutting UX Polish Audit (Iter 2)

**Date:** 2026-04-16
**Scope:** Dimensions cutting across every command — observability, progress, error
recovery, JSON envelope shape, exit codes, color/TTY, config-file error messages.
**Reference commit:** current `main` (post `bc997ea`).

## Summary

agent-manager has a surprisingly consistent skeleton for a v0 CLI — there is a
shared `src/lib/output.ts` helper (`output`, `info`, `error`, `debug`, `amError`),
a typed `AmError` class with suggestion + code, and almost every command funnels
through the same `try { … } catch (err) { amError(err, opts); process.exitCode = 1; }`
pattern. Registry network calls have retry + exponential backoff + stale-cache
fallback. Exit codes are respected via `process.exitCode` (not `process.exit()`),
so finally-blocks and async cleanup run.

That good foundation is let down by several gaps:

- **No spinners.** Not one `clack.spinner()` call, no `ora`, nothing. Long ops
  (git clone, npm install, apply to 13 adapters, `am run` ACP spawn) print a
  single "Installing..." line then stare at the user for seconds to minutes.
- **No structured logs.** `info()` takes only a `string` — no level, no fields,
  no correlation ID, no per-adapter context. Log output is scattered
  `console.log` strings indistinguishable from result data.
- **stdout/stderr leakage.** `info()` writes to stdout even in `--json` mode when
  a sibling code path forgets the `!opts.json` guard (see findings). `output()`
  writes `JSON.stringify(...)` to stdout — correct — but success `info()` calls
  in non-JSON branches can still pollute the JSON stream if a command accidentally
  emits both (e.g., `apply`, `install`).
- **JSON envelope is inconsistent.** Some commands emit `{action, ...}`, some
  emit `{servers: [...]}`, some emit `{valid, errors, warnings}`, some emit
  `{agents: [...]}`. There is no `{ok: true, data}` / `{ok: false, error}`
  envelope. The error JSON is `{error: "message"}` — machine-readable but
  separate schema from success payloads.
- **Only two exit codes exist: 0 and 1.** No usage-error (2), no
  network-specific, no auth-specific. Nothing documented.
- **No color library, no NO_COLOR handling, no `--color` flag.** The CLI emits
  raw text + a few `─` box-drawing characters. The `❕⚠` emoji in
  `update.ts:98` will render as tofu on Windows cmd.exe.
- **Partial-failure summary is weak.** `apply` catches per-adapter errors,
  pushes them into `warnings[]`, and moves on — but the human summary does not
  tell you "3 of 13 failed". You have to scan each line.
- **No `--retry` / `--resume`.** The only retry lives in the registry HTTP
  client. A half-finished `apply` to 13 adapters cannot be resumed from
  adapter #7.
- **TOML parse errors lose line/column.** `@iarna/toml` throws a rich
  SyntaxError with `.line/.col`, but `doctor.ts:77` and `config.ts:73` stringify
  it as `Parse error: ${errorMessage(err)}` losing that context.

Headline score: **5/10** — solid bones, shipping-ready for early adopters, not
ready for "chezmoi for AI agent configs" positioning where every `apply` must
be confidence-inspiring.

## Observability findings (severity-tagged)

### [HIGH] No log level hierarchy — only `info`, `debug`, `error`

`src/lib/output.ts` exposes four functions:

```ts
// lines 13-32
export function info(message: string, opts: OutputOptions): void {
  if (!opts.json && !opts.quiet) console.log(message);
}
export function error(message: string, opts: OutputOptions): void {
  if (opts.json) console.error(JSON.stringify({ error: message }));
  else console.error(`error: ${message}`);
}
export function debug(message: string, opts: OutputOptions): void {
  if (opts.verbose && !opts.json) console.log(`  [debug] ${message}`);
}
```

There is **no `warn` level**. `update.ts:98` works around this by emitting
`info("  ⚠ ${e.name}: ${e.error}", opts)` — so a warning shows up as info and
gets suppressed by `--quiet`. `apply.ts:134` does the same: `info(" warning:
${w}", opts)` — warnings are silenced by `-q`, which is wrong: `-q` should
still emit warnings.

### [HIGH] `-v` + `-q` interaction is silently "last wins"

Neither citty nor `output.ts` flag the conflict. In
`src/lib/output.ts:30-32`:

```ts
export function debug(message: string, opts: OutputOptions): void {
  if (opts.verbose && !opts.json) console.log(`  [debug] ${message}`);
}
```

`debug` only checks `verbose` — it does NOT check `!opts.quiet`. So
`am apply -vq` emits debug logs but NOT info logs. The user gets `[debug] ...`
lines without the context `info` lines that preceded them. This is the worst
of both worlds. Either:

- error on `-v -q` (preferred for a scripting CLI), or
- document explicit precedence (`-v` overrides `-q`) and make `debug()` respect
  `!quiet`.

### [HIGH] No correlation ID across multi-step operations

`apply.ts:90-140` iterates `for (const adapter of adapters) { ... }` with no
per-adapter run ID. When one adapter fails and another warns, there is nothing
tying `info("$name: wrote 2 file(s)")` to the specific `apply` invocation.
Same for `marketplace update <all>`, `wiki ingest`, `adapter update`. No
grep-friendly identifier. Consider generating a UUID at command-start and
prefixing every `debug`/`info` line with `[<first-8>]` at least in `--verbose`.

### [MED] stdout / stderr boundaries are respected for `error()` but not for
implicit `info()` calls in JSON mode

`output.ts:14`:

```ts
if (!opts.json && !opts.quiet) console.log(message);  // ok: skipped in --json
```

So `info()` correctly stays silent in `--json`. Good.

However, commands still call `console.log` directly in a few places that should
be `info()`:

- `src/commands/secret.ts:155` — `console.log(decrypted);` (bypasses the `opts.json`
  check AND emits plaintext to stdout; a `--json` output flow would print BOTH
  the JSON envelope AND the raw decrypted secret).
- `src/commands/session.ts:173, 176` — `console.log(m.content)` and
  `console.log(formatMarkdown(...))`.
- `src/commands/run.ts:121-124` — `process.stdout.write(text)` /
  `console.log(text)` for streaming agent output. Gated on
  `!args.json && !args.quiet` on line 116, so this one is correct.
- `src/commands/serve.ts:41,43` — unconditional `console.log`, no JSON flag
  awareness.

### [MED] Errors include suggestions — but inconsistently

`AmError` supports a `suggestion` field (`src/lib/errors.ts:22-31`):

```ts
export class AmError extends Error {
  constructor(
    message: string,
    public suggestion?: string,
    public code?: string,
  ) { ... }
}
```

**Commands that use it well:**

- `apply.ts:38-42` — `"Config not found"` + `"Run \`am init\`..."` + `"CONFIG_NOT_FOUND"`
- `apply.ts:68-72` — adapter not found + lists available adapters
- `list.ts:67-71`, `status.ts:30-35`, `config.ts:143-148` — same config-not-found

**Commands that do NOT:**

- `secret.ts:79` — `error(\`Server "${args.server}" not found.\`, opts)` — no
  suggestion ("Use `am list` to see available servers")
- `agents.ts:112, 172, 197, 212, 278, 301` — raw `error()` calls, no hints
- `run.ts:98-101` — good hint on missing agent
- `flow.ts:39` — `"Invalid --input: must be valid JSON"` — no example
- `wiki.ts:143` — `"Invalid entity type..."` — lists types, decent
- `install.ts:65, 100` — only partial hints
- `marketplace.ts` — relies on `MarketplaceError` which has no suggestion field
  (see `client.ts:368-373`)

### [LOW] `MarketplaceError` is a plain Error — no code, no suggestion

```ts
// src/marketplace/client.ts:368-373
export class MarketplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceError";
  }
}
```

When `amError(err, opts)` formats this, it falls into the generic-Error branch
of `formatError` (`src/lib/errors.ts:49-52`): just prints the message. No
`code`, no `suggestion`. Consider making it extend `AmError` or give it the
same three-field shape.

### [LOW] Same problem with `RegistryError`

`src/registry/client.ts:142-150`. The message is helpful but no
machine-readable code beyond the (HTTP) `statusCode`, and it is not surfaced
in `--json` mode.

## Progress findings

### [HIGH] Zero spinner usage project-wide

Grep for `spinner|ora|progress|Spinner` finds no matches in the CLI command
layer. `@clack/prompts` is already a dep (used for `confirm`/`text` in `init`,
`install`, `update`, `uninstall`) and ships a spinner:

```js
import * as clack from "@clack/prompts";
const s = clack.spinner();
s.start("Cloning marketplace…");
// ...
s.stop("Cloned.");
```

Operations that silently hang for seconds with no feedback:

| Command | Blocking op | Current UX |
|---|---|---|
| `am marketplace add <url>` | `git.clone({...})` at `client.ts:172-182` | one-line `info("Adding marketplace from ...")` in `marketplace.ts:57`, then silence during clone |
| `am marketplace update` | `git.pull` at `client.ts:246-262` | no progress |
| `am adapter install <source>` | `Bun.spawn(['npm', 'install', ...])` at `adapter.ts:167-172` | `info("Installing …")` then silence |
| `am install <pkg>` | registry fetch + optional retry at `install.ts:56` | no per-package progress |
| `am apply` | up to 13 adapter `export()` calls | one `info` line per adapter when done, nothing while running |
| `am doctor` | per-adapter `detect()` calls at `doctor.ts:84-101` | silent |
| `am run <agent>` | ACP spawn + connect at `run.ts:132-135` | `info("Connecting to ${agent}...")` — printed before the long wait, good, but no animation |
| `am wiki ingest` | potentially 100s of sessions → pages | single summary at end |

### [MED] No ">2s warning" annotations

There is no convention like `long-running` / `may take a minute` / `(Ctrl+C
safe)` to reassure the user. New users will Ctrl+C a slow `marketplace add` and
leave a partial clone (even though `client.ts:186-190` cleans up on exception,
SIGINT bypasses that path).

### [LOW] SIGINT handling is implicit

No `process.on('SIGINT', …)` cleanup anywhere in `src/commands/`. Partial
state (marketplace clone, adapter install directory, spawned ACP process) can
be left behind if the user Ctrl+Cs at the wrong moment. `run.ts:204` uses
`finally { await client.disconnect() }` — good — but does not handle Ctrl+C.

## Error Recovery findings

### [HIGH] Only the registry client retries

`src/registry/client.ts:50-51, 59-115`:

```ts
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];
// ... exponential backoff + stale-cache fallback
```

Exemplary. But:

- **Git clone** (`marketplace/client.ts:172-195`) — **no retry**. Transient
  network blips (hotel wifi, flaky gitlab mirror) are a one-shot fail.
- **Git pull** (`client.ts:246-266`) — has a branch-fallback (`main` → `master`)
  but no network retry.
- **npm install** in `adapter.ts:167-172` — one-shot.
- **ACP connect** in `run.ts:133-135` — 30s `initTimeout`, no retry.
- **A2A discovery / ping** in `agents.ts:110, 205` — no retry.

### [HIGH] Errors are not classified

There is no taxonomy of error classes beyond `AmError` / `MarketplaceError` /
`RegistryError`. A user-facing "you forgot `--yes`" is shaped identically to a
"network unreachable". Recommend:

```ts
type ErrorClass = "user" | "config" | "network" | "permission" | "internal" | "auth";
```

and expose it in the JSON envelope so callers (wrappers, CI) can decide
whether to retry.

### [MED] `am apply` does not summarize failures

`src/commands/apply.ts:136-141`:

```ts
} catch (e: unknown) {
  const msg = errorMessage(e) || "export failed";
  info(`${adapter.meta.displayName}: ${msg}`, opts);   // <-- printed as INFO, not ERROR
  results.push({ adapter: adapter.meta.name, files: [], warnings: [msg] });
}
```

So if 3 of 13 adapters fail, the user sees 3 interleaved info lines among 10
success lines, no summary at the end, exit code **still 0**, and in `--json`
the three failures show up only as `warnings` entries (not a separate
`errors` array). **Users will miss this.** `apply` should:

1. Emit a summary: `Applied: 10 ok, 3 failed, 0 skipped`.
2. Set `process.exitCode = 1` if any adapter failed.
3. Distinguish `errors` from `warnings` in the JSON output.

### [HIGH] No `--retry` / `--resume` anywhere

`apply`, `install` (multi-package), `marketplace update` (multi), `wiki ingest`
are all multi-step operations with no way to say "continue from where you
left off". The state is not persisted; a re-run does the whole thing fresh.

For `apply` this is mostly benign (idempotent writes), but `adapter install`
leaves a half-populated `adapters/<name>/` dir if npm install fails midway,
and there is no `am adapter install <name> --resume`.

## JSON Output Consistency

### The envelope problem

There is no canonical envelope. Grepping `output\(` across all commands shows
four distinct shapes:

1. `{action: "<verb>", …fields}` — most commands
2. `{<entity-plural>: [...]}` — `list`, `agents list`, `adapter list`
3. `{valid, errors, warnings}` — `config validate`
4. Raw payload (whole config object) — `config show`, `wiki export`

For errors, the envelope is `{error: "message", suggestion?, code?}` (from
`formatError` in `src/lib/errors.ts:38-53`). A machine consumer has to
`if ('error' in json) { fail } else if ('action' in json) { success } else { ??? }`.

### Conformance table (✓ = present, ✗ = missing)

| Command | Success key | Error format | `action`? | Streaming JSON? |
|---|---|---|---|---|
| `init` | `status` | `{error}` | ✗ | n/a |
| `init --project` | `action: "init-project"` | `{error}` | ✓ | n/a |
| `add <name>` | `action: "add"` | `{error}` | ✓ | n/a |
| `list` | `servers` / `instructions` / `skills` / `agents` / `profiles` | `{error}` | ✗ | n/a |
| `use` | `action: "use"` | `{error}` | ✓ | n/a |
| `apply` | `action: "apply", results[]` | `{error}` | ✓ | ✗ (batched) |
| `status` | `{profile, servers, git, tools}` | `{error}` | ✗ | n/a |
| `config validate` | `{valid, errors, warnings}` | in payload | ✗ | n/a |
| `config show` | raw TOML object | `{error}` | ✗ | n/a |
| `profile create` | `action: "create"` | `{error}` | ✓ | n/a |
| `profile delete` | `action: "delete"` | `{error}` | ✓ | n/a |
| `doctor` | `{healthy, checks}` | `{error}` | ✗ | n/a |
| `import` | `action: "import"` | `{error}` | ✓ | n/a |
| `push` / `pull` | `action: "push" / "pull"` | `{error}` | ✓ | n/a |
| `undo` | `action: "undo"` | `{error}` | ✓ | n/a |
| `log` | (no JSON impl inspected) | — | — | — |
| `secret set/get/list` | `action: "<verb>"` | `{error}` | ✓ | n/a |
| `secret scan` | `action: "scan", secrets[]` | `{error}` | ✓ | n/a |
| `version` | version string | n/a | ✗ | n/a |
| `adapter list` | `{adapters: [...]}` | `{error}` | ✗ | n/a |
| `adapter install` | `action: "install"` | `{error}` | ✓ | n/a |
| `adapter update` | `action: "update", results[]` | `{error}` | ✓ | n/a |
| `serve` | no JSON | `console.error` | n/a | n/a |
| `tui` | n/a | n/a | n/a | n/a |
| `session` | raw Session object JSON | n/a | ✗ | n/a |
| `search` | (registry-search shape) | `{error}` | ✗ | n/a |
| `install` | `action: "install", results[]` | per-package `reason` | ✓ | ✗ |
| `uninstall` | `action: "uninstall"` | `{error}` | ✓ | n/a |
| `update` | `action: "update", updates[]` | nested `errors[]` | ✓ | ✗ |
| `wiki search` | `{query, results, total}` | `{error}` | ✗ | n/a |
| `wiki add/delete/ingest/…` | `action: "<verb>"` | `{error}` | ✓ | ✗ |
| `wiki export` | `{index, entries}` | `{error}` | ✗ | ✗ |
| `agent add` | `action: "add"` | `{error}` | ✓ | n/a |
| `agent delegate` | `action: "delegate"` | `{error}` | ✓ | ✗ |
| `run <agent> <prompt>` | `{agent, sessionId, stopReason, text, toolCalls, usage}` | `{error}` | ✗ | ✗ (buffered) |
| `run agents` / `run session …` | `{agents}` / `{sessions}` / `action: "cancel"` | mixed | partial | n/a |
| `flow run` | (inspected — returns state JSON) | `{error}` | ✗ | ✗ |
| `marketplace add/update/remove/install/uninstall` | `action: "<verb>"` | `{error}` | ✓ | n/a |
| `marketplace list` | `{marketplaces, plugins}` | `{error}` | ✗ | n/a |
| `marketplace search` | `{query, results}` | `{error}` | ✗ | n/a |
| `completion` | prints shell script | n/a | n/a | n/a |

**Out of ~35 JSON-emitting commands: ~20 use `{action}`, ~15 do not. No
streaming JSON anywhere.** `apply` and `run` are the most obvious candidates
for JSONL streaming.

### Recommendation

Adopt a single envelope:

```ts
// success
{ ok: true, action: "apply", data: { ... } }
// error
{ ok: false, action: "apply", error: { code: "ADAPTER_NOT_FOUND", message: "...", suggestion: "..." } }
```

Add `output({action, data?, error?})` helper that enforces it. Have existing
commands migrate progressively.

For streaming (SSE-capable, per-adapter) use **JSONL**: one `{action:"apply.progress", adapter:"codex", status:"writing"}` line per event, terminated with
a final `{action:"apply.done", summary:{...}}` object. `am apply --json
--stream` could emit one JSON object per line.

## Exit Codes

### Current state — only 0 and 1

```
$ grep -rE 'process\.exit(Code)?\s*=\s*[2-9]' src/
(no matches)
```

Every failure path sets `process.exitCode = 1`. No 2 (usage error), no 64–78
(sysexits-style), no network-error-specific code. This undermines scripting
use cases:

- A cron job cannot distinguish "config is malformed" from "network is down —
  try again".
- A CI task cannot gate retry on `exit=75` (TEMPFAIL) vs `exit=64` (USAGE).

### Table: exit-code usage by command

| Command | Success | User error | Network | Config | Auth | Other |
|---|---|---|---|---|---|---|
| `init` | 0 | 1 (already initialized) | — | 1 | — | — |
| `add` | 0 | 1 | — | 1 | — | — |
| `apply` | 0 | 1 | 1 (inside adapter — swallowed) | 1 | — | — |
| `list` | 0 | 1 | — | 1 | — | — |
| `use` | 0 | 1 | — | — | — | — |
| `status` | 0 | — | — | 1 | — | — |
| `config validate` | 0 | — | — | 1 | — | — |
| `doctor` | 0 | — | 1 | 1 | — | 1 |
| `install` | 0 | — | 1 (caught, moves on) | 1 | — | 1 |
| `update` | 0 | — | 1 (per-server — swallowed) | 1 | — | — |
| `uninstall` | 0 | — | — | 1 | — | — |
| `marketplace add` | 0 | 1 (no-trust) | 1 (clone fail) | 1 | — | 1 (size-cap) |
| `marketplace update` | 0 | — | 1 | 1 | — | 1 (SHA change reject) |
| `marketplace install` | 0 | 1 (not found) | 1 | 1 | — | 1 (SHA mismatch) |
| `adapter install` | 0 | 1 (name conflict) | 1 (clone/npm) | 1 | — | 1 (validation) |
| `adapter update` | 0 | 1 (not found) | 1 | 1 | — | 1 |
| `secret set/get` | 0 | 1 (no key, not found) | — | 1 | — | — |
| `wiki *` | 0 | 1 (bad args, bad file) | — | — | — | 1 (import parse) |
| `run <agent>` | 0 | 1 (unknown agent) | 1 (connect fail) | — | — | 1 (timeout) |
| `flow run` | 0 | 1 (bad JSON input) | — | — | — | 1 (flow error) |
| `serve` | 0 | 1 (bad port) | — | — | — | — |

**Nothing documented.** Grep for `exit code` in `README.md`, `CLAUDE.md`,
`CONTRIBUTING.md` finds no table.

### Recommended convention

Adopt (documented, enforced via a small `exitCode(err)` helper):

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic runtime error |
| 2 | Usage error (bad flag, missing positional, unknown subcommand) |
| 3 | Config error (malformed TOML, schema violation, missing config) |
| 4 | Network error (connect/clone/pull/fetch) |
| 5 | Auth / permissions (Midway, git credentials, OS keychain) |
| 6 | Partial success (apply: N ok, M failed) |
| 10 | Integrity / signature / pin mismatch |

Document in `README.md` and have the JSON envelope expose the same code under
`error.code`.

## Color / TTY

### [HIGH] No color library, no NO_COLOR support

Grep for `NO_COLOR|FORCE_COLOR|chalk|picocolors|kleur|ansi` across `src/`
finds zero matches in the command layer. There is no `--color=always|auto|never`
flag in `src/cli.ts`.

Consequences:

- If anyone adds ANSI codes later, `am apply | less` will show raw escape
  sequences. `NO_COLOR=1` will be ignored.
- `am list | grep active` works fine *today* only because no color is emitted
  at all.

Recommendation: adopt `picocolors` (2 KB, treeshakeable) and wrap via a
`useColor()` helper:

```ts
const useColor = process.stdout.isTTY
  && !process.env.NO_COLOR
  && process.env.TERM !== "dumb"
  && !opts.json;
```

Expose `--color=always|auto|never` on the root command.

### [MED] isTTY detection is ad-hoc

`src/commands/init.ts:81,97`, `install.ts:89,111`, `update.ts:142`,
`uninstall.ts:57` all check `process.stdin.isTTY` directly. It works, but is
scattered. A single `isInteractive(opts)` helper in `src/lib/output.ts` would
centralize the rule.

### [LOW] Box-drawing characters (`─`, `│`) are always emitted

`list.ts:116, 154, 181, 211, 248`, `status.ts`, `adapter.ts`, `agents.ts`,
`run.ts:229-281`, `wiki.ts:100` etc. use `─` which is UTF-8. On ancient
Windows cmd.exe or CI logs without UTF-8, these render as `?`. Not a huge
problem in 2026 but worth noting.

### [LOW] `⚠` emoji in `update.ts:98`

`info(" ⚠ ${e.name}: ${e.error}", opts)` — not consistent with the rest of
the codebase which uses plain ASCII `[!]` (see `doctor.ts:243`).

## Config error messages

### [MED] TOML parse errors lose line + column

`@iarna/toml`'s `TOML.parse` throws a `SyntaxError` with `.line` and `.col`
properties. The code throws it away:

`src/core/config.ts:45-48`:

```ts
export async function readConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf-8");
  const parsed = TOML.parse(raw);      // <-- raw throw propagates up
  return ConfigSchema.parse(parsed);
}
```

`src/commands/doctor.ts:73-79` stringifies it:

```ts
checks.push({
  name: "config.toml",
  status: "fail",
  message: `Parse error: ${errorMessage(err)}`,  // <-- loses .line/.col
});
```

`src/commands/config.ts:73`:

```ts
errors.push(`config.toml parse error: ${errorMessage(err)}`);  // <-- same
```

Fix: in `readConfig`, catch the TOML error, pull `.line`/`.col`, and rethrow
as an `AmError` with `code: "TOML_PARSE"` and a `suggestion` pointing to
`${path}:${line}:${col}`.

### [GOOD] Zod validation errors surface path + message

`src/commands/doctor.ts:62-72` and `config.ts:43-67` both handle `ZodError`
correctly:

```ts
for (const issue of result.error.issues) {
  errors.push(`config.toml: ${issue.path.join(".")}: ${issue.message}`);
}
```

So `profiles.default.servers[0]` validation fails report the exact path. Good.

### [MED] "Unknown field" errors are silent

Zod defaults to `strict()` → no; the schemas use `z.object({...})` which in
Zod v3 is passthrough by default. Unknown top-level keys in `config.toml`
will be silently ignored. `config validate` should warn about unknown keys so
users catch typos like `servres = {...}`.

### [LOW] No "schema expected" guidance on union mismatch

When a user writes `scope = "global"` instead of `"always"`, the error is
Zod's default:
`instructions.foo.scope: Invalid enum value. Expected 'always' | 'glob' | 'agent-decision' | 'manual'`.
Adequate, but the config.ts output strips Zod's formatting — a docs link
(`See: https://.../config-reference#instruction-scope`) would help.

### [GOOD] `AmError("Config not found", "Run \`am init\` ...", "CONFIG_NOT_FOUND")` is used uniformly

Appears identically in `apply.ts:38-42`, `status.ts:31-35`, `list.ts:67-71`,
`config.ts:143-148`, `config.ts:170-174`. This is the gold standard for
error UX in the codebase.

## Recommended quick wins + bigger fixes

### Quick wins (< 1 hr each)

1. **Add a `warn()` level to `src/lib/output.ts`.** `info("warning: ...")`
   becomes `warn("...")` — emits to stderr in both JSON and text mode, not
   suppressed by `-q`. Migrate the ~15 hand-rolled warning sites.
2. **Fix `debug()` to respect `-q`.** In `output.ts:31`, add
   `&& !opts.quiet`. Or error out on `-v -q` at root-command `setup()`.
3. **Centralize `isInteractive(opts)` in `output.ts`.** Replace the seven
   `!args.json && process.stdin.isTTY` checks.
4. **Fix `secret get` to not write plaintext to stdout in `--json` mode.**
   Line 152-156 already branches on `args.json`, but line 155's fallback
   `console.log(decrypted)` runs even when `opts.json` is true because of how
   the early `if (args.json) output(...)` structures the code — actually
   correct, but a) the secret leaks to scrollback in interactive mode
   (consider `--reveal` opt-in), b) it should go to stdout without newline.
5. **Add `apply` summary line.** `apply.ts:140` after the loop:
   `info(\`\nApplied to ${successes.length}/${adapters.length} adapter(s). ${failures.length} failed.\`, opts)`.
   Set `process.exitCode = 1` if `failures.length > 0`.
6. **Add a documented exit-code table to `README.md`.** Even if all commands
   still use 0/1 today, a public contract lets clients future-proof.
7. **Install `picocolors` + wrap a `color()` helper.** Disabled by default
   (feature flag `AM_COLOR=1`) while migrating; respects `NO_COLOR` and
   `!isTTY`.
8. **Add clack spinner to `marketplace add`, `marketplace update`, `adapter
   install`, `install` (per-package).** 10 lines each. Huge perceived-speed
   win.
9. **Make `MarketplaceError` extend `AmError`** so it gains `suggestion` and
   `code`; populate those where the message already hints ("Use a different
   `--name` or remove it first" → suggestion field; "Marketplace not found" →
   `code: "MARKETPLACE_NOT_FOUND"`).
10. **Surface TOML line/col.** Catch-and-rewrap in `readConfig` /
    `readProjectConfig` (`src/core/config.ts:44-55`).

### Bigger investments

1. **Unified JSON envelope.** Introduce
   `{ok, action, data?, error?: {code, message, suggestion?}}` with a new
   `respond(res, opts)` helper. Migrate one command per PR. Add a CLI
   contract test that validates every `--json` output against a Zod schema.
   ~2 days across all commands + tests.
2. **Structured log hierarchy with correlation IDs.** Replace
   `info`/`debug`/`error` with a single `log` that takes `{level, event, fields}`.
   Generate a run UUID at root and include `run_id` in every `--json`
   envelope. Under `--log-format=json` emit JSONL to stderr with `level`,
   `event`, `run_id`, `adapter`, `duration_ms`. Keep `info`/`debug` as
   convenience shims. Paves the way for telemetry later.
3. **Streaming JSON mode for `apply` / `install` / `run`.** `--json --stream`
   emits JSONL: one event per adapter / per package / per ACP update.
   Final line is a summary. Clients (CI, MCP, TUI) can consume progressively.
4. **Retry + resume for `apply`.** Persist a `.am/apply-state.json` with
   per-adapter status during the run. `am apply --resume` skips
   already-written adapters. Combined with `--retry 3 --retry-delay 2s`
   for transient failures (file lock, network export target).
5. **Error-class taxonomy.** Define six classes (user/config/network/auth/
   permission/internal) as a Zod enum on `AmError.class`. Map exit codes per
   class. Expose in JSON `error.class`. Enables `am apply && [ $? -eq 4 ] &&
   retry` patterns.
6. **Full `NO_COLOR` / `--color` / `FORCE_COLOR` support + Windows compat.**
   Audit box-drawing for cp437 fallback. Include CI terminals (GitHub Actions
   sets `CI=true` and usually `TERM=dumb`).
7. **Partial-failure UX across all batch commands.** `install`, `update`,
   `marketplace update`, `adapter update`, `apply`, `wiki ingest` all need
   the same summary shape: `Succeeded: N. Failed: M. Skipped: K.` + list of
   failures + exit code 6 on partial.
8. **SIGINT / cleanup.** Global `onCancel` handler that un-does in-flight
   clones, kills spawned subprocesses, closes ACP clients. Currently only
   `run.ts` has a `finally` that does the right thing.

## Appendix — key files cited

- `/Users/baladita/Documents/DevBox/agent-manager/src/lib/output.ts` (49 LOC) — the single output abstraction
- `/Users/baladita/Documents/DevBox/agent-manager/src/lib/errors.ts` (71 LOC) — `AmError`, `formatError`, `requireConfig`
- `/Users/baladita/Documents/DevBox/agent-manager/src/cli.ts` — root citty command; no `--color`, no `--log-format`
- `/Users/baladita/Documents/DevBox/agent-manager/src/commands/apply.ts` — representative batch command, no summary, swallows per-adapter failures into warnings
- `/Users/baladita/Documents/DevBox/agent-manager/src/commands/marketplace.ts` — subcommand group, inconsistent envelope (some `{action}`, some `{marketplaces}`)
- `/Users/baladita/Documents/DevBox/agent-manager/src/commands/doctor.ts` — good model for structured checks, but TOML parse message loses line/col
- `/Users/baladita/Documents/DevBox/agent-manager/src/commands/config.ts` — TOML + Zod error paths
- `/Users/baladita/Documents/DevBox/agent-manager/src/commands/run.ts` — has the only streaming-ish output (process.stdout.write per chunk); no `--stream` JSON mode
- `/Users/baladita/Documents/DevBox/agent-manager/src/marketplace/client.ts` — git clone with no retry; `MarketplaceError` is a bare `Error`
- `/Users/baladita/Documents/DevBox/agent-manager/src/marketplace/installer.ts` — `MarketplaceError` thrown, no `code`
- `/Users/baladita/Documents/DevBox/agent-manager/src/registry/client.ts` — best-in-class: retry w/ exponential backoff + stale-cache fallback
- `/Users/baladita/Documents/DevBox/agent-manager/src/core/config.ts` — `readConfig`/`tryReadConfig` throw raw TOML SyntaxError
- `/Users/baladita/Documents/DevBox/agent-manager/src/core/schema.ts` — Zod schemas; `.passthrough()` by default → unknown keys silently ignored
