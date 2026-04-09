import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "@/adapters/cursor/detect.ts";

describe("cursor detect()", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "am-cursor-detect-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  test("detects when ~/.cursor/ directory exists", async () => {
    await mkdir(join(tempHome, ".cursor"));
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.configDir).toBe(join(tempHome, ".cursor"));
  });

  test("detects global mcp.json", async () => {
    await mkdir(join(tempHome, ".cursor"), { recursive: true });
    await writeFile(join(tempHome, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.globalMcpConfig).toBe(join(tempHome, ".cursor", "mcp.json"));
  });

  test("returns installed:false when nothing exists", () => {
    const result = detect(tempHome);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("includes project .cursor/mcp.json path", async () => {
    await mkdir(join(tempHome, ".cursor"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".cursor"), { recursive: true });
    await writeFile(join(projectDir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));

    const result = detect(tempHome, projectDir);
    expect(result.paths.projectMcpConfig).toBe(join(projectDir, ".cursor", "mcp.json"));
  });

  test("includes .cursor/rules/ path when present", async () => {
    await mkdir(join(tempHome, ".cursor"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".cursor", "rules"), { recursive: true });

    const result = detect(tempHome, projectDir);
    expect(result.paths.rulesDir).toBe(join(projectDir, ".cursor", "rules"));
  });

  test("includes .cursorrules path when present", async () => {
    await mkdir(join(tempHome, ".cursor"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".cursorrules"), "rules here");

    const result = detect(tempHome, projectDir);
    expect(result.paths.legacyRules).toBe(join(projectDir, ".cursorrules"));
  });

  test("includes .cursor/agents/ path when present", async () => {
    await mkdir(join(tempHome, ".cursor"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".cursor", "agents"), { recursive: true });

    const result = detect(tempHome, projectDir);
    expect(result.paths.agentsDir).toBe(join(projectDir, ".cursor", "agents"));
  });

  test("does not include project paths when projectPath not provided", async () => {
    await mkdir(join(tempHome, ".cursor"));
    const result = detect(tempHome);
    expect(result.paths.projectMcpConfig).toBeUndefined();
    expect(result.paths.rulesDir).toBeUndefined();
    expect(result.paths.legacyRules).toBeUndefined();
    expect(result.paths.agentsDir).toBeUndefined();
  });
});
