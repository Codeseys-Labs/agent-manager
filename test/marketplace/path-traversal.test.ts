import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { addMarketplace } from "../../src/marketplace/client";
import { applyPlugin, installPlugin } from "../../src/marketplace/installer";
import { MarketplaceSecurityError, safeResolveInsidePlugin } from "../../src/marketplace/security";
import type { DiscoveredPlugin, PluginManifest } from "../../src/marketplace/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

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

describe("marketplace/security: path traversal", () => {
  let dir: TestDir;
  let origConfigDir: string | undefined;

  beforeEach(async () => {
    dir = await createTestDir("am-path-traversal-");
    origConfigDir = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = dir.path;
  });

  afterEach(async () => {
    if (origConfigDir !== undefined) {
      process.env.AM_CONFIG_DIR = origConfigDir;
    } else {
      process.env.AM_CONFIG_DIR = undefined;
    }
    if (dir) await dir.cleanup();
  });

  // ── safeResolveInsidePlugin unit tests ─────────────────────────

  describe("safeResolveInsidePlugin", () => {
    test("accepts a relative path inside the plugin dir", () => {
      const base = "/plugins/foo";
      const resolved = safeResolveInsidePlugin(base, "skills/my-skill/", "skills");
      // resolve() emits native separators and (on Windows) a drive-letter
      // prefix, so build the expected base prefix the same way.
      expect(resolved.startsWith(resolve(base) + sep)).toBe(true);
    });

    test("rejects ../../../etc/passwd", () => {
      const base = "/plugins/foo";
      expect(() => safeResolveInsidePlugin(base, "../../../etc/passwd", "skills[0]")).toThrow(
        MarketplaceSecurityError,
      );
    });

    test("rejects a path that escapes via normalized traversal", () => {
      const base = "/plugins/foo";
      expect(() => safeResolveInsidePlugin(base, "skills/../../bar", "skills[0]")).toThrow(
        MarketplaceSecurityError,
      );
    });

    test("rejects an absolute path outside the plugin dir", () => {
      const base = "/plugins/foo";
      expect(() => safeResolveInsidePlugin(base, "/etc/passwd", "skills[0]")).toThrow(
        MarketplaceSecurityError,
      );
    });

    test("rejects a sibling-directory prefix attack", () => {
      // /plugins/foo-evil must NOT be accepted under /plugins/foo.
      const base = "/plugins/foo";
      expect(() => safeResolveInsidePlugin(base, "../foo-evil/leak", "skills")).toThrow(
        MarketplaceSecurityError,
      );
    });

    test("rejects NUL byte in candidate", () => {
      expect(() => safeResolveInsidePlugin("/plugins/foo", "skills/\0foo", "skills")).toThrow(
        MarketplaceSecurityError,
      );
    });

    test("rejects empty string", () => {
      expect(() => safeResolveInsidePlugin("/plugins/foo", "", "skills[0]")).toThrow(
        MarketplaceSecurityError,
      );
    });
  });

  // ── applyPlugin — skills field ──────────────────────────────────

  describe("applyPlugin: skills path traversal", () => {
    test("rejects skill path that escapes the plugin dir", () => {
      const config: Config = {};
      const plugin: DiscoveredPlugin = {
        manifest: {
          name: "evil-plugin",
          description: "Attempts to break out",
          skills: ["../../../etc/passwd"],
        },
        marketplace: "mp",
        pluginDir: "/plugins/evil-plugin",
        manifestPath: "/plugins/evil-plugin/.am-plugin/plugin.json",
      };

      expect(() => applyPlugin(config, plugin)).toThrow(MarketplaceSecurityError);
    });

    test("accepts in-plugin skill paths", () => {
      const config: Config = {};
      const plugin: DiscoveredPlugin = {
        manifest: {
          name: "good-plugin",
          description: "Clean paths",
          skills: ["skills/my-skill/"],
        },
        marketplace: "mp",
        pluginDir: "/plugins/good-plugin",
        manifestPath: "/plugins/good-plugin/.am-plugin/plugin.json",
      };

      const result = applyPlugin(config, plugin);
      expect(result.skills).toEqual(["my-skill"]);
      // path.resolve emits native separators + drive letter on Windows; build
      // the expected with the same resolve for a platform-agnostic assertion.
      expect(config.skills?.["my-skill"]?.path).toBe(
        resolve("/plugins/good-plugin", "skills/my-skill"),
      );
    });
  });

  // ── applyPlugin — agents[].prompt_file ──────────────────────────

  describe("applyPlugin: agent prompt_file traversal", () => {
    test("rejects prompt_file that escapes the plugin dir", () => {
      const config: Config = {};
      const plugin: DiscoveredPlugin = {
        manifest: {
          name: "evil-agent-plugin",
          description: "Bad prompt path",
          agents: {
            "evil-agent": {
              name: "Evil",
              prompt_file: "../../../etc/passwd",
            },
          },
        },
        marketplace: "mp",
        pluginDir: "/plugins/evil-agent-plugin",
        manifestPath: "/plugins/evil-agent-plugin/.am-plugin/plugin.json",
      };

      expect(() => applyPlugin(config, plugin)).toThrow(MarketplaceSecurityError);
    });
  });

  // ── installPlugin: end-to-end rejection ─────────────────────────

  describe("installPlugin: end-to-end rejects traversal", () => {
    test("installPlugin refuses manifest with ../../../etc/passwd skill", async () => {
      const configDir = dir.path;
      await initRepo(configDir);
      await writeConfig(join(configDir, "config.toml"), { servers: {} });

      const mpDir = join(dir.path, "mp");
      await createMockPlugin(mpDir, "evil", {
        name: "evil",
        description: "malicious",
        skills: ["../../../etc/passwd"],
      });
      await addMarketplace(mpDir, "evil-mp");

      await expect(installPlugin("evil")).rejects.toThrow();
    });
  });
});
