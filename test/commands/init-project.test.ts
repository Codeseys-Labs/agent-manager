import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { initProject } from "@/commands/init-project.ts";
import type { ProjectConfig } from "@/core/schema.ts";
import * as TOML from "@iarna/toml";
import { type TestDir, createTestDir } from "../helpers/tmp.ts";

const silentOpts = { json: false, quiet: true, verbose: false };

describe("initProject()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("scans Claude Code project configs and creates .agent-manager.toml", async () => {
    dir = await createTestDir("am-init-project-");
    const projectDir = join(dir.path, "my-app");

    // Write Claude Code project config (.mcp.json)
    await dir.write(
      "my-app/.mcp.json",
      JSON.stringify({
        mcpServers: {
          fetch: {
            command: "uvx",
            args: ["mcp-server-fetch"],
          },
          postgres: {
            command: "npx",
            args: ["-y", "pg-mcp"],
            env: { DATABASE_URL: "postgres://localhost/mydb" },
          },
        },
      }),
    );

    // Write CLAUDE.md (instructions)
    await dir.write("my-app/CLAUDE.md", "# Project Rules\n\nUse strict TypeScript.");

    const result = await initProject(projectDir, silentOpts);
    expect(result.written).toBe(true);
    expect(result.config).toBeDefined();

    // Verify .agent-manager.toml was written
    const tomlContent = await dir.read("my-app/.agent-manager.toml");
    const parsed = TOML.parse(tomlContent) as unknown as ProjectConfig;

    expect(parsed.project?.name).toBe("my-app");

    // Check servers
    expect(parsed.servers).toBeDefined();
    const serverNames = Object.keys(parsed.servers!);
    expect(serverNames).toContain("fetch");
    expect(serverNames).toContain("postgres");
    expect(parsed.servers?.fetch.command).toBe("uvx");
    expect(parsed.servers?.postgres.args).toEqual(["-y", "pg-mcp"]);
  });

  test("uses content_file for instructions within the project", async () => {
    dir = await createTestDir("am-init-project-");
    const projectDir = join(dir.path, "my-app");

    // Write Claude Code configs
    await dir.write(
      "my-app/.mcp.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
        },
      }),
    );
    await dir.write("my-app/CLAUDE.md", "# Instructions\n\nAlways use TypeScript.");

    const result = await initProject(projectDir, silentOpts);
    expect(result.written).toBe(true);

    const tomlContent = await dir.read("my-app/.agent-manager.toml");
    const parsed = TOML.parse(tomlContent) as unknown as ProjectConfig;

    // Instructions should use content_file reference (relative path)
    expect(parsed.instructions).toBeDefined();
    const instrKeys = Object.keys(parsed.instructions!);
    expect(instrKeys.length).toBeGreaterThan(0);

    // At least one instruction should reference CLAUDE.md
    const hasContentFile = Object.values(parsed.instructions!).some(
      (i) => i.content_file === "CLAUDE.md",
    );
    expect(hasContentFile).toBe(true);
  });

  test("deduplicates servers across adapters by identity", async () => {
    dir = await createTestDir("am-init-project-");
    const projectDir = join(dir.path, "my-app");

    // Claude Code: has fetch server
    await dir.write(
      "my-app/.mcp.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          tavily: { command: "bunx", args: ["tavily-mcp@latest"] },
        },
      }),
    );

    // Cursor: also has fetch server (same identity)
    await dir.write(
      "my-app/.cursor/mcp.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
          "cursor-only": { command: "node", args: ["cursor-server.js"] },
        },
      }),
    );

    const result = await initProject(projectDir, silentOpts);
    expect(result.written).toBe(true);

    const tomlContent = await dir.read("my-app/.agent-manager.toml");
    const parsed = TOML.parse(tomlContent) as unknown as ProjectConfig;

    // "fetch" should appear only once (deduped)
    const serverNames = Object.keys(parsed.servers!);
    expect(serverNames.filter((n) => n === "fetch").length).toBe(1);
  });

  test("refuses when .agent-manager.toml already exists", async () => {
    dir = await createTestDir("am-init-project-");
    const projectDir = join(dir.path, "my-app");

    await dir.write("my-app/.agent-manager.toml", "# existing");
    await dir.write(
      "my-app/.mcp.json",
      JSON.stringify({
        mcpServers: { fetch: { command: "uvx", args: ["mcp-server-fetch"] } },
      }),
    );

    const result = await initProject(projectDir, silentOpts);
    expect(result.written).toBe(false);
  });

  test("returns written:false when no configs found", async () => {
    dir = await createTestDir("am-init-project-");
    const projectDir = join(dir.path, "empty-project");
    await dir.write("empty-project/.keep", "");

    const result = await initProject(projectDir, silentOpts);
    expect(result.written).toBe(false);
  });

  test("handles multiple instruction sources", async () => {
    dir = await createTestDir("am-init-project-");
    const projectDir = join(dir.path, "my-app");

    // Claude Code
    await dir.write("my-app/.mcp.json", JSON.stringify({ mcpServers: {} }));
    await dir.write("my-app/CLAUDE.md", "# Claude instructions");

    // Windsurf rules
    await dir.write(
      "my-app/.windsurf/rules/coding.md",
      "---\ntrigger: always_on\n---\n\nUse functional components.",
    );

    const result = await initProject(projectDir, silentOpts);
    expect(result.written).toBe(true);

    const tomlContent = await dir.read("my-app/.agent-manager.toml");
    const parsed = TOML.parse(tomlContent) as unknown as ProjectConfig;

    // Should have instructions from multiple sources
    expect(parsed.instructions).toBeDefined();
    expect(Object.keys(parsed.instructions!).length).toBeGreaterThanOrEqual(1);
  });

  test("JSON output includes structured data", async () => {
    dir = await createTestDir("am-init-project-");
    const projectDir = join(dir.path, "my-app");

    await dir.write(
      "my-app/.mcp.json",
      JSON.stringify({
        mcpServers: {
          fetch: { command: "uvx", args: ["mcp-server-fetch"] },
        },
      }),
    );

    // Capture JSON output
    const logs: unknown[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args[0]);

    try {
      await initProject(projectDir, { json: true, quiet: false, verbose: false });
    } finally {
      console.log = origLog;
    }

    // Find the JSON output line
    const jsonLine = logs.find((l) => typeof l === "string" && l.includes('"action"'));
    expect(jsonLine).toBeDefined();

    const parsed = JSON.parse(jsonLine as string);
    expect(parsed.action).toBe("init-project");
    expect(parsed.servers).toContain("fetch");
  });

  test("preserves server env vars and description", async () => {
    dir = await createTestDir("am-init-project-");
    const projectDir = join(dir.path, "my-app");

    await dir.write(
      "my-app/.mcp.json",
      JSON.stringify({
        mcpServers: {
          mydb: {
            command: "npx",
            args: ["-y", "pg-mcp"],
            env: { DATABASE_URL: "postgres://localhost/test" },
          },
        },
      }),
    );

    const result = await initProject(projectDir, silentOpts);
    expect(result.written).toBe(true);

    const tomlContent = await dir.read("my-app/.agent-manager.toml");
    const parsed = TOML.parse(tomlContent) as unknown as ProjectConfig;

    expect(parsed.servers?.mydb.env).toEqual({
      DATABASE_URL: "postgres://localhost/test",
    });
  });
});
