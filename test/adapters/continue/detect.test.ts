import { afterEach, describe, expect, test } from "bun:test";
import { detect } from "@/adapters/continue/detect.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("continue detect()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("detects when ~/.continue/ exists", async () => {
    dir = await createTestDir("am-ct-detect-");
    await dir.write(".continue/.keep", "");
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.configDir).toContain(".continue");
  });

  test("detects config.json", async () => {
    dir = await createTestDir("am-ct-detect-");
    await dir.write(".continue/config.json", JSON.stringify({ mcpServers: [] }));
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalConfig).toContain("config.json");
  });

  test("returns installed:false when nothing exists", async () => {
    dir = await createTestDir("am-ct-detect-");
    const result = detect(dir.path);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("includes project .continue/config.json path", async () => {
    dir = await createTestDir("am-ct-detect-");
    await dir.write(".continue/.keep", "");
    const projectDir = `${dir.path}/project`;
    await dir.write("project/.continue/config.json", JSON.stringify({ mcpServers: [] }));

    const result = detect(dir.path, projectDir);
    expect(result.paths.projectConfig).toContain(".continue/config.json");
  });
});
