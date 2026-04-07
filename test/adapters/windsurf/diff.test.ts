import { describe, expect, test, afterEach } from "bun:test";
import { createTestDir, type TestDir } from "../../helpers/tmp.ts";
import { diffConfig } from "@/adapters/windsurf/diff.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";

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

describe("windsurf diffConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("in-sync when native matches resolved", async () => {
    dir = await createTestDir("am-ws-diff-");
    await dir.write(
      ".codeium/windsurf/mcp_config.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
        },
      }),
    );

    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("in-sync");
    expect(result.changes).toHaveLength(0);
  });

  test("detects server added locally", async () => {
    dir = await createTestDir("am-ws-diff-");
    await dir.write(
      ".codeium/windsurf/mcp_config.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          extra: { command: "extra-mcp" },
        },
      }),
    );

    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("drifted");
    const added = result.changes.find(
      (c) => c.name === "extra" && c.type === "added-locally",
    );
    expect(added).toBeDefined();
  });

  test("detects server removed locally", async () => {
    dir = await createTestDir("am-ws-diff-");
    await dir.write(
      ".codeium/windsurf/mcp_config.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
        },
      }),
    );

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
        }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("drifted");
    const removed = result.changes.find(
      (c) => c.name === "tavily" && c.type === "removed-locally",
    );
    expect(removed).toBeDefined();
  });

  test("detects modified server fields", async () => {
    dir = await createTestDir("am-ws-diff-");
    await dir.write(
      ".codeium/windsurf/mcp_config.json",
      JSON.stringify({
        mcpServers: {
          tavily: { command: "bunx", args: ["tavily-mcp@0.9.0"] },
        },
      }),
    );

    const cfg = config({
      servers: {
        tavily: server({
          name: "tavily",
          command: "bunx",
          args: ["tavily-mcp@latest"],
        }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("drifted");
    const modified = result.changes.find(
      (c) => c.name === "tavily" && c.type === "modified",
    );
    expect(modified).toBeDefined();
    expect(modified!.details!.some((d) => d.field === "args")).toBe(true);
  });

  test("returns unmanaged when no native file", async () => {
    dir = await createTestDir("am-ws-diff-");

    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx" }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("unmanaged");
    expect(result.changes).toHaveLength(0);
  });
});
