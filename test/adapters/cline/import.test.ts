import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { importConfig } from "@/adapters/cline/import.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

const SETTINGS_REL = join(
  "Library",
  "Application Support",
  "Code",
  "User",
  "globalStorage",
  "saoudrizwan.claude-dev",
  "settings",
  "cline_mcp_settings.json",
);

describe("cline importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports servers from cline_mcp_settings.json", async () => {
    dir = await createTestDir("am-cline-import-");
    await dir.write(
      SETTINGS_REL,
      JSON.stringify({
        mcpServers: {
          fetch: {
            command: "uvx",
            args: ["mcp-server-fetch"],
            env: { API_KEY: "test" },
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("fetch");
    expect(result.servers[0].command).toBe("uvx");
    expect(result.servers[0].args).toEqual(["mcp-server-fetch"]);
    expect(result.servers[0].env).toEqual({ API_KEY: "test" });
    expect(result.servers[0].scope).toBe("global");
  });

  test("imports alwaysAllow into adapterExtras", async () => {
    dir = await createTestDir("am-cline-import-");
    await dir.write(
      SETTINGS_REL,
      JSON.stringify({
        mcpServers: {
          server1: {
            command: "node",
            args: ["server.js"],
            alwaysAllow: ["tool1", "tool2"],
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].adapterExtras?.alwaysAllow).toEqual(["tool1", "tool2"]);
  });

  test("marks disabled servers", async () => {
    dir = await createTestDir("am-cline-import-");
    await dir.write(
      SETTINGS_REL,
      JSON.stringify({
        mcpServers: {
          disabled: { command: "node", disabled: true },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].enabled).toBe(false);
    expect(result.servers[0].adapterExtras?.disabled).toBe(true);
  });

  test("imports multiple servers", async () => {
    dir = await createTestDir("am-cline-import-");
    await dir.write(
      SETTINGS_REL,
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          tavily: {
            command: "bunx",
            args: ["tavily-mcp@latest"],
            env: { TAVILY_KEY: "key" },
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(2);
    expect(result.servers.find((s) => s.name === "fetch")).toBeDefined();
    expect(result.servers.find((s) => s.name === "tavily")).toBeDefined();
  });

  test("imports .clinerules directory (modern format)", async () => {
    dir = await createTestDir("am-cline-import-");
    await dir.write(SETTINGS_REL, JSON.stringify({ mcpServers: {} }));
    const projectDir = join(dir.path, "project");
    await dir.write("project/.clinerules/coding.md", "Use functional components.");
    await dir.write("project/.clinerules/testing.md", "Always write tests.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(2);
    expect(result.instructions.some((i) => i.content.includes("functional"))).toBe(true);
    expect(result.instructions.some((i) => i.content.includes("tests"))).toBe(true);
  });

  test("imports .clinerules single file (legacy format)", async () => {
    dir = await createTestDir("am-cline-import-");
    await dir.write(SETTINGS_REL, JSON.stringify({ mcpServers: {} }));
    const projectDir = join(dir.path, "project");
    await dir.write("project/.clinerules", "Use strict mode always.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("cline-rules");
    expect(result.instructions[0].content).toContain("strict mode");
  });

  test("handles missing settings file gracefully", async () => {
    dir = await createTestDir("am-cline-import-");
    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("handles malformed JSON gracefully", async () => {
    dir = await createTestDir("am-cline-import-");
    await dir.write(SETTINGS_REL, "{ not valid json ]]]");

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSON"))).toBe(true);
  });

  test("skips non-md files in .clinerules directory", async () => {
    dir = await createTestDir("am-cline-import-");
    await dir.write(SETTINGS_REL, JSON.stringify({ mcpServers: {} }));
    const projectDir = join(dir.path, "project");
    await dir.write("project/.clinerules/coding.md", "Rules here.");
    await dir.write("project/.clinerules/notes.txt", "Not a rule.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("cline-rule-coding");
  });

  test("skips servers without command field", async () => {
    dir = await createTestDir("am-cline-import-");
    await dir.write(
      SETTINGS_REL,
      JSON.stringify({
        mcpServers: {
          valid: { command: "node", args: ["server.js"] },
          invalid: { args: ["no-command"] },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("valid");
  });
});
