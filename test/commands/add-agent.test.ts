import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../src/core/config";
import { commitAll, initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

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

async function setupConfigDir(prefix = "am-add-agent-"): Promise<{
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

async function makePromptFile(base: string, name: string, body?: string): Promise<string> {
  const path = join(base, `${name}.md`);
  await writeFile(path, body ?? `# ${name}\n\nYou are ${name}. Be helpful.\n`);
  return path;
}

describe("am add agent", () => {
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

  test("happy path — prompt-file only", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-agent-ws-");
    const promptPath = await makePromptFile(workspace.path, "reviewer");

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["agent", "reviewer"],
        "prompt-file": promptPath,
        description: "Reviews code changes.",
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.agents?.reviewer).toBeDefined();
    expect(updated.agents?.reviewer.name).toBe("reviewer");
    expect(updated.agents?.reviewer.description).toBe("Reviews code changes.");
    expect(updated.agents?.reviewer.prompt_file).toBe(promptPath);
    expect(updated.agents?.reviewer.acp).toBeUndefined();
    expect(updated.agents?.reviewer.a2a).toBeUndefined();

    // Next-step hint printed
    expect(consoleOutput.some((l) => l.includes("am apply"))).toBe(true);
  });

  test("happy path — ACP-backed (local runtime)", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["agent", "claude"],
        acp: "npx -y @agentclientprotocol/claude-agent-acp@latest",
        description: "Claude via ACP",
        json: false,
        quiet: true,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.agents?.claude).toBeDefined();
    expect(updated.agents?.claude.acp?.command).toBe(
      "npx -y @agentclientprotocol/claude-agent-acp@latest",
    );
    expect(updated.agents?.claude.a2a).toBeUndefined();
    expect(updated.agents?.claude.prompt_file).toBeUndefined();
  });

  test("happy path — A2A-backed (remote)", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["agent", "review-bot"],
        a2a: "https://review-bot.internal.example.com",
        json: false,
        quiet: true,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.agents?.["review-bot"]).toBeDefined();
    expect(updated.agents?.["review-bot"].a2a?.url).toBe("https://review-bot.internal.example.com");
    expect(updated.agents?.["review-bot"].acp).toBeUndefined();
  });

  test("happy path — combined ACP + A2A + prompt-file + model", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-agent-ws-");
    const promptPath = await makePromptFile(workspace.path, "hybrid");

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["agent", "hybrid"],
        "prompt-file": promptPath,
        acp: "./my-agent --acp",
        a2a: "https://hybrid.example.com",
        model: "claude-opus-4-7",
        description: "Hybrid agent",
        json: false,
        quiet: true,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    const agent = updated.agents?.hybrid;
    expect(agent).toBeDefined();
    expect(agent!.prompt_file).toBe(promptPath);
    expect(agent!.acp?.command).toBe("./my-agent --acp");
    expect(agent!.a2a?.url).toBe("https://hybrid.example.com");
    expect(agent!.model).toBe("claude-opus-4-7");
    expect(agent!.description).toBe("Hybrid agent");
  });

  test("auto-commits the change", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { log } = await import("../../src/core/git");
    const before = await log(configDir);

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["agent", "committing-agent"],
        a2a: "https://example.com/agent",
        json: false,
        quiet: true,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const after = await log(configDir);
    expect(after.length).toBe(before.length + 1);
    expect(after[0].message).toBe("add agent: committing-agent");
  });

  test("invalid input — no backing source (prompt-file/acp/a2a) fails", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["agent", "empty"],
        description: "no backing",
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /--prompt-file, --acp, or --a2a/.test(l))).toBe(true);
    process.exitCode = 0;
  });

  test("invalid input — prompt-file does not exist", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["agent", "bad-prompt"],
        "prompt-file": "/tmp/does-not-exist-am-test-xyz.md",
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

  test("conflict — duplicate agent name fails", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["agent", "dup"],
        a2a: "https://example.com/dup",
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
        _: ["agent", "dup"],
        a2a: "https://example.com/dup",
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

  test("portability — warns on a host-absolute path in the prompt-file body", async () => {
    ({ dir, configDir } = await setupConfigDir());
    workspace = await createTestDir("am-add-agent-ws-");
    const promptPath = await makePromptFile(
      workspace.path,
      "host-path-agent",
      "# host-path-agent\n\nYou are an agent. Run /home/baladita/.local/bin/tool first.\n",
    );

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["agent", "host-path-agent"],
        "prompt-file": promptPath,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    // Warning surfaced + finding carried in the JSON envelope; agent still added.
    expect(consoleErrors.some((l) => /host-absolute path/.test(l))).toBe(true);
    const jsonLine = consoleOutput.find((l) => l.includes('"action"'));
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.portability).toBeDefined();
    expect(parsed.portability[0].kind).toBe("linux");
    expect(parsed.portability[0].match).toBe("/home/baladita/");
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.agents?.["host-path-agent"]).toBeDefined();
  });

  test("JSON mode emits the action envelope on stdout", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: {
        _: ["agent", "json-agent"],
        a2a: "https://example.com/json",
        description: "Json test",
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
    expect(parsed.entity).toBe("agent");
    expect(parsed.name).toBe("json-agent");
    expect(parsed.config.a2a.url).toBe("https://example.com/json");
  });
});
