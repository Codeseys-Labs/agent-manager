import { afterEach, describe, expect, test } from "bun:test";
import { exportConfig } from "@/adapters/cursor/export.ts";
import type {
  ResolvedAgent,
  ResolvedConfig,
  ResolvedInstruction,
  ResolvedServer,
} from "@/adapters/types.ts";
import { toPosix } from "../../helpers/path.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

/** Helper to build a minimal ResolvedServer. */
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

/** Helper to build a minimal ResolvedConfig. */
function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
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

/** Helper to build a minimal ResolvedInstruction. */
function instruction(
  overrides: Partial<ResolvedInstruction> & { content: string },
): ResolvedInstruction {
  return {
    name: "test-rule",
    scope: "always",
    globs: [],
    description: "",
    targets: [],
    adapters: {},
    ...overrides,
  };
}

/** Helper to build a minimal ResolvedAgent. */
function agent(overrides: Partial<ResolvedAgent> & { name: string }): ResolvedAgent {
  return {
    description: "",
    subagent_type: "test",
    prompt: "",
    prompt_file: "",
    model: "",
    tools: [],
    disallowed_tools: [],
    mcp_servers: [],
    max_turns: undefined,
    adapters: {},
    ...overrides,
  };
}

describe("cursor exportConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("generates global ~/.cursor/mcp.json with mcpServers", async () => {
    dir = await createTestDir("am-cursor-export-");
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

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    const globalFile = result.files.find((f) => toPosix(f.path).includes(".cursor/mcp.json"));
    expect(globalFile).toBeDefined();

    const parsed = JSON.parse(globalFile!.content);
    expect(parsed.mcpServers.fetch.command).toBe("uvx");
    expect(parsed.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(parsed.mcpServers.tavily.env.TAVILY_API_KEY).toBe("test-key");
  });

  test("generates project .cursor/mcp.json for project-scoped servers", async () => {
    dir = await createTestDir("am-cursor-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      servers: {
        "db-mcp": server({
          name: "db-mcp",
          command: "npx",
          args: ["-y", "db-mcp-server"],
          adapters: { cursor: { scope: "project" } },
        }),
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const projectFile = result.files.find((f) =>
      toPosix(f.path).includes("project/.cursor/mcp.json"),
    );
    expect(projectFile).toBeDefined();
    const parsed = JSON.parse(projectFile!.content);
    expect(parsed.mcpServers["db-mcp"].command).toBe("npx");
  });

  test("generates .mdc rule files from instructions", async () => {
    dir = await createTestDir("am-cursor-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "ts-rules": instruction({
          name: "ts-rules",
          content: "Use strict TypeScript.",
          scope: "always",
          description: "TypeScript conventions",
          targets: ["cursor"],
        }),
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const mdcFile = result.files.find((f) => toPosix(f.path).endsWith(".mdc"));
    expect(mdcFile).toBeDefined();
    expect(mdcFile!.content).toContain("alwaysApply: true");
    expect(mdcFile!.content).toContain('description: "TypeScript conventions"');
    expect(mdcFile!.content).toContain("Use strict TypeScript.");
  });

  test("generates glob-scoped .mdc with globs array", async () => {
    dir = await createTestDir("am-cursor-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "ts-rules": instruction({
          name: "ts-rules",
          content: "Use interfaces.",
          scope: "glob",
          globs: ["**/*.ts", "**/*.tsx"],
          description: "TS rules",
          targets: ["cursor"],
        }),
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const mdcFile = result.files.find((f) => toPosix(f.path).endsWith(".mdc"));
    expect(mdcFile!.content).toContain('globs: ["**/*.ts", "**/*.tsx"]');
    expect(mdcFile!.content).toContain("alwaysApply: false");
  });

  test("skips instructions not targeted at cursor", async () => {
    dir = await createTestDir("am-cursor-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "cc-only": instruction({
          name: "cc-only",
          content: "Claude-only rule.",
          targets: ["claude-code"],
        }),
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const mdcFiles = result.files.filter((f) => toPosix(f.path).endsWith(".mdc"));
    expect(mdcFiles).toHaveLength(0);
  });

  test("generates agent .md files", async () => {
    dir = await createTestDir("am-cursor-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      agents: {
        researcher: agent({
          name: "researcher",
          description: "Research agent",
          prompt: "You are a research assistant.",
        }),
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const agentFile = result.files.find((f) => toPosix(f.path).includes("agents/researcher.md"));
    expect(agentFile).toBeDefined();
    expect(agentFile!.content).toContain("# researcher");
    expect(agentFile!.content).toContain("Research agent");
    expect(agentFile!.content).toContain("You are a research assistant.");
  });

  test("dry run doesn't write files", async () => {
    dir = await createTestDir("am-cursor-export-");
    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    for (const file of result.files) {
      expect(file.written).toBe(false);
    }
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-cursor-export-");
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

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    const globalFile = result.files.find((f) => toPosix(f.path).includes(".cursor/mcp.json"));
    const parsed = JSON.parse(globalFile!.content);
    expect(parsed.mcpServers.enabled_one).toBeDefined();
    expect(parsed.mcpServers.disabled_one).toBeUndefined();
  });

  test("actual write creates files on disk", async () => {
    dir = await createTestDir("am-cursor-export-");
    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = await exportConfig(cfg, {}, dir.path);
    const globalFile = result.files.find((f) => toPosix(f.path).includes(".cursor/mcp.json"));
    expect(globalFile?.written).toBe(true);
    expect(await dir.exists(".cursor/mcp.json")).toBe(true);
    const content = JSON.parse(await dir.read(".cursor/mcp.json"));
    expect(content.mcpServers.fetch.command).toBe("uvx");
  });
});
