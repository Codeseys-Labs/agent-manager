import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDir, type TestDir } from "../helpers/tmp";
import { join } from "node:path";

let testDir: TestDir;

async function runAM(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
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
  testDir = await createTestDir("am-lifecycle-");
});

afterEach(async () => {
  await testDir.cleanup();
});

describe("lifecycle integration tests", () => {
  test("am version prints version", async () => {
    const { stdout, code } = await runAM("version");
    expect(code).toBe(0);
    expect(stdout).toContain("agent-manager");
    expect(stdout).toMatch(/v?\d+\.\d+\.\d+/);
  });

  test("am init creates config.toml and .git", async () => {
    const { stdout, stderr, code } = await runAM("init");
    expect(code).toBe(0);
    expect(await testDir.exists("config.toml")).toBe(true);
    // .git is a directory; check for a known file inside it
    expect(await testDir.exists(".git/HEAD")).toBe(true);
  });

  test("am init --json returns structured output", async () => {
    const { stdout, code } = await runAM("init", "--json");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("initialized");
    expect(parsed.configDir).toBe(testDir.path);
    expect(parsed.configPath).toContain("config.toml");
  });

  test("am add server adds to config.toml", async () => {
    await runAM("init");

    const { code } = await runAM(
      "add",
      "fetch",
      "--command",
      "uvx",
      "--args",
      "mcp-server-fetch",
      "--tags",
      "utility",
    );
    expect(code).toBe(0);

    const configRaw = await testDir.read("config.toml");
    expect(configRaw).toContain("[servers.fetch]");
    expect(configRaw).toContain('command = "uvx"');
  });

  test("am list servers shows added server", async () => {
    await runAM("init");
    await runAM("add", "fetch", "--command", "uvx", "--args", "mcp-server-fetch", "--tags", "utility");

    const { stdout, code } = await runAM("list");
    expect(code).toBe(0);
    expect(stdout).toContain("fetch");
    expect(stdout).toContain("uvx");
  });

  test("am list servers --json returns valid JSON", async () => {
    await runAM("init");
    await runAM("add", "fetch", "--command", "uvx", "--args", "mcp-server-fetch", "--tags", "utility");

    const { stdout, code } = await runAM("list", "--json");
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.servers).toBeArray();
    expect(parsed.servers.length).toBe(1);
    expect(parsed.servers[0].name).toBe("fetch");
    expect(parsed.servers[0].command).toBe("uvx");
    expect(parsed.servers[0].tags).toContain("utility");
  });

  test("am use default switches profile", async () => {
    await runAM("init");

    const { stdout, code } = await runAM("use", "default");
    expect(code).toBe(0);
    expect(stdout).toContain("default");
  });

  test("am apply --target claude-code --dry-run shows plan", async () => {
    await runAM("init");
    await runAM("add", "fetch", "--command", "uvx", "--args", "mcp-server-fetch");

    const { stdout, code } = await runAM("apply", "--target", "claude-code", "--dry-run");
    expect(code).toBe(0);
    expect(stdout).toContain("would write");
  });

  test("am status --json returns structured status", async () => {
    await runAM("init");

    const { stdout, code } = await runAM("status", "--json");
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.profile).toBeDefined();
    expect(typeof parsed.servers).toBe("number");
    expect(parsed.git).toBeDefined();
    expect(parsed.git.branch).toBe("main");
  });

  test("am log shows commit history", async () => {
    await runAM("init");

    const { stdout, code } = await runAM("log");
    expect(code).toBe(0);
    expect(stdout).toContain("init");
  });

  test("am log --json returns structured log", async () => {
    await runAM("init");

    const { stdout, code } = await runAM("log", "--json");
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.log).toBeArray();
    expect(parsed.log.length).toBeGreaterThanOrEqual(1);
    expect(parsed.log[0].oid).toBeDefined();
    expect(parsed.log[0].message).toContain("init");
  });

  test("am undo reverts last change", async () => {
    await runAM("init");
    // Add two servers so undo reverts the second, leaving the first
    await runAM("add", "fetch", "--command", "uvx", "--args", "mcp-server-fetch");
    await runAM("add", "tavily", "--command", "bunx", "--args", "tavily-mcp");

    // Verify tavily exists
    let configRaw = await testDir.read("config.toml");
    expect(configRaw).toContain("[servers.tavily]");

    // Undo the last add (tavily)
    const { stdout, code } = await runAM("undo");
    expect(code).toBe(0);
    expect(stdout).toContain("Reverted");

    // Verify tavily is gone but fetch remains
    configRaw = await testDir.read("config.toml");
    expect(configRaw).not.toContain("[servers.tavily]");
    expect(configRaw).toContain("[servers.fetch]");
  });

  test("full lifecycle: init → add → apply → status → undo", async () => {
    // 1. Init
    let result = await runAM("init");
    expect(result.code).toBe(0);

    // 2. Add two servers
    result = await runAM("add", "fetch", "--command", "uvx", "--args", "mcp-server-fetch", "--tags", "utility");
    expect(result.code).toBe(0);

    result = await runAM("add", "tavily", "--command", "bunx", "--args", "tavily-mcp@latest", "--tags", "search,web");
    expect(result.code).toBe(0);

    // 3. List — should show 2 servers
    result = await runAM("list", "--json");
    expect(result.code).toBe(0);
    const listed = JSON.parse(result.stdout);
    expect(listed.servers.length).toBe(2);

    // 4. Apply dry run
    result = await runAM("apply", "--dry-run", "--target", "claude-code");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("would write");

    // 5. Status
    result = await runAM("status", "--json");
    expect(result.code).toBe(0);
    const status = JSON.parse(result.stdout);
    expect(status.servers).toBe(2);

    // 6. Log — should have 4 commits: init gitignore, init config, add fetch, add tavily
    result = await runAM("log", "--json");
    expect(result.code).toBe(0);
    const logEntries = JSON.parse(result.stdout);
    expect(logEntries.log.length).toBeGreaterThanOrEqual(3);

    // 7. Undo — reverts add tavily
    result = await runAM("undo");
    expect(result.code).toBe(0);

    // 8. List again — should show 1 server
    result = await runAM("list", "--json");
    expect(result.code).toBe(0);
    const afterUndo = JSON.parse(result.stdout);
    expect(afterUndo.servers.length).toBe(1);
    expect(afterUndo.servers[0].name).toBe("fetch");
  });

  test("am init is idempotent (reports already initialized)", async () => {
    await runAM("init");
    const { stderr, code } = await runAM("init");
    // Second init should report already initialized (not crash)
    expect(code).toBe(0);
    const combined = stderr;
    expect(combined).toContain("Already initialized");
  });

  test("am add rejects duplicate server name", async () => {
    await runAM("init");
    await runAM("add", "fetch", "--command", "uvx");
    const { stderr, code } = await runAM("add", "fetch", "--command", "uvx");
    expect(code).not.toBe(0);
    expect(stderr).toContain("already exists");
  });
});
