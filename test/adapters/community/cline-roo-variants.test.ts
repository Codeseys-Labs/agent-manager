import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CLINE_EXTENSION_IDS,
  detect as detectCline,
  getGlobalStoragePath as getClineStorage,
} from "@/adapters/cline/detect.ts";
import {
  ROO_EXTENSION_IDS,
  detect as detectRoo,
  getGlobalStoragePath as getRooStorage,
} from "@/adapters/roo-code/detect.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

/**
 * Wave-A tests for the Cline and Roo Code adapters' VS Code variant coverage.
 *
 * Previously both adapters hardcoded `Code` as the product dir. They now
 * iterate `VSCODE_VARIANTS` and also try mixed-case + lowercase extension IDs
 * for case-sensitive Linux filesystems.
 */
const origPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p });
}
function restore() {
  Object.defineProperty(process, "platform", { value: origPlatform });
}

describe("cline detect() — VS Code variants", () => {
  let dir: TestDir;
  afterEach(async () => {
    restore();
    if (dir) await dir.cleanup();
  });

  test("exposes the canonical extension ID", () => {
    expect(CLINE_EXTENSION_IDS[0]).toBe("saoudrizwan.claude-dev");
  });

  test("getGlobalStoragePath returns stable Code path when nothing installed", () => {
    setPlatform("linux");
    const p = getClineStorage("/home/alice");
    expect(p).toBe("/home/alice/.config/Code/User/globalStorage/saoudrizwan.claude-dev");
  });

  test("detects stable Code install", async () => {
    dir = await createTestDir("am-cline-variants-");
    setPlatform("linux");
    await dir.write(
      ".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
      JSON.stringify({ mcpServers: {} }),
    );
    const result = detectCline(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalStorageDir).toContain("/Code/");
  });

  test("detects Insiders install", async () => {
    dir = await createTestDir("am-cline-variants-");
    setPlatform("linux");
    await dir.write(".config/Code - Insiders/User/globalStorage/saoudrizwan.claude-dev/.keep", "");
    const result = detectCline(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalStorageDir).toContain("Code - Insiders");
  });

  test("detects VSCodium install", async () => {
    dir = await createTestDir("am-cline-variants-");
    setPlatform("linux");
    await dir.write(".config/VSCodium/User/globalStorage/saoudrizwan.claude-dev/.keep", "");
    const result = detectCline(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalStorageDir).toContain("VSCodium");
  });

  test("detects Cursor install", async () => {
    dir = await createTestDir("am-cline-variants-");
    setPlatform("linux");
    await dir.write(".config/Cursor/User/globalStorage/saoudrizwan.claude-dev/.keep", "");
    const result = detectCline(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalStorageDir).toContain("Cursor");
  });
});

describe("roo-code detect() — VS Code variants + casing", () => {
  let dir: TestDir;
  afterEach(async () => {
    restore();
    if (dir) await dir.cleanup();
  });

  test("exposes mixed-case ID first, then lowercase fallback", () => {
    expect(ROO_EXTENSION_IDS[0]).toBe("RooVeterinaryInc.roo-cline");
    expect(ROO_EXTENSION_IDS[1]).toBe("rooveterinaryinc.roo-cline");
  });

  test("getGlobalStoragePath prefers mixed-case in absence of any install", () => {
    setPlatform("linux");
    const p = getRooStorage("/home/alice");
    // When nothing exists we return the first candidate (stable Code, mixed case).
    expect(p).toBe("/home/alice/.config/Code/User/globalStorage/RooVeterinaryInc.roo-cline");
  });

  test("detects mixed-case dir on disk", async () => {
    dir = await createTestDir("am-roo-variants-");
    setPlatform("linux");
    await dir.write(
      ".config/Code/User/globalStorage/RooVeterinaryInc.roo-cline/settings/mcp_settings.json",
      JSON.stringify({ mcpServers: {} }),
    );
    const result = detectRoo(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalStorageDir).toContain("RooVeterinaryInc.roo-cline");
  });

  test("detects Insiders variant", async () => {
    dir = await createTestDir("am-roo-variants-");
    setPlatform("linux");
    await dir.write(
      ".config/Code - Insiders/User/globalStorage/RooVeterinaryInc.roo-cline/.keep",
      "",
    );
    const result = detectRoo(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalStorageDir).toContain("Code - Insiders");
  });

  test("detects Cursor variant", async () => {
    dir = await createTestDir("am-roo-variants-");
    setPlatform("linux");
    await dir.write(".config/Cursor/User/globalStorage/RooVeterinaryInc.roo-cline/.keep", "");
    const result = detectRoo(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalStorageDir).toContain("Cursor");
  });
});
