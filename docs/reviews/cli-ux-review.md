# CLI UX Review — agent-manager (`am`)

**Reviewer:** CLI UX agent  
**Date:** 2026-04-14  
**Scope:** All 27 top-level commands, 28 command files, global flags, output helpers  
**Compared against:** chezmoi, brew, ACPX CLI  

---

## Executive Summary

The CLI is remarkably well-structured for a 27-command tool. The output helpers
(`src/lib/output.ts`) provide a clean `--json`/`--quiet`/`--verbose` pattern that most
commands follow. Command naming is mostly logical, and the citty + clack stack gives
interactive flows without sacrificing scriptability.

There are **3 critical** issues (blocking for v1.0), **5 high** issues (will cause user
confusion), **8 medium** issues (paper cuts that accumulate), and **6 low** issues
(polish for later).

---

## Findings

### CRITICAL

#### C1. `am add` only adds servers — the command name is too broad

**Severity:** CRITICAL  
**File:** `src/commands/add.ts`

The top-level `am add` command only adds servers, but its name implies it could add
anything (profiles, instructions, skills, agents). This is the second most-used command
after `am init` and the naming will collide with future entity types.

Compare:
- `brew install <formula>` — unambiguous because there's only one installable entity
- `chezmoi add <target>` — unambiguous because "add" means "track this file"
- `am add <name>` — ambiguous: add what?

The description says "Add a server to the config" but the positional arg is just `name`.
A user typing `am add --help` gets no disambiguation.

**Current:**
```bash
am add tavily --command "bunx tavily-mcp@latest"
```

**Recommended:** Make `add` a parent command with subcommands, matching the existing
`list` pattern if it were expanded:
```bash
am add server tavily --command "bunx tavily-mcp@latest"
am add instruction ts-strict --content "Use strict TypeScript"
am add skill research --path skills/research
```

For backward compatibility during transition, `am add <name> --command <cmd>` could
remain as a shortcut that assumes `server` when `--command` is present.

**Why this matters:** The README already uses `am add server` syntax in the Quick Start
section, creating a mismatch with the actual CLI. Users will try `am add server tavily`
and get an error.

---

#### C2. `am list` only lists servers — same breadth problem as `am add`

**Severity:** CRITICAL  
**File:** `src/commands/list.ts`

`am list` lists servers exclusively. There's no way to list instructions, skills, or
agent profiles from the CLI. Users must use `am config show` and visually parse TOML
to see these.

Compare:
- `brew list` lists all installed formulae and casks
- `chezmoi managed` lists all managed entries

**Current:**
```bash
am list                    # servers only
am profile list            # profiles only
am adapter list            # adapters only
am agents list             # A2A agents only
am secret list             # secrets only
am session list            # sessions only
```

**Recommended:** Either:

**(A)** Make `am list` a parent command:
```bash
am list servers             # existing behavior
am list profiles            # replaces am profile list
am list adapters            # replaces am adapter list
am list agents              # replaces am agents list
am list instructions        # NEW
am list skills              # NEW
am list secrets             # replaces am secret list
```

**(B)** Keep entity-specific parents but add `am list` as a summary dashboard:
```bash
am list                     # summary: 15 servers, 3 profiles, 8 instructions, 2 agents
am list --json              # full inventory JSON
```

Option (A) is closer to `kubectl get <resource>` and `docker <entity> ls` patterns
that users already know.

---

#### C3. `am add` description says "Add a server" but README shows `am add server <name>` syntax

**Severity:** CRITICAL  
**Files:** `src/commands/add.ts`, `README.md`

The README's Quick Start and CLI Reference both use `am add server <name>` syntax, but
the actual command is `am add <name>`. A new user following the README will fail on
their first command.

```
# README shows:
am add server tavily --command "bunx tavily-mcp@latest"

# Actual CLI:
am add tavily --command "bunx tavily-mcp@latest"
```

This must be resolved before v1.0 — either fix the README or fix the CLI. Given C1
above, fixing the CLI is the better path.

---

### HIGH

#### H1. `--json` output inconsistency: some commands print nothing without `--json`

**Severity:** HIGH  
**Files:** `src/lib/output.ts`, multiple commands

The `output()` helper only prints when `--json` is true. This means commands that
primarily use `output()` for their data produce nothing in non-JSON mode. Most commands
handle this correctly by using `info()` for human output, but the pattern is fragile.

Three specific issues:

1. **`am wiki export --format json`** calls `output()` — correct for `--json` mode, but
   without `--json` it prints nothing. The user must always pass `--json` to get JSON
   export, which is redundant.

2. **`am config show --resolved --json`** works, but `am config show --resolved` without
   `--json` prints TOML. This is actually good behavior but undocumented — it's a
   format choice hidden behind flag combinations.

3. **`am secret get`** bypasses the output helper entirely with `console.log(decrypted)`
   in non-JSON mode. This is correct (raw value for piping) but inconsistent with
   the pattern.

**Recommended:** Document the output contract. Consider adding a `--format` flag
at the global level (`text`, `json`, `toml`) rather than overloading `--json`.

---

#### H2. `mcp-serve`, `serve`, and `tui` lack global flag support

**Severity:** HIGH  
**Files:** `src/commands/mcp-serve.ts`, `src/commands/serve.ts`, `src/commands/tui.ts`

These three commands accept no arguments at all (or only `--port`):

- `am mcp-serve` — zero args, no `--json`, no `--verbose`
- `am tui` — zero args
- `am serve` — only `--port`

For `mcp-serve`, this is defensible (it's a JSON-RPC server, not a human-facing command).
But `am serve` should support `--verbose` for request logging and `--json` for
machine-readable startup output (port, token path, PID).

**Recommended:**
```typescript
// serve.ts — add at minimum:
json: { type: "boolean", default: false },
verbose: { type: "boolean", alias: "v", default: false },
host: { type: "string", description: "Bind address", default: "localhost" },
```

---

#### H3. Error handling bypasses `AmError` in many commands

**Severity:** HIGH  
**Files:** Multiple commands

The codebase defines `AmError` with `suggestion` and `code` fields in
`src/lib/errors.ts`, plus a `formatError()` helper. But most commands construct
error messages inline:

```typescript
// Common pattern (NOT using AmError):
error("Config not found. Run `am init` first.", opts);
process.exitCode = 1;
return;
```

This duplicates the same "Config not found" message in **13 different commands** and
misses the structured error contract. The `requireConfig()` helper exists but is not
used anywhere.

**Recommended:** Use `requireConfig()` and throw `AmError` consistently:
```typescript
// Before (repeated 13 times):
let config;
try {
  config = await readConfig(configPath);
} catch {
  error("Config not found. Run `am init` first.", opts);
  process.exitCode = 1;
  return;
}

// After (once, at the top of the command):
const config = await tryReadConfig(configPath);
requireConfig(config);
```

Each command would need a top-level try/catch that calls `amError(err, opts)`.

---

#### H4. `am pull` does not auto-apply, contradicting its description

**Severity:** HIGH  
**File:** `src/commands/pull.ts`

The command description is "Pull config changes from remote and auto-apply", but the
implementation only pulls and then prints a hint:

```typescript
info("Run `am apply` to regenerate native configs", opts);
```

This contradicts both the description and the README which says:
> `am pull` — Pull from remote + auto-apply

Compare: `chezmoi update` actually applies changes after pulling.

**Recommended:** Either:
1. Actually auto-apply after pull (add `--no-apply` to opt out)
2. Change the description to "Pull config changes from remote"

Option 1 is the better UX — if users wanted pull-only, they'd use git directly.

---

#### H5. Numeric flags stored as strings require manual parsing

**Severity:** HIGH  
**Files:** `src/commands/log.ts`, `src/commands/search.ts`, `src/commands/serve.ts`

citty doesn't have a native `number` type, so numeric flags are declared as `type: "string"` 
and manually parsed with `Number.parseInt()`:

```typescript
// log.ts
count: { type: "string", description: "Number of entries to show", default: "20" }
// ...
entries = await gitLog(configDir, Number.parseInt(args.count, 10));

// serve.ts  
port: { type: "string", description: "Port to listen on", default: "3456" }
```

This means `am log --count abc` silently produces NaN, and `am serve --port -5` doesn't
validate. There's no centralized numeric parsing/validation.

**Recommended:** Create a `parsePositiveInt(value: string, name: string): number`
helper in `src/lib/output.ts` that throws `AmError` with a clear message:

```typescript
function parsePositiveInt(value: string, name: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 1) {
    throw new AmError(
      `Invalid value for --${name}: "${value}"`,
      `Provide a positive integer`,
    );
  }
  return n;
}
```

---

### MEDIUM

#### M1. `am search` vs `am wiki search` — ambiguous at the top level

**Severity:** MEDIUM  
**Files:** `src/commands/search.ts`, `src/commands/wiki.ts`

`am search` searches the MCP registry. `am wiki search` searches the wiki. `am session search`
searches sessions. A user who just wants to "search for something" may pick the wrong one.

Compare: `brew search` is unambiguous because Homebrew has one searchable domain.

**Recommended:** Rename `am search` to `am registry search` or add `am search --scope`
to unify:
```bash
am search tavily                    # registry (default)
am search tavily --scope wiki       # wiki
am search tavily --scope sessions   # sessions
```

Alternatively, keep `am search` for registry but add an `am find` or `am lookup` alias
that searches all domains simultaneously.

---

#### M2. `am install` / `am uninstall` / `am update` are top-level but only for registry

**Severity:** MEDIUM  
**Files:** `src/commands/install.ts`, `src/commands/uninstall.ts`, `src/commands/update.ts`

These familiar package-manager verbs live at the top level but only operate on registry
packages. This creates semantic confusion:

- `am install tavily-mcp` — installs from registry (good)
- `am add tavily --command ...` — manually adds a server (different from install?)
- `am uninstall tavily` — removes a server, but only if registry-installed?

Actually, `am uninstall` removes ANY server (not just registry-installed ones), which
makes `am uninstall` an alias for a hypothetical `am remove server`. The `uninstall`
naming implies it only undoes `am install`.

**Recommended:** Either:
1. Group under `am registry install/uninstall/update/search`
2. Make `am uninstall` explicitly registry-only (add `am remove server` for manual ones)

Option 1 matches the `am wiki`, `am agents`, `am secret` grouping pattern.

---

#### M3. `am wiki harvest` and `am wiki ingest` are near-duplicates

**Severity:** MEDIUM  
**File:** `src/commands/wiki.ts`

`harvest` produces knowledge entries (old format). `ingest` produces wiki pages (new
format). The codebase acknowledges this with a comment: "Keep 'harvest' as an alias for
backward compat." But they're not aliases — they produce different output types and have
identical argument signatures, which is confusing.

**Recommended:** Deprecate `harvest` with a warning:
```
am wiki harvest is deprecated — use am wiki ingest instead.
```

Then remove in the next major version.

---

#### M4. `am wiki delete` uses `--force` instead of `--yes` for confirmation skip

**Severity:** MEDIUM  
**File:** `src/commands/wiki.ts`

Most destructive commands use `--yes` / `-y` to skip confirmation:
- `am profile delete --yes`
- `am uninstall --yes`
- `am update --yes`

But `am wiki delete` uses `--force` / `-f`:
```bash
am wiki delete my-page --force
```

**Recommended:** Standardize on `--yes` / `-y` for all confirmation skips. `--force` should
be reserved for "overwrite even when drifted" (as `am apply --force` already uses it).

---

#### M5. `am init --project` is a hidden dual-purpose flag, not a subcommand

**Severity:** MEDIUM  
**File:** `src/commands/init.ts`

`am init` does global initialization. `am init --project` scans the workspace and creates
`.agent-manager.toml`. These are fundamentally different operations hidden behind a boolean
flag.

Compare:
- `chezmoi init` and `chezmoi init --apply` — same operation with extra step
- `am init` and `am init --project` — completely different operations

The implementation delegates to a separate file (`init-project.ts`), confirming they're
distinct operations.

**Recommended:** Register as a subcommand visible in help:
```bash
am init              # global setup (existing)
am init project      # workspace scan (existing --project behavior)
```

This is already hinted at in the README: `am init --project`.

---

#### M6. `am version` doesn't support `--verbose`

**Severity:** MEDIUM  
**File:** `src/commands/version.ts`

`am version` only prints the version string. Diagnostic tools like `am doctor` exist
separately, but a `--verbose` version command could print runtime info useful for
bug reports:

```
am version --verbose
0.1.0
  Runtime: Bun 1.3.x
  Platform: darwin-arm64
  Config: ~/.config/agent-manager
  Adapters: 13 (7 detected)
```

Compare: `brew --version` shows Homebrew + Ruby + Git + Clang versions.

**Recommended:** Add `--verbose` to `am version` for diagnostic output.

---

#### M7. `am config` has only `show` and `validate` — missing `edit` and `path`

**Severity:** MEDIUM  
**File:** `src/commands/config.ts`

Users frequently need to open the config in an editor or find its path. Currently they
must know the path (`~/.config/agent-manager/config.toml`) by heart.

Compare:
- `chezmoi edit-config` — opens `$EDITOR`
- `chezmoi source-path` — prints the path
- `brew --prefix` — prints the install path

**Recommended:** Add at minimum:
```bash
am config path              # print config dir path
am config edit              # open in $EDITOR
```

---

#### M8. `am log --count` should be `-n` for git-muscle-memory users

**Severity:** MEDIUM  
**File:** `src/commands/log.ts`

`am log` wraps git log but uses `--count` instead of git's `-n` / `--max-count`.
Users with git muscle memory will try `am log -n 5` and get an error.

**Recommended:** Add `-n` as an alias:
```typescript
count: {
  type: "string",
  alias: "n",
  description: "Number of entries to show (default: 20)",
  default: "20",
}
```

---

### LOW

#### L1. Table output uses `padEnd` — breaks with wide characters (CJK, emoji)

**Severity:** LOW  
**Files:** Multiple (list.ts, search.ts, session.ts, etc.)

All table output uses `String.padEnd()` for column alignment, which counts bytes not
display width. CJK characters and emoji will misalign columns.

**Recommended:** Use a display-width-aware padding function, or switch to a table
rendering library for non-JSON output.

---

#### L2. `am adapter` has only one subcommand (`list`)

**Severity:** LOW  
**File:** `src/commands/adapter.ts`

`am adapter list` is the only subcommand. The parent `am adapter` exists only as a
namespace for this one command. Consider whether `am adapter` should also support:

```bash
am adapter show <name>      # detailed adapter info, config paths, capabilities
am adapter check <name>     # verify a specific adapter's config
```

If not, `am adapter list` could be moved to `am list adapters` (see C2).

---

#### L3. `am agents` uses plural noun, everything else uses singular

**Severity:** LOW  
**File:** `src/commands/agents.ts`, `src/cli.ts`

Command naming:
- `am profile list` (singular)
- `am adapter list` (singular)
- `am secret list` (singular)
- `am session list` (singular)
- `am wiki search` (singular)
- **`am agents list`** (plural)

**Recommended:** Rename to `am agent list` for consistency. Keep `agents` as a hidden
alias for backward compatibility.

---

#### L4. `am doctor` output uses ASCII art icons `[+]`, `[!]`, `[x]`

**Severity:** LOW  
**File:** `src/commands/doctor.ts`

The icons are functional but visually flat. Consider using Unicode symbols for a more
polished look, with ASCII fallback for dumb terminals:

```
Current: [+] Config directory: ~/.config/agent-manager
Proposed: OK  Config directory: ~/.config/agent-manager
```

Or, follow `brew doctor` which uses checkmarks and X marks.

---

#### L5. No shell completions

**Severity:** LOW  

None of the 27 commands generate shell completions. Both chezmoi and brew ship
completions for bash, zsh, and fish. citty may have completion support or a plugin.

**Recommended:** Add `am completion bash|zsh|fish` command for future.

---

#### L6. `am undo` only reverts one level — no `am undo --steps N`

**Severity:** LOW  
**File:** `src/commands/undo.ts`

`am undo` reverts `HEAD` only. There's no way to undo multiple changes or undo a
specific change by hash. This is fine for v1.0 but will be limiting as config history
grows.

**Recommended:** Add `--steps N` for multi-level undo and `--commit <hash>` for
targeted revert.

---

## Consistency Audit

### Global Flag Support Matrix

| Command | `--json` | `--quiet` | `--verbose` | `--profile` | Notes |
|---------|:--------:|:---------:|:-----------:|:-----------:|-------|
| `init` | Y | Y | Y | - | |
| `add` | Y | Y | Y | - | |
| `list` | Y | Y | Y | - | |
| `use` | Y | Y | Y | - | |
| `apply` | Y | Y | Y | Y | |
| `status` | Y | Y | Y | - | |
| `config validate` | Y | Y | Y | - | |
| `config show` | Y | Y | Y | - | |
| `profile list` | Y | Y | Y | - | |
| `profile show` | Y | Y | Y | - | |
| `profile create` | Y | Y | Y | - | |
| `profile delete` | Y | Y | Y | - | |
| `doctor` | Y | Y | Y | - | |
| `import` | Y | Y | Y | - | |
| `push` | Y | Y | Y | - | |
| `pull` | Y | Y | Y | - | |
| `undo` | Y | Y | Y | - | |
| `log` | Y | Y | Y | - | |
| `secret *` | Y | Y | Y | - | All 7 subcommands |
| `version` | Y | Y | **N** | - | Missing `--verbose` |
| `adapter list` | Y | Y | Y | - | |
| `search` | Y | Y | Y | - | |
| `install` | Y | Y | Y | - | |
| `uninstall` | Y | Y | Y | - | |
| `update` | Y | Y | Y | - | |
| `session *` | Y | Y | Y | - | All 3 subcommands |
| `wiki *` | Y | Y | Y | - | All 13 subcommands |
| `agents *` | Y | Y | Y | - | All 5 subcommands |
| **`mcp-serve`** | **N** | **N** | **N** | - | Zero flags |
| **`serve`** | **N** | **N** | **N** | - | Only `--port` |
| **`tui`** | **N** | **N** | **N** | - | Zero flags |

**Summary:** 24/27 commands have full `--json`/`--quiet`/`--verbose` support. The three
missing commands (`mcp-serve`, `serve`, `tui`) are interface launchers where `--json`
makes less sense, but `--verbose` would be useful for `serve`.

### Confirmation Prompt Convention

| Command | Prompt method | Skip flag | Consistent? |
|---------|--------------|-----------|:-----------:|
| `profile delete` | `@clack/prompts confirm` | `--yes` / `-y` | Y |
| `uninstall` | `@clack/prompts confirm` | `--yes` / `-y` | Y |
| `update` | `@clack/prompts confirm` | `--yes` / `-y` | Y |
| `install` | `@clack/prompts confirm` | `--yes` / `-y` | Y |
| `wiki delete` | Manual hint | `--force` / `-f` | **N** |
| `init` | `@clack/prompts confirm` | N/A (not destructive) | Y |

---

## Command Hierarchy Recommendation

Current flat+nested hybrid:

```
am
  init [--project]
  add <name>                    # servers only
  list                          # servers only
  use <profile>
  apply
  status
  config {show, validate}
  profile {list, show, create, delete}
  doctor
  import <source>
  push / pull / undo / log
  secret {set, get, list, scan, install-scanner, generate-key, import-key}
  version
  adapter {list}
  search <query>                # registry only
  install / uninstall / update  # registry only
  session {list, export, search}
  wiki {init, search, add, show, delete, ingest, harvest, synthesize, briefing, export, import, lint, graph}
  agents {list, add, remove, ping, delegate}
  mcp-serve / serve / tui
```

Recommended restructuring (preserving backward compat via aliases):

```
am
  init                          # global setup
  init project                  # workspace scan (was --project)
  
  add server <name>             # was: add <name>
  add instruction <name>        # NEW
  add skill <name>              # NEW
  
  list servers                  # was: list
  list profiles                 # was: profile list
  list adapters                 # was: adapter list
  list instructions             # NEW
  list skills                   # NEW
  
  use <profile>
  apply
  status
  doctor
  version
  
  config {show, validate, path, edit}
  
  profile {show, create, delete}    # list moves to am list profiles
  
  import <source>
  
  push / pull / undo / log      # git sync (no changes)
  
  registry {search, install, uninstall, update}   # was: search/install/uninstall/update
  
  secret {set, get, list, scan, install-scanner, generate-key, import-key}
  
  session {list, export, search}
  
  wiki {init, search, add, show, delete, ingest, synthesize, briefing, export, import, lint, graph}
  
  agent {list, add, remove, ping, delegate}   # was: agents (plural)
  
  mcp-serve / serve / tui       # interfaces (no changes)
  
  completion {bash, zsh, fish}  # NEW (future)
```

---

## Comparison with Reference CLIs

### chezmoi

| Pattern | chezmoi | am | Assessment |
|---------|---------|-----|-----------|
| First-time setup | `chezmoi init` | `am init` | Equivalent |
| Apply changes | `chezmoi apply` | `am apply` | Equivalent |
| Pull + apply | `chezmoi update` | `am pull` (no auto-apply) | am should auto-apply |
| Diff before apply | `chezmoi diff` | `am apply --diff` | am is slightly worse (flag vs command) |
| Edit config | `chezmoi edit-config` | (missing) | Add `am config edit` |
| Status | `chezmoi status` | `am status` | Equivalent |
| Doctor | `chezmoi doctor` | `am doctor` | Equivalent |
| Undo | (via git) | `am undo` | am is better |

### brew

| Pattern | brew | am | Assessment |
|---------|------|-----|-----------|
| Search | `brew search` | `am search` | Equivalent |
| Install | `brew install` | `am install` | Equivalent |
| Uninstall | `brew uninstall` | `am uninstall` | Equivalent |
| Update | `brew update && brew upgrade` | `am update` | am is simpler |
| List installed | `brew list` | `am list` | am is narrower (servers only) |
| Info | `brew info <name>` | (missing) | Add `am show <server>` or `am info` |
| Doctor | `brew doctor` | `am doctor` | Equivalent |
| Completions | `brew completions` | (missing) | Add later |

### ACPX CLI

| Pattern | ACPX | am | Assessment |
|---------|------|-----|-----------|
| Resource-centric | `acpx get pods` | `am list` (servers only) | am should support multiple resource types |
| JSON output | `acpx -o json` | `am --json` | Equivalent |
| Profile/context | `acpx use-context` | `am use` | Equivalent |
| Apply | `acpx apply -f` | `am apply` | Equivalent |

---

## Priority Action Plan

### Phase 1 — Before v1.0 (Critical + High)

1. **C1+C2+C3:** Restructure `am add` and `am list` to accept entity type as first arg
2. **H3:** Replace 13 inline "Config not found" messages with `requireConfig()`
3. **H4:** Make `am pull` auto-apply (add `--no-apply` opt-out)
4. **H5:** Create `parsePositiveInt()` helper for numeric flags

### Phase 2 — Post v1.0 (Medium)

5. **M1+M2:** Group registry commands under `am registry`
6. **M3:** Deprecate `am wiki harvest`
7. **M4:** Standardize `--yes` for all confirmation skips
8. **M5:** Make `am init project` a subcommand
9. **M6:** Add `--verbose` to `am version`
10. **M7:** Add `am config path` and `am config edit`
11. **M8:** Add `-n` alias to `am log --count`

### Phase 3 — Polish (Low)

12. **L1:** Display-width-aware table rendering
13. **L2:** Expand or collapse `am adapter`
14. **L3:** Rename `am agents` to `am agent`
15. **L4:** Improve `am doctor` output styling
16. **L5:** Shell completions
17. **L6:** Multi-level `am undo`
