import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { addMarketplace, resolveMarketplacesDir } from "../../src/marketplace/client";
import { readPluginManifest, scanMarketplace, searchPlugins } from "../../src/marketplace/scanner";
import type { PluginManifest } from "../../src/marketplace/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

/** Create a mock plugin directory with a manifest under .am-plugin/. */
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

/** Create a mock plugin directory with a manifest under .claude-plugin/. */
async function createClaudePlugin(
  baseDir: string,
  pluginName: string,
  manifest: PluginManifest,
): Promise<string> {
  const pluginDir = join(baseDir, pluginName);
  const manifestDir = join(pluginDir, ".claude-plugin");
  await fs.promises.mkdir(manifestDir, { recursive: true });
  await fs.promises.writeFile(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2));
  return pluginDir;
}

describe("marketplace/scanner", () => {
  let dir: TestDir;
  let origConfigDir: string | undefined;

  beforeEach(async () => {
    dir = await createTestDir("am-marketplace-scanner-");
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

  // ── readPluginManifest ─────────────────────────────────────────

  describe("readPluginManifest", () => {
    test("reads a valid manifest", async () => {
      const pluginDir = join(dir.path, "test-plugin");
      await createMockPlugin(dir.path, "test-plugin", {
        name: "my-plugin",
        description: "A test plugin",
        version: "1.0.0",
        servers: {
          "my-server": { command: "node", args: ["server.js"] },
        },
      });

      const manifest = await readPluginManifest(pluginDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.name).toBe("my-plugin");
      expect(manifest!.description).toBe("A test plugin");
      expect(manifest!.servers?.["my-server"]?.command).toBe("node");
    });

    test("returns null for missing manifest", async () => {
      const pluginDir = join(dir.path, "no-manifest");
      await fs.promises.mkdir(pluginDir, { recursive: true });

      const manifest = await readPluginManifest(pluginDir);
      expect(manifest).toBeNull();
    });

    test("returns null for manifest missing required fields", async () => {
      const pluginDir = join(dir.path, "bad-manifest");
      const manifestDir = join(pluginDir, ".am-plugin");
      await fs.promises.mkdir(manifestDir, { recursive: true });
      await fs.promises.writeFile(
        join(manifestDir, "plugin.json"),
        JSON.stringify({ name: "test" }), // Missing description
      );

      const manifest = await readPluginManifest(pluginDir);
      expect(manifest).toBeNull();
    });

    test("returns null for invalid JSON", async () => {
      const pluginDir = join(dir.path, "invalid-json");
      const manifestDir = join(pluginDir, ".am-plugin");
      await fs.promises.mkdir(manifestDir, { recursive: true });
      await fs.promises.writeFile(join(manifestDir, "plugin.json"), "{invalid json");

      const manifest = await readPluginManifest(pluginDir);
      expect(manifest).toBeNull();
    });

    test("reads .claude-plugin/plugin.json as fallback", async () => {
      const pluginDir = await createClaudePlugin(dir.path, "claude-style-plugin", {
        name: "claude-style",
        description: "Uses Claude Code plugin format",
        version: "1.0.0",
        servers: {
          "claude-server": { command: "node", args: ["index.js"] },
        },
      });

      const manifest = await readPluginManifest(pluginDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.name).toBe("claude-style");
      expect(manifest!.servers?.["claude-server"]).toBeDefined();
    });

    test("prefers .am-plugin over .claude-plugin when both exist", async () => {
      const pluginDir = join(dir.path, "dual-manifest");
      // Create .am-plugin
      const amDir = join(pluginDir, ".am-plugin");
      await fs.promises.mkdir(amDir, { recursive: true });
      await fs.promises.writeFile(
        join(amDir, "plugin.json"),
        JSON.stringify({ name: "am-version", description: "AM format" }),
      );
      // Create .claude-plugin
      const claudeDir = join(pluginDir, ".claude-plugin");
      await fs.promises.mkdir(claudeDir, { recursive: true });
      await fs.promises.writeFile(
        join(claudeDir, "plugin.json"),
        JSON.stringify({ name: "claude-version", description: "Claude format" }),
      );

      const manifest = await readPluginManifest(pluginDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.name).toBe("am-version");
    });

    test("reads manifest with adapter field", async () => {
      const pluginDir = await createMockPlugin(dir.path, "adapter-plugin", {
        name: "adapter-plugin",
        description: "Plugin with a community adapter",
        adapter: { command: "/usr/local/bin/am-adapter-zed", source: "npm:am-adapter-zed@0.2.0" },
      } as PluginManifest);

      const manifest = await readPluginManifest(pluginDir);
      expect(manifest).not.toBeNull();
      expect(manifest!.adapter).toBeDefined();
      expect(manifest!.adapter!.command).toBe("/usr/local/bin/am-adapter-zed");
      expect(manifest!.adapter!.source).toBe("npm:am-adapter-zed@0.2.0");
    });
  });

  // ── scanMarketplace ────────────────────────────────────────────

  describe("scanMarketplace", () => {
    test("finds plugins in root-level subdirectories", async () => {
      const mpDir = join(dir.path, "test-marketplace");
      await createMockPlugin(mpDir, "plugin-a", {
        name: "plugin-a",
        description: "Plugin A",
        servers: { "server-a": { command: "cmd-a" } },
      });
      await createMockPlugin(mpDir, "plugin-b", {
        name: "plugin-b",
        description: "Plugin B",
      });

      const plugins = await scanMarketplace("test-mp", mpDir);
      expect(plugins).toHaveLength(2);
      expect(plugins.map((p) => p.manifest.name).sort()).toEqual(["plugin-a", "plugin-b"]);
    });

    test("finds plugins in plugins/ subdirectory", async () => {
      const mpDir = join(dir.path, "test-marketplace");
      const pluginsDir = join(mpDir, "plugins");
      await createMockPlugin(pluginsDir, "sub-plugin", {
        name: "sub-plugin",
        description: "A sub plugin",
      });

      const plugins = await scanMarketplace("test-mp", mpDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].manifest.name).toBe("sub-plugin");
    });

    test("skips directories without manifest", async () => {
      const mpDir = join(dir.path, "test-marketplace");
      await createMockPlugin(mpDir, "valid-plugin", {
        name: "valid",
        description: "Valid plugin",
      });
      // Create dir without manifest
      await fs.promises.mkdir(join(mpDir, "no-manifest"), { recursive: true });

      const plugins = await scanMarketplace("test-mp", mpDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].manifest.name).toBe("valid");
    });

    test("skips hidden directories", async () => {
      const mpDir = join(dir.path, "test-marketplace");
      await createMockPlugin(mpDir, ".hidden-plugin", {
        name: "hidden",
        description: "Should be skipped",
      });
      await createMockPlugin(mpDir, "visible-plugin", {
        name: "visible",
        description: "Should be found",
      });

      const plugins = await scanMarketplace("test-mp", mpDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].manifest.name).toBe("visible");
    });

    test("returns empty for nonexistent directory", async () => {
      const plugins = await scanMarketplace("test-mp", "/nonexistent/dir");
      expect(plugins).toEqual([]);
    });

    test("includes marketplace name in results", async () => {
      const mpDir = join(dir.path, "test-marketplace");
      await createMockPlugin(mpDir, "plugin-x", {
        name: "plugin-x",
        description: "Test",
      });

      const plugins = await scanMarketplace("my-mp-name", mpDir);
      expect(plugins[0].marketplace).toBe("my-mp-name");
    });

    test("discovers .claude-plugin format plugins", async () => {
      const mpDir = join(dir.path, "claude-marketplace");
      await createClaudePlugin(mpDir, "claude-mcp", {
        name: "claude-mcp",
        description: "A Claude Code plugin",
        servers: { "my-mcp": { command: "bunx" } },
      });

      const plugins = await scanMarketplace("claude-mp", mpDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].manifest.name).toBe("claude-mcp");
      expect(plugins[0].manifestPath).toContain(".claude-plugin");
    });

    test("discovers mixed .am-plugin and .claude-plugin plugins", async () => {
      const mpDir = join(dir.path, "mixed-marketplace");
      await createMockPlugin(mpDir, "am-native", {
        name: "am-native",
        description: "AM format plugin",
      });
      await createClaudePlugin(mpDir, "claude-native", {
        name: "claude-native",
        description: "Claude format plugin",
      });

      const plugins = await scanMarketplace("mixed-mp", mpDir);
      expect(plugins).toHaveLength(2);
      const names = plugins.map((p) => p.manifest.name).sort();
      expect(names).toEqual(["am-native", "claude-native"]);
    });

    test("discovers .claude-plugin format with only name and description", async () => {
      const mpDir = join(dir.path, "claude-minimal-marketplace");
      await createClaudePlugin(mpDir, "minimal-claude-plugin", {
        name: "minimal-claude",
        description: "A minimal Claude Code plugin with no servers or agents",
      });

      const plugins = await scanMarketplace("claude-min-mp", mpDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].manifest.name).toBe("minimal-claude");
      expect(plugins[0].manifest.description).toBe(
        "A minimal Claude Code plugin with no servers or agents",
      );
      expect(plugins[0].manifest.servers).toBeUndefined();
      expect(plugins[0].manifest.agents).toBeUndefined();
      expect(plugins[0].manifestPath).toContain(".claude-plugin");
    });
  });

  // ── searchPlugins ──────────────────────────────────────────────

  describe("searchPlugins", () => {
    test("searches by plugin name", async () => {
      const mpDir = join(dir.path, "search-marketplace");
      await createMockPlugin(mpDir, "fetch-plugin", {
        name: "fetch-plugin",
        description: "URL fetching",
        servers: { fetch: { command: "uvx" } },
      });
      await createMockPlugin(mpDir, "search-plugin", {
        name: "search-plugin",
        description: "Web search",
        servers: { tavily: { command: "bunx" } },
      });

      // Add as a local marketplace
      await addMarketplace(mpDir, "search-test");

      const results = await searchPlugins("fetch");
      expect(results).toHaveLength(1);
      expect(results[0].manifest.name).toBe("fetch-plugin");
    });

    test("searches by description", async () => {
      const mpDir = join(dir.path, "search-marketplace");
      await createMockPlugin(mpDir, "web-plugin", {
        name: "web-plugin",
        description: "Advanced web search and extraction",
      });

      await addMarketplace(mpDir, "search-desc-test");

      const results = await searchPlugins("extraction");
      expect(results).toHaveLength(1);
    });

    test("searches by server name", async () => {
      const mpDir = join(dir.path, "search-marketplace");
      await createMockPlugin(mpDir, "multi-server", {
        name: "multi-server",
        description: "Multiple servers",
        servers: {
          "tavily-search": { command: "bunx" },
          "exa-search": { command: "bunx" },
        },
      });

      await addMarketplace(mpDir, "search-server-test");

      const results = await searchPlugins("tavily");
      expect(results).toHaveLength(1);
    });

    test("returns empty for no matches", async () => {
      const mpDir = join(dir.path, "search-marketplace");
      await createMockPlugin(mpDir, "unrelated", {
        name: "unrelated",
        description: "Nothing useful",
      });

      await addMarketplace(mpDir, "search-empty-test");

      const results = await searchPlugins("zzzznonexistent");
      expect(results).toEqual([]);
    });
  });
});
