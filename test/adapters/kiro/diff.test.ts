import { describe, expect, test, afterEach } from "bun:test";
import { createTestDir, type TestDir } from "../../helpers/tmp.ts";
import { diffConfig } from "@/adapters/kiro/diff.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
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

function makeServer(overrides: Partial<ResolvedServer> = {}): ResolvedServer {
  return {
    name: "test-server",
    command: "test-cmd",
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

describe("kiro diffConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("returns in-sync when configs match", async () => {
    dir = await createTestDir("am-kiro-diff-");
    await dir.write(
      ".kiro/settings/mcp.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
        },
      }),
    );

    const config = makeConfig({
      servers: {
        fetch: makeServer({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = diffConfig(config, {}, dir.path);
    expect(result.status).toBe("in-sync");
    expect(result.changes).toHaveLength(0);
  });

  test("returns unmanaged when no native config exists", async () => {
    dir = await createTestDir("am-kiro-diff-");
    const config = makeConfig({
      servers: {
        fetch: makeServer({ name: "fetch", command: "uvx" }),
      },
    });

    const result = diffConfig(config, {}, dir.path);
    expect(result.status).toBe("unmanaged");
  });

  test("detects server added locally", async () => {
    dir = await createTestDir("am-kiro-diff-");
    await dir.write(
      ".kiro/settings/mcp.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          extra: { command: "extra-mcp" },
        },
      }),
    );

    const config = makeConfig({
      servers: {
        fetch: makeServer({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = diffConfig(config, {}, dir.path);
    expect(result.status).toBe("drifted");
    const added = result.changes.find((c) => c.name === "extra");
    expect(added).toBeDefined();
    expect(added!.type).toBe("added-locally");
  });

  test("detects server removed locally", async () => {
    dir = await createTestDir("am-kiro-diff-");
    await dir.write(
      ".kiro/settings/mcp.json",
      JSON.stringify({
        mcpServers: {},
      }),
    );

    const config = makeConfig({
      servers: {
        fetch: makeServer({ name: "fetch", command: "uvx" }),
      },
    });

    const result = diffConfig(config, {}, dir.path);
    expect(result.status).toBe("drifted");
    const removed = result.changes.find((c) => c.name === "fetch");
    expect(removed).toBeDefined();
    expect(removed!.type).toBe("removed-locally");
  });

  test("detects modified server (command changed)", async () => {
    dir = await createTestDir("am-kiro-diff-");
    await dir.write(
      ".kiro/settings/mcp.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "npx", args: ["mcp-server-fetch"] },
        },
      }),
    );

    const config = makeConfig({
      servers: {
        fetch: makeServer({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = diffConfig(config, {}, dir.path);
    expect(result.status).toBe("drifted");
    const modified = result.changes.find((c) => c.name === "fetch");
    expect(modified).toBeDefined();
    expect(modified!.type).toBe("modified");
    expect(modified!.details).toBeDefined();
    expect(modified!.details![0].field).toBe("command");
  });

  test("detects modified env", async () => {
    dir = await createTestDir("am-kiro-diff-");
    await dir.write(
      ".kiro/settings/mcp.json",
      JSON.stringify({
        mcpServers: {
          tavily: {
            command: "bunx",
            args: ["tavily-mcp@latest"],
            env: { KEY: "old-value" },
          },
        },
      }),
    );

    const config = makeConfig({
      servers: {
        tavily: makeServer({
          name: "tavily",
          command: "bunx",
          args: ["tavily-mcp@latest"],
          env: { KEY: "new-value" },
        }),
      },
    });

    const result = diffConfig(config, {}, dir.path);
    expect(result.status).toBe("drifted");
    const modified = result.changes.find((c) => c.name === "tavily");
    expect(modified!.details!.some((d) => d.field === "env")).toBe(true);
  });

  test("includes project servers in diff", async () => {
    dir = await createTestDir("am-kiro-diff-");
    await dir.write(
      ".kiro/settings/mcp.json",
      JSON.stringify({ mcpServers: {} }),
    );
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.kiro/settings/mcp.json",
      JSON.stringify({
        mcpServers: {
          local: { command: "local-mcp" },
        },
      }),
    );

    const config = makeConfig({
      servers: {
        local: makeServer({ name: "local", command: "local-mcp" }),
      },
    });

    const result = diffConfig(config, { projectPath: projectDir }, dir.path);
    expect(result.status).toBe("in-sync");
  });
});
