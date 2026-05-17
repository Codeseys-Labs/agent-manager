import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  getExtensionsDir,
  resolveExtensionVars,
  scanVSCodeExtensions,
} from "@/adapters/shared/marketplace-vscode.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("resolveExtensionVars()", () => {
  test("replaces ${extensionPath}", () => {
    expect(resolveExtensionVars("${extensionPath}/dist/server.js", "/ext/path")).toBe(
      "/ext/path/dist/server.js",
    );
  });

  test("replaces multiple occurrences", () => {
    expect(resolveExtensionVars("${extensionPath}/a:${extensionPath}/b", "/ext")).toBe(
      "/ext/a:/ext/b",
    );
  });

  test("returns unchanged string with no variables", () => {
    expect(resolveExtensionVars("node", "/ext")).toBe("node");
  });
});

describe("getExtensionsDir()", () => {
  test("returns path for copilot", () => {
    const dir = getExtensionsDir("copilot", "/home/user");
    expect(dir).toBeDefined();
    expect(dir).toContain("extensions");
  });

  test("returns path for cursor", () => {
    const dir = getExtensionsDir("cursor", "/home/user");
    expect(dir).toBeDefined();
    expect(dir).toContain("extensions");
  });

  test("returns path for kiro", () => {
    const dir = getExtensionsDir("kiro", "/home/user");
    expect(dir).toBeDefined();
    expect(dir).toContain("extensions");
  });

  test("returns path for windsurf", () => {
    const dir = getExtensionsDir("windsurf", "/home/user");
    expect(dir).toBeDefined();
    expect(dir).toContain("extensions");
  });

  test("returns undefined for unknown adapter", () => {
    expect(getExtensionsDir("unknown-tool", "/home/user")).toBeUndefined();
  });
});

describe("getExtensionsDir() on win32", () => {
  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (originalAppData === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
  });

  test("copilot returns AppData path with explicit APPDATA", () => {
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
    const dir = getExtensionsDir("copilot", "C:\\Users\\test");
    expect(dir).toBe(join("C:\\Users\\test\\AppData\\Roaming", "Code", "User", "extensions"));
  });

  test("cursor returns AppData path", () => {
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
    const dir = getExtensionsDir("cursor", "C:\\Users\\test");
    expect(dir).toContain("Cursor");
    expect(dir).toContain("extensions");
  });

  test("kiro returns AppData path", () => {
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
    const dir = getExtensionsDir("kiro", "C:\\Users\\test");
    expect(dir).toContain("Kiro");
    expect(dir).toContain("extensions");
  });

  test("windsurf returns AppData path", () => {
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
    const dir = getExtensionsDir("windsurf", "C:\\Users\\test");
    expect(dir).toContain("Windsurf");
    expect(dir).toContain("extensions");
  });

  test("falls back to <home>/AppData/Roaming when APPDATA unset", () => {
    // biome-ignore lint/performance/noDelete: env var cleanup
    delete process.env.APPDATA;
    const dir = getExtensionsDir("copilot", "/tmp/userhome");
    // path.join is platform-native; on linux test runner / will be the sep,
    // so just assert key segments are present.
    expect(dir).toContain("AppData");
    expect(dir).toContain("Roaming");
    expect(dir).toContain("Code");
    expect(dir).toContain("extensions");
  });
});

describe("scanVSCodeExtensions()", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("returns empty when extensions directory does not exist", async () => {
    dir = await createTestDir("am-vscode-mp-");
    // scanVSCodeExtensions uses platform-specific paths, so we need to
    // mock by creating the exact directory structure it expects.
    // For this test, just pass a homeDir where no extensions exist.
    const result = scanVSCodeExtensions("copilot", dir.path);
    expect(result.items).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns warning for unknown adapter name", () => {
    const result = scanVSCodeExtensions("nonexistent");
    expect(result.items).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("No marketplace source mapping");
  });

  test("scans extension with contributes.mcpServers", async () => {
    dir = await createTestDir("am-vscode-mp-");
    // Create a fake extensions directory at the platform-expected path
    const extDir = getExtensionsDir("copilot", dir.path)!;
    const extPath = join(extDir, "publisher.my-ext-1.0.0");

    await dir.write(
      `${extPath.replace(`${dir.path}/`, "")}/package.json`,
      JSON.stringify({
        name: "my-ext",
        displayName: "My Extension",
        version: "1.0.0",
        publisher: "publisher",
        repository: { url: "https://github.com/pub/my-ext" },
        contributes: {
          mcpServers: {
            "ext-server": {
              command: "node",
              args: ["${extensionPath}/dist/server.js"],
              env: { API_KEY: "test" },
            },
          },
        },
      }),
    );

    const result = scanVSCodeExtensions("copilot", dir.path);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("publisher.my-ext");
    expect(result.items[0].name).toBe("My Extension");
    expect(result.items[0].version).toBe("1.0.0");
    expect(result.items[0].source).toBe("vscode-extension");
    expect(result.items[0].servers).toHaveLength(1);
    expect(result.items[0].servers[0].name).toBe("ext-server");
    expect(result.items[0].servers[0].command).toBe("node");
    // ${extensionPath} should be resolved
    expect(result.items[0].servers[0].args![0]).toContain("dist/server.js");
    expect(result.items[0].servers[0].args![0]).not.toContain("${extensionPath}");
    expect(result.items[0].servers[0].env).toEqual({ API_KEY: "test" });
    expect(result.items[0].servers[0].tags).toEqual(["extension:publisher.my-ext"]);
    expect(result.items[0].metadata.publisher).toBe("publisher");
    expect(result.items[0].metadata.repository).toBe("https://github.com/pub/my-ext");
    expect(result.items[0].skills).toHaveLength(0);
  });

  test("skips extensions without contributes.mcpServers", async () => {
    dir = await createTestDir("am-vscode-mp-");
    const extDir = getExtensionsDir("copilot", dir.path)!;

    // Extension with no MCP servers
    await dir.write(
      `${join(extDir, "pub.theme-1.0.0").replace(`${dir.path}/`, "")}/package.json`,
      JSON.stringify({
        name: "theme",
        publisher: "pub",
        version: "1.0.0",
        contributes: {
          themes: [{ label: "Dark", uiTheme: "vs-dark" }],
        },
      }),
    );

    const result = scanVSCodeExtensions("copilot", dir.path);
    expect(result.items).toHaveLength(0);
  });

  test("scans multiple extensions", async () => {
    dir = await createTestDir("am-vscode-mp-");
    const extDir = getExtensionsDir("cursor", dir.path)!;

    await dir.write(
      `${join(extDir, "pub.ext-a-1.0.0").replace(`${dir.path}/`, "")}/package.json`,
      JSON.stringify({
        name: "ext-a",
        publisher: "pub",
        version: "1.0.0",
        contributes: {
          mcpServers: {
            "server-a": { command: "node", args: ["a.js"] },
          },
        },
      }),
    );

    await dir.write(
      `${join(extDir, "pub.ext-b-2.0.0").replace(`${dir.path}/`, "")}/package.json`,
      JSON.stringify({
        name: "ext-b",
        publisher: "pub",
        version: "2.0.0",
        contributes: {
          mcpServers: {
            "server-b1": { command: "node", args: ["b1.js"] },
            "server-b2": { command: "node", args: ["b2.js"] },
          },
        },
      }),
    );

    const result = scanVSCodeExtensions("cursor", dir.path);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].source).toBe("cursor-extension");
    expect(result.items[1].source).toBe("cursor-extension");
    // Total servers across both extensions
    const totalServers = result.items.reduce((sum, i) => sum + i.servers.length, 0);
    expect(totalServers).toBe(3);
  });

  test("handles extension with string repository", async () => {
    dir = await createTestDir("am-vscode-mp-");
    const extDir = getExtensionsDir("copilot", dir.path)!;

    await dir.write(
      `${join(extDir, "pub.str-repo-1.0.0").replace(`${dir.path}/`, "")}/package.json`,
      JSON.stringify({
        name: "str-repo",
        publisher: "pub",
        version: "1.0.0",
        repository: "https://github.com/pub/str-repo",
        contributes: {
          mcpServers: {
            "repo-server": { command: "node", args: ["s.js"] },
          },
        },
      }),
    );

    const result = scanVSCodeExtensions("copilot", dir.path);
    expect(result.items[0].metadata.repository).toBe("https://github.com/pub/str-repo");
  });

  test("uses kiro source for kiro adapter", async () => {
    dir = await createTestDir("am-vscode-mp-");
    const extDir = getExtensionsDir("kiro", dir.path)!;

    await dir.write(
      `${join(extDir, "pub.kiro-ext-1.0.0").replace(`${dir.path}/`, "")}/package.json`,
      JSON.stringify({
        name: "kiro-ext",
        publisher: "pub",
        version: "1.0.0",
        contributes: {
          mcpServers: {
            "kiro-server": { command: "node", args: ["k.js"] },
          },
        },
      }),
    );

    const result = scanVSCodeExtensions("kiro", dir.path);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].source).toBe("kiro-extension");
  });

  test("uses windsurf source for windsurf adapter", async () => {
    dir = await createTestDir("am-vscode-mp-");
    const extDir = getExtensionsDir("windsurf", dir.path)!;

    await dir.write(
      `${join(extDir, "pub.ws-ext-1.0.0").replace(`${dir.path}/`, "")}/package.json`,
      JSON.stringify({
        name: "ws-ext",
        publisher: "pub",
        version: "1.0.0",
        contributes: {
          mcpServers: {
            "ws-server": { command: "node", args: ["w.js"] },
          },
        },
      }),
    );

    const result = scanVSCodeExtensions("windsurf", dir.path);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].source).toBe("windsurf-extension");
  });

  test("skips malformed package.json", async () => {
    dir = await createTestDir("am-vscode-mp-");
    const extDir = getExtensionsDir("copilot", dir.path)!;

    await dir.write(
      `${join(extDir, "pub.bad-ext-1.0.0").replace(`${dir.path}/`, "")}/package.json`,
      "{ not valid json ]]]",
    );

    const result = scanVSCodeExtensions("copilot", dir.path);
    expect(result.items).toHaveLength(0);
    expect(result.warnings).toHaveLength(0); // Silently skipped
  });

  test("skips non-directory entries", async () => {
    dir = await createTestDir("am-vscode-mp-");
    const extDir = getExtensionsDir("copilot", dir.path)!;

    // Create a file (not directory) in extensions dir
    await dir.write(join(extDir, ".DS_Store").replace(`${dir.path}/`, ""), "junk");

    const result = scanVSCodeExtensions("copilot", dir.path);
    expect(result.items).toHaveLength(0);
  });
});
