import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { diffConfig } from "@/adapters/codex-cli/diff.ts";
import { exportConfig } from "@/adapters/codex-cli/export.ts";
import { importConfig } from "@/adapters/codex-cli/import.ts";
import type { ResolvedConfig, ResolvedServer } from "@/adapters/types.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

describe("Codex CLI adapter roundtrip", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("import → transform → export → diff shows in-sync", async () => {
    dir = await createTestDir("am-codex-roundtrip-");

    // 1. Write sample native config.toml with mcp_servers
    const sampleToml = `[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[mcp_servers.context7.env]
API_KEY = "test-key"

[mcp_servers.fetch]
command = "uvx"
args = ["mcp-server-fetch"]
`;

    await dir.write(".codex/config.toml", sampleToml);

    // 2. Import
    const imported = importConfig({}, dir.path);
    expect(imported.servers).toHaveLength(2);
    expect(imported.warnings).toHaveLength(0);

    // 3. Transform to ResolvedConfig
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
        adapters: s.adapterExtras ? { "codex-cli": s.adapterExtras } : {},
      };
    }

    const resolved: ResolvedConfig = {
      servers: resolvedServers,
      instructions: {},
      skills: {},
      agents: {},
      profile: "default",
      adapters: {},
    };

    // 4. Export (writes to disk)
    const exported = exportConfig(resolved, {}, dir.path);
    expect(exported.warnings).toHaveLength(0);
    const globalFile = exported.files.find((f) => f.path.endsWith("config.toml"));
    expect(globalFile).toBeDefined();
    expect(globalFile?.written).toBe(true);

    // 5. Verify output preserves key fields
    expect(globalFile?.content).toContain("context7");
    expect(globalFile?.content).toContain("npx");
    expect(globalFile?.content).toContain("uvx");
    expect(globalFile?.content).toContain("mcp-server-fetch");

    // 6. Diff should show in-sync after roundtrip
    const diff = diffConfig(resolved, {}, dir.path);
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });

  test("import from fixtures → roundtrip", async () => {
    dir = await createTestDir("am-codex-roundtrip-fixture-");

    // Copy fixture files to temp dir
    const fixtureDir = join(import.meta.dir, "../../fixtures/codex-cli");
    const fs = require("node:fs");
    const sampleConfig = fs.readFileSync(join(fixtureDir, "sample-config.toml"), "utf-8");
    await dir.write(".codex/config.toml", sampleConfig);

    // Import
    const imported = importConfig({}, dir.path);
    // fixture has 3 servers: context7, figma (url-based), local-tool (disabled)
    expect(imported.servers.length).toBeGreaterThan(0);

    // Verify scopes — all global since we only provided global config
    const globalServers = imported.servers.filter((s) => s.scope === "global");
    expect(globalServers.length).toBe(imported.servers.length);

    // Verify disabled server is imported with enabled=false
    const localTool = imported.servers.find((s) => s.name === "local-tool");
    expect(localTool).toBeDefined();
    expect(localTool?.enabled).toBe(false);
  });

  test("servers with env vars survive roundtrip", async () => {
    dir = await createTestDir("am-codex-roundtrip-env-");

    const sampleToml = `[mcp_servers.tavily]
command = "bunx"
args = ["tavily-mcp@latest"]

[mcp_servers.tavily.env]
TAVILY_API_KEY = "\${TAVILY_API_KEY}"
`;

    await dir.write(".codex/config.toml", sampleToml);

    // Import
    const imported = importConfig({}, dir.path);
    expect(imported.servers).toHaveLength(1);
    const tavily = imported.servers[0];
    expect(tavily.env?.TAVILY_API_KEY).toBe("${TAVILY_API_KEY}");

    // Transform
    const resolvedServers: Record<string, ResolvedServer> = {};
    resolvedServers[tavily.name] = {
      name: tavily.name,
      command: tavily.command,
      args: tavily.args ?? [],
      env: tavily.env ?? {},
      transport: "stdio",
      description: "",
      tags: [],
      enabled: true,
      adapters: {},
    };

    const resolved: ResolvedConfig = {
      servers: resolvedServers,
      instructions: {},
      skills: {},
      agents: {},
      profile: "default",
      adapters: {},
    };

    // Export
    const exported = exportConfig(resolved, {}, dir.path);
    expect(exported.warnings).toHaveLength(0);

    // Diff
    const diff = diffConfig(resolved, {}, dir.path);
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });
});
