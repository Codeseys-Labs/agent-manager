import { afterEach, describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { getGlobalStoragePath } from "@/adapters/roo-code/detect.ts";
import { diffConfig } from "@/adapters/roo-code/diff.ts";
import { exportConfig } from "@/adapters/roo-code/export.ts";
import { importConfig } from "@/adapters/roo-code/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { toPosix } from "../../helpers/path.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

function settingsRel(home: string): string {
  return join(relative(home, getGlobalStoragePath(home)), "settings", "mcp_settings.json");
}

/** Write mcp_settings.json into the fake VS Code globalStorage path. */
async function writeMcpSettings(dir: TestDir, content: string) {
  await dir.write(settingsRel(dir.path), content);
}

describe("Roo Code adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import → transform → export → diff shows in-sync", async () => {
    dir = await createTestDir("am-roo-roundtrip-");

    // 1. Write sample native mcp_settings.json
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

    await writeMcpSettings(dir, JSON.stringify(sampleMcp));

    // 2. Import
    const imported = importConfig({ entities: ["servers"] }, dir.path);
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
        adapters: s.adapterExtras ? { "roo-code": s.adapterExtras } : {},
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
    const mcpFile = exported.files.find((f) => f.path.includes("mcp_settings.json"));
    expect(mcpFile).toBeDefined();
    expect(mcpFile?.written).toBe(true);

    // 5. Verify output
    const outputJson = JSON.parse(mcpFile!.content);
    expect(outputJson.mcpServers.fetch.command).toBe("uvx");
    expect(outputJson.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(outputJson.mcpServers.tavily.env.TAVILY_API_KEY).toBe("${TAVILY_API_KEY}");

    // 6. Diff should show in-sync after roundtrip
    const diff = diffConfig(resolved, {}, dir.path);
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });

  test("project servers roundtrip through .roo/mcp.json", async () => {
    dir = await createTestDir("am-roo-roundtrip-proj-");
    const projectDir = `${dir.path}/project`;

    // Need global settings to exist for diff to not return "unmanaged"
    await writeMcpSettings(dir, JSON.stringify({ mcpServers: {} }));

    await dir.write(
      "project/.roo/mcp.json",
      JSON.stringify({
        mcpServers: {
          "local-dev": { command: "node", args: ["dev-server.js"] },
        },
      }),
    );

    // Import
    const imported = importConfig({ projectPath: projectDir, entities: ["servers"] }, dir.path);
    const projServer = imported.servers.find((s) => s.name === "local-dev");
    expect(projServer).toBeDefined();
    expect(projServer?.scope).toBe("project");

    // Transform — mark as project scope via adapter extras
    const resolvedServers: Record<string, ResolvedServer> = {};
    for (const s of imported.servers) {
      if (s.scope === "project") {
        resolvedServers[s.name] = {
          name: s.name,
          command: s.command,
          args: s.args ?? [],
          env: s.env ?? {},
          transport: "stdio",
          description: "",
          tags: [],
          enabled: true,
          adapters: { "roo-code": { scope: "project" } },
        };
      }
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
    const exported = exportConfig(resolved, { projectPath: projectDir }, dir.path);
    const projectMcpFile = exported.files.find((f) => toPosix(f.path).includes(".roo/mcp.json"));
    expect(projectMcpFile).toBeDefined();
    const output = JSON.parse(projectMcpFile!.content);
    expect(output.mcpServers["local-dev"].command).toBe("node");
  });

  test("instructions roundtrip through .roo/rules/", async () => {
    dir = await createTestDir("am-roo-roundtrip-rules-");
    const projectDir = `${dir.path}/project`;

    await dir.write(
      "project/.roo/rules/code-style.md",
      "Use TypeScript strict mode.\nPrefer const over let.",
    );

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
          targets: ["roo-code"],
          adapters: {},
        },
      },
      skills: {},
      agents: {},
      profile: "default",
      adapters: {},
    };

    // Export (dry run)
    const exported = exportConfig(resolved, { projectPath: projectDir, dryRun: true }, dir.path);
    const ruleFile = exported.files.find(
      (f) => f.path.endsWith(".md") && toPosix(f.path).includes(".roo/rules/"),
    );
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.content).toContain("Use TypeScript strict mode.");
  });
});
