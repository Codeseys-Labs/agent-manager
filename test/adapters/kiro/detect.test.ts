import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "@/adapters/kiro/detect.ts";

describe("kiro detect()", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "am-kiro-detect-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  test("detects when ~/.kiro/ directory exists", async () => {
    await mkdir(join(tempHome, ".kiro"));
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.globalConfigDir).toBe(join(tempHome, ".kiro"));
  });

  test("detects when ~/.kiro/settings/mcp.json exists", async () => {
    await mkdir(join(tempHome, ".kiro", "settings"), { recursive: true });
    await writeFile(join(tempHome, ".kiro", "settings", "mcp.json"), "{}");
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.globalMcpConfig).toBe(join(tempHome, ".kiro", "settings", "mcp.json"));
  });

  test("returns installed:false when nothing exists", () => {
    const result = detect(tempHome);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("includes global steering dir when present", async () => {
    await mkdir(join(tempHome, ".kiro", "steering"), { recursive: true });
    const result = detect(tempHome);
    expect(result.paths.globalSteeringDir).toBe(join(tempHome, ".kiro", "steering"));
  });

  test("includes global agents dir when present", async () => {
    await mkdir(join(tempHome, ".kiro", "agents"), { recursive: true });
    const result = detect(tempHome);
    expect(result.paths.globalAgentsDir).toBe(join(tempHome, ".kiro", "agents"));
  });

  test("includes global skills dir when present", async () => {
    await mkdir(join(tempHome, ".kiro", "skills"), { recursive: true });
    const result = detect(tempHome);
    expect(result.paths.globalSkillsDir).toBe(join(tempHome, ".kiro", "skills"));
  });

  test("includes project .kiro/ path when projectPath provided", async () => {
    await mkdir(join(tempHome, ".kiro"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".kiro"), { recursive: true });
    const result = detect(tempHome, projectDir);
    expect(result.paths.projectDir).toBe(join(projectDir, ".kiro"));
  });

  test("includes project MCP config when present", async () => {
    await mkdir(join(tempHome, ".kiro"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".kiro", "settings"), { recursive: true });
    await writeFile(join(projectDir, ".kiro", "settings", "mcp.json"), "{}");
    const result = detect(tempHome, projectDir);
    expect(result.paths.projectMcpConfig).toBe(join(projectDir, ".kiro", "settings", "mcp.json"));
  });

  test("includes project steering dir when present", async () => {
    await mkdir(join(tempHome, ".kiro"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".kiro", "steering"), { recursive: true });
    const result = detect(tempHome, projectDir);
    expect(result.paths.projectSteeringDir).toBe(join(projectDir, ".kiro", "steering"));
  });

  test("includes project agents and skills dirs when present", async () => {
    await mkdir(join(tempHome, ".kiro"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".kiro", "agents"), { recursive: true });
    await mkdir(join(projectDir, ".kiro", "skills"), { recursive: true });
    const result = detect(tempHome, projectDir);
    expect(result.paths.projectAgentsDir).toBe(join(projectDir, ".kiro", "agents"));
    expect(result.paths.projectSkillsDir).toBe(join(projectDir, ".kiro", "skills"));
  });

  test("does not include project paths when projectPath not provided", async () => {
    await mkdir(join(tempHome, ".kiro"));
    const result = detect(tempHome);
    expect(result.paths.projectDir).toBeUndefined();
    expect(result.paths.projectMcpConfig).toBeUndefined();
    expect(result.paths.projectSteeringDir).toBeUndefined();
  });
});
