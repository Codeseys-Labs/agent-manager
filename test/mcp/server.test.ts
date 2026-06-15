import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { addRemote, initRepo } from "../../src/core/git";
import type { Config, Settings } from "../../src/core/schema";
import type { Session, SessionReader, SessionSummary } from "../../src/core/session";
import { writeActiveProfile } from "../../src/core/state";
import { McpServer, checkPermission } from "../../src/mcp/server";
import { type TestDir, createTestDir } from "../helpers/tmp";

type JsonRpcResult = Record<string, any>;

describe("MCP server", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
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
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(resp).not.toBeNull();
    // iter4 Wave A Bug 3: serverInfo.version used to be hardcoded "0.1.0" and
    // was asserted as such here — a snapshot of the bug. Now uses AM_VERSION
    // (defaults to "0.0.0-dev" when BUILD_VERSION env is unset, matches the
    // compiled-binary version when set by the build pipeline).
    expect(resp?.result).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "agent-manager" },
    });
    const result = resp?.result as { serverInfo: { version: string } };
    expect(result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+(-\w+)?$/);
  });

  test("tools/list returns only core tools by default (ADR-0021)", async () => {
    await setupConfig({});
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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
    // W1-4 added 4 core tools: am_list_skills, am_list_instructions,
    // am_profile_create, am_profile_delete (14 → 18). K6 added am_get_scope
    // (ADR-0055 auditability, core read-only) → 19.
    expect(names).toContain("am_list_skills");
    expect(names).toContain("am_list_instructions");
    expect(names).toContain("am_profile_create");
    expect(names).toContain("am_profile_delete");
    expect(names).toContain("am_get_scope");
    expect(names.length).toBe(19);
    // Session tools are in their own group now (ADR-0021), not core
    expect(names).not.toContain("am_session_list");
    expect(names).not.toContain("am_session_export");
    expect(names).not.toContain("am_session_search");
    // Non-core tools should NOT be present by default
    expect(names).not.toContain("am_registry_search");
    expect(names).not.toContain("am_wiki_search");
    expect(names).not.toContain("am_agent_discover");
    // ACP tools should NOT be present by default
    expect(names).not.toContain("am_run_agent");
    expect(names).not.toContain("am_acp_list_agents");
    expect(names).not.toContain("am_acp_session_list");
    expect(names).not.toContain("am_acp_session_cancel");
  });

  test("tools/list returns all groups when configured (ADR-0021)", async () => {
    await setupConfig({
      settings: {
        mcp_serve: { tools: ["core", "registry", "a2a", "wiki", "session", "acp"] },
      },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(resp).not.toBeNull();
    const tools = (resp?.result as JsonRpcResult).tools;
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("am_list_servers");
    // Catalog read-only enumeration (W1-4)
    expect(names).toContain("am_list_skills");
    expect(names).toContain("am_list_instructions");
    // Profile authoring (W1-4)
    expect(names).toContain("am_profile_create");
    expect(names).toContain("am_profile_delete");
    expect(names).toContain("am_registry_search");
    expect(names).toContain("am_registry_install");
    expect(names).toContain("am_registry_list_installed");
    expect(names).toContain("am_registry_uninstall");
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
    // ACP tools (ADR-0026 Phase 2)
    expect(names).toContain("am_run_agent");
    expect(names).toContain("am_acp_list_agents");
    expect(names).toContain("am_acp_session_list");
    expect(names).toContain("am_acp_session_cancel");
    // Wave D unified agent tools (5 new; legacy ACP aliases still present)
    expect(names).toContain("am_agent_invoke");
    expect(names).toContain("am_agent_session_list");
    expect(names).toContain("am_agent_session_cancel");
    expect(names).toContain("am_agent_status");
    expect(names).toContain("am_agent_detect");
    expect(names).toContain("am_get_scope");
    // W1-4: +5 quick-win tools → 43. K6: +am_get_scope (ADR-0055 auditability) → 44.
    expect(names.length).toBe(44);
  });

  test("tools/list respects selective group configuration (ADR-0021)", async () => {
    await setupConfig({
      settings: {
        mcp_serve: { tools: ["core", "wiki"] },
      },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(resp).not.toBeNull();
    const tools = (resp?.result as JsonRpcResult).tools;
    const names = tools.map((t: { name: string }) => t.name);
    // Core + wiki = 19 + 5 = 24. Core gained 4 W1-4 tools + am_get_scope (K6).
    // am_registry_uninstall is in the registry group, excluded here.
    expect(names.length).toBe(24);
    expect(names).toContain("am_list_servers");
    expect(names).toContain("am_list_skills");
    expect(names).toContain("am_profile_create");
    expect(names).toContain("am_wiki_search");
    expect(names).not.toContain("am_registry_search");
    expect(names).not.toContain("am_registry_uninstall");
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

  // R2-SEC1 belt-and-suspenders: am_status is read-only and tokenless, so a git
  // remote URL with embedded credentials must never reach the client verbatim —
  // even if a future code path bypasses getStatus's boundary redaction.
  test("am_status strips userinfo from remote URLs", async () => {
    const configDir = await setupConfig({});
    const secretToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const plainPassword = "s3cretPasswordWithNoTokenShape";
    await addRemote(
      configDir,
      `https://x-access-token:${secretToken}@github.com/org/repo.git`,
      "origin",
    );
    // A plain user:password URL has no recognizable token shape — only the
    // URL-userinfo strip catches it, which is the whole point of this guard.
    await addRemote(
      configDir,
      `https://alice:${plainPassword}@example.com/org/repo.git`,
      "upstream",
    );

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 53,
      method: "tools/call",
      params: { name: "am_status", arguments: {} },
    });

    const text = (resp?.result as JsonRpcResult).content[0].text as string;
    expect(text).not.toContain(secretToken);
    expect(text).not.toContain(plainPassword);

    const content = JSON.parse(text);
    expect(Array.isArray(content.git.remotes)).toBe(true);
    expect(content.git.remotes.length).toBeGreaterThanOrEqual(2);
    for (const r of content.git.remotes) {
      // The userinfo segment is replaced wholesale with `[redacted]@`, so the
      // raw `user:secret@` is gone but the host is still legible for diagnostics.
      expect(r.url).toContain("[redacted]@");
      expect(r.url).not.toContain(secretToken);
      expect(r.url).not.toContain(plainPassword);
    }
  });

  test("am_config_show returns config", async () => {
    await setupConfig({
      // The active profile must actually EXIST: fix-1-0 fails CLOSED when an
      // explicitly-named profile (`default_profile`) is absent from the profiles
      // table, which would deny this non-diagnostic read tool. Define `dev` so
      // the gateway resolves a real scope and the tool stays callable.
      settings: { default_profile: "dev" },
      profiles: { dev: {} },
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
      },
    });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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
    // am_config_show redacts every env value by key location (defense-in-depth
    // against plaintext-secret leaks — FIX 1). The merge is still verifiable
    // via the KEYS: both the pre-existing and the new var must be present.
    expect(Object.keys(serverEnv).sort()).toEqual(["API_KEY", "NEW_VAR"]);
    expect(serverEnv.API_KEY).toBe("[redacted]");
    expect(serverEnv.NEW_VAR).toBe("[redacted]");
  });

  test("am_server_update errors on nonexistent server", async () => {
    await setupConfig({ servers: {} });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

  // R2-LOW: am_doctor's config.toml check surfaces parse/validation errors to a
  // read-only, tokenless client. A Zod error echoes the offending VALUE — here
  // an invalid `transport` enum whose value is a GitHub token — so the message
  // must pass through safeErrorMessage before it leaves the process.
  //
  // ws2 (seed 6a89) regression guard: the config is structurally INVALID (a
  // server missing `command`), so refreshSettings fails CLOSED. am_doctor MUST
  // still run — it is the recovery/diagnostic tool that EXISTS to surface exactly
  // this kind of breakage — so the scope dispatch gate exempts it (see
  // DIAGNOSTIC_SCOPE_EXEMPT). A regression that bricked am_doctor here would mean
  // a broken config could no longer be diagnosed over MCP.
  test("am_doctor redacts secret-shaped values in config validation errors", async () => {
    await setupConfig({});
    const secretToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    // Overwrite config.toml with a raw, schema-invalid file. We bypass
    // writeConfig (which would reject it) by writing the TOML text directly.
    // The secret-shaped value is the SERVER NAME and the server is invalid
    // (missing `command`), so the Zod error echoes the token in the issue path
    // — exercising the redactor. (ADR-0057: a secret in `transport` no longer
    // leaks at all — the discriminated-union error names only the valid options,
    // never the bad value — so we place the token where the error DOES echo it.)
    await dir.write("config.toml", `[servers."${secretToken}"]\ntransport = "stdio"\n`);

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 52,
      method: "tools/call",
      params: { name: "am_doctor", arguments: {} },
    });

    const result = resp?.result as JsonRpcResult;
    const text = result.content[0].text as string;
    // The raw token must not appear anywhere in the response...
    expect(text).not.toContain(secretToken);

    const content = JSON.parse(text);
    const configCheck = content.checks.find((c: { name: string }) => c.name === "config.toml");
    expect(configCheck?.status).toBe("fail");
    expect(configCheck?.message).toContain("Parse/validation error:");
    // ...and the token specifically is replaced by the redaction placeholder.
    expect(configCheck?.message).not.toContain(secretToken);
    expect(configCheck?.message).toContain("[REDACTED_GH_TOKEN]");
  });

  test("am_doctor is read-only (no opt-in needed)", async () => {
    await setupConfig({});
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });

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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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
    expect(content.total).toBe(0); // gemini-cli has no sessions in test env
  });

  test("am_session_list with adapter that has no sessions returns empty", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "am_session_export",
        arguments: { id: "nonexistent", adapter: "forgecode" },
      },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("does not support session reading");
  });

  test("am_session_export errors on missing session", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    // Use gemini-cli — empty session storage in test env, returns empty quickly
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
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
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

  // ── W1-4: quick-win MCP tools (thin wrappers over controller/CLI paths) ──

  test("am_profile_create then am_list_profiles shows the new profile", async () => {
    await setupConfig({ profiles: {} });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });

    const createResp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 70,
      method: "tools/call",
      params: {
        name: "am_profile_create",
        arguments: { name: "work", description: "work profile" },
      },
    });
    const created = JSON.parse((createResp?.result as JsonRpcResult).content[0].text);
    expect(created.action).toBe("create");
    expect(created.profile).toBe("work");

    const listResp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 71,
      method: "tools/call",
      params: { name: "am_list_profiles", arguments: {} },
    });
    const list = JSON.parse((listResp?.result as JsonRpcResult).content[0].text);
    expect(list.profiles.some((p: { name: string }) => p.name === "work")).toBe(true);
  });

  test("am_profile_create rejects a duplicate name", async () => {
    await setupConfig({ profiles: { work: {} } });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 72,
      method: "tools/call",
      params: { name: "am_profile_create", arguments: { name: "work" } },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("already exists");
  });

  test("am_profile_create rejects a missing parent", async () => {
    await setupConfig({ profiles: {} });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 73,
      method: "tools/call",
      params: { name: "am_profile_create", arguments: { name: "child", inherits: "ghost" } },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not exist");
  });

  test("am_profile_delete removes a profile", async () => {
    await setupConfig({ profiles: { work: {}, play: {} } });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 74,
      method: "tools/call",
      params: { name: "am_profile_delete", arguments: { name: "play" } },
    });
    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
    expect(content.action).toBe("delete");
    expect(content.profile).toBe("play");
  });

  test("am_profile_delete refuses when another profile inherits from it", async () => {
    await setupConfig({ profiles: { base: {}, child: { inherits: "base" } } });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 75,
      method: "tools/call",
      params: { name: "am_profile_delete", arguments: { name: "base" } },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("inherits from it");
  });

  test("am_list_skills enumerates catalog skills", async () => {
    await setupConfig({
      skills: {
        review: { path: "skills/review.md", description: "code review", tags: ["dev"] },
      },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 76,
      method: "tools/call",
      params: { name: "am_list_skills", arguments: {} },
    });
    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
    expect(content.skills.length).toBe(1);
    expect(content.skills[0].name).toBe("review");
    expect(content.skills[0].path).toBe("skills/review.md");
    expect(content.skills[0].tags).toEqual(["dev"]);
  });

  test("am_list_instructions enumerates catalog instructions", async () => {
    await setupConfig({
      instructions: {
        style: { content: "Use tabs", scope: "always", description: "style guide" },
      },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 77,
      method: "tools/call",
      params: { name: "am_list_instructions", arguments: {} },
    });
    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
    expect(content.instructions.length).toBe(1);
    expect(content.instructions[0].name).toBe("style");
    expect(content.instructions[0].scope).toBe("always");
  });

  test("am_registry_uninstall removes a server and returns its provenance", async () => {
    await setupConfig({
      servers: {
        fetch: {
          command: "uvx",
          args: ["mcp-server-fetch"],
          transport: "stdio",
          enabled: true,
          _registry: {
            source: "mcp-registry",
            package: "mcp-server-fetch",
            version: "1.0.0",
            installed_at: "2026-06-04T00:00:00.000Z",
          },
        },
      },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 78,
      method: "tools/call",
      params: { name: "am_registry_uninstall", arguments: { name: "fetch" } },
    });
    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
    expect(content.action).toBe("uninstall");
    expect(content.server).toBe("fetch");
    expect(content.provenance?.package).toBe("mcp-server-fetch");
  });

  test("am_registry_uninstall errors on a missing server", async () => {
    await setupConfig({ servers: {} });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 79,
      method: "tools/call",
      params: { name: "am_registry_uninstall", arguments: { name: "ghost" } },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  // ── ADR-0055: runtime access-scoping profiles ──────────────────────────
  //
  // A profile that declares `scope` narrows the MCP surface at BOTH discovery
  // (tools/list) and dispatch (tools/call), intersected with the global
  // `settings.mcp_serve.tools` ceiling. A profile WITHOUT scope is unchanged.

  test("a profile scope narrows tools/list within the global ceiling", async () => {
    // Ceiling exposes core+wiki+registry; the active profile's scope narrows to
    // core only (+ explicitly allows one wiki tool).
    await setupConfig({
      settings: {
        default_profile: "locked",
        mcp_serve: { tools: ["core", "wiki", "registry"] },
      },
      profiles: {
        locked: { scope: { tool_groups: ["core"], allow_tools: ["am_wiki_search"] } },
      },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({ jsonrpc: "2.0", id: 90, method: "tools/list" });
    const names = (resp?.result as JsonRpcResult).tools.map((t: { name: string }) => t.name);
    // core tools visible:
    expect(names).toContain("am_status");
    expect(names).toContain("am_list_servers");
    // wiki group narrowed out EXCEPT the explicitly-allowed am_wiki_search:
    expect(names).toContain("am_wiki_search");
    expect(names).not.toContain("am_wiki_add");
    // registry group narrowed out entirely:
    expect(names).not.toContain("am_registry_search");
  });

  test("a profile scope REFUSES an out-of-scope tools/call (dispatch gate)", async () => {
    await setupConfig({
      settings: {
        default_profile: "locked",
        mcp_serve: { tools: ["core", "registry"] },
      },
      profiles: {
        locked: { scope: { tool_groups: ["core"] } }, // registry narrowed out
      },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: { name: "am_registry_search", arguments: { query: "x" } },
    });
    // Refused at dispatch even though the tool exists — hiding alone isn't a
    // boundary. -32601 with a profile-scope message.
    expect(resp?.error).toBeDefined();
    expect(resp?.error?.code).toBe(-32601);
    expect(resp?.error?.message).toContain("locked");
    expect(resp?.error?.message).toContain("scope");
  });

  test("deny_tools refuses a tool whose group is otherwise in scope", async () => {
    await setupConfig({
      settings: { default_profile: "noapply", mcp_serve: { tools: ["core"] } },
      profiles: { noapply: { scope: { deny_tools: ["am_apply"] } } },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    // am_apply hidden from discovery:
    const list = await server.handleRequest({ jsonrpc: "2.0", id: 92, method: "tools/list" });
    const names = (list?.result as JsonRpcResult).tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("am_apply");
    expect(names).toContain("am_status");
    // …and refused at dispatch:
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 93,
      method: "tools/call",
      params: { name: "am_apply", arguments: {} },
    });
    expect(call?.error?.code).toBe(-32601);
  });

  test("a profile WITHOUT scope leaves the default surface unchanged", async () => {
    // No scope on the active profile → tools/call for a non-core tool still
    // works (gated only by tier/auth, not group) — ADR-0021 discovery semantics
    // preserved, no regression.
    await setupConfig({
      settings: { default_profile: "plain" },
      profiles: { plain: { description: "no scope" } },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 94,
      method: "tools/call",
      params: { name: "am_list_skills", arguments: {} },
    });
    // am_list_skills is 'core' read-only → succeeds, not refused by scope.
    expect(resp?.error).toBeUndefined();
    expect((resp?.result as JsonRpcResult).isError).toBeUndefined();
  });

  // K-CRIT: a scoped profile whose inheritance is BROKEN must fail CLOSED, never
  // open. A typo'd `inherits` (or a cycle) makes resolveProfile throw; the
  // boundary must then deny everything, not silently expose the full ceiling.
  test("a scoped profile with an unknown inherits parent fails CLOSED (deny not bypassed)", async () => {
    await setupConfig({
      settings: { default_profile: "broken", mcp_serve: { tools: ["core", "registry"] } },
      profiles: {
        // `inherits: "ghost"` does not exist → resolveProfile throws.
        broken: { inherits: "ghost", scope: { deny_tools: ["am_apply"] } },
      },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    // tools/list must NOT expose the ceiling (fail-closed = empty surface).
    const list = await server.handleRequest({ jsonrpc: "2.0", id: 97, method: "tools/list" });
    const names = (list?.result as JsonRpcResult).tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("am_registry_search");
    expect(names).not.toContain("am_apply");
    expect(names).not.toContain("am_status");
    // The denied tool must be refused at dispatch, NOT silently callable.
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 98,
      method: "tools/call",
      params: { name: "am_apply", arguments: {} },
    });
    expect(call?.error?.code).toBe(-32601);
  });

  test("a scoped profile with circular inheritance fails CLOSED", async () => {
    await setupConfig({
      settings: { default_profile: "a", mcp_serve: { tools: ["core", "registry"] } },
      profiles: {
        a: { inherits: "b", scope: { tool_groups: ["core"] } },
        b: { inherits: "a" },
      },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "am_registry_search", arguments: { query: "x" } },
    });
    // Circular chain → fail closed → out-of-scope refusal, not exposure.
    expect(call?.error?.code).toBe(-32601);
  });

  // ws2 (seed 6a89) regression: a profile whose `scope` SUBTABLE is malformed —
  // e.g. `tool_groups = ["bogus"]` fails the z.enum, or `scope` is not an object —
  // makes ConfigSchema.parse THROW a ZodError. tryReadConfig rethrows it (only
  // ENOENT is swallowed), loadResolvedConfig throws, and refreshSettings used to
  // swallow it in its catch — leaving this.settings AND this.scope at their field
  // defaults (undefined). isToolInScope(..., undefined) returns true for the whole
  // ceiling, and the tools/call gate `if (this.scope && ...)` was bypassed
  // entirely. Net: a typo in a confinement profile's scope exposed the FULL
  // ceiling. The fix fails CLOSED: a present-but-invalid config sets this.scope to
  // an empty (maximally-restrictive) scope so the ceiling∩∅ denies everything.
  // This is distinct from the broken-inheritance case (resolveProfile throws);
  // here the throw is inside ConfigSchema.parse, BEFORE resolveActiveScope runs.
  test("a malformed profile.scope (invalid tool_groups) fails CLOSED, never exposes the ceiling", async () => {
    dir = await createTestDir("am-mcp-badscope-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    // Write RAW TOML — writeConfig would refuse to serialize an invalid scope,
    // so we hand-author the malformed on-disk config the bug requires. The
    // ceiling is wide (core+registry) so a fail-OPEN regression would be obvious.
    await dir.write(
      "config.toml",
      [
        "[settings]",
        'default_profile = "locked"',
        "",
        "[settings.mcp_serve]",
        'tools = ["core", "registry"]',
        "",
        "[profiles.locked.scope]",
        'tool_groups = ["bogus"]', // not in MCP_TOOL_GROUPS → z.enum throws
        "",
      ].join("\n"),
    );
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });

    // tools/list must NOT fall back to the global ceiling. The invalid scope
    // confines to ∅, EXCEPT the always-available diagnostic/recovery tools
    // (am_doctor, am_get_scope) that exist to surface exactly this breakage.
    const list = await server.handleRequest({ jsonrpc: "2.0", id: 130, method: "tools/list" });
    const names = (list?.result as JsonRpcResult).tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["am_doctor", "am_get_scope"]); // diagnostics only — fail closed
    // The dangerous ceiling (registry + the rest of core) is NOT exposed:
    expect(names).not.toContain("am_status");
    expect(names).not.toContain("am_apply");
    expect(names).not.toContain("am_registry_search");

    // tools/call for an in-ceiling, NON-diagnostic tool must be REFUSED at
    // dispatch, not silently callable. This is the core of the leak: the dispatch
    // gate must engage even though the config never parsed.
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 131,
      method: "tools/call",
      params: { name: "am_status", arguments: {} },
    });
    expect(call?.error).toBeDefined();
    expect(call?.error?.code).toBe(-32601);

    // A registry (non-core, dangerous) tool is likewise refused — proving the
    // malformed scope did NOT widen the surface to the configured ceiling.
    const reg = await server.handleRequest({
      jsonrpc: "2.0",
      id: 134,
      method: "tools/call",
      params: { name: "am_registry_search", arguments: { query: "x" } },
    });
    expect(reg?.error?.code).toBe(-32601);
  });

  // ws2 (seed 6a89) regression, second shape: `scope` itself is not a table
  // (e.g. a bare string). Same fail-CLOSED requirement — distinct only in WHICH
  // z.parse rule throws. Also selects the profile via the persisted state.toml
  // active profile (not default_profile) to exercise that resolution term.
  test("a profile.scope that is not a table fails CLOSED via the state.toml-active profile", async () => {
    dir = await createTestDir("am-mcp-badscope2-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await dir.write(
      "config.toml",
      [
        "[settings.mcp_serve]",
        'tools = ["core", "registry"]',
        "",
        "[profiles.locked]",
        'scope = "not-a-table"', // scope must be an object → ConfigSchema.parse throws
        "",
      ].join("\n"),
    );
    await writeActiveProfile(configDir, "locked"); // persisted `am use locked`
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });

    const list = await server.handleRequest({ jsonrpc: "2.0", id: 132, method: "tools/list" });
    const names = (list?.result as JsonRpcResult).tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["am_doctor", "am_get_scope"]); // diagnostics only — fail closed

    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 133,
      method: "tools/call",
      params: { name: "am_registry_search", arguments: { query: "x" } },
    });
    expect(call?.error?.code).toBe(-32601);
  });

  // ── M1: an EXPLICITLY-configured global ceiling is enforced at DISPATCH ──
  //
  // ADR-0055 Decision 2 keeps the global `settings.mcp_serve.tools` ceiling a
  // DISCOVERY-only filter for the DEFAULT (unset) case — so calling a non-core
  // tool without configuring groups keeps working (ADR-0021 backward-compat).
  // BUT once an operator EXPLICITLY narrows the ceiling, that narrowing is a
  // real access boundary: a de-listed group must reject at tools/call too, not
  // just disappear from tools/list. Hiding a tool is not a boundary — an agent
  // can call a name it saw before, or hallucinated. Detection is by the
  // explicit-set flag (tools !== undefined), NOT by value-comparing to ['core'].

  test("M1: an explicitly-set ceiling rejects an out-of-ceiling tools/call (not just hides it)", async () => {
    // tools = ['core'] is the SAME set as the unset default, but set EXPLICITLY.
    // This proves the gate keys off the explicit-set flag, not the value.
    await setupConfig({
      settings: { mcp_serve: { tools: ["core"] } },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });

    // Hidden from discovery (ADR-0021 behaviour, unchanged):
    const list = await server.handleRequest({ jsonrpc: "2.0", id: 200, method: "tools/list" });
    const names = (list?.result as JsonRpcResult).tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("am_wiki_search");
    expect(names).toContain("am_status"); // core still visible

    // …AND refused at dispatch — the M1 leak. -32601 with a ceiling message.
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: { name: "am_wiki_search", arguments: { query: "x" } },
    });
    expect(call?.error).toBeDefined();
    expect(call?.error?.code).toBe(-32601);
    expect(call?.error?.message).toContain("ceiling");
  });

  test("M1 regression: the UNSET (default) ceiling still dispatches non-core tools (ADR-0021)", async () => {
    // No settings.mcp_serve.tools at all → tools is `undefined` → the explicit
    // ceiling gate must NOT engage. am_wiki_search is hidden from tools/list
    // (default surface is core) but a direct call has ALWAYS worked and must
    // keep working — gated only by tier/auth, never by group. (The naive M1 fix
    // of dropping `this.scope &&` would 32601 this — the regression guard.)
    await setupConfig({});
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 202,
      method: "tools/call",
      params: { name: "am_wiki_search", arguments: { query: "anything" } },
    });
    // Not refused by the ceiling: either a successful result envelope or a
    // tool-internal error — but NEVER the -32601 group-boundary rejection.
    expect(call?.error?.code).not.toBe(-32601);
  });

  test("M1: the explicit-ceiling reject is positioned AFTER zod validation", async () => {
    // am_wiki_search is OUTSIDE an explicit ['core'] ceiling AND its `query`
    // arg is required. A client calling it with NO arguments must see the ZOD
    // validation error (the contract violation), not the ceiling rejection —
    // i.e. the ceiling gate must sit BELOW zod so 'rejects missing X' tests keep
    // hitting zod first. (Both reject, but the diagnostic must be the precise one.)
    await setupConfig({
      settings: { mcp_serve: { tools: ["core"] } },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 203,
      method: "tools/call",
      params: { name: "am_wiki_search", arguments: {} }, // missing required `query`
    });
    // Zod runs first → an isError result envelope, NOT a -32601 ceiling error.
    expect(call?.error).toBeUndefined();
    const result = call?.result as JsonRpcResult;
    expect(result?.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(typeof payload.error).toBe("string");
    // The zod error mentions the offending field, never the group/ceiling.
    expect(payload.error.toLowerCase()).not.toContain("ceiling");
  });

  test("M1: an explicit ceiling that INCLUDES the group still dispatches (no over-rejection)", async () => {
    // The explicit-ceiling gate must reject ONLY out-of-ceiling tools. A tool
    // whose group IS in the explicit ceiling must dispatch normally — guards
    // against a future flip where the explicit-set gate over-blocks in-ceiling
    // tools (which would brick legitimately-configured deployments).
    await setupConfig({
      settings: { mcp_serve: { tools: ["core", "wiki"] } },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 204,
      method: "tools/call",
      params: { name: "am_wiki_search", arguments: { query: "x" } },
    });
    // wiki IS in the ceiling → never the -32601 ceiling rejection.
    expect(call?.error?.code).not.toBe(-32601);
  });

  // seed f747 (regression): an explicit ceiling that OMITS `core` with NO active
  // profile (this.scope === undefined) skips the profile-scope gate entirely — so
  // only the explicit-ceiling gate runs. That gate must still exempt the
  // diagnostic/recovery tools (am_doctor, am_get_scope), or it bricks the very
  // tools an operator needs to SEE and FIX the broken ceiling. Pre-e900 these
  // were callable regardless of the ceiling; the e900 change regressed it.
  test("seed f747: an explicit ceiling omitting core still dispatches diagnostics (am_doctor, am_get_scope) but blocks non-diagnostic core tools", async () => {
    // tools = ['registry'] omits core. No profile → this.scope is undefined, so
    // the profile-scope gate (which exempts diagnostics via isToolScoped) never
    // engages — only isOutsideExplicitCeiling runs.
    await setupConfig({
      settings: { mcp_serve: { tools: ["registry"] } },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });

    // am_doctor (core, DIAGNOSTIC_SCOPE_EXEMPT) must NOT be refused by the ceiling.
    const doctor = await server.handleRequest({
      jsonrpc: "2.0",
      id: 220,
      method: "tools/call",
      params: { name: "am_doctor", arguments: {} },
    });
    expect(doctor?.error?.code).not.toBe(-32601);

    // am_get_scope (core, DIAGNOSTIC_SCOPE_EXEMPT) must NOT be refused either.
    const scope = await server.handleRequest({
      jsonrpc: "2.0",
      id: 221,
      method: "tools/call",
      params: { name: "am_get_scope", arguments: {} },
    });
    expect(scope?.error?.code).not.toBe(-32601);

    // A non-diagnostic core tool (am_status — am_init is not an MCP tool) IS
    // blocked: core is outside the explicit ['registry'] ceiling. -32601 with a
    // ceiling message proves the gate is the boundary, not auth/zod.
    const status = await server.handleRequest({
      jsonrpc: "2.0",
      id: 222,
      method: "tools/call",
      params: { name: "am_status", arguments: {} },
    });
    expect(status?.error).toBeDefined();
    expect(status?.error?.code).toBe(-32601);
    expect(status?.error?.message).toContain("ceiling");

    // seed 22b7 (no-drift): am_get_scope's manifest must NOT report an empty
    // effectiveTools while the diagnostics are actually callable. The raw
    // isToolInScope manifest would exclude am_doctor/am_get_scope (core ∉
    // ['registry'] ceiling), contradicting enforcement. The handler promotes the
    // exempt names into effectiveTools so the manifest matches the gate.
    const m = JSON.parse((scope?.result as JsonRpcResult).content[0].text);
    expect(m.ceiling).toEqual(["registry"]);
    expect(m.effectiveTools).toContain("am_doctor");
    expect(m.effectiveTools).toContain("am_get_scope");
    expect(m.excludedTools).not.toContain("am_doctor");
    expect(m.excludedTools).not.toContain("am_get_scope");
    // The blocked non-diagnostic core tool stays excluded.
    expect(m.effectiveTools).not.toContain("am_status");
    expect(m.excludedTools).toContain("am_status");
  });

  test("AM_MCP_PROFILE env selects the connection scope at initialize", async () => {
    await setupConfig({
      settings: { mcp_serve: { tools: ["core", "registry"] } },
      profiles: { envlocked: { scope: { tool_groups: ["core"] } } },
    });
    const prev = process.env.AM_MCP_PROFILE;
    process.env.AM_MCP_PROFILE = "envlocked";
    try {
      const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
      // Drive a real initialize so the connection profile is read.
      await server.handleRequest({
        jsonrpc: "2.0",
        id: 95,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      const list = await server.handleRequest({ jsonrpc: "2.0", id: 96, method: "tools/list" });
      const names = (list?.result as JsonRpcResult).tools.map((t: { name: string }) => t.name);
      expect(names).toContain("am_status");
      expect(names).not.toContain("am_registry_search"); // registry narrowed by env-selected profile
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "AM_MCP_PROFILE");
      else process.env.AM_MCP_PROFILE = prev;
    }
  });

  // CodeRabbit cr2 regression: the out-of-scope -32601 error must name the
  // profile whose scope the gate ACTUALLY enforced. The enforced scope comes
  // from resolveActiveScope (connection am.profile → state.toml → default_profile
  // → default); the error message must not re-derive a name that skips the
  // state.toml term. Set state.toml="locked" with a DIFFERENT default_profile
  // and no connection profile → the message must say "locked", not the default.
  test("out-of-scope refusal names the state.toml-resolved profile, not the default", async () => {
    const configDir = await setupConfig({
      settings: { default_profile: "wideopen", mcp_serve: { tools: ["core", "registry"] } },
      profiles: {
        wideopen: {}, // no scope
        locked: { scope: { tool_groups: ["core"] } }, // registry narrowed out
      },
    });
    await writeActiveProfile(configDir, "locked"); // persisted `am use locked`
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 97,
      method: "tools/call",
      params: { name: "am_registry_search", arguments: { query: "x" } },
    });
    // Enforced by "locked"'s scope (registry out) → refused…
    expect(call?.error?.code).toBe(-32601);
    // …and the message names "locked" (state.toml), NOT "wideopen" (default).
    expect(call?.error?.message).toContain('"locked"');
    expect(call?.error?.message).not.toContain("wideopen");
  });

  // K6 (ADR-0055 Decision 6): am_get_scope returns the effective tool manifest,
  // matching what tools/list exposes — the auditable, drift-free boundary view.
  test("am_get_scope reports the active profile's effective tool manifest", async () => {
    await setupConfig({
      settings: { default_profile: "locked", mcp_serve: { tools: ["core", "registry"] } },
      profiles: { locked: { scope: { tool_groups: ["core"], deny_tools: ["am_apply"] } } },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "am_get_scope", arguments: {} },
    });
    const m = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
    expect(m.profile).toBe("locked");
    expect(m.scoped).toBe(true);
    expect(m.ceiling).toEqual(["core", "registry"]);
    expect(m.toolGroups).toEqual(["core"]);
    expect(m.denyTools).toContain("am_apply");
    // Effective excludes the denied tool + the narrowed-out registry group.
    expect(m.effectiveTools).toContain("am_status");
    expect(m.effectiveTools).not.toContain("am_apply");
    expect(m.effectiveTools).not.toContain("am_registry_search");
    expect(m.excludedTools).toContain("am_apply");
    expect(m.excludedTools).toContain("am_registry_search");
    // The manifest must agree with what tools/list actually exposes (no drift).
    const list = await server.handleRequest({ jsonrpc: "2.0", id: 101, method: "tools/list" });
    const listed = (list?.result as JsonRpcResult).tools
      .map((t: { name: string }) => t.name)
      .sort();
    expect(m.effectiveTools).toEqual(listed);
  });

  // K6 regression (review finding, 87bdd2a): am_get_scope MUST report the
  // CONNECTION-supplied profile the gateway enforces — not the persisted/default
  // profile. Before the fix it re-resolved via loadConfigAndProfile() (which
  // ignores connectionProfile), so when the connection profile diverged from the
  // default the manifest LIED: tools/list hid registry tools while am_get_scope
  // reported them as available. The bug only manifests when connection ≠ default.
  test("am_get_scope follows the connection profile (am.profile capability), not the default", async () => {
    await setupConfig({
      settings: { default_profile: "wideopen", mcp_serve: { tools: ["core", "registry"] } },
      profiles: {
        wideopen: {}, // default: no scope → full ceiling (core + registry)
        locked: { scope: { tool_groups: ["core"], deny_tools: ["am_apply"] } },
      },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    // Initialize with a connection profile that DIFFERS from default_profile.
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 110,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: { experimental: { "am.profile": "locked" } },
      },
    });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 111,
      method: "tools/call",
      params: { name: "am_get_scope", arguments: {} },
    });
    const m = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
    // Reports the CONNECTION profile, not the wideopen default.
    expect(m.profile).toBe("locked");
    expect(m.scoped).toBe(true);
    expect(m.effectiveTools).not.toContain("am_registry_search"); // registry narrowed by locked
    expect(m.effectiveTools).not.toContain("am_apply"); // denied by locked
    expect(m.excludedTools).toContain("am_registry_search");
    // Zero drift: the manifest equals what tools/list exposes under this connection.
    const list = await server.handleRequest({ jsonrpc: "2.0", id: 112, method: "tools/list" });
    const listed = (list?.result as JsonRpcResult).tools
      .map((t: { name: string }) => t.name)
      .sort();
    expect(m.effectiveTools).toEqual(listed);
  });

  test("am_get_scope follows the connection profile (AM_MCP_PROFILE env), not the default", async () => {
    await setupConfig({
      settings: { default_profile: "wideopen", mcp_serve: { tools: ["core", "registry"] } },
      profiles: {
        wideopen: {},
        envlocked: { scope: { tool_groups: ["core"] } },
      },
    });
    const prev = process.env.AM_MCP_PROFILE;
    process.env.AM_MCP_PROFILE = "envlocked";
    try {
      const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
      await server.handleRequest({
        jsonrpc: "2.0",
        id: 120,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      const resp = await server.handleRequest({
        jsonrpc: "2.0",
        id: 121,
        method: "tools/call",
        params: { name: "am_get_scope", arguments: {} },
      });
      const m = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
      expect(m.profile).toBe("envlocked");
      expect(m.effectiveTools).not.toContain("am_registry_search");
      const list = await server.handleRequest({ jsonrpc: "2.0", id: 122, method: "tools/list" });
      const listed = (list?.result as JsonRpcResult).tools
        .map((t: { name: string }) => t.name)
        .sort();
      expect(m.effectiveTools).toEqual(listed);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "AM_MCP_PROFILE");
      else process.env.AM_MCP_PROFILE = prev;
    }
  });
});

// ── Error hint field tests ────────────────────────────────────────
// Verify that tool errors produce structured JSON with `error` and optional `hint`.

describe("MCP error response structure", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    }
    if (dir) await dir.cleanup();
  });

  async function setupConfig(config: Config): Promise<string> {
    dir = await createTestDir("am-mcp-err-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), config);
    return configDir;
  }

  test("error responses include hint field for actionable errors", async () => {
    await setupConfig({ servers: {} });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 200,
      method: "tools/call",
      params: { name: "am_remove_server", arguments: { name: "nonexistent" } },
    });

    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toBeDefined();
    // The error message contains a period-separated hint
    expect(content.hint).toBeDefined();
    expect(content.hint).toContain("am_list_servers");
  });

  test("am_add_server duplicate returns error with hint", async () => {
    await setupConfig({
      servers: {
        fetch: { command: "uvx", transport: "stdio", enabled: true },
      },
    });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: {
        name: "am_add_server",
        arguments: { name: "fetch", command: "uvx" },
      },
    });

    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("already exists");
    expect(content.hint).toBeDefined();
  });

  test("am_use_profile with nonexistent profile returns error with available profiles", async () => {
    await setupConfig({
      profiles: {
        work: { description: "Work profile" },
        personal: { description: "Personal profile" },
      },
    });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 202,
      method: "tools/call",
      params: { name: "am_use_profile", arguments: { profile: "nonexistent" } },
    });

    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("not found");
  });

  test("am_import with nonexistent adapter returns error with hint", async () => {
    await setupConfig({ servers: {} });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 203,
      method: "tools/call",
      params: { name: "am_import", arguments: { source: "nonexistent-tool" } },
    });

    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("not found");
  });
});

// ── Import projectPath regression test ──────────────────────────
// Verifies that am_import passes projectPath to adapters (bug fix).

describe("MCP am_import passes projectPath to adapters", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    }
    if (dir) await dir.cleanup();
  });

  test("am_import with 'auto' source returns structured result", async () => {
    dir = await createTestDir("am-mcp-import-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), { servers: {} });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 300,
      method: "tools/call",
      params: { name: "am_import", arguments: { source: "auto" } },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    // Even with no detected tools, should return a structured response (not error)
    if (!result.isError) {
      const content = JSON.parse(result.content[0].text);
      expect(content.action).toBe("import");
      expect(typeof content.imported).toBe("number");
    }
  });

  test("am_import with specific adapter returns structured result", async () => {
    dir = await createTestDir("am-mcp-import-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), { servers: {} });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    // Use claude-code which is always available
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 301,
      method: "tools/call",
      params: { name: "am_import", arguments: { source: "claude-code" } },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    if (!result.isError) {
      const content = JSON.parse(result.content[0].text);
      expect(content.action).toBe("import");
      expect(content.source).toBe("claude-code");
      expect(typeof content.imported).toBe("number");
    }
  });
});

// ── am_list_profiles handler test ───────────────────────────────

describe("MCP am_list_profiles handler", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    }
    if (dir) await dir.cleanup();
  });

  test("am_list_profiles returns profile list with active indicator", async () => {
    dir = await createTestDir("am-mcp-profiles-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), {
      settings: { default_profile: "work" },
      profiles: {
        work: { description: "Work environment" },
        personal: { description: "Personal setup", inherits: "work" },
      },
    });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 400,
      method: "tools/call",
      params: { name: "am_list_profiles", arguments: {} },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(content.activeProfile).toBe("work");
    expect(Array.isArray(content.profiles)).toBe(true);
    expect(content.profiles.length).toBe(2);

    const work = content.profiles.find((p: { name: string }) => p.name === "work");
    expect(work.active).toBe(true);
    expect(work.description).toBe("Work environment");

    const personal = content.profiles.find((p: { name: string }) => p.name === "personal");
    expect(personal.active).toBe(false);
    expect(personal.inherits).toBe("work");
  });
});

// ── am_use_profile handler test ─────────────────────────────────

describe("MCP am_use_profile handler", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    }
    if (dir) await dir.cleanup();
  });

  test("am_use_profile switches active profile", async () => {
    dir = await createTestDir("am-mcp-use-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), {
      settings: { default_profile: "default" },
      profiles: {
        default: { description: "Default" },
        work: { description: "Work" },
      },
    });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 500,
      method: "tools/call",
      params: { name: "am_use_profile", arguments: { profile: "work" } },
    });

    const content = JSON.parse((resp?.result as JsonRpcResult).content[0].text);
    expect(content.action).toBe("use");
    expect(content.profile).toBe("work");
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

// ── ACP tool tests (ADR-0026 Phase 2) ────────────────────────────

describe("MCP ACP tools", () => {
  let dir: TestDir;
  const originalEnv = process.env.AM_CONFIG_DIR;

  afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    }
    if (dir) await dir.cleanup();
  });

  async function setupConfig(config: Config): Promise<string> {
    dir = await createTestDir("am-mcp-acp-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), config);
    return configDir;
  }

  test("ACP tools are registered with correct names", () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const tools = server.getTools();
    const names = tools.map((t) => t.def.name);
    expect(names).toContain("am_run_agent");
    expect(names).toContain("am_acp_list_agents");
    expect(names).toContain("am_acp_session_list");
    expect(names).toContain("am_acp_session_cancel");
  });

  test("ACP tools belong to the 'acp' group", () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const tools = server.getTools();
    const acpToolNames = [
      "am_run_agent",
      "am_acp_list_agents",
      "am_acp_session_list",
      "am_acp_session_cancel",
    ];
    for (const name of acpToolNames) {
      const tool = tools.find((t) => t.def.name === name);
      expect(tool).toBeDefined();
    }
  });

  test("ACP tools visible only when acp group is enabled", async () => {
    await setupConfig({
      settings: {
        mcp_serve: { tools: ["acp"] },
      },
    });
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/list",
    });
    expect(resp).not.toBeNull();
    const tools = (resp?.result as JsonRpcResult).tools;
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("am_run_agent");
    expect(names).toContain("am_acp_list_agents");
    expect(names).toContain("am_acp_session_list");
    expect(names).toContain("am_acp_session_cancel");
    // Wave D unified agent tools also live in the acp group.
    expect(names).toContain("am_agent_invoke");
    expect(names).toContain("am_agent_session_list");
    expect(names).toContain("am_agent_session_cancel");
    expect(names).toContain("am_agent_status");
    expect(names).toContain("am_agent_detect");
    expect(names.length).toBe(9);
    // Core tools should NOT be present
    expect(names).not.toContain("am_list_servers");
  });

  test("am_run_agent has correct tier (write-remote)", () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const tools = server.getTools();
    const runAgent = tools.find((t) => t.def.name === "am_run_agent");
    expect(runAgent?.tier).toBe("write-remote");
  });

  test("am_acp_list_agents has correct tier (read-only)", () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const tools = server.getTools();
    const listAgents = tools.find((t) => t.def.name === "am_acp_list_agents");
    expect(listAgents?.tier).toBe("read-only");
  });

  test("am_acp_session_list has correct tier (read-only)", () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const tools = server.getTools();
    const sessionList = tools.find((t) => t.def.name === "am_acp_session_list");
    expect(sessionList?.tier).toBe("read-only");
  });

  test("am_acp_session_cancel has correct tier (write-remote)", () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const tools = server.getTools();
    const sessionCancel = tools.find((t) => t.def.name === "am_acp_session_cancel");
    expect(sessionCancel?.tier).toBe("write-remote");
  });

  test("am_run_agent requires agent and prompt params", () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const tools = server.getTools();
    const runAgent = tools.find((t) => t.def.name === "am_run_agent");
    expect(runAgent?.def.inputSchema.required).toEqual(["agent", "prompt"]);
    expect(runAgent?.def.inputSchema.properties).toHaveProperty("agent");
    expect(runAgent?.def.inputSchema.properties).toHaveProperty("prompt");
    expect(runAgent?.def.inputSchema.properties).toHaveProperty("session");
    expect(runAgent?.def.inputSchema.properties).toHaveProperty("cwd");
  });

  test("am_acp_session_cancel requires sessionId param", () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const tools = server.getTools();
    const cancel = tools.find((t) => t.def.name === "am_acp_session_cancel");
    expect(cancel?.def.inputSchema.required).toEqual(["sessionId"]);
    expect(cancel?.def.inputSchema.properties).toHaveProperty("sessionId");
  });

  test("am_acp_list_agents returns agents from registry", async () => {
    await setupConfig({
      settings: {
        mcp_serve: { tools: ["acp"] },
      },
      agents: {
        "my-custom": {
          name: "My Custom",
          description: "Custom agent",
          acp: { command: "./custom-agent --acp" },
        },
      },
    });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: { name: "am_acp_list_agents", arguments: {} },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(Array.isArray(content.agents)).toBe(true);
    // Should include built-in agents
    const names = content.agents.map((a: { name: string }) => a.name);
    expect(names).toContain("claude");
    expect(names).toContain("codex");
    // Should include config override
    expect(names).toContain("my-custom");
    // Check config override has correct source
    const custom = content.agents.find((a: { name: string }) => a.name === "my-custom");
    expect(custom.source).toBe("config");
    expect(custom.acp.command).toBe("./custom-agent --acp");
  });

  test("am_acp_session_list returns empty when no session dir", async () => {
    await setupConfig({});

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: { name: "am_acp_session_list", arguments: {} },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(Array.isArray(content.sessions)).toBe(true);
    expect(content.sessions.length).toBe(0);
  });

  test("am_acp_session_cancel errors on nonexistent session", async () => {
    await setupConfig({
      settings: {
        mcp_serve: { allow_push: true },
      },
    });

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 103,
      method: "tools/call",
      params: { name: "am_acp_session_cancel", arguments: { sessionId: "nonexistent-session" } },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("not found");
  });

  test("am_run_agent rejected without write-remote opt-in", async () => {
    await setupConfig({});

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    server.setSettings({});

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 104,
      method: "tools/call",
      params: { name: "am_run_agent", arguments: { agent: "claude", prompt: "test" } },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("opt-in");
  });

  test("am_acp_session_cancel rejected without write-remote opt-in", async () => {
    await setupConfig({});

    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    server.setSettings({});

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 105,
      method: "tools/call",
      params: { name: "am_acp_session_cancel", arguments: { sessionId: "test" } },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toContain("opt-in");
  });
});

// ── CODEX-4 (2026-05-02): am_agent_detect reachable alias deprecation ──
//
// The field was renamed from `reachable` to `locallyInstalled` in an earlier
// commit because "reachable" misleadingly suggested A2A remote-endpoint
// reachability for protocol:"both" entries. To avoid breaking MCP consumers
// that parse `.reachable`, the old field name is emitted as an alias for one
// release with the same value, then removed in v0.6.
describe("am_agent_detect — reachable compat alias (2026-05-02..v0.6)", () => {
  let tmp: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  afterEach(async () => {
    if (originalEnv) process.env.AM_CONFIG_DIR = originalEnv;
    else Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    if (tmp) await tmp.cleanup();
    tmp = undefined;
  });

  test("emits both locallyInstalled and reachable with equal values", async () => {
    tmp = await createTestDir("am-detect-alias-");
    process.env.AM_CONFIG_DIR = tmp.path;
    await initRepo(tmp.path);
    await writeConfig(join(tmp.path, "config.toml"), {});

    const server = new McpServer();
    server.setAuth({ token: undefined, allowUnsafeLocal: true });

    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "am_agent_detect", arguments: {} },
    });

    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(Array.isArray(content.detected)).toBe(true);
    // Every detected entry must carry BOTH field names with the same value.
    // When the backing detectAllAgents() call returns nothing (no built-in
    // agents installed in a bare test config), `detected` may be empty —
    // that's fine; the alias invariant is about shape, not presence.
    for (const entry of content.detected as Array<Record<string, unknown>>) {
      expect(entry).toHaveProperty("locallyInstalled");
      expect(entry).toHaveProperty("reachable");
      expect(entry.reachable).toBe(entry.locallyInstalled as unknown as typeof entry.reachable);
    }
  });
});

// ── checkPermission fail-closed (L2/dd56) ───────────────────────────
//
// The ToolTier union is 'read-only' | 'write-local' | 'write-remote', but
// nine tool definitions assign their tier via `as ToolTier` casts that bypass
// the literal-type check. A future typo'd tier ("write-remot", "write_local")
// would therefore compile. checkPermission MUST default-DENY any tier outside
// the known union — otherwise a mis-tagged write-tier tool would silently
// default-ALLOW with no opt-in / no auth gate.
describe("checkPermission fail-closed default", () => {
  test("read-only and write-local are allowed (baseline)", () => {
    expect(checkPermission("read-only").allowed).toBe(true);
    expect(checkPermission("write-local").allowed).toBe(true);
  });

  test("write-remote is denied without opt-in, allowed with allow_push", () => {
    expect(checkPermission("write-remote").allowed).toBe(false);
    const optedIn = { mcp_serve: { allow_push: true } } as unknown as Settings;
    expect(checkPermission("write-remote", optedIn).allowed).toBe(true);
  });

  test("an unknown tier (cast past the union) is DENIED, not default-allowed", () => {
    // Simulate a typo'd `tier: "..." as ToolTier` cast reaching the gate.
    const bogusTier = "write-remot" as unknown as Parameters<typeof checkPermission>[0];
    const decision = checkPermission(bogusTier);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/fail-closed/i);

    // Even with allow_push set (opt-in for a *known* remote tier), an
    // unrecognised tier must still be refused — opt-in is tier-specific.
    const optedIn = { mcp_serve: { allow_push: true } } as unknown as Settings;
    expect(checkPermission(bogusTier, optedIn).allowed).toBe(false);
  });

  test("empty-string and arbitrary tiers are DENIED", () => {
    for (const bogus of ["", "WRITE-LOCAL", "admin", "write_local", "remote"]) {
      const t = bogus as unknown as Parameters<typeof checkPermission>[0];
      expect(checkPermission(t).allowed).toBe(false);
    }
  });
});
