import type { CommandDef } from "citty";

/**
 * Resolve citty's Resolvable<CommandMeta> wrapper.
 *
 * citty 3.x types `CommandDef.meta` as `Resolvable<CommandMeta>` (a union of
 * T | Promise<T> | (() => T) | (() => Promise<T>)). At runtime citty resolves
 * eagerly so `.meta.name` works, but TypeScript rejects the property access.
 * Use this helper to resolve the type at the test boundary.
 */
export async function resolveMeta<T extends CommandDef>(cmd: T) {
  const meta = await (typeof cmd.meta === "function" ? cmd.meta() : cmd.meta);
  return meta!;
}

/** Resolve citty's Resolvable<SubCommandsDef> wrapper. */
export async function resolveSubCommands<T extends CommandDef>(cmd: T) {
  const sub = await (typeof cmd.subCommands === "function" ? cmd.subCommands() : cmd.subCommands);
  return sub!;
}

/** Resolve citty's Resolvable<ArgsDef> wrapper. */
export async function resolveArgs<T extends CommandDef>(cmd: T) {
  const args = await (typeof cmd.args === "function" ? cmd.args() : cmd.args);
  return args!;
}
