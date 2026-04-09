import { afterEach, describe, expect, test } from "bun:test";
import { extractPackageId } from "@/adapters/kilo-code/identity.ts";
import { importConfig } from "@/adapters/kilo-code/import.ts";
import { parseJsonc } from "@/adapters/kilo-code/jsonc.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

// ── parseJsonc ─────────────────────────────────────────────────

describe("parseJsonc()", () => {
  test("strips single-line comments", () => {
    const result = parseJsonc('{\n  // comment\n  "a": 1\n}');
    expect(result).toEqual({ a: 1 });
  });

  test("strips multi-line comments", () => {
    const result = parseJsonc('{\n  /* multi\n  line */\n  "a": 1\n}');
    expect(result).toEqual({ a: 1 });
  });

  test("strips trailing commas", () => {
    const result = parseJsonc('{ "a": 1, "b": [2,] }');
    expect(result).toEqual({ a: 1, b: [2] });
  });

  test("preserves // inside strings", () => {
    const result = parseJsonc('{ "url": "https://example.com" }');
    expect(result).toEqual({ url: "https://example.com" });
  });

  test("handles complex JSONC with all features", () => {
    const input = `{
      // top comment
      "name": "test", /* inline comment */
      "arr": [1, 2, 3,],
      "nested": {
        "url": "https://example.com/path", // trailing
      },
    }`;
    const result = parseJsonc(input) as Record<string, unknown>;
    expect(result.name).toBe("test");
    expect(result.arr).toEqual([1, 2, 3]);
    expect((result.nested as Record<string, string>).url).toBe("https://example.com/path");
  });

  test("handles escaped quotes in strings", () => {
    const result = parseJsonc('{ "msg": "say \\"hello\\"" }');
    expect(result).toEqual({ msg: 'say "hello"' });
  });
});

// ── extractPackageId ────────────────────────────────────────────

describe("extractPackageId() for Kilo", () => {
  test("extracts from command array (new format)", () => {
    expect(extractPackageId(["uvx", "mcp-server-fetch"])).toBe("mcp-server-fetch");
  });

  test("extracts scoped package from command array", () => {
    expect(extractPackageId(["bunx", "@upstash/context7-mcp@latest"])).toBe(
      "@upstash/context7-mcp",
    );
  });

  test("extracts from legacy command + args", () => {
    expect(extractPackageId("bunx", ["tavily-mcp@latest"])).toBe("tavily-mcp");
  });

  test("returns command basename for non-runner", () => {
    expect(extractPackageId("aws-outlook-mcp")).toBe("aws-outlook-mcp");
  });

  test("handles single-element command array", () => {
    expect(extractPackageId(["my-server"])).toBe("my-server");
  });

  test("extracts endpoint from command array", () => {
    expect(
      extractPackageId(["uvx", "mcp-proxy", "--endpoint", "https://api.example.com/mcp"]),
    ).toBe("api.example.com");
  });
});

// ── importConfig ────────────────────────────────────────────────

describe("importConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("imports servers from global kilo.jsonc (new format)", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      `{
        // MCP servers
        "mcp": {
          "fetch": {
            "type": "local",
            "command": ["uvx", "mcp-server-fetch"],
            "enabled": true
          },
          "tavily": {
            "type": "local",
            "command": ["bunx", "tavily-mcp@latest"],
            "environment": { "TAVILY_KEY": "test" },
          }
        }
      }`,
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].name).toBe("fetch");
    expect(result.servers[0].command).toBe("uvx");
    expect(result.servers[0].args).toEqual(["mcp-server-fetch"]);
    expect(result.servers[0].scope).toBe("global");
    expect(result.servers[0].packageId).toBe("mcp-server-fetch");
    expect(result.servers[1].name).toBe("tavily");
    expect(result.servers[1].env).toEqual({ TAVILY_KEY: "test" });
  });

  test("imports servers from legacy mcpServers format", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcpServers: {
          server1: {
            command: "python",
            args: ["/path/to/server.py"],
            env: { API_KEY: "test-key" },
            alwaysAllow: ["tool1"],
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].command).toBe("python");
    expect(result.servers[0].args).toEqual(["/path/to/server.py"]);
    expect(result.servers[0].env).toEqual({ API_KEY: "test-key" });
    expect(result.servers[0].adapterExtras?.alwaysAllow).toEqual(["tool1"]);
  });

  test("imports both new and legacy MCP servers", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      `{
        "mcp": {
          "new-server": {
            "type": "local",
            "command": ["node", "new.js"]
          }
        },
        "mcpServers": {
          "legacy-server": {
            "command": "python",
            "args": ["legacy.py"]
          }
        }
      }`,
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(2);
    expect(result.servers.find((s) => s.name === "new-server")).toBeDefined();
    expect(result.servers.find((s) => s.name === "legacy-server")).toBeDefined();
  });

  test("imports remote MCP servers", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcp: {
          "remote-api": {
            type: "remote",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer token" },
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].command).toBe("https://example.com/mcp");
    expect(result.servers[0].transport).toBe("streamable-http");
  });

  test("marks disabled servers (new format: enabled=false)", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcp: {
          disabled: {
            type: "local",
            command: ["node", "disabled.js"],
            enabled: false,
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].enabled).toBe(false);
  });

  test("marks disabled servers (legacy format: disabled=true)", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcpServers: {
          disabled: { command: "node", disabled: true },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers[0].enabled).toBe(false);
  });

  test("imports project servers from .kilo/kilo.jsonc", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(".config/kilo/kilo.jsonc", JSON.stringify({ mcp: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.kilo/kilo.jsonc",
      `{
        "mcp": {
          "proj-server": {
            "type": "local",
            "command": ["node", "proj.js"]
          }
        }
      }`,
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    const projServer = result.servers.find((s) => s.name === "proj-server");
    expect(projServer).toBeDefined();
    expect(projServer?.scope).toBe("project");
  });

  test("imports project servers from root kilo.jsonc", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(".config/kilo/kilo.jsonc", JSON.stringify({ mcp: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/kilo.jsonc",
      `{
        "mcp": {
          "root-server": {
            "type": "local",
            "command": ["node", "root.js"]
          }
        }
      }`,
    );

    const result = importConfig({ projectPath: projectDir }, dir.path);
    const rootServer = result.servers.find((s) => s.name === "root-server");
    expect(rootServer).toBeDefined();
    expect(rootServer?.scope).toBe("project");
  });

  test("imports AGENTS.md as instruction", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(".config/kilo/kilo.jsonc", JSON.stringify({ mcp: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write("project/AGENTS.md", "# Instructions\n\nUse strict mode.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    const agentsInstr = result.instructions.find((i) => i.name.includes("agents"));
    expect(agentsInstr).toBeDefined();
    expect(agentsInstr?.content).toContain("Use strict mode");
    expect(agentsInstr?.scope).toBe("always");
  });

  test("falls back to CLAUDE.md when no AGENTS.md", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(".config/kilo/kilo.jsonc", JSON.stringify({ mcp: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write("project/CLAUDE.md", "# Claude Instructions\n\nFrom CLAUDE.md.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    const claudeInstr = result.instructions.find((i) => i.name.includes("claude"));
    expect(claudeInstr).toBeDefined();
    expect(claudeInstr?.content).toContain("From CLAUDE.md");
  });

  test("imports rules from .kilocode/rules/", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(".config/kilo/kilo.jsonc", JSON.stringify({ mcp: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.kilocode/rules/react-conventions.md",
      "Use functional components only.",
    );
    await dir.write("project/.kilocode/rules/testing.md", "Always write unit tests.");

    const result = importConfig({ projectPath: projectDir, entities: ["instructions"] }, dir.path);
    const rules = result.instructions.filter((i) => i.name.includes("kilo-rule"));
    expect(rules).toHaveLength(2);
    expect(rules.some((r) => r.content.includes("functional components"))).toBe(true);
  });

  test("imports skills from .kilocode/skills/", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(".config/kilo/kilo.jsonc", JSON.stringify({ mcp: {} }));
    const projectDir = `${dir.path}/project`;
    await dir.write(
      "project/.kilocode/skills/my-skill/SKILL.md",
      "---\nname: my-skill\ndescription: A test skill\n---\n\n# Instructions\n\nDo the thing.",
    );

    const result = importConfig({ projectPath: projectDir, entities: ["skills"] }, dir.path);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("my-skill");
    expect(result.skills[0].description).toBe("A test skill");
  });

  test("handles missing global config gracefully", async () => {
    dir = await createTestDir("am-kc-import-");
    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("No Kilo global config");
  });

  test("handles malformed JSONC gracefully", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(".config/kilo/kilo.jsonc", "{ not valid json ]]]");

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Malformed JSONC"))).toBe(true);
  });

  test("falls back to config.json if no kilo.jsonc", async () => {
    dir = await createTestDir("am-kc-import-");
    await dir.write(
      ".config/kilo/config.json",
      JSON.stringify({
        mcp: {
          fetch: {
            type: "local",
            command: ["uvx", "mcp-server-fetch"],
          },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("fetch");
  });
});
