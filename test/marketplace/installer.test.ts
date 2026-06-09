import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { readAdaptersToml } from "../../src/adapters/community/loader";
import { readConfig, writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { MarketplaceError, addMarketplace } from "../../src/marketplace/client";
import {
  applyPlugin,
  installPlugin,
  listInstalled,
  uninstallPlugin,
} from "../../src/marketplace/installer";
import type { DiscoveredPlugin, PluginManifest } from "../../src/marketplace/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

/** Create a mock plugin directory with a manifest. */
async function createMockPlugin(
  baseDir: string,
  pluginName: string,
  manifest: PluginManifest,
): Promise<string> {
  const pluginDir = join(baseDir, pluginName);
  const manifestDir = join(pluginDir, ".am-plugin");
  await fs.promises.mkdir(manifestDir, { recursive: true });
  await fs.promises.writeFile(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2));
  return pluginDir;
}

describe("marketplace/installer", () => {
  let dir: TestDir;
  let origConfigDir: string | undefined;

  beforeEach(async () => {
    dir = await createTestDir("am-marketplace-installer-");
    origConfigDir = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = dir.path;
  });

  afterEach(async () => {
    if (origConfigDir !== undefined) {
      process.env.AM_CONFIG_DIR = origConfigDir;
    } else {
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    }
    if (dir) await dir.cleanup();
  });

  // ── applyPlugin (unit, no disk) ────────────────────────────────

  describe("applyPlugin", () => {
    test("adds servers from plugin manifest to config", () => {
      const config: Config = { servers: {} };
      const plugin: DiscoveredPlugin = {
        manifest: {
          name: "test-plugin",
          description: "A test plugin",
          version: "1.0.0",
          servers: {
            "my-server": { command: "node", args: ["server.js"] },
            "other-server": { command: "bunx", args: ["other@latest"], env: { KEY: "val" } },
          },
        },
        marketplace: "test-mp",
        pluginDir: "/fake/path/test-plugin",
        manifestPath: "/fake/path/test-plugin/.am-plugin/plugin.json",
      };

      const result = applyPlugin(config, plugin);

      expect(result.servers).toEqual(["my-server", "other-server"]);
      expect(config.servers?.["my-server"]).toBeDefined();
      expect(config.servers?.["my-server"].command).toBe("node");
      expect(config.servers?.["my-server"].args).toEqual(["server.js"]);
      expect(config.servers?.["my-server"]._marketplace).toBeDefined();
      expect(config.servers?.["my-server"]._marketplace?.package).toBe("test-plugin");

      expect(config.servers?.["other-server"].command).toBe("bunx");
      expect(config.servers?.["other-server"].env).toEqual({ KEY: "val" });
    });

    test("adds skills from plugin manifest to config", () => {
      const config: Config = {};
      const plugin: DiscoveredPlugin = {
        manifest: {
          name: "skill-plugin",
          description: "A skill plugin",
          skills: ["skills/my-skill/", "skills/other-skill/"],
        },
        marketplace: "test-mp",
        pluginDir: "/fake/path/skill-plugin",
        manifestPath: "/fake/path/skill-plugin/.am-plugin/plugin.json",
      };

      const result = applyPlugin(config, plugin);

      expect(result.skills).toEqual(["my-skill", "other-skill"]);
      expect(config.skills?.["my-skill"]).toBeDefined();
      // `safeResolveInsidePlugin` normalises via path.resolve, which strips
      // trailing slashes and emits native separators (drive-letter + `\` on
      // Windows). Build the expected with the same `resolve` so the assertion
      // is separator/platform-agnostic.
      expect(config.skills?.["my-skill"].path).toBe(
        resolve("/fake/path/skill-plugin", "skills/my-skill"),
      );
      expect(config.skills?.["my-skill"]._marketplace).toBeDefined();
      expect(config.skills?.["my-skill"]._marketplace?.package).toBe("skill-plugin");
    });

    test("adds agents from plugin manifest to config", () => {
      const config: Config = {};
      const plugin: DiscoveredPlugin = {
        manifest: {
          name: "agent-plugin",
          description: "An agent plugin",
          agents: {
            "research-agent": {
              name: "Research Agent",
              description: "From plugin: agent-plugin",
              prompt: "You are a research agent.",
              model: "claude-sonnet-4-20250514",
            },
          },
        },
        marketplace: "test-mp",
        pluginDir: "/fake/path/agent-plugin",
        manifestPath: "/fake/path/agent-plugin/.am-plugin/plugin.json",
      };

      const result = applyPlugin(config, plugin);

      expect(result.agents).toEqual(["research-agent"]);
      expect(config.agents?.["research-agent"]).toBeDefined();
      expect(config.agents?.["research-agent"].name).toBe("Research Agent");
      expect(config.agents?.["research-agent"]._marketplace).toBeDefined();
      expect(config.agents?.["research-agent"]._marketplace?.package).toBe("agent-plugin");
    });

    test("initializes config sections if missing", () => {
      const config: Config = {};
      const plugin: DiscoveredPlugin = {
        manifest: {
          name: "full-plugin",
          description: "Full plugin",
          servers: { s: { command: "cmd" } },
          skills: ["skills/sk/"],
          agents: { a: { name: "A" } },
        },
        marketplace: "mp",
        pluginDir: "/p",
        manifestPath: "/p/.am-plugin/plugin.json",
      };

      applyPlugin(config, plugin);

      expect(config.servers).toBeDefined();
      expect(config.skills).toBeDefined();
      expect(config.agents).toBeDefined();
    });
  });

  // ── installPlugin (integration) ────────────────────────────────

  describe("installPlugin", () => {
    test("installs a plugin and writes to config", async () => {
      const configDir = dir.path;
      await initRepo(configDir);

      const config: Config = { settings: { default_profile: "default" }, servers: {} };
      await writeConfig(join(configDir, "config.toml"), config);

      // Create a marketplace with a plugin
      const mpDir = join(dir.path, "test-marketplace");
      await createMockPlugin(mpDir, "cool-plugin", {
        name: "cool-plugin",
        description: "A cool plugin",
        version: "2.0.0",
        servers: {
          "cool-server": { command: "cool-cmd", args: ["--port", "3000"] },
        },
      });
      await addMarketplace(mpDir, "test-mp");

      const result = await installPlugin("cool-plugin");

      expect(result.plugin).toBe("cool-plugin");
      expect(result.servers).toEqual(["cool-server"]);

      // Verify config was updated on disk
      const updated = await readConfig(join(configDir, "config.toml"));
      expect(updated.servers?.["cool-server"]).toBeDefined();
      expect(updated.servers?.["cool-server"].command).toBe("cool-cmd");
      expect(updated.servers?.["cool-server"]._marketplace).toBeDefined();
    });

    test("throws when plugin not found", async () => {
      const configDir = dir.path;
      await initRepo(configDir);
      await writeConfig(join(configDir, "config.toml"), { servers: {} });

      await expect(installPlugin("nonexistent-plugin")).rejects.toThrow(MarketplaceError);
    });

    // Regression (ADR-0057): a plugin manifest may set `url` with `transport`
    // absent, which resolves to stdio. The ServerSchema discriminated union
    // forbids `url` on a stdio server, and writeConfig does NOT validate — so
    // an unguarded `url` copy would silently persist a stdio+url server that
    // bricks the config on the NEXT readConfig (ConfigSchema.parse throws).
    // The installer must guard `url` on the resolved transport (mirrors
    // install.ts). This test fails (config un-readable) before the guard.
    test("does NOT write url onto a stdio server when manifest url has no transport", async () => {
      const configDir = dir.path;
      await initRepo(configDir);
      await writeConfig(join(configDir, "config.toml"), {
        settings: { default_profile: "default" },
        servers: {},
      });

      const mpDir = join(dir.path, "url-no-transport-mp");
      await createMockPlugin(mpDir, "url-plugin", {
        name: "url-plugin",
        description: "server with url but no transport",
        version: "1.0.0",
        servers: {
          // url set, transport ABSENT → resolves to stdio
          "url-server": {
            command: "https://mcp.example.com/sse",
            url: "https://mcp.example.com/sse",
          },
        },
      } as PluginManifest);
      await addMarketplace(mpDir, "url-mp");

      // trustCommands: the command is URL-shaped (has a path separator), which
      // the security layer otherwise refuses — that gate is orthogonal to the
      // stdio+url schema guard under test here.
      const result = await installPlugin("url-plugin", { trustCommands: true });
      expect(result.servers).toEqual(["url-server"]);

      // The persisted config MUST round-trip: readConfig runs ConfigSchema.parse,
      // which throws on a stdio+url server. A clean read proves the guard held.
      const updated = await readConfig(join(configDir, "config.toml"));
      const srv = updated.servers?.["url-server"];
      expect(srv).toBeDefined();
      expect(srv?.transport).toBe("stdio");
      // url must NOT have been copied onto the stdio server.
      expect((srv as { url?: string }).url).toBeUndefined();
    });

    test("preserves url on a remote (streamable-http) plugin server", async () => {
      const configDir = dir.path;
      await initRepo(configDir);
      await writeConfig(join(configDir, "config.toml"), {
        settings: { default_profile: "default" },
        servers: {},
      });

      const mpDir = join(dir.path, "remote-mp");
      await createMockPlugin(mpDir, "remote-plugin", {
        name: "remote-plugin",
        description: "remote server with explicit transport + url",
        version: "1.0.0",
        servers: {
          "remote-server": {
            command: "https://mcp.example.com/mcp",
            transport: "streamable-http",
            url: "https://mcp.example.com/mcp",
          },
        },
      } as PluginManifest);
      await addMarketplace(mpDir, "remote-mp");

      await installPlugin("remote-plugin", { trustCommands: true });

      const updated = await readConfig(join(configDir, "config.toml"));
      const srv = updated.servers?.["remote-server"];
      expect(srv?.transport).toBe("streamable-http");
      expect((srv as { url?: string }).url).toBe("https://mcp.example.com/mcp");
    });

    test("registers community adapter in adapters.toml when manifest has adapter field", async () => {
      const configDir = dir.path;
      await initRepo(configDir);

      const config: Config = { settings: { default_profile: "default" }, servers: {} };
      await writeConfig(join(configDir, "config.toml"), config);

      const mpDir = join(dir.path, "adapter-marketplace");
      await createMockPlugin(mpDir, "zed-adapter-plugin", {
        name: "zed-adapter-plugin",
        description: "Plugin with a Zed adapter",
        version: "0.2.0",
        servers: {
          "zed-helper": { command: "zed-mcp-helper" },
        },
        adapter: {
          command: "/usr/local/bin/am-adapter-zed",
          source: "npm:am-adapter-zed@0.2.0",
        },
      } as PluginManifest);
      await addMarketplace(mpDir, "adapter-mp");

      const result = await installPlugin("zed-adapter-plugin");

      expect(result.adapter).toBe("zed-adapter-plugin");
      expect(result.servers).toEqual(["zed-helper"]);

      // Verify adapters.toml was updated
      const adaptersToml = await readAdaptersToml(configDir);
      expect(adaptersToml.adapters["zed-adapter-plugin"]).toBeDefined();
      expect(adaptersToml.adapters["zed-adapter-plugin"].command).toBe(
        "/usr/local/bin/am-adapter-zed",
      );
      expect(adaptersToml.adapters["zed-adapter-plugin"].source).toBe("npm:am-adapter-zed@0.2.0");
    });

    test("does not touch adapters.toml when manifest has no adapter field", async () => {
      const configDir = dir.path;
      await initRepo(configDir);

      const config: Config = { settings: { default_profile: "default" }, servers: {} };
      await writeConfig(join(configDir, "config.toml"), config);

      const mpDir = join(dir.path, "no-adapter-marketplace");
      await createMockPlugin(mpDir, "server-only-plugin", {
        name: "server-only-plugin",
        description: "No adapter, just servers",
        servers: { srv: { command: "cmd" } },
      });
      await addMarketplace(mpDir, "no-adapter-mp");

      const result = await installPlugin("server-only-plugin");

      expect(result.adapter).toBeUndefined();

      const adaptersToml = await readAdaptersToml(configDir);
      expect(Object.keys(adaptersToml.adapters)).toHaveLength(0);
    });
  });

  // ── uninstallPlugin ────────────────────────────────────────────

  describe("uninstallPlugin", () => {
    test("removes servers with matching provenance", async () => {
      const configDir = dir.path;
      await initRepo(configDir);

      const config: Config = {
        servers: {
          "marketplace-server": {
            command: "cmd",
            transport: "stdio",
            enabled: true,
            description: "From plugin: test-plugin",
            _marketplace: {
              source: "claude-plugin",
              package: "test-plugin",
              version: "1.0.0",
              imported_at: "2024-01-01T00:00:00Z",
              install_path: "/some/path",
            },
          },
          "manual-server": {
            command: "other-cmd",
            transport: "stdio",
            enabled: true,
          },
        },
      };
      await writeConfig(join(configDir, "config.toml"), config);

      const result = await uninstallPlugin("test-plugin");

      expect(result.removedServers).toEqual(["marketplace-server"]);

      const updated = await readConfig(join(configDir, "config.toml"));
      expect(updated.servers?.["marketplace-server"]).toBeUndefined();
      expect(updated.servers?.["manual-server"]).toBeDefined();
    });

    test("removes adapter from adapters.toml during uninstall", async () => {
      const configDir = dir.path;
      await initRepo(configDir);

      // Set up config with a marketplace-installed server
      const config: Config = {
        servers: {
          "adapter-server": {
            command: "cmd",
            transport: "stdio",
            enabled: true,
            description: "From plugin: adapter-plugin",
            _marketplace: {
              source: "claude-plugin",
              package: "adapter-plugin",
              version: "1.0.0",
              imported_at: "2024-01-01T00:00:00Z",
            },
          },
        },
      };
      await writeConfig(join(configDir, "config.toml"), config);

      // Set up adapters.toml with the matching adapter
      const { setCommunityAdapterConfig } = await import("../../src/adapters/community/loader");
      await setCommunityAdapterConfig(configDir, "adapter-plugin", {
        source: "marketplace:test-mp/adapter-plugin",
        command: "/usr/local/bin/am-adapter-test",
        installed_at: "2024-01-01T00:00:00Z",
      });

      const result = await uninstallPlugin("adapter-plugin");

      expect(result.removedServers).toEqual(["adapter-server"]);
      expect(result.removedAdapter).toBe("adapter-plugin");

      // Verify adapters.toml was cleaned up
      const adaptersToml = await readAdaptersToml(configDir);
      expect(adaptersToml.adapters["adapter-plugin"]).toBeUndefined();
    });

    test("removes skills and agents with matching _marketplace provenance", async () => {
      const configDir = dir.path;
      await initRepo(configDir);

      const config: Config = {
        servers: {
          "mp-server": {
            command: "cmd",
            transport: "stdio",
            enabled: true,
            _marketplace: {
              source: "claude-plugin",
              package: "full-plugin",
              version: "1.0.0",
              imported_at: "2024-01-01T00:00:00Z",
            },
          },
        },
        skills: {
          "mp-skill": {
            path: "/some/path",
            description: "From plugin: full-plugin",
            _marketplace: {
              source: "claude-plugin",
              package: "full-plugin",
              version: "1.0.0",
              imported_at: "2024-01-01T00:00:00Z",
            },
          },
          "manual-skill": {
            path: "/other/path",
            description: "Manually added",
          },
        },
        agents: {
          "mp-agent": {
            name: "MP Agent",
            description: "From plugin: full-plugin",
            _marketplace: {
              source: "claude-plugin",
              package: "full-plugin",
              version: "1.0.0",
              imported_at: "2024-01-01T00:00:00Z",
            },
          },
          "manual-agent": {
            name: "Manual Agent",
          },
        },
      };
      await writeConfig(join(configDir, "config.toml"), config);

      const result = await uninstallPlugin("full-plugin");

      expect(result.removedServers).toEqual(["mp-server"]);
      expect(result.removedSkills).toEqual(["mp-skill"]);
      expect(result.removedAgents).toEqual(["mp-agent"]);

      const updated = await readConfig(join(configDir, "config.toml"));
      expect(updated.skills?.["mp-skill"]).toBeUndefined();
      expect(updated.skills?.["manual-skill"]).toBeDefined();
      expect(updated.agents?.["mp-agent"]).toBeUndefined();
      expect(updated.agents?.["manual-agent"]).toBeDefined();
    });

    test("throws when no entities found for plugin", async () => {
      const configDir = dir.path;
      await initRepo(configDir);
      await writeConfig(join(configDir, "config.toml"), { servers: {} });

      await expect(uninstallPlugin("no-such-plugin")).rejects.toThrow(MarketplaceError);
    });
  });

  // ── listInstalled ──────────────────────────────────────────────

  describe("listInstalled", () => {
    test("returns empty when no marketplace servers exist", async () => {
      const configDir = dir.path;
      await writeConfig(join(configDir, "config.toml"), {
        servers: {
          manual: { command: "cmd", transport: "stdio", enabled: true },
        },
      });

      const result = await listInstalled();
      expect(result).toEqual([]);
    });

    test("groups servers by plugin name", async () => {
      const configDir = dir.path;
      await writeConfig(join(configDir, "config.toml"), {
        servers: {
          "server-a": {
            command: "cmd-a",
            transport: "stdio",
            enabled: true,
            _marketplace: {
              source: "claude-plugin",
              package: "plugin-x",
              version: "1.0.0",
              imported_at: "2024-01-01T00:00:00Z",
            },
          },
          "server-b": {
            command: "cmd-b",
            transport: "stdio",
            enabled: true,
            _marketplace: {
              source: "claude-plugin",
              package: "plugin-x",
              version: "1.0.0",
              imported_at: "2024-01-01T00:00:00Z",
            },
          },
          "server-c": {
            command: "cmd-c",
            transport: "stdio",
            enabled: true,
            _marketplace: {
              source: "claude-plugin",
              package: "plugin-y",
              version: "2.0.0",
              imported_at: "2024-02-01T00:00:00Z",
            },
          },
        },
      });

      const result = await listInstalled();
      expect(result).toHaveLength(2);

      const pluginX = result.find((r) => r.plugin === "plugin-x");
      expect(pluginX).toBeDefined();
      expect(pluginX!.servers).toHaveLength(2);

      const pluginY = result.find((r) => r.plugin === "plugin-y");
      expect(pluginY).toBeDefined();
      expect(pluginY!.servers).toHaveLength(1);
    });
  });
});
