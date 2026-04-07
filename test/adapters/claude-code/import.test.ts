import { describe, expect, test, afterEach } from "bun:test";
import { createTestDir, type TestDir } from "../../helpers/tmp.ts";
import { importConfig } from "@/adapters/claude-code/import.ts";
import { extractPackageId } from "@/adapters/claude-code/identity.ts";

// ── extractPackageId ────────────────────────────────────────────

describe("extractPackageId()", () => {
  test("extracts package from npx command", () => {
    expect(extractPackageId("npx", ["-y", "tavily-mcp@latest"])).toBe(
      "tavily-mcp",
    );
  });

  test("extracts package from bunx command", () => {
    expect(extractPackageId("bunx", ["tavily-mcp@latest"])).toBe("tavily-mcp");
  });

  test("extracts scoped package from bunx", () => {
    expect(
      extractPackageId("bunx", ["@upstash/context7-mcp@latest"]),
    ).toBe("@upstash/context7-mcp");
  });

  test("extracts package from uvx command", () => {
    expect(extractPackageId("uvx", ["mcp-server-fetch"])).toBe(
      "mcp-server-fetch",
    );
  });

  test("extracts hostname from --endpoint URL (proxy-wrapped)", () => {
    expect(
      extractPackageId("uvx", [
        "mcp-proxy",
        "--endpoint",
        "https://mcp.exa.ai/sse",
      ]),
    ).toBe("mcp.exa.ai");
  });

  test("returns command basename for non-runner commands", () => {
    expect(extractPackageId("aws-outlook-mcp")).toBe("aws-outlook-mcp");
  });

  test("returns basename from full path", () => {
    expect(extractPackageId("/usr/local/bin/aws-outlook-mcp")).toBe(
      "aws-outlook-mcp",
    );
  });

  test("handles pipx runner", () => {
    expect(extractPackageId("pipx", ["run", "my-mcp-server"])).toBe(
      "my-mcp-server",
    );
  });

  test("returns undefined for empty command", () => {
    expect(extractPackageId("")).toBeUndefined();
  });
});

// ── importConfig ────────────────────────────────────────────────

describe("importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports servers from ~/.claude.json", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(
      ".claude.json",
      JSON.stringify({
        numStartups: 42,
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          tavily: {
            command: "bunx",
            args: ["tavily-mcp@latest"],
            env: { TAVILY_API_KEY: "${TAVILY_API_KEY}" },
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].name).toBe("fetch");
    expect(result.servers[0].command).toBe("uvx");
    expect(result.servers[0].scope).toBe("global");
    expect(result.servers[0].packageId).toBe("mcp-server-fetch");
    expect(result.servers[1].name).toBe("tavily");
    expect(result.servers[1].packageId).toBe("tavily-mcp");
  });

  test("imports .mcp.json as project-scoped", async () => {
    dir = await createTestDir("am-import-");
    // Need a global config to avoid warning noise
    await dir.write(".claude.json", JSON.stringify({ mcpServers: {} }));
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.mcp.json",
      JSON.stringify({
        mcpServers: {
          "aws-outlook-mcp": {
            command: "aws-outlook-mcp",
            env: { MIDWAY_AUTH: "true" },
          },
        },
      }),
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    const projectServer = result.servers.find(
      (s) => s.name === "aws-outlook-mcp",
    );
    expect(projectServer).toBeDefined();
    expect(projectServer!.scope).toBe("project");
    expect(projectServer!.env).toEqual({ MIDWAY_AUTH: "true" });
  });

  test("imports CLAUDE.md as instruction", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(".claude.json", JSON.stringify({ mcpServers: {} }));
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/CLAUDE.md",
      "# Instructions\n\nUse strict mode.",
    );

    const result = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("claude-md");
    expect(result.instructions[0].content).toContain("Use strict mode");
    expect(result.instructions[0].scope).toBe("always");
  });

  test("handles missing file gracefully", async () => {
    dir = await createTestDir("am-import-");
    // No .claude.json at all
    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("File not found");
  });

  test("handles malformed JSON gracefully", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(".claude.json", "{ not valid json ]]]");

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSON"))).toBe(
      true,
    );
  });

  test("preserves adapter extras (alwaysAllow etc.)", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          outlook: {
            command: "aws-outlook-mcp",
            always_allow: ["email_search", "calendar_view"],
            some_custom_field: true,
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].adapterExtras).toBeDefined();
    expect(result.servers[0].adapterExtras!.always_allow).toEqual([
      "email_search",
      "calendar_view",
    ]);
    expect(result.servers[0].adapterExtras!.some_custom_field).toBe(true);
  });

  test("marks disabled servers", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          disabled_server: {
            command: "some-mcp",
            disabled: true,
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].enabled).toBe(false);
  });

  test("imports from .claude/CLAUDE.md if no root CLAUDE.md", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(".claude.json", JSON.stringify({ mcpServers: {} }));
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.claude/CLAUDE.md",
      "# Hidden instructions\n\nFrom .claude dir.",
    );

    const result = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].content).toContain("Hidden instructions");
  });
});
