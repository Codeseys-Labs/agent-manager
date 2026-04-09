import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { exportConfig } from "@/adapters/cline/export.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

const SETTINGS_REL = join(
  "Library",
  "Application Support",
  "Code",
  "User",
  "globalStorage",
  "saoudrizwan.claude-dev",
  "settings",
  "cline_mcp_settings.json",
);

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

describe("cline exportConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("generates cline_mcp_settings.json with mcpServers", async () => {
    dir = await createTestDir("am-cline-export-");
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

    const settingsFile = result.files.find((f) => f.path.endsWith("cline_mcp_settings.json"));
    expect(settingsFile).toBeDefined();

    const parsed = JSON.parse(settingsFile?.content) as Record<string, unknown>;
    const mcpServers = parsed.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcpServers.fetch.command).toBe("uvx");
    expect(mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(mcpServers.tavily.env).toEqual({ TAVILY_KEY: "test-key" });
  });

  test("includes alwaysAllow from adapter extras", async () => {
    dir = await createTestDir("am-cline-export-");
    const cfg = config({
      servers: {
        svc: server({
          name: "svc",
          command: "node",
          args: ["server.js"],
          adapters: { cline: { alwaysAllow: ["tool1", "tool2"] } },
        }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    const settingsFile = result.files.find((f) => f.path.endsWith("cline_mcp_settings.json"));
    const parsed = JSON.parse(settingsFile?.content) as Record<string, unknown>;
    const mcpServers = parsed.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcpServers.svc.alwaysAllow).toEqual(["tool1", "tool2"]);
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-cline-export-");
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
    const settingsFile = result.files.find((f) => f.path.endsWith("cline_mcp_settings.json"));
    const parsed = JSON.parse(settingsFile?.content) as Record<string, unknown>;
    const mcpServers = parsed.mcpServers as Record<string, unknown>;
    expect(mcpServers.enabled).toBeDefined();
    expect(mcpServers.disabled).toBeUndefined();
  });

  test("generates .clinerules/*.md from instructions", async () => {
    dir = await createTestDir("am-cline-export-");
    const projectDir = join(dir.path, "project");
    const cfg = config({
      instructions: {
        "ts-rules": {
          name: "ts-rules",
          content: "Use strict TypeScript.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["cline"],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const ruleFile = result.files.find((f) => f.path.endsWith("ts-rules.md"));
    expect(ruleFile).toBeDefined();
    expect(ruleFile?.content).toContain("Use strict TypeScript.");
    expect(ruleFile?.path).toContain(".clinerules");
  });

  test("skips instructions not targeted at cline", async () => {
    dir = await createTestDir("am-cline-export-");
    const projectDir = join(dir.path, "project");
    const cfg = config({
      instructions: {
        "cline-rule": {
          name: "cline-rule",
          content: "For Cline.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["cline"],
          adapters: {},
        },
        "cursor-rule": {
          name: "cursor-rule",
          content: "For Cursor only.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["cursor"],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const ruleFiles = result.files.filter((f) => f.path.includes(".clinerules"));
    expect(ruleFiles).toHaveLength(1);
    expect(ruleFiles[0].path).toContain("cline-rule");
  });

  test("includes untargeted instructions", async () => {
    dir = await createTestDir("am-cline-export-");
    const projectDir = join(dir.path, "project");
    const cfg = config({
      instructions: {
        "global-rule": {
          name: "global-rule",
          content: "For all tools.",
          scope: "always",
          globs: [],
          description: "",
          targets: [],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const ruleFiles = result.files.filter((f) => f.path.includes(".clinerules"));
    expect(ruleFiles).toHaveLength(1);
  });

  test("dry run doesn't write files", async () => {
    dir = await createTestDir("am-cline-export-");
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

  test("actual write creates files on disk", async () => {
    dir = await createTestDir("am-cline-export-");
    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = exportConfig(cfg, {}, dir.path);
    const settingsFile = result.files.find((f) => f.path.endsWith("cline_mcp_settings.json"));
    expect(settingsFile?.written).toBe(true);
    expect(await dir.exists(SETTINGS_REL)).toBe(true);
    const content = JSON.parse(await dir.read(SETTINGS_REL));
    expect(content.mcpServers.fetch.command).toBe("uvx");
  });

  test("preserves existing non-MCP fields", async () => {
    dir = await createTestDir("am-cline-export-");
    await dir.write(
      SETTINGS_REL,
      JSON.stringify({
        customField: "preserved",
        mcpServers: { old: { command: "old-mcp" } },
      }),
    );

    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = exportConfig(cfg, {}, dir.path);
    const settingsFile = result.files.find((f) => f.path.endsWith("cline_mcp_settings.json"));
    const parsed = JSON.parse(settingsFile?.content) as Record<string, unknown>;
    expect(parsed.customField).toBe("preserved");
    // Old MCP replaced
    const mcpServers = parsed.mcpServers as Record<string, unknown>;
    expect(mcpServers.old).toBeUndefined();
    expect(mcpServers.fetch).toBeDefined();
  });
});
