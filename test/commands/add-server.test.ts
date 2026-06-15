import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCommand } from "citty";
import { readConfig, writeConfig } from "../../src/core/config";
import { commitAll, initRepo } from "../../src/core/git";
import { type Config, ServerSchema } from "../../src/core/schema";
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

async function setupConfigDir(prefix = "am-add-server-"): Promise<{
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

// Base citty-shaped args object. Tests spread their own fields over this so the
// boolean output flags are always present (mirrors how citty fills defaults).
function baseArgs(over: Record<string, unknown>): Record<string, unknown> {
  return {
    json: false,
    quiet: true,
    verbose: false,
    transport: "stdio",
    ...over,
  };
}

describe("am add server — flags", () => {
  let dir: TestDir;
  let configDir: string;

  beforeEach(() => {
    resetConsole();
  });

  afterEach(async () => {
    restoreConsole();
    if (dir) await dir.cleanup();
    Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    process.exitCode = 0;
  });

  test("(a) --args comma form yields a flat args array", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: baseArgs({
        _: ["server", "comma"],
        command: "bunx",
        args: "-y,@scope/pkg,--port,8080",
      }) as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.comma?.args).toEqual(["-y", "@scope/pkg", "--port", "8080"]);
  });

  test("(b) --args repeated form yields a flat args array", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: baseArgs({
        _: ["server", "repeated"],
        command: "bunx",
        // citty turns repeated --args into a string[]
        args: ["-y", "@scope/pkg", "--port", "8080"],
      }) as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.repeated?.args).toEqual(["-y", "@scope/pkg", "--port", "8080"]);
  });

  test("(c) --args space-separated string form is split", async () => {
    // citty does not split on spaces, but a user can pass a single quoted string
    // with comma separators. The repeated-flag array may also carry a mixed
    // comma+single element; flatten + comma-split must normalize all of them.
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: baseArgs({
        _: ["server", "mixed"],
        command: "bunx",
        // repeated flag where one element is itself comma-separated, and an
        // empty/whitespace element that must be dropped
        args: ["-y", "@scope/pkg,--port,8080", "  ", ""],
      }) as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.mixed?.args).toEqual(["-y", "@scope/pkg", "--port", "8080"]);
  });

  test("all three --args forms produce the same parsed array", async () => {
    ({ dir, configDir } = await setupConfigDir());
    const { addCommand } = await import("../../src/commands/add");

    const forms: Record<string, unknown>[] = [
      { _: ["server", "f1"], command: "bunx", args: "-y,@scope/pkg" },
      { _: ["server", "f2"], command: "bunx", args: ["-y", "@scope/pkg"] },
      { _: ["server", "f3"], command: "bunx", args: ["-y,@scope/pkg"] },
    ];
    for (const f of forms) {
      await addCommand.run!({ args: baseArgs(f) as any, rawArgs: [], cmd: addCommand as any });
    }

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.f1?.args).toEqual(["-y", "@scope/pkg"]);
    expect(updated.servers?.f2?.args).toEqual(updated.servers?.f1?.args);
    expect(updated.servers?.f3?.args).toEqual(updated.servers?.f1?.args);
  });

  test("(d) remote server via --transport sse --url produces a valid remote Server", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: baseArgs({
        _: ["server", "remote"],
        transport: "sse",
        url: "https://mcp.example.com/sse",
        description: "Remote SSE server",
      }) as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    expect(process.exitCode).not.toBe(1);
    const updated = await readConfig(join(configDir, "config.toml"));
    const remote = updated.servers?.remote;
    expect(remote).toBeDefined();
    expect(remote?.transport).toBe("sse");
    expect(remote?.url).toBe("https://mcp.example.com/sse");
    // Must pass the discriminated-union ServerSchema as a remote variant.
    expect(() => ServerSchema.parse(remote)).not.toThrow();
  });

  test("(d2) remote server via --transport streamable-http --url is valid", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: baseArgs({
        _: ["server", "shttp"],
        transport: "streamable-http",
        url: "https://mcp.example.com/mcp",
      }) as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    expect(process.exitCode).not.toBe(1);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.shttp?.transport).toBe("streamable-http");
    expect(updated.servers?.shttp?.url).toBe("https://mcp.example.com/mcp");
    expect(() => ServerSchema.parse(updated.servers?.shttp)).not.toThrow();
  });

  test("(e) --transport sse with missing --url errors with nonzero exit", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: baseArgs({
        _: ["server", "no-url"],
        transport: "sse",
        quiet: false,
      }) as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /--url/.test(l))).toBe(true);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.["no-url"]).toBeUndefined();
  });

  test("stdio (default) with --url is rejected", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: baseArgs({
        _: ["server", "stdio-url"],
        command: "bunx",
        url: "https://nope.example.com",
        quiet: false,
      }) as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /--url/.test(l))).toBe(true);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.["stdio-url"]).toBeUndefined();
  });

  test("invalid --transport value errors", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: baseArgs({
        _: ["server", "bad-transport"],
        command: "bunx",
        transport: "carrier-pigeon",
        quiet: false,
      }) as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /transport/i.test(l))).toBe(true);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.["bad-transport"]).toBeUndefined();
  });

  test("(f) an unknown flag errors with nonzero exit", async () => {
    ({ dir, configDir } = await setupConfigDir());

    // Unknown-flag detection scans the intact rawArgs token stream (mri explodes
    // leading-dash values into bogus short-flag keys on the parsed args object,
    // so the args object is no longer a reliable source). Drive through citty.
    const { addCommand } = await import("../../src/commands/add");
    await runCommand(addCommand, {
      rawArgs: ["server", "bogus", "--command", "bunx", "--bogus", "value"],
    });

    expect(process.exitCode).toBe(1);
    expect(consoleErrors.some((l) => /Unknown flag: --bogus/.test(l))).toBe(true);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.bogus).toBeUndefined();
  });

  test("stdio server still adds with command + comma args (regression)", async () => {
    ({ dir, configDir } = await setupConfigDir());

    const { addCommand } = await import("../../src/commands/add");
    await addCommand.run!({
      args: baseArgs({
        _: ["server", "tavily"],
        command: "bunx",
        args: "tavily-mcp@latest",
        tags: "search,web",
        description: "Web search via Tavily",
      }) as any,
      rawArgs: [],
      cmd: addCommand as any,
    });

    expect(process.exitCode).not.toBe(1);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.tavily?.command).toBe("bunx");
    expect(updated.servers?.tavily?.transport).toBe("stdio");
    expect(updated.servers?.tavily?.args).toEqual(["tavily-mcp@latest"]);
    expect(updated.servers?.tavily?.tags).toEqual(["search", "web"]);
  });
});

// These tests drive the command through citty's real argument parser
// (runCommand with rawArgs) instead of hand-rolling the post-mri `args` object.
// That exercises the mri explosion that poisons leading-dash `--args` values
// (e.g. `--args "-y,pkg"` → mri sets args="" and explodes -y,tavily-mcp into
// bogus short flags `y`, `,`, `t`, ...). The handler must reconstruct the
// `--args` value(s) from rawArgs and must not treat the exploded short flags as
// unknown flags.
describe("am add server — citty rawArgs (mri explosion)", () => {
  let dir: TestDir;
  let configDir: string;

  beforeEach(() => {
    resetConsole();
  });

  afterEach(async () => {
    restoreConsole();
    if (dir) await dir.cleanup();
    Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    process.exitCode = 0;
  });

  test('--args "-y,pkg" (single comma string with leading dash)', async () => {
    ({ dir, configDir } = await setupConfigDir());
    const { addCommand } = await import("../../src/commands/add");

    await runCommand(addCommand, {
      rawArgs: ["server", "leadingdash1", "--command", "npx", "--args", "-y,pkg", "--quiet"],
    });

    expect(process.exitCode).not.toBe(1);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.leadingdash1?.command).toBe("npx");
    expect(updated.servers?.leadingdash1?.args).toEqual(["-y", "pkg"]);
  });

  test("--args -y --args pkg (repeated flag with leading dash)", async () => {
    ({ dir, configDir } = await setupConfigDir());
    const { addCommand } = await import("../../src/commands/add");

    await runCommand(addCommand, {
      rawArgs: [
        "server",
        "leadingdash2",
        "--command",
        "npx",
        "--args",
        "-y",
        "--args",
        "pkg",
        "--quiet",
      ],
    });

    expect(process.exitCode).not.toBe(1);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.leadingdash2?.command).toBe("npx");
    expect(updated.servers?.leadingdash2?.args).toEqual(["-y", "pkg"]);
  });

  test("--args=-y,pkg (equals form with leading dash)", async () => {
    ({ dir, configDir } = await setupConfigDir());
    const { addCommand } = await import("../../src/commands/add");

    await runCommand(addCommand, {
      rawArgs: ["server", "leadingdash3", "--command", "npx", "--args=-y,pkg", "--quiet"],
    });

    expect(process.exitCode).not.toBe(1);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.leadingdash3?.command).toBe("npx");
    expect(updated.servers?.leadingdash3?.args).toEqual(["-y", "pkg"]);
  });

  test("all three leading-dash --args forms produce the same parsed array", async () => {
    ({ dir, configDir } = await setupConfigDir());
    const { addCommand } = await import("../../src/commands/add");

    await runCommand(addCommand, {
      rawArgs: ["server", "g1", "--command", "npx", "--args", "-y,tavily-mcp", "--quiet"],
    });
    await runCommand(addCommand, {
      rawArgs: [
        "server",
        "g2",
        "--command",
        "npx",
        "--args",
        "-y",
        "--args",
        "tavily-mcp",
        "--quiet",
      ],
    });
    await runCommand(addCommand, {
      rawArgs: ["server", "g3", "--command", "npx", "--args=-y,tavily-mcp", "--quiet"],
    });

    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.g1?.args).toEqual(["-y", "tavily-mcp"]);
    expect(updated.servers?.g2?.args).toEqual(updated.servers?.g1?.args);
    expect(updated.servers?.g3?.args).toEqual(updated.servers?.g1?.args);
  });

  test("non-dash comma args still parse via rawArgs path", async () => {
    ({ dir, configDir } = await setupConfigDir());
    const { addCommand } = await import("../../src/commands/add");

    await runCommand(addCommand, {
      rawArgs: ["server", "nodash", "--command", "bunx", "--args", "tavily-mcp@latest", "--quiet"],
    });

    expect(process.exitCode).not.toBe(1);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.nodash?.args).toEqual(["tavily-mcp@latest"]);
  });

  test("leading-dash --args does not trip the unknown-flag guard", async () => {
    ({ dir, configDir } = await setupConfigDir());
    const { addCommand } = await import("../../src/commands/add");

    await runCommand(addCommand, {
      rawArgs: ["server", "noguard", "--command", "npx", "--args", "-y,tavily-mcp"],
    });

    // The exploded short flags (y, ',', t, a, ...) must NOT be treated as
    // unknown flags. No "Unknown flag" error should appear.
    expect(consoleErrors.some((l) => /Unknown flag/.test(l))).toBe(false);
    expect(process.exitCode).not.toBe(1);
    const updated = await readConfig(join(configDir, "config.toml"));
    expect(updated.servers?.noguard?.args).toEqual(["-y", "tavily-mcp"]);
  });
});
