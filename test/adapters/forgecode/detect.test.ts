import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detect } from "@/adapters/forgecode/detect.ts";

describe("forgecode detect()", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "am-fc-detect-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  test("detects when ~/forge/ directory exists", async () => {
    await mkdir(join(tempHome, "forge"));
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.globalConfigDir).toBe(join(tempHome, "forge"));
  });

  test("detects when ~/.forge.toml exists", async () => {
    await writeFile(join(tempHome, ".forge.toml"), 'model = "claude-sonnet-4"');
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.globalSettings).toBe(join(tempHome, ".forge.toml"));
  });

  test("returns installed:false when nothing exists", () => {
    const result = detect(tempHome);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("includes project .mcp.json path when projectPath provided", async () => {
    await mkdir(join(tempHome, "forge"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(projectDir);
    await writeFile(join(projectDir, ".mcp.json"), "{}");

    const result = detect(tempHome, projectDir);
    expect(result.installed).toBe(true);
    expect(result.paths.projectMcpConfig).toBe(join(projectDir, ".mcp.json"));
  });

  test("includes AGENTS.md path when present in project root", async () => {
    await mkdir(join(tempHome, "forge"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(projectDir);
    await writeFile(join(projectDir, "AGENTS.md"), "# Guidelines");

    const result = detect(tempHome, projectDir);
    expect(result.paths.agentsMd).toBe(join(projectDir, "AGENTS.md"));
  });

  test("includes .forge/ project config dir when present", async () => {
    await mkdir(join(tempHome, "forge"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".forge"), { recursive: true });

    const result = detect(tempHome, projectDir);
    expect(result.paths.projectConfigDir).toBe(join(projectDir, ".forge"));
  });

  test("includes project .forge.toml when present", async () => {
    await mkdir(join(tempHome, "forge"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(projectDir);
    await writeFile(join(projectDir, ".forge.toml"), "");

    const result = detect(tempHome, projectDir);
    expect(result.paths.projectSettings).toBe(
      join(projectDir, ".forge.toml"),
    );
  });

  test("does not include project paths when projectPath not provided", async () => {
    await mkdir(join(tempHome, "forge"));
    const result = detect(tempHome);
    expect(result.paths.projectMcpConfig).toBeUndefined();
    expect(result.paths.agentsMd).toBeUndefined();
    expect(result.paths.projectConfigDir).toBeUndefined();
  });

  test("populates both globalConfigDir and globalSettings when both exist", async () => {
    await mkdir(join(tempHome, "forge"));
    await writeFile(join(tempHome, ".forge.toml"), "");
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.globalConfigDir).toBe(join(tempHome, "forge"));
    expect(result.paths.globalSettings).toBe(join(tempHome, ".forge.toml"));
  });
});
