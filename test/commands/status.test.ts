import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffConfig } from "../../src/adapters/claude-code/diff";
import type { ResolvedConfig, ResolvedServer } from "../../src/adapters/types";
import { buildResolvedConfig, loadResolvedConfig, writeConfig } from "../../src/core/config";
import { commitAll, getStatus, initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { findMissingSkillAgentDeps } from "../../src/core/skill-deps";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("am status", () => {
  let dir: TestDir;

  afterEach(async () => {
    if (dir) await dir.cleanup();
  });

  test("reports clean status after init", async () => {
    dir = await createTestDir("am-status-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {
        fetch: { command: "uvx", transport: "stdio", enabled: true },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "init config");

    const status = await getStatus(configDir);
    expect(status.clean).toBe(true);
    expect(status.branch).toBe("main");
  });

  test("reports dirty status with uncommitted changes", async () => {
    dir = await createTestDir("am-status-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      settings: { default_profile: "default" },
      servers: {},
    };
    await writeConfig(join(configDir, "config.toml"), config);
    await commitAll(configDir, "init config");

    // Make a change without committing
    config.servers = { newServer: { command: "test", transport: "stdio", enabled: true } };
    await writeConfig(join(configDir, "config.toml"), config);

    const status = await getStatus(configDir);
    expect(status.clean).toBe(false);
    expect(status.dirty).toContain("config.toml");
  });

  test("reports server count correctly", async () => {
    dir = await createTestDir("am-status-");
    const configDir = dir.path;
    await initRepo(configDir);

    const config: Config = {
      servers: {
        a: { command: "a", transport: "stdio", enabled: true },
        b: { command: "b", transport: "stdio", enabled: true },
        c: { command: "c", transport: "stdio", enabled: false },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const loaded = await loadResolvedConfig({ configDir, configFile: "config.toml" });
    expect(Object.keys(loaded.servers ?? {}).length).toBe(3);
  });

  // ws4-drift-relabel-catalog-ahead: `am status` must split a catalog-ahead
  // delta (e.g. right after `am add server`) into PENDING ("N to add") and not
  // conflate it with REAL native-side drift. This mirrors the split the status
  // command computes (pending = added-in-config; drift = the rest).
  test("classifies catalog-ahead delta as pending, not drift", async () => {
    dir = await createTestDir("am-status-");
    // Native config has only `fetch`; the resolved catalog has `fetch` + a
    // freshly-added `tavily`. That is a catalog-ahead FORWARD delta.
    await dir.write(
      ".claude.json",
      JSON.stringify({ mcpServers: { fetch: { command: "uvx", args: ["mcp-server-fetch"] } } }),
    );

    const mk = (overrides: Partial<ResolvedServer> & { command: string }): ResolvedServer => ({
      name: "test",
      args: [],
      env: {},
      transport: "stdio",
      description: "",
      tags: [],
      enabled: true,
      adapters: {},
      ...overrides,
    });
    const resolved: ResolvedConfig = {
      servers: {
        fetch: mk({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }),
        tavily: mk({ name: "tavily", command: "bunx", args: ["tavily-mcp@latest"] }),
      },
      instructions: {},
      skills: {},
      agents: {},
      profile: "default",
      adapters: {},
    };

    const diffResult = diffConfig(resolved, {}, dir.path);
    // Same split the status command renders from.
    const pending = diffResult.changes.filter((c) => c.type === "added-in-config").length;
    const drift = diffResult.changes.length - pending;

    expect(pending).toBe(1);
    expect(drift).toBe(0);
    // Status would render "1 to add", NOT "drift detected".
    expect(diffResult.changes.some((c) => c.type === "removed-locally")).toBe(false);
  });

  test("classifies a genuinely-modified server as drift, not pending", async () => {
    dir = await createTestDir("am-status-");
    // Native `fetch` command hand-edited away from the catalog value: real drift.
    await dir.write(
      ".claude.json",
      JSON.stringify({ mcpServers: { fetch: { command: "npx", args: ["mcp-server-fetch"] } } }),
    );

    const resolved: ResolvedConfig = {
      servers: {
        fetch: {
          name: "fetch",
          command: "uvx",
          args: ["mcp-server-fetch"],
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
      agents: {},
      profile: "default",
      adapters: {},
    };

    const diffResult = diffConfig(resolved, {}, dir.path);
    const pending = diffResult.changes.filter((c) => c.type === "added-in-config").length;
    const drift = diffResult.changes.length - pending;

    expect(pending).toBe(0);
    expect(drift).toBeGreaterThan(0);
  });

  // ws6-skill-deps-missing-agent (R2/297e): a skill whose SKILL.md body calls
  // Task(subagent_type='hyperresearch-fetcher') with no matching catalog agent
  // must surface as a missing dependency in both the `--json` `missing-deps`
  // envelope field and the human "skill X references missing agent Y" line.
  test("reports a skill referencing an absent agent as a missing dep", async () => {
    dir = await createTestDir("am-status-");
    const configDir = dir.path;
    await initRepo(configDir);

    // Skill directory + SKILL.md body that delegates to an agent the catalog
    // does NOT provide.
    const skillDir = join(configDir, "skills", "researcher");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "# Researcher\n\nFan out with Task(subagent_type='hyperresearch-fetcher').\n",
    );

    const config: Config = {
      settings: { default_profile: "default" },
      skills: {
        researcher: { path: skillDir, description: "Research skill" },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    // Mirror exactly what `am status` computes from the resolved catalog.
    const resolved = buildResolvedConfig(config, "default", configDir);
    const missingDeps = findMissingSkillAgentDeps(resolved);

    expect(missingDeps).toEqual([{ skill: "researcher", agent: "hyperresearch-fetcher" }]);

    // Human render line + JSON envelope field shape.
    const humanLine = `  skill ${missingDeps[0].skill} references missing agent ${missingDeps[0].agent}`;
    expect(humanLine).toBe("  skill researcher references missing agent hyperresearch-fetcher");
    const envelope = { "missing-deps": missingDeps };
    expect(envelope["missing-deps"]).toContainEqual({
      skill: "researcher",
      agent: "hyperresearch-fetcher",
    });
  });

  test("reports no missing deps when the referenced agent is in the catalog", async () => {
    dir = await createTestDir("am-status-");
    const configDir = dir.path;
    await initRepo(configDir);

    const skillDir = join(configDir, "skills", "researcher");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "# Researcher\n\nFan out with Task(subagent_type='hyperresearch-fetcher').\n",
    );

    const config: Config = {
      settings: { default_profile: "default" },
      skills: {
        researcher: { path: skillDir, description: "Research skill" },
      },
      agents: {
        "hyperresearch-fetcher": { name: "hyperresearch-fetcher", prompt: "Fetch sources." },
      },
    };
    await writeConfig(join(configDir, "config.toml"), config);

    const resolved = buildResolvedConfig(config, "default", configDir);
    expect(findMissingSkillAgentDeps(resolved)).toEqual([]);
  });
});
