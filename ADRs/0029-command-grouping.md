---
status: accepted
date: 2026-04-14
---

# ADR-0029: Command Grouping in Help Output

## Context

With 28 subcommands registered in `src/cli.ts`, the default `am --help` output is a
flat alphabetical list that makes it hard to discover related commands or understand
the tool's capabilities at a glance. CLI tools with many subcommands (gh, docker,
kubectl) solve this by grouping commands by category in their help output.

citty (our CLI framework) does not have built-in support for command groups, but its
`runMain` function accepts a custom `showUsage` callback that replaces the default
help renderer.

## Decision

Add a `src/help.ts` module that:

1. **Defines `COMMAND_GROUPS`** — an ordered array of `{ heading, commands }` objects
   that maps every visible subcommand into one of 7 categories:
   - Config commands (init, add, list, use, apply, status, config, profile)
   - Git commands (push, pull, undo, log)
   - Registry commands (search, install, uninstall, update)
   - Agent commands (agent, run)
   - Knowledge commands (wiki)
   - Tool commands (import, adapter, doctor, secret, session, version)
   - Interface commands (mcp-serve, tui, serve)

2. **Exports `renderGroupedHelp(version)`** — a pure function that produces the
   grouped help string. No ANSI colors or consola dependency — plain text that works
   in pipes, CI, and terminals equally.

3. **Exports `showGroupedUsage(cmd, parent?)`** — passed to `runMain` as the
   `showUsage` option. For the root command (`am --help` or bare `am`), it prints
   grouped output. For subcommands (`am init --help`), it delegates to citty's
   default `showUsage` so individual command help is unchanged.

Hidden aliases (e.g. `agents` as an alias for `agent`) are omitted from help output
but continue to route normally through citty's subCommands.

Command routing is completely unchanged — this only affects help display.

## Consequences

### Positive

- Users can discover commands by domain (config, git, registry, agents, etc.)
- The output follows a familiar pattern (gh CLI, docker)
- Adding a new command requires adding one line to `COMMAND_GROUPS` in `help.ts`
- `renderGroupedHelp` is a pure function, trivially testable
- Subcommand help (`am init --help`) is unaffected

### Negative

- Command descriptions in `COMMAND_GROUPS` are duplicated from the `meta.description`
  fields in each command module. If a command's description changes, `help.ts` must be
  updated manually. This is an acceptable trade-off for control over the root help
  layout — the descriptions are intentionally shorter/more uniform than the per-command
  meta descriptions.

### Neutral

- The test suite validates that every registered subcommand (except hidden aliases)
  appears in exactly one group, catching omissions when new commands are added

## Alternatives Considered

### 1. Monkey-patch citty's renderUsage

Rejected. Fragile across citty version upgrades and couples us to internal formatting
details (column widths, ANSI codes, markdown backticks in output).

### 2. Add a `run` handler to the main command that prints help

Rejected. citty calls `showUsage` on both `--help` and error paths (unknown command,
no command). A `run` handler would only cover the no-args case, not `--help`.

### 3. Fork citty to add native group support

Rejected. Overkill for a cosmetic change. The `showUsage` callback is the designed
extension point.

## References

- citty source: `runMain` accepts `showUsage` option (`RunMainOptions.showUsage`)
- gh CLI grouped help: `gh --help` output pattern
- Implementation: `src/help.ts`, `src/cli.ts`, `test/commands/help.test.ts`
