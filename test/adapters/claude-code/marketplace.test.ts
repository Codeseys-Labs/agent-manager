import { afterEach, describe, expect, test } from "bun:test";
import { scanClaudePlugins } from "@/adapters/claude-code/marketplace.ts";
import { toPosix } from "../../helpers/path.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("scanClaudePlugins()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("returns empty when no settings.json", async () => {
    dir = await createTestDir("am-marketplace-");
    const result = scanClaudePlugins(dir.path);
    expect(result.items).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Cannot read Claude settings");
  });

  test("returns empty when enabledPlugins is empty", async () => {
    dir = await createTestDir("am-marketplace-");
    await dir.write(".claude/settings.json", JSON.stringify({ enabledPlugins: [] }));
    const result = scanClaudePlugins(dir.path);
    expect(result.items).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns empty when enabledPlugins is missing", async () => {
    dir = await createTestDir("am-marketplace-");
    await dir.write(".claude/settings.json", JSON.stringify({ theme: "dark" }));
    const result = scanClaudePlugins(dir.path);
    expect(result.items).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("scans plugin with MCP servers", async () => {
    dir = await createTestDir("am-marketplace-");
    await dir.write(
      ".claude/settings.json",
      JSON.stringify({ enabledPlugins: ["@anthropic/plugin-foo"] }),
    );
    await dir.write(
      ".claude/plugins/@anthropic/plugin-foo/plugin.json",
      JSON.stringify({
        name: "plugin-foo",
        version: "1.2.0",
        author: "Anthropic",
        mcpServers: {
          "foo-server": {
            command: "node",
            args: ["dist/server.js"],
            env: { FOO_KEY: "abc" },
          },
        },
      }),
    );

    const result = scanClaudePlugins(dir.path);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("@anthropic/plugin-foo");
    expect(result.items[0].name).toBe("plugin-foo");
    expect(result.items[0].version).toBe("1.2.0");
    expect(result.items[0].source).toBe("claude-plugin");
    expect(result.items[0].servers).toHaveLength(1);
    expect(result.items[0].servers[0].name).toBe("foo-server");
    expect(result.items[0].servers[0].command).toBe("node");
    expect(result.items[0].servers[0].args).toEqual(["dist/server.js"]);
    expect(result.items[0].servers[0].env).toEqual({ FOO_KEY: "abc" });
    expect(result.items[0].servers[0].scope).toBe("global");
    expect(result.items[0].servers[0].tags).toEqual(["plugin:@anthropic/plugin-foo"]);
    expect(result.items[0].metadata.publisher).toBe("Anthropic");
  });

  test("scans plugin with skills", async () => {
    dir = await createTestDir("am-marketplace-");
    await dir.write(
      ".claude/settings.json",
      JSON.stringify({ enabledPlugins: ["@company/plugin-bar"] }),
    );
    await dir.write(
      ".claude/plugins/@company/plugin-bar/plugin.json",
      JSON.stringify({
        name: "plugin-bar",
        version: "0.5.0",
        skills: [
          {
            name: "bar-skill",
            description: "Does bar things",
            path: "skills/bar/SKILL.md",
          },
        ],
      }),
    );
    await dir.write(".claude/plugins/@company/plugin-bar/skills/bar/SKILL.md", "# Bar Skill");

    const result = scanClaudePlugins(dir.path);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].skills).toHaveLength(1);
    expect(result.items[0].skills[0].name).toBe("bar-skill");
    expect(result.items[0].skills[0].description).toBe("Does bar things");
    expect(toPosix(result.items[0].skills[0].path)).toContain("skills/bar/SKILL.md");
    expect(result.items[0].servers).toHaveLength(0);
  });

  test("scans multiple plugins", async () => {
    dir = await createTestDir("am-marketplace-");
    await dir.write(
      ".claude/settings.json",
      JSON.stringify({
        enabledPlugins: ["@anthropic/plugin-a", "@company/plugin-b"],
      }),
    );
    await dir.write(
      ".claude/plugins/@anthropic/plugin-a/plugin.json",
      JSON.stringify({
        name: "plugin-a",
        version: "1.0.0",
        mcpServers: {
          "server-a": { command: "node", args: ["a.js"] },
        },
      }),
    );
    await dir.write(
      ".claude/plugins/@company/plugin-b/plugin.json",
      JSON.stringify({
        name: "plugin-b",
        version: "2.0.0",
        mcpServers: {
          "server-b1": { command: "node", args: ["b1.js"] },
          "server-b2": { command: "node", args: ["b2.js"] },
        },
      }),
    );

    const result = scanClaudePlugins(dir.path);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].servers).toHaveLength(1);
    expect(result.items[1].servers).toHaveLength(2);
  });

  test("warns on missing plugin.json", async () => {
    dir = await createTestDir("am-marketplace-");
    await dir.write(
      ".claude/settings.json",
      JSON.stringify({ enabledPlugins: ["missing-plugin"] }),
    );

    const result = scanClaudePlugins(dir.path);
    expect(result.items).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("missing-plugin");
    expect(result.warnings[0]).toContain("no plugin.json found");
  });

  test("uses plugin ID as name when manifest has no name field", async () => {
    dir = await createTestDir("am-marketplace-");
    await dir.write(".claude/settings.json", JSON.stringify({ enabledPlugins: ["bare-plugin"] }));
    await dir.write(
      ".claude/plugins/bare-plugin/plugin.json",
      JSON.stringify({ version: "0.1.0" }),
    );

    const result = scanClaudePlugins(dir.path);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("bare-plugin");
    expect(result.items[0].version).toBe("0.1.0");
  });

  test("skips plugin IDs with path traversal sequences", async () => {
    dir = await createTestDir("am-marketplace-");
    await dir.write(
      ".claude/settings.json",
      JSON.stringify({
        enabledPlugins: [
          "../../../etc/passwd",
          "..\\windows\\system32",
          "/absolute/path",
          "",
          "valid-plugin",
        ],
      }),
    );
    await dir.write(
      ".claude/plugins/valid-plugin/plugin.json",
      JSON.stringify({ name: "valid", version: "1.0.0" }),
    );

    const result = scanClaudePlugins(dir.path);
    // Only the valid plugin should be scanned
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("valid");
    // Path traversal IDs should produce warnings
    const traversalWarnings = result.warnings.filter((w) => w.includes("invalid plugin ID"));
    expect(traversalWarnings).toHaveLength(4);
  });

  test("defaults version to unknown when not in manifest", async () => {
    dir = await createTestDir("am-marketplace-");
    await dir.write(".claude/settings.json", JSON.stringify({ enabledPlugins: ["no-version"] }));
    await dir.write(
      ".claude/plugins/no-version/plugin.json",
      JSON.stringify({ name: "no-version" }),
    );

    const result = scanClaudePlugins(dir.path);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].version).toBe("unknown");
  });

  test("plugin with both servers and skills", async () => {
    dir = await createTestDir("am-marketplace-");
    await dir.write(".claude/settings.json", JSON.stringify({ enabledPlugins: ["@full/plugin"] }));
    await dir.write(
      ".claude/plugins/@full/plugin/plugin.json",
      JSON.stringify({
        name: "full-plugin",
        version: "3.0.0",
        mcpServers: {
          "full-server": { command: "node", args: ["server.js"] },
        },
        skills: [{ name: "full-skill", description: "A skill", path: "skills/full/SKILL.md" }],
      }),
    );

    const result = scanClaudePlugins(dir.path);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].servers).toHaveLength(1);
    expect(result.items[0].skills).toHaveLength(1);
  });
});
