import { afterEach, describe, expect, test } from "bun:test";
import { importConfig } from "@/adapters/copilot/import.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("copilot importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports servers from .vscode/mcp.json using 'servers' key", async () => {
    dir = await createTestDir("am-cp-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.vscode/mcp.json",
      JSON.stringify({
        servers: {
          "local-server": {
            command: "npx",
            args: ["-y", "@some/mcp-server"],
          },
          "python-server": {
            command: "uvx",
            args: ["mcp-server-fetch"],
            env: { DEBUG: "true" },
          },
        },
      }),
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].name).toBe("local-server");
    expect(result.servers[0].command).toBe("npx");
    expect(result.servers[0].scope).toBe("project");
    expect(result.servers[0].packageId).toBe("@some/mcp-server");
    expect(result.servers[1].name).toBe("python-server");
    expect(result.servers[1].env).toEqual({ DEBUG: "true" });
  });

  test("imports HTTP servers with type and url", async () => {
    dir = await createTestDir("am-cp-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.vscode/mcp.json",
      JSON.stringify({
        servers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
          },
        },
      }),
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("github");
    expect(result.servers[0].command).toBe("https://api.githubcopilot.com/mcp/");
    expect(result.servers[0].transport).toBe("streamable-http");
    expect(result.servers[0].adapterExtras?.type).toBe("http");
  });

  test("imports global instructions from copilot-instructions.md", async () => {
    dir = await createTestDir("am-cp-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.github/copilot-instructions.md",
      "Use strict TypeScript mode.\nAlways write tests.",
    );

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("copilot-instructions");
    expect(result.instructions[0].scope).toBe("always");
    expect(result.instructions[0].content).toContain("strict TypeScript");
  });

  test("imports scoped instructions with applyTo frontmatter", async () => {
    dir = await createTestDir("am-cp-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.github/instructions/typescript.instructions.md",
      '---\napplyTo: "**/*.ts,**/*.tsx"\n---\n\nUse explicit return types.',
    );

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("typescript");
    expect(result.instructions[0].scope).toBe("glob");
    expect(result.instructions[0].content).toContain("explicit return types");
    expect(result.instructions[0].description).toContain("**/*.ts");
  });

  test("handles missing .vscode/mcp.json gracefully", async () => {
    dir = await createTestDir("am-cp-import-");
    const projectDir = `${dir.path}/project`;
    const result = importConfig({ projectPath: projectDir }, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("File not found");
  });

  test("handles malformed JSON gracefully", async () => {
    dir = await createTestDir("am-cp-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.vscode/mcp.json", "{ not valid }}}");

    const result = importConfig({ projectPath: projectDir }, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSON"))).toBe(true);
  });

  test("ignores non-.instructions.md files in instructions dir", async () => {
    dir = await createTestDir("am-cp-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.github/instructions/readme.md", "This should be ignored.");
    await dir.write(
      "project/.github/instructions/ts.instructions.md",
      '---\napplyTo: "**/*.ts"\n---\n\nUse TS.',
    );

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("ts");
  });

  test("imports instructions without frontmatter as always scope", async () => {
    dir = await createTestDir("am-cp-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.github/instructions/general.instructions.md",
      "Be concise and helpful.",
    );

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].scope).toBe("always");
  });
});
