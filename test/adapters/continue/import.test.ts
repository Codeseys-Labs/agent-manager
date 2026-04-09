import { afterEach, describe, expect, test } from "bun:test";
import { importConfig } from "@/adapters/continue/import.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("continue importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports servers from config.json (array format)", async () => {
    dir = await createTestDir("am-ct-import-");
    await dir.write(
      ".continue/config.json",
      JSON.stringify({
        mcpServers: [
          {
            name: "sqlite",
            command: "uvx",
            args: ["mcp-server-sqlite", "--db-path", "./test.db"],
            env: { NODE_ENV: "production" },
          },
          {
            name: "fetch",
            command: "uvx",
            args: ["mcp-server-fetch"],
          },
        ],
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].name).toBe("sqlite");
    expect(result.servers[0].command).toBe("uvx");
    expect(result.servers[0].args).toEqual(["mcp-server-sqlite", "--db-path", "./test.db"]);
    expect(result.servers[0].env).toEqual({ NODE_ENV: "production" });
    expect(result.servers[0].scope).toBe("global");
    expect(result.servers[1].name).toBe("fetch");
    expect(result.servers[1].packageId).toBe("mcp-server-fetch");
  });

  test("imports servers from project config.json", async () => {
    dir = await createTestDir("am-ct-import-");
    await dir.write(".continue/config.json", JSON.stringify({ mcpServers: [] }));
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.continue/config.json",
      JSON.stringify({
        mcpServers: [{ name: "local", command: "node", args: ["server.js"] }],
      }),
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    const projectServer = result.servers.find((s) => s.name === "local");
    expect(projectServer).toBeDefined();
    expect(projectServer?.scope).toBe("project");
  });

  test("imports rules with uses references", async () => {
    dir = await createTestDir("am-ct-import-");
    await dir.write(
      ".continue/config.json",
      JSON.stringify({
        mcpServers: [],
        rules: [{ uses: "org/ruleset-name" }, { uses: "file://path/to/rules.md" }],
      }),
    );

    const result = importConfig({ entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(2);
    expect(result.instructions[0].name).toBe("ruleset-name");
    expect(result.instructions[0].content).toBe("org/ruleset-name");
    expect(result.instructions[1].name).toBe("rules");
    expect(result.instructions[1].content).toBe("file://path/to/rules.md");
  });

  test("handles missing config.json gracefully", async () => {
    dir = await createTestDir("am-ct-import-");
    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("File not found");
  });

  test("handles malformed JSON gracefully", async () => {
    dir = await createTestDir("am-ct-import-");
    await dir.write(".continue/config.json", "{ not valid json }}}");

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSON"))).toBe(true);
  });

  test("skips entries without name field", async () => {
    dir = await createTestDir("am-ct-import-");
    await dir.write(
      ".continue/config.json",
      JSON.stringify({
        mcpServers: [
          { command: "uvx", args: ["no-name-server"] },
          { name: "valid", command: "uvx", args: ["valid-server"] },
        ],
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("valid");
  });

  test("preserves adapter extras like cwd", async () => {
    dir = await createTestDir("am-ct-import-");
    await dir.write(
      ".continue/config.json",
      JSON.stringify({
        mcpServers: [
          {
            name: "proj",
            command: "node",
            args: ["server.js"],
            cwd: "/path/to/project",
          },
        ],
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].adapterExtras).toBeDefined();
    expect(result.servers[0].adapterExtras?.cwd).toBe("/path/to/project");
  });

  test("handles empty mcpServers array", async () => {
    dir = await createTestDir("am-ct-import-");
    await dir.write(".continue/config.json", JSON.stringify({ mcpServers: [] }));

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
