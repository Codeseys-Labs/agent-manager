import { afterEach, describe, expect, test } from "bun:test";
import { exportConfig } from "@/adapters/amazon-q/export.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
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

describe("amazon-q exportConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("generates mcp.json with mcpServers", async () => {
    dir = await createTestDir("am-aq-export-");
    const cfg = config({
      servers: {
        "aws-docs": server({
          name: "aws-docs",
          command: "uvx",
          args: ["awslabs.aws-documentation-mcp-server@latest"],
          env: { FASTMCP_LOG_LEVEL: "ERROR" },
        }),
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    expect(result.files.length).toBeGreaterThanOrEqual(1);

    const mcpFile = result.files.find((f) => f.path.endsWith("mcp.json"));
    expect(mcpFile).toBeDefined();

    const parsed = JSON.parse(mcpFile!.content);
    expect(parsed.mcpServers["aws-docs"].command).toBe("uvx");
    expect(parsed.mcpServers["aws-docs"].env.FASTMCP_LOG_LEVEL).toBe("ERROR");
    expect(parsed.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
  });

  test("generates .amazonq/rules/*.md from instructions", async () => {
    dir = await createTestDir("am-aq-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "ts-rules": {
          name: "ts-rules",
          content: "Use strict TypeScript.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["amazon-q"],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const ruleFile = result.files.find((f) => f.path.endsWith("ts-rules.md"));
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.content).toBe("Use strict TypeScript.\n");
  });

  test("instructions are plain markdown without frontmatter", async () => {
    dir = await createTestDir("am-aq-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        testing: {
          name: "testing",
          content: "Use describe/test blocks.",
          scope: "glob",
          globs: ["**/*.test.ts"],
          description: "",
          targets: [],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const ruleFile = result.files.find((f) => f.path.endsWith("testing.md"));
    expect(ruleFile).toBeDefined();
    // No frontmatter, just content
    expect(ruleFile!.content).toBe("Use describe/test blocks.\n");
    expect(ruleFile!.content).not.toContain("---");
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-aq-export-");
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

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    const mcpFile = result.files.find((f) => f.path.endsWith("mcp.json"));
    const parsed = JSON.parse(mcpFile!.content);
    expect(parsed.mcpServers.enabled_one).toBeDefined();
    expect(parsed.mcpServers.disabled_one).toBeUndefined();
  });

  test("skips instructions not targeting amazon-q", async () => {
    dir = await createTestDir("am-aq-export-");
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

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const ruleFiles = result.files.filter((f) => f.path.includes(".amazonq/rules"));
    expect(ruleFiles).toHaveLength(0);
  });

  test("dry run doesn't write files", async () => {
    dir = await createTestDir("am-aq-export-");
    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    for (const file of result.files) {
      expect(file.written).toBe(false);
    }
  });

  test("actual write creates files on disk", async () => {
    dir = await createTestDir("am-aq-export-");
    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = exportConfig(cfg, {}, dir.path);
    const mcpFile = result.files.find((f) => f.path.endsWith("mcp.json"));
    expect(mcpFile?.written).toBe(true);
    const content = JSON.parse(await dir.read(".aws/amazonq/mcp.json"));
    expect(content.mcpServers.fetch.command).toBe("uvx");
  });

  test("preserves existing non-MCP fields in mcp.json", async () => {
    dir = await createTestDir("am-aq-export-");
    await dir.write(
      ".aws/amazonq/mcp.json",
      JSON.stringify({
        useLegacyMcpJson: true,
        mcpServers: { old: { command: "old-mcp" } },
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

    const result = exportConfig(cfg, {}, dir.path);
    const mcpFile = result.files.find((f) => f.path.endsWith("mcp.json"));
    const parsed = JSON.parse(mcpFile!.content);
    expect(parsed.useLegacyMcpJson).toBe(true);
    expect(parsed.mcpServers.old).toBeUndefined();
    expect(parsed.mcpServers.fetch).toBeDefined();
  });

  test("maps adapter-specific fields to export", async () => {
    dir = await createTestDir("am-aq-export-");
    const cfg = config({
      servers: {
        slow: server({
          name: "slow",
          command: "uvx",
          args: ["slow-server"],
          adapters: { "amazon-q": { timeout: 60 } },
        }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    const mcpFile = result.files.find((f) => f.path.endsWith("mcp.json"));
    const parsed = JSON.parse(mcpFile!.content);
    expect(parsed.mcpServers.slow.timeout).toBe(60);
  });
});
