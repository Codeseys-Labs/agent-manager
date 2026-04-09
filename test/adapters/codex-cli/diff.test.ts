import { afterEach, describe, expect, test } from "bun:test";
import { diffConfig } from "@/adapters/codex-cli/diff.ts";
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

describe("codex-cli diffConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("in-sync when native matches resolved", async () => {
    dir = await createTestDir("am-codex-diff-");
    await dir.write(
      ".codex/config.toml",
      `
[mcp_servers.ctx]
command = "npx"
args = ["-y", "context7-mcp"]
`,
    );

    const cfg = config({
      servers: {
        ctx: server({
          name: "ctx",
          command: "npx",
          args: ["-y", "context7-mcp"],
        }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("in-sync");
    expect(result.changes).toHaveLength(0);
  });

  test("detects server added locally", async () => {
    dir = await createTestDir("am-codex-diff-");
    await dir.write(
      ".codex/config.toml",
      `
[mcp_servers.ctx]
command = "npx"
args = ["-y", "context7-mcp"]

[mcp_servers.extra]
command = "extra-mcp"
`,
    );

    const cfg = config({
      servers: {
        ctx: server({
          name: "ctx",
          command: "npx",
          args: ["-y", "context7-mcp"],
        }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("drifted");
    const added = result.changes.find((c) => c.name === "extra" && c.type === "added-locally");
    expect(added).toBeDefined();
  });

  test("detects server removed locally", async () => {
    dir = await createTestDir("am-codex-diff-");
    await dir.write(
      ".codex/config.toml",
      `
[mcp_servers.ctx]
command = "npx"
args = ["-y", "context7-mcp"]
`,
    );

    const cfg = config({
      servers: {
        ctx: server({
          name: "ctx",
          command: "npx",
          args: ["-y", "context7-mcp"],
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
    dir = await createTestDir("am-codex-diff-");
    await dir.write(
      ".codex/config.toml",
      `
[mcp_servers.ctx]
command = "npx"
args = ["-y", "context7-mcp@0.9.0"]
`,
    );

    const cfg = config({
      servers: {
        ctx: server({
          name: "ctx",
          command: "npx",
          args: ["-y", "context7-mcp@latest"],
        }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("drifted");
    const modified = result.changes.find((c) => c.name === "ctx" && c.type === "modified");
    expect(modified).toBeDefined();
    expect(modified?.details).toBeDefined();
    expect(modified?.details?.some((d) => d.field === "args")).toBe(true);
  });

  test("returns unmanaged when no native file", async () => {
    dir = await createTestDir("am-codex-diff-");
    // No .codex/config.toml written

    const cfg = config({
      servers: {
        ctx: server({ name: "ctx", command: "npx" }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("unmanaged");
    expect(result.changes).toHaveLength(0);
  });

  test("normalizes key order for comparison", async () => {
    dir = await createTestDir("am-codex-diff-");
    await dir.write(
      ".codex/config.toml",
      `
[mcp_servers.svc]
command = "my-mcp"

[mcp_servers.svc.env]
B_KEY = "2"
A_KEY = "1"
`,
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
    dir = await createTestDir("am-codex-diff-");
    await dir.write(
      ".codex/config.toml",
      `
[mcp_servers.svc]
command = "my-mcp"

[mcp_servers.svc.env]
API_KEY = "old-value"
`,
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

  test("handles HTTP server diff via url field", async () => {
    dir = await createTestDir("am-codex-diff-");
    await dir.write(
      ".codex/config.toml",
      `
[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
`,
    );

    const cfg = config({
      servers: {
        figma: server({
          name: "figma",
          command: "https://mcp.figma.com/mcp",
          transport: "streamable-http",
        }),
      },
    });

    const result = diffConfig(cfg, {}, dir.path);
    expect(result.status).toBe("in-sync");
  });
});
