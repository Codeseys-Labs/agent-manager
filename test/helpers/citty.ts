type Resolvable<T> = T | Promise<T> | (() => T | Promise<T>);

type CommandLike = {
  meta?: Resolvable<unknown>;
  subCommands?: Resolvable<unknown>;
  args?: Resolvable<unknown>;
  run?: (ctx: { args: Record<string, unknown> }) => unknown | Promise<unknown>;
};

async function resolveValue<T>(value: Resolvable<T> | undefined): Promise<T | undefined> {
  if (typeof value === "function") {
    return await (value as () => T | Promise<T>)();
  }
  return await value;
}

/**
 * Resolve citty's Resolvable<CommandMeta> wrapper.
 *
 * citty 3.x types `CommandDef.meta` as `Resolvable<CommandMeta>` (a union of
 * T | Promise<T> | (() => T) | (() => Promise<T>)). At runtime citty resolves
 * eagerly so `.meta.name` works, but TypeScript rejects the property access.
 * Use this helper to resolve the type at the test boundary.
 */
// NB: Promise<any> is intentional. callers use property access on the
// result (e.g. `meta.name`, `subCommands.add`); switching to
// Promise<unknown> requires type narrowing at every call site (~12
// places) which would regress the typecheck-error reduction this helper
// is designed to deliver. Reviewer (claude-opus-4.7) flagged the `any`
// as a nit; the tradeoff is documented here. Revisit when migrating
// the helper to a typed wrapper API.
export async function resolveMeta(cmd: unknown): Promise<any> {
  return (await resolveValue((cmd as CommandLike).meta))!;
}

/** Resolve citty's Resolvable<SubCommandsDef> wrapper. */
// biome-ignore lint/suspicious/noExplicitAny: see resolveMeta above.
export async function resolveSubCommands(cmd: unknown): Promise<any> {
  return (await resolveValue((cmd as CommandLike).subCommands))!;
}

/** Resolve citty's Resolvable<ArgsDef> wrapper. */
// biome-ignore lint/suspicious/noExplicitAny: see resolveMeta above.
export async function resolveArgs(cmd: unknown): Promise<any> {
  return (await resolveValue((cmd as CommandLike).args))!;
}

/** Invoke citty's command run entrypoint with args. */
export async function resolveRun(cmd: unknown, args: Record<string, unknown>) {
  return await (cmd as CommandLike).run?.({ args });
}
