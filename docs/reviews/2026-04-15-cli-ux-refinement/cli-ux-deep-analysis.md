# CLI UX Deep Analysis — agent-manager (`am`)

**Reviewer:** CLI UX deep-analysis agent
**Date:** 2026-04-15
**Scope:** All 29 commands (27 original + `run`, `session` via `run session`), remaining HIGH/MEDIUM issues from Phase 1, new command fit analysis, command grouping, help text quality, error consistency
**Compared against:** chezmoi, brew, gh CLI, ACPX, clig.dev guidelines

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Phase 1 Critical Fixes — Verification](#phase-1-critical-fixes)
3. [Remaining HIGH Issues — Detailed Analysis](#remaining-high-issues)
4. [New Command Fit Analysis (`am run`, `am run session`)](#new-command-fit)
5. [Command Grouping Restructure](#command-grouping)
6. [Help Text Quality Audit](#help-text-quality)
7. [Error Consistency Audit](#error-consistency)
8. [Comparison Table: am vs Best-in-Class CLIs](#comparison-table)
9. [New Findings](#new-findings)
10. [Priority Action Plan](#priority-action-plan)
11. [ADR-0029 Draft: Command Grouping Restructure](#adr-0029)

---

## Executive Summary

The Phase 1 review identified 22 issues. Three criticals (C1-C3) were resolved: `am add` and `am list` now accept entity types as positional arguments, and the README matches the actual CLI.

This deep analysis covers the **5 remaining HIGHs**, evaluates how the new **`am run`** command fits the hierarchy, proposes a **command grouping restructure** for help output, audits **error consistency** across all 29 commands, and benchmarks against `gh`, `brew`, `chezmoi`, and `clig.dev` guidelines.

**Key findings:**
- "Config not found" appears in **19 command locations** (up from 13 reported), with a `requireConfig()` helper sitting unused in `src/lib/errors.ts`
- `am run` introduces a third agent-related namespace (`am agents` for A2A, `am run agents` for ACP, `am list agents` for config) that will confuse users
- 8 `Number.parseInt()` calls have no validation — `am log --count abc` silently produces `NaN`
- `am pull` still does not auto-apply despite its description claiming it does
- Help output is a flat alphabetical list of 29 commands with no grouping — gh CLI's grouped approach would dramatically improve scannability

---

## Phase 1 Critical Fixes — Verification {#phase-1-critical-fixes}

| Issue | Status | Evidence |
|-------|--------|----------|
| C1: `am add` too broad | **Fixed** | `add.ts` now accepts `[server\|instruction\|skill\|agent]` as first positional, with backward compat fallback to `server` |
| C2: `am list` too narrow | **Fixed** | `list.ts` now accepts `[servers\|instructions\|skills\|agents\|profiles]` with singular/plural normalization |
| C3: README mismatch | **Fixed** | README shows `am add server <name>`, matches actual CLI |

All three fixes are well-implemented with backward compatibility preserved.

---

## Remaining HIGH Issues — Detailed Analysis {#remaining-high-issues}

### H1. `--json` output inconsistency across commands

**Severity:** HIGH
**Status:** Still present, with additional nuances found

**Detailed audit of all 29 commands:**

| Pattern | Commands | Issue |
|---------|----------|-------|
| Correct: `output()` for JSON, `info()` for human | `add`, `list`, `install`, `uninstall`, `update`, `status`, `profile *`, `agents *`, `session *`, `run *` | None |
| Missing JSON path entirely | `config show` (raw mode, no `--resolved`) | Prints raw TOML with `info()`, no JSON alternative without `--resolved` |
| Bypasses output helper | `secret get` | `console.log(decrypted)` in non-JSON mode — actually correct for piping but undocumented |
| `output()` only (no human fallback) | `wiki export --format json` | Without `--json`, nothing prints. `--format json` and `--json` are independent concerns |
| Inconsistent JSON structure | `push`, `pull` | Error path uses `console.error(JSON.stringify(...))` directly, bypassing `error()` helper |

**New finding: `push` and `pull` have inline error JSON**

```typescript
// push.ts:30-37 and pull.ts:28-36 — bypasses error() helper
if (args.json) {
  console.error(JSON.stringify({
    error: "No remote configured",
    suggestion: "Add a remote URL to your config repo",
  }));
} else {
  console.error("error: No remote configured");
}
```

This should use `amError()` from `src/lib/output.ts` with a thrown `AmError`.

**Concrete fix:**

```typescript
// Before (push.ts, pull.ts):
if (status.remotes.length === 0) {
  if (args.json) {
    console.error(JSON.stringify({ error: "No remote configured", ... }));
  } else {
    console.error("error: No remote configured");
  }
  process.exitCode = 1;
  return;
}

// After:
if (status.remotes.length === 0) {
  throw new AmError(
    "No remote configured",
    "Add a remote URL to your config repo",
    "NO_REMOTE",
  );
}
```

With a top-level `try/catch` in the command's `run()` that calls `amError(err, opts)`.

**Recommendation:**
1. Document the output contract in a `CONTRIBUTING.md` section
2. Replace all inline `console.error(JSON.stringify(...))` with `amError()` calls
3. Add a `--format` global flag (text, json, toml) — separate from `--json` which becomes `--format json` sugar

---

### H2. `mcp-serve`, `serve`, `tui` accept zero global flags

**Severity:** HIGH (downgraded to MEDIUM for `mcp-serve` and `tui`)
**Status:** Still present

**Detailed assessment per command:**

| Command | Current flags | Should add | Rationale |
|---------|--------------|------------|-----------|
| `mcp-serve` | None | `--verbose` | JSON-RPC server, but `--verbose` for request/response logging is valuable for debugging |
| `serve` | `--port` only | `--verbose`, `--host`, `--json` (startup info) | Web server should log requests in verbose mode, bind to configurable host, emit startup JSON for automation |
| `tui` | None | None needed | Interactive app — flags don't apply |

**Concrete fix for `serve.ts`:**

```typescript
// Before:
args: {
  port: { type: "string", description: "Port to listen on", default: "3456" },
},

// After:
args: {
  port: { type: "string", description: "Port to listen on", default: "3456" },
  host: { type: "string", description: "Bind address", default: "localhost" },
  json: { type: "boolean", description: "JSON startup output", default: false },
  verbose: { type: "boolean", alias: "v", description: "Log HTTP requests", default: false },
  quiet: { type: "boolean", alias: "q", description: "Suppress banner", default: false },
},
async run({ args }) {
  const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
  const port = parsePositiveInt(args.port, "port");
  if (port > 65535) {
    throw new AmError("Port must be between 1 and 65535", "Use a valid port number");
  }
  // ... existing logic ...
  if (args.json) {
    output({ url: `http://${args.host}:${port}`, port, host: args.host }, opts);
  } else if (!args.quiet) {
    console.log(`Dashboard running at http://${args.host}:${port}`);
  }
}
```

**Revised severity:** `mcp-serve` is MEDIUM (JSON-RPC protocol server — `--verbose` nice-to-have). `serve` remains HIGH. `tui` is LOW (interactive app, no flags needed).

---

### H3. Error handling bypasses `AmError` — "Config not found" x19

**Severity:** HIGH
**Status:** Worse than reported. Now 19 occurrences in command files (was 13).

**Full inventory of "Config not found" locations:**

| File | Line | Pattern |
|------|------|---------|
| `add.ts` | 109 | `error("Config not found. Run \`am init\` first.", opts)` |
| `add.ts` | 232 | Same |
| `apply.ts` | 36 | Same |
| `config.ts` | 143 | Same |
| `import.ts` | 91 | Same |
| `install.ts` | 42 | Same |
| `list.ts` | 65 | Same |
| `profile.ts` | 45 | Same |
| `profile.ts` | 101 | Same |
| `profile.ts` | 157 | Same |
| `profile.ts` | 217 | Same |
| `pull.ts` | 22 | Same |
| `push.ts` | 24 | Same |
| `secret.ts` | 70 | Same |
| `secret.ts` | 134 | Same |
| `secret.ts` | 179 | Same |
| `secret.ts` | 280 | Same |
| `status.ts` | 29 | Same |
| `uninstall.ts` | 30 | Same |
| `update.ts` | 48 | Same |
| `use.ts` | 63 | Same |

**The unused helper that already exists:**

```typescript
// src/lib/errors.ts:59-70
export function requireConfig<T>(
  config: T | null | undefined,
  action = "this command",
): asserts config is T {
  if (config == null) {
    throw new AmError(
      "Config not found",
      "Run `am init` to initialize agent-manager",
      "CONFIG_NOT_FOUND",
    );
  }
}
```

**Concrete fix pattern — convert commands to use it:**

```typescript
// Before (repeated 19+ times):
let config;
try {
  config = await readConfig(configPath);
} catch {
  error("Config not found. Run `am init` first.", opts);
  process.exitCode = 1;
  return;
}

// After (once per command, with top-level try/catch):
async run({ args }) {
  const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
  try {
    const config = await tryReadConfig(configPath);
    requireConfig(config);
    // ... rest of command logic ...
  } catch (err) {
    amError(err, opts);
    process.exitCode = 1;
  }
}
```

**Additional benefit:** The `AmError` has a `code` field (`CONFIG_NOT_FOUND`), which enables `--json` consumers to programmatically detect this condition rather than parsing error strings.

**Effort estimate:** Mechanical refactor across 21 files. Each file needs:
1. Import `requireConfig` from `../lib/errors`
2. Replace `readConfig()` try/catch with `tryReadConfig()` + `requireConfig()`
3. Add top-level try/catch calling `amError(err, opts)`

---

### H4. `am pull` does not auto-apply, contradicting its description

**Severity:** HIGH
**Status:** Still present, unchanged.

**Current behavior (`pull.ts:43-49`):**

```typescript
await pull(configDir);
info(`Pulled from ${status.remotes[0].url}`, opts);
info("Run `am apply` to regenerate native configs", opts);  // <-- hint, not action
```

**Description mismatch:**
- `pull.ts:8` meta description: `"Pull config changes from remote and auto-apply"`
- README: `"am pull — Pull from remote + auto-apply"`

**Concrete fix — actually auto-apply:**

```typescript
// After pull succeeds:
await pull(configDir);
info(`Pulled from ${status.remotes[0].url}`, opts);

// Auto-apply unless --no-apply
if (!args["no-apply"]) {
  const { applyAll } = await import("../core/apply");
  const applyResult = await applyAll(configDir, profileName, opts);
  info(`Applied to ${applyResult.adaptersUpdated} tool(s)`, opts);
} else {
  info("Run `am apply` to regenerate native configs", opts);
}
```

**New flags needed:**

```typescript
args: {
  "no-apply": {
    type: "boolean",
    description: "Pull without auto-applying",
    default: false,
  },
  // ... existing flags ...
}
```

**Why auto-apply is the right default:**
- `chezmoi update` applies after pulling
- `git pull` already changes your working tree
- Users who want pull-only can use `--no-apply` or `git pull` directly

---

### H5. Numeric flags stored as strings, no validation

**Severity:** HIGH
**Status:** Still present, with more locations found than originally reported.

**Full inventory of `Number.parseInt()` calls without validation:**

| File | Flag | Default | Validation? |
|------|------|---------|:-----------:|
| `serve.ts:14` | `--port` | `"3456"` | Partial (checks NaN and range, but accepts "3.5") |
| `log.ts:40` | `--count` | `"20"` | None |
| `run.ts:106` | `--timeout` | `300` (via `\|\| 300`) | Silent fallback (NaN -> 300, "-5" -> -5) |
| `wiki.ts:71` | `--limit` (search) | `"20"` | Silent fallback (NaN -> 20) |
| `wiki.ts:350` | `--limit` (ingest) | `"10"` | Silent fallback |
| `wiki.ts:458` | `--limit` (harvest) | `"10"` | Silent fallback |
| `wiki.ts:569` | `--top-k` (synthesize) | `"10"` | Silent fallback |
| `search.ts:25` | `--limit` | `20` (via `\|\| 20`) | Silent fallback |

**Problem: silent fallback masks user errors.** `am log --count abc` silently shows 20 entries (the `|| 20` fallback), giving no indication the flag was ignored.

**Concrete fix — create a shared validator:**

```typescript
// src/lib/validators.ts (new file, or add to output.ts)

import { AmError } from "./errors";

/**
 * Parse a string flag as a positive integer.
 * Throws AmError with a clear message if invalid.
 */
export function parsePositiveInt(value: string, flagName: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 1) {
    throw new AmError(
      `Invalid value for --${flagName}: "${value}"`,
      `Provide a positive integer`,
      "INVALID_FLAG",
    );
  }
  return n;
}

/**
 * Parse a port number (1-65535).
 */
export function parsePort(value: string): number {
  const n = parsePositiveInt(value, "port");
  if (n > 65535) {
    throw new AmError(
      `Port ${n} is out of range`,
      `Provide a port between 1 and 65535`,
      "INVALID_PORT",
    );
  }
  return n;
}
```

**Before/after for `log.ts`:**

```typescript
// Before:
entries = await gitLog(configDir, Number.parseInt(args.count, 10));

// After:
const count = parsePositiveInt(args.count, "count");
entries = await gitLog(configDir, count);
```

---

## New Command Fit Analysis (`am run`, `am run session`) {#new-command-fit}

### Current State

`am run` (defined in `src/commands/run.ts`) adds the ACP (Agent Control Protocol) runtime to the CLI. It has this structure:

```
am run <agent> <prompt>             # one-shot agent execution
am run --session <name> <agent> <prompt>  # named session
am run agents                       # list available ACP agents
am run session list <agent>         # list active sessions
am run session cancel <agent> <id>  # cancel a session
```

### Problem: Three Agent Namespaces

The CLI now has **three separate "agents" concepts** with overlapping naming:

| Command | Domain | What it does |
|---------|--------|-------------|
| `am agents list` | A2A protocol | List discovered A2A agents in roster |
| `am agents add/remove/ping/delegate` | A2A protocol | Manage A2A agent roster |
| `am run agents` | ACP runtime | List locally available coding agents |
| `am list agents` | Config | List agent profiles from config.toml |

A user asking "how do I see my agents?" has three valid answers depending on which "agents" they mean.

### Problem: `am run session` vs `am session`

| Command | Domain | What it does |
|---------|--------|-------------|
| `am session list` | Session harvest | List past IDE session transcripts |
| `am session export <id>` | Session harvest | Export a session transcript |
| `am run session list <agent>` | ACP runtime | List active ACP sessions for an agent |
| `am run session cancel <agent> <id>` | ACP runtime | Cancel an ACP session |

Again, `am session` means two different things.

### Recommendation: Namespace Segregation

The cleanest resolution follows the `gh` CLI pattern (noun-verb, group by domain):

```
# ACP agent execution (NEW — keep as-is, it's clean)
am run <agent> <prompt>
am run --session <name> <agent> <prompt>

# ACP session management (move under `am run`)
am run session list <agent>
am run session cancel <agent> <id>
am run agents                        # list available ACP agents

# A2A protocol (rename from `agents` to `a2a` for disambiguation)
am a2a list                          # was: am agents list
am a2a add <url>                     # was: am agents add
am a2a remove <name>
am a2a ping <name>
am a2a delegate <name> <task>
am a2a cancel <name> <taskId>

# Config agent profiles (stay under `am list`)
am list agents                       # list config-defined agent profiles
```

**Rationale:**
- `am run` = "execute something now" (ACP runtime domain)
- `am a2a` = "A2A protocol operations" (network/discovery domain)
- `am list agents` = "show what's in my config" (config domain)

**Alternative:** Keep `am agents` for A2A but add a `am agents --scope acp|a2a|config` flag. This is worse because it overloads a single namespace.

### `am run` Internal Quality

The `run.ts` implementation is solid:
- Follows the global flag pattern (`--json`, `--quiet`, `--verbose`)
- Has proper error handling with `AcpClientError`
- Streaming output is well-implemented (text chunks via `process.stdout.write`)
- Timeout handling uses `Promise.race`

**Issues found:**

1. **H5 applies here:** `timeout` flag uses `Number.parseInt(args.timeout as string) || 300` — no validation, silent fallback
2. **Type assertion:** `await runMainCommand.run!({ args: args as any })` — the `as any` in the top-level `run()` handler is a type safety escape hatch. Should be refactored to extract shared logic into a function both commands call.
3. **Missing `--cwd` in top-level export:** The `cwd` flag is defined but the top-level `runCommand` delegates to `runMainCommand.run!()` which re-reads `args.cwd`. This works but is fragile.

---

## Command Grouping Restructure {#command-grouping}

### Problem: Flat Command List

Currently `am --help` displays all 29 commands in alphabetical order. As the command count grows (it went from 27 to 29 in one sprint), this becomes unscalnable. Compare:

**Current (`am --help` equivalent):**
```
COMMANDS:
  adapter, add, agents, apply, config, doctor, import, init, install,
  list, log, mcp-serve, profile, pull, push, run, search, secret,
  serve, session, status, tui, undo, uninstall, update, use, version,
  wiki
```

**gh CLI (`gh --help`):**
```
CORE COMMANDS
  pr:         Manage pull requests
  issue:      Manage issues
  repo:       Manage repositories

ADDITIONAL COMMANDS
  auth:       Manage authentication
  config:     Manage configuration
  ...
```

### Proposed Grouping for `am --help`

```
GETTING STARTED
  init              First-time setup -- detect tools, import configs, init git repo
  import <adapter>  Import native config from an AI tool
  doctor            Health check -- config, adapters, git, secrets

CONFIG MANAGEMENT
  add               Add an entity (server, instruction, skill, agent)
  list              List entities (servers, instructions, skills, agents, profiles)
  use <profile>     Switch active profile
  apply             Generate native configs for detected tools
  status            Drift detection across all tools + git sync status
  config            View and validate configuration (show, validate)
  profile           Manage profiles (list, show, create, delete)

GIT SYNC
  push              Push config changes to remote
  pull              Pull from remote + auto-apply
  undo              Revert last config change
  log               Config change history

REGISTRY
  search <query>    Search the MCP registry
  install <pkg>     Install MCP server packages
  uninstall <name>  Remove a server package
  update            Check for and apply registry updates

AGENTS & RUNTIME
  run               Run an ACP-compatible coding agent
  agents            Manage A2A agent discovery and delegation

KNOWLEDGE
  wiki              LLM Wiki -- knowledge synthesis from sessions
  session           Browse and export tool sessions

SECURITY
  secret            Manage encrypted secrets (set, get, scan, ...)

INTERFACES
  serve             Local web dashboard
  tui               Interactive terminal dashboard
  mcp-serve         Run as MCP server (stdio)

OTHER
  adapter list      Show all registered adapters
  version           Print version

GLOBAL FLAGS
  --profile <name>  Override active profile
  --json            JSON output for scripting
  --verbose, -v     Increase log verbosity
  --quiet, -q       Suppress non-essential output
```

### Implementation in citty

citty does not natively support command groups in help output. Options:

1. **Custom help formatter** — Override citty's default help rendering to group commands. This is the cleanest approach.
2. **Top-level `run()` handler** — Intercept `--help` in the main command's `run()` and print custom formatted help.
3. **Helper commands** — Add `am help` as a command that prints the grouped view.

**Recommendation:** Option 1. Create a `src/lib/help.ts` that formats grouped help and register it as citty's help handler. This is a one-time investment that pays off as command count grows.

---

## Help Text Quality Audit {#help-text-quality}

### Command Descriptions

| Command | Description | Quality | Notes |
|---------|------------|:-------:|-------|
| `init` | "Initialize agent-manager config and git repo" | Good | |
| `add` | "Add an entity to the config (server, instruction, skill, agent)" | Good | Fixed from Phase 1 |
| `list` | "List entities in the config (servers, instructions, skills, agents, profiles)" | Good | Fixed from Phase 1 |
| `use` | "Switch active profile" | Good | |
| `apply` | "Generate native configs for detected tools" | Good | |
| `status` | "Show config and drift status" | Good | |
| `config` | "Manage agent-manager configuration" | Vague | Should say "View and validate configuration" |
| `profile` | "Manage profiles" | Vague | Should say "Manage config profiles (list, show, create, delete)" |
| `doctor` | "Health check for agent-manager" | Good | |
| `import` | "Import servers from a tool's native config" | Good | |
| `push` | "Push config changes to remote" | Good | |
| `pull` | "Pull config changes from remote and auto-apply" | **Wrong** | Does not auto-apply (H4) |
| `undo` | "Revert the last config change" | Good | |
| `log` | "Show config change history" | Good | |
| `secret` | "Manage encrypted secrets" | Good | |
| `version` | "Print version" | Good | |
| `adapter` | "Manage adapters" | Vague | Only has `list` subcommand |
| `mcp-serve` | "Start agent-manager as an MCP server (stdio transport)" | Good | |
| `serve` | "Start the web dashboard" | Good | |
| `tui` | "Launch interactive TUI dashboard" | Good | |
| `session` | "Browse and export tool sessions" | Good | |
| `search` | "Search the MCP registry for packages" | Good | |
| `install` | "Install MCP server packages from the registry" | Good | |
| `uninstall` | "Remove an MCP server package from config" | Good | |
| `update` | "Check for and apply MCP registry updates" | Good | |
| `wiki` | "LLM Wiki -- knowledge synthesis from agent sessions" | Good | |
| `agents` | "Manage A2A agent discovery and delegation" | Good | |
| `run` | "Run an ACP-compatible coding agent or manage sessions" | Good | Dual purpose is clear |

### Missing: Examples in Help Text

Per clig.dev guidelines, help text should "lead with examples." None of the 29 commands include example invocations in their help output. This is the single highest-impact improvement for new users.

**Recommendation:** Add a `meta.examples` field (if citty supports it) or append examples to the description:

```typescript
meta: {
  name: "add",
  description: `Add an entity to the config (server, instruction, skill, agent)

Examples:
  am add server tavily --command "bunx tavily-mcp@latest"
  am add instruction ts-strict --content "Use strict TypeScript" --scope always`,
},
```

---

## Error Consistency Audit {#error-consistency}

### Error Output Patterns Found

| Pattern | Count | Commands | Correct? |
|---------|------:|----------|:--------:|
| `error(msg, opts)` via output helper | 19 | Most commands | Yes |
| `console.error(msg)` directly | 4 | `serve`, `apply` (adapter error), `push`, `pull` | No |
| `console.error(JSON.stringify(...))` inline | 2 | `push`, `pull` (no-remote path) | No |
| `amError(err, opts)` via structured helper | 0 | None | N/A |
| `throw new AmError(...)` | 0 | None | N/A |

**Key finding:** The `AmError` class, `formatError()`, `amError()`, and `requireConfig()` exist in `src/lib/errors.ts` and `src/lib/output.ts` but are **used by zero commands**. They are dead code.

### Error Message Consistency

| Error Condition | Message Variations |
|----------------|-------------------|
| Config missing | "Config not found. Run \`am init\` first." (19x, identical) |
| Config missing (requireConfig) | "Config not found" + suggestion "Run \`am init\` to initialize agent-manager" (0x, unused) |
| Adapter not found | "Adapter \"%s\" not found" + "available: ..." (2 variations: `apply.ts` and `import.ts` format differently) |
| No remote | "No remote configured" (2x, `push` and `pull`, identical) |
| Profile not found | "Profile \"%s\" not found" (1x, consistent) |

**Recommendation: Error taxonomy**

Create error codes for common conditions and use `AmError` consistently:

| Code | Message | Suggestion |
|------|---------|-----------|
| `CONFIG_NOT_FOUND` | "Config not found" | "Run \`am init\` to initialize agent-manager" |
| `NO_REMOTE` | "No remote configured" | "Add a remote URL to your config repo" |
| `ADAPTER_NOT_FOUND` | "Adapter \"%s\" not found" | "Available adapters: ..." |
| `PROFILE_NOT_FOUND` | "Profile \"%s\" not found" | "Available profiles: ..." |
| `SERVER_NOT_FOUND` | "Server \"%s\" not found in config" | null |
| `AGENT_NOT_FOUND` | "Agent \"%s\" not found" | context-dependent |
| `INVALID_FLAG` | "Invalid value for --%s: \"%s\"" | "Provide a positive integer" |

---

## Comparison Table: am vs Best-in-Class CLIs {#comparison-table}

### Structural Patterns

| Pattern | gh | brew | chezmoi | am (current) | am (recommended) |
|---------|:--:|:----:|:-------:|:------------:|:----------------:|
| Command groups in help | Yes (Core/Additional) | Yes (Main/Developer) | No (flat) | No (flat) | Yes |
| Noun-verb ordering | Yes (`gh pr create`) | N/A (flat) | N/A (flat) | Partial (`wiki search`) | Yes |
| Consistent CRUD verbs | Yes | Yes | N/A | Inconsistent | Yes |
| Examples in help text | Yes | Yes | Yes | No | Yes |
| Shell completions | Yes (bash/zsh/fish/ps) | Yes (bash/zsh) | Yes | No | Future |
| `--format` flag | Yes (json, text) | Yes | No | `--json` only | Add `--format` |
| Error suggestions | Yes | Yes | Yes | Partial | Yes (via AmError) |
| `help` sub-topics | Yes (env, formatting) | Yes | No | No | Consider |

### Confirmation Patterns

| Action | gh | brew | chezmoi | am | clig.dev |
|--------|:--:|:----:|:-------:|:--:|:--------:|
| Destructive delete | `--yes` | N/A | `--force` | Mixed (`--yes` + `--force`) | `--force` for scripts |
| Overwrite | N/A | `--force` | `--force` | `--force` | `--force` |
| Batch operations | N/A | `--yes` | N/A | `--yes` | `--yes` |

**Recommendation:** Standardize on `--yes`/`-y` for "skip confirmation prompt" and `--force`/`-f` for "overwrite despite conflicts." The `wiki delete --force` should become `wiki delete --yes`.

### Output Patterns

| Feature | gh | brew | chezmoi | am |
|---------|:--:|:----:|:-------:|:--:|
| `--json` flag | Per-command, with field selection | No | No | Global, all-or-nothing |
| Stable text output | `--format text` | Default | Default | No guarantee |
| Color control | `NO_COLOR`, `--color` | `NO_COLOR` | N/A | No control |
| Pager for long output | Yes | Yes | No | No |

---

## New Findings {#new-findings}

### N1. `am run` uses `as any` type assertion

**Severity:** MEDIUM
**File:** `src/commands/run.ts:409`

```typescript
await runMainCommand.run!({ args: args as any });
```

The top-level `runCommand` defines the same args as `runMainCommand` but delegates via `as any`. This breaks type safety and will silently pass wrong args if the two arg definitions drift apart.

**Fix:** Extract the shared run logic into a standalone function that both commands call:

```typescript
async function executeRun(args: RunArgs, opts: OutputOptions) { ... }
```

### N2. `am wiki harvest` is a full code duplicate of `am wiki ingest`

**Severity:** MEDIUM
**File:** `src/commands/wiki.ts:444-553`

`harvestSubcommand` is a ~110-line function that is nearly identical to `ingestSubcommand` except it calls `harvestSession()` instead of `harvestSessionAsPages()`. This is a maintenance burden.

**Fix:** Extract shared logic into a helper, parameterized by the harvest function:

```typescript
async function processSessionsInto(mode: "pages" | "entries", args, opts) { ... }
```

### N3. `am apply` error path bypasses `error()` helper

**Severity:** LOW
**File:** `src/commands/apply.ts:64-72`

When an adapter is not found, `apply.ts` uses `console.error()` directly instead of `error()`:

```typescript
if (args.json) {
  console.error(JSON.stringify({ error: `Adapter "${args.target}" not found`, ... }));
} else {
  console.error(`error: Adapter "${args.target}" not found`);
}
```

Should use `throw new AmError(...)` instead.

### N4. `am use` error path bypasses `error()` helper

**Severity:** LOW
**File:** `src/commands/use.ts:72-80`

Same pattern as N3:

```typescript
if (args.json) {
  console.error(JSON.stringify({ error: `Profile "${profile}" not found`, ... }));
} else {
  console.error(`error: Profile "${profile}" not found`);
}
```

### N5. `am version` missing `--verbose` for diagnostics

**Severity:** MEDIUM (from M6)
**File:** `src/commands/version.ts`

Currently only 19 lines. Missing `--verbose` flag that could output runtime info for bug reports:

```
$ am version --verbose
0.1.0
  Runtime: Bun 1.x.x
  Platform: darwin-arm64
  Config: ~/.config/agent-manager
  Adapters: 13 (7 detected)
  Node: v22.x.x
```

Compare: `brew --version` shows Homebrew, Ruby, and Git versions.

### N6. No `NO_COLOR` support

**Severity:** LOW

The CLI does not check the `NO_COLOR` environment variable (standard: https://no-color.org/). While `am` currently uses minimal color (mostly via `@clack/prompts`), this should be respected as the output system grows.

### N7. `am config show` without `--resolved` lacks `--json` path

**Severity:** LOW
**File:** `src/commands/config.ts:155-165`

When `--resolved` is not set and `--json` is set, the command parses TOML and outputs JSON. But without `--resolved`, the `--json` flag on the _parent_ command isn't forwarded cleanly. The non-resolved path works but the code path is less explicit.

---

## Priority Action Plan {#priority-action-plan}

### Immediate (before next release)

| # | Issue | Effort | Impact |
|---|-------|--------|--------|
| 1 | **H3:** Replace all 19 "Config not found" with `requireConfig()` | Medium (mechanical refactor, 21 files) | High — eliminates dead code, adds error codes for JSON consumers |
| 2 | **H5:** Create `parsePositiveInt()` and apply to all 8 `Number.parseInt` sites | Small | High — prevents silent NaN bugs |
| 3 | **H4:** Make `am pull` auto-apply (add `--no-apply` flag) | Small | High — fixes documented behavior |

### Next sprint

| # | Issue | Effort | Impact |
|---|-------|--------|--------|
| 4 | **H1:** Replace inline `console.error(JSON.stringify(...))` in push/pull/apply/use with `AmError` throws | Small | Medium — consistent error output |
| 5 | **H2:** Add `--verbose`, `--host`, `--json` to `am serve` | Small | Medium — enables automation |
| 6 | **N1:** Fix `as any` in `run.ts` by extracting shared execute function | Small | Medium — type safety |
| 7 | **Command grouping:** Implement grouped help output | Medium | High — dramatically improves discoverability |

### Future

| # | Issue | Effort | Impact |
|---|-------|--------|--------|
| 8 | Agent namespace disambiguation (A2A vs ACP vs config) | Medium (ADR needed) | High — prevents user confusion at scale |
| 9 | Add examples to all command help text | Medium (29 commands) | High — clig.dev #1 recommendation |
| 10 | `--format` global flag (text/json/toml) | Medium | Medium — cleaner than `--json` boolean |
| 11 | Deprecate `am wiki harvest` in favor of `ingest` | Small | Low |
| 12 | Standardize `--yes` for all confirmation skips (wiki delete) | Small | Low |
| 13 | `NO_COLOR` support | Small | Low |
| 14 | Shell completions (`am completion bash\|zsh\|fish`) | Large | Medium |

---

## ADR-0029 Draft: Command Grouping and Help Restructure {#adr-0029}

---

```markdown
---
status: proposed
date: 2026-04-15
---

# ADR-0029: Command Grouping and Help Restructure

## Context

The agent-manager CLI has grown to 29 commands. The current help output lists
all commands alphabetically with no grouping. As commands continue to be added
(ACP runtime, possible `completion`, `upgrade`, etc.), the flat list becomes
unscalable for users.

Additionally, three separate namespaces now deal with "agents":
- `am agents` — A2A protocol agent roster management
- `am run agents` — ACP runtime agent discovery
- `am list agents` — Config-defined agent profiles

This creates ambiguity. A user asking "how do I see my agents?" gets three
different answers depending on which "agents" they mean.

### Reference CLIs

- **gh CLI** groups commands into "Core" and "Additional" sections with
  descriptions, making the help output scannable at a glance.
- **brew** groups into "Main," "Developer," and "External" sections.
- **kubectl** groups by lifecycle stage: "Basic," "Deploy," "Cluster
  Management," "Troubleshooting."
- **clig.dev** recommends: "If you've got lots of subcommands, group them
  by workflow stage."

## Decision

### 1. Grouped Help Output

Implement a custom help formatter that organizes commands into functional
groups in `am --help` output:

| Group | Commands |
|-------|----------|
| Getting Started | init, import, doctor |
| Config Management | add, list, use, apply, status, config, profile |
| Git Sync | push, pull, undo, log |
| Registry | search, install, uninstall, update |
| Agents & Runtime | run, agents |
| Knowledge | wiki, session |
| Security | secret |
| Interfaces | serve, tui, mcp-serve |
| Other | adapter, version |

Each command shows a one-line description next to it.

### 2. Agent Namespace Segregation (Future)

Rename `am agents` to `am a2a` to disambiguate from ACP agents (`am run`)
and config agent profiles (`am list agents`). Keep `am agents` as a hidden
alias for backward compatibility.

This is deferred until the A2A protocol support stabilizes, but the grouping
restructure in (1) should already separate these visually.

### 3. Implementation

Create `src/lib/help.ts` with a `formatGroupedHelp()` function. Hook it
into citty's help rendering by intercepting the default `--help` handler in
the main command's `run()` method. If citty provides no hook, use a custom
`run()` that prints grouped help when no subcommand is provided.

## Consequences

### Positive

- Help output is scannable at 29+ commands
- New commands have a clear home — contributors know which group to add to
- The "agents" ambiguity is visually mitigated by grouping even before a rename

### Negative

- Custom help formatter is a maintenance surface (must be updated when commands are added)
- Renaming `am agents` to `am a2a` requires migration period with backward-compat alias

### Neutral

- No change to actual command behavior — purely a presentation layer change
- Command names themselves don't change (except the future `agents` -> `a2a`)

## Alternatives Considered

1. **citty built-in groups** — citty does not support command groups natively.
   Would require a citty PR or fork.
2. **`am help <group>`** — Show groups via a separate help command. Rejected
   because it adds a step; the top-level `--help` should be sufficient.
3. **Umbrella parent commands** — Group under `am config add`, `am config list`,
   `am git push`, etc. Rejected because it adds typing overhead to the most
   common commands and breaks backward compatibility.

## References

- [clig.dev](https://clig.dev/) — CLI Guidelines
- [gh CLI manual](https://cli.github.com/manual/) — Grouped help pattern
- Phase 1 CLI UX review: `docs/reviews/2026-04-15-mcp-a2a-cli-review/cli-ux-review.md`
```

---

## Appendix: Full Command Surface (29 commands)

```
Top-level commands:
  init            [--project]
  add             [server|instruction|skill|agent] <name> --command/--content ...
  list            [servers|instructions|skills|agents|profiles] [--active] [--global] [--project]
  use             <profile>
  apply           [--dry-run] [--diff] [--force] [--target] [--profile]
  status
  config          {show [--resolved], validate}
  profile         {list, show <name>, create <name>, delete <name>}
  doctor
  import          <adapter|auto> [--no-encrypt]
  push
  pull            (TODO: --no-apply)
  undo
  log             [--count N]
  secret          {set, get, list, scan [--fix], install-scanner, generate-key, import-key}
  version
  adapter         {list}
  mcp-serve
  serve           [--port]
  tui
  session         {list, export <id>, search <query>}
  search          <query> [--tag] [--verified] [--limit]
  install         <pkg...> [--version] [--dry-run] [--yes]
  uninstall       <name> [--dry-run] [--yes]
  update          [--dry-run] [--yes]
  wiki            {init, search, add, show, delete, ingest, harvest, synthesize, briefing, export, import, lint, graph}
  agents          {list, add, remove, ping, delegate, cancel}
  run             <agent> <prompt> [--session] [--cwd] [--timeout]
                  run agents
                  run session {list <agent>, cancel <agent> <id>}
```

Total: 29 top-level commands, 66 subcommands/operations.
