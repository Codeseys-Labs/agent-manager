import { afterEach, describe, expect, test } from "bun:test";
import { exportConfig } from "@/adapters/claude-code/export.ts";
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
    ...overrides,
  };
}

describe("exportConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("generates ~/.claude.json with mcpServers", async () => {
    dir = await createTestDir("am-export-");
    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
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

    const globalFile = result.files.find((f) => f.path.endsWith(".claude.json"));
    expect(globalFile).toBeDefined();

    const parsed = JSON.parse(globalFile?.content);
    expect(parsed.mcpServers.fetch.command).toBe("uvx");
    expect(parsed.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(parsed.mcpServers.tavily.env.TAVILY_API_KEY).toBe("test-key");
  });

  test("writes adapter-specific fields (alwaysAllow)", async () => {
    dir = await createTestDir("am-export-");
    const cfg = config({
      servers: {
        outlook: server({
          name: "outlook",
          command: "aws-outlook-mcp",
          adapters: {
            "claude-code": {
              alwaysAllow: ["email_search", "calendar_view"],
            },
          },
        }),
      },
    });

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    const globalFile = result.files.find((f) => f.path.endsWith(".claude.json"));
    const parsed = JSON.parse(globalFile?.content);
    expect(parsed.mcpServers.outlook.always_allow).toEqual(["email_search", "calendar_view"]);
  });

  test("generates CLAUDE.md with am markers", async () => {
    dir = await createTestDir("am-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "ts-rules": {
          name: "ts-rules",
          content: "Use strict TypeScript.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["claude-code"],
          adapters: {},
        },
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const claudeMdFile = result.files.find((f) => f.path.endsWith("CLAUDE.md"));
    expect(claudeMdFile).toBeDefined();
    expect(claudeMdFile?.content).toContain("<!-- am:begin -->");
    expect(claudeMdFile?.content).toContain("Use strict TypeScript.");
    expect(claudeMdFile?.content).toContain("<!-- am:end -->");
  });

  test("dry run doesn't write files", async () => {
    dir = await createTestDir("am-export-");
    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    for (const file of result.files) {
      expect(file.written).toBe(false);
    }
    // Verify file was NOT actually written
    expect(await dir.exists(".claude.json")).toBe(false);
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-export-");
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
    const globalFile = result.files.find((f) => f.path.endsWith(".claude.json"));
    const parsed = JSON.parse(globalFile?.content);
    expect(parsed.mcpServers.enabled_one).toBeDefined();
    expect(parsed.mcpServers.disabled_one).toBeUndefined();
  });

  test("preserves existing ~/.claude.json fields", async () => {
    dir = await createTestDir("am-export-");
    // Write an existing file with non-MCP fields
    await dir.write(
      ".claude.json",
      JSON.stringify({
        numStartups: 42,
        selectedModel: "opus",
        mcpServers: { old: { command: "old-mcp" } },
      }),
    );

    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = await exportConfig(cfg, {}, dir.path);
    const globalFile = result.files.find((f) => f.path.endsWith(".claude.json"));
    const parsed = JSON.parse(globalFile?.content);
    // Non-MCP fields preserved
    expect(parsed.numStartups).toBe(42);
    expect(parsed.selectedModel).toBe("opus");
    // Old mcpServers replaced with new
    expect(parsed.mcpServers.old).toBeUndefined();
    expect(parsed.mcpServers.fetch).toBeDefined();
  });

  test("actual write creates files on disk", async () => {
    dir = await createTestDir("am-export-");
    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = await exportConfig(cfg, {}, dir.path);
    const globalFile = result.files.find((f) => f.path.endsWith(".claude.json"));
    expect(globalFile?.written).toBe(true);
    expect(await dir.exists(".claude.json")).toBe(true);
    const content = JSON.parse(await dir.read(".claude.json"));
    expect(content.mcpServers.fetch.command).toBe("uvx");
  });
});
