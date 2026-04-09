import { afterEach, describe, expect, test } from "bun:test";
import { importConfig } from "@/adapters/forgecode/import.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("forgecode importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports servers from .mcp.json", async () => {
    dir = await createTestDir("am-fc-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.mcp.json",
      JSON.stringify({
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

    const result = importConfig({ projectPath: projectDir }, dir.path);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].name).toBe("fetch");
    expect(result.servers[0].command).toBe("uvx");
    expect(result.servers[0].scope).toBe("project");
    expect(result.servers[0].packageId).toBe("mcp-server-fetch");
    expect(result.servers[1].name).toBe("tavily");
    expect(result.servers[1].packageId).toBe("tavily-mcp");
  });

  test("imports AGENTS.md as instruction", async () => {
    dir = await createTestDir("am-fc-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/AGENTS.md", "# Guidelines\n\nUse strict mode.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("agents-md");
    expect(result.instructions[0].content).toContain("Use strict mode");
    expect(result.instructions[0].scope).toBe("always");
  });

  test("falls back to ~/forge/AGENTS.md if no project AGENTS.md", async () => {
    dir = await createTestDir("am-fc-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.keep", "");
    await dir.write("forge/AGENTS.md", "# Global Guidelines\n\nGlobal rules here.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].content).toContain("Global rules here");
  });

  test("handles missing .mcp.json gracefully", async () => {
    dir = await createTestDir("am-fc-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.keep", "");

    const result = importConfig({ projectPath: projectDir, entities: ["servers"] }, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("File not found");
  });

  test("handles malformed JSON gracefully", async () => {
    dir = await createTestDir("am-fc-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.mcp.json", "{ not valid json ]]]");

    const result = importConfig({ projectPath: projectDir }, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSON"))).toBe(true);
  });

  test("marks disabled servers (disable: true)", async () => {
    dir = await createTestDir("am-fc-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.mcp.json",
      JSON.stringify({
        mcpServers: {
          disabled_server: {
            command: "some-mcp",
            disable: true,
          },
        },
      }),
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    expect(result.servers[0].enabled).toBe(false);
  });

  test("imports skills from .forge/skills/", async () => {
    dir = await createTestDir("am-fc-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.forge/skills/my-skill/SKILL.md", "# My Skill\n\nDo the thing.");

    const result = importConfig({ projectPath: projectDir, entities: ["skills"] }, dir.path);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("my-skill");
    expect(result.skills[0].path).toContain("SKILL.md");
  });

  test("imports from fixture files", async () => {
    dir = await createTestDir("am-fc-import-fixture-");
    const fs = require("node:fs");
    const { join } = require("node:path");
    const fixtureDir = join(import.meta.dir, "../../fixtures/forgecode");

    const projectDir = `${dir.path}/project`;
    const sampleMcp = fs.readFileSync(join(fixtureDir, "sample-mcp.json"), "utf-8");
    await dir.write("project/.mcp.json", sampleMcp);

    const sampleAgentsMd = fs.readFileSync(join(fixtureDir, "sample-AGENTS.md"), "utf-8");
    await dir.write("project/AGENTS.md", sampleAgentsMd);

    const result = importConfig({ projectPath: projectDir }, dir.path);
    // 3 servers from sample-mcp.json (fetch, tavily, disabled-server)
    expect(result.servers).toHaveLength(3);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].content).toContain("TypeScript strict mode");

    // disabled-server should have enabled=false
    const disabled = result.servers.find((s) => s.name === "disabled-server");
    expect(disabled).toBeDefined();
    expect(disabled?.enabled).toBe(false);
  });
});
