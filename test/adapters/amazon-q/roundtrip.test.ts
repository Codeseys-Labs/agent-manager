import { afterEach, describe, expect, test } from "bun:test";
import { diffConfig } from "@/adapters/amazon-q/diff.ts";
import { exportConfig } from "@/adapters/amazon-q/export.ts";
import { importConfig } from "@/adapters/amazon-q/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("Amazon Q adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import -> transform -> export -> diff shows in-sync", async () => {
    dir = await createTestDir("am-aq-roundtrip-");

    // 1. Write sample native config
    await dir.write(
      ".aws/amazonq/mcp.json",
      JSON.stringify({
        mcpServers: {
          "aws-docs": {
            command: "uvx",
            args: ["awslabs.aws-documentation-mcp-server@latest"],
            env: { FASTMCP_LOG_LEVEL: "ERROR" },
          },
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
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
        adapters: s.adapterExtras ? { "amazon-q": s.adapterExtras } : {},
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
    const exported = await exportConfig(resolved, {}, dir.path);
    expect(exported.warnings).toHaveLength(0);
    const mcpFile = exported.files.find((f) => f.path.endsWith("mcp.json"));
    expect(mcpFile).toBeDefined();
    expect(mcpFile?.written).toBe(true);

    // 5. Verify output
    const outputJson = JSON.parse(mcpFile!.content);
    expect(outputJson.mcpServers["aws-docs"].command).toBe("uvx");
    expect(outputJson.mcpServers["aws-docs"].env.FASTMCP_LOG_LEVEL).toBe("ERROR");

    // 6. Diff should show in-sync
    const diff = diffConfig(resolved, {}, dir.path);
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });

  test("roundtrip with instructions", async () => {
    dir = await createTestDir("am-aq-roundtrip-");
    const projectDir = `${dir.path}/project`;

    // 1. Write native rules
    await dir.write("project/.amazonq/rules/coding.md", "Use TypeScript strict mode.");
    await dir.write("project/.amazonq/rules/testing.md", "Write tests for all functions.");

    // 2. Import
    const imported = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(imported.instructions).toHaveLength(2);

    // 3. Transform to ResolvedConfig
    const resolvedInstructions: Record<string, any> = {};
    for (const i of imported.instructions) {
      resolvedInstructions[i.name] = {
        name: i.name,
        content: i.content,
        scope: i.scope,
        globs: [],
        description: i.description ?? "",
        targets: [],
        adapters: {},
      };
    }

    const resolved: ResolvedConfig = {
      servers: {},
      instructions: resolvedInstructions,
      skills: {},
      profile: "default",
      adapters: {},
      agents: {},
    };

    // 4. Export
    const exported = await exportConfig(resolved, { projectPath: projectDir }, dir.path);
    expect(exported.warnings).toHaveLength(0);

    // 5. Verify rule files
    const codingFile = exported.files.find((f) => f.path.endsWith("coding.md"));
    expect(codingFile).toBeDefined();
    expect(codingFile!.content).toBe("Use TypeScript strict mode.\n");

    const testingFile = exported.files.find((f) => f.path.endsWith("testing.md"));
    expect(testingFile).toBeDefined();
    expect(testingFile!.content).toBe("Write tests for all functions.\n");
  });
});
