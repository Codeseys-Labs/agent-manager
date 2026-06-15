import { afterEach, describe, expect, test } from "bun:test";
import { diffConfig } from "@/adapters/claude-code/diff.ts";
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
    agents: {},
    ...overrides,
  };
}

describe("diffConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("in-sync when native matches resolved", async () => {
    dir = await createTestDir("am-diff-");
    await dir.write(
      ".claude.json",
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
    dir = await createTestDir("am-diff-");
    await dir.write(
      ".claude.json",
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
    const added = result.changes.find((c) => c.name === "extra" && c.type === "added-locally");
    expect(added).toBeDefined();
  });

  test("labels catalog-ahead server as added-in-config, not removed-locally", async () => {
    // Catalog-ahead: the user just ran `am add server tavily`. The native
    // config still only has `fetch`; the catalog has both. This is a FORWARD
    // delta `am apply` resolves by writing tavily — NOT a local removal. It
    // must be labeled `added-in-config` so the controller drift gate treats it
    // as benign and a bare `am apply` writes it without --force.
    // (ws4-drift-relabel-catalog-ahead)
    dir = await createTestDir("am-diff-");
    await dir.write(
      ".claude.json",
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
    // diff() still reports `drifted` for any non-empty delta (status semantics
    // are unchanged — other code relies on them); the FIX is the change TYPE.
    expect(result.status).toBe("drifted");
    const pending = result.changes.find((c) => c.name === "tavily");
    expect(pending?.type).toBe("added-in-config");
    // Catalog-ahead must NOT surface as a local removal anywhere.
    expect(result.changes.some((c) => c.type === "removed-locally")).toBe(false);
  });

  test("detects modified server fields", async () => {
    dir = await createTestDir("am-diff-");
    await dir.write(
      ".claude.json",
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
    const modified = result.changes.find((c) => c.name === "tavily" && c.type === "modified");
    expect(modified).toBeDefined();
    expect(modified?.details).toBeDefined();
    expect(modified?.details?.some((d) => d.field === "args")).toBe(true);
  });

  test("returns unmanaged when no native file", async () => {
    dir = await createTestDir("am-diff-");
    // No .claude.json written

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
    dir = await createTestDir("am-diff-");
    // Write env with keys in different order than resolved config
    await dir.write(
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          svc: {
            command: "my-mcp",
            env: { B_KEY: "2", A_KEY: "1" },
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
    // Should be in-sync despite different key order
    expect(result.status).toBe("in-sync");
    expect(result.changes).toHaveLength(0);
  });

  test("detects env changes", async () => {
    dir = await createTestDir("am-diff-");
    await dir.write(
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          svc: {
            command: "my-mcp",
            env: { API_KEY: "old-value" },
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
});
