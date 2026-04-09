import { afterEach, describe, expect, test } from "bun:test";
import { exportConfig } from "@/adapters/forgecode/export.ts";
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

describe("forgecode exportConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("generates .mcp.json with mcpServers", async () => {
    dir = await createTestDir("am-fc-export-");
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

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true });
    const mcpFile = result.files.find((f) => f.path.endsWith(".mcp.json"));
    expect(mcpFile).toBeDefined();

    const parsed = JSON.parse(mcpFile?.content);
    expect(parsed.mcpServers.fetch.command).toBe("uvx");
    expect(parsed.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(parsed.mcpServers.tavily.env.TAVILY_API_KEY).toBe("test-key");
  });

  test("generates AGENTS.md with am markers", async () => {
    dir = await createTestDir("am-fc-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "ts-rules": {
          name: "ts-rules",
          content: "Use strict TypeScript.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["forgecode"],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true });
    const agentsMdFile = result.files.find((f) => f.path.endsWith("AGENTS.md"));
    expect(agentsMdFile).toBeDefined();
    expect(agentsMdFile?.content).toContain("<!-- am:begin -->");
    expect(agentsMdFile?.content).toContain("Use strict TypeScript.");
    expect(agentsMdFile?.content).toContain("<!-- am:end -->");
  });

  test("dry run doesn't write files", async () => {
    dir = await createTestDir("am-fc-export-");
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

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true });
    for (const file of result.files) {
      expect(file.written).toBe(false);
    }
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-fc-export-");
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

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true });
    const mcpFile = result.files.find((f) => f.path.endsWith(".mcp.json"));
    const parsed = JSON.parse(mcpFile?.content);
    expect(parsed.mcpServers.enabled_one).toBeDefined();
    expect(parsed.mcpServers.disabled_one).toBeUndefined();
  });

  test("actual write creates files on disk", async () => {
    dir = await createTestDir("am-fc-export-");
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

    const result = exportConfig(cfg, { projectPath: projectDir });
    const mcpFile = result.files.find((f) => f.path.endsWith(".mcp.json"));
    expect(mcpFile?.written).toBe(true);
    expect(await dir.exists("project/.mcp.json")).toBe(true);
    const content = JSON.parse(await dir.read("project/.mcp.json"));
    expect(content.mcpServers.fetch.command).toBe("uvx");
  });

  test("preserves existing AGENTS.md content outside markers", async () => {
    dir = await createTestDir("am-fc-export-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/AGENTS.md", "# My Custom Rules\n\nDo not delete this.\n");

    const cfg = config({
      instructions: {
        managed: {
          name: "managed",
          content: "Managed content here.",
          scope: "always",
          globs: [],
          description: "",
          targets: [],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true });
    const agentsMdFile = result.files.find((f) => f.path.endsWith("AGENTS.md"));
    expect(agentsMdFile?.content).toContain("My Custom Rules");
    expect(agentsMdFile?.content).toContain("Do not delete this.");
    expect(agentsMdFile?.content).toContain("Managed content here.");
  });

  test("skips instructions targeted at other adapters", async () => {
    dir = await createTestDir("am-fc-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "cc-only": {
          name: "cc-only",
          content: "Claude Code only instruction.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["claude-code"],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true });
    const agentsMdFile = result.files.find((f) => f.path.endsWith("AGENTS.md"));
    // Should not generate AGENTS.md since instruction is targeted elsewhere
    expect(agentsMdFile).toBeUndefined();
  });
});
