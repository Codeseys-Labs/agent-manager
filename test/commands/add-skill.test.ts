import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
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

async function setupConfigDir(prefix = "am-add-skill-"): Promise<{
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

async function makeSkillDir(base: string, name: string, skillMdBody?: string): Promise<string> {
  const path = join(base, name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    skillMdBody ??
      `---\nname: ${name}\ndescription: Example skill ${name} for testing\n---\n\n# ${name}\n\nBody.\n`,
  );
  return path;
}

describe("am add skill", () => {
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

  test("happy path — adds skill entry with --path, auto-commits", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-skill-ws-");
    const skillPath = await makeSkillDir(workspace.path, "example-skill");

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["skill", "example-skill"],
        path: skillPath,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.skills?.["example-skill"]).toBeDefined();
    expect(updated.skills?.["example-skill"].path).toBe(skillPath);
    // Description was pulled from SKILL.md frontmatter
    expect(updated.skills?.["example-skill"].description).toBe(
      "Example skill example-skill for testing",
    );

    // Next-step hint is printed
    expect(consoleOutput.some((l) => l.includes("am apply"))).toBe(true);
  });

  test("writes config atomically (no leftover tmp files in config dir)", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-skill-ws-");
    const skillPath = await makeSkillDir(workspace.path, "atomic-skill");

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["skill", "atomic-skill"],
        path: skillPath,
        json: false,
        quiet: true,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(configDir);
    const tmpFiles = entries.filter((e) => e.includes(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  test("auto-commits the change", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-skill-ws-");
    const skillPath = await makeSkillDir(workspace.path, "commit-skill");

    const { log } = await import("../../src/core/git");
    const before = await log(configDir);

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["skill", "commit-skill"],
        path: skillPath,
        json: false,
        quiet: true,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const after = await log(configDir);
    expect(after.length).toBe(before.length + 1);
    expect(after[0].message).toBe("add skill: commit-skill");
  });

  test("conflict — duplicate skill name fails", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-skill-ws-");
    const skillPath = await makeSkillDir(workspace.path, "dup-skill");

    // Reset the global exitCode before the test; other tests may have
    // left it set to 1, and we're asserting this run does NOT set it.
    process.exitCode = 0;

    const { addCommand } = await import("../../src/commands/add");
    // First add succeeds
    await addCommand.run!({
      args: {
        _: ["skill", "dup-skill"],
        path: skillPath,
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

    // Second add fails
    await addCommand.run!({
      args: {
        _: ["skill", "dup-skill"],
        path: skillPath,
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

  test("invalid input — missing --path and --source fails", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["skill", "no-source"],
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /--path or --source/.test(l))).toBe(true);
    process.exitCode = 0;
  });

  test("invalid input — --path points to non-existent dir fails", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["skill", "bad-path"],
        path: "/tmp/definitely/does/not/exist-am-test-xyz",
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /does not exist/.test(l))).toBe(true);
    process.exitCode = 0;
  });

  test("invalid input — path without SKILL.md fails", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-skill-ws-");
    // Create a dir without SKILL.md
    const skillPath = join(workspace.path, "no-skill-md");
    await mkdir(skillPath, { recursive: true });

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["skill", "no-skill-md"],
        path: skillPath,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /SKILL\.md/.test(l))).toBe(true);
    process.exitCode = 0;
  });

  test("--source local:<path> resolves to a local skill", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-skill-ws-");
    const skillPath = await makeSkillDir(workspace.path, "local-source-skill");

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["skill", "local-source-skill"],
        source: `local:${skillPath}`,
        json: false,
        quiet: true,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.skills?.["local-source-skill"]).toBeDefined();
    expect(updated.skills?.["local-source-skill"].path).toBe(skillPath);
  });

  test("--source git+... is rejected with a clear message (not yet supported)", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["skill", "git-skill"],
        source: "git+https://github.com/example/skill.git",
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /not yet supported/.test(l))).toBe(true);
    process.exitCode = 0;
  });

  test("--source help text does not advertise git+/marketplace as working", async () => {
    // Docs-truth: only local:<path> is implemented (parseSkillSource rejects
    // git+/marketplace). The flag description must not present unimplemented
    // sources as supported. (ws2-e5c8-docs-truth)
    const { addCommand } = await import("../../src/commands/add");
    const sourceArg = (addCommand.args as Record<string, { description?: string }>).source;
    expect(sourceArg.description).toContain("local:<path>");
    expect(sourceArg.description).not.toMatch(/git\+<url>|marketplace-ref/);
    // The description should make the unsupported status explicit.
    expect(sourceArg.description).toMatch(/not yet supported/);
  });

  test("portability — warns on a host-absolute path in the SKILL.md body", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-skill-ws-");
    // SKILL.md body hard-codes the author's home dir (R1/297e).
    const skillPath = await makeSkillDir(
      workspace.path,
      "host-path-skill",
      "---\nname: host-path-skill\ndescription: A skill\n---\n\n# host-path-skill\n\nRun /home/baladita/.local/share/uv/tools/hyperresearch/bin/hr\n",
    );

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["skill", "host-path-skill"],
        path: skillPath,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    // The portability finding is surfaced as a warning on stderr and is NOT
    // silenced; the skill is still added (lint signal, not a hard gate).
    expect(consoleErrors.some((l) => /host-absolute path/.test(l))).toBe(true);
    expect(consoleErrors.some((l) => l.includes("/home/baladita/"))).toBe(true);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.skills?.["host-path-skill"]).toBeDefined();
  });

  test("portability — JSON mode includes the finding in the envelope", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-skill-ws-");
    const skillPath = await makeSkillDir(
      workspace.path,
      "host-path-json-skill",
      "---\nname: host-path-json-skill\ndescription: A skill\n---\n\n# x\n\nsee /Users/baladita/.config/foo\n",
    );

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["skill", "host-path-json-skill"],
        path: skillPath,
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
    expect(parsed.portability).toBeDefined();
    expect(parsed.portability).toHaveLength(1);
    expect(parsed.portability[0].kind).toBe("macos");
    expect(parsed.portability[0].match).toBe("/Users/baladita/");
  });

  test("portability — clean SKILL.md emits no portability warning or envelope field", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-skill-ws-");
    const skillPath = await makeSkillDir(
      workspace.path,
      "clean-skill",
      "---\nname: clean-skill\ndescription: A skill\n---\n\n# x\n\nRun ./scripts/run.sh\n",
    );

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["skill", "clean-skill"],
        path: skillPath,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    expect(consoleErrors.some((l) => /host-absolute path/.test(l))).toBe(false);
    const jsonLine = consoleOutput.find((l) => l.includes('"action"'));
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.portability).toBeUndefined();
  });

  test("JSON mode emits the action envelope on stdout", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-skill-ws-");
    const skillPath = await makeSkillDir(workspace.path, "json-skill");

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["skill", "json-skill"],
        path: skillPath,
        description: "Custom description override",
        tags: "alpha,beta",
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
    expect(parsed.entity).toBe("skill");
    expect(parsed.name).toBe("json-skill");
    expect(parsed.config.path).toBe(skillPath);
    expect(parsed.config.description).toBe("Custom description override");
    expect(parsed.config.tags).toEqual(["alpha", "beta"]);
  });
});
