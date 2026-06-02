import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { detect } from "@/adapters/copilot/detect.ts";
import { exportConfig } from "@/adapters/copilot/export.ts";
import { importConfig } from "@/adapters/copilot/import.ts";
import type { ResolvedConfig } from "@/adapters/types.ts";
import { toPosix } from "../../helpers/path.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

/**
 * Wave-A tests for the Copilot adapter's VS Code variant support.
 *
 * Before this change, Copilot hardcoded a macOS path
 * (`~/Library/Application Support/Code/User/mcp.json`). Now we iterate every
 * variant (Code, Code - Insiders, VSCodium, Cursor, Windsurf) on every
 * platform (darwin/linux/win32).
 */
const origPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p });
}
function restore() {
  Object.defineProperty(process, "platform", { value: origPlatform });
}

describe("copilot detect() — variant + platform coverage", () => {
  let dir: TestDir;
  afterEach(async () => {
    restore();
    if (dir) await dir.cleanup();
  });

  test("linux: detects user mcp.json under .config/Code/User/", async () => {
    dir = await createTestDir("am-cp-variants-");
    setPlatform("linux");
    await dir.write(".config/Code/User/mcp.json", JSON.stringify({ servers: {} }));
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.userMcpConfig).toBe(join(dir.path, ".config/Code/User/mcp.json"));
  });

  test("linux: detects user mcp.json under Insiders variant", async () => {
    dir = await createTestDir("am-cp-variants-");
    setPlatform("linux");
    await dir.write(".config/Code - Insiders/User/mcp.json", JSON.stringify({ servers: {} }));
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.userMcpConfig).toContain("Code - Insiders");
  });

  test("linux: detects user mcp.json under VSCodium", async () => {
    dir = await createTestDir("am-cp-variants-");
    setPlatform("linux");
    await dir.write(".config/VSCodium/User/mcp.json", JSON.stringify({ servers: {} }));
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.userMcpConfig).toContain("VSCodium");
  });

  test("linux: detects user mcp.json under Cursor", async () => {
    dir = await createTestDir("am-cp-variants-");
    setPlatform("linux");
    await dir.write(".config/Cursor/User/mcp.json", JSON.stringify({ servers: {} }));
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.userMcpConfig).toContain("Cursor");
  });

  test("darwin: detects user mcp.json under Library/Application Support/Code/User/", async () => {
    dir = await createTestDir("am-cp-variants-");
    setPlatform("darwin");
    await dir.write(
      "Library/Application Support/Code/User/mcp.json",
      JSON.stringify({ servers: {} }),
    );
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(toPosix(result.paths.userMcpConfig ?? "")).toContain(
      "Library/Application Support/Code/User/mcp.json",
    );
  });

  test("win32: respects APPDATA for user mcp.json location", async () => {
    dir = await createTestDir("am-cp-variants-");
    setPlatform("win32");
    const appData = join(dir.path, "AppData", "Roaming");
    process.env.APPDATA = appData;
    try {
      await dir.write("AppData/Roaming/Code/User/mcp.json", JSON.stringify({ servers: {} }));
      const result = detect(dir.path);
      expect(result.installed).toBe(true);
      expect(result.paths.userMcpConfig).toContain("Code");
    } finally {
      process.env.APPDATA = undefined;
    }
  });

  test("prefers stable Code over Insiders when both exist", async () => {
    dir = await createTestDir("am-cp-variants-");
    setPlatform("linux");
    await dir.write(".config/Code/User/mcp.json", JSON.stringify({ servers: {} }));
    await dir.write(".config/Code - Insiders/User/mcp.json", JSON.stringify({ servers: {} }));
    const result = detect(dir.path);
    expect(toPosix(result.paths.userMcpConfig ?? "")).toContain("/.config/Code/User/");
    expect(result.paths.userMcpConfig).not.toContain("Insiders");
  });
});

describe("copilot importConfig() — reads user-scope mcp.json on all platforms", () => {
  let dir: TestDir;
  afterEach(async () => {
    restore();
    if (dir) await dir.cleanup();
  });

  test("linux: imports user-scope servers", async () => {
    dir = await createTestDir("am-cp-variants-");
    setPlatform("linux");
    await dir.write(
      ".config/Code/User/mcp.json",
      JSON.stringify({
        servers: {
          "user-sqlite": { command: "uvx", args: ["mcp-server-sqlite"] },
        },
      }),
    );
    const result = importConfig({ entities: ["servers"] }, dir.path);
    const server = result.servers.find((s) => s.name === "user-sqlite");
    expect(server).toBeDefined();
    expect(server?.scope).toBe("global");
    expect(server?.command).toBe("uvx");
  });

  test("darwin: imports user-scope servers", async () => {
    dir = await createTestDir("am-cp-variants-");
    setPlatform("darwin");
    await dir.write(
      "Library/Application Support/Code/User/mcp.json",
      JSON.stringify({
        servers: {
          "user-fetch": { command: "uvx", args: ["mcp-server-fetch"] },
        },
      }),
    );
    const result = importConfig({ entities: ["servers"] }, dir.path);
    const server = result.servers.find((s) => s.name === "user-fetch");
    expect(server).toBeDefined();
    expect(server?.scope).toBe("global");
  });
});

describe("copilot exportConfig() — writes to existing user-scope mcp.json", () => {
  let dir: TestDir;
  afterEach(async () => {
    restore();
    if (dir) await dir.cleanup();
  });

  test("writes to user-scope when adapter scope=global AND an existing user mcp.json exists", async () => {
    dir = await createTestDir("am-cp-variants-");
    setPlatform("linux");
    await dir.write(".config/Code/User/mcp.json", JSON.stringify({ servers: {} }));

    const cfg: ResolvedConfig = {
      servers: {
        "user-srv": {
          name: "user-srv",
          command: "uvx",
          args: ["user-mcp"],
          env: {},
          transport: "stdio",
          description: "",
          tags: [],
          enabled: true,
          adapters: { copilot: { scope: "global" } },
        },
      },
      instructions: {},
      skills: {},
      profile: "default",
      adapters: {},
      agents: {},
    };

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    const userFile = result.files.find((f) => toPosix(f.path).endsWith("Code/User/mcp.json"));
    expect(userFile).toBeDefined();
    const parsed = JSON.parse(userFile?.content ?? "{}");
    expect(parsed.servers["user-srv"].command).toBe("uvx");
  });

  test("skips user-scope export with warning when no user mcp.json exists", async () => {
    dir = await createTestDir("am-cp-variants-");
    setPlatform("linux");

    const cfg: ResolvedConfig = {
      servers: {
        "user-srv": {
          name: "user-srv",
          command: "uvx",
          args: ["user-mcp"],
          env: {},
          transport: "stdio",
          description: "",
          tags: [],
          enabled: true,
          adapters: { copilot: { scope: "global" } },
        },
      },
      instructions: {},
      skills: {},
      profile: "default",
      adapters: {},
      agents: {},
    };

    const result = await exportConfig(cfg, { dryRun: true }, dir.path);
    const userFile = result.files.find((f) => toPosix(f.path).endsWith("Code/User/mcp.json"));
    expect(userFile).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("user-scope"))).toBe(true);
  });
});
