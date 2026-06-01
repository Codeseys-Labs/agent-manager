/**
 * Unit tests for the UX-1 parent-command help dispatcher (src/lib/parent-help.ts).
 *
 * `resolveParentHelp` is the pure resolution layer behind cli.ts's
 * "parent command with no subcommand → print help, exit 0" behavior. These
 * tests exercise the decision logic directly (no process.exit, no citty
 * runMain) against a small command tree that mirrors the real `am` shape:
 *
 *   root (parent)
 *     ├─ wiki (parent, lazy subCommands factory)
 *     │    ├─ list (leaf, has run)
 *     │    └─ resolve (leaf, has run)
 *     └─ version (leaf, has run)
 */
import { describe, expect, test } from "bun:test";
import { type CommandDef, defineCommand } from "citty";
import { resolveParentHelp } from "../../src/lib/parent-help";

const listCmd = defineCommand({
  meta: { name: "list" },
  run() {},
});
const resolveCmd = defineCommand({
  meta: { name: "resolve" },
  run() {},
});
const wikiCmd = defineCommand({
  meta: { name: "wiki" },
  // Lazy factory map, like the real cli.ts wiki/secret/etc. parents.
  subCommands: {
    list: () => Promise.resolve(listCmd),
    resolve: () => Promise.resolve(resolveCmd),
  },
});
const versionCmd = defineCommand({
  meta: { name: "version" },
  run() {},
});
const root: CommandDef = defineCommand({
  meta: { name: "am" },
  subCommands: {
    wiki: () => Promise.resolve(wikiCmd),
    version: () => Promise.resolve(versionCmd),
  },
});

describe("resolveParentHelp (UX-1)", () => {
  test("bare root → returns root for grouped-help + exit 0", async () => {
    const r = await resolveParentHelp(root, []);
    expect(r).not.toBeNull();
    expect(r?.cmd).toBe(root);
    expect(r?.parent).toBeUndefined();
  });

  test("nested parent with no subcommand → returns that parent", async () => {
    const r = await resolveParentHelp(root, ["wiki"]);
    expect(r).not.toBeNull();
    expect(r?.cmd).toBe(wikiCmd);
    expect(r?.parent).toBe(root);
  });

  test("real subcommand → null (citty dispatches the leaf normally)", async () => {
    expect(await resolveParentHelp(root, ["wiki", "list"])).toBeNull();
  });

  test("leaf command at top level → null (has its own run)", async () => {
    expect(await resolveParentHelp(root, ["version"])).toBeNull();
  });

  test("unknown nested subcommand → null (let citty raise E_UNKNOWN_COMMAND)", async () => {
    expect(await resolveParentHelp(root, ["wiki", "bogus"])).toBeNull();
  });

  test("unknown top-level command → null (let citty raise E_UNKNOWN_COMMAND)", async () => {
    expect(await resolveParentHelp(root, ["bogus-top"])).toBeNull();
  });

  test("--help on a parent → null (citty already prints usage + exit 0)", async () => {
    expect(await resolveParentHelp(root, ["wiki", "--help"])).toBeNull();
  });

  test("-h on bare root → null (citty handles it)", async () => {
    expect(await resolveParentHelp(root, ["-h"])).toBeNull();
  });

  test("--version alone → null (citty prints the version, not grouped help)", async () => {
    expect(await resolveParentHelp(root, ["--version"])).toBeNull();
  });

  test("flags before the parent name are ignored when locating the subcommand", async () => {
    // `am --json wiki` still resolves to the wiki parent (no subcommand token).
    const r = await resolveParentHelp(root, ["--json", "wiki"]);
    expect(r?.cmd).toBe(wikiCmd);
  });

  test("flags after a parent with no subcommand still yield the parent", async () => {
    const r = await resolveParentHelp(root, ["wiki", "--json"]);
    expect(r?.cmd).toBe(wikiCmd);
  });
});
