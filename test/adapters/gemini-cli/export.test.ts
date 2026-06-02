import { afterEach, describe, expect, test } from "bun:test";
import { exportConfig } from "@/adapters/gemini-cli/export.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
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
    profile: "default",
    adapters: {},
    agents: {},
    ...overrides,
  };
}

describe("gemini-cli exportConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("generates ~/.gemini/settings.json with mcpServers", async () => {
    dir = await createTestDir("am-gc-export-");
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
    expect(result.files.length).toBeGreaterThanOrEqual(1);

    const globalFile = result.files.find((f) => f.path.endsWith("settings.json"));
    expect(globalFile).toBeDefined();

    const parsed = JSON.parse(globalFile!.content);
    expect(parsed.mcpServers.fetch.command).toBe("uvx");
    expect(parsed.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(parsed.mcpServers.tavily.env.TAVILY_API_KEY).toBe("test-key");
  });

  test("writes adapter-specific fields (timeout, trust)", async () => {
    dir = await createTestDir("am-gc-export-");
    const cfg = config({
      servers: {
        trusted: server({
          name: "trusted",
          command: "my-mcp",
          adapters: {
            "gemini-cli": {
              trust: true,
              timeout: 60000,
            },
          },
        }),
      },
    });

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    const globalFile = result.files.find((f) => f.path.endsWith("settings.json"));
    const parsed = JSON.parse(globalFile!.content);
    expect(parsed.mcpServers.trusted.trust).toBe(true);
    expect(parsed.mcpServers.trusted.timeout).toBe(60000);
  });

  test("generates GEMINI.md with am markers", async () => {
    dir = await createTestDir("am-gc-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "ts-rules": {
          name: "ts-rules",
          content: "Use strict TypeScript.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["gemini-cli"],
          adapters: {},
        },
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const geminiMdFile = result.files.find((f) => f.path.endsWith("GEMINI.md"));
    expect(geminiMdFile).toBeDefined();
    expect(geminiMdFile!.content).toContain("<!-- am:begin -->");
    expect(geminiMdFile!.content).toContain("Use strict TypeScript.");
    expect(geminiMdFile!.content).toContain("<!-- am:end -->");
  });

  test("dry run doesn't write files", async () => {
    dir = await createTestDir("am-gc-export-");
    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    for (const file of result.files) {
      expect(file.written).toBe(false);
    }
    expect(await dir.exists(".gemini/settings.json")).toBe(false);
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-gc-export-");
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
    const globalFile = result.files.find((f) => f.path.endsWith("settings.json"));
    const parsed = JSON.parse(globalFile!.content);
    expect(parsed.mcpServers.enabled_one).toBeDefined();
    expect(parsed.mcpServers.disabled_one).toBeUndefined();
  });

  test("preserves existing settings.json fields", async () => {
    dir = await createTestDir("am-gc-export-");
    // Write an existing file with non-MCP fields
    await dir.write(
      ".gemini/settings.json",
      JSON.stringify({
        general: { vimMode: true },
        model: { name: "gemini-2.5-pro" },
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

    const result = await exportConfig(cfg, {}, dir.path);
    const globalFile = result.files.find((f) => f.path.endsWith("settings.json"));
    const parsed = JSON.parse(globalFile!.content);
    // Non-MCP fields preserved
    expect(parsed.general.vimMode).toBe(true);
    expect(parsed.model.name).toBe("gemini-2.5-pro");
    // Old mcpServers replaced with new
    expect(parsed.mcpServers.old).toBeUndefined();
    expect(parsed.mcpServers.fetch).toBeDefined();
  });

  test("actual write creates files on disk", async () => {
    dir = await createTestDir("am-gc-export-");
    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = await exportConfig(cfg, {}, dir.path);
    const globalFile = result.files.find((f) => f.path.endsWith("settings.json"));
    expect(globalFile?.written).toBe(true);
    expect(await dir.exists(".gemini/settings.json")).toBe(true);
    const content = JSON.parse(await dir.read(".gemini/settings.json"));
    expect(content.mcpServers.fetch.command).toBe("uvx");
  });

  test("skips instructions not targeted at gemini-cli", async () => {
    dir = await createTestDir("am-gc-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "claude-only": {
          name: "claude-only",
          content: "Claude-specific rule.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["claude-code"],
          adapters: {},
        },
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const geminiMdFile = result.files.find((f) => f.path.endsWith("GEMINI.md"));
    expect(geminiMdFile).toBeUndefined();
  });

  test("generates project .gemini/settings.json for project-scoped servers", async () => {
    dir = await createTestDir("am-gc-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      servers: {
        "project-mcp": server({
          name: "project-mcp",
          command: "project-server",
          adapters: {
            "gemini-cli": { scope: "project" },
          },
        }),
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const projectFile = result.files.find(
      (f) => f.path.includes("project") && f.path.endsWith("settings.json"),
    );
    expect(projectFile).toBeDefined();
    const parsed = JSON.parse(projectFile!.content);
    expect(parsed.mcpServers["project-mcp"].command).toBe("project-server");
  });
});
