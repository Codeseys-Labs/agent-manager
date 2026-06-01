import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { diffConfig } from "@/adapters/cursor/diff.ts";
import { exportConfig } from "@/adapters/cursor/export.ts";
import { importConfig } from "@/adapters/cursor/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { toPosix } from "../../helpers/path.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("Cursor adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import → transform → export → diff shows in-sync", async () => {
    dir = await createTestDir("am-cursor-roundtrip-");

    // 1. Write sample native configs
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

    await dir.write(".cursor/mcp.json", JSON.stringify(sampleMcp));

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
        adapters: s.adapterExtras ? { cursor: s.adapterExtras } : {},
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
    const globalFile = exported.files.find((f) => toPosix(f.path).includes(".cursor/mcp.json"));
    expect(globalFile).toBeDefined();
    expect(globalFile?.written).toBe(true);

    // 5. Verify output
    const outputJson = JSON.parse(globalFile!.content);
    expect(outputJson.mcpServers.fetch.command).toBe("uvx");
    expect(outputJson.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
    expect(outputJson.mcpServers.tavily.env.TAVILY_API_KEY).toBe("${TAVILY_API_KEY}");

    // 6. Diff should show in-sync after roundtrip
    const diff = diffConfig(resolved, {}, dir.path);
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });

  test("import from fixtures → roundtrip", async () => {
    dir = await createTestDir("am-cursor-roundtrip-fixture-");

    // Copy fixture files to temp dir
    const fixtureDir = join(import.meta.dir, "../../fixtures/cursor");
    const fs = require("node:fs");
    const sampleGlobal = fs.readFileSync(join(fixtureDir, "global-mcp.json"), "utf-8");
    await dir.write(".cursor/mcp.json", sampleGlobal);

    const projectDir = `${dir.path}/project`;
    const sampleProject = fs.readFileSync(join(fixtureDir, "project-mcp.json"), "utf-8");
    await dir.write("project/.cursor/mcp.json", sampleProject);

    // Import global + project
    const imported = importConfig({ projectPath: projectDir }, dir.path);
    expect(imported.servers.length).toBeGreaterThan(0);

    // Verify server scopes
    const globalServers = imported.servers.filter((s) => s.scope === "global");
    const projectServers = imported.servers.filter((s) => s.scope === "project");
    expect(globalServers.length).toBe(3); // from global-mcp.json
    expect(projectServers.length).toBe(2); // from project-mcp.json
  });

  test("instructions roundtrip through .mdc files", async () => {
    dir = await createTestDir("am-cursor-roundtrip-mdc-");
    const projectDir = `${dir.path}/project`;

    // Write sample .mdc file
    await dir.write(
      "project/.cursor/rules/ts.mdc",
      `---
description: "TypeScript rules"
globs: ["**/*.ts"]
alwaysApply: false
---

Use strict TypeScript.`,
    );

    // Import
    const imported = importConfig(
      { projectPath: projectDir, entities: ["instructions"] },
      dir.path,
    );
    expect(imported.instructions).toHaveLength(1);
    const instr = imported.instructions[0];

    // Transform to resolved
    const resolved: ResolvedConfig = {
      servers: {},
      instructions: {
        [instr.name]: {
          name: instr.name,
          content: instr.content,
          scope: instr.scope,
          globs: ["**/*.ts"],
          description: instr.description ?? "",
          targets: ["cursor"],
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
    const mdcFile = exported.files.find((f) => f.path.endsWith(".mdc"));
    expect(mdcFile).toBeDefined();
    expect(mdcFile!.content).toContain('description: "TypeScript rules"');
    expect(mdcFile!.content).toContain('globs: ["**/*.ts"]');
    expect(mdcFile!.content).toContain("Use strict TypeScript.");
  });
});
