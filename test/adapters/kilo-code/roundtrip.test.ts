import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { diffConfig } from "@/adapters/kilo-code/diff.ts";
import { exportConfig } from "@/adapters/kilo-code/export.ts";
import { importConfig } from "@/adapters/kilo-code/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("Kilo Code adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import → transform → export → diff shows in-sync (new format)", async () => {
    dir = await createTestDir("am-kc-roundtrip-");

    // 1. Write sample native config (new format with JSONC features)
    await dir.write(
      ".config/kilo/kilo.jsonc",
      `{
        // Global Kilo config
        "model": "anthropic/claude-sonnet-4-20250514",
        "mcp": {
          "fetch": {
            "type": "local",
            "command": ["uvx", "mcp-server-fetch"],
          },
          "tavily": {
            "type": "local",
            "command": ["bunx", "tavily-mcp@latest"],
            "environment": { "TAVILY_KEY": "\${TAVILY_KEY}" },
          },
          "context7": {
            "type": "local",
            "command": ["bunx", "@upstash/context7-mcp@latest"],
          }
        }
      }`,
    );

    // 2. Import
    const imported = importConfig({}, dir.path);
    expect(imported.servers).toHaveLength(3);
    // No warnings about missing global config
    expect(imported.warnings.some((w) => w.includes("No Kilo global config"))).toBe(false);

    // 3. Transform to ResolvedConfig
    const resolvedServers: Record<string, ResolvedServer> = {};
    for (const s of imported.servers) {
      resolvedServers[s.name] = {
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        env: s.env ?? {},
        transport: s.transport ?? "stdio",
        description: s.description ?? "",
        tags: s.tags ?? [],
        enabled: s.enabled ?? true,
        adapters: s.adapterExtras ? { "kilo-code": s.adapterExtras } : {},
      };
    }

    const resolved: ResolvedConfig = {
      servers: resolvedServers,
      instructions: {},
      skills: {},
      profile: "default",
      adapters: {},
    };

    // 4. Export (writes to disk)
    const exported = await exportConfig(resolved, {}, dir.path);
    expect(exported.warnings).toHaveLength(0);
    const globalFile = exported.files.find((f) => f.path.endsWith("kilo.jsonc"));
    expect(globalFile).toBeDefined();
    expect(globalFile?.written).toBe(true);

    // 5. Verify output
    const outputJson = JSON.parse(globalFile?.content) as Record<string, unknown>;

    // Non-MCP fields preserved
    expect(outputJson.model).toBe("anthropic/claude-sonnet-4-20250514");

    // All servers present with correct fields (new format)
    const mcp = outputJson.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.fetch.command).toEqual(["uvx", "mcp-server-fetch"]);
    expect(mcp.tavily.command).toEqual(["bunx", "tavily-mcp@latest"]);
    expect(mcp.tavily.environment).toEqual({ TAVILY_KEY: "${TAVILY_KEY}" });
    expect(mcp.context7.command).toEqual(["bunx", "@upstash/context7-mcp@latest"]);

    // Legacy mcpServers key should be removed
    expect(outputJson.mcpServers).toBeUndefined();

    // 6. Diff should show in-sync after roundtrip
    const diff = diffConfig(resolved, {}, dir.path);
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });

  test("import → roundtrip with legacy format servers", async () => {
    dir = await createTestDir("am-kc-roundtrip-legacy-");

    // Write legacy format
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcpServers: {
          server1: {
            command: "python",
            args: ["/path/to/server.py"],
            env: { API_KEY: "test-key" },
          },
        },
      }),
    );

    // Import
    const imported = importConfig({}, dir.path);
    expect(imported.servers).toHaveLength(1);
    expect(imported.servers[0].command).toBe("python");
    expect(imported.servers[0].args).toEqual(["/path/to/server.py"]);

    // Transform
    const resolvedServers: Record<string, ResolvedServer> = {};
    for (const s of imported.servers) {
      resolvedServers[s.name] = {
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        env: s.env ?? {},
        transport: s.transport ?? "stdio",
        description: s.description ?? "",
        tags: s.tags ?? [],
        enabled: s.enabled ?? true,
        adapters: {},
      };
    }

    const resolved: ResolvedConfig = {
      servers: resolvedServers,
      instructions: {},
      skills: {},
      profile: "default",
      adapters: {},
    };

    // Export (writes new format)
    const exported = await exportConfig(resolved, {}, dir.path);
    const globalFile = exported.files.find((f) => f.path.endsWith("kilo.jsonc"));
    const outputJson = JSON.parse(globalFile?.content) as Record<string, unknown>;

    // Exported in new format
    const mcp = outputJson.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.server1.command).toEqual(["python", "/path/to/server.py"]);
    expect(mcp.server1.environment).toEqual({ API_KEY: "test-key" });

    // Diff should be in-sync (diff normalizes both formats)
    const diff = diffConfig(resolved, {}, dir.path);
    expect(diff.status).toBe("in-sync");
  });

  test("import from fixtures → verify counts", async () => {
    dir = await createTestDir("am-kc-roundtrip-fixture-");

    // Copy fixture files to temp dir
    const fixtureDir = join(import.meta.dir, "../../fixtures/kilo-code");
    const fs = require("node:fs");
    const sampleKilo = fs.readFileSync(join(fixtureDir, "sample-kilo.jsonc"), "utf-8");
    await dir.write(".config/kilo/kilo.jsonc", sampleKilo);

    const projectDir = `${dir.path}/project`;
    const sampleProject = fs.readFileSync(join(fixtureDir, "sample-project.jsonc"), "utf-8");
    await dir.write("project/kilo.jsonc", sampleProject);

    const sampleAgents = fs.readFileSync(join(fixtureDir, "sample-AGENTS.md"), "utf-8");
    await dir.write("project/AGENTS.md", sampleAgents);

    // Import global + project
    const imported = importConfig({ projectPath: projectDir }, dir.path);
    expect(imported.servers.length).toBeGreaterThan(0);
    expect(imported.instructions).toHaveLength(2); // global config instruction ref + AGENTS.md

    // Verify server scopes
    const globalServers = imported.servers.filter((s) => s.scope === "global");
    const projectServers = imported.servers.filter((s) => s.scope === "project");
    // sample-kilo.jsonc has 4 servers (3 enabled + 1 disabled)
    expect(globalServers.length).toBe(4);
    // sample-project.jsonc has 2 servers (1 new + 1 legacy)
    expect(projectServers.length).toBe(2);
  });
});
