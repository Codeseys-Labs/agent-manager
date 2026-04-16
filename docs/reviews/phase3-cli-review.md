# Phase 3 CLI Review — `am add` and `am list` Entity Dispatch

**Reviewer:** CLI review agent  
**Date:** 2026-04-14  
**Scope:** `src/commands/add.ts` and `src/commands/list.ts` only  
**Against:** Original `cli-ux-review.md` findings (C1, C2, C3), citty conventions, CLAUDE.md output helpers  

---

## Executive Summary

Both commands correctly address the critical issues C1/C2/C3 from the original review.
`am add server|instruction|skill|agent <name>` and `am list servers|instructions|skills|agents|profiles`
now work as designed. Backwards compatibility with bare `am add <name>` is preserved.

There are **2 medium** issues (behaviour gaps that will cause user confusion),
**3 low** issues (polish), and **1 test coverage gap** that should be filled before
merging.

---

## Backwards Compatibility

### `am add <name> --command <cmd>` still works

`parseEntityAndName` checks whether the first positional is a known entity keyword
(`server`, `instruction`, `skill`, `agent`). If not, it falls through as `entity="server"`,
`name=rawArgs[0]`. This means:

```bash
am add tavily --command "bunx tavily-mcp@latest"   # still works — entity=server
am add server tavily --command "bunx tavily-mcp@latest"  # new form — entity=server
```

The backwards compat path is correct and well-commented. No regressions on the
happy path.

**One edge case (medium severity — see M1 below):** a server named exactly `"server"`,
`"instruction"`, `"skill"`, or `"agent"` is silently rejected via the new dispatch path
rather than treated as a server name.

---

## Findings

### MEDIUM

#### M1. Server name collision with entity keywords

**Severity:** MEDIUM  
**File:** `src/commands/add.ts:18-26`

`parseEntityAndName` calls `.toLowerCase()` before checking against `ENTITY_TYPES`.
If a user's server is named `"server"`, `"agent"`, `"skill"`, or `"instruction"` (unlikely
but valid TOML keys), the dispatch logic consumes the keyword as an entity type and uses
`rawArgs[1]` as the name — which may be `undefined` or a flag value like `--command`.

```bash
am add server --command "echo hi"
# parseEntityAndName sees first=server (entity keyword) → entity=server, name=undefined
# Falls through to: error(`Missing name. Usage: am add server <name>`)
# The user wanted to add a server NAMED "server" — gets a confusing error instead
```

This is an inherent tension in the "keyword or name" pattern. The original chezmoi
review noted that citty doesn't support true subcommand dispatch for positionals, so
the workaround is reasonable — but the collision case needs documentation or a guard.

**Recommendation:** Add a note to help text: "Entity-type keywords (server, instruction,
skill, agent) cannot be used as server names." Or detect the collision and emit a
specific error: `"\"server\" is a reserved keyword. Use a different name."`.

---

#### M2. `am list` silently defaults on unknown entity type

**Severity:** MEDIUM  
**File:** `src/commands/list.ts:9-26`

`parseEntityType` maps unknown/unrecognized strings to `"servers"` via the fallback
`?? "servers"` on the lookup:

```typescript
return singular[normalized] ?? "servers";
```

This means `am list foobar` silently lists servers instead of printing an error. The user
gets server output with no indication their entity type was invalid.

The same issue does not exist in `add.ts` — `parseEntityAndName` only performs forward
resolution for known types and falls back correctly for unknown first args (treats them
as server names). `list.ts` is different: there's an explicit `entity` positional arg,
so an invalid value should be an error.

**Recommendation:**

```typescript
function parseEntityType(raw: string | undefined): EntityType {
  if (!raw) return "servers";
  const normalized = raw.toLowerCase();
  const singular: Record<string, EntityType> = { /* ... */ };
  if (!(normalized in singular)) {
    // caller should handle error — return null or throw
    return null as unknown as EntityType;  // or restructure to return Result type
  }
  return singular[normalized];
}
```

Then in the `run` handler:

```typescript
const entityType = parseEntityType(args.entity as string | undefined);
if (entityType === null) {
  error(`Unknown entity type "${args.entity}". Valid types: servers, instructions, skills, agents, profiles`, opts);
  process.exitCode = 1;
  return;
}
```

---

### LOW

#### L1. `am add skill` and `am add agent` output a stub message, but `--json` shape is inconsistent with other entity types

**Severity:** LOW  
**File:** `src/commands/add.ts:271-280`

`addStub()` returns `{ action, entity, name, status: "not_implemented" }`. Every other
entity type returns `{ action, entity, name, config: <entity object> }`. A script
calling `am add skill foo --json` gets a different shape and must special-case
`status === "not_implemented"`.

This is acceptable while the feature is unimplemented, but the discrepancy should be
tracked. If `addStub` is expected to be replaced soon, this is fine. If it will persist,
document the shape difference in the help text or return a `null` config field for
consistency: `{ action, entity, name, config: null, status: "not_implemented" }`.

---

#### L2. `listServers` empty-state hint uses old syntax

**Severity:** LOW  
**File:** `src/commands/list.ts:98`

When no servers are configured, the hint message says:

```
No servers configured. Run `am add <name> --command <cmd>` to add one.
```

This uses the old bare syntax. Now that `am add server <name>` is the canonical form,
the hint should be updated:

```
No servers configured. Run `am add server <name> --command <cmd>` to add one.
```

This is cosmetic but affects first-run UX for new users.

---

#### L3. `--active`, `--global`, `--project` flags only filter servers — no-op for other entity types

**Severity:** LOW  
**File:** `src/commands/list.ts:40-44`, `src/commands/list.ts:51`

The `--active`, `--global`, and `--project` flags are declared at the command level but
only `--global` is used in the `run()` handler (to set `projectFile`). The filtering
only meaningfully affects servers because `loadResolvedConfig` handles the project/global
split. For `am list instructions --project` or `am list agents --global`, the flag is
accepted silently but has undefined behavior depending on how `loadResolvedConfig` merges
config layers.

This is a minor UX inconsistency — the flags appear in `--help` output for `am list agents`
but only make sense for servers. No immediate fix needed, but worth noting for when
instructions and agents gain project-scope support.

---

## Convention Compliance

| Check | `add.ts` | `list.ts` | Notes |
|-------|:--------:|:---------:|-------|
| Uses `output()` / `info()` / `error()` from `src/lib/output.ts` | Y | Y | Correct |
| `--json`, `--quiet`, `--verbose` present | Y | Y | All three present |
| `process.exitCode = 1` on error (not `process.exit`) | Y | Y | Correct — allows async cleanup |
| citty `defineCommand` export | Y | Y | Named exports match `src/cli.ts` conventions |
| No direct `console.log` outside output helpers | Y | Y | Clean |
| Error messages include actionable hint | Y | Partial | `list.ts` errors are bare (see M2) |

---

## `--json` Output Shape Audit

All entity types produce a top-level key matching the entity type name (plural for list,
singular label for add):

| Command | `--json` shape | Consistent? |
|---------|---------------|:-----------:|
| `am list servers --json` | `{ servers: [...] }` | Y |
| `am list instructions --json` | `{ instructions: [...] }` | Y |
| `am list skills --json` | `{ skills: [...] }` | Y |
| `am list agents --json` | `{ agents: [...] }` | Y |
| `am list profiles --json` | `{ profiles: [...] }` | Y |
| `am add server foo --json` | `{ action, entity, name, config, secretsEncrypted? }` | Y |
| `am add instruction foo --json` | `{ action, entity, name, config }` | Y |
| `am add skill foo --json` | `{ action, entity, name, status: "not_implemented" }` | Partial (see L1) |
| `am add agent foo --json` | `{ action, entity, name, status: "not_implemented" }` | Partial (see L1) |

The `--json` shape for `list` is consistent across all five entity types. The `add`
shape is consistent for implemented types. The stub shape (L1) is the only gap.

---

## Help Text

`add.ts` meta description: `"Add an entity to the config (server, instruction, skill, agent)"` — accurate.  
`list.ts` meta description: `"List entities in the config (servers, instructions, skills, agents, profiles)"` — accurate.

The positional arg descriptions adequately enumerate the valid entity types.

One gap: `add.ts` declares a single `_args` positional (citty catch-all), while `list.ts`
declares a named `entity` positional. This means `am add --help` will show:

```
_args    Entity type and name: `am add [server|instruction|skill|agent] <name>`
```

The underscore-prefixed name leaks into help output on some citty versions. This is a
citty convention limitation rather than a bug — the multi-positional case requires the
catch-all approach. `list.ts` is cleaner because it only needs one positional.

---

## Test Coverage Gaps

There are no tests in `test/commands/` — the directory does not exist. The closest
coverage is in `test/integration/lifecycle.test.ts`. Given the new dispatch logic in
both commands, the following cases should have unit tests:

| Case | Priority |
|------|---------|
| `am add server <name>` dispatches to `addServer` | High |
| `am add <name>` (bare) still dispatches to `addServer` | High — backwards compat regression risk |
| `am add instruction <name>` dispatches to `addInstruction` | High |
| `am add skill <name>` returns stub JSON shape | Medium |
| `am add agent <name>` returns stub JSON shape | Medium |
| `am list servers` returns servers list | High |
| `am list instructions` returns instructions list | High |
| `am list foobar` should error (not silently list servers) | High — if M2 is fixed |
| `am list skills` with empty skills returns empty info | Medium |
| `am list profiles` returns profiles list | Medium |
| `am add server` (keyword as server name) shows clear error | Medium — M1 case |

The integration lifecycle test likely covers the server-add happy path. The new entity
types and the backwards-compat path have no dedicated coverage.

---

## Summary

| ID | Severity | Issue | File | Action |
|----|---------|-------|------|--------|
| M1 | MEDIUM | Server name collides silently with entity keywords | `add.ts:18-26` | Document or guard |
| M2 | MEDIUM | Invalid entity type silently defaults to `servers` | `list.ts:9-26` | Return error on unknown type |
| L1 | LOW | Stub `--json` shape differs from implemented entity types | `add.ts:271-280` | Track; add `config: null` for consistency |
| L2 | LOW | Empty-state hint uses old `am add <name>` syntax | `list.ts:98` | Update to `am add server <name>` |
| L3 | LOW | `--active/--global/--project` flags silently no-op for non-server entities | `list.ts:40-44` | Note in help text or scope flags to servers |
| T1 | — | No `test/commands/` directory; dispatch logic untested | — | Add unit tests for both commands |
