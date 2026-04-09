import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { importConfig } from "@/adapters/roo-code/import.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

/** Write mcp_settings.json into the fake VS Code globalStorage path. */
async function writeMcpSettings(dir: TestDir, content: string) {
  await dir.write(
    "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json",
    content,
  );
}

describe("roo-code importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports global servers from mcp_settings.json", async () => {
    dir = await createTestDir("am-roo-import-");
    await writeMcpSettings(
      dir,
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          tavily: {
            command: "bunx",
            args: ["tavily-mcp@latest"],
            env: { TAVILY_API_KEY: "test-key" },
          },
        },
      }),
    );

    const result = importConfig({ entities: ["servers"] }, dir.path);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].name).toBe("fetch");
    expect(result.servers[0].command).toBe("uvx");
    expect(result.servers[0].args).toEqual(["mcp-server-fetch"]);
    expect(result.servers[0].scope).toBe("global");
    expect(result.servers[1].env).toEqual({ TAVILY_API_KEY: "test-key" });
  });

  test("imports project servers from .roo/mcp.json", async () => {
    dir = await createTestDir("am-roo-import-");
    await writeMcpSettings(dir, JSON.stringify({ mcpServers: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.roo/mcp.json",
      JSON.stringify({
        mcpServers: {
          "proj-server": { command: "node", args: ["server.js"] },
        },
      }),
    );

    const result = importConfig({ projectPath: projectDir, entities: ["servers"] }, dir.path);
    const proj = result.servers.find((s) => s.name === "proj-server");
    expect(proj).toBeDefined();
    expect(proj?.scope).toBe("project");
  });

  test("marks disabled servers", async () => {
    dir = await createTestDir("am-roo-import-");
    await writeMcpSettings(
      dir,
      JSON.stringify({
        mcpServers: {
          old: { command: "old-mcp", disabled: true },
        },
      }),
    );

    const result = importConfig({ entities: ["servers"] }, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].enabled).toBe(false);
    expect(result.servers[0].adapterExtras?.disabled).toBe(true);
  });

  test("preserves alwaysAllow in adapterExtras", async () => {
    dir = await createTestDir("am-roo-import-");
    await writeMcpSettings(
      dir,
      JSON.stringify({
        mcpServers: {
          fetch: {
            command: "uvx",
            args: ["mcp-server-fetch"],
            alwaysAllow: ["fetch_url"],
          },
        },
      }),
    );

    const result = importConfig({ entities: ["servers"] }, dir.path);
    expect(result.servers[0].adapterExtras?.alwaysAllow).toEqual(["fetch_url"]);
  });

  test("imports shared rules from .roo/rules/", async () => {
    dir = await createTestDir("am-roo-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.roo/rules/code-style.md", "Use TypeScript strict mode.");
    await dir.write("project/.roo/rules/testing.md", "Write tests for all new code.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    const shared = result.instructions.filter((i) => i.name.startsWith("roo-shared-"));
    expect(shared).toHaveLength(2);
    expect(shared.some((r) => r.content.includes("TypeScript strict mode"))).toBe(true);
  });

  test("imports mode-specific rules from .roo/rules-{slug}/", async () => {
    dir = await createTestDir("am-roo-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.roo/rules-code/conventions.md", "Follow project conventions.");
    await dir.write("project/.roo/rules-docs-writer/style.md", "Write clear documentation.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    const codeRules = result.instructions.filter((i) => i.name.startsWith("roo-mode-code-"));
    const docsRules = result.instructions.filter((i) => i.name.startsWith("roo-mode-docs-writer-"));
    expect(codeRules).toHaveLength(1);
    expect(docsRules).toHaveLength(1);
  });

  test("imports legacy .roorules-* files", async () => {
    dir = await createTestDir("am-roo-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.roorules-code", "Legacy Roo rule content.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    const legacy = result.instructions.find((i) => i.name === "roorules-code");
    expect(legacy).toBeDefined();
    expect(legacy?.content).toBe("Legacy Roo rule content.");
  });

  test("imports legacy .clinerules-* files", async () => {
    dir = await createTestDir("am-roo-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.clinerules-architect", "Legacy Cline rule content.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    const legacy = result.instructions.find((i) => i.name === "clinerules-architect");
    expect(legacy).toBeDefined();
    expect(legacy?.content).toBe("Legacy Cline rule content.");
  });

  test("handles missing mcp_settings.json gracefully", async () => {
    dir = await createTestDir("am-roo-import-");
    const result = importConfig({ entities: ["servers"] }, dir.path);
    expect(result.servers).toHaveLength(0);
  });

  test("handles malformed JSON gracefully", async () => {
    dir = await createTestDir("am-roo-import-");
    await writeMcpSettings(dir, "{ not valid json ]]]");

    const result = importConfig({ entities: ["servers"] }, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSON"))).toBe(true);
  });
});
