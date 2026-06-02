import { afterEach, describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { getGlobalStoragePath } from "@/adapters/roo-code/detect.ts";
import { exportConfig } from "@/adapters/roo-code/export.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { toPosix } from "../../helpers/path.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

function settingsRel(home: string): string {
  return join(relative(home, getGlobalStoragePath(home)), "settings", "mcp_settings.json");
}

function makeResolved(
  servers: Record<string, ResolvedServer>,
  instructions: ResolvedConfig["instructions"] = {},
): ResolvedConfig {
  return {
    servers,
    instructions,
    skills: {},
    agents: {},
    profile: "default",
    adapters: {},
  };
}

function makeServer(
  overrides: Partial<ResolvedServer> & { name: string; command: string },
): ResolvedServer {
  return {
    args: [],
    env: {},
    transport: "stdio",
    description: "",
    tags: [],
    enabled: true,
    adapters: {},
    ...overrides,
  };
}

describe("roo-code exportConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("exports global servers to mcp_settings.json", async () => {
    dir = await createTestDir("am-roo-export-");
    const resolved = makeResolved({
      fetch: makeServer({
        name: "fetch",
        command: "uvx",
        args: ["mcp-server-fetch"],
      }),
    });

    const result = exportConfig(resolved, {}, dir.path);
    expect(result.warnings).toHaveLength(0);

    const mcpFile = result.files.find((f) => toPosix(f.path).includes("mcp_settings.json"));
    expect(mcpFile).toBeDefined();
    expect(mcpFile?.written).toBe(true);

    const output = JSON.parse(mcpFile!.content);
    expect(output.mcpServers.fetch.command).toBe("uvx");
    expect(output.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
  });

  test("exports project servers to .roo/mcp.json", async () => {
    dir = await createTestDir("am-roo-export-");
    const projectDir = `${dir.path}/project`;
    const resolved = makeResolved({
      "proj-server": makeServer({
        name: "proj-server",
        command: "node",
        args: ["server.js"],
        adapters: { "roo-code": { scope: "project" } },
      }),
    });

    const result = exportConfig(resolved, { projectPath: projectDir }, dir.path);
    const projectFile = result.files.find((f) => toPosix(f.path).includes(".roo/mcp.json"));
    expect(projectFile).toBeDefined();
    expect(projectFile?.written).toBe(true);

    const output = JSON.parse(projectFile!.content);
    expect(output.mcpServers["proj-server"].command).toBe("node");
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-roo-export-");
    const resolved = makeResolved({
      disabled: makeServer({
        name: "disabled",
        command: "old-mcp",
        enabled: false,
      }),
    });

    const result = exportConfig(resolved, {}, dir.path);
    const mcpFile = result.files.find((f) => toPosix(f.path).includes("mcp_settings.json"));
    expect(mcpFile).toBeDefined();
    const output = JSON.parse(mcpFile!.content);
    expect(Object.keys(output.mcpServers)).toHaveLength(0);
  });

  test("writes adapter extras (alwaysAllow) to native format", async () => {
    dir = await createTestDir("am-roo-export-");
    const resolved = makeResolved({
      fetch: makeServer({
        name: "fetch",
        command: "uvx",
        args: ["mcp-server-fetch"],
        adapters: { "roo-code": { alwaysAllow: ["fetch_url"] } },
      }),
    });

    const result = exportConfig(resolved, {}, dir.path);
    const mcpFile = result.files.find((f) => toPosix(f.path).includes("mcp_settings.json"));
    const output = JSON.parse(mcpFile!.content);
    expect(output.mcpServers.fetch.alwaysAllow).toEqual(["fetch_url"]);
  });

  test("generates .roo/rules/*.md from instructions", async () => {
    dir = await createTestDir("am-roo-export-");
    const projectDir = `${dir.path}/project`;
    const resolved = makeResolved(
      {},
      {
        "code-style": {
          name: "code-style",
          content: "Use TypeScript strict mode.",
          scope: "always",
          globs: [],
          description: "Code style rules",
          targets: [],
          adapters: {},
        },
      },
    );

    const result = exportConfig(resolved, { projectPath: projectDir, dryRun: true }, dir.path);
    const ruleFile = result.files.find((f) => toPosix(f.path).endsWith("code-style.md"));
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.content).toBe("Use TypeScript strict mode.\n");
    expect(ruleFile && toPosix(ruleFile.path)).toContain(".roo/rules/");
  });

  test("skips instructions targeted at other adapters", async () => {
    dir = await createTestDir("am-roo-export-");
    const projectDir = `${dir.path}/project`;
    const resolved = makeResolved(
      {},
      {
        "claude-only": {
          name: "claude-only",
          content: "Only for Claude.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["claude-code"],
          adapters: {},
        },
      },
    );

    const result = exportConfig(resolved, { projectPath: projectDir, dryRun: true }, dir.path);
    const ruleFiles = result.files.filter((f) => toPosix(f.path).includes(".roo/rules/"));
    expect(ruleFiles).toHaveLength(0);
  });

  test("preserves existing non-managed fields in mcp_settings.json", async () => {
    dir = await createTestDir("am-roo-export-");
    // Pre-populate with existing content
    await dir.write(
      settingsRel(dir.path),
      JSON.stringify({ customField: "preserved", mcpServers: {} }),
    );

    const resolved = makeResolved({
      fetch: makeServer({
        name: "fetch",
        command: "uvx",
        args: ["mcp-server-fetch"],
      }),
    });

    const result = exportConfig(resolved, {}, dir.path);
    const mcpFile = result.files.find((f) => toPosix(f.path).includes("mcp_settings.json"));
    const output = JSON.parse(mcpFile!.content);
    expect(output.customField).toBe("preserved");
    expect(output.mcpServers.fetch.command).toBe("uvx");
  });
});
