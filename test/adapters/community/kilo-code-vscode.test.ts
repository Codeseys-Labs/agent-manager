import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { detect, findKiloExtensionStoragePath } from "@/adapters/kilo-code/detect.ts";
import { exportConfig } from "@/adapters/kilo-code/export.ts";
import { importConfig } from "@/adapters/kilo-code/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

/**
 * Wave-A tests for the Kilo Code adapter's new VS Code extension surface.
 *
 * Kilo ships as both a CLI (writing `~/.config/kilo/kilo.jsonc`) and a VS
 * Code extension (`kilocode.Kilo-Code` writing
 * `<globalStorage>/settings/mcp_settings.json`). These tests lock in both
 * surfaces being read and written.
 */
const origPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p });
}
function restore() {
  Object.defineProperty(process, "platform", { value: origPlatform });
}

function resolvedServer(overrides: Partial<ResolvedServer> & { command: string }): ResolvedServer {
  return {
    name: "test",
    args: [],
    env: {},
    transport: "stdio",
    description: "",
    tags: [],
    enabled: true,
    adapters: {},
    ...overrides,
  };
}

describe("kilo-code VS Code extension surface", () => {
  let dir: TestDir;
  afterEach(async () => {
    restore();
    if (dir) await dir.cleanup();
  });

  test("findKiloExtensionStoragePath finds stable Code variant", async () => {
    dir = await createTestDir("am-kc-vscode-");
    setPlatform("linux");
    await dir.write(".config/Code/User/globalStorage/kilocode.Kilo-Code/.keep", "");
    const path = findKiloExtensionStoragePath(dir.path);
    expect(path).toBe(join(dir.path, ".config/Code/User/globalStorage/kilocode.Kilo-Code"));
  });

  test("findKiloExtensionStoragePath finds Insiders variant when only it is installed", async () => {
    dir = await createTestDir("am-kc-vscode-");
    setPlatform("linux");
    await dir.write(".config/Code - Insiders/User/globalStorage/kilocode.Kilo-Code/.keep", "");
    const path = findKiloExtensionStoragePath(dir.path);
    expect(path).toContain("Code - Insiders");
  });

  test("detect() reports installed:true when only extension is present", async () => {
    dir = await createTestDir("am-kc-vscode-");
    setPlatform("linux");
    await dir.write(
      ".config/Code/User/globalStorage/kilocode.Kilo-Code/settings/mcp_settings.json",
      JSON.stringify({
        mcpServers: {
          sqlite: { command: "uvx", args: ["mcp-server-sqlite"] },
        },
      }),
    );
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.extensionStorageDir).toContain("globalStorage/kilocode.Kilo-Code");
    expect(result.paths.extensionMcpSettings).toContain("mcp_settings.json");
  });

  test("importConfig() reads extension mcp_settings.json", async () => {
    dir = await createTestDir("am-kc-vscode-");
    setPlatform("linux");
    await dir.write(
      ".config/Code/User/globalStorage/kilocode.Kilo-Code/settings/mcp_settings.json",
      JSON.stringify({
        mcpServers: {
          "ext-only": {
            command: "uvx",
            args: ["ext-mcp"],
            env: { X: "1" },
            alwaysAllow: ["read_file"],
          },
        },
      }),
    );
    const result = importConfig({}, dir.path);
    const server = result.servers.find((s) => s.name === "ext-only");
    expect(server).toBeDefined();
    expect(server?.command).toBe("uvx");
    expect(server?.args).toEqual(["ext-mcp"]);
    expect(server?.env).toEqual({ X: "1" });
    expect(server?.adapterExtras?.alwaysAllow).toEqual(["read_file"]);
    expect(server?.adapterExtras?.source).toBe("vscode-extension");
  });

  test("importConfig() merges CLI and extension; extension wins on name collision", async () => {
    dir = await createTestDir("am-kc-vscode-");
    setPlatform("linux");

    // CLI surface
    await dir.write(
      ".config/kilo/kilo.jsonc",
      JSON.stringify({
        mcp: {
          shared: { type: "local", command: ["cli-cmd", "a"] },
          "cli-only": { type: "local", command: ["cli-only-cmd"] },
        },
      }),
    );

    // Extension surface
    await dir.write(
      ".config/Code/User/globalStorage/kilocode.Kilo-Code/settings/mcp_settings.json",
      JSON.stringify({
        mcpServers: {
          shared: { command: "ext-cmd", args: ["b"] },
          "ext-only": { command: "ext-only-cmd" },
        },
      }),
    );

    const result = importConfig({}, dir.path);
    const names = result.servers.map((s) => s.name).sort();
    expect(names).toEqual(["cli-only", "ext-only", "shared"]);

    const shared = result.servers.find((s) => s.name === "shared");
    expect(shared?.command).toBe("ext-cmd");
    expect(shared?.adapterExtras?.source).toBe("vscode-extension");
    expect(result.warnings.some((w) => w.includes("overrode CLI"))).toBe(true);
  });

  test("exportConfig() writes extension mcp_settings.json when extension dir exists", async () => {
    dir = await createTestDir("am-kc-vscode-");
    setPlatform("linux");
    await dir.write(".config/Code/User/globalStorage/kilocode.Kilo-Code/.keep", "");

    const cfg: ResolvedConfig = {
      servers: {
        fetch: resolvedServer({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
      instructions: {},
      skills: {},
      profile: "default",
      adapters: {},
      agents: {},
    };

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    const extFile = result.files.find((f) =>
      f.path.includes("globalStorage/kilocode.Kilo-Code/settings/mcp_settings.json"),
    );
    expect(extFile).toBeDefined();
    const parsed = JSON.parse(extFile?.content ?? "{}");
    expect(parsed.mcpServers.fetch.command).toBe("uvx");
    expect(parsed.mcpServers.fetch.args).toEqual(["mcp-server-fetch"]);
  });

  test("exportConfig() does NOT write extension file when extension dir missing", async () => {
    dir = await createTestDir("am-kc-vscode-");
    setPlatform("linux");
    // No extension dir created.

    const cfg: ResolvedConfig = {
      servers: {
        fetch: resolvedServer({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
      instructions: {},
      skills: {},
      profile: "default",
      adapters: {},
      agents: {},
    };

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    const extFile = result.files.find((f) => f.path.includes("globalStorage/kilocode.Kilo-Code"));
    expect(extFile).toBeUndefined();
  });
});
