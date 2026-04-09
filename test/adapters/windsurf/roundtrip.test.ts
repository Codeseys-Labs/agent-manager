import { afterEach, describe, expect, test } from "bun:test";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { diffConfig } from "@/adapters/windsurf/diff.ts";
import { exportConfig } from "@/adapters/windsurf/export.ts";
import { importConfig } from "@/adapters/windsurf/import.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("Windsurf adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import -> transform -> export -> diff shows in-sync", async () => {
    dir = await createTestDir("am-ws-roundtrip-");

    // 1. Write sample native config
    await dir.write(
      ".codeium/windsurf/mcp_config.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          tavily: {
            command: "bunx",
            args: ["tavily-mcp@latest"],
            env: { TAVILY_API_KEY: "${env:TAVILY_API_KEY}" },
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
    expect(imported.warnings).toHaveLength(0);

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
        adapters: s.adapterExtras ? { windsurf: s.adapterExtras } : {},
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
    const exported = exportConfig(resolved, {}, dir.path);
    expect(exported.warnings).toHaveLength(0);
    const mcpFile = exported.files.find((f) => f.path.endsWith("mcp_config.json"));
    expect(mcpFile).toBeDefined();
    expect(mcpFile?.written).toBe(true);

    // 5. Verify output
    const outputJson = JSON.parse(mcpFile?.content);
    expect(outputJson.mcpServers.fetch.command).toBe("uvx");
    expect(outputJson.mcpServers.tavily.env.TAVILY_API_KEY).toBe("${env:TAVILY_API_KEY}");

    // 6. Diff should show in-sync
    const diff = diffConfig(resolved, {}, dir.path);
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });
});
