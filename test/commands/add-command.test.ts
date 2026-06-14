import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../src/core/config";
import { commitAll, initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

// Capture console output
let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const origLog = console.log;
const origError = console.error;

function resetConsole() {
  consoleOutput = [];
  consoleErrors = [];
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
}

function restoreConsole() {
  console.log = origLog;
  console.error = origError;
}

async function setupConfigDir(prefix = "am-add-command-"): Promise<{
  dir: TestDir;
  configDir: string;
}> {
  const dir = await createTestDir(prefix);
  const configDir = dir.path;
  process.env.AM_CONFIG_DIR = configDir;
  await initRepo(configDir);
  const config: Config = { settings: { default_profile: "default" }, servers: {} };
  await writeConfig(join(configDir, "config.toml"), config);
  await commitAll(configDir, "init config");
  return { dir, configDir };
}

async function makeCommandMd(base: string, name: string, body: string): Promise<string> {
  const path = join(base, `${name}.md`);
  await writeFile(path, body);
  return path;
}

describe("am add command", () => {
  let dir: TestDir;
  let configDir: string;
  let workspace: TestDir;

  beforeEach(async () => {
    resetConsole();
  });

  afterEach(async () => {
    restoreConsole();
    if (dir) await dir.cleanup();
    if (workspace) await workspace.cleanup();
    Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
  });

  test("happy path — adds command entry with --path, type === 'command', auto-commits", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { log } = await import("../../src/core/git");
    const before = await log(configDir);

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["command", "deploy"],
        path: "./commands/deploy.md",
        json: false,
        quiet: true,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.commands?.deploy).toBeDefined();
    expect(updated.commands?.deploy.type).toBe("command");
    expect(updated.commands?.deploy.path).toBe("./commands/deploy.md");

    const after = await log(configDir);
    expect(after.length).toBe(before.length + 1);
    expect(after[0].message).toBe("add command: deploy");
  });

  test("round-trips — re-read config still has the command", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["command", "rt"],
        path: "./commands/rt.md",
        description: "Round trip",
        json: false,
        quiet: true,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const first = await readConfig(join(configDir, "config.toml"));
    expect(first.commands?.rt).toBeDefined();
    // Write it back out and re-read — the commands record must survive.
    await writeConfig(join(configDir, "config.toml"), first);
    const second = await readConfig(join(configDir, "config.toml"));
    expect(second.commands?.rt.type).toBe("command");
    expect(second.commands?.rt.path).toBe("./commands/rt.md");
    expect(second.commands?.rt.description).toBe("Round trip");
  });

  test("conflict — duplicate command name fails", async () => {
    ({ dir, configDir } = await setupConfigDir());
    process.exitCode = 0;

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["command", "dup"],
        path: "./commands/dup.md",
        json: false,
        quiet: true,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });
    expect(process.exitCode).not.toBe(1);

    resetConsole();
    process.exitCode = 0;

    await addCommand.run!({
      args: {
        _: ["command", "dup"],
        path: "./commands/dup.md",
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => l.includes("already exists"))).toBe(true);
    process.exitCode = 0;
  });

  test("invalid input — missing --path and --from fails", async () => {
    ({ dir, configDir } = await setupConfigDir());
    process.exitCode = 0;

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["command", "no-source"],
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /--path or --from/.test(l))).toBe(true);
    process.exitCode = 0;
  });

  test("--from file WITH `kind: command` frontmatter classifies and derives description", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-command-ws-");
    const mdPath = await makeCommandMd(
      workspace.path,
      "review",
      "---\nkind: command\ndescription: Review the open PR\n---\n\n# review\n\nBody.\n",
    );

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["command", "review"],
        from: mdPath,
        json: false,
        quiet: true,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.commands?.review).toBeDefined();
    expect(updated.commands?.review.type).toBe("command");
    expect(updated.commands?.review.path).toBe(mdPath);
    expect(updated.commands?.review.description).toBe("Review the open PR");
  });

  test("--from file MISSING `kind:` is REFUSED (not guessed)", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-command-ws-");
    const mdPath = await makeCommandMd(
      workspace.path,
      "ambiguous",
      "---\ndescription: No kind declared\n---\n\n# ambiguous\n\nBody.\n",
    );
    process.exitCode = 0;

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["command", "ambiguous"],
        from: mdPath,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /kind/.test(l))).toBe(true);
    // Nothing was written.
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.commands?.ambiguous).toBeUndefined();
    process.exitCode = 0;
  });

  test("--from file with WRONG `kind:` is REFUSED (not guessed)", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-command-ws-");
    const mdPath = await makeCommandMd(
      workspace.path,
      "wrong-kind",
      "---\nkind: skill\ndescription: This is actually a skill\n---\n\n# wrong-kind\n\nBody.\n",
    );
    process.exitCode = 0;

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["command", "wrong-kind"],
        from: mdPath,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /kind/.test(l))).toBe(true);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.commands?.["wrong-kind"]).toBeUndefined();
    process.exitCode = 0;
  });

  test("JSON mode emits the action envelope on stdout", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["command", "json-cmd"],
        path: "./commands/json-cmd.md",
        description: "A command",
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const jsonLine = consoleOutput.find((l) => l.includes('"action"'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.action).toBe("add");
    expect(parsed.entity).toBe("command");
    expect(parsed.name).toBe("json-cmd");
    expect(parsed.config.type).toBe("command");
    expect(parsed.config.path).toBe("./commands/json-cmd.md");
    expect(parsed.config.description).toBe("A command");
  });
});
