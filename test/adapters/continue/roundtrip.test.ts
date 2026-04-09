import { afterEach, describe, expect, test } from "bun:test";
import { diffConfig } from "@/adapters/continue/diff.ts";
import { exportConfig } from "@/adapters/continue/export.ts";
import { importConfig } from "@/adapters/continue/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("Continue adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import -> transform -> export -> diff shows in-sync", async () => {
    dir = await createTestDir("am-ct-roundtrip-");

    // 1. Write sample native config (array format)
    await dir.write(
      ".continue/config.json",
      JSON.stringify({
        name: "my-config",
        mcpServers: [
          {
            name: "sqlite",
            command: "uvx",
            args: ["mcp-server-sqlite", "--db-path", "./test.db"],
            env: { NODE_ENV: "production" },
          },
          { name: "fetch", command: "uvx", args: ["mcp-server-fetch"] },
          {
            name: "context7",
            command: "bunx",
            args: ["@upstash/context7-mcp@latest"],
          },
        ],
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
        adapters: s.adapterExtras ? { continue: s.adapterExtras } : {},
      };
    }

    const resolved: ResolvedConfig = {
      servers: resolvedServers,
      instructions: {},
      skills: {},
      profile: "default",
      adapters: {},
      agents: {},
    };

    // 4. Export (writes to disk)
    const exported = exportConfig(resolved, {}, dir.path);
    expect(exported.warnings).toHaveLength(0);
    const configFile = exported.files.find((f) => f.path.endsWith("config.json"));
    expect(configFile).toBeDefined();
    expect(configFile?.written).toBe(true);

    // 5. Verify output is array format
    const outputJson = JSON.parse(configFile?.content);
    expect(Array.isArray(outputJson.mcpServers)).toBe(true);
    expect(outputJson.mcpServers).toHaveLength(3);

    const sqliteEntry = outputJson.mcpServers.find((s: any) => s.name === "sqlite");
    expect(sqliteEntry.command).toBe("uvx");
    expect(sqliteEntry.env.NODE_ENV).toBe("production");

    // Existing fields preserved
    expect(outputJson.name).toBe("my-config");

    // 6. Diff should show in-sync
    const diff = diffConfig(resolved, {}, dir.path);
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });
});
