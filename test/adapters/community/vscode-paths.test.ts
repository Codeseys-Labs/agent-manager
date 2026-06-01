import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  VSCODE_VARIANTS,
  findFirstExistingVSCodeExtensionStorage,
  resolveVSCodeExtensionStorage,
  resolveVSCodeUserDir,
  resolveVSCodeUserMcpJson,
  resolveVSCodeUserSettings,
} from "@/adapters/shared/vscode-paths.ts";
import { toPosix } from "../../helpers/path.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

// The helper branches on process.platform for the path LAYOUT, but node:path
// `join` always emits the HOST OS separator. So when these simulated
// darwin/linux cases run on the Windows CI runner, join() yields backslashes
// and a literal "/"-string assertion would mismatch. Normalize both sides with
// toPosix() so the assertions test the path STRUCTURE, not the host separator.

/**
 * Unit tests for the shared VS Code paths helper.
 *
 * The helper branches on `process.platform`. Tests mutate and restore
 * `process.platform` / `process.env.APPDATA` so that the three platforms
 * can be exercised without running on three OSes.
 *
 * NOTE: These tests live under `test/adapters/community/` rather than the
 * logical `test/adapters/vscode/` because the sandboxed author of this change
 * did not have write access to create a new test directory. Lead can move.
 */
const origPlatform = process.platform;
const origAppData = process.env.APPDATA;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

function restorePlatform() {
  Object.defineProperty(process, "platform", { value: origPlatform });
  if (origAppData === undefined) process.env.APPDATA = undefined;
  else process.env.APPDATA = origAppData;
}

describe("VS Code paths helper", () => {
  afterEach(() => {
    restorePlatform();
  });

  describe("VSCODE_VARIANTS", () => {
    test("includes stable, Insiders, VSCodium, Cursor, Windsurf", () => {
      const dirs = VSCODE_VARIANTS.map((v) => v.dirName);
      expect(dirs).toContain("Code");
      expect(dirs).toContain("Code - Insiders");
      expect(dirs).toContain("VSCodium");
      expect(dirs).toContain("Cursor");
      expect(dirs).toContain("Windsurf");
    });

    test("order prefers stable VS Code first", () => {
      expect(VSCODE_VARIANTS[0].dirName).toBe("Code");
    });
  });

  describe("resolveVSCodeUserDir()", () => {
    test("darwin: Library/Application Support/<variant>/User", () => {
      setPlatform("darwin");
      const home = "/Users/alice";
      const stable = resolveVSCodeUserDir({ displayName: "VS Code", dirName: "Code" }, home);
      expect(toPosix(stable)).toBe("/Users/alice/Library/Application Support/Code/User");

      const insiders = resolveVSCodeUserDir(
        { displayName: "VS Code Insiders", dirName: "Code - Insiders" },
        home,
      );
      expect(toPosix(insiders)).toBe(
        "/Users/alice/Library/Application Support/Code - Insiders/User",
      );

      const codium = resolveVSCodeUserDir({ displayName: "VSCodium", dirName: "VSCodium" }, home);
      expect(toPosix(codium)).toBe("/Users/alice/Library/Application Support/VSCodium/User");
    });

    test("linux: .config/<variant>/User", () => {
      setPlatform("linux");
      const home = "/home/alice";

      const stable = resolveVSCodeUserDir({ displayName: "VS Code", dirName: "Code" }, home);
      expect(toPosix(stable)).toBe("/home/alice/.config/Code/User");

      const insiders = resolveVSCodeUserDir(
        { displayName: "VS Code Insiders", dirName: "Code - Insiders" },
        home,
      );
      expect(toPosix(insiders)).toBe("/home/alice/.config/Code - Insiders/User");

      const cursor = resolveVSCodeUserDir({ displayName: "Cursor", dirName: "Cursor" }, home);
      expect(toPosix(cursor)).toBe("/home/alice/.config/Cursor/User");
    });

    test("win32: injected homeDir wins over ambient APPDATA", () => {
      // An explicit homeDir MUST take precedence over the ambient %APPDATA% so
      // resolution stays hermetic (the CI Windows runner always has APPDATA set
      // to the real user's Roaming dir). Derive %APPDATA% under the supplied
      // home instead of reading the env var.
      setPlatform("win32");
      process.env.APPDATA = "D:\\runner\\AppData\\Roaming"; // junk: must be ignored

      const stable = resolveVSCodeUserDir(
        { displayName: "VS Code", dirName: "Code" },
        "C:\\Users\\alice",
      );
      expect(stable).toContain("Code");
      expect(stable).toContain("User");
      // Path is derived from the injected home, NOT the ambient APPDATA.
      expect(stable).toBe(join("C:\\Users\\alice", "AppData", "Roaming", "Code", "User"));
      expect(stable).not.toContain("runner");
    });

    test("win32: uses ambient APPDATA when no homeDir injected", () => {
      // With no override, fall back to the real user's %APPDATA% verbatim.
      setPlatform("win32");
      process.env.APPDATA = "C:\\Users\\alice\\AppData\\Roaming";
      const stable = resolveVSCodeUserDir({ displayName: "VS Code", dirName: "Code" });
      expect(stable).toContain("Code");
      expect(stable).toContain("User");
      expect(stable.startsWith("C:\\Users\\alice\\AppData\\Roaming")).toBe(true);
    });

    test("win32: falls back to home/AppData/Roaming when APPDATA unset", () => {
      setPlatform("win32");
      process.env.APPDATA = undefined;
      const stable = resolveVSCodeUserDir(
        { displayName: "VS Code", dirName: "Code" },
        "C:\\Users\\alice",
      );
      expect(stable).toContain("AppData");
      expect(stable).toContain("Roaming");
    });
  });

  describe("resolveVSCodeExtensionStorage()", () => {
    test("darwin × single ID: one path per variant", () => {
      setPlatform("darwin");
      const paths = resolveVSCodeExtensionStorage("saoudrizwan.claude-dev", "/Users/alice");
      expect(paths.length).toBe(VSCODE_VARIANTS.length);
      for (const p of paths) {
        expect(p).toContain("globalStorage");
        expect(toPosix(p).endsWith("/saoudrizwan.claude-dev")).toBe(true);
      }
      expect(toPosix(paths[0])).toBe(
        "/Users/alice/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev",
      );
    });

    test("darwin × array IDs: cross product", () => {
      setPlatform("darwin");
      const paths = resolveVSCodeExtensionStorage(
        ["RooVeterinaryInc.roo-cline", "rooveterinaryinc.roo-cline"],
        "/Users/alice",
      );
      expect(paths.length).toBe(VSCODE_VARIANTS.length * 2);
      const posixPaths = paths.map(toPosix);
      expect(posixPaths).toContain(
        "/Users/alice/Library/Application Support/Code/User/globalStorage/RooVeterinaryInc.roo-cline",
      );
      expect(posixPaths).toContain(
        "/Users/alice/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline",
      );
    });

    test("linux × single ID", () => {
      setPlatform("linux");
      const paths = resolveVSCodeExtensionStorage("kilocode.Kilo-Code", "/home/alice");
      expect(toPosix(paths[0])).toBe(
        "/home/alice/.config/Code/User/globalStorage/kilocode.Kilo-Code",
      );
      const insiders = paths.find((p) => p.includes("Code - Insiders"));
      expect(insiders && toPosix(insiders)).toBe(
        "/home/alice/.config/Code - Insiders/User/globalStorage/kilocode.Kilo-Code",
      );
      const cursor = paths.find((p) => p.includes("Cursor"));
      expect(cursor && toPosix(cursor)).toBe(
        "/home/alice/.config/Cursor/User/globalStorage/kilocode.Kilo-Code",
      );
    });

    test("win32 × single ID", () => {
      setPlatform("win32");
      process.env.APPDATA = "C:\\Users\\alice\\AppData\\Roaming";
      const paths = resolveVSCodeExtensionStorage("saoudrizwan.claude-dev", "C:\\Users\\alice");
      expect(paths[0]).toContain("Code");
      expect(paths[0]).toContain("globalStorage");
      expect(paths[0]).toContain("saoudrizwan.claude-dev");
    });

    test("coverage matrix: 5 variants × 3 platforms", () => {
      for (const plat of ["darwin", "linux", "win32"] as const) {
        setPlatform(plat);
        if (plat === "win32") {
          process.env.APPDATA = "C:\\Users\\alice\\AppData\\Roaming";
        }
        const paths = resolveVSCodeExtensionStorage("foo.bar", "/root");
        const needed = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];
        for (const variant of needed) {
          const match = paths.find(
            (p) => p.includes(`/${variant}/`) || p.includes(`\\${variant}\\`),
          );
          expect(match).toBeDefined();
        }
      }
    });
  });

  describe("resolveVSCodeUserSettings()", () => {
    test("one settings.json per variant", () => {
      setPlatform("darwin");
      const paths = resolveVSCodeUserSettings("/Users/alice");
      expect(paths.length).toBe(VSCODE_VARIANTS.length);
      for (const p of paths) expect(toPosix(p).endsWith("/settings.json")).toBe(true);
    });
  });

  describe("resolveVSCodeUserMcpJson()", () => {
    test("one mcp.json per variant on darwin", () => {
      setPlatform("darwin");
      const paths = resolveVSCodeUserMcpJson("/Users/alice").map(toPosix);
      expect(paths.length).toBe(VSCODE_VARIANTS.length);
      expect(paths[0]).toBe("/Users/alice/Library/Application Support/Code/User/mcp.json");
      expect(paths).toContain(
        "/Users/alice/Library/Application Support/Code - Insiders/User/mcp.json",
      );
      expect(paths).toContain("/Users/alice/Library/Application Support/VSCodium/User/mcp.json");
    });

    test("one mcp.json per variant on linux", () => {
      setPlatform("linux");
      const paths = resolveVSCodeUserMcpJson("/home/alice").map(toPosix);
      expect(paths[0]).toBe("/home/alice/.config/Code/User/mcp.json");
      expect(paths).toContain("/home/alice/.config/Code - Insiders/User/mcp.json");
    });

    test("one mcp.json per variant on win32", () => {
      setPlatform("win32");
      process.env.APPDATA = "C:\\Users\\alice\\AppData\\Roaming";
      const paths = resolveVSCodeUserMcpJson("C:\\Users\\alice");
      expect(paths.length).toBe(VSCODE_VARIANTS.length);
      for (const p of paths) {
        expect(p.endsWith("\\mcp.json") || p.endsWith("/mcp.json")).toBe(true);
      }
    });
  });
});

describe("findFirstExistingVSCodeExtensionStorage()", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-vscode-paths-");
  });

  afterEach(async () => {
    restorePlatform();
    if (dir) await dir.cleanup();
  });

  test("returns undefined when no variant has the extension", () => {
    setPlatform("linux");
    const found = findFirstExistingVSCodeExtensionStorage("nonexistent.ext", dir.path);
    expect(found).toBeUndefined();
  });

  test("returns the stable Code path when present", async () => {
    setPlatform("linux");
    await dir.write(".config/Code/User/globalStorage/my.ext/.keep", "");
    const found = findFirstExistingVSCodeExtensionStorage("my.ext", dir.path);
    expect(found).toBe(join(dir.path, ".config/Code/User/globalStorage/my.ext"));
    expect(existsSync(found ?? "")).toBe(true);
  });

  test("falls back to VSCodium when only that variant is installed", async () => {
    setPlatform("linux");
    await dir.write(".config/VSCodium/User/globalStorage/my.ext/.keep", "");
    const found = findFirstExistingVSCodeExtensionStorage("my.ext", dir.path);
    expect(found).toBe(join(dir.path, ".config/VSCodium/User/globalStorage/my.ext"));
  });

  test("tries each casing passed in", async () => {
    setPlatform("linux");
    // Only the explicitly-named variant exists.
    await dir.write(".config/Code/User/globalStorage/ExactCase.Extension/.keep", "");
    const found = findFirstExistingVSCodeExtensionStorage(
      ["OtherCase.extension", "ExactCase.Extension"],
      dir.path,
    );
    // On case-insensitive filesystems (macOS default), BOTH will match;
    // on case-sensitive (Linux CI), only the exact match will.
    // Either way, the helper must return a defined string that contains the
    // requested extension ID casing (not throw / return undefined).
    expect(found).toBeDefined();
    expect(found).toContain("globalStorage");
  });
});
