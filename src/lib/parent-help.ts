/**
 * Parent-command help dispatch (UX-1).
 *
 * citty treats a command that has `subCommands` but no `run` handler as a
 * pure parent. When such a command is invoked with NO subcommand
 * (`am wiki`, `am secret`, `am profile`, …), citty throws
 * `CLIError("No command specified.", "E_NO_COMMAND")`, prints usage, and
 * exits with code 1. Every other modern CLI (git, gh, docker, cargo) prints
 * the command's help and exits 0 in that situation.
 *
 * Rather than fork citty, we pre-resolve the command chain for the raw args
 * and detect the "parent invoked with no subcommand" case BEFORE handing off
 * to `runMain`. When detected, the caller prints the resolved command's usage
 * and exits 0.
 *
 * The walk mirrors citty's own resolution (`runCommand` / `resolveSubCommand`,
 * neither of which is part of citty's public API): the first token that does
 * not start with `-` is the subcommand name. `--help`/`-h` are deliberately
 * left to citty — it already prints usage and exits 0 for those.
 */
import type { ArgsDef, CommandDef } from "citty";

/** Resolve a possibly-lazy citty value (`T | () => T | Promise<T>`). */
async function resolve<T>(input: T | (() => T | Promise<T>)): Promise<T> {
  return typeof input === "function" ? await (input as () => T | Promise<T>)() : input;
}

/** Resolve a command's `subCommands` map (lazy factory aware), or `undefined`. */
async function resolveSubCommands(cmd: CommandDef): Promise<Record<string, unknown> | undefined> {
  if (!cmd.subCommands) return undefined;
  return (await resolve(cmd.subCommands as unknown)) as Record<string, unknown> | undefined;
}

/**
 * A command is a "parent" when it has at least one subcommand and no `run`
 * handler of its own.
 */
async function isParentCommand(cmd: CommandDef): Promise<boolean> {
  if (typeof cmd.run === "function") return false;
  const subCommands = await resolveSubCommands(cmd);
  return !!subCommands && Object.keys(subCommands).length > 0;
}

type LeafResult =
  | { cmd: CommandDef; parent?: CommandDef; unknownSubcommand?: false }
  /** A non-flag token was supplied that matches no subcommand of `cmd`. */
  | { cmd: CommandDef; parent?: CommandDef; unknownSubcommand: true };

/**
 * Walk the command tree the way citty dispatches it: the first non-flag token
 * selects the matching subcommand; recurse with the remaining args. Stops at
 * the deepest reachable command and returns it with its parent.
 *
 * If a parent receives a non-flag token that matches no subcommand, the result
 * is flagged `unknownSubcommand` so the caller defers to citty (which raises
 * `E_UNKNOWN_COMMAND` and exits 1) rather than printing help + exit 0.
 */
async function resolveLeaf(
  cmd: CommandDef,
  rawArgs: string[],
  parent?: CommandDef,
): Promise<LeafResult> {
  const subCommands = await resolveSubCommands(cmd);
  if (subCommands && Object.keys(subCommands).length > 0) {
    const idx = rawArgs.findIndex((arg) => !arg.startsWith("-"));
    const name = idx === -1 ? undefined : rawArgs[idx];
    if (name) {
      if (!subCommands[name]) {
        return { cmd, parent, unknownSubcommand: true };
      }
      const sub = (await resolve(subCommands[name])) as CommandDef | undefined;
      if (sub) {
        return resolveLeaf(sub, rawArgs.slice(idx + 1), cmd);
      }
    }
  }
  return { cmd, parent };
}

/**
 * Decide whether the given raw args target a parent command with no
 * subcommand specified. Returns the resolved `{ cmd, parent }` pair to render
 * help for, or `null` when citty should handle the invocation normally
 * (a real subcommand was named, `--help` was passed, or the leaf has a `run`).
 *
 * The bare root invocation (`am` with no args) is intentionally returned as a
 * parent so the caller can print the grouped root help and exit 0.
 */
export async function resolveParentHelp<T extends ArgsDef = ArgsDef>(
  root: CommandDef<T>,
  rawArgs: string[],
): Promise<{ cmd: CommandDef; parent?: CommandDef } | null> {
  // citty itself handles --help / -h with a clean exit-0 usage dump, and
  // `--version` (alone) by printing the meta version. Defer both so we don't
  // shadow them with grouped help.
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) return null;
  if (rawArgs.length === 1 && rawArgs[0] === "--version") return null;

  // citty's CommandDef is invariant over its ArgsDef generic; the internal
  // walk only reads structural fields (subCommands/run), so widen to the base.
  const leaf = await resolveLeaf(root as unknown as CommandDef, rawArgs);
  // An unrecognized subcommand token (`am wiki bogus`) must surface citty's
  // E_UNKNOWN_COMMAND error + exit 1, not silently print help.
  if (leaf.unknownSubcommand) return null;
  return (await isParentCommand(leaf.cmd)) ? { cmd: leaf.cmd, parent: leaf.parent } : null;
}
