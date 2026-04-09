import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { diffConfig } from "@/adapters/gemini-cli/diff.ts";
import { exportConfig } from "@/adapters/gemini-cli/export.ts";
import { importConfig } from "@/adapters/gemini-cli/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("Gemini CLI adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import -> transform -> export -> verify output matches", async () => {
    dir = await createTestDir("am-gc-roundtrip-");

    // 1. Write sample native configs
    const sampleSettings = {
      general: { vimMode: false },
      model: { name: "gemini-2.5-pro" },
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

    await dir.write(".gemini/settings.json", JSON.stringify(sampleSettings));

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
        adapters: s.adapterExtras ? { "gemini-cli": s.adapterExtras } : {},
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
    const globalFile = exported.files.find((f) => f.path.endsWith("settings.json"));
    expect(globalFile).toBeDefined();
    expect(globalFile?.written).toBe(true);

    // 5. Verify output
    const outputJson = JSON.parse(globalFile?.content);

    // Non-MCP fields preserved
    expect(outputJson.general.vimMode).toBe(false);
    expect(outputJson.model.name).toBe("gemini-2.5-pro");

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

  test("import from fixtures -> roundtrip", async () => {
    dir = await createTestDir("am-gc-roundtrip-fixture-");

    // Copy fixture files to temp dir
    const fixtureDir = join(import.meta.dir, "../../fixtures/gemini-cli");
    const fs = require("node:fs");
    const sampleSettings = fs.readFileSync(join(fixtureDir, "sample-settings.json"), "utf-8");
    await dir.write(".gemini/settings.json", sampleSettings);

    const projectDir = `${dir.path}/project`;
    const sampleProjectSettings = fs.readFileSync(
      join(fixtureDir, "sample-project-settings.json"),
      "utf-8",
    );
    await dir.write("project/.gemini/settings.json", sampleProjectSettings);

    const sampleGeminiMd = fs.readFileSync(join(fixtureDir, "sample-GEMINI.md"), "utf-8");
    await dir.write("project/GEMINI.md", sampleGeminiMd);

    // Import global + project
    const imported = importConfig({ projectPath: projectDir }, dir.path);
    expect(imported.servers.length).toBeGreaterThan(0);
    expect(imported.instructions).toHaveLength(1);

    // Verify server scopes
    const globalServers = imported.servers.filter((s) => s.scope === "global");
    const projectServers = imported.servers.filter((s) => s.scope === "project");
    expect(globalServers.length).toBe(4); // from sample-settings.json
    expect(projectServers.length).toBe(2); // from sample-project-settings.json
  });

  test("roundtrip preserves adapter extras", async () => {
    dir = await createTestDir("am-gc-roundtrip-extras-");

    await dir.write(
      ".gemini/settings.json",
      JSON.stringify({
        mcpServers: {
          trusted: {
            command: "my-mcp",
            trust: true,
            timeout: 60000,
            includeTools: ["tool1", "tool2"],
          },
        },
      }),
    );

    // Import
    const imported = importConfig({}, dir.path);
    expect(imported.servers).toHaveLength(1);
    expect(imported.servers[0].adapterExtras?.trust).toBe(true);

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
        adapters: s.adapterExtras ? { "gemini-cli": s.adapterExtras } : {},
      };
    }

    const resolved: ResolvedConfig = {
      servers: resolvedServers,
      instructions: {},
      skills: {},
      profile: "default",
      adapters: {},
    };

    // Export
    const exported = exportConfig(resolved, {}, dir.path);
    const globalFile = exported.files.find((f) => f.path.endsWith("settings.json"));
    const parsed = JSON.parse(globalFile?.content);
    expect(parsed.mcpServers.trusted.trust).toBe(true);
    expect(parsed.mcpServers.trusted.timeout).toBe(60000);
    expect(parsed.mcpServers.trusted.includeTools).toEqual(["tool1", "tool2"]);
  });
});
