import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { marketplaceCommand } from "../../src/commands/marketplace";

describe("marketplace command", () => {
  // ── Command registration ───────────────────────────────────────

  test("marketplace command has correct meta", () => {
    const meta = marketplaceCommand.meta;
    expect(meta?.name).toBe("marketplace");
    expect(meta?.description).toContain("marketplace");
  });

  test("marketplace command has all subcommands", () => {
    const subCmds = marketplaceCommand.subCommands;
    expect(subCmds).toBeDefined();
    expect(subCmds!.add).toBeDefined();
    expect(subCmds!.list).toBeDefined();
    expect(subCmds!.install).toBeDefined();
    expect(subCmds!.update).toBeDefined();
    expect(subCmds!.remove).toBeDefined();
    expect(subCmds!.search).toBeDefined();
    expect(subCmds!.uninstall).toBeDefined();
  });

  test("add subcommand requires url positional", () => {
    const addCmd = marketplaceCommand.subCommands!.add as any;
    expect(addCmd.args?.url?.type).toBe("positional");
    expect(addCmd.args?.url?.required).toBe(true);
  });

  test("install subcommand requires plugin positional", () => {
    const installCmd = marketplaceCommand.subCommands!.install as any;
    expect(installCmd.args?.plugin?.type).toBe("positional");
    expect(installCmd.args?.plugin?.required).toBe(true);
  });

  test("search subcommand requires query positional", () => {
    const searchCmd = marketplaceCommand.subCommands!.search as any;
    expect(searchCmd.args?.query?.type).toBe("positional");
    expect(searchCmd.args?.query?.required).toBe(true);
  });

  test("remove subcommand requires name positional", () => {
    const removeCmd = marketplaceCommand.subCommands!.remove as any;
    expect(removeCmd.args?.name?.type).toBe("positional");
    expect(removeCmd.args?.name?.required).toBe(true);
  });

  test("all subcommands support --json flag", () => {
    const subCmds = marketplaceCommand.subCommands!;
    for (const [name, cmd] of Object.entries(subCmds)) {
      const resolved = cmd as any;
      expect(resolved.args?.json?.type).toBe("boolean");
    }
  });
});
