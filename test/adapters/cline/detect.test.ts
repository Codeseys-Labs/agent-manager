import { afterEach, describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { detect, getGlobalStoragePath } from "@/adapters/cline/detect.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

// Use the same path resolution as the adapter for cross-platform test correctness
function globalStorageRel(home: string): string {
  return relative(home, getGlobalStoragePath(home));
}

describe("cline detect()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("detects when globalStorage directory exists", async () => {
    dir = await createTestDir("am-cline-detect-");
    await dir.write(`${globalStorageRel(dir.path)}/.keep`, "");
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalStorageDir).toBe(join(dir.path, globalStorageRel(dir.path)));
  });

  test("detects cline_mcp_settings.json", async () => {
    dir = await createTestDir("am-cline-detect-");
    await dir.write(`${globalStorageRel(dir.path)}/settings/cline_mcp_settings.json`, "{}");
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.mcpSettings).toBe(
      join(dir.path, globalStorageRel(dir.path), "settings", "cline_mcp_settings.json"),
    );
  });

  test("returns installed:false when nothing exists", async () => {
    dir = await createTestDir("am-cline-detect-");
    const result = detect(dir.path);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("finds .clinerules directory", async () => {
    dir = await createTestDir("am-cline-detect-");
    await dir.write(`${globalStorageRel(dir.path)}/.keep`, "");
    const projectDir = join(dir.path, "project");
    await dir.write("project/.clinerules/coding.md", "# Rules");

    const result = detect(dir.path, projectDir);
    expect(result.paths.rulesDir).toBe(join(projectDir, ".clinerules"));
  });

  test("finds .clinerules as single file (legacy)", async () => {
    dir = await createTestDir("am-cline-detect-");
    await dir.write(`${globalStorageRel(dir.path)}/.keep`, "");
    const projectDir = join(dir.path, "project");
    await dir.write("project/.clinerules", "Use strict mode.");

    const result = detect(dir.path, projectDir);
    expect(result.paths.rulesFile).toBe(join(projectDir, ".clinerules"));
  });

  test("does not include project paths when projectPath not provided", async () => {
    dir = await createTestDir("am-cline-detect-");
    await dir.write(`${globalStorageRel(dir.path)}/.keep`, "");
    const result = detect(dir.path);
    expect(result.paths.rulesDir).toBeUndefined();
    expect(result.paths.rulesFile).toBeUndefined();
  });
});
