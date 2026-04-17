# CLI UX Review — agent-manager

**Date:** 2026-04-16
**Facet:** CLI UX consistency, help text quality, flag design, error messages, discoverability
**Scope:** `src/cli.ts`, `src/commands/*.ts` (32 files, 31 top-level commands), `src/lib/output.ts`, `src/help.ts`

## Summary

agent-manager has a **reasonably mature CLI** for its scope (31 top-level commands, ~119 `defineCommand` call sites when counting subcommands). A centralized `lib/output.ts` output layer with `info`/`error`/`debug`/`amError`/`output` helpers is in use across almost all commands, `--json`/`-q`/`-v` flags are declared consistently, and grouped root help (`src/help.ts` + ADR-0029) is a genuine UX strength versus plain citty output. `AmError` with `suggestion` + error `code` is a solid foundation — several commands already use it to render actionable errors (e.g., `PROFILE_NOT_FOUND`, `CONFIG_NOT_FOUND`, `ADAPTER_NOT_FOUND`).

**However**, there are real inconsistencies: four commands use raw `console.log`/`console.error` (bypassing `--json` / `--quiet`), `serve` and `mcp-serve` don't declare the standard flag set at all, `completion.ts` has a subcommand list that **drifts** from reality (`adapter: ["list"]` — missing `install`/`remove`/`update`/`verify`; `run: ["agents","session"]` — missing the primary prompt form), only 5 commands use structured `AmError`+suggestion (most throw bare strings), and there's no progress indicator for any long-running operation (git clone in `adapter install`, npm install, subprocess validation, import scans). The grouped help is good but hides the complete subcommand hierarchy — there's no `am help <cmd>` wrapper, users must run `am <cmd> --help`.

Overall the foundation is strong but about a dozen "shouldn't-ship" paper cuts remain, most fixable in an afternoon.

---

## Command Inventory

Legend: ✓ = has it, ✗ = missing / placeholder, ~ = partial/present-but-weak.

| Command | Meta description | Help on no-arg | Error quality | `--json` | `--quiet` | `--verbose` | Exit code on fail |
|---------|-----------------|----------------|---------------|:-------:|:-------:|:----------:|:-----------------:|
| `init` | "Initialize agent-manager config and git repo" ✓ | N/A (no required positional) | Plain string on "already initialized" ~ | ✓ | ✓ | ✓ | ✓ |
| `add <entity?> <name>` | "Add an entity to the config (…)" ✓ | Prints `Usage: am add <entity> <name>` ✓ | Good: tells user syntax ✓ | ✓ | ✓ | ✓ | ✓ |
| `list [entity]` | "List entities in the config (…)" ✓ | Defaults to `servers` (implicit) ~ | Good: lists valid entity types on bad input ✓ | ✓ | ✓ | ✓ | ✓ |
| `use <profile>` | "Switch active profile" ✓ | citty requires positional; errors cleanly ✓ | Excellent: `AmError` with available profiles listed ✓ | ✓ | ✓ | ✓ | ✓ |
| `apply` | "Generate native configs for detected tools" ✓ | N/A | Good: `AmError` + suggestion on missing config/adapter ✓ | ✓ | ✓ | ✓ | ✓ |
| `status` | "Show config and drift status" ✓ | N/A | Good ✓ | ✓ | ✓ | ✓ | ✓ |
| `config validate` | "Validate config files" ✓ | N/A | Lists all errors with paths ✓ | ✓ | ✓ | ✓ | ✓ |
| `config show` | "Show configuration" ✓ | N/A | Good: AmError on missing ✓ | ✓ | ✓ | ✓ | ✓ |
| `profile list/show/create/delete` | Each has description ✓ | Positional enforced by citty ✓ | OK, bare `error()` — not AmError ~ | ✓ | ✓ | ✓ | ✓ |
| `doctor` | "Health check for agent-manager" ✓ | N/A | Renders every check with status icons ✓ | ✓ | ✓ | ✓ | ✓ (on failures only) |
| `import <source>` | "Import servers from a tool's native config" ✓ | citty-enforced positional | Excellent: `AmError` + "Available adapters: …" ✓ | ✓ | ✓ | ✓ | ✓ |
| `push` | "Push config changes to remote" ✓ | N/A | Excellent: `AmError` with `NO_REMOTE` / `CONFIG_NOT_FOUND` ✓ | ✓ | ✓ | ✓ | ✓ |
| `pull` | "Pull config changes from the remote git repository" ✓ | N/A | Excellent (same) ✓ | ✓ | ✓ | ✓ | ✓ |
| `undo` | "Revert the last config change" ✓ | N/A | Bare strings, no suggestion ~ | ✓ | ✓ | ✓ | ✓ |
| `log` | "Show config change history" ✓ | N/A | "Cannot read git log. Run `am init` first." ✓ | ✓ | ✓ | ✓ | ✓ |
| `secret set/get/list/scan/install-scanner/generate-key/import-key` | All have descriptions ✓ | Positional enforced ✓ | Bare strings mostly ~; `get` has `console.log(decrypted)` bypass | ✓ | ✓ | ✓ | ✓ |
| `version` | "Print version" ✓ | N/A | N/A | ✓ | ✓ | ✗ (no `-v`) | N/A |
| `adapter list/install/remove/update/verify` | Each described ✓ | Positional enforced ✓ | Bare strings, does have context ("Use --force to…") ~ | ✓ | ✓ | ✓ | ✓ |
| `mcp-serve` | "Start agent-manager as an MCP server (stdio transport)" ✓ | N/A | **No flags declared at all** ✗ | ✗ | ✗ | ✗ | ✗ (no error path) |
| `serve` | "Start the web dashboard" ✓ | N/A | Uses raw `console.error` ✗ | ✗ | ✗ | ✗ | ✓ (port check) |
| `tui` | "Launch interactive TUI dashboard" ✓ | N/A | No error path, no flags | ✗ | ✗ | ✗ | — |
| `session list/export/search` | Described ✓ | Positional enforced ✓ | Uses `console.log` for markdown/json output ~ | ✓ | ✓ | ✓ | ✓ |
| `search <query>` | "Search the MCP registry for packages" ✓ | Positional enforced ✓ | Good, bare strings ~ | ✓ | ✓ | ✓ | ✓ |
| `install <packages>` | "Install MCP server packages from the registry" ✓ | Positional enforced ✓ | Good, reports per-package ✓ | ✓ | ✓ | ✓ | ✓ |
| `uninstall <name>` | "Remove an MCP server package from config" ✓ | Positional enforced ✓ | Good ✓ | ✓ | ✓ | ✓ | ✓ |
| `update` | "Check for and apply MCP registry updates" ✓ | N/A | Good ✓ | ✓ | ✓ | ✓ | ✓ |
| `wiki init/search/add/show/delete/ingest/harvest/synthesize/briefing/export/import/lint/graph` | All described ✓ | Positional enforced ✓ | Mostly bare strings ~ | ✓ | ✓ | ✓ | ✓ |
| `agent list/add/remove/ping/delegate/cancel` | Each described ✓ | Positional enforced ✓ | Good: includes "Use `am agent list` to see…" ✓ | ✓ | ✓ | ✓ | ✓ |
| `run <agent> <prompt>` | "Run an ACP-compatible coding agent or manage sessions" ✓ | "Usage: am run <agent> \"<prompt>\" …" ✓ | Good: "Run `am run agents` to list" ✓ | ✓ | ✓ | ✓ | ✓ |
| `flow run/list/status` | Described ✓ | Positional enforced ✓ | Bare strings ~ | ✓ | ✓ | ✓ | ✓ |
| `completion bash/zsh/fish` | Each described ✓ | citty handles | No error path | ✗ | ✗ | ✗ | N/A |
| `marketplace add/list/install/update/remove/search/uninstall` | Each described ✓ | Positional enforced ✓ | Uses `MarketplaceError` class ✓ | ✓ | ✓ | ✓ | ✓ |

**Completeness:** 31 top-level commands, ~119 `defineCommand` sites. All top-level commands have meta descriptions that go beyond placeholders; none say "Add a server" in isolation — they describe the intent.

---

## UX Inconsistencies

### HIGH severity

**H1. `serve` bypasses the output layer entirely.** `src/commands/serve.ts:24,29,41,43` uses `console.error`/`console.log` directly — ignores `--json` and `--quiet`. Also, `serve` declares NO `--json`/`-q`/`-v` flags at all. A user running `am serve --json` to launch the dashboard in a script gets a human-readable line. Fix: wire through `opts` and declare standard flag set.

**H2. `mcp-serve` declares `args: {}`** — zero flags. No way to set port override, no JSON mode, no quiet. Minor since mcp-serve typically runs in stdio but still inconsistent with the rest of the CLI.

**H3. `completion.ts` subcommand list drifts from reality.** `SUBCOMMANDS` hardcodes:
- `adapter: ["list"]` — reality is `list, install, remove, update, verify` (4 missing).
- `run: ["agents", "session"]` — omits the primary `am run <agent> <prompt>` form and `session list/cancel`.
- `config: ["validate", "show"]` — OK.
- `profile: ["list", "show", "create", "delete"]` — OK.
- `wiki: [...]` — includes `init` but order doesn't match `wikiCommand` subCommands.
- Missing entirely: `completion: ["bash","zsh","fish"]`.
Tab completion will silently not suggest half the `am adapter <TAB>` commands. Fix: derive `SUBCOMMANDS` from the citty `subCommands` trees at build time, or at minimum add a test that diffs the two.

**H4. Four files use raw `console.log`/`console.error`** (grep of `src/commands/`):
- `secret.ts:153` — `console.log(decrypted)` for the secret value. Intentional? Probably yes (don't want "Value: xxx"), but should be gated on `!opts.json`/`!opts.quiet` and use `process.stdout.write`.
- `serve.ts:24,29,41,43` — see H1.
- `session.ts:169,173,176` — bypasses info() for markdown/json output.
- `run.ts:124` — streaming agent text chunks uses `console.log` for non-text updates; `process.stdout.write` is already used for text chunks. Mixed.

**H5. No progress indicators on long-running operations.**
- `adapter install` runs `git clone`, `npm install`, then spawns the adapter for validation — emits only static "Installing…" and "Validating…" lines. No spinner, no stderr pass-through. On a slow clone the user has no feedback.
- `import` scanning multiple adapters: `debug(Importing from X…)` only surfaces with `-v`.
- `marketplace install`, `install` (registry), `update`: similarly silent during network fetches.
- No uniform helper like `spinner("Cloning…", () => gitClone())`. Could use `@clack/prompts` spinner since clack is already a dep.

### MEDIUM severity

**M1. `AmError` + suggestion + code is used unevenly.** Only 5 commands (`use`, `apply`, `import`, `push`, `pull`, `config`, `list`) throw structured `AmError`; the rest use bare `error(..., opts)`. Good error DX is the single biggest differentiator for a CLI — inconsistent use here means `am undo` gives "Nothing to undo — only the initial commit exists" (no next step), while `am use bad-profile` gives the beautiful "error: Profile 'bad-profile' not found / suggestion: Available profiles: default, work".

**M2. Entity-type drift between `add`, `list`, and CLAUDE.md guidance.** `add` accepts `server|instruction|skill|agent` (stubs skill/agent); `list` accepts `servers|instructions|skills|agents|profiles` (note plural + the extra `profiles`). Users running `am add profile <name>` get "Missing name. Usage: am add server <name>" because the token `profile` isn't in `ENTITY_TYPES` and falls through to the backwards-compat branch that treats it as a server name. Either support it symmetrically or error with "Use `am profile create`".

**M3. Positional versus flag inconsistency for names.**
- Positional: `use <profile>`, `adapter install <source>`, `adapter remove <name>`, `secret set <name> <value>`, `install <packages>`, `uninstall <name>`, `profile create <name>`.
- Flag-based where it matters: `add` takes positional name but requires `--command` flag for the actual server command; `add instruction` needs `--content` or `--content-file`.
- The `add server` form mixes them: positional name, flag command. This is fine but `add` would benefit from a "required flag missing" message that echoes the whole expected invocation, which it already does.

**M4. `list` output format is unconditionally a table.** Tables break on narrow terminals — names >20 chars, descriptions >30 chars, tag lists >20 chars all simply overflow with no wrap and no truncation. No `--wide` or `--no-header` alternative. `search.ts` does `truncate(…)` to 38 chars but `list` does not.

**M5. `version` omits `-v`/`-verbose`.** Inconsistent with every other command. Minor but surprising.

**M6. `tui` and `completion` subcommands have no `--json`/`-q`/`-v`** — they don't produce output, so technically fine, but asymmetry is visible on help.

**M7. `run` streams text via `process.stdout.write` but other updates via `console.log`** (`run.ts:120-125`). Streaming is correct; the `console.log` branch should use `info()` so `--quiet` silences it.

**M8. `doctor` status icons use `+`, `!`, `x`** (ASCII) everywhere. `flow status` uses `+`, `x`, `~`, ` `. `log` uses Unicode `●`, `↓`, `↶`. Inconsistent visual vocabulary. Pick one and lint.

**M9. `wiki delete --force` is the confirmation gate** — without `--force` it just prints "Use --force to confirm deletion." and returns success. Users running it twice in a script see success both times without deletion. Better: interactive confirm via clack by default (like `profile delete`), `--yes` to skip, `--dry-run` to preview.

### LOW severity

**L1. `am add skill <name>` and `am add agent <name>` print** `"Adding skills is coming soon. Use config.toml to add '<name>' manually."` with exit code 0. A user scripting against `am add skill` gets a silent no-op. Should exit 2 (feature not available) or print a discovery hint.

**L2. `completion` lists `init-project` as a top-level command** (`completion.ts:47`) — but the actual router doesn't mount it. `init --project` is the form. Tab completion will show a phantom command.

**L3. `am agent` with no subcommand** likely prints citty's generic help. Would benefit from a one-line recipe: "Usage: `am agent list | add <url> | ping <name> | delegate <name> <task>`".

**L4. Error messages frequently end with a period, sometimes don't.** `"Agent "${name}" not found in roster."` vs `"Config not found"` (no period). Both are valid English but inconsistent; pick one.

**L5. `error()` in output.ts prints `error: <msg>` without a trailing newline issue**, but `debug()` prefixes with 2 spaces + `[debug]`. No log level hierarchy — `warn()` is missing and simulated as `info()` or inlined.

**L6. `apply` uses `info()` to print errors inside the per-adapter loop** (`apply.ts:138`): `info(`${adapter.meta.displayName}: ${msg}`, opts);` for export failures. Wrong channel — should be `error()` so scripts picking up stderr can fail fast.

**L7. `push` catches platform.storeKey errors silently** — user can't tell whether key was synced. A single debug() line or a final "⚠ key not stored" hint would help.

---

## Help / Discoverability findings

### Strengths

- **Grouped root help (`src/help.ts`)** — `am --help` shows 8 logical groupings (Config, Git, Registry, Marketplace, Agent, Knowledge, Tool, Interface). 31 commands become navigable. This is the single best UX feature.
- **"Run `am X` to do Y" hints** are sprinkled through success paths: `apply` hint after `install`, `am apply` hint after `update`/`pull`/`use`/`uninstall`, `am run agents` to list after `run` failure. These are gold.
- **Citty handles missing-positional errors** — running `am use` (no arg) produces "Missing required positional argument: profile", which is functional if terse.

### Weaknesses

**D1. No `am help <cmd>` alias.** Only `am <cmd> --help` works. Many users type `help` reflexively. Easy to add with a `help` subcommand that re-invokes with `--help`.

**D2. Subcommand help is citty-default, not grouped.** `am adapter --help` lists 5 subs alphabetically with the short desc. `am wiki --help` lists 13. At 5+ subs, grouping (e.g. "Content", "Introspection", "Maintenance") would help.

**D3. No top-level examples in help.** Compare with `gh`'s help which shows `EXAMPLES:` at the bottom. `am --help` ends with "Run `am <command> --help` for more information" — no quickstart. Adding 3 canonical flows (Init → Import → Apply; Search → Install → Apply; Add agent → Delegate) would massively reduce "what do I even do next" friction.

**D4. Ambiguous command overlap.**
- `add` vs `install`: both add servers. `add` is manual + --command; `install` pulls from registry. Users won't intuit this.
- `import` vs `install` vs `marketplace install`: three "install" verbs. Each is correct (import from native config; install from MCP registry; install plugin from a git-based marketplace) but the surface area is confusing. Consider making this discoverable via `am help topics` or a section in root help.
- `adapter install` (install a community adapter) vs `install` (install an MCP server package from the registry) — completely different semantics, same verb.

**D5. Discoverability of `list <entity>`.** Running `am list` defaults silently to `servers`. If you were looking for `am list profiles` or `am list agents`, you'd have to read the description or error message. A cleaner default: when `am list` is run with no positional, show a one-liner "Listing servers. Use `am list <servers|instructions|skills|agents|profiles>` for other entities." before the table.

**D6. `am` alone (no args) should probably print grouped help**, not an error. Verify by reading citty behavior — in `cli.ts` the root has subcommands but no default `run`, so citty prints usage. `showGroupedUsage` renders the grouped view, so this should already work — but worth verifying in `bun run src/cli.ts` with no args.

**D7. No way to show "all subcommands with their descriptions as one tree".** Users discovering the CLI for the first time benefit from a single-page view. `am commands` or `am tree` would be useful.

---

## Error Message Quality

### What's good

- **`AmError` pattern** is solid: message + suggestion + code, rendered cleanly in both plain and JSON modes (see `src/lib/errors.ts:36-54`). When used, errors are actionable: *"Profile \"work\" not found / suggestion: Available profiles: default, work-old"*.
- **`push`/`pull`/`use`/`import`** all wrap failure paths with `AmError` + suggestion — these feel professional.
- **`add` prints the exact expected invocation** when args are missing: `"Missing --command. Usage: am add server <name> --command <cmd>"`.
- **`doctor`** gives per-check messages that include the fix: `"Not a git repo. Run \`am init\`."`, `"betterleaks not installed (run \`am secret install-scanner\` for enhanced scanning)"`. Excellent.

### What's not

- **Most non-AmError sites throw bare strings**, e.g. `secret.ts:63` `"No encryption key found. Run `am secret generate-key` first."` has a hint in the message but no structured suggestion → `--json` output loses the structure.
- **`flow`, `wiki`, `session`, `agent`** commands mostly use `error(str, opts)` without AmError — losing the suggestion channel.
- **`undo`'s "Nothing to undo — only the initial commit exists"** tells the user why but not what to do next. Could add "suggestion: make a change first, then undo it."
- **`install` registry errors** are rendered per-package inline (good) but the failure summary at the end doesn't tell the user `--no-cache` or `--verbose` might help debug.
- **`adapter install` validation failure** cleans up the cloned dir and reports the exception message, but doesn't say "Adapter must implement the community adapter protocol. See docs/adapters/community.md". The error is meaningful only to someone who's read the protocol spec.
- **No hint when user provides unknown command.** Running `am appli` (typo) produces citty's default "Unknown command" with no "Did you mean: apply?" suggestion. A fuzzy-match like `git`'s "The most similar command is…" would be a high-value addition.

---

## Recommendations

### Quick wins (1–2 hours each)

**R1. Replace all raw `console.log`/`console.error` in `src/commands/`** with `info`/`error`/`output` that respect `--json`/`--quiet`. Exception: `serve` entering HTTP mode can still log its bound port to stdout, but gate on `!opts.quiet`. Add a lint rule / test: `grep -rn 'console\.' src/commands/` should be empty.

**R2. Fix `completion.ts` SUBCOMMANDS drift.** At minimum, update the hardcoded lists to match reality (adapter has 5 subs, run has the main prompt form + agents + session; add completion itself). Ideally, write a helper that walks the citty subCommands tree at runtime and emits the completion script from that structure so they cannot drift.

**R3. Declare the standard flag set on `serve` and `mcp-serve`** (`--json`, `-q`, `-v`). Even if no-op for `mcp-serve`, consistency matters for script writers.

**R4. Add `help` as a top-level command** that forwards to `<cmd> --help`. 5-line implementation.

**R5. Add `-v` alias to `version`.** Trivial.

**R6. Normalize status icons.** Pick one of `[+][!][x]` (ASCII) or `✓/⚠/✗` and use everywhere. `doctor`, `flow status`, and `log` currently use three different visual grammars.

**R7. Unify error message period style.** Lint rule: all error strings end with a period.

**R8. `am add skill/agent` should return exit code 2** (feature not available) rather than 0 — scripts can branch correctly.

**R9. `apply.ts:138` `info(\`${adapter}: ${msg}\`)` → `error(...)`** for per-adapter export failures. Cheap DX win.

### Medium-effort improvements

**R10. Convert remaining bare `error()` calls to `AmError`** with suggestions, especially in `flow`, `wiki`, `session`, `agent`, `undo`, and `secret`. This is rote but high-value — pairs well with R11.

**R11. Add a `--help` examples section** rendered after the subcommand list for commands with >3 subcommands (`wiki`, `secret`, `adapter`, `agent`, `marketplace`, `profile`, `config`, `flow`, `run`, `session`). Could be a `meta.examples?: string[]` convention that `showGroupedUsage` picks up.

**R12. Add a spinner helper** in `src/lib/output.ts` that uses `@clack/prompts` when TTY, falls back to `info()` otherwise. Wire into `adapter install` (git clone, npm install, validate), `marketplace install`, `install`, `update`, `import` (per-adapter), and `apply` (per-adapter). Rule: any operation that takes >500ms should spin.

**R13. Typo suggestion on unknown commands.** Use a simple Levenshtein check against `TOP_LEVEL_COMMANDS` (already exported) to emit "Did you mean: `apply`?". Citty may require a custom unknown-command hook.

**R14. Terminal-width-aware table rendering** in `list`, `search`, `adapter list`, `flow list`, `session list`, `run agents`, `agent list`. Truncate to `process.stdout.columns - padding`. One shared `renderTable(rows, columns)` helper.

**R15. `completion` should include a hidden `_list` subcommand** that emits `commands:subcommands` JSON — then bash/zsh/fish scripts can fetch current data at runtime instead of baking it in. Eliminates drift class.

### Larger changes

**R16. Formalize the entity model.** Today `add` and `list` disagree on the canonical set (server vs servers, presence of profiles). Define an `Entity` enum, re-use it in both commands, and expose `am entities` that prints the list with one-line descriptions of each. Also aligns `skill`/`agent` stubs.

**R17. Single "canonical usage" object per command**, consumed by both `error(…)` missing-arg messages and the help renderer. Today every "Missing --X" error inlines its own usage string — fragile under refactor. A `usage: string` field on the command, rendered by both `--help` and error paths, would dedupe.

**R18. Grouped help for subcommand trees with 5+ subs.** `am wiki --help` showing 13 subcommands alphabetically is a wall of text. Adding a `subCommandGroups` meta field would let us render "Content: add, show, delete, import, export" / "Ingestion: harvest, ingest, synthesize" / "Maintenance: lint, graph, init, briefing, search".

**R19. `am doctor --fix` / `am doctor --interactive`.** Doctor already identifies missing betterleaks, missing encryption key, missing remote — next step is letting it apply the fix. High leverage for new users.

**R20. Output-layer warnings.** Introduce `warn(msg, opts)` distinct from `info()` so warnings (e.g. secret scan hits, managed config override, stale wiki pages) route to stderr and survive `--quiet`. Today warnings are mixed into `info()` which silences them under `-q`.

---

## Global flag audit

```
Global on root `am`:
  --profile <string>     Override active profile
  --json                 JSON output
  -v, --verbose          Increase log verbosity
  -q, --quiet            Suppress non-essential output
```

`--profile` is declared at the root but **not actually propagated** to subcommands via citty's arg inheritance — every subcommand that needs profile override re-declares it (`apply` does; `status`, `list`, `config show --resolved` don't). Test: `am --profile work list` likely ignores the flag. Worth verifying and either enforcing inheritance or removing from the root.

`-v` is overloaded: root-level alias is `verbose`, `version` doesn't have it (`-v` would print version in many CLIs but here collides with verbose). Decide the convention.

`--help` is citty's default; `-h` alias should be confirmed working.

---

## Summary of findings at a glance

- **Exit codes:** 110 `process.exitCode` or `process.exit` sites across 28 files — good coverage. `tui`, `mcp-serve`, `completion` don't have error paths, which is acceptable. `version` has no error path, which is fine.
- **Flag consistency:** 28 of 32 command files declare `--json`/`-q`/`-v`. Outliers: `tui` (none), `mcp-serve` (none), `serve` (none), `completion` (bash/zsh/fish subs only, top-level inherits).
- **`AmError` usage:** only ~7 commands use structured errors. The rest inline hint strings, losing the `--json` suggestion channel.
- **Raw `console` bypass:** 4 files / 9 sites.
- **Completion drift:** ~15 subcommands not covered by the hardcoded list.
- **Long-running ops without progress:** 4+ (git clone, npm install, subprocess validation, registry fetches, large imports).
- **Help grouping:** root ✓, subcommands ✗ (for ≥5-sub families).

The CLI is in good shape for v1 but would benefit from a dedicated UX polish pass focused on R1–R9 (2 afternoons) before wider adoption.
