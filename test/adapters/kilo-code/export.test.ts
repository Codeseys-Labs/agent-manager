import { describe, expect, test, afterEach } from "bun:test";
import { createTestDir, type TestDir } from "../../helpers/tmp.ts";
import { exportConfig } from "@/adapters/kilo-code/export.ts";
import { parseJsonc } from "@/adapters/kilo-code/jsonc.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";

/** Helper to build a minimal ResolvedServer. */
function server(
  overrides: Partial<ResolvedServer> & { command: string },
): ResolvedServer {
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

  test("generates kilo.jsonc with mcp key (new format)", async () => {
    dir = await createTestDir("am-kc-export-");
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
          env: { TAVILY_KEY: "test-key" },
        }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    expect(result.files.length).toBeGreaterThanOrEqual(1);

    const globalFile = result.files.find((f) =>
      f.path.endsWith("kilo.jsonc"),
    );
    expect(globalFile).toBeDefined();

    const parsed = JSON.parse(globalFile!.content) as Record<string, unknown>;
    const mcp = parsed.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.fetch.command).toEqual(["uvx", "mcp-server-fetch"]);
    expect(mcp.fetch.type).toBe("local");
    expect(mcp.tavily.environment).toEqual({ TAVILY_KEY: "test-key" });
  });

  test("exports remote servers correctly", async () => {
    dir = await createTestDir("am-kc-export-");
    const cfg = config({
      servers: {
        api: server({
          name: "api",
          command: "https://example.com/mcp",
          transport: "streamable-http",
          env: { Authorization: "Bearer token" },
        }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    const globalFile = result.files.find((f) =>
      f.path.endsWith("kilo.jsonc"),
    );
    const parsed = JSON.parse(globalFile!.content) as Record<string, unknown>;
    const mcp = parsed.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.api.type).toBe("remote");
    expect(mcp.api.url).toBe("https://example.com/mcp");
    expect(mcp.api.headers).toEqual({ Authorization: "Bearer token" });
  });

  test("generates AGENTS.md with am markers", async () => {
    dir = await createTestDir("am-kc-export-");
    const projectDir = dir.path + "/project";
    const cfg = config({
      instructions: {
        "ts-rules": {
          name: "ts-rules",
          content: "Use strict TypeScript.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["kilo-code"],
          adapters: {},
        },
      },
    });

    const result = exportConfig(
      cfg,
      { projectPath: projectDir, dryRun: true },
      dir.path,
    );
    const agentsFile = result.files.find((f) => f.path.endsWith("AGENTS.md"));
    expect(agentsFile).toBeDefined();
    expect(agentsFile!.content).toContain("<!-- am:begin -->");
    expect(agentsFile!.content).toContain("Use strict TypeScript.");
    expect(agentsFile!.content).toContain("<!-- am:end -->");
  });

  test("dry run doesn't write files", async () => {
    dir = await createTestDir("am-kc-export-");
    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    for (const file of result.files) {
      expect(file.written).toBe(false);
    }
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-kc-export-");
    const cfg = config({
      servers: {
        enabled: server({ name: "enabled", command: "enabled-mcp" }),
        disabled: server({
          name: "disabled",
          command: "disabled-mcp",
          enabled: false,
        }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    const globalFile = result.files.find((f) =>
      f.path.endsWith("kilo.jsonc"),
    );
    const parsed = JSON.parse(globalFile!.content) as Record<string, unknown>;
    const mcp = parsed.mcp as Record<string, unknown>;
    expect(mcp.enabled).toBeDefined();
    expect(mcp.disabled).toBeUndefined();
  });

  test("preserves existing config fields", async () => {
    dir = await createTestDir("am-kc-export-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        model: "anthropic/claude-sonnet-4-20250514",
        mcp: { old: { type: "local", command: ["old-mcp"] } },
      }),
    );

    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = exportConfig(cfg, {}, dir.path);
    const globalFile = result.files.find((f) =>
      f.path.endsWith("kilo.jsonc"),
    );
    const parsed = JSON.parse(globalFile!.content) as Record<string, unknown>;
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-20250514");
    // Old MCP replaced
    const mcp = parsed.mcp as Record<string, unknown>;
    expect(mcp.old).toBeUndefined();
    expect(mcp.fetch).toBeDefined();
  });

  test("removes legacy mcpServers when writing new format", async () => {
    dir = await createTestDir("am-kc-export-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcpServers: { legacy: { command: "old", args: [] } },
      }),
    );

    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = exportConfig(cfg, {}, dir.path);
    const globalFile = result.files.find((f) =>
      f.path.endsWith("kilo.jsonc"),
    );
    const parsed = JSON.parse(globalFile!.content) as Record<string, unknown>;
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.mcp).toBeDefined();
  });

  test("actual write creates files on disk", async () => {
    dir = await createTestDir("am-kc-export-");
    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = exportConfig(cfg, {}, dir.path);
    const globalFile = result.files.find((f) =>
      f.path.endsWith("kilo.jsonc"),
    );
    expect(globalFile!.written).toBe(true);
    expect(await dir.exists(".config/kilo/kilo.jsonc")).toBe(true);
    const content = JSON.parse(
      await dir.read(".config/kilo/kilo.jsonc"),
    );
    expect(content.mcp.fetch.command).toEqual(["uvx", "mcp-server-fetch"]);
  });

  test("routes project-scoped servers to project kilo.jsonc", async () => {
    dir = await createTestDir("am-kc-export-");
    const projectDir = dir.path + "/project";
    const cfg = config({
      servers: {
        "proj-server": server({
          name: "proj-server",
          command: "node",
          args: ["proj.js"],
          adapters: { "kilo-code": { scope: "project" } },
        }),
      },
    });

    const result = exportConfig(
      cfg,
      { projectPath: projectDir, dryRun: true },
      dir.path,
    );
    const projFile = result.files.find(
      (f) => f.path.endsWith("kilo.jsonc") && f.path.includes("project"),
    );
    expect(projFile).toBeDefined();
    const parsed = JSON.parse(projFile!.content) as Record<string, unknown>;
    const mcp = parsed.mcp as Record<string, unknown>;
    expect(mcp["proj-server"]).toBeDefined();
  });
});
