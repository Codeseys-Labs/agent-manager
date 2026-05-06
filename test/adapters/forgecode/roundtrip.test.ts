import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { diffConfig } from "@/adapters/forgecode/diff.ts";
import { exportConfig } from "@/adapters/forgecode/export.ts";
import { importConfig } from "@/adapters/forgecode/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("ForgeCode adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import → transform → export → diff shows in-sync", async () => {
    dir = await createTestDir("am-forgecode-roundtrip-");
    const projectDir = `${dir.path}/project`;

    // 1. Write sample native .mcp.json
    const sampleMcp = {
      mcpServers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"] },
        tavily: {
          command: "bunx",
          args: ["tavily-mcp@latest"],
          env: { TAVILY_API_KEY: "${TAVILY_API_KEY}" },
        },
        context7: { command: "bunx", args: ["@upstash/context7-mcp@latest"] },
      },
    };

    await dir.write("project/.mcp.json", JSON.stringify(sampleMcp));

    // 2. Import (only servers to avoid warnings about missing AGENTS.md)
    const imported = importConfig({ projectPath: projectDir, entities: ["servers"] }, dir.path);
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
        adapters: s.adapterExtras ? { forgecode: s.adapterExtras } : {},
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
    const exported = await exportConfig(resolved, { projectPath: projectDir });
    expect(exported.warnings).toHaveLength(0);
    const mcpFile = exported.files.find((f) => f.path.endsWith(".mcp.json"));
    expect(mcpFile).toBeDefined();
    expect(mcpFile?.written).toBe(true);

    // 5. Verify output
    const outputJson = JSON.parse(mcpFile!.content);
    expect(outputJson.mcpServers.fetch.command).toBe("uvx");
    expect(outputJson.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(outputJson.mcpServers.tavily.env.TAVILY_API_KEY).toBe("${TAVILY_API_KEY}");

    // 6. Diff should show in-sync after roundtrip
    const diff = diffConfig(resolved, { projectPath: projectDir });
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });

  test("import from fixtures → roundtrip", async () => {
    dir = await createTestDir("am-forgecode-roundtrip-fixture-");
    const projectDir = `${dir.path}/project`;

    // Copy fixture files to temp dir
    const fixtureDir = join(import.meta.dir, "../../fixtures/forgecode");
    const fs = require("node:fs");
    const sampleMcp = fs.readFileSync(join(fixtureDir, "sample-mcp.json"), "utf-8");
    await dir.write("project/.mcp.json", sampleMcp);

    // Import
    const imported = importConfig({ projectPath: projectDir }, dir.path);
    expect(imported.servers.length).toBeGreaterThan(0);

    // Verify all project-scoped (ForgeCode only uses project-level .mcp.json)
    const projectServers = imported.servers.filter((s) => s.scope === "project");
    expect(projectServers.length).toBe(imported.servers.length);

    // Verify disabled server imported correctly
    const disabledServer = imported.servers.find((s) => s.name === "disabled-server");
    expect(disabledServer).toBeDefined();
    expect(disabledServer?.enabled).toBe(false);
  });

  test("instructions roundtrip through AGENTS.md", async () => {
    dir = await createTestDir("am-forgecode-roundtrip-instr-");
    const projectDir = `${dir.path}/project`;

    await dir.write("project/AGENTS.md", "# Project Instructions\n\nUse TypeScript strict mode.\n");

    // Import
    const imported = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(imported.instructions).toHaveLength(1);
    const instr = imported.instructions[0];
    expect(instr.content).toContain("Use TypeScript strict mode.");

    // Transform to resolved
    const resolved: ResolvedConfig = {
      servers: {},
      instructions: {
        [instr.name]: {
          name: instr.name,
          content: instr.content,
          scope: instr.scope,
          globs: [],
          description: instr.description ?? "",
          targets: [],
          adapters: {},
        },
      },
      skills: {},
      agents: {},
      profile: "default",
      adapters: {},
    };

    // Export
    const exported = await exportConfig(resolved, {
      projectPath: projectDir,
      dryRun: true,
    });
    const agentsMdFile = exported.files.find((f) => f.path.endsWith("AGENTS.md"));
    expect(agentsMdFile).toBeDefined();
    expect(agentsMdFile!.content).toContain("Use TypeScript strict mode.");
    expect(agentsMdFile!.content).toContain("<!-- am:begin -->");
    expect(agentsMdFile!.content).toContain("<!-- am:end -->");
  });
});
