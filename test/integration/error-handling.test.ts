import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { bunExe } from "../helpers/bun-exe";
import { type TestDir, createTestDir } from "../helpers/tmp";

// Integration tests spawn bun subprocesses per runAM() call; the cold-start
// cost of `bun run src/cli.ts` on CI and some dev machines is 1-3s, and these
// tests chain 2+ calls each. The default 5s test timeout leaves no headroom —
// bump to 30s so slow CI runners don't cause false flakes.
setDefaultTimeout(30_000);

let testDir: TestDir;

async function runAM(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([bunExe(), "run", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, AM_CONFIG_DIR: testDir.path },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, code: await proc.exited };
}

beforeEach(async () => {
  testDir = await createTestDir("am-errors-");
});

afterEach(async () => {
  await testDir.cleanup();
});

describe("error handling — commands requiring init", () => {
  test("am add before init shows helpful error", async () => {
    const { stderr, code } = await runAM("add", "fetch", "--command", "uvx");
    expect(code).not.toBe(0);
    expect(stderr).toContain("Config not found");
    expect(stderr).toContain("am init");
  });

  test("am log before init shows helpful error", async () => {
    const { stderr, code } = await runAM("log");
    expect(code).not.toBe(0);
    expect(stderr).toContain("am init");
  });

  test("am undo before init shows helpful error", async () => {
    const { stderr, code } = await runAM("undo");
    expect(code).not.toBe(0);
    // Either "Cannot read git log" or "am init" message
    expect(stderr.length).toBeGreaterThan(0);
  });

  test("am import before init shows helpful error", async () => {
    const { stderr, code } = await runAM("import", "claude-code");
    expect(code).not.toBe(0);
    expect(stderr).toContain("Config not found");
    expect(stderr).toContain("am init");
  });
});

describe("error handling — commands that gracefully handle missing config", () => {
  // These commands use loadResolvedConfig which returns empty config on missing file
  test("am list before init shows empty (not error)", async () => {
    const { stdout, code } = await runAM("list");
    expect(code).toBe(0);
    expect(stdout).toContain("No servers configured");
  });

  test("am status before init works with empty state", async () => {
    const { code } = await runAM("status");
    expect(code).toBe(0);
  });

  test("am apply before init works with empty state", async () => {
    const { code } = await runAM("apply");
    expect(code).toBe(0);
  });
});

describe("error handling — invalid arguments", () => {
  test("am use nonexistent-profile shows available profiles", async () => {
    await runAM("init");
    const { stderr, code } = await runAM("use", "nonexistent-profile");
    expect(code).not.toBe(0);
    expect(stderr).toContain("not found");
    expect(stderr).toContain("default");
  });

  test("am use nonexistent --json returns structured error", async () => {
    await runAM("init");
    const { stderr, code } = await runAM("use", "nonexistent", "--json");
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stderr);
    expect(parsed.error).toContain("not found");
    expect(parsed.suggestion).toContain("default");
  });

  test("am import nonexistent-adapter shows available adapters", async () => {
    await runAM("init");
    const { stderr, code } = await runAM("import", "nonexistent-adapter");
    expect(code).not.toBe(0);
    expect(stderr).toContain("not found");
    expect(stderr).toContain("claude-code");
  });

  test("am import nonexistent --json returns structured error", async () => {
    await runAM("init");
    const { stderr, code } = await runAM("import", "nonexistent", "--json");
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stderr);
    expect(parsed.error).toContain("not found");
    expect(parsed.suggestion).toContain("claude-code");
  });

  test("am apply --target nonexistent shows available adapters", async () => {
    await runAM("init");
    const { stderr, code } = await runAM("apply", "--target", "nonexistent");
    expect(code).not.toBe(0);
    expect(stderr).toContain("not found");
    expect(stderr).toContain("claude-code");
  });

  test("am apply --target nonexistent --json returns structured error", async () => {
    await runAM("init");
    const { stderr, code } = await runAM("apply", "--target", "nonexistent", "--json");
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stderr);
    expect(parsed.error).toContain("not found");
    expect(parsed.suggestion).toContain("claude-code");
  });
});

describe("error handling — push/pull without remote", () => {
  test("am push without remote shows helpful message", async () => {
    await runAM("init");
    const { stderr, code } = await runAM("push");
    expect(code).not.toBe(0);
    expect(stderr).toContain("No remote configured");
  });

  test("am push --json without remote returns structured error", async () => {
    await runAM("init");
    const { stderr, code } = await runAM("push", "--json");
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stderr);
    expect(parsed.error).toContain("No remote configured");
    expect(parsed.suggestion).toBeDefined();
  });

  test("am pull without remote shows helpful message", async () => {
    await runAM("init");
    const { stderr, code } = await runAM("pull");
    expect(code).not.toBe(0);
    expect(stderr).toContain("No remote configured");
  });

  test("am pull --json without remote returns structured error", async () => {
    await runAM("init");
    const { stderr, code } = await runAM("pull", "--json");
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stderr);
    expect(parsed.error).toContain("No remote configured");
    expect(parsed.suggestion).toBeDefined();
  });
});

describe("error handling — undo edge case", () => {
  test("am undo with only initial commit shows clear error", async () => {
    await runAM("init");
    const { stderr, code } = await runAM("undo");
    expect(code).not.toBe(0);
    expect(stderr).toContain("Nothing to undo");
  });
});

describe("error handling — duplicate server", () => {
  test("am add duplicate server shows clear error", async () => {
    await runAM("init");
    await runAM("add", "fetch", "--command", "uvx");
    const { stderr, code } = await runAM("add", "fetch", "--command", "uvx");
    expect(code).not.toBe(0);
    expect(stderr).toContain("already exists");
  });
});

describe("error handling — malformed config", () => {
  test("am add with malformed TOML shows error", async () => {
    // Write invalid TOML that won't parse
    await testDir.write("config.toml", "this is not valid [[[toml");

    const { stderr, code } = await runAM("add", "test", "--command", "echo");
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  test("am import with malformed TOML shows error", async () => {
    await testDir.write("config.toml", "broken = [[[toml");

    const { stderr, code } = await runAM("import", "claude-code");
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });
});

describe("error handling — all error commands return non-zero exit code", () => {
  const errorCases = [
    { name: "add before init", args: ["add", "x", "--command", "y"] },
    { name: "log before init", args: ["log"] },
    { name: "undo before init", args: ["undo"] },
    { name: "import before init", args: ["import", "claude-code"] },
  ];

  for (const { name, args } of errorCases) {
    test(`${name} returns non-zero exit code`, async () => {
      const { code } = await runAM(...args);
      expect(code).not.toBe(0);
    });
  }
});

describe("error handling — json error format for commands requiring init", () => {
  test("am add --json before init returns structured error", async () => {
    const { stderr, code } = await runAM("add", "x", "--command", "y", "--json");
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stderr);
    expect(parsed.error).toBeDefined();
    expect(typeof parsed.error).toBe("string");
  });

  test("am log --json before init returns structured error", async () => {
    const { stderr, code } = await runAM("log", "--json");
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stderr);
    expect(parsed.error).toBeDefined();
  });
});
