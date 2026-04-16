import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import type { Session, SessionReader, SessionSummary } from "../../src/core/session";
import { McpServer } from "../../src/mcp/server";
import { type TestDir, createTestDir } from "../helpers/tmp";

type JsonRpcResult = Record<string, any>;

describe("MCP server", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      process.env.AM_CONFIG_DIR = undefined;
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
    expect(resp?.result).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "agent-manager", version: "0.1.0" },
    });
  });

  test("tools/list returns only core tools by default (ADR-0021)", async () => {
    await setupConfig({});
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(resp).not.toBeNull();
    const tools = (resp?.result as JsonRpcResult).tools;
    expect(Array.isArray(tools)).toBe(true);

    const names = tools.map((t: { name: string }) => t.name);
    // Core tools should be present
    expect(names).toContain("am_list_servers");
    expect(names).toContain("am_list_profiles");
    expect(names).toContain("am_status");
    expect(names).toContain("am_config_show");
    expect(names).toContain("am_doctor");
    expect(names).toContain("am_add_server");
    expect(names).toContain("am_remove_server");
    expect(names).toContain("am_server_update");
    expect(names).toContain("am_undo");
    expect(names).toContain("am_use_profile");
    expect(names).toContain("am_import");
    expect(names).toContain("am_apply");
    expect(names).toContain("am_sync_push");
    expect(names).toContain("am_sync_pull");
    expect(names.length).toBe(14);
    // Session tools are in their own group now (ADR-0021), not core
    expect(names).not.toContain("am_session_list");
    expect(names).not.toContain("am_session_export");
    expect(names).not.toContain("am_session_search");
    // Non-core tools should NOT be present by default
    expect(names).not.toContain("am_registry_search");
    expect(names).not.toContain("am_wiki_search");
    expect(names).not.toContain("am_agent_discover");
  });

  test("tools/list returns all groups when configured (ADR-0021)", async () => {
    await setupConfig({
      settings: {
        mcp_serve: { tools: ["core", "registry", "a2a", "wiki", "session"] },
      },
    });
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(resp).not.toBeNull();
    const tools = (resp?.result as JsonRpcResult).tools;
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("am_list_servers");
    expect(names).toContain("am_registry_search");
    expect(names).toContain("am_registry_install");
    expect(names).toContain("am_registry_list_installed");
    // Wiki tools (ADR-0020)
    expect(names).toContain("am_wiki_search");
    expect(names).toContain("am_wiki_add");
    expect(names).toContain("am_wiki_synthesize");
    expect(names).toContain("am_wiki_briefing");
    expect(names).toContain("am_wiki_harvest");
    // A2A agent tools (ADR-0017)
    expect(names).toContain("am_agent_discover");
    expect(names).toContain("am_agent_list");
    expect(names).toContain("am_agent_delegate");
    expect(names).toContain("am_agent_task_status");
    // Session tools (ADR-0021 — own group)
    expect(names).toContain("am_session_list");
    expect(names).toContain("am_session_export");
    expect(names).toContain("am_session_search");
    expect(names.length).toBe(29);
  });

  test("tools/list respects selective group configuration (ADR-0021)", async () => {
    await setupConfig({
      settings: {
        mcp_serve: { tools: ["core", "wiki"] },
      },
    });
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(resp).not.toBeNull();
    const tools = (resp?.result as JsonRpcResult).tools;
    const names = tools.map((t: { name: string }) => t.name);
    // Core + wiki = 14 + 5 = 19
    expect(names.length).toBe(19);
    expect(names).toContain("am_list_servers");
    expect(names).toContain("am_wiki_search");
    expect(names).not.toContain("am_registry_search");
    expect(names).not.toContain("am_agent_discover");
  });

  test("am_list_servers returns servers from config", async () => {
    await setupConfig({
      servers: {
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          tags: ["utility"],
          transport: "stdio",
          enabled: true,
        },
        tavily: {
          command: "bunx",
          args: ["tavily-mcp@latest"],
          tags: ["search"],
          transport: "stdio",
          enabled: true,
        },
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
    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
    expect(content.servers.length).toBe(3);

    const names = content.servers.map((s: { name: string }) => s.name);
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

    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
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

    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
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

    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
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

    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
    expect(content.action).toBe("add");
    expect(content.server).toBe("tavily");

    // Verify it's in the config now
    const listResp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "am_list_servers", arguments: {} },
    });
    const listContent = JSON.parse((listResp?.result as JsonRpcResult).content[0].text);
    expect(listContent.servers.some((s: { name: string }) => s.name === "tavily")).toBe(true);
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

    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
    expect(content.action).toBe("remove");
    expect(content.server).toBe("tavily");
  });

  test("am_server_update updates server properties", async () => {
    await setupConfig({
      servers: {
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          tags: ["utility"],
          transport: "stdio",
          enabled: true,
          description: "old description",
        },
      },
    });

    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "am_server_update",
        arguments: {
          name: "fetch",
          enabled: false,
          tags: ["utility", "web"],
          description: "new description",
        },
      },
    });

    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
    expect(content.action).toBe("update");
    expect(content.server).toBe("fetch");

    // Verify the updates persisted
    const listResp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "am_list_servers", arguments: {} },
    });
    const listContent = JSON.parse((listResp?.result as JsonRpcResult).content[0].text);
    const updated = listContent.servers.find((s: { name: string }) => s.name === "fetch");
    expect(updated.enabled).toBe(false);
    expect(updated.tags).toEqual(["utility", "web"]);
    expect(updated.description).toBe("new description");
  });

  test("am_server_update merges env vars", async () => {
    await setupConfig({
      servers: {
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          env: { API_KEY: "existing" },
          transport: "stdio",
          enabled: true,
        },
      },
    });

    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: {
        name: "am_server_update",
        arguments: {
          name: "fetch",
          env: { NEW_VAR: "new-value" },
        },
      },
    });

    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
    expect(content.action).toBe("update");

    // Verify env was merged (not replaced)
    const showResp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 43,
      method: "tools/call",
      params: { name: "am_config_show", arguments: {} },
    });
    const showContent = JSON.parse((showResp?.result as JsonRpcResult).content[0].text);
    const serverEnv = showContent.config.servers.fetch.env;
    expect(serverEnv.API_KEY).toBe("existing");
    expect(serverEnv.NEW_VAR).toBe("new-value");
  });

  test("am_server_update errors on nonexistent server", async () => {
    await setupConfig({ servers: {} });

    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 44,
      method: "tools/call",
      params: {
        name: "am_server_update",
        arguments: { name: "nonexistent", enabled: false },
      },
    });

    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("not found");
  });

  test("am_server_update replaces args", async () => {
    await setupConfig({
      servers: {
        fetch: {
          command: "uvx",
          args: ["old-arg"],
          transport: "stdio",
          enabled: true,
        },
      },
    });

    const server = new McpServer();
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 45,
      method: "tools/call",
      params: {
        name: "am_server_update",
        arguments: {
          name: "fetch",
          args: ["new-arg-1", "new-arg-2"],
        },
      },
    });

    const showResp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 46,
      method: "tools/call",
      params: { name: "am_config_show", arguments: {} },
    });
    const showContent = JSON.parse((showResp?.result as JsonRpcResult).content[0].text);
    expect(showContent.config.servers.fetch.args).toEqual(["new-arg-1", "new-arg-2"]);
  });

  test("am_doctor returns health check results", async () => {
    await setupConfig({
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
      },
    });

    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: { name: "am_doctor", arguments: {} },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(typeof content.healthy).toBe("boolean");
    expect(Array.isArray(content.checks)).toBe(true);
    expect(content.checks.length).toBeGreaterThan(0);

    // Every check has the expected shape
    for (const check of content.checks) {
      expect(typeof check.name).toBe("string");
      expect(["ok", "warn", "fail"]).toContain(check.status);
      expect(typeof check.message).toBe("string");
    }

    // Config dir and git should be ok since setupConfig inits a repo
    const configDirCheck = content.checks.find(
      (c: { name: string }) => c.name === "Config directory",
    );
    expect(configDirCheck?.status).toBe("ok");

    const gitCheck = content.checks.find((c: { name: string }) => c.name === "Git repository");
    expect(gitCheck?.status).toBe("ok");

    const configCheck = content.checks.find((c: { name: string }) => c.name === "config.toml");
    expect(configCheck?.status).toBe("ok");
  });

  test("am_doctor is read-only (no opt-in needed)", async () => {
    await setupConfig({});
    const server = new McpServer();
    server.setSettings({});

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: { name: "am_doctor", arguments: {} },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    // Should never be a permission error
    if (result.isError) {
      const content = JSON.parse(result.content[0].text);
      expect(content.error).not.toContain("opt-in");
    }
  });

  test("am_undo reverts the last config change", async () => {
    await setupConfig({ servers: {} });

    const server = new McpServer();

    // Add a server to create a commit we can undo
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 52,
      method: "tools/call",
      params: {
        name: "am_add_server",
        arguments: { name: "temp-server", command: "echo" },
      },
    });

    // Verify it exists
    let listResp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 53,
      method: "tools/call",
      params: { name: "am_list_servers", arguments: {} },
    });
    let listContent = JSON.parse((listResp?.result as JsonRpcResult).content[0].text);
    expect(listContent.servers.some((s: { name: string }) => s.name === "temp-server")).toBe(true);

    // Undo
    const undoResp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 54,
      method: "tools/call",
      params: { name: "am_undo", arguments: {} },
    });

    const undoContent = JSON.parse((undoResp?.result as JsonRpcResult).content[0].text);
    expect(undoContent.action).toBe("undo");
    expect(undoContent.reverted).toContain("add server: temp-server");
    expect(typeof undoContent.oid).toBe("string");

    // Verify the server is gone after undo
    listResp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 55,
      method: "tools/call",
      params: { name: "am_list_servers", arguments: {} },
    });
    listContent = JSON.parse((listResp?.result as JsonRpcResult).content[0].text);
    expect(listContent.servers.some((s: { name: string }) => s.name === "temp-server")).toBe(false);
  });

  test("am_undo errors when nothing to undo", async () => {
    // setupConfig creates a repo with only the initial commit
    await setupConfig({});

    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 56,
      method: "tools/call",
      params: { name: "am_undo", arguments: {} },
    });

    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("Nothing to undo");
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
      params: { name: "am_sync_push", arguments: {} },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("opt-in");
  });

  test("am_apply is write-local (no opt-in required)", async () => {
    await setupConfig({
      settings: { default_profile: "default" },
      servers: {},
    });

    const server = new McpServer();
    server.setSettings({});

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "am_apply", arguments: { dryRun: true } },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    // Should not be a permission error — am_apply is write-local
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
    const result = resp?.result as JsonRpcResult;
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
    expect(resp?.error).toBeDefined();
    expect(resp?.error?.code).toBe(-32601);
    expect(resp?.error?.message).toContain("Unknown tool");
  });

  test("unknown method returns error", async () => {
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 14,
      method: "nonexistent/method",
    });

    expect(resp).not.toBeNull();
    expect(resp?.error).toBeDefined();
    expect(resp?.error?.code).toBe(-32601);
  });

  test("notification (no id) returns null", async () => {
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(resp).toBeNull();
  });

  // ── Session tool tests ─────────────────────────────────────
  // Use gemini-cli adapter filter — it has no sessionReader, so lookups are fast.
  // For session reader tests, use claude-code with specific session IDs.

  test("am_session_list with adapter filter returns array", async () => {
    const server = new McpServer();
    // gemini-cli has no sessionReader, so this returns empty quickly
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "am_session_list", arguments: { adapter: "gemini-cli" } },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(Array.isArray(content.sessions)).toBe(true);
    expect(typeof content.total).toBe("number");
    expect(content.total).toBe(0); // gemini-cli has no session reader
  });

  test("am_session_list with adapter that has no sessions returns empty", async () => {
    const server = new McpServer();
    // windsurf has no sessionReader, returns empty fast
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "am_session_list", arguments: { adapter: "windsurf" } },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(Array.isArray(content.sessions)).toBe(true);
    expect(content.total).toBe(0);
  });

  test("am_session_export errors on adapter without session reading", async () => {
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "am_session_export",
        arguments: { id: "nonexistent", adapter: "gemini-cli" },
      },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("does not support session reading");
  });

  test("am_session_export errors on missing session", async () => {
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: {
        name: "am_session_export",
        arguments: { id: "nonexistent-session-id", adapter: "claude-code" },
      },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("not found");
  });

  test("am_session_export errors on nonexistent adapter", async () => {
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: {
        name: "am_session_export",
        arguments: { id: "test", adapter: "nonexistent-adapter" },
      },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
  });

  test("am_session_search with adapter filter returns results structure", async () => {
    const server = new McpServer();
    // Use gemini-cli — no session reader, returns empty quickly
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 25,
      method: "tools/call",
      params: {
        name: "am_session_search",
        arguments: { query: "test", adapter: "gemini-cli" },
      },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(content.query).toBe("test");
    expect(Array.isArray(content.results)).toBe(true);
    expect(typeof content.total).toBe("number");
  });

  test("am_session_search with role filter", async () => {
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 26,
      method: "tools/call",
      params: {
        name: "am_session_search",
        arguments: { query: "test", adapter: "gemini-cli", role: "user" },
      },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
  });

  test("session tools are read-only tier (no opt-in needed)", async () => {
    const server = new McpServer();
    // Explicitly set empty settings (no permissions)
    server.setSettings({});

    // am_session_list should work without opt-in (use adapter filter for speed)
    const listResp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "am_session_list", arguments: { adapter: "gemini-cli" } },
    });
    expect(listResp).not.toBeNull();
    const listResult = listResp?.result as JsonRpcResult;
    if (listResult.isError) {
      const content = JSON.parse(listResult.content[0].text);
      expect(content.error).not.toContain("opt-in");
    }

    // am_session_search should work without opt-in
    const searchResp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "am_session_search", arguments: { query: "test", adapter: "gemini-cli" } },
    });
    expect(searchResp).not.toBeNull();
    const searchResult = searchResp?.result as JsonRpcResult;
    if (searchResult.isError) {
      const content = JSON.parse(searchResult.content[0].text);
      expect(content.error).not.toContain("opt-in");
    }
  });
});

// ── Session tools with mocked session data ──────────────────────
// These tests exercise session tool handlers with actual session data
// by directly testing the core session functions used by the MCP handlers,
// since mocking the adapter registry module at the MCP server level is fragile.

describe("MCP session tools — core function integration", () => {
  // Import the same core functions the MCP session tool handlers use
  const {
    filterMessages,
    formatMarkdown,
    formatJson,
  }: typeof import("../../src/core/session") = require("../../src/core/session");

  const testSession: Session = {
    id: "test-session-001",
    adapter: "mock-adapter",
    project: "/home/user/myproject",
    messages: [
      {
        role: "system",
        content: "You are a helpful assistant.",
        timestamp: new Date("2024-01-15T10:00:00Z"),
      },
      {
        role: "user",
        content: "Help me fix the authentication bug in the login handler",
        timestamp: new Date("2024-01-15T10:01:00Z"),
      },
      {
        role: "assistant",
        content: "I'll look at the login handler. Let me check the auth middleware first.",
        timestamp: new Date("2024-01-15T10:01:30Z"),
        toolCalls: [
          {
            name: "read_file",
            input: { path: "src/auth.ts" },
            output: "export function authenticate() { ... }",
          },
        ],
      },
      {
        role: "tool",
        content: "File contents: export function authenticate() { ... }",
        timestamp: new Date("2024-01-15T10:01:31Z"),
      },
      {
        role: "assistant",
        content:
          "I found the issue. The token validation is missing the expiry check. Here's the fix that properly validates JWT expiration timestamps before granting access to protected routes. This is a very long message that exceeds two hundred characters to test snippet truncation behavior in the search results output.",
        timestamp: new Date("2024-01-15T10:02:00Z"),
      },
    ],
    startedAt: new Date("2024-01-15T10:00:00Z"),
    endedAt: new Date("2024-01-15T10:05:00Z"),
    metadata: { model: "claude-3" },
  };

  const testSummaries: SessionSummary[] = [
    {
      id: "session-b",
      adapter: "mock-adapter",
      project: "/project-b",
      messageCount: 3,
      startedAt: new Date("2024-01-14T10:00:00Z"),
    },
    {
      id: "session-a",
      adapter: "mock-adapter",
      project: "/project-a",
      messageCount: 5,
      startedAt: new Date("2024-01-15T10:00:00Z"),
      endedAt: new Date("2024-01-15T10:05:00Z"),
      estimatedTokens: 1200,
    },
  ];

  test("session list sorts by date descending", () => {
    // Replicate the sort logic from the MCP handler
    const sorted = [...testSummaries].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    expect(sorted[0].id).toBe("session-a"); // most recent
    expect(sorted[1].id).toBe("session-b");

    // Verify serialization matches MCP output format
    const serialized = sorted.map((s) => ({
      ...s,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
    }));
    expect(serialized[0].startedAt).toBe("2024-01-15T10:00:00.000Z");
    expect(serialized[0].endedAt).toBe("2024-01-15T10:05:00.000Z");
    expect(serialized[1].endedAt).toBeNull();
  });

  test("session export as markdown contains header and messages", () => {
    const md = formatMarkdown(testSession);
    expect(md).toContain("# Session test-session-001");
    expect(md).toContain("**Adapter:** mock-adapter");
    expect(md).toContain("**Project:** /home/user/myproject");
    expect(md).toContain("### User");
    expect(md).toContain("### Assistant");
    expect(md).toContain("authentication bug");
    expect(md).toContain("**Tool:** `read_file`");
  });

  test("session export as JSON has correct structure", () => {
    const json = formatJson(testSession) as any;
    expect(json.id).toBe("test-session-001");
    expect(json.adapter).toBe("mock-adapter");
    expect(json.project).toBe("/home/user/myproject");
    expect(json.startedAt).toBe("2024-01-15T10:00:00.000Z");
    expect(json.endedAt).toBe("2024-01-15T10:05:00.000Z");
    expect(json.messageCount).toBe(5);
    expect(json.messages.length).toBe(5);
    expect(json.messages[0].role).toBe("system");
    expect(json.metadata).toEqual({ model: "claude-3" });
  });

  test("session export with role filter (user only)", () => {
    const json = formatJson(testSession, { roles: ["user"] }) as any;
    expect(json.messageCount).toBe(1);
    expect(json.messages[0].role).toBe("user");
    expect(json.messages[0].content).toContain("authentication bug");
  });

  test("session export with noTools filter", () => {
    const json = formatJson(testSession, { noTools: true }) as any;
    expect(json.messages.every((m: any) => m.role !== "tool")).toBe(true);
    expect(json.messageCount).toBe(4); // system + user + 2 assistant
  });

  test("session export with noSystem filter", () => {
    const json = formatJson(testSession, { noSystem: true }) as any;
    expect(json.messages.every((m: any) => m.role !== "system")).toBe(true);
    expect(json.messageCount).toBe(4); // user + assistant + tool + assistant
  });

  test("session export with combined noTools + noSystem", () => {
    const json = formatJson(testSession, { noTools: true, noSystem: true }) as any;
    expect(json.messages.every((m: any) => m.role !== "tool" && m.role !== "system")).toBe(true);
    expect(json.messageCount).toBe(3); // user + 2 assistant
  });

  test("session search filterMessages returns matching messages", () => {
    const matched = filterMessages(testSession.messages, { query: "authentication" });
    expect(matched.length).toBe(1);
    expect(matched[0].role).toBe("user");
    expect(matched[0].content).toContain("authentication");
  });

  test("session search with role filter narrows results", () => {
    const matched = filterMessages(testSession.messages, {
      query: "auth",
      roles: ["assistant"],
    });
    expect(matched.length).toBe(1);
    expect(matched[0].role).toBe("assistant");
    expect(matched[0].content).toContain("auth middleware");
  });

  test("session search snippet truncation to 200 chars", () => {
    // Replicate the MCP handler snippet logic
    const matched = filterMessages(testSession.messages, { query: "token validation" });
    expect(matched.length).toBe(1);

    const snippets = matched.slice(0, 5).map((m) => ({
      role: m.role,
      snippet: m.content.length > 200 ? `${m.content.slice(0, 200)}...` : m.content,
    }));

    expect(snippets[0].snippet.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(snippets[0].snippet).toEndWith("...");
    expect(snippets[0].role).toBe("assistant");
  });

  test("session search case-insensitive", () => {
    const matched = filterMessages(testSession.messages, { query: "AUTHENTICATION" });
    expect(matched.length).toBe(1);
  });

  test("session search no matches returns empty", () => {
    const matched = filterMessages(testSession.messages, { query: "xyznonexistent" });
    expect(matched.length).toBe(0);
  });
});
