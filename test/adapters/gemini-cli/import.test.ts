import { afterEach, describe, expect, test } from "bun:test";
import { importConfig } from "@/adapters/gemini-cli/import.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("gemini-cli importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports servers from ~/.gemini/settings.json", async () => {
    dir = await createTestDir("am-gc-import-");
    await dir.write(
      ".gemini/settings.json",
      JSON.stringify({
        model: { name: "gemini-2.5-pro" },
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
    expect(result.servers[1].name).toBe("tavily");
    expect(result.servers[1].env).toEqual({
      TAVILY_API_KEY: "${TAVILY_API_KEY}",
    });
  });

  test("imports .gemini/settings.json as project-scoped", async () => {
    dir = await createTestDir("am-gc-import-");
    // Need a global config to avoid warning noise
    await dir.write(".gemini/settings.json", JSON.stringify({ mcpServers: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.gemini/settings.json",
      JSON.stringify({
        mcpServers: {
          "project-mcp": {
            command: "project-mcp-server",
            env: { PROJECT_KEY: "abc" },
          },
        },
      }),
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    const projectServer = result.servers.find((s) => s.name === "project-mcp");
    expect(projectServer).toBeDefined();
    expect(projectServer?.scope).toBe("project");
    expect(projectServer?.env).toEqual({ PROJECT_KEY: "abc" });
  });

  test("imports GEMINI.md as instruction", async () => {
    dir = await createTestDir("am-gc-import-");
    await dir.write(".gemini/settings.json", JSON.stringify({ mcpServers: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write("project/GEMINI.md", "# Instructions\n\nUse strict mode.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("gemini-md");
    expect(result.instructions[0].content).toContain("Use strict mode");
    expect(result.instructions[0].scope).toBe("always");
  });

  test("handles missing file gracefully", async () => {
    dir = await createTestDir("am-gc-import-");
    // No .gemini/settings.json at all
    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("File not found");
  });

  test("handles malformed JSON gracefully", async () => {
    dir = await createTestDir("am-gc-import-");
    await dir.write(".gemini/settings.json", "{ not valid json ]]]");

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSON"))).toBe(true);
  });

  test("preserves adapter extras (timeout, trust, etc.)", async () => {
    dir = await createTestDir("am-gc-import-");
    await dir.write(
      ".gemini/settings.json",
      JSON.stringify({
        mcpServers: {
          trusted: {
            command: "my-mcp",
            trust: true,
            timeout: 60000,
            includeTools: ["tool1"],
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].adapterExtras).toBeDefined();
    expect(result.servers[0].adapterExtras?.trust).toBe(true);
    expect(result.servers[0].adapterExtras?.timeout).toBe(60000);
    expect(result.servers[0].adapterExtras?.includeTools).toEqual(["tool1"]);
  });

  test("all servers are enabled (Gemini has no disabled flag)", async () => {
    dir = await createTestDir("am-gc-import-");
    await dir.write(
      ".gemini/settings.json",
      JSON.stringify({
        mcpServers: {
          svc: { command: "some-mcp" },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].enabled).toBe(true);
  });

  test("silently skips when GEMINI.md is missing", async () => {
    dir = await createTestDir("am-gc-import-");
    await dir.write(".gemini/settings.json", JSON.stringify({ mcpServers: {} }));
    const projectDir = `${dir.path}/project`;
    // No GEMINI.md created — should not produce a warning

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("GEMINI.md"))).toBe(false);
  });

  test("skips entries without command", async () => {
    dir = await createTestDir("am-gc-import-");
    await dir.write(
      ".gemini/settings.json",
      JSON.stringify({
        mcpServers: {
          valid: { command: "my-mcp" },
          invalid: { args: ["no-command"] },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("valid");
  });
});
