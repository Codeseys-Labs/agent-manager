import { afterEach, describe, expect, test } from "bun:test";
import { importConfig } from "@/adapters/amazon-q/import.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("amazon-q importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports servers from global mcp.json", async () => {
    dir = await createTestDir("am-aq-import-");
    await dir.write(
      ".aws/amazonq/mcp.json",
      JSON.stringify({
        mcpServers: {
          "aws-docs": {
            command: "uvx",
            args: ["awslabs.aws-documentation-mcp-server@latest"],
            env: { FASTMCP_LOG_LEVEL: "ERROR" },
          },
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].name).toBe("aws-docs");
    expect(result.servers[0].command).toBe("uvx");
    expect(result.servers[0].scope).toBe("global");
    expect(result.servers[0].env).toEqual({ FASTMCP_LOG_LEVEL: "ERROR" });
    expect(result.servers[1].name).toBe("fetch");
    expect(result.servers[1].packageId).toBe("mcp-server-fetch");
  });

  test("imports servers from project mcp.json", async () => {
    dir = await createTestDir("am-aq-import-");
    await dir.write(".aws/amazonq/mcp.json", JSON.stringify({ mcpServers: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.amazonq/mcp.json",
      JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["server.js"] },
        },
      }),
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    const projectServer = result.servers.find((s) => s.name === "local");
    expect(projectServer).toBeDefined();
    expect(projectServer?.scope).toBe("project");
  });

  test("imports rule files from .amazonq/rules/", async () => {
    dir = await createTestDir("am-aq-import-");
    await dir.write(".aws/amazonq/mcp.json", JSON.stringify({ mcpServers: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.amazonq/rules/testing.md", "Use describe/test blocks for all tests.");
    await dir.write("project/.amazonq/rules/style.md", "Use TypeScript strict mode.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(2);

    const testing = result.instructions.find((i) => i.name === "testing");
    expect(testing).toBeDefined();
    expect(testing?.content).toBe("Use describe/test blocks for all tests.");
    expect(testing?.scope).toBe("always");
  });

  test("instructions are plain markdown with no frontmatter parsing", async () => {
    dir = await createTestDir("am-aq-import-");
    const projectDir = `${dir.path}/project`;
    const content = "# My Rule\n\nThis is plain markdown.\n\n- item 1\n- item 2";
    await dir.write("project/.amazonq/rules/my-rule.md", content);

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].content).toBe(content);
    expect(result.instructions[0].name).toBe("my-rule");
  });

  test("handles missing mcp.json gracefully", async () => {
    dir = await createTestDir("am-aq-import-");
    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("File not found");
  });

  test("handles malformed JSON gracefully", async () => {
    dir = await createTestDir("am-aq-import-");
    await dir.write(".aws/amazonq/mcp.json", "{ not valid json }}}");

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSON"))).toBe(true);
  });

  test("marks disabled servers", async () => {
    dir = await createTestDir("am-aq-import-");
    await dir.write(
      ".aws/amazonq/mcp.json",
      JSON.stringify({
        mcpServers: {
          disabled_server: { command: "some-mcp", disabled: true },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].enabled).toBe(false);
  });

  test("preserves adapter extras like timeout", async () => {
    dir = await createTestDir("am-aq-import-");
    await dir.write(
      ".aws/amazonq/mcp.json",
      JSON.stringify({
        mcpServers: {
          slow: { command: "uvx", args: ["slow-server"], timeout: 60 },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].adapterExtras).toBeDefined();
    expect(result.servers[0].adapterExtras?.timeout).toBe(60);
  });

  test("skips non-.md files in rules directory", async () => {
    dir = await createTestDir("am-aq-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.amazonq/rules/valid.md", "A rule");
    await dir.write("project/.amazonq/rules/notes.txt", "Not a rule");
    await dir.write("project/.amazonq/rules/.hidden", "Also not a rule");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("valid");
  });
});
