import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { exportConfig } from "@/adapters/continue/export.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

function server(overrides: Partial<ResolvedServer> & { command: string }): ResolvedServer {
  return {
    name: "test",
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

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    servers: {},
    instructions: {},
    skills: {},
    profile: "default",
    adapters: {},
    agents: {},
    ...overrides,
  };
}

describe("continue exportConfig()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("generates config.json with mcpServers as array", async () => {
    dir = await createTestDir("am-ct-export-");
    const cfg = config({
      servers: {
        sqlite: server({
          name: "sqlite",
          command: "uvx",
          args: ["mcp-server-sqlite", "--db-path", "./test.db"],
          env: { NODE_ENV: "production" },
        }),
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    expect(result.files.length).toBeGreaterThanOrEqual(1);

    const configFile = result.files.find((f) => f.path.endsWith("config.json"));
    expect(configFile).toBeDefined();

    const parsed = JSON.parse(configFile?.content);
    expect(Array.isArray(parsed.mcpServers)).toBe(true);
    expect(parsed.mcpServers).toHaveLength(2);

    const sqliteEntry = parsed.mcpServers.find((s: any) => s.name === "sqlite");
    expect(sqliteEntry.command).toBe("uvx");
    expect(sqliteEntry.args).toEqual(["mcp-server-sqlite", "--db-path", "./test.db"]);
    expect(sqliteEntry.env.NODE_ENV).toBe("production");

    const fetchEntry = parsed.mcpServers.find((s: any) => s.name === "fetch");
    expect(fetchEntry.command).toBe("uvx");
  });

  test("skips disabled servers", async () => {
    dir = await createTestDir("am-ct-export-");
    const cfg = config({
      servers: {
        enabled_one: server({ name: "enabled_one", command: "enabled-mcp" }),
        disabled_one: server({
          name: "disabled_one",
          command: "disabled-mcp",
          enabled: false,
        }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    const configFile = result.files.find((f) => f.path.endsWith("config.json"));
    const parsed = JSON.parse(configFile?.content);
    expect(parsed.mcpServers).toHaveLength(1);
    expect(parsed.mcpServers[0].name).toBe("enabled_one");
  });

  test("skips instructions not targeting continue", async () => {
    dir = await createTestDir("am-ct-export-");
    const cfg = config({
      instructions: {
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
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    const configFile = result.files.find((f) => f.path.endsWith("config.json"));
    const parsed = JSON.parse(configFile?.content);
    expect(parsed.rules).toBeUndefined();
  });

  test("exports instructions as rules with uses references", async () => {
    dir = await createTestDir("am-ct-export-");
    const cfg = config({
      instructions: {
        "my-rules": {
          name: "my-rules",
          content: "org/my-ruleset",
          scope: "always",
          globs: [],
          description: "",
          targets: [],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    const configFile = result.files.find((f) => f.path.endsWith("config.json"));
    const parsed = JSON.parse(configFile?.content);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0].uses).toBe("org/my-ruleset");
  });

  test("dry run doesn't write files", async () => {
    dir = await createTestDir("am-ct-export-");
    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    for (const file of result.files) {
      expect(file.written).toBe(false);
    }
  });

  test("actual write creates files on disk", async () => {
    dir = await createTestDir("am-ct-export-");
    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = exportConfig(cfg, {}, dir.path);
    const configFile = result.files.find((f) => f.path.endsWith("config.json"));
    expect(configFile?.written).toBe(true);
    const content = JSON.parse(await dir.read(".continue/config.json"));
    expect(content.mcpServers[0].name).toBe("fetch");
  });

  test("preserves existing non-MCP fields in config.json", async () => {
    dir = await createTestDir("am-ct-export-");
    await dir.write(
      ".continue/config.json",
      JSON.stringify({
        name: "my-config",
        version: "1.0",
        models: [{ name: "claude", provider: "anthropic" }],
        mcpServers: [{ name: "old", command: "old-mcp" }],
      }),
    );

    const cfg = config({
      servers: {
        fetch: server({
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
        }),
      },
    });

    const result = exportConfig(cfg, {}, dir.path);
    const configFile = result.files.find((f) => f.path.endsWith("config.json"));
    const parsed = JSON.parse(configFile?.content);
    expect(parsed.name).toBe("my-config");
    expect(parsed.models).toHaveLength(1);
    expect(parsed.mcpServers).toHaveLength(1);
    expect(parsed.mcpServers[0].name).toBe("fetch");
  });

  test("writes rule .md files for instructions with inline content", async () => {
    dir = await createTestDir("am-ct-export-");
    const cfg = config({
      instructions: {
        "coding-standards": {
          name: "coding-standards",
          content: "Always use strict TypeScript.",
          scope: "always",
          globs: [],
          description: "",
          targets: [],
          adapters: {},
        },
        "test-rules": {
          name: "test-rules",
          content: "Write tests for all new code.",
          scope: "always",
          globs: [],
          description: "",
          targets: ["continue"],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);

    // config.json + 2 rule files
    const ruleFiles = result.files.filter((f) => f.path.endsWith(".md"));
    expect(ruleFiles).toHaveLength(2);

    const codingFile = ruleFiles.find((f) => f.path.includes("coding-standards.md"));
    expect(codingFile).toBeDefined();
    expect(codingFile?.content).toContain("Always use strict TypeScript.");
    expect(codingFile?.path).toContain(".continue/rules/coding-standards.md");

    const testFile = ruleFiles.find((f) => f.path.includes("test-rules.md"));
    expect(testFile).toBeDefined();
    expect(testFile?.content).toContain("Write tests for all new code.");
  });

  test("writes rule files to disk on actual export", async () => {
    dir = await createTestDir("am-ct-export-");
    const projectPath = join(dir.path, "my-project");
    const cfg = config({
      instructions: {
        "my-rule": {
          name: "my-rule",
          content: "Follow the conventions.",
          scope: "always",
          globs: [],
          description: "",
          targets: [],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { projectPath }, dir.path);
    const ruleFile = result.files.find((f) => f.path.endsWith("my-rule.md"));
    expect(ruleFile).toBeDefined();
    expect(ruleFile?.written).toBe(true);

    // Verify the file is on disk at the project path
    const fs = require("node:fs");
    const onDisk = fs.readFileSync(join(projectPath, ".continue", "rules", "my-rule.md"), "utf-8");
    expect(onDisk).toContain("Follow the conventions.");
  });

  test("skips rule files for external references", async () => {
    dir = await createTestDir("am-ct-export-");
    const cfg = config({
      instructions: {
        "external-ref": {
          name: "external-ref",
          content: "org/my-ruleset",
          scope: "always",
          globs: [],
          description: "",
          targets: [],
          adapters: {},
        },
        "file-ref": {
          name: "file-ref",
          content: "file://.continue/rules/custom.md",
          scope: "always",
          globs: [],
          description: "",
          targets: [],
          adapters: {},
        },
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    const ruleFiles = result.files.filter((f) => f.path.endsWith(".md"));
    // External references should NOT produce .md files
    expect(ruleFiles).toHaveLength(0);
  });

  test("maps adapter-specific fields to export", async () => {
    dir = await createTestDir("am-ct-export-");
    const cfg = config({
      servers: {
        proj: server({
          name: "proj",
          command: "node",
          args: ["server.js"],
          adapters: { continue: { cwd: "/path/to/project" } },
        }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    const configFile = result.files.find((f) => f.path.endsWith("config.json"));
    const parsed = JSON.parse(configFile?.content);
    expect(parsed.mcpServers[0].cwd).toBe("/path/to/project");
  });
});
