import { afterEach, describe, expect, test } from "bun:test";
import { exportConfig } from "@/adapters/codex-cli/export.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { parse as parseTOML } from "@iarna/toml";
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

describe("codex-cli exportConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("generates config.toml with mcp_servers", async () => {
    dir = await createTestDir("am-codex-export-");
    const cfg = config({
      servers: {
        context7: server({
          name: "context7",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          env: { API_KEY: "test-key" },
        }),
      },
    });

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    expect(result.files.length).toBeGreaterThanOrEqual(1);

    const globalFile = result.files.find((f) => f.path.endsWith("config.toml"));
    expect(globalFile).toBeDefined();

    const parsed = parseTOML(globalFile?.content) as any;
    expect(parsed.mcp_servers.context7.command).toBe("npx");
    expect(parsed.mcp_servers.context7.args).toEqual(["-y", "@upstash/context7-mcp"]);
    expect(parsed.mcp_servers.context7.env.API_KEY).toBe("test-key");
  });

  test("generates HTTP server with url field", async () => {
    dir = await createTestDir("am-codex-export-");
    const cfg = config({
      servers: {
        figma: server({
          name: "figma",
          command: "https://mcp.figma.com/mcp",
          transport: "streamable-http",
          adapters: {
            "codex-cli": {
              bearer_token_env_var: "FIGMA_TOKEN",
              http_headers: { "X-Region": "us-east-1" },
            },
          },
        }),
      },
    });

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    const globalFile = result.files.find((f) => f.path.endsWith("config.toml"));
    const parsed = parseTOML(globalFile?.content) as any;
    expect(parsed.mcp_servers.figma.url).toBe("https://mcp.figma.com/mcp");
    expect(parsed.mcp_servers.figma.command).toBeUndefined();
    expect(parsed.mcp_servers.figma.bearer_token_env_var).toBe("FIGMA_TOKEN");
    expect(parsed.mcp_servers.figma.http_headers["X-Region"]).toBe("us-east-1");
  });

  test("writes adapter-specific fields (enabled_tools, timeouts)", async () => {
    dir = await createTestDir("am-codex-export-");
    const cfg = config({
      servers: {
        context7: server({
          name: "context7",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          adapters: {
            "codex-cli": {
              enabled_tools: ["search", "summarize"],
              startup_timeout_sec: 15,
              tool_timeout_sec: 120,
            },
          },
        }),
      },
    });

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    const globalFile = result.files.find((f) => f.path.endsWith("config.toml"));
    const parsed = parseTOML(globalFile?.content) as any;
    expect(parsed.mcp_servers.context7.enabled_tools).toEqual(["search", "summarize"]);
    expect(parsed.mcp_servers.context7.startup_timeout_sec).toBe(15);
    expect(parsed.mcp_servers.context7.tool_timeout_sec).toBe(120);
  });

  test("generates AGENTS.md with am markers", async () => {
    dir = await createTestDir("am-codex-export-");
    const projectDir = `${dir.path}/project`;
    const cfg = config({
      instructions: {
        "ts-rules": {
          name: "ts-rules",
          content: "Use strict TypeScript.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["codex-cli"],
          adapters: {},
        },
      },
    });

    const result = await exportConfig(cfg, { projectPath: projectDir, dryRun: true }, dir.path);
    const agentsMdFile = result.files.find((f) => f.path.endsWith("AGENTS.md"));
    expect(agentsMdFile).toBeDefined();
    expect(agentsMdFile?.content).toContain("<!-- am:begin -->");
    expect(agentsMdFile?.content).toContain("Use strict TypeScript.");
    expect(agentsMdFile?.content).toContain("<!-- am:end -->");
  });

  test("dry run doesn't write files", async () => {
    dir = await createTestDir("am-codex-export-");
    const cfg = config({
      servers: {
        ctx: server({ name: "ctx", command: "npx", args: ["-y", "context7-mcp"] }),
      },
    });

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    for (const file of result.files) {
      expect(file.written).toBe(false);
    }
    expect(await dir.exists(".codex/config.toml")).toBe(false);
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-codex-export-");
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
    const globalFile = result.files.find((f) => f.path.endsWith("config.toml"));
    const parsed = parseTOML(globalFile?.content) as any;
    expect(parsed.mcp_servers.enabled_one).toBeDefined();
    expect(parsed.mcp_servers.disabled_one).toBeUndefined();
  });

  test("preserves existing config.toml fields", async () => {
    dir = await createTestDir("am-codex-export-");
    await dir.write(
      ".codex/config.toml",
      `model = "gpt-5.4"
model_provider = "openai"
approval_policy = "on-request"

[mcp_servers.old]
command = "old-mcp"
`,
    );

    const cfg = config({
      servers: {
        ctx: server({ name: "ctx", command: "npx", args: ["-y", "context7-mcp"] }),
      },
    });

    const result = await exportConfig(cfg, {}, dir.path);
    const globalFile = result.files.find((f) => f.path.endsWith("config.toml"));
    const parsed = parseTOML(globalFile?.content) as any;
    // Non-MCP fields preserved
    expect(parsed.model).toBe("gpt-5.4");
    expect(parsed.model_provider).toBe("openai");
    expect(parsed.approval_policy).toBe("on-request");
    // Old mcp_servers replaced
    expect(parsed.mcp_servers.old).toBeUndefined();
    expect(parsed.mcp_servers.ctx).toBeDefined();
  });

  test("actual write creates files on disk", async () => {
    dir = await createTestDir("am-codex-export-");
    const cfg = config({
      servers: {
        ctx: server({ name: "ctx", command: "npx", args: ["-y", "context7-mcp"] }),
      },
    });

    const result = await exportConfig(cfg, {}, dir.path);
    const globalFile = result.files.find((f) => f.path.endsWith("config.toml"));
    expect(globalFile?.written).toBe(true);
    expect(await dir.exists(".codex/config.toml")).toBe(true);
    const content = await dir.read(".codex/config.toml");
    const parsed = parseTOML(content) as any;
    expect(parsed.mcp_servers.ctx.command).toBe("npx");
  });
});
