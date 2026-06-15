import { afterEach, describe, expect, test } from "bun:test";
import { extractPackageId } from "@/adapters/claude-code/identity.ts";
import { importConfig } from "@/adapters/claude-code/import.ts";
import { toPosix } from "../../helpers/path.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

// ── extractPackageId ────────────────────────────────────────────

describe("extractPackageId()", () => {
  test("extracts package from npx command", () => {
    expect(extractPackageId("npx", ["-y", "tavily-mcp@latest"])).toBe("tavily-mcp");
  });

  test("extracts package from bunx command", () => {
    expect(extractPackageId("bunx", ["tavily-mcp@latest"])).toBe("tavily-mcp");
  });

  test("extracts scoped package from bunx", () => {
    expect(extractPackageId("bunx", ["@upstash/context7-mcp@latest"])).toBe(
      "@upstash/context7-mcp",
    );
  });

  test("extracts package from uvx command", () => {
    expect(extractPackageId("uvx", ["mcp-server-fetch"])).toBe("mcp-server-fetch");
  });

  test("extracts hostname from --endpoint URL (proxy-wrapped)", () => {
    expect(extractPackageId("uvx", ["mcp-proxy", "--endpoint", "https://mcp.exa.ai/sse"])).toBe(
      "mcp.exa.ai",
    );
  });

  test("returns command basename for non-runner commands", () => {
    expect(extractPackageId("aws-outlook-mcp")).toBe("aws-outlook-mcp");
  });

  test("returns basename from full path", () => {
    expect(extractPackageId("/usr/local/bin/aws-outlook-mcp")).toBe("aws-outlook-mcp");
  });

  test("handles pipx runner", () => {
    expect(extractPackageId("pipx", ["run", "my-mcp-server"])).toBe("my-mcp-server");
  });

  test("returns undefined for empty command", () => {
    expect(extractPackageId("")).toBeUndefined();
  });
});

// ── importConfig ────────────────────────────────────────────────

describe("importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports servers from ~/.claude.json", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(
      ".claude.json",
      JSON.stringify({
        numStartups: 42,
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

  test("imports .mcp.json as project-scoped", async () => {
    dir = await createTestDir("am-import-");
    // Need a global config to avoid warning noise
    await dir.write(".claude.json", JSON.stringify({ mcpServers: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.mcp.json",
      JSON.stringify({
        mcpServers: {
          "aws-outlook-mcp": {
            command: "aws-outlook-mcp",
            env: { MIDWAY_AUTH: "true" },
          },
        },
      }),
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    const projectServer = result.servers.find((s) => s.name === "aws-outlook-mcp");
    expect(projectServer).toBeDefined();
    expect(projectServer?.scope).toBe("project");
    expect(projectServer?.env).toEqual({ MIDWAY_AUTH: "true" });
  });

  test("imports CLAUDE.md as instruction", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(".claude.json", JSON.stringify({ mcpServers: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write("project/CLAUDE.md", "# Instructions\n\nUse strict mode.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].name).toBe("claude-md");
    expect(result.instructions[0].content).toContain("Use strict mode");
    expect(result.instructions[0].scope).toBe("always");
  });

  test("handles missing file gracefully", async () => {
    dir = await createTestDir("am-import-");
    // No .claude.json at all
    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("File not found");
  });

  test("handles malformed JSON gracefully", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(".claude.json", "{ not valid json ]]]");

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSON"))).toBe(true);
  });

  test("preserves adapter extras (alwaysAllow etc.)", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          outlook: {
            command: "aws-outlook-mcp",
            always_allow: ["email_search", "calendar_view"],
            some_custom_field: true,
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].adapterExtras).toBeDefined();
    expect(result.servers[0].adapterExtras?.always_allow).toEqual([
      "email_search",
      "calendar_view",
    ]);
    expect(result.servers[0].adapterExtras?.some_custom_field).toBe(true);
  });

  test("marks disabled servers", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(
      ".claude.json",
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

  test("imports from .claude/CLAUDE.md if no root CLAUDE.md", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(".claude.json", JSON.stringify({ mcpServers: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.claude/CLAUDE.md", "# Hidden instructions\n\nFrom .claude dir.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0].content).toContain("Hidden instructions");
  });

  test("imports global skills from ~/.claude/skills/", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(
      ".claude/skills/research-rabbithole/SKILL.md",
      "# Research Rabbithole\n\nDeep research.",
    );
    await dir.write(".claude/skills/admin-lint/SKILL.md", "# Admin Lint\n\nVault health check.");

    const result = importConfig({ entities: ["skills"] }, dir.path);
    expect(result.skills).toHaveLength(2);
    const research = result.skills.find((s) => s.name === "research-rabbithole");
    expect(research).toBeDefined();
    expect(research?.description).toBe("Research Rabbithole");
    expect(toPosix(research?.path ?? "")).toContain(".claude/skills/research-rabbithole");
  });

  test("imports project skills from <project>/.claude/skills/", async () => {
    dir = await createTestDir("am-import-");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.claude/skills/deploy/SKILL.md", "# Deploy Skill\n\nDeploys things.");

    const result = importConfig({ projectPath: projectDir, entities: ["skills"] }, dir.path);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("deploy");
    expect(result.skills[0].description).toBe("Deploy Skill");
  });

  test("imports both global and project skills", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(".claude/skills/global-skill/SKILL.md", "# Global Skill\n\nGlobal.");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.claude/skills/project-skill/SKILL.md", "# Project Skill\n\nProject.");

    const result = importConfig({ projectPath: projectDir, entities: ["skills"] }, dir.path);
    expect(result.skills).toHaveLength(2);
    expect(result.skills.find((s) => s.name === "global-skill")).toBeDefined();
    expect(result.skills.find((s) => s.name === "project-skill")).toBeDefined();
  });

  test("skips skill directories without SKILL.md", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(".claude/skills/broken/.keep", "");

    const result = importConfig({ entities: ["skills"] }, dir.path);
    expect(result.skills).toHaveLength(0);
  });

  test("returns empty skills when ~/.claude/skills/ does not exist", async () => {
    dir = await createTestDir("am-import-");
    // No skills dir at all
    const result = importConfig({ entities: ["skills"] }, dir.path);
    expect(result.skills).toHaveLength(0);
  });

  test("portability — flags a foreign-host absolute path in the SKILL.md body", async () => {
    dir = await createTestDir("am-import-");
    // A skill body that hard-codes the author's home dir (R1/297e). On Linux
    // this is a foreign-host absolute path the moment it's shared elsewhere.
    await dir.write(
      ".claude/skills/hyperresearch/SKILL.md",
      "# Hyperresearch\n\nRun /home/baladita/.local/share/uv/tools/hyperresearch/bin/hr to start.",
    );

    const result = importConfig({ entities: ["skills"] }, dir.path);
    const skill = result.skills.find((s) => s.name === "hyperresearch");
    expect(skill).toBeDefined();
    expect(skill?.portability).toBeDefined();
    expect(skill?.portability).toHaveLength(1);
    expect(skill?.portability?.[0].kind).toBe("linux");
    expect(skill?.portability?.[0].match).toBe("/home/baladita/");
  });

  test("portability — clean SKILL.md leaves the portability field unset", async () => {
    dir = await createTestDir("am-import-");
    await dir.write(
      ".claude/skills/portable/SKILL.md",
      "# Portable\n\nRun ./scripts/run.sh from the repo root.",
    );

    const result = importConfig({ entities: ["skills"] }, dir.path);
    const skill = result.skills.find((s) => s.name === "portable");
    expect(skill).toBeDefined();
    expect(skill?.portability).toBeUndefined();
  });
});
