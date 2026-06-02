import { afterEach, describe, expect, test } from "bun:test";
import { importConfig } from "@/adapters/windsurf/import.ts";
import { toPosix } from "../../helpers/path.ts";
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

  test("imports AGENTS.md as instruction", async () => {
    dir = await createTestDir("am-ws-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/AGENTS.md", "# Agent Instructions\n\nUse strict mode.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    const agentsMd = result.instructions.find((i) => i.name === "agents-md");
    expect(agentsMd).toBeDefined();
    expect(agentsMd?.content).toContain("Use strict mode.");
    expect(agentsMd?.scope).toBe("always");
    expect(agentsMd?.sourcePath).toContain("AGENTS.md");
  });

  test("imports skill directories from .windsurf/skills/", async () => {
    dir = await createTestDir("am-ws-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.windsurf/skills/research/SKILL.md",
      "# Research Skill\n\nDoes research.",
    );
    await dir.write(
      "project/.windsurf/skills/deploy/SKILL.md",
      "# Deploy Skill\n\nDeploys things.",
    );

    const result = importConfig({ projectPath: projectDir, entities: ["skills"] }, dir.path);
    expect(result.skills).toHaveLength(2);
    const research = result.skills.find((s) => s.name === "research");
    expect(research).toBeDefined();
    expect(research?.description).toBe("Research Skill");
    expect(toPosix(research?.path ?? "")).toContain(".windsurf/skills/research");
  });

  test("imports standalone skill .md files", async () => {
    dir = await createTestDir("am-ws-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.windsurf/skills/quick-task.md", "# Quick Task\n\nA simple skill.");

    const result = importConfig({ projectPath: projectDir, entities: ["skills"] }, dir.path);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("quick-task");
    expect(result.skills[0].description).toBe("Quick Task");
  });

  test("skips skill directories without SKILL.md", async () => {
    dir = await createTestDir("am-ws-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.windsurf/skills/broken/.keep", "");

    const result = importConfig({ projectPath: projectDir, entities: ["skills"] }, dir.path);
    expect(result.skills).toHaveLength(0);
  });

  test("returns empty skills when .windsurf/skills/ does not exist", async () => {
    dir = await createTestDir("am-ws-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.keep", "");

    const result = importConfig({ projectPath: projectDir, entities: ["skills"] }, dir.path);
    expect(result.skills).toHaveLength(0);
  });
});
