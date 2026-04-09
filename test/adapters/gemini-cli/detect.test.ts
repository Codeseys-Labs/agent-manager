import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "@/adapters/gemini-cli/detect.ts";

describe("gemini-cli detect()", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "am-gc-detect-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  test("detects when ~/.gemini/ directory exists", async () => {
    await mkdir(join(tempHome, ".gemini"));
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.configDir).toBe(join(tempHome, ".gemini"));
  });

  test("detects when ~/.gemini/settings.json exists", async () => {
    await mkdir(join(tempHome, ".gemini"), { recursive: true });
    await writeFile(join(tempHome, ".gemini", "settings.json"), "{}");
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.globalSettings).toBe(join(tempHome, ".gemini", "settings.json"));
  });

  test("returns installed:false when nothing exists", () => {
    const result = detect(tempHome);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("includes project .gemini/settings.json path when projectPath provided", async () => {
    await mkdir(join(tempHome, ".gemini"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(join(projectDir, ".gemini"), { recursive: true });
    await writeFile(join(projectDir, ".gemini", "settings.json"), "{}");

    const result = detect(tempHome, projectDir);
    expect(result.installed).toBe(true);
    expect(result.paths.projectSettings).toBe(join(projectDir, ".gemini", "settings.json"));
  });

  test("includes GEMINI.md path when present in project root", async () => {
    await mkdir(join(tempHome, ".gemini"));
    const projectDir = join(tempHome, "my-project");
    await mkdir(projectDir);
    await writeFile(join(projectDir, "GEMINI.md"), "# Instructions");

    const result = detect(tempHome, projectDir);
    expect(result.paths.geminiMd).toBe(join(projectDir, "GEMINI.md"));
  });

  test("does not include project paths when projectPath not provided", async () => {
    await mkdir(join(tempHome, ".gemini"));
    const result = detect(tempHome);
    expect(result.paths.projectSettings).toBeUndefined();
    expect(result.paths.geminiMd).toBeUndefined();
  });

  test("populates both configDir and globalSettings when both exist", async () => {
    await mkdir(join(tempHome, ".gemini"));
    await writeFile(join(tempHome, ".gemini", "settings.json"), "{}");
    const result = detect(tempHome);
    expect(result.installed).toBe(true);
    expect(result.paths.configDir).toBe(join(tempHome, ".gemini"));
    expect(result.paths.globalSettings).toBe(join(tempHome, ".gemini", "settings.json"));
  });
});
