/**
 * Smoke test: `am pair` router registration (Wave T sub-task T3).
 *
 * Verifies that `pairCommand` is correctly wired as a multi-verb parent
 * with `accept` and `finalize` subcommands resolving to the commands
 * shipped in T1/T2.
 */

import { describe, expect, test } from "bun:test";
import { resolveMeta, resolveSubCommands } from "../helpers/citty";

describe("am pair: router registration", () => {
  test("pairCommand exports with meta", async () => {
    const mod = await import("../../src/commands/pair");
    expect(mod.pairCommand).toBeDefined();
    const meta = await resolveMeta(mod.pairCommand);
    expect(meta).toBeDefined();
    expect(meta.name).toBe("pair");
    expect(meta.description).toContain("ADR-0047");
  });

  test("pairCommand has accept and finalize subcommands", async () => {
    const mod = await import("../../src/commands/pair");
    const subs = await resolveSubCommands(mod.pairCommand);
    expect(subs).toBeDefined();
    expect(subs.accept).toBeDefined();
    expect(subs.finalize).toBeDefined();
  });

  test("accept subcommand resolves to pairAcceptCommand", async () => {
    const mod = await import("../../src/commands/pair");
    const subs = await resolveSubCommands(mod.pairCommand);
    const resolved = await (subs.accept as () => Promise<any>)();
    const acceptMeta = await resolveMeta(resolved);
    expect(acceptMeta.name).toBe("accept");
    expect(acceptMeta.description).toContain("ADR-0047");
    expect(resolved.args).toBeDefined();
    expect(resolved.args.name).toBeDefined();
    expect(resolved.args.name.type).toBe("positional");
    expect(resolved.args.name.required).toBe(true);
  });

  test("finalize subcommand resolves to pairFinalizeCommand", async () => {
    const mod = await import("../../src/commands/pair");
    const subs = await resolveSubCommands(mod.pairCommand);
    const resolved = await (subs.finalize as () => Promise<any>)();
    const finalizeMeta = await resolveMeta(resolved);
    expect(finalizeMeta.name).toBe("finalize");
    expect(finalizeMeta.description).toContain("ADR-0047");
    expect(resolved.args).toBeDefined();
    expect(resolved.args.name).toBeDefined();
    expect(resolved.args.name.type).toBe("positional");
    expect(resolved.args.name.required).toBe(true);
  });
});
