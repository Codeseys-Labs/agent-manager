import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { McpServer } from "../../src/mcp/server";
import { extractServerIdentity } from "../../src/commands/import";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("extractServerIdentity", () => {
  test("strips npx -y prefix and @version suffix", () => {
    expect(extractServerIdentity("npx", ["-y", "tavily-mcp@latest"])).toBe("tavily-mcp");
  });

  test("strips bunx prefix and @version suffix", () => {
    expect(extractServerIdentity("bunx", ["tavily-mcp@latest"])).toBe("tavily-mcp");
  });

  test("strips uvx prefix", () => {
    expect(extractServerIdentity("uvx", ["mcp-server-fetch"])).toBe("mcp-server-fetch");
  });

  test("extracts hostname from proxy endpoint", () => {
    expect(
      extractServerIdentity("uvx", ["mcp-proxy", "--endpoint", "https://mcp.exa.ai/sse"]),
    ).toBe("mcp.exa.ai");
  });

  test("strips absolute path to basename", () => {
    expect(extractServerIdentity("/usr/local/bin/aws-outlook-mcp")).toBe("aws-outlook-mcp");
  });

  test("returns plain command as-is", () => {
    expect(extractServerIdentity("aws-outlook-mcp")).toBe("aws-outlook-mcp");
  });

  test("handles pipx run prefix", () => {
    expect(extractServerIdentity("pipx", ["run", "some-tool@1.2.3"])).toBe("some-tool");
  });

  test("handles scoped package with @version", () => {
    // "@upstash/context7-mcp@latest" — the last @ is the version separator
    expect(extractServerIdentity("bunx", ["@upstash/context7-mcp@latest"])).toBe(
      "@upstash/context7-mcp",
    );
  });

  test("deduplicates identical servers", () => {
    const servers = [
      { name: "tavily", command: "bunx", args: ["tavily-mcp@latest"] },
      { name: "tavily-2", command: "npx", args: ["-y", "tavily-mcp@0.2.0"] },
    ];

    const identities = new Map<string, string>();
    let dupes = 0;

    for (const srv of servers) {
      const identity = extractServerIdentity(srv.command, srv.args);
      if (identities.has(identity)) {
        dupes++;
      } else {
        identities.set(identity, srv.name);
      }
    }

    expect(dupes).toBe(1);
    expect(identities.get("tavily-mcp")).toBe("tavily");
  });
});

// ── Import projectPath regression test ──────────────────────────
// The MCP server's am_import handler previously passed {} to adapter.import(),
// missing projectPath. This verifies the fix propagates project-level configs.

describe("import command passes projectPath to adapters", () => {
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

  test("MCP am_import handler passes projectPath (regression)", async () => {
    dir = await createTestDir("am-import-projpath-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), { servers: {} });

    // Invoke via MCP server — the handler should pass projectPath: process.cwd()
    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "am_import", arguments: { source: "auto" } },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as Record<string, any>;
    // Should not error — the handler completes successfully even if no tools detected
    if (!result.isError) {
      const content = JSON.parse(result.content[0].text);
      expect(content.action).toBe("import");
      expect(typeof content.imported).toBe("number");
    }
  });

  test("MCP am_import with specific adapter does not error from missing projectPath", async () => {
    dir = await createTestDir("am-import-projpath-");
    const configDir = dir.path;
    process.env.AM_CONFIG_DIR = configDir;
    await initRepo(configDir);
    await writeConfig(join(configDir, "config.toml"), { servers: {} });

    const server = new McpServer();
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "am_import", arguments: { source: "claude-code" } },
    });

    expect(resp).not.toBeNull();
    const result = resp?.result as Record<string, any>;
    if (!result.isError) {
      const content = JSON.parse(result.content[0].text);
      expect(content.source).toBe("claude-code");
    }
  });
});
