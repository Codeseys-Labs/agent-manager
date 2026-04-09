import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "@/adapters/codex-cli/detect.ts";

describe("codex-cli detect()", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "am-codex-detect-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  test("detects when ~/.codex/config.toml exists", async () => {
    await mkdir(join(tempHome, ".codex"), { recursive: true });
    await writeFile(join(tempHome, ".codex", "config.toml"), 'model = "gpt-5.4"');
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.userConfig).toBe(join(tempHome, ".codex", "config.toml"));
    expect(result.paths.configDir).toBe(join(tempHome, ".codex"));
  });

  test("detects when only ~/.codex/ directory exists", async () => {
    await mkdir(join(tempHome, ".codex"));
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.configDir).toBe(join(tempHome, ".codex"));
  });

  test("returns installed:false when nothing exists", () => {
    const result = detect(tempHome);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("includes project .codex/config.toml path when projectPath provided", async () => {
    await mkdir(join(tempHome, ".codex"), { recursive: true });
    await writeFile(join(tempHome, ".codex", "config.toml"), "");
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".codex"), { recursive: true });
    await writeFile(join(projectDir, ".codex", "config.toml"), "");

    const result = detect(tempHome, projectDir);
    expect(result.installed).toBe(true);
    expect(result.paths.projectConfig).toBe(join(projectDir, ".codex", "config.toml"));
  });

  test("includes AGENTS.md path when present in project root", async () => {
    await mkdir(join(tempHome, ".codex"), { recursive: true });
    await writeFile(join(tempHome, ".codex", "config.toml"), "");
    const projectDir = join(tempHome, "my-project");
    await mkdir(projectDir);
    await writeFile(join(projectDir, "AGENTS.md"), "# Instructions");

    const result = detect(tempHome, projectDir);
    expect(result.paths.agentsMd).toBe(join(projectDir, "AGENTS.md"));
  });

  test("includes global AGENTS.md path when present", async () => {
    await mkdir(join(tempHome, ".codex"), { recursive: true });
    await writeFile(join(tempHome, ".codex", "config.toml"), "");
    await writeFile(join(tempHome, ".codex", "AGENTS.md"), "# Global Instructions");

    const result = detect(tempHome);
    expect(result.paths.globalAgentsMd).toBe(join(tempHome, ".codex", "AGENTS.md"));
  });

  test("includes agents directory paths", async () => {
    await mkdir(join(tempHome, ".codex", "agents"), { recursive: true });
    await writeFile(join(tempHome, ".codex", "config.toml"), "");
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".codex", "agents"), { recursive: true });

    const result = detect(tempHome, projectDir);
    expect(result.paths.globalAgentsDir).toBe(join(tempHome, ".codex", "agents"));
    expect(result.paths.projectAgentsDir).toBe(join(projectDir, ".codex", "agents"));
  });

  test("does not include project paths when projectPath not provided", async () => {
    await mkdir(join(tempHome, ".codex"), { recursive: true });
    await writeFile(join(tempHome, ".codex", "config.toml"), "");
    const result = detect(tempHome);
    expect(result.paths.projectConfig).toBeUndefined();
    expect(result.paths.agentsMd).toBeUndefined();
    expect(result.paths.projectAgentsDir).toBeUndefined();
  });
});
