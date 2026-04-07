import { describe, expect, test, afterEach } from "bun:test";
import { createTestDir, type TestDir } from "../../helpers/tmp.ts";
import { importConfig } from "@/adapters/copilot/import.ts";
import { exportConfig } from "@/adapters/copilot/export.ts";
import { diffConfig } from "@/adapters/copilot/diff.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";

describe("Copilot adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import -> transform -> export -> diff shows in-sync", async () => {
    dir = await createTestDir("am-cp-roundtrip-");
    const projectDir = dir.path + "/project";

    // 1. Write sample native config (note: "servers" key, not "mcpServers")
    await dir.write(
      "project/.vscode/mcp.json",
      JSON.stringify({
        servers: {
          "local-server": {
            command: "npx",
            args: ["-y", "@some/mcp-server"],
          },
          "python-server": {
            command: "uvx",
            args: ["mcp-server-fetch"],
            env: { DEBUG: "true" },
          },
        },
      }),
    );

    // 2. Import
    const imported = importConfig({ projectPath: projectDir }, dir.path);
    expect(imported.servers).toHaveLength(2);
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
        adapters: s.adapterExtras ? { copilot: s.adapterExtras } : {},
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
    const exported = exportConfig(resolved, { projectPath: projectDir }, dir.path);
    expect(exported.warnings).toHaveLength(0);
    const mcpFile = exported.files.find((f) => f.path.endsWith("mcp.json"));
    expect(mcpFile).toBeDefined();
    expect(mcpFile!.written).toBe(true);

    // 5. Verify output uses "servers" key
    const outputJson = JSON.parse(mcpFile!.content);
    expect(outputJson.servers).toBeDefined();
    expect(outputJson.mcpServers).toBeUndefined();
    expect(outputJson.servers["local-server"].command).toBe("npx");
    expect(outputJson.servers["python-server"].env.DEBUG).toBe("true");

    // 6. Diff should show in-sync
    const diff = diffConfig(resolved, { projectPath: projectDir });
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });
});
