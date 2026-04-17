import { afterEach, describe, expect, test } from "bun:test";
import { detect } from "@/adapters/continue/detect.ts";
import { exportConfig } from "@/adapters/continue/export.ts";
import { importConfig } from "@/adapters/continue/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

/**
 * Wave-A tests for the Continue adapter rewrite.
 *
 * Covers the modern YAML config.yaml + .continue/mcpServers/*.yaml surface,
 * legacy config.json import with a deprecation warning, and export fall-back
 * to JSON when only legacy file is present.
 */

function server(overrides: Partial<ResolvedServer> & { command: string }): ResolvedServer {
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

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    servers: {},
    instructions: {},
    skills: {},
    profile: "default",
    adapters: {},
    agents: {},
    ...overrides,
  };
}

describe("continue detect() — YAML + JSON variants", () => {
  let dir: TestDir;
  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("detects config.yaml as the modern path", async () => {
    dir = await createTestDir("am-ctyaml-detect-");
    await dir.write(".continue/config.yaml", "name: foo\nversion: 0.0.1\nschema: v1\n");
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalConfigYaml).toContain("config.yaml");
    expect(result.paths.globalConfigJson).toBeUndefined();
  });

  test("detects legacy config.json", async () => {
    dir = await createTestDir("am-ctyaml-detect-");
    await dir.write(".continue/config.json", JSON.stringify({ mcpServers: [] }));
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalConfigJson).toContain("config.json");
    expect(result.paths.globalConfigYaml).toBeUndefined();
  });

  test("detects both when both exist", async () => {
    dir = await createTestDir("am-ctyaml-detect-");
    await dir.write(".continue/config.yaml", "name: foo\n");
    await dir.write(".continue/config.json", "{}");
    const result = detect(dir.path);
    expect(result.paths.globalConfigYaml).toContain("config.yaml");
    expect(result.paths.globalConfigJson).toContain("config.json");
  });

  test("detects .continue/mcpServers/ block dir", async () => {
    dir = await createTestDir("am-ctyaml-detect-");
    await dir.write(".continue/mcpServers/a.yaml", "name: a\n");
    const result = detect(dir.path);
    expect(result.installed).toBe(true);
    expect(result.paths.globalMcpServersDir).toContain("mcpServers");
  });
});

describe("continue importConfig() — YAML first", () => {
  let dir: TestDir;
  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("reads mcpServers from config.yaml (modern path)", async () => {
    dir = await createTestDir("am-ctyaml-import-");
    await dir.write(
      ".continue/config.yaml",
      [
        "name: my-assistant",
        "version: 0.0.1",
        "schema: v1",
        "mcpServers:",
        "  - name: sqlite",
        "    command: uvx",
        "    args:",
        "      - mcp-server-sqlite",
        "      - --db-path",
        "      - ./test.db",
        "    env:",
        "      NODE_ENV: production",
        "  - name: fetch",
        "    command: uvx",
        "    args:",
        "      - mcp-server-fetch",
        "",
      ].join("\n"),
    );

    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(2);

    const sqlite = result.servers.find((s) => s.name === "sqlite");
    expect(sqlite).toBeDefined();
    expect(sqlite?.command).toBe("uvx");
    expect(sqlite?.args).toEqual(["mcp-server-sqlite", "--db-path", "./test.db"]);
    expect(sqlite?.env).toEqual({ NODE_ENV: "production" });

    expect(result.warnings.some((w) => w.includes("deprecated"))).toBe(false);
  });

  test("reads per-server .continue/mcpServers/*.yaml block files", async () => {
    dir = await createTestDir("am-ctyaml-import-");
    await dir.write(
      ".continue/mcpServers/weather.yaml",
      [
        "name: weather-block",
        "version: 1.0.0",
        "schema: v1",
        "mcpServers:",
        "  - name: weather",
        "    command: uvx",
        "    args:",
        "      - weather-mcp",
        "",
      ].join("\n"),
    );

    const result = importConfig({}, dir.path);
    const weather = result.servers.find((s) => s.name === "weather");
    expect(weather).toBeDefined();
    expect(weather?.args).toEqual(["weather-mcp"]);
  });

  test("emits deprecation warning when only legacy config.json exists", async () => {
    dir = await createTestDir("am-ctyaml-import-");
    await dir.write(
      ".continue/config.json",
      JSON.stringify({
        mcpServers: [{ name: "legacy", command: "uvx", args: ["legacy-mcp"] }],
      }),
    );
    const result = importConfig({}, dir.path);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("legacy");
    expect(result.warnings.some((w) => w.includes("deprecated"))).toBe(true);
  });

  test("prefers config.yaml when both exist, warns about legacy", async () => {
    dir = await createTestDir("am-ctyaml-import-");
    await dir.write(
      ".continue/config.yaml",
      [
        "name: x",
        "schema: v1",
        "mcpServers:",
        "  - name: modern",
        "    command: uvx",
        "    args: [modern-mcp]",
        "",
      ].join("\n"),
    );
    await dir.write(
      ".continue/config.json",
      JSON.stringify({
        mcpServers: [{ name: "legacy", command: "uvx", args: ["legacy-mcp"] }],
      }),
    );
    const result = importConfig({}, dir.path);
    // Both sources feed into the result (last-wins dedupe is a future iter).
    const names = result.servers.map((s) => s.name).sort();
    expect(names).toContain("modern");
    expect(names).toContain("legacy");
    expect(result.warnings.some((w) => w.includes("deprecated"))).toBe(true);
  });

  test("returns File not found when nothing exists", () => {
    return (async () => {
      dir = await createTestDir("am-ctyaml-import-");
      const result = importConfig({}, dir.path);
      expect(result.servers).toHaveLength(0);
      expect(result.warnings.some((w) => w.includes("File not found"))).toBe(true);
    })();
  });
});

describe("continue exportConfig() — YAML first", () => {
  let dir: TestDir;
  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("writes config.yaml by default (no existing file)", async () => {
    dir = await createTestDir("am-ctyaml-export-");
    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = exportConfig(cfg, {}, dir.path);
    const yamlFile = result.files.find((f) => f.path.endsWith("config.yaml"));
    expect(yamlFile).toBeDefined();
    expect(yamlFile?.written).toBe(true);
    expect(yamlFile?.content).toContain("mcpServers:");
    expect(yamlFile?.content).toContain("name: fetch");
    expect(yamlFile?.content).toContain("command: uvx");
    expect(yamlFile?.content).toContain("schema: v1");

    // No config.json written
    const jsonFile = result.files.find((f) => f.path.endsWith("config.json"));
    expect(jsonFile).toBeUndefined();
  });

  test("writes config.json (legacy) when only config.json exists", async () => {
    dir = await createTestDir("am-ctyaml-export-");
    await dir.write(
      ".continue/config.json",
      JSON.stringify({ name: "legacy-profile", mcpServers: [] }),
    );

    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = exportConfig(cfg, { dryRun: true }, dir.path);
    const jsonFile = result.files.find((f) => f.path.endsWith("config.json"));
    expect(jsonFile).toBeDefined();

    const parsed = JSON.parse(jsonFile?.content ?? "{}");
    expect(Array.isArray(parsed.mcpServers)).toBe(true);
    expect(parsed.mcpServers).toHaveLength(1);
    expect(parsed.mcpServers[0].name).toBe("fetch");
    expect(parsed.name).toBe("legacy-profile"); // preserved

    expect(result.warnings.some((w) => w.includes("deprecated"))).toBe(true);
  });

  test("preserves existing non-mcpServers fields in config.yaml", async () => {
    dir = await createTestDir("am-ctyaml-export-");
    await dir.write(
      ".continue/config.yaml",
      [
        "name: my-assistant",
        "version: 2.3.4",
        "schema: v1",
        "models:",
        "  - name: claude",
        "    provider: anthropic",
        "mcpServers: []",
        "",
      ].join("\n"),
    );

    const cfg = config({
      servers: {
        fetch: server({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
      },
    });

    const result = exportConfig(cfg, {}, dir.path);
    const yamlFile = result.files.find((f) => f.path.endsWith("config.yaml"));
    expect(yamlFile?.content).toContain("name: my-assistant");
    expect(yamlFile?.content).toContain("version: 2.3.4");
    expect(yamlFile?.content).toContain("provider: anthropic");
    expect(yamlFile?.content).toContain("name: fetch");
  });
});

describe("continue roundtrip — YAML read → YAML write", () => {
  let dir: TestDir;
  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import YAML → export → import preserves server data", async () => {
    dir = await createTestDir("am-ctyaml-rt-");
    const originalYaml = [
      "name: my-assistant",
      "version: 0.0.1",
      "schema: v1",
      "mcpServers:",
      "  - name: sqlite",
      "    command: uvx",
      "    args:",
      "      - mcp-server-sqlite",
      "      - --db-path",
      "      - ./test.db",
      "    env:",
      "      NODE_ENV: production",
      "  - name: fetch",
      "    command: uvx",
      "    args:",
      "      - mcp-server-fetch",
      "",
    ].join("\n");
    await dir.write(".continue/config.yaml", originalYaml);

    const imported = importConfig({}, dir.path);
    expect(imported.servers).toHaveLength(2);

    const resolvedServers: Record<string, ResolvedServer> = {};
    for (const s of imported.servers) {
      resolvedServers[s.name] = {
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        env: s.env ?? {},
        transport: s.transport ?? "stdio",
        description: s.description ?? "",
        tags: s.tags ?? [],
        enabled: s.enabled ?? true,
        adapters: s.adapterExtras ? { continue: s.adapterExtras } : {},
      };
    }
    const resolved: ResolvedConfig = {
      servers: resolvedServers,
      instructions: {},
      skills: {},
      profile: "default",
      adapters: {},
      agents: {},
    };

    const exported = exportConfig(resolved, {}, dir.path);
    const yamlFile = exported.files.find((f) => f.path.endsWith("config.yaml"));
    expect(yamlFile?.written).toBe(true);

    // Now import again from what we just wrote
    const reimported = importConfig({}, dir.path);
    expect(reimported.servers).toHaveLength(2);
    const sqlite = reimported.servers.find((s) => s.name === "sqlite");
    expect(sqlite?.args).toEqual(["mcp-server-sqlite", "--db-path", "./test.db"]);
    expect(sqlite?.env).toEqual({ NODE_ENV: "production" });
  });

  test("import legacy JSON → export preserves JSON path + emits warning", async () => {
    dir = await createTestDir("am-ctyaml-rt-");
    await dir.write(
      ".continue/config.json",
      JSON.stringify({
        mcpServers: [{ name: "legacy", command: "uvx", args: ["legacy-mcp"] }],
      }),
    );

    const imported = importConfig({}, dir.path);
    expect(imported.servers).toHaveLength(1);

    const resolved: ResolvedConfig = {
      servers: {
        legacy: {
          name: "legacy",
          command: "uvx",
          args: ["legacy-mcp"],
          env: {},
          transport: "stdio",
          description: "",
          tags: [],
          enabled: true,
          adapters: {},
        },
      },
      instructions: {},
      skills: {},
      profile: "default",
      adapters: {},
      agents: {},
    };

    const exported = exportConfig(resolved, {}, dir.path);
    const jsonFile = exported.files.find((f) => f.path.endsWith("config.json"));
    expect(jsonFile).toBeDefined();
    expect(exported.warnings.some((w) => w.includes("deprecated"))).toBe(true);
  });
});
