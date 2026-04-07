import { describe, expect, test, afterEach } from "bun:test";
import { createTestDir, type TestDir } from "../../helpers/tmp.ts";
import { exportConfig } from "@/adapters/kiro/export.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    servers: {},
    instructions: {},
    skills: {},
    agents: {},
    profile: "default",
    adapters: {},
    ...overrides,
  };
}

function makeServer(overrides: Partial<ResolvedServer> = {}): ResolvedServer {
  return {
    name: "test-server",
    command: "test-cmd",
    args: [],
    env: {},
    transport: "stdio",
    description: "",
    tags: [],
    enabled: true,
    adapters: {},
    ...overrides,
  };
}

describe("kiro exportConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("generates ~/.kiro/settings/mcp.json with servers", async () => {
    dir = await createTestDir("am-kiro-export-");
    const config = makeConfig({
      servers: {
        fetch: makeServer({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = exportConfig(config, { dryRun: true }, dir.path);
    expect(result.files.length).toBeGreaterThanOrEqual(1);

    const globalFile = result.files.find((f) =>
      f.path.includes(".kiro/settings/mcp.json"),
    );
    expect(globalFile).toBeDefined();
    const parsed = JSON.parse(globalFile!.content);
    expect(parsed.mcpServers.fetch.command).toBe("uvx");
    expect(parsed.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
  });

  test("generates project .kiro/settings/mcp.json for project-scoped servers", async () => {
    dir = await createTestDir("am-kiro-export-");
    const projectDir = dir.path + "/project";
    const config = makeConfig({
      servers: {
        local: makeServer({
          name: "local",
          command: "my-local-mcp",
          adapters: { kiro: { scope: "project" } },
        }),
      },
    });

    const result = exportConfig(
      config,
      { projectPath: projectDir, dryRun: true },
      dir.path,
    );
    const projectFile = result.files.find(
      (f) => f.path.includes("project/.kiro/settings/mcp.json"),
    );
    expect(projectFile).toBeDefined();
    const parsed = JSON.parse(projectFile!.content);
    expect(parsed.mcpServers.local.command).toBe("my-local-mcp");
  });

  test("preserves Kiro-specific extras (autoApprove, disabledTools, timeout)", async () => {
    dir = await createTestDir("am-kiro-export-");
    const config = makeConfig({
      servers: {
        outlook: makeServer({
          name: "outlook",
          command: "aws-outlook-mcp",
          adapters: {
            kiro: {
              autoApprove: ["email_search"],
              disabledTools: ["email_send"],
              timeout: 60000,
            },
          },
        }),
      },
    });

    const result = exportConfig(config, { dryRun: true }, dir.path);
    const globalFile = result.files[0];
    const parsed = JSON.parse(globalFile.content);
    expect(parsed.mcpServers.outlook.autoApprove).toEqual(["email_search"]);
    expect(parsed.mcpServers.outlook.disabledTools).toEqual(["email_send"]);
    expect(parsed.mcpServers.outlook.timeout).toBe(60000);
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-kiro-export-");
    const config = makeConfig({
      servers: {
        disabled: makeServer({ name: "disabled", enabled: false }),
        active: makeServer({ name: "active", command: "my-mcp" }),
      },
    });

    const result = exportConfig(config, { dryRun: true }, dir.path);
    const globalFile = result.files[0];
    const parsed = JSON.parse(globalFile.content);
    expect(parsed.mcpServers.disabled).toBeUndefined();
    expect(parsed.mcpServers.active).toBeDefined();
  });

  test("generates steering files from instructions", async () => {
    dir = await createTestDir("am-kiro-export-");
    const projectDir = dir.path + "/project";
    const config = makeConfig({
      instructions: {
        "code-style": {
          name: "code-style",
          content: "# Code Style\n\nUse strict mode.",
          scope: "always",
          globs: [],
          description: "Code style rules",
          targets: [],
          adapters: {},
        },
      },
    });

    const result = exportConfig(
      config,
      { projectPath: projectDir, dryRun: true },
      dir.path,
    );
    const steeringFile = result.files.find((f) =>
      f.path.includes(".kiro/steering/code-style.md"),
    );
    expect(steeringFile).toBeDefined();
    expect(steeringFile!.content).toContain("inclusion: always");
    expect(steeringFile!.content).toContain("<!-- am:begin -->");
    expect(steeringFile!.content).toContain("Use strict mode");
    expect(steeringFile!.content).toContain("<!-- am:end -->");
  });

  test("filters instructions by target", async () => {
    dir = await createTestDir("am-kiro-export-");
    const projectDir = dir.path + "/project";
    const config = makeConfig({
      instructions: {
        "kiro-only": {
          name: "kiro-only",
          content: "Kiro rules",
          scope: "always",
          globs: [],
          description: "For Kiro",
          targets: ["kiro"],
          adapters: {},
        },
        "claude-only": {
          name: "claude-only",
          content: "Claude rules",
          scope: "always",
          globs: [],
          description: "For Claude",
          targets: ["claude-code"],
          adapters: {},
        },
      },
    });

    const result = exportConfig(
      config,
      { projectPath: projectDir, dryRun: true },
      dir.path,
    );
    const steeringFiles = result.files.filter((f) =>
      f.path.includes(".kiro/steering/"),
    );
    expect(steeringFiles).toHaveLength(1);
    expect(steeringFiles[0].content).toContain("Kiro rules");
  });

  test("writes files when not dryRun", async () => {
    dir = await createTestDir("am-kiro-export-");
    const config = makeConfig({
      servers: {
        fetch: makeServer({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = exportConfig(config, { dryRun: false }, dir.path);
    expect(result.files[0].written).toBe(true);

    const content = await dir.read(".kiro/settings/mcp.json");
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers.fetch.command).toBe("uvx");
  });

  test("exports HTTP servers with url field", async () => {
    dir = await createTestDir("am-kiro-export-");
    const config = makeConfig({
      servers: {
        remote: makeServer({
          name: "remote",
          command: "https://mcp.example.com/api",
          transport: "streamable-http",
        }),
      },
    });

    const result = exportConfig(config, { dryRun: true }, dir.path);
    const parsed = JSON.parse(result.files[0].content);
    expect(parsed.mcpServers.remote.url).toBe("https://mcp.example.com/api");
    expect(parsed.mcpServers.remote.command).toBeUndefined();
  });
});
