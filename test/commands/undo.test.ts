import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { __setUndoClackForTests, undoCommand } from "../../src/commands/undo";
import { readConfig, writeConfig } from "../../src/core/config";
import { commitAll, getStatus, log as gitLog, initRepo, revertHead } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

/** Run undoCommand.run with the given args, capturing stderr (warnings). */
async function runUndo(
  args: Partial<{
    apply: boolean;
    force: boolean;
    json: boolean;
    quiet: boolean;
    verbose: boolean;
  }> = {},
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
        force: false,
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

  // c47a: `am undo` reverts COMMITTED history (git revert) by writing every
  // parent-tree blob over the workdir. When the config repo's working tree is
  // dirty, that overwrite silently CLOBBERS uncommitted edits. The command must
  // REFUSE (fail closed) rather than warn-and-proceed: in non-interactive/JSON
  // mode it exits 1 with an actionable error and does NOT revert; in a TTY it
  // prompts (default No) and aborts on decline/cancel. `--force` bypasses.
  describe("dirty working-tree refusal (clean gate)", () => {
    const origConfigDir = process.env.AM_CONFIG_DIR;

    afterEach(() => {
      __setUndoClackForTests(null);
      if (origConfigDir === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
      else process.env.AM_CONFIG_DIR = origConfigDir;
      process.exitCode = 0;
    });

    /** init + two commits + an uncommitted edit. Returns the dirty config. */
    async function setupDirtyRepo(configDir: string): Promise<Config> {
      await initRepo(configDir);
      const config: Config = {
        servers: { fetch: { command: "uvx", transport: "stdio", enabled: true } },
      };
      await writeConfig(join(configDir, "config.toml"), config);
      await commitAll(configDir, "add server: fetch");
      config.servers!.tavily = { command: "bunx", transport: "stdio", enabled: true };
      await writeConfig(join(configDir, "config.toml"), config);
      await commitAll(configDir, "add server: tavily");
      // Dirty the working tree (uncommitted edit — `exa` is NOT in any commit).
      config.servers!.exa = { command: "exa-mcp", transport: "stdio", enabled: true };
      await writeConfig(join(configDir, "config.toml"), config);
      return config;
    }

    test("refuses (exit 1) and does NOT revert when dirty, non-TTY/no --force", async () => {
      dir = await createTestDir("am-undo-dirty-");
      const configDir = dir.path;
      process.env.AM_CONFIG_DIR = configDir;
      await setupDirtyRepo(configDir);

      const headBefore = (await gitLog(configDir, 1))[0].oid;

      const { stderr } = await runUndo();

      // Fail-closed: exit 1 with an actionable error.
      expect(process.exitCode).toBe(1);
      expect(stderr).toContain("Uncommitted");
      expect(stderr.toLowerCase()).toMatch(/--force|commit|discard/);

      // The revert did NOT run: HEAD is unchanged (no `revert:` commit) and the
      // dirty edit survives untouched (config.toml still holds `exa`).
      const entries = await gitLog(configDir, 1);
      expect(entries[0].oid).toBe(headBefore);
      expect(entries[0].message).not.toContain("revert");
      const onDisk = await readConfig(join(configDir, "config.toml"));
      expect(onDisk.servers?.exa).toBeDefined();
      expect(onDisk.servers?.tavily).toBeDefined();
    });

    test("refuses (exit 1) when dirty in --json mode", async () => {
      dir = await createTestDir("am-undo-dirty-json-");
      const configDir = dir.path;
      process.env.AM_CONFIG_DIR = configDir;
      await setupDirtyRepo(configDir);

      const headBefore = (await gitLog(configDir, 1))[0].oid;

      await runUndo({ json: true });

      expect(process.exitCode).toBe(1);
      const entries = await gitLog(configDir, 1);
      expect(entries[0].oid).toBe(headBefore);
      const onDisk = await readConfig(join(configDir, "config.toml"));
      expect(onDisk.servers?.exa).toBeDefined();
    });

    test("--force bypasses the gate and the revert proceeds, clobbering the dirty edit", async () => {
      dir = await createTestDir("am-undo-dirty-force-");
      const configDir = dir.path;
      process.env.AM_CONFIG_DIR = configDir;
      await setupDirtyRepo(configDir);

      const { stderr } = await runUndo({ force: true });

      // Old behavior preserved under --force: the revert runs.
      expect(process.exitCode).not.toBe(1);
      const entries = await gitLog(configDir, 1);
      expect(entries[0].message).toContain("revert");
      expect(entries[0].message).toContain("add server: tavily");
      // The revert restored the parent tree (fetch only); the dirty `exa` edit
      // is intentionally discarded, which is exactly what --force opts into.
      const onDisk = await readConfig(join(configDir, "config.toml"));
      expect(onDisk.servers?.fetch).toBeDefined();
      expect(onDisk.servers?.tavily).toBeUndefined();
      expect(onDisk.servers?.exa).toBeUndefined();
      // A dirty-data-loss warning is still surfaced even under --force.
      expect(stderr).toContain("Uncommitted");
    });

    test("TTY: prompt declined aborts without reverting", async () => {
      dir = await createTestDir("am-undo-dirty-tty-no-");
      const configDir = dir.path;
      process.env.AM_CONFIG_DIR = configDir;
      await setupDirtyRepo(configDir);
      const headBefore = (await gitLog(configDir, 1))[0].oid;

      // Force the interactive branch and decline.
      const origTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      __setUndoClackForTests({
        confirm: async () => false,
        isCancel: (v: unknown): v is symbol => false,
      });
      try {
        await runUndo();
      } finally {
        Object.defineProperty(process.stdin, "isTTY", { value: origTTY, configurable: true });
      }

      const entries = await gitLog(configDir, 1);
      expect(entries[0].oid).toBe(headBefore);
      const onDisk = await readConfig(join(configDir, "config.toml"));
      expect(onDisk.servers?.exa).toBeDefined();
    });

    test("TTY: prompt confirmed proceeds with the revert", async () => {
      dir = await createTestDir("am-undo-dirty-tty-yes-");
      const configDir = dir.path;
      process.env.AM_CONFIG_DIR = configDir;
      await setupDirtyRepo(configDir);

      const origTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      __setUndoClackForTests({
        confirm: async () => true,
        isCancel: (v: unknown): v is symbol => false,
      });
      try {
        await runUndo();
      } finally {
        Object.defineProperty(process.stdin, "isTTY", { value: origTTY, configurable: true });
      }

      const entries = await gitLog(configDir, 1);
      expect(entries[0].message).toContain("revert");
      const onDisk = await readConfig(join(configDir, "config.toml"));
      expect(onDisk.servers?.fetch).toBeDefined();
      expect(onDisk.servers?.tavily).toBeUndefined();
    });

    test("clean tree undoes without prompting or refusing", async () => {
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

      // Sanity: tree is clean before undo.
      expect((await getStatus(configDir)).clean).toBe(true);

      const { stderr } = await runUndo();

      // The revert happened (stale-config warning fires) but NOT the dirty one,
      // and the command did not refuse.
      expect(process.exitCode).not.toBe(1);
      expect(stderr).not.toContain("Uncommitted");
      const entries = await gitLog(configDir, 1);
      expect(entries[0].message).toContain("revert");
    });
  });
});
