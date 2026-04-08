import { describe, expect, test, afterEach } from "bun:test";
import { createTestDir, type TestDir } from "../../helpers/tmp.ts";
import { importConfig, parseMdc } from "@/adapters/cursor/import.ts";

// ── parseMdc ───────────────────────────────────────────────────

describe("parseMdc()", () => {
  test("parses full frontmatter with body", () => {
    const raw = `---
description: "TypeScript conventions"
globs: ["**/*.ts", "**/*.tsx"]
alwaysApply: false
---

Use strict TypeScript.`;

    const result = parseMdc(raw);
    expect(result.frontmatter.description).toBe("TypeScript conventions");
    expect(result.frontmatter.globs).toEqual(["**/*.ts", "**/*.tsx"]);
    expect(result.frontmatter.alwaysApply).toBe(false);
    expect(result.body).toBe("Use strict TypeScript.");
  });

  test("parses alwaysApply: true", () => {
    const raw = `---
description: "Always on"
alwaysApply: true
---

Content here.`;

    const result = parseMdc(raw);
    expect(result.frontmatter.alwaysApply).toBe(true);
  });

  test("handles missing frontmatter", () => {
    const raw = "Just plain markdown content.";
    const result = parseMdc(raw);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Just plain markdown content.");
  });

  test("handles empty frontmatter", () => {
    const raw = `---
---

Body content.`;

    const result = parseMdc(raw);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Body content.");
  });

  test("handles single-quoted description", () => {
    const raw = `---
description: 'Single quoted'
alwaysApply: false
---

Body.`;

    const result = parseMdc(raw);
    expect(result.frontmatter.description).toBe("Single quoted");
  });
});

// ── importConfig ───────────────────────────────────────────────

describe("cursor importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports global servers from ~/.cursor/mcp.json", async () => {
    dir = await createTestDir("am-cursor-import-");
    await dir.write(
      ".cursor/mcp.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          tavily: {
            command: "bunx",
            args: ["tavily-mcp@latest"],
            env: { TAVILY_API_KEY: "test" },
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

  test("imports project servers from .cursor/mcp.json", async () => {
    dir = await createTestDir("am-cursor-import-");
    await dir.write(
      ".cursor/mcp.json",
      JSON.stringify({ mcpServers: {} }),
    );
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.cursor/mcp.json",
      JSON.stringify({
        mcpServers: {
          "db-mcp": {
            command: "npx",
            args: ["-y", "db-mcp-server"],
            env: { DB_URL: "postgres://localhost" },
          },
        },
      }),
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    const projectServer = result.servers.find((s) => s.name === "db-mcp");
    expect(projectServer).toBeDefined();
    expect(projectServer!.scope).toBe("project");
    expect(projectServer!.env).toEqual({ DB_URL: "postgres://localhost" });
  });

  test("imports URL-based servers with streamable-http transport", async () => {
    dir = await createTestDir("am-cursor-import-");
    await dir.write(
      ".cursor/mcp.json",
      JSON.stringify({
        mcpServers: {
          "remote-api": {
            url: "https://api.example.com/mcp",
            headers: { Authorization: "Bearer token" },
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("remote-api");
    expect(result.servers[0].transport).toBe("streamable-http");
    expect(result.servers[0].adapterExtras?.url).toBe(
      "https://api.example.com/mcp",
    );
    expect(result.servers[0].adapterExtras?.headers).toEqual({
      Authorization: "Bearer token",
    });
  });

  test("imports .mdc rules as instructions", async () => {
    dir = await createTestDir("am-cursor-import-");
    await dir.write(
      ".cursor/mcp.json",
      JSON.stringify({ mcpServers: {} }),
    );
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.cursor/rules/typescript.mdc",
      `---
description: "TypeScript conventions"
globs: ["**/*.ts"]
alwaysApply: false
---

Use strict TypeScript.`,
    );

    const result = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("typescript");
    expect(result.instructions[0].scope).toBe("glob");
    expect(result.instructions[0].description).toBe("TypeScript conventions");
    expect(result.instructions[0].content).toContain("Use strict TypeScript");
  });

  test("imports alwaysApply rules with 'always' scope", async () => {
    dir = await createTestDir("am-cursor-import-");
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.cursor/rules/global.mdc",
      `---
description: "Global rules"
alwaysApply: true
---

Always do this.`,
    );

    const result = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].scope).toBe("always");
  });

  test("imports agent-requested rules (description only, no globs)", async () => {
    dir = await createTestDir("am-cursor-import-");
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.cursor/rules/db.mdc",
      `---
description: "Database patterns"
alwaysApply: false
---

Use Drizzle ORM.`,
    );

    const result = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].scope).toBe("agent-decision");
  });

  test("imports manual rules (empty frontmatter)", async () => {
    dir = await createTestDir("am-cursor-import-");
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.cursor/rules/manual.mdc",
      `---
---

Only used when explicitly referenced.`,
    );

    const result = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].scope).toBe("manual");
  });

  test("imports legacy .cursorrules", async () => {
    dir = await createTestDir("am-cursor-import-");
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.cursorrules",
      "Use strict mode. Legacy rules.",
    );

    const result = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    const legacy = result.instructions.find(
      (i) => i.name === "cursorrules-legacy",
    );
    expect(legacy).toBeDefined();
    expect(legacy!.scope).toBe("always");
    expect(legacy!.content).toContain("Legacy rules");
  });

  test("handles missing file gracefully", async () => {
    dir = await createTestDir("am-cursor-import-");
    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("File not found");
  });

  test("handles malformed JSON gracefully", async () => {
    dir = await createTestDir("am-cursor-import-");
    await dir.write(".cursor/mcp.json", "{ not valid ]]]");

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSON"))).toBe(
      true,
    );
  });

  test("marks disabled servers", async () => {
    dir = await createTestDir("am-cursor-import-");
    await dir.write(
      ".cursor/mcp.json",
      JSON.stringify({
        mcpServers: {
          disabled_one: { command: "some-mcp", disabled: true },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].enabled).toBe(false);
  });
});
