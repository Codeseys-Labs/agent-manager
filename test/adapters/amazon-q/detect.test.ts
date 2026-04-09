import { afterEach, describe, expect, test } from "bun:test";
import { detect } from "@/adapters/amazon-q/detect.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("amazon-q detect()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("detects when ~/.aws/amazonq/ exists", async () => {
    dir = await createTestDir("am-aq-detect-");
    await dir.write(".aws/amazonq/.keep", "");
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.configDir).toContain(".aws/amazonq");
  });

  test("detects mcp.json", async () => {
    dir = await createTestDir("am-aq-detect-");
    await dir.write(".aws/amazonq/mcp.json", JSON.stringify({ mcpServers: {} }));
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalMcpConfig).toContain("mcp.json");
  });

  test("returns installed:false when nothing exists", async () => {
    dir = await createTestDir("am-aq-detect-");
    const result = detect(dir.path);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("includes project .amazonq/mcp.json path", async () => {
    dir = await createTestDir("am-aq-detect-");
    await dir.write(".aws/amazonq/.keep", "");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.amazonq/mcp.json", JSON.stringify({ mcpServers: {} }));

    const result = detect(dir.path, projectDir);
    expect(result.paths.projectMcpConfig).toContain(".amazonq/mcp.json");
  });

  test("includes project .amazonq/rules/ path", async () => {
    dir = await createTestDir("am-aq-detect-");
    await dir.write(".aws/amazonq/.keep", "");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.amazonq/rules/test.md", "# Rule");

    const result = detect(dir.path, projectDir);
    expect(result.paths.rulesDir).toContain(".amazonq/rules");
  });
});
