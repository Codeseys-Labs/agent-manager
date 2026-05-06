import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY_WIKI_PROJECT_DIRNAME,
  WIKI_PROJECT_DIRNAME,
  resolveWikiDir,
} from "../../src/wiki/storage";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("resolveWikiDir", () => {
  let projectDir: TestDir;
  let configHome: TestDir;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    projectDir = await createTestDir("wiki-resolve-proj-");
    configHome = await createTestDir("wiki-resolve-cfg-");
    savedEnv = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = configHome.path;
    writeFileSync(join(projectDir.path, ".agent-manager.toml"), "# am project marker\n", "utf-8");
  });

  afterEach(async () => {
    if (savedEnv === undefined) process.env.AM_CONFIG_DIR = undefined;
    else process.env.AM_CONFIG_DIR = savedEnv;
    await projectDir.cleanup();
    await configHome.cleanup();
  });

  test("project with only `.am-wiki/` returns the new project wiki path", () => {
    const newPath = join(projectDir.path, WIKI_PROJECT_DIRNAME);
    mkdirSync(newPath, { recursive: true });

    expect(resolveWikiDir({ projectDir: projectDir.path })).toBe(newPath);
  });

  test("project with only legacy `.agent-manager/wiki/` returns legacy path", () => {
    const legacyPath = join(projectDir.path, LEGACY_WIKI_PROJECT_DIRNAME);
    mkdirSync(legacyPath, { recursive: true });

    expect(resolveWikiDir({ projectDir: projectDir.path })).toBe(legacyPath);
  });

  test("project with both layouts returns `.am-wiki/`", () => {
    const newPath = join(projectDir.path, WIKI_PROJECT_DIRNAME);
    const legacyPath = join(projectDir.path, LEGACY_WIKI_PROJECT_DIRNAME);
    mkdirSync(newPath, { recursive: true });
    mkdirSync(legacyPath, { recursive: true });

    expect(resolveWikiDir({ projectDir: projectDir.path })).toBe(newPath);
  });

  test("project with neither layout returns global wiki dir", () => {
    expect(resolveWikiDir({ projectDir: projectDir.path })).toBe(
      join(configHome.path, "wiki", "global"),
    );
  });

  test("global flag forces global regardless of project-local layouts", () => {
    mkdirSync(join(projectDir.path, WIKI_PROJECT_DIRNAME), { recursive: true });
    mkdirSync(join(projectDir.path, LEGACY_WIKI_PROJECT_DIRNAME), { recursive: true });

    expect(resolveWikiDir({ global: true, projectDir: projectDir.path })).toBe(
      join(configHome.path, "wiki", "global"),
    );
  });
});
