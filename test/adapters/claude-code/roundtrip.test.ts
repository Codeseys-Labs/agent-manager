import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { diffConfig } from "@/adapters/claude-code/diff.ts";
import { exportConfig } from "@/adapters/claude-code/export.ts";
import { importConfig } from "@/adapters/claude-code/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("Claude Code adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import → transform → export → verify output matches", async () => {
    dir = await createTestDir("am-roundtrip-");

    // 1. Write sample native configs
    const sampleClaude = {
      numStartups: 42,
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

    await dir.write(".claude.json", JSON.stringify(sampleClaude));

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
        adapters: s.adapterExtras ? { "claude-code": s.adapterExtras } : {},
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
    const exported = await exportConfig(resolved, {}, dir.path);
    expect(exported.warnings).toHaveLength(0);
    const globalFile = exported.files.find((f) => f.path.endsWith(".claude.json"));
    expect(globalFile).toBeDefined();
    expect(globalFile?.written).toBe(true);

    // 5. Verify output
    const outputJson = JSON.parse(globalFile!.content);

    // Non-MCP fields preserved
    expect(outputJson.numStartups).toBe(42);

    // All servers present with correct fields
    expect(outputJson.mcpServers.fetch.command).toBe("uvx");
    expect(outputJson.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(outputJson.mcpServers.tavily.command).toBe("bunx");
    expect(outputJson.mcpServers.tavily.args).toEqual(["tavily-mcp@latest"]);
    expect(outputJson.mcpServers.tavily.env.TAVILY_API_KEY).toBe("${TAVILY_API_KEY}");
    expect(outputJson.mcpServers.context7.args).toEqual(["@upstash/context7-mcp@latest"]);

    // 6. Diff should show in-sync after roundtrip
    const diff = diffConfig(resolved, {}, dir.path);
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });

  test("import from fixtures → roundtrip", async () => {
    dir = await createTestDir("am-roundtrip-fixture-");

    // Copy fixture files to temp dir
    const fixtureDir = join(import.meta.dir, "../../fixtures/claude-code");
    const fs = require("node:fs");
    const sampleClaude = fs.readFileSync(join(fixtureDir, "sample-claude.json"), "utf-8");
    await dir.write(".claude.json", sampleClaude);

    const projectDir = `${dir.path}/project`;
    const sampleMcp = fs.readFileSync(join(fixtureDir, "sample-mcp.json"), "utf-8");
    await dir.write("project/.mcp.json", sampleMcp);

    const sampleClaudeMd = fs.readFileSync(join(fixtureDir, "sample-CLAUDE.md"), "utf-8");
    await dir.write("project/CLAUDE.md", sampleClaudeMd);

    // Import global + project
    const imported = importConfig({ projectPath: projectDir }, dir.path);
    expect(imported.servers.length).toBeGreaterThan(0);
    expect(imported.instructions).toHaveLength(1);

    // Verify server scopes
    const globalServers = imported.servers.filter((s) => s.scope === "global");
    const projectServers = imported.servers.filter((s) => s.scope === "project");
    expect(globalServers.length).toBe(5); // from sample-claude.json
    expect(projectServers.length).toBe(2); // from sample-mcp.json
  });
});
