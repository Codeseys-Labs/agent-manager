import { afterEach, describe, expect, test } from "bun:test";
import { exportConfig } from "@/adapters/copilot/export.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { toPosix } from "../../helpers/path.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

function server(overrides: Partial<ResolvedServer> & { command: string }): ResolvedServer {
  return {
    name: "test",
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

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    servers: {},
    instructions: {},
    skills: {},
    profile: "default",
    adapters: {},
    agents: {},
    ...overrides,
  };
}

describe("copilot exportConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("generates .vscode/mcp.json with 'servers' key (not mcpServers)", async () => {
    dir = await createTestDir("am-cp-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
        tavily: server({
          name: "tavily",
          command: "bunx",
          args: ["tavily-mcp@latest"],
          env: { TAVILY_API_KEY: "test-key" },
        }),
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const mcpFile = result.files.find((f) => toPosix(f.path).endsWith("mcp.json"));
    expect(mcpFile).toBeDefined();

    const parsed = JSON.parse(mcpFile!.content);
    // Must use "servers" key
    expect(parsed.servers).toBeDefined();
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.servers.fetch.command).toBe("uvx");
    expect(parsed.servers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(parsed.servers.tavily.env.TAVILY_API_KEY).toBe("test-key");
  });

  test("generates copilot-instructions.md for always-scoped instructions", async () => {
    dir = await createTestDir("am-cp-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "ts-rules": {
          name: "ts-rules",
          content: "Use strict TypeScript.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["copilot"],
          adapters: {},
        },
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const instrFile = result.files.find((f) => toPosix(f.path).endsWith("copilot-instructions.md"));
    expect(instrFile).toBeDefined();
    expect(instrFile!.content).toContain("Use strict TypeScript.");
  });

  test("generates scoped .instructions.md with applyTo frontmatter", async () => {
    dir = await createTestDir("am-cp-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        testing: {
          name: "testing",
          content: "Use describe/test blocks.",
          scope: "glob",
          globs: ["**/*.test.ts"],
          description: "",
          targets: ["copilot"],
          adapters: {},
        },
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const instrFile = result.files.find((f) => toPosix(f.path).endsWith("testing.instructions.md"));
    expect(instrFile).toBeDefined();
    expect(instrFile!.content).toContain('applyTo: "**/*.test.ts"');
    expect(instrFile!.content).toContain("Use describe/test blocks.");
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-cp-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      servers: {
        enabled_one: server({ name: "enabled_one", command: "enabled-mcp" }),
        disabled_one: server({
          name: "disabled_one",
          command: "disabled-mcp",
          enabled: false,
        }),
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const mcpFile = result.files.find((f) => toPosix(f.path).endsWith("mcp.json"));
    const parsed = JSON.parse(mcpFile!.content);
    expect(parsed.servers.enabled_one).toBeDefined();
    expect(parsed.servers.disabled_one).toBeUndefined();
  });

  test("skips instructions not targeting copilot", async () => {
    dir = await createTestDir("am-cp-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "claude-only": {
          name: "claude-only",
          content: "Only for Claude.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["claude-code"],
          adapters: {},
        },
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const instrFiles = result.files.filter(
      (f) =>
        toPosix(f.path).endsWith("copilot-instructions.md") ||
        toPosix(f.path).includes(".github/instructions"),
    );
    expect(instrFiles).toHaveLength(0);
  });

  test("dry run doesn't write files", async () => {
    dir = await createTestDir("am-cp-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    for (const file of result.files) {
      expect(file.written).toBe(false);
    }
  });

  test("actual write creates files on disk", async () => {
    dir = await createTestDir("am-cp-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir }, dir.path);
    const mcpFile = result.files.find((f) => toPosix(f.path).endsWith("mcp.json"));
    expect(mcpFile?.written).toBe(true);
    const content = JSON.parse(await dir.read("project/.vscode/mcp.json"));
    expect(content.servers.fetch.command).toBe("uvx");
  });

  test("preserves existing non-server fields in mcp.json", async () => {
    dir = await createTestDir("am-cp-export-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.vscode/mcp.json",
      JSON.stringify({
        someOtherSetting: true,
        servers: { old: { command: "old-mcp" } },
      }),
    );

    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir }, dir.path);
    const mcpFile = result.files.find((f) => toPosix(f.path).endsWith("mcp.json"));
    const parsed = JSON.parse(mcpFile!.content);
    expect(parsed.someOtherSetting).toBe(true);
    expect(parsed.servers.old).toBeUndefined();
    expect(parsed.servers.fetch).toBeDefined();
  });

  test("exports HTTP servers with type and url", async () => {
    dir = await createTestDir("am-cp-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      servers: {
        github: server({
          name: "github",
          command: "https://api.githubcopilot.com/mcp/",
          transport: "streamable-http",
          adapters: {
            copilot: {
              type: "http",
              url: "https://api.githubcopilot.com/mcp/",
            },
          },
        }),
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const mcpFile = result.files.find((f) => toPosix(f.path).endsWith("mcp.json"));
    const parsed = JSON.parse(mcpFile!.content);
    expect(parsed.servers.github.type).toBe("http");
    expect(parsed.servers.github.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(parsed.servers.github.command).toBeUndefined();
  });
});
