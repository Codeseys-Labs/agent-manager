import { describe, expect, test, afterEach } from "bun:test";
import { createTestDir, type TestDir } from "../../helpers/tmp.ts";
import { detect } from "@/adapters/windsurf/detect.ts";

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
    expect(result.paths.configDir).toContain(".codeium/windsurf");
  });

  test("detects mcp_config.json", async () => {
    dir = await createTestDir("am-ws-detect-");
    await dir.write(
      ".codeium/windsurf/mcp_config.json",
      JSON.stringify({ mcpServers: {} }),
    );
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
    const projectDir = dir.path + "/project";
    await dir.write("project/.windsurf/rules/test.md", "# Rule");

    const result = detect(dir.path, projectDir);
    expect(result.paths.rulesDir).toContain(".windsurf/rules");
  });

  test("includes legacy .windsurfrules path", async () => {
    dir = await createTestDir("am-ws-detect-");
    await dir.write(".codeium/windsurf/.keep", "");
    const projectDir = dir.path + "/project";
    await dir.write("project/.windsurfrules", "some rules");

    const result = detect(dir.path, projectDir);
    expect(result.paths.legacyRules).toContain(".windsurfrules");
  });

  test("includes global_rules.md path when present", async () => {
    dir = await createTestDir("am-ws-detect-");
    await dir.write(
      ".codeium/windsurf/memories/global_rules.md",
      "# Global",
    );
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalRules).toContain("global_rules.md");
  });
});
