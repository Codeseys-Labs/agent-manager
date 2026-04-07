import { describe, expect, test, afterEach } from "bun:test";
import { createTestDir, type TestDir } from "../../helpers/tmp.ts";
import { detect } from "@/adapters/copilot/detect.ts";

describe("copilot detect()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("detects when ~/.vscode/ exists", async () => {
    dir = await createTestDir("am-cp-detect-");
    await dir.write(".vscode/.keep", "");
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.vscodeDir).toContain(".vscode");
  });

  test("returns installed:false when nothing exists", async () => {
    dir = await createTestDir("am-cp-detect-");
    const result = detect(dir.path);
    expect(result.installed).toBe(false);
    expect(Object.keys(result.paths).length).toBe(0);
  });

  test("includes project .vscode/mcp.json path", async () => {
    dir = await createTestDir("am-cp-detect-");
    await dir.write(".vscode/.keep", "");
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.vscode/mcp.json",
      JSON.stringify({ servers: {} }),
    );

    const result = detect(dir.path, projectDir);
    expect(result.paths.projectMcpConfig).toContain("mcp.json");
  });

  test("includes .github/copilot-instructions.md path", async () => {
    dir = await createTestDir("am-cp-detect-");
    await dir.write(".vscode/.keep", "");
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.github/copilot-instructions.md",
      "# Instructions",
    );

    const result = detect(dir.path, projectDir);
    expect(result.paths.globalInstructions).toContain(
      "copilot-instructions.md",
    );
  });

  test("includes .github/instructions/ directory path", async () => {
    dir = await createTestDir("am-cp-detect-");
    await dir.write(".vscode/.keep", "");
    const projectDir = dir.path + "/project";
    await dir.write(
      "project/.github/instructions/ts.instructions.md",
      "content",
    );

    const result = detect(dir.path, projectDir);
    expect(result.paths.instructionsDir).toContain("instructions");
  });

  test("includes CLI config path when present", async () => {
    dir = await createTestDir("am-cp-detect-");
    await dir.write(
      ".copilot/mcp-config.json",
      JSON.stringify({ mcpServers: {} }),
    );

    const result = detect(dir.path);
    expect(result.paths.cliMcpConfig).toContain("mcp-config.json");
  });
});
