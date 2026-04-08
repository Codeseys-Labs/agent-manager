import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { createTestDir, type TestDir } from "../helpers/tmp";
import { writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import { McpServer } from "../../src/mcp/server";
import type { Config } from "../../src/core/schema";

describe("MCP server", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.AM_CONFIG_DIR;
    }
    if (dir) await dir.cleanup();
  });

  async function setupConfig(config: Config): Promise<string> {
    dir = await createTestDir("am-mcp-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), config);
    return configDir;
  }

  test("initialize returns server info", async () => {
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(resp).not.toBeNull();
    expect(resp!.result).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "agent-manager", version: "0.1.0" },
    });
  });

  test("tools/list returns all tools", async () => {
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(resp).not.toBeNull();
    const tools = (resp!.result as any).tools;
    expect(Array.isArray(tools)).toBe(true);

    const names = tools.map((t: any) => t.name);
    expect(names).toContain("am_list_servers");
    expect(names).toContain("am_list_profiles");
    expect(names).toContain("am_status");
    expect(names).toContain("am_config_show");
    expect(names).toContain("am_add_server");
    expect(names).toContain("am_remove_server");
    expect(names).toContain("am_use_profile");
    expect(names).toContain("am_import");
    expect(names).toContain("am_apply");
    expect(names).toContain("am_sync_push");
    expect(names).toContain("am_sync_pull");
    expect(names.length).toBe(11);
  });

  test("am_list_servers returns servers from config", async () => {
    await setupConfig({
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], tags: ["utility"], transport: "stdio", enabled: true },
        tavily: { command: "bunx", args: ["tavily-mcp@latest"], tags: ["search"], transport: "stdio", enabled: true },
        disabled: { command: "noop", transport: "stdio", enabled: false },
      },
    });

    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "am_list_servers", arguments: {} },
    });

    expect(resp).not.toBeNull();
    const content = JSON.parse((resp!.result as any).content[0].text);
    expect(content.servers.length).toBe(3);

    const names = content.servers.map((s: any) => s.name);
    expect(names).toContain("fetch");
    expect(names).toContain("tavily");
    expect(names).toContain("disabled");
  });

  test("am_list_servers with active filter", async () => {
    await setupConfig({
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
        disabled: { command: "noop", transport: "stdio", enabled: false },
      },
    });

    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "am_list_servers", arguments: { active: true } },
    });

    const content = JSON.parse((resp!.result as any).content[0].text);
    expect(content.servers.length).toBe(1);
    expect(content.servers[0].name).toBe("fetch");
  });

  test("am_status returns structured result", async () => {
    await setupConfig({
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
      },
    });

    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "am_status", arguments: {} },
    });

    const content = JSON.parse((resp!.result as any).content[0].text);
    expect(content.profile).toBe("default");
    expect(content.servers).toBe(1);
    expect(content.git).toBeDefined();
    expect(content.git.branch).toBeDefined();
    expect(typeof content.git.clean).toBe("boolean");
    expect(Array.isArray(content.tools)).toBe(true);
  });

  test("am_config_show returns config", async () => {
    await setupConfig({
      settings: { default_profile: "dev" },
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
      },
    });

    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "am_config_show", arguments: {} },
    });

    const content = JSON.parse((resp!.result as any).content[0].text);
    expect(content.config).toBeDefined();
    expect(content.config.servers).toBeDefined();
    expect(content.config.servers.fetch).toBeDefined();
  });

  test("am_add_server adds a server", async () => {
    await setupConfig({ servers: {} });

    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "am_add_server",
        arguments: {
          name: "tavily",
          command: "bunx",
          args: ["tavily-mcp@latest"],
          tags: ["search"],
        },
      },
    });

    const content = JSON.parse((resp!.result as any).content[0].text);
    expect(content.action).toBe("add");
    expect(content.server).toBe("tavily");

    // Verify it's in the config now
    const listResp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "am_list_servers", arguments: {} },
    });
    const listContent = JSON.parse((listResp!.result as any).content[0].text);
    expect(listContent.servers.some((s: any) => s.name === "tavily")).toBe(true);
  });

  test("am_remove_server removes a server", async () => {
    await setupConfig({
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
        tavily: { command: "bunx", args: ["tavily-mcp@latest"], transport: "stdio", enabled: true },
      },
    });

    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "am_remove_server", arguments: { name: "tavily" } },
    });

    const content = JSON.parse((resp!.result as any).content[0].text);
    expect(content.action).toBe("remove");
    expect(content.server).toBe("tavily");
  });

  test("write-remote tools rejected without opt-in", async () => {
    await setupConfig({
      settings: { default_profile: "default" },
      servers: {},
    });

    const server = new McpServer();
    // Set settings explicitly without mcp_serve permissions
    server.setSettings({});

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "am_apply", arguments: {} },
    });

    expect(resp).not.toBeNull();
    const result = resp!.result as any;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("opt-in");
  });

  test("write-remote tools allowed with opt-in", async () => {
    await setupConfig({
      settings: {
        default_profile: "default",
        mcp_serve: { allow_apply: true },
      },
      servers: {},
    });

    const server = new McpServer();
    server.setSettings({ mcp_serve: { allow_apply: true } });

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "am_apply", arguments: { dryRun: true } },
    });

    expect(resp).not.toBeNull();
    const result = resp!.result as any;
    // Should not be an error — it may find no adapters, but permission passes
    if (result.isError) {
      const content = JSON.parse(result.content[0].text);
      expect(content.error).not.toContain("opt-in");
    } else {
      const content = JSON.parse(result.content[0].text);
      expect(content.action).toBe("apply");
    }
  });

  test("am_sync_push rejected without opt-in", async () => {
    await setupConfig({
      settings: { default_profile: "default" },
      servers: {},
    });

    const server = new McpServer();
    server.setSettings({});

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "am_sync_push", arguments: {} },
    });

    expect(resp).not.toBeNull();
    const result = resp!.result as any;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("opt-in");
  });

  test("unknown tool returns error", async () => {
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    });

    expect(resp).not.toBeNull();
    expect(resp!.error).toBeDefined();
    expect(resp!.error!.code).toBe(-32601);
    expect(resp!.error!.message).toContain("Unknown tool");
  });

  test("unknown method returns error", async () => {
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 14,
      method: "nonexistent/method",
    });

    expect(resp).not.toBeNull();
    expect(resp!.error).toBeDefined();
    expect(resp!.error!.code).toBe(-32601);
  });

  test("notification (no id) returns null", async () => {
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(resp).toBeNull();
  });
});
