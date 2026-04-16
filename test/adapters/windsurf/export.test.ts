import { afterEach, describe, expect, test } from "bun:test";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { exportConfig } from "@/adapters/windsurf/export.ts";
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
    ...overrides,
  };
}

describe("windsurf exportConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("generates mcp_config.json with mcpServers", async () => {
    dir = await createTestDir("am-ws-export-");
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

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    expect(result.files.length).toBeGreaterThanOrEqual(1);

    const mcpFile = result.files.find((f) => f.path.endsWith("mcp_config.json"));
    expect(mcpFile).toBeDefined();

    const parsed = JSON.parse(mcpFile?.content);
    expect(parsed.mcpServers.fetch.command).toBe("uvx");
    expect(parsed.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(parsed.mcpServers.tavily.env.TAVILY_API_KEY).toBe("test-key");
  });

  test("generates .windsurf/rules/*.md from instructions", async () => {
    dir = await createTestDir("am-ws-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "ts-rules": {
          name: "ts-rules",
          content: "Use strict TypeScript.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["windsurf"],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const ruleFile = result.files.find((f) => f.path.endsWith("ts-rules.md"));
    expect(ruleFile).toBeDefined();
    expect(ruleFile?.content).toContain("trigger: always_on");
    expect(ruleFile?.content).toContain("Use strict TypeScript.");
  });

  test("generates glob rules with globs frontmatter", async () => {
    dir = await createTestDir("am-ws-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        testing: {
          name: "testing",
          content: "Use describe/test blocks.",
          scope: "glob",
          globs: ["**/*.test.ts"],
          description: "",
          targets: ["windsurf"],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const ruleFile = result.files.find((f) => f.path.endsWith("testing.md"));
    expect(ruleFile).toBeDefined();
    expect(ruleFile?.content).toContain("trigger: glob");
    expect(ruleFile?.content).toContain('globs: "**/*.test.ts"');
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-ws-export-");
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
    const mcpFile = result.files.find((f) => f.path.endsWith("mcp_config.json"));
    const parsed = JSON.parse(mcpFile?.content);
    expect(parsed.mcpServers.enabled_one).toBeDefined();
    expect(parsed.mcpServers.disabled_one).toBeUndefined();
  });

  test("skips instructions not targeting windsurf", async () => {
    dir = await createTestDir("am-ws-export-");
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
    const ruleFiles = result.files.filter((f) => f.path.includes(".windsurf/rules"));
    expect(ruleFiles).toHaveLength(0);
  });

  test("dry run doesn't write files", async () => {
    dir = await createTestDir("am-ws-export-");
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
    dir = await createTestDir("am-ws-export-");
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
    const mcpFile = result.files.find((f) => f.path.endsWith("mcp_config.json"));
    expect(mcpFile?.written).toBe(true);
    const content = JSON.parse(await dir.read(".codeium/windsurf/mcp_config.json"));
    expect(content.mcpServers.fetch.command).toBe("uvx");
  });

  test("generates AGENTS.md with am markers", async () => {
    dir = await createTestDir("am-ws-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "ws-rules": {
          name: "ws-rules",
          content: "Use strict TypeScript.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["windsurf"],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const agentsMdFile = result.files.find((f) => f.path.endsWith("AGENTS.md"));
    expect(agentsMdFile).toBeDefined();
    expect(agentsMdFile?.content).toContain("<!-- am:begin -->");
    expect(agentsMdFile?.content).toContain("Use strict TypeScript.");
    expect(agentsMdFile?.content).toContain("<!-- am:end -->");
  });

  test("generates .windsurf/skills/ from resolved skills", async () => {
    dir = await createTestDir("am-ws-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      skills: {
        research: {
          name: "research",
          path: "/tmp/skills/research",
          description: "Multi-agent research skill",
          tags: [],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const skillFile = result.files.find((f) => f.path.includes(".windsurf/skills/research/SKILL.md"));
    expect(skillFile).toBeDefined();
    expect(skillFile?.content).toContain("# research");
    expect(skillFile?.content).toContain("Multi-agent research skill");
  });

  test("preserves existing non-MCP fields in mcp_config.json", async () => {
    dir = await createTestDir("am-ws-export-");
    await dir.write(
      ".codeium/windsurf/mcp_config.json",
      JSON.stringify({
        someOtherSetting: true,
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
    const mcpFile = result.files.find((f) => f.path.endsWith("mcp_config.json"));
    const parsed = JSON.parse(mcpFile?.content);
    expect(parsed.someOtherSetting).toBe(true);
    expect(parsed.mcpServers.old).toBeUndefined();
    expect(parsed.mcpServers.fetch).toBeDefined();
  });
});
