import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "@/adapters/roo-code/detect.ts";

describe("roo-code detect()", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "am-roo-detect-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  test("detects when globalStorage directory exists", async () => {
    const storagePath = join(
      tempHome,
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "rooveterinaryinc.roo-cline",
    );
    await mkdir(storagePath, { recursive: true });

    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.globalStorageDir).toBe(storagePath);
  });

  test("detects mcp_settings.json", async () => {
    const settingsDir = join(
      tempHome,
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "rooveterinaryinc.roo-cline",
      "settings",
    );
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "mcp_settings.json"), '{"mcpServers":{}}');

    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.mcpSettings).toBe(join(settingsDir, "mcp_settings.json"));
  });

  test("returns installed:false when nothing exists", () => {
    const result = detect(tempHome);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("finds .roo/ directory at project root", async () => {
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".roo"), { recursive: true });

    const result = detect(tempHome, projectDir);
    expect(result.paths.rooDir).toBe(join(projectDir, ".roo"));
  });

  test("finds .roo/mcp.json at project root", async () => {
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".roo"), { recursive: true });
    await writeFile(join(projectDir, ".roo", "mcp.json"), '{"mcpServers":{}}');

    const result = detect(tempHome, projectDir);
    expect(result.paths.projectMcp).toBe(join(projectDir, ".roo", "mcp.json"));
  });

  test("finds .roomodes file at project root", async () => {
    const projectDir = join(tempHome, "my-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".roomodes"), "customModes: []");

    const result = detect(tempHome, projectDir);
    expect(result.paths.roomodes).toBe(join(projectDir, ".roomodes"));
  });

  test("finds .roo/rules/ directory", async () => {
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".roo", "rules"), { recursive: true });

    const result = detect(tempHome, projectDir);
    expect(result.paths.sharedRulesDir).toBe(join(projectDir, ".roo", "rules"));
  });

  test("does not include project paths when projectPath not provided", async () => {
    const storagePath = join(
      tempHome,
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "rooveterinaryinc.roo-cline",
    );
    await mkdir(storagePath, { recursive: true });

    const result = detect(tempHome);
    expect(result.paths.rooDir).toBeUndefined();
    expect(result.paths.projectMcp).toBeUndefined();
    expect(result.paths.roomodes).toBeUndefined();
  });
});
