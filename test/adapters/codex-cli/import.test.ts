import { afterEach, describe, expect, test } from "bun:test";
import { importConfig } from "@/adapters/codex-cli/import.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("codex-cli importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports stdio servers from ~/.codex/config.toml", async () => {
    dir = await createTestDir("am-codex-import-");
    await dir.write(
      ".codex/config.toml",
      `
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env = { API_KEY = "test-key" }
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled_tools = ["search", "summarize"]
`,
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("context7");
    expect(result.servers[0].command).toBe("npx");
    expect(result.servers[0].args).toEqual(["-y", "@upstash/context7-mcp"]);
    expect(result.servers[0].env).toEqual({ API_KEY: "test-key" });
    expect(result.servers[0].scope).toBe("global");
    expect(result.servers[0].transport).toBe("stdio");
    expect(result.servers[0].enabled).toBe(true);
  });

  test("imports HTTP servers from TOML", async () => {
    dir = await createTestDir("am-codex-import-");
    await dir.write(
      ".codex/config.toml",
      `
[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
http_headers = { "X-Region" = "us-east-1" }
enabled = true
required = true
`,
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("figma");
    expect(result.servers[0].command).toBe("https://mcp.figma.com/mcp");
    expect(result.servers[0].transport).toBe("streamable-http");
    expect(result.servers[0].adapterExtras).toBeDefined();
    expect(result.servers[0].adapterExtras?.bearer_token_env_var).toBe("FIGMA_OAUTH_TOKEN");
    expect(result.servers[0].adapterExtras?.http_headers).toEqual({ "X-Region": "us-east-1" });
    expect(result.servers[0].adapterExtras?.required).toBe(true);
  });

  test("imports project-scoped servers from .codex/config.toml", async () => {
    dir = await createTestDir("am-codex-import-");
    await dir.write(".codex/config.toml", "[mcp_servers]\n");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.codex/config.toml",
      `
[mcp_servers.local-tool]
command = "my-local-mcp"
args = ["--port", "3000"]
`,
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    const projectServer = result.servers.find((s) => s.name === "local-tool");
    expect(projectServer).toBeDefined();
    expect(projectServer?.scope).toBe("project");
    expect(projectServer?.command).toBe("my-local-mcp");
  });

  test("preserves Codex-specific fields in adapterExtras", async () => {
    dir = await createTestDir("am-codex-import-");
    await dir.write(
      ".codex/config.toml",
      `
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
enabled_tools = ["search", "summarize"]
disabled_tools = ["slow-tool"]
startup_timeout_sec = 10
tool_timeout_sec = 60
required = false
scopes = ["read:docs"]
env_vars = ["ANOTHER_SECRET"]
cwd = "/tmp/server"
`,
    );

    const result = importConfig({}, dir.path);
    const extras = result.servers[0].adapterExtras!;
    expect(extras.enabled_tools).toEqual(["search", "summarize"]);
    expect(extras.disabled_tools).toEqual(["slow-tool"]);
    expect(extras.startup_timeout_sec).toBe(10);
    expect(extras.tool_timeout_sec).toBe(60);
    expect(extras.required).toBe(false);
    expect(extras.scopes).toEqual(["read:docs"]);
    expect(extras.env_vars).toEqual(["ANOTHER_SECRET"]);
    expect(extras.cwd).toBe("/tmp/server");
  });

  test("marks disabled servers", async () => {
    dir = await createTestDir("am-codex-import-");
    await dir.write(
      ".codex/config.toml",
      `
[mcp_servers.disabled-server]
command = "some-mcp"
enabled = false
`,
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].enabled).toBe(false);
  });

  test("imports AGENTS.md as instruction", async () => {
    dir = await createTestDir("am-codex-import-");
    await dir.write(".codex/config.toml", "");
    await dir.write(".codex/AGENTS.md", "# Global Instructions\n\nBe helpful.");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/AGENTS.md", "# Project Instructions\n\nUse strict mode.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(2);
    expect(result.instructions[0].name).toBe("agents-md-global");
    expect(result.instructions[0].content).toContain("Global Instructions");
    expect(result.instructions[1].name).toBe("agents-md");
    expect(result.instructions[1].content).toContain("Use strict mode");
  });

  test("handles missing file gracefully", async () => {
    dir = await createTestDir("am-codex-import-");
    // No .codex/config.toml at all
    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("File not found");
  });

  test("handles malformed TOML gracefully", async () => {
    dir = await createTestDir("am-codex-import-");
    await dir.write(".codex/config.toml", "[[[ not valid toml !!!");

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed TOML"))).toBe(true);
  });

  test("imports multiple servers from same file", async () => {
    dir = await createTestDir("am-codex-import-");
    await dir.write(
      ".codex/config.toml",
      `
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_TOKEN"

[mcp_servers.local]
command = "my-mcp"
`,
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(3);
    const names = result.servers.map((s) => s.name).sort();
    expect(names).toEqual(["context7", "figma", "local"]);
  });
});
