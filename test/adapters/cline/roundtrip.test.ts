import { afterEach, describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { getGlobalStoragePath } from "@/adapters/cline/detect.ts";
import { diffConfig } from "@/adapters/cline/diff.ts";
import { exportConfig } from "@/adapters/cline/export.ts";
import { importConfig } from "@/adapters/cline/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

function settingsRel(home: string): string {
  return join(relative(home, getGlobalStoragePath(home)), "settings", "cline_mcp_settings.json");
}

describe("Cline adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import → transform → export → diff shows in-sync", async () => {
    dir = await createTestDir("am-cline-roundtrip-");

    // 1. Write sample native config
    await dir.write(
      settingsRel(dir.path),
      JSON.stringify({
        mcpServers: {
          fetch: {
            command: "uvx",
            args: ["mcp-server-fetch"],
          },
          tavily: {
            command: "bunx",
            args: ["tavily-mcp@latest"],
            env: { TAVILY_KEY: "${TAVILY_KEY}" },
          },
          context7: {
            command: "bunx",
            args: ["@upstash/context7-mcp@latest"],
          },
        },
      }),
    );

    // 2. Import
    const imported = importConfig({}, dir.path);
    expect(imported.servers).toHaveLength(3);

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
        adapters: s.adapterExtras ? { cline: s.adapterExtras } : {},
      };
    }

    const resolved: ResolvedConfig = {
      servers: resolvedServers,
      instructions: {},
      skills: {},
      agents: {},
      profile: "default",
      adapters: {},
    };

    // 4. Export (writes to disk)
    const exported = exportConfig(resolved, {}, dir.path);
    expect(exported.warnings).toHaveLength(0);
    const settingsFile = exported.files.find((f) => f.path.endsWith("cline_mcp_settings.json"));
    expect(settingsFile).toBeDefined();
    expect(settingsFile?.written).toBe(true);

    // 5. Verify output
    const outputJson = JSON.parse(settingsFile!.content) as Record<string, unknown>;
    const mcpServers = outputJson.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcpServers.fetch.command).toBe("uvx");
    expect(mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(mcpServers.tavily.command).toBe("bunx");
    expect(mcpServers.tavily.env).toEqual({ TAVILY_KEY: "${TAVILY_KEY}" });
    expect(mcpServers.context7.command).toBe("bunx");

    // 6. Diff should show in-sync after roundtrip
    const diff = diffConfig(resolved, {}, dir.path);
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });

  test("roundtrip preserves alwaysAllow and disabled fields", async () => {
    dir = await createTestDir("am-cline-roundtrip-");

    await dir.write(
      settingsRel(dir.path),
      JSON.stringify({
        mcpServers: {
          server1: {
            command: "node",
            args: ["server.js"],
            alwaysAllow: ["tool1", "tool2"],
          },
          server2: {
            command: "python",
            args: ["server.py"],
            disabled: true,
          },
        },
      }),
    );

    // Import
    const imported = importConfig({}, dir.path);
    expect(imported.servers).toHaveLength(2);

    const s1 = imported.servers.find((s) => s.name === "server1");
    expect(s1?.adapterExtras?.alwaysAllow).toEqual(["tool1", "tool2"]);

    const s2 = imported.servers.find((s) => s.name === "server2");
    expect(s2?.enabled).toBe(false);

    // Transform
    const resolvedServers: Record<string, ResolvedServer> = {};
    for (const s of imported.servers) {
      resolvedServers[s.name] = {
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        env: s.env ?? {},
        transport: "stdio",
        description: "",
        tags: [],
        enabled: s.enabled ?? true,
        adapters: s.adapterExtras ? { cline: s.adapterExtras } : {},
      };
    }

    const resolved: ResolvedConfig = {
      servers: resolvedServers,
      instructions: {},
      skills: {},
      agents: {},
      profile: "default",
      adapters: {},
    };

    // Export
    const exported = exportConfig(resolved, { dryRun: true }, dir.path);
    const settingsFile = exported.files.find((f) => f.path.endsWith("cline_mcp_settings.json"));
    const output = JSON.parse(settingsFile!.content) as Record<string, unknown>;
    const mcpServers = output.mcpServers as Record<string, Record<string, unknown>>;

    // server1 should have alwaysAllow preserved
    expect(mcpServers.server1.alwaysAllow).toEqual(["tool1", "tool2"]);

    // server2 is disabled, so it should be skipped in export
    expect(mcpServers.server2).toBeUndefined();
  });

  test("roundtrip with instructions", async () => {
    dir = await createTestDir("am-cline-roundtrip-");

    // Write MCP settings and project rules
    await dir.write(
      settingsRel(dir.path),
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
        },
      }),
    );
    const projectDir = join(dir.path, "project");
    await dir.write("project/.clinerules/coding.md", "Use functional components.");

    // Import
    const imported = importConfig({ projectPath: projectDir }, dir.path);
    expect(imported.servers).toHaveLength(1);
    expect(imported.instructions).toHaveLength(1);
    expect(imported.instructions[0].content).toContain("functional");

    // Transform
    const resolvedServers: Record<string, ResolvedServer> = {};
    for (const s of imported.servers) {
      resolvedServers[s.name] = {
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        env: s.env ?? {},
        transport: "stdio",
        description: "",
        tags: [],
        enabled: true,
        adapters: {},
      };
    }

    const resolved: ResolvedConfig = {
      servers: resolvedServers,
      instructions: {
        "cline-rule-coding": {
          name: "cline-rule-coding",
          content: imported.instructions[0].content,
          scope: "always",
          globs: [],
          description: "",
          targets: ["cline"],
          adapters: {},
        },
      },
      skills: {},
      agents: {},
      profile: "default",
      adapters: {},
    };

    // Export
    const exported = exportConfig(resolved, { projectPath: projectDir, dryRun: true }, dir.path);

    const ruleFile = exported.files.find((f) => f.path.includes(".clinerules"));
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.content).toContain("functional components");
  });
});
