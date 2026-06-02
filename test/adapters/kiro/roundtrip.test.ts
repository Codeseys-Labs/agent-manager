import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { diffConfig } from "@/adapters/kiro/diff.ts";
import { exportConfig } from "@/adapters/kiro/export.ts";
import { importConfig } from "@/adapters/kiro/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { toPosix } from "../../helpers/path.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("Kiro adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import → transform → export → diff shows in-sync", async () => {
    dir = await createTestDir("am-kiro-roundtrip-");

    // 1. Write sample native mcp.json
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

    await dir.write(".kiro/settings/mcp.json", JSON.stringify(sampleMcp));

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
        adapters: s.adapterExtras ? { kiro: s.adapterExtras } : {},
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
    const globalFile = exported.files.find((f) =>
      toPosix(f.path).includes(".kiro/settings/mcp.json"),
    );
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
    dir = await createTestDir("am-kiro-roundtrip-fixture-");

    // Copy fixture files to temp dir
    const fixtureDir = join(import.meta.dir, "../../fixtures/kiro");
    const fs = require("node:fs");
    const sampleMcp = fs.readFileSync(join(fixtureDir, "mcp.json"), "utf-8");
    await dir.write(".kiro/settings/mcp.json", sampleMcp);

    const projectDir = `${dir.path}/project`;
    // Also place mcp.json at project level
    await dir.write("project/.kiro/settings/mcp.json", sampleMcp);

    // Import global + project
    const imported = importConfig({ projectPath: projectDir }, dir.path);
    expect(imported.servers.length).toBeGreaterThan(0);

    // Verify server scopes
    const globalServers = imported.servers.filter((s) => s.scope === "global");
    const projectServers = imported.servers.filter((s) => s.scope === "project");
    expect(globalServers.length).toBeGreaterThan(0);
    expect(projectServers.length).toBeGreaterThan(0);

    // Verify disabled server imported correctly
    const disabledServer = imported.servers.find((s) => s.name === "disabled-server");
    expect(disabledServer).toBeDefined();
    expect(disabledServer?.enabled).toBe(false);
  });

  test("instructions roundtrip through steering files", async () => {
    dir = await createTestDir("am-kiro-roundtrip-steering-");
    const projectDir = `${dir.path}/project`;

    // Write sample steering file
    await dir.write(
      "project/.kiro/steering/code-style.md",
      `---
inclusion: always
description: "Code style and conventions"
---

Use TypeScript strict mode.
Prefer const over let.`,
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
          targets: ["kiro"],
          adapters: {},
        },
      },
      skills: {},
      agents: {},
      profile: "default",
      adapters: {},
    };

    // Export
    const exported = await exportConfig(
      resolved,
      {
        projectPath: projectDir,
        dryRun: true,
      },
      dir.path,
    );
    const steeringFile = exported.files.find((f) => f.path.endsWith(".md"));
    expect(steeringFile).toBeDefined();
    expect(steeringFile!.content).toContain("Use TypeScript strict mode.");
    expect(steeringFile!.content).toContain("<!-- am:begin -->");
    expect(steeringFile!.content).toContain("<!-- am:end -->");
  });
});
