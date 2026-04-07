import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detect } from "@/adapters/claude-code/detect.ts";

describe("claude-code detect()", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "am-cc-detect-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  test("detects when ~/.claude.json exists", async () => {
    await writeFile(join(tempHome, ".claude.json"), "{}");
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.globalConfig).toBe(join(tempHome, ".claude.json"));
  });

  test("detects when only ~/.claude/ directory exists", async () => {
    await mkdir(join(tempHome, ".claude"));
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.configDir).toBe(join(tempHome, ".claude"));
  });

  test("returns installed:false when nothing exists", () => {
    const result = detect(tempHome);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("includes project .mcp.json path when projectPath provided", async () => {
    await writeFile(join(tempHome, ".claude.json"), "{}");
    const projectDir = join(tempHome, "my-project");
    await mkdir(projectDir);
    await writeFile(join(projectDir, ".mcp.json"), "{}");

    const result = detect(tempHome, projectDir);
    expect(result.installed).toBe(true);
    expect(result.paths.projectMcpConfig).toBe(join(projectDir, ".mcp.json"));
  });

  test("includes CLAUDE.md path when present in project root", async () => {
    await writeFile(join(tempHome, ".claude.json"), "{}");
    const projectDir = join(tempHome, "my-project");
    await mkdir(projectDir);
    await writeFile(join(projectDir, "CLAUDE.md"), "# Instructions");

    const result = detect(tempHome, projectDir);
    expect(result.paths.claudeMd).toBe(join(projectDir, "CLAUDE.md"));
  });

  test("includes .claude/CLAUDE.md path when present", async () => {
    await writeFile(join(tempHome, ".claude.json"), "{}");
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".claude"), { recursive: true });
    await writeFile(
      join(projectDir, ".claude", "CLAUDE.md"),
      "# Instructions",
    );

    const result = detect(tempHome, projectDir);
    expect(result.paths.claudeMdDotDir).toBe(
      join(projectDir, ".claude", "CLAUDE.md"),
    );
  });

  test("does not include project paths when projectPath not provided", async () => {
    await writeFile(join(tempHome, ".claude.json"), "{}");
    const result = detect(tempHome);
    expect(result.paths.projectMcpConfig).toBeUndefined();
    expect(result.paths.claudeMd).toBeUndefined();
    expect(result.paths.claudeMdDotDir).toBeUndefined();
  });

  test("populates both globalConfig and configDir when both exist", async () => {
    await writeFile(join(tempHome, ".claude.json"), "{}");
    await mkdir(join(tempHome, ".claude"));
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.globalConfig).toBe(join(tempHome, ".claude.json"));
    expect(result.paths.configDir).toBe(join(tempHome, ".claude"));
  });
});
