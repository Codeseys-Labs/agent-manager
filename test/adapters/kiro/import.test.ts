import { describe, expect, test, afterEach } from "bun:test";
import { createTestDir, type TestDir } from "../../helpers/tmp.ts";
import { importConfig } from "@/adapters/kiro/import.ts";
import { extractPackageId } from "@/adapters/kiro/identity.ts";

// ── extractPackageId ────────────────────────────────────────────

describe("kiro extractPackageId()", () => {
  test("extracts package from npx command", () => {
    expect(extractPackageId("npx", ["-y", "tavily-mcp@latest"])).toBe(
      "tavily-mcp",
    );
  });

  test("extracts scoped package from bunx", () => {
    expect(
      extractPackageId("bunx", ["@upstash/context7-mcp@latest"]),
    ).toBe("@upstash/context7-mcp");
  });

  test("extracts hostname from --endpoint URL", () => {
    expect(
      extractPackageId("uvx", [
        "mcp-proxy",
        "--endpoint",
        "https://mcp.exa.ai/sse",
      ]),
    ).toBe("mcp.exa.ai");
  });

  test("returns command basename for non-runner commands", () => {
    expect(extractPackageId("aws-outlook-mcp")).toBe("aws-outlook-mcp");
  });

  test("returns undefined for empty command", () => {
    expect(extractPackageId("")).toBeUndefined();
  });
});

// ── importConfig ────────────────────────────────────────────────

describe("kiro importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports servers from ~/.kiro/settings/mcp.json", async () => {
    dir = await createTestDir("am-kiro-import-");
    await dir.write(
      ".kiro/settings/mcp.json",
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

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].name).toBe("fetch");
    expect(result.servers[0].command).toBe("uvx");
    expect(result.servers[0].scope).toBe("global");
    expect(result.servers[0].packageId).toBe("mcp-server-fetch");
    expect(result.servers[1].name).toBe("tavily");
    expect(result.servers[1].packageId).toBe("tavily-mcp");
  });

  test("imports project-scoped servers", async () => {
    dir = await createTestDir("am-kiro-import-");
    await dir.write(
      ".kiro/settings/mcp.json",
      JSON.stringify({ mcpServers: {} }),
    );
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.kiro/settings/mcp.json",
      JSON.stringify({
        mcpServers: {
          "local-mcp": {
            command: "my-local-mcp",
            env: { PORT: "3000" },
          },
        },
      }),
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    const projectServer = result.servers.find(
      (s) => s.name === "local-mcp",
    );
    expect(projectServer).toBeDefined();
    expect(projectServer!.scope).toBe("project");
    expect(projectServer!.env).toEqual({ PORT: "3000" });
  });

  test("imports HTTP/remote servers with url field", async () => {
    dir = await createTestDir("am-kiro-import-");
    await dir.write(
      ".kiro/settings/mcp.json",
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "https://mcp.example.com/api",
            headers: { Authorization: "Bearer tok" },
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].command).toBe("https://mcp.example.com/api");
    expect(result.servers[0].transport).toBe("streamable-http");
    expect(result.servers[0].adapterExtras!.headers).toEqual({
      Authorization: "Bearer tok",
    });
  });

  test("preserves Kiro-specific extras (autoApprove, disabledTools, timeout)", async () => {
    dir = await createTestDir("am-kiro-import-");
    await dir.write(
      ".kiro/settings/mcp.json",
      JSON.stringify({
        mcpServers: {
          outlook: {
            command: "aws-outlook-mcp",
            autoApprove: ["email_search", "calendar_view"],
            disabledTools: ["email_send"],
            timeout: 60000,
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    const extras = result.servers[0].adapterExtras!;
    expect(extras.autoApprove).toEqual(["email_search", "calendar_view"]);
    expect(extras.disabledTools).toEqual(["email_send"]);
    expect(extras.timeout).toBe(60000);
  });

  test("marks disabled servers", async () => {
    dir = await createTestDir("am-kiro-import-");
    await dir.write(
      ".kiro/settings/mcp.json",
      JSON.stringify({
        mcpServers: {
          disabled_server: {
            command: "some-mcp",
            disabled: true,
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].enabled).toBe(false);
  });

  test("imports steering files as instructions", async () => {
    dir = await createTestDir("am-kiro-import-");
    await dir.write(
      ".kiro/settings/mcp.json",
      JSON.stringify({ mcpServers: {} }),
    );
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.kiro/steering/code-style.md",
      "---\ninclusion: always\ndescription: Code style rules\n---\n\n# Code Style\n\nUse strict mode.",
    );
    await dir.write(
      "project/.kiro/steering/testing.md",
      "---\ninclusion: auto\ndescription: Testing guidelines\n---\n\n# Testing\n\nAlways write tests.",
    );

    const result = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(result.instructions).toHaveLength(2);

    const codeStyle = result.instructions.find(
      (i) => i.name === "steering-code-style",
    );
    expect(codeStyle).toBeDefined();
    expect(codeStyle!.scope).toBe("always");
    expect(codeStyle!.content).toContain("Use strict mode");

    const testing = result.instructions.find(
      (i) => i.name === "steering-testing",
    );
    expect(testing).toBeDefined();
    expect(testing!.scope).toBe("agent-decision");
    expect(testing!.content).toContain("Always write tests");
  });

  test("maps fileMatch inclusion to glob scope", async () => {
    dir = await createTestDir("am-kiro-import-");
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.kiro/steering/api.md",
      '---\ninclusion: fileMatch\ndescription: API standards\n---\n\n# API Standards\n\nFollow REST conventions.',
    );

    const result = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].scope).toBe("glob");
  });

  test("maps manual inclusion to manual scope", async () => {
    dir = await createTestDir("am-kiro-import-");
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.kiro/steering/deploy.md",
      "---\ninclusion: manual\n---\n\n# Deploy\n\nDeploy steps.",
    );

    const result = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].scope).toBe("manual");
  });

  test("defaults steering without frontmatter to always scope", async () => {
    dir = await createTestDir("am-kiro-import-");
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.kiro/steering/simple.md",
      "# Simple\n\nNo frontmatter.",
    );

    const result = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].scope).toBe("always");
    expect(result.instructions[0].content).toContain("No frontmatter");
  });

  test("imports skills from .kiro/skills/", async () => {
    dir = await createTestDir("am-kiro-import-");
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.kiro/skills/pr-review/SKILL.md",
      "---\nname: pr-review\ndescription: Review pull requests for quality.\n---\n\n## Steps\n\n1. Check code.",
    );

    const result = importConfig(
      { projectPath: projectDir, entities: ["skills"] },
      dir.path,
    );
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("pr-review");
    expect(result.skills[0].description).toBe(
      "Review pull requests for quality.",
    );
    expect(result.skills[0].path).toContain("SKILL.md");
  });

  test("handles missing MCP file gracefully", async () => {
    dir = await createTestDir("am-kiro-import-");
    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("File not found");
  });

  test("handles malformed JSON gracefully", async () => {
    dir = await createTestDir("am-kiro-import-");
    await dir.write(
      ".kiro/settings/mcp.json",
      "{ not valid json ]]]",
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSON"))).toBe(
      true,
    );
  });

  test("imports global steering files", async () => {
    dir = await createTestDir("am-kiro-import-");
    await dir.write(
      ".kiro/steering/global-rules.md",
      "---\ninclusion: always\n---\n\n# Global Rules\n\nBe concise.",
    );

    const result = importConfig({ entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("steering-global-global-rules");
    expect(result.instructions[0].content).toContain("Be concise");
  });

  test("imports multiple servers from same file", async () => {
    dir = await createTestDir("am-kiro-import-");
    await dir.write(
      ".kiro/settings/mcp.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          tavily: { command: "bunx", args: ["tavily-mcp@latest"] },
          remote: { url: "https://mcp.example.com/api" },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(3);
    const names = result.servers.map((s) => s.name).sort();
    expect(names).toEqual(["fetch", "remote", "tavily"]);
  });
});
