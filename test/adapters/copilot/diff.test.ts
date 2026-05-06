import { afterEach, describe, expect, test } from "bun:test";
import { diffConfig } from "@/adapters/copilot/diff.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

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

describe("copilot diffConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("in-sync when native matches resolved", async () => {
    dir = await createTestDir("am-cp-diff-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.vscode/mcp.json",
      JSON.stringify({
        servers: {
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

    const result = diffConfig(cfg, { projectPath: projectDir });
    expect(result.status).toBe("in-sync");
    expect(result.changes).toHaveLength(0);
  });

  test("detects server added locally", async () => {
    dir = await createTestDir("am-cp-diff-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.vscode/mcp.json",
      JSON.stringify({
        servers: {
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

    const result = diffConfig(cfg, { projectPath: projectDir });
    expect(result.status).toBe("drifted");
    const added = result.changes.find((c) => c.name === "extra" && c.type === "added-locally");
    expect(added).toBeDefined();
  });

  test("detects server removed locally", async () => {
    dir = await createTestDir("am-cp-diff-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.vscode/mcp.json",
      JSON.stringify({
        servers: {
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

    const result = diffConfig(cfg, { projectPath: projectDir });
    expect(result.status).toBe("drifted");
    const removed = result.changes.find((c) => c.name === "tavily" && c.type === "removed-locally");
    expect(removed).toBeDefined();
  });

  test("detects modified server fields", async () => {
    dir = await createTestDir("am-cp-diff-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.vscode/mcp.json",
      JSON.stringify({
        servers: {
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

    const result = diffConfig(cfg, { projectPath: projectDir });
    expect(result.status).toBe("drifted");
    const modified = result.changes.find((c) => c.name === "tavily" && c.type === "modified");
    expect(modified).toBeDefined();
    expect(modified?.details?.some((d) => d.field === "args")).toBe(true);
  });

  test("returns unmanaged when no native file", async () => {
    dir = await createTestDir("am-cp-diff-");
    const projectDir = `${dir.path}/project`;

    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx" }),
      },
    });

    const result = diffConfig(cfg, { projectPath: projectDir });
    expect(result.status).toBe("unmanaged");
    expect(result.changes).toHaveLength(0);
  });

  test("returns unmanaged when no projectPath", () => {
    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx" }),
      },
    });

    const result = diffConfig(cfg, {});
    expect(result.status).toBe("unmanaged");
  });

  test("reads 'servers' key not 'mcpServers'", async () => {
    dir = await createTestDir("am-cp-diff-");
    const projectDir = `${dir.path}/project`;
    // File has mcpServers instead of servers — should be treated as empty
    await dir.write(
      "project/.vscode/mcp.json",
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

    const result = diffConfig(cfg, { projectPath: projectDir });
    // fetch should show as removed-locally (not in native "servers" key)
    expect(result.status).toBe("drifted");
    const removed = result.changes.find((c) => c.name === "fetch" && c.type === "removed-locally");
    expect(removed).toBeDefined();
  });
});
