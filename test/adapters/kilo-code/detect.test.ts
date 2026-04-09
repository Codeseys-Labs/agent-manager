import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "@/adapters/kilo-code/detect.ts";

describe("kilo-code detect()", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "am-kc-detect-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  test("detects when ~/.config/kilo/ directory exists", async () => {
    await mkdir(join(tempHome, ".config", "kilo"), { recursive: true });
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.globalConfigDir).toBe(join(tempHome, ".config", "kilo"));
  });

  test("detects global config file kilo.jsonc", async () => {
    const configDir = join(tempHome, ".config", "kilo");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "kilo.jsonc"), "{}");
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.globalConfig).toBe(join(configDir, "kilo.jsonc"));
  });

  test("falls back to config.json if no kilo.jsonc", async () => {
    const configDir = join(tempHome, ".config", "kilo");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), "{}");
    const result = detect(tempHome);
    expect(result.paths.globalConfig).toBe(join(configDir, "config.json"));
  });

  test("falls back to opencode.jsonc", async () => {
    const configDir = join(tempHome, ".config", "kilo");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.jsonc"), "{}");
    const result = detect(tempHome);
    expect(result.paths.globalConfig).toBe(join(configDir, "opencode.jsonc"));
  });

  test("returns installed:false when nothing exists", () => {
    const result = detect(tempHome);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("finds .kilo/kilo.jsonc in project (priority over root)", async () => {
    await mkdir(join(tempHome, ".config", "kilo"), { recursive: true });
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".kilo"), { recursive: true });
    await writeFile(join(projectDir, ".kilo", "kilo.jsonc"), "{}");
    // Also create root kilo.jsonc to verify priority
    await writeFile(join(projectDir, "kilo.jsonc"), "{}");

    const result = detect(tempHome, projectDir);
    expect(result.paths.projectConfig).toBe(join(projectDir, ".kilo", "kilo.jsonc"));
  });

  test("finds kilo.jsonc at project root", async () => {
    await mkdir(join(tempHome, ".config", "kilo"), { recursive: true });
    const projectDir = join(tempHome, "my-project");
    await mkdir(projectDir);
    await writeFile(join(projectDir, "kilo.jsonc"), "{}");

    const result = detect(tempHome, projectDir);
    expect(result.paths.projectConfig).toBe(join(projectDir, "kilo.jsonc"));
  });

  test("finds .kilocode/ directory (legacy)", async () => {
    await mkdir(join(tempHome, ".config", "kilo"), { recursive: true });
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".kilocode"), { recursive: true });

    const result = detect(tempHome, projectDir);
    expect(result.paths.kilocodeDir).toBe(join(projectDir, ".kilocode"));
  });

  test("finds AGENTS.md at project root", async () => {
    await mkdir(join(tempHome, ".config", "kilo"), { recursive: true });
    const projectDir = join(tempHome, "my-project");
    await mkdir(projectDir);
    await writeFile(join(projectDir, "AGENTS.md"), "# Instructions");

    const result = detect(tempHome, projectDir);
    expect(result.paths.agentsMd).toBe(join(projectDir, "AGENTS.md"));
  });

  test("falls back to CLAUDE.md when no AGENTS.md", async () => {
    await mkdir(join(tempHome, ".config", "kilo"), { recursive: true });
    const projectDir = join(tempHome, "my-project");
    await mkdir(projectDir);
    await writeFile(join(projectDir, "CLAUDE.md"), "# Instructions");

    const result = detect(tempHome, projectDir);
    expect(result.paths.agentsMd).toBe(join(projectDir, "CLAUDE.md"));
  });

  test("finds project rules directory", async () => {
    await mkdir(join(tempHome, ".config", "kilo"), { recursive: true });
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".kilocode", "rules"), { recursive: true });

    const result = detect(tempHome, projectDir);
    expect(result.paths.projectRulesDir).toBe(join(projectDir, ".kilocode", "rules"));
  });

  test("finds project skills directory", async () => {
    await mkdir(join(tempHome, ".config", "kilo"), { recursive: true });
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".kilocode", "skills"), { recursive: true });

    const result = detect(tempHome, projectDir);
    expect(result.paths.projectSkillsDir).toBe(join(projectDir, ".kilocode", "skills"));
  });

  test("finds project agents directory", async () => {
    await mkdir(join(tempHome, ".config", "kilo"), { recursive: true });
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".kilo", "agents"), { recursive: true });

    const result = detect(tempHome, projectDir);
    expect(result.paths.projectAgentsDir).toBe(join(projectDir, ".kilo", "agents"));
  });

  test("finds global AGENTS.md", async () => {
    const configDir = join(tempHome, ".config", "kilo");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "AGENTS.md"), "# Global");

    const result = detect(tempHome);
    expect(result.paths.globalAgentsMd).toBe(join(configDir, "AGENTS.md"));
  });

  test("finds global rules directory", async () => {
    await mkdir(join(tempHome, ".config", "kilo"), { recursive: true });
    await mkdir(join(tempHome, ".kilocode", "rules"), { recursive: true });

    const result = detect(tempHome);
    expect(result.paths.globalRulesDir).toBe(join(tempHome, ".kilocode", "rules"));
  });

  test("does not include project paths when projectPath not provided", async () => {
    await mkdir(join(tempHome, ".config", "kilo"), { recursive: true });
    const result = detect(tempHome);
    expect(result.paths.projectConfig).toBeUndefined();
    expect(result.paths.agentsMd).toBeUndefined();
    expect(result.paths.kilocodeDir).toBeUndefined();
  });
});
