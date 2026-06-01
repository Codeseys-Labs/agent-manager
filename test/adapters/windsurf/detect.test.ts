import { afterEach, describe, expect, test } from "bun:test";
import { detect } from "@/adapters/windsurf/detect.ts";
import { toPosix } from "../../helpers/path.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("windsurf detect()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("detects when ~/.codeium/windsurf/ exists", async () => {
    dir = await createTestDir("am-ws-detect-");
    await dir.write(".codeium/windsurf/.keep", "");
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(toPosix(result.paths.configDir ?? "")).toContain(".codeium/windsurf");
  });

  test("detects mcp_config.json", async () => {
    dir = await createTestDir("am-ws-detect-");
    await dir.write(".codeium/windsurf/mcp_config.json", JSON.stringify({ mcpServers: {} }));
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalMcpConfig).toContain("mcp_config.json");
  });

  test("returns installed:false when nothing exists", async () => {
    dir = await createTestDir("am-ws-detect-");
    const result = detect(dir.path);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("includes project .windsurf/rules/ path", async () => {
    dir = await createTestDir("am-ws-detect-");
    await dir.write(".codeium/windsurf/.keep", "");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.windsurf/rules/test.md", "# Rule");

    const result = detect(dir.path, projectDir);
    expect(toPosix(result.paths.rulesDir ?? "")).toContain(".windsurf/rules");
  });

  test("includes legacy .windsurfrules path", async () => {
    dir = await createTestDir("am-ws-detect-");
    await dir.write(".codeium/windsurf/.keep", "");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.windsurfrules", "some rules");

    const result = detect(dir.path, projectDir);
    expect(result.paths.legacyRules).toContain(".windsurfrules");
  });

  test("includes global_rules.md path when present", async () => {
    dir = await createTestDir("am-ws-detect-");
    await dir.write(".codeium/windsurf/memories/global_rules.md", "# Global");
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalRules).toContain("global_rules.md");
  });

  test("includes project .windsurf/skills/ path", async () => {
    dir = await createTestDir("am-ws-detect-");
    await dir.write(".codeium/windsurf/.keep", "");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.windsurf/skills/my-skill/SKILL.md", "# My Skill");

    const result = detect(dir.path, projectDir);
    expect(toPosix(result.paths.skillsDir ?? "")).toContain(".windsurf/skills");
  });

  test("includes AGENTS.md path when present", async () => {
    dir = await createTestDir("am-ws-detect-");
    await dir.write(".codeium/windsurf/.keep", "");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/AGENTS.md", "# Agent Instructions");

    const result = detect(dir.path, projectDir);
    expect(result.paths.agentsMd).toContain("AGENTS.md");
  });

  test("does not include skills/agents paths when absent", async () => {
    dir = await createTestDir("am-ws-detect-");
    await dir.write(".codeium/windsurf/.keep", "");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.keep", "");

    const result = detect(dir.path, projectDir);
    expect(result.paths.skillsDir).toBeUndefined();
    expect(result.paths.agentsMd).toBeUndefined();
  });
});
