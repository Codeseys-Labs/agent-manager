import { afterEach, describe, expect, test } from "bun:test";
import { diffConfig } from "@/adapters/kilo-code/diff.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
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

describe("diffConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("in-sync when native matches resolved (new format)", async () => {
    dir = await createTestDir("am-kc-diff-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcp: {
          fetch: {
            type: "local",
            command: ["uvx", "mcp-server-fetch"],
          },
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

  test("in-sync when native matches resolved (legacy format)", async () => {
    dir = await createTestDir("am-kc-diff-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
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
    dir = await createTestDir("am-kc-diff-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcp: {
          fetch: { type: "local", command: ["uvx", "mcp-server-fetch"] },
          extra: { type: "local", command: ["node", "extra.js"] },
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
    const added = result.changes.find((c) => c.name === "extra" && c.type === "added-locally");
    expect(added).toBeDefined();
  });

  test("detects server removed locally", async () => {
    dir = await createTestDir("am-kc-diff-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcp: {
          fetch: { type: "local", command: ["uvx", "mcp-server-fetch"] },
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
    const removed = result.changes.find((c) => c.name === "tavily" && c.type === "removed-locally");
    expect(removed).toBeDefined();
  });

  test("detects modified server fields", async () => {
    dir = await createTestDir("am-kc-diff-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcp: {
          tavily: {
            type: "local",
            command: ["bunx", "tavily-mcp@0.9.0"],
          },
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
    const modified = result.changes.find((c) => c.name === "tavily" && c.type === "modified");
    expect(modified).toBeDefined();
    expect(modified?.details?.some((d) => d.field === "args")).toBe(true);
  });

  test("returns unmanaged when no native config", async () => {
    dir = await createTestDir("am-kc-diff-");

    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx" }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("unmanaged");
    expect(result.changes).toHaveLength(0);
  });

  test("normalizes key order for comparison", async () => {
    dir = await createTestDir("am-kc-diff-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcp: {
          svc: {
            type: "local",
            command: ["my-mcp"],
            environment: { B_KEY: "2", A_KEY: "1" },
          },
        },
      }),
    );

    const cfg = config({
      servers: {
        svc: server({
          name: "svc",
          command: "my-mcp",
          env: { A_KEY: "1", B_KEY: "2" },
        }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("in-sync");
    expect(result.changes).toHaveLength(0);
  });

  test("detects env changes", async () => {
    dir = await createTestDir("am-kc-diff-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcp: {
          svc: {
            type: "local",
            command: ["my-mcp"],
            environment: { API_KEY: "old-value" },
          },
        },
      }),
    );

    const cfg = config({
      servers: {
        svc: server({
          name: "svc",
          command: "my-mcp",
          env: { API_KEY: "new-value" },
        }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("drifted");
    const modified = result.changes.find((c) => c.type === "modified");
    expect(modified?.details?.some((d) => d.field === "env")).toBe(true);
  });

  test("handles JSONC with comments in diff", async () => {
    dir = await createTestDir("am-kc-diff-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      `{
        // MCP config
        "mcp": {
          "fetch": {
            "type": "local",
            "command": ["uvx", "mcp-server-fetch"],
          }
        }
      }`,
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
  });

  test("skips disabled native servers", async () => {
    dir = await createTestDir("am-kc-diff-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcp: {
          fetch: { type: "local", command: ["uvx", "mcp-server-fetch"] },
          disabled: {
            type: "local",
            command: ["node", "disabled.js"],
            enabled: false,
          },
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
});
