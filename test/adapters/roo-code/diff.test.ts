import { afterEach, describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { getGlobalStoragePath } from "@/adapters/roo-code/detect.ts";
import { diffConfig } from "@/adapters/roo-code/diff.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

function settingsRel(home: string): string {
  return join(relative(home, getGlobalStoragePath(home)), "settings", "mcp_settings.json");
}

function makeResolved(servers: Record<string, ResolvedServer>): ResolvedConfig {
  return {
    servers,
    instructions: {},
    skills: {},
    agents: {},
    profile: "default",
    adapters: {},
  };
}

function makeServer(
  overrides: Partial<ResolvedServer> & { name: string; command: string },
): ResolvedServer {
  return {
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

/** Write mcp_settings.json into the fake VS Code globalStorage path. */
async function writeMcpSettings(dir: TestDir, content: string) {
  await dir.write(settingsRel(dir.path), content);
}

describe("roo-code diffConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("returns unmanaged when mcp_settings.json does not exist", async () => {
    dir = await createTestDir("am-roo-diff-");
    const resolved = makeResolved({});
    const result = diffConfig(resolved, {}, dir.path);
    expect(result.status).toBe("unmanaged");
  });

  test("shows in-sync when configs match", async () => {
    dir = await createTestDir("am-roo-diff-");
    await writeMcpSettings(
      dir,
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
        },
      }),
    );

    const resolved = makeResolved({
      fetch: makeServer({
        name: "fetch",
        command: "uvx",
        args: ["mcp-server-fetch"],
      }),
    });

    const result = diffConfig(resolved, {}, dir.path);
    expect(result.status).toBe("in-sync");
    expect(result.changes).toHaveLength(0);
  });

  test("detects server added locally", async () => {
    dir = await createTestDir("am-roo-diff-");
    await writeMcpSettings(
      dir,
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          extra: { command: "extra-mcp" },
        },
      }),
    );

    const resolved = makeResolved({
      fetch: makeServer({
        name: "fetch",
        command: "uvx",
        args: ["mcp-server-fetch"],
      }),
    });

    const result = diffConfig(resolved, {}, dir.path);
    expect(result.status).toBe("drifted");
    const added = result.changes.find((c) => c.name === "extra" && c.type === "added-locally");
    expect(added).toBeDefined();
  });

  test("detects server removed locally", async () => {
    dir = await createTestDir("am-roo-diff-");
    await writeMcpSettings(dir, JSON.stringify({ mcpServers: {} }));

    const resolved = makeResolved({
      fetch: makeServer({
        name: "fetch",
        command: "uvx",
        args: ["mcp-server-fetch"],
      }),
    });

    const result = diffConfig(resolved, {}, dir.path);
    expect(result.status).toBe("drifted");
    const removed = result.changes.find((c) => c.name === "fetch" && c.type === "removed-locally");
    expect(removed).toBeDefined();
  });

  test("detects modified server (command changed)", async () => {
    dir = await createTestDir("am-roo-diff-");
    await writeMcpSettings(
      dir,
      JSON.stringify({
        mcpServers: {
          fetch: { command: "npx", args: ["mcp-server-fetch"] },
        },
      }),
    );

    const resolved = makeResolved({
      fetch: makeServer({
        name: "fetch",
        command: "uvx",
        args: ["mcp-server-fetch"],
      }),
    });

    const result = diffConfig(resolved, {}, dir.path);
    expect(result.status).toBe("drifted");
    const modified = result.changes.find((c) => c.name === "fetch" && c.type === "modified");
    expect(modified).toBeDefined();
    expect(modified?.details).toBeDefined();
  });

  test("skips disabled native servers", async () => {
    dir = await createTestDir("am-roo-diff-");
    await writeMcpSettings(
      dir,
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          disabled: { command: "old-mcp", disabled: true },
        },
      }),
    );

    const resolved = makeResolved({
      fetch: makeServer({
        name: "fetch",
        command: "uvx",
        args: ["mcp-server-fetch"],
      }),
    });

    const result = diffConfig(resolved, {}, dir.path);
    expect(result.status).toBe("in-sync");
  });

  test("includes project servers from .roo/mcp.json in diff", async () => {
    dir = await createTestDir("am-roo-diff-");
    await writeMcpSettings(dir, JSON.stringify({ mcpServers: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.roo/mcp.json",
      JSON.stringify({
        mcpServers: {
          "proj-extra": { command: "node", args: ["extra.js"] },
        },
      }),
    );

    const resolved = makeResolved({});
    const result = diffConfig(resolved, { projectPath: projectDir }, dir.path);
    expect(result.status).toBe("drifted");
    const added = result.changes.find((c) => c.name === "proj-extra" && c.type === "added-locally");
    expect(added).toBeDefined();
  });
});
