import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { undoCommand } from "../../src/commands/undo";
import { readConfig, writeConfig } from "../../src/core/config";
import { commitAll, log as gitLog, initRepo, revertHead } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

/** Run undoCommand.run with the given args, capturing stderr (warnings). */
async function runUndo(
  args: Partial<{ apply: boolean; json: boolean; quiet: boolean; verbose: boolean }> = {},
): Promise<{ stderr: string; stdout: string }> {
  const stderrLines: string[] = [];
  const stdoutLines: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a: unknown[]) => {
    stderrLines.push(a.map(String).join(" "));
  };
  console.log = (...a: unknown[]) => {
    stdoutLines.push(a.map(String).join(" "));
  };
  try {
    await undoCommand.run?.({
      args: {
        apply: false,
        json: false,
        quiet: false,
        verbose: false,
        ...args,
        _: [] as string[],
      },
      rawArgs: [],
      cmd: undoCommand,
    } as unknown as Parameters<NonNullable<typeof undoCommand.run>>[0]);
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
  return { stderr: stderrLines.join("\n"), stdout: stdoutLines.join("\n") };
}

describe("am undo", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("undo creates a revert commit", async () => {
    dir = await createTestDir("am-undo-");
    const configDir = dir.path;
    await initRepo(configDir);

    // Add a server
    const config: Config = {
      servers: { fetch: { command: "uvx", transport: "stdio", enabled: true } },
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "add server: fetch");

    // Add another server
    config.servers!.tavily = { command: "bunx", transport: "stdio", enabled: true };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "add server: tavily");

    // Undo
    await revertHead(configDir);

    // Should have revert commit
    const entries = await gitLog(configDir, 1);
    expect(entries[0].message).toContain("revert");
    expect(entries[0].message).toContain("add server: tavily");

    // Config should be back to only fetch
    const reverted = await readConfig(join(configDir, "config.toml"));
    expect(reverted.servers?.fetch).toBeDefined();
    expect(reverted.servers?.tavily).toBeUndefined();
  });

  test("undo fails with only init commit", async () => {
    dir = await createTestDir("am-undo-");
    const configDir = dir.path;
    await initRepo(configDir);

    await expect(revertHead(configDir)).rejects.toThrow();
  });

  // ws4-6fd2: `am undo` reverts COMMITTED history (git revert). When the config
  // repo's working tree is dirty, the command must WARN that uncommitted edits
  // exist and are outside the revert's scope — before attempting the revert.
  describe("dirty working-tree warning", () => {
    const origConfigDir = process.env.AM_CONFIG_DIR;

    afterEach(() => {
      if (origConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
      else process.env.AM_CONFIG_DIR = origConfigDir;
    });

    test("warns about uncommitted edits when the tree is dirty", async () => {
      dir = await createTestDir("am-undo-dirty-");
      const configDir = dir.path;
      process.env.AM_CONFIG_DIR = configDir;
      await initRepo(configDir);

      // Two commits so there is something to undo.
      const config: Config = {
        servers: { fetch: { command: "uvx", transport: "stdio", enabled: true } },
      };
      await writeConfig(join(configDir, "config.toml"), config);
      await commitAll(configDir, "add server: fetch");
      config.servers!.tavily = { command: "bunx", transport: "stdio", enabled: true };
      await writeConfig(join(configDir, "config.toml"), config);
      await commitAll(configDir, "add server: tavily");

      // Dirty the working tree (uncommitted edit).
      config.servers!.exa = { command: "exa-mcp", transport: "stdio", enabled: true };
      await writeConfig(join(configDir, "config.toml"), config);

      const { stderr } = await runUndo();

      expect(stderr).toContain("Uncommitted edits");
      expect(stderr).toContain("config.toml");
      // The warning must scope the revert to committed history.
      expect(stderr).toContain("COMMITTED history only");
    });

    test("no dirty warning when the working tree is clean", async () => {
      dir = await createTestDir("am-undo-clean-");
      const configDir = dir.path;
      process.env.AM_CONFIG_DIR = configDir;
      await initRepo(configDir);

      const config: Config = {
        servers: { fetch: { command: "uvx", transport: "stdio", enabled: true } },
      };
      await writeConfig(join(configDir, "config.toml"), config);
      await commitAll(configDir, "add server: fetch");
      config.servers!.tavily = { command: "bunx", transport: "stdio", enabled: true };
      await writeConfig(join(configDir, "config.toml"), config);
      await commitAll(configDir, "add server: tavily");

      const { stderr } = await runUndo();

      // The revert happened (stale-config warning fires) but NOT the dirty one.
      expect(stderr).not.toContain("Uncommitted edits");
    });
  });
});
