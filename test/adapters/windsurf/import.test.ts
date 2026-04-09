import { afterEach, describe, expect, test } from "bun:test";
import { importConfig } from "@/adapters/windsurf/import.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("windsurf importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports servers from mcp_config.json", async () => {
    dir = await createTestDir("am-ws-import-");
    await dir.write(
      ".codeium/windsurf/mcp_config.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          tavily: {
            command: "bunx",
            args: ["tavily-mcp@latest"],
            env: { TAVILY_API_KEY: "${env:TAVILY_API_KEY}" },
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
    expect(result.servers[1].env).toEqual({
      TAVILY_API_KEY: "${env:TAVILY_API_KEY}",
    });
  });

  test("imports rule files from .windsurf/rules/", async () => {
    dir = await createTestDir("am-ws-import-");
    await dir.write(".codeium/windsurf/mcp_config.json", JSON.stringify({ mcpServers: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.windsurf/rules/testing.md",
      '---\ntrigger: glob\nglobs: "**/*.test.ts"\n---\n\nUse describe/test blocks.',
    );

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("testing");
    expect(result.instructions[0].scope).toBe("glob");
    expect(result.instructions[0].content).toContain("describe/test");
  });

  test("imports always_on rules", async () => {
    dir = await createTestDir("am-ws-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.windsurf/rules/general.md",
      "---\ntrigger: always_on\n---\n\nBe concise.",
    );

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].scope).toBe("always");
  });

  test("imports legacy .windsurfrules", async () => {
    dir = await createTestDir("am-ws-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.windsurfrules", "Use strict mode.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    const legacy = result.instructions.find((i) => i.name === "windsurfrules-legacy");
    expect(legacy).toBeDefined();
    expect(legacy?.content).toBe("Use strict mode.");
    expect(legacy?.scope).toBe("always");
  });

  test("handles missing mcp_config.json gracefully", async () => {
    dir = await createTestDir("am-ws-import-");
    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("File not found");
  });

  test("handles malformed JSON gracefully", async () => {
    dir = await createTestDir("am-ws-import-");
    await dir.write(".codeium/windsurf/mcp_config.json", "{ not valid json }}}");

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSON"))).toBe(true);
  });

  test("marks disabled servers", async () => {
    dir = await createTestDir("am-ws-import-");
    await dir.write(
      ".codeium/windsurf/mcp_config.json",
      JSON.stringify({
        mcpServers: {
          disabled_server: { command: "some-mcp", disabled: true },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].enabled).toBe(false);
  });

  test("imports model_decision rules as agent-decision scope", async () => {
    dir = await createTestDir("am-ws-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.windsurf/rules/context.md",
      "---\ntrigger: model_decision\n---\n\nLLM decides when to use this.",
    );

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions[0].scope).toBe("agent-decision");
  });
});
