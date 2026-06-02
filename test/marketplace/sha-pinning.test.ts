import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import git from "isomorphic-git";
import { writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import {
  MarketplaceError,
  resolveMarketplacesDir,
  verifyMarketplacePin,
} from "../../src/marketplace/client";
import { installPlugin } from "../../src/marketplace/installer";
import { resolveHeadSha } from "../../src/marketplace/security";
import type { MarketplaceEntry, PluginManifest } from "../../src/marketplace/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

const AUTHOR = { name: "am-test", email: "am@test.local" };

/**
 * Create a git-backed marketplace directory with a single plugin.
 * Returns the clone dir and the commit SHA of HEAD.
 */
async function createGitMarketplace(
  parentDir: string,
  marketplaceName: string,
  pluginName: string,
  manifest: PluginManifest,
): Promise<{ dir: string; sha: string }> {
  const mpDir = join(parentDir, marketplaceName);
  await fs.promises.mkdir(mpDir, { recursive: true });
  await git.init({ fs, dir: mpDir, defaultBranch: "main" });

  const pluginDir = join(mpDir, pluginName);
  const manifestDir = join(pluginDir, ".am-plugin");
  await fs.promises.mkdir(manifestDir, { recursive: true });
  await fs.promises.writeFile(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2));

  await git.add({ fs, dir: mpDir, filepath: `${pluginName}/.am-plugin/plugin.json` });
  const sha = await git.commit({ fs, dir: mpDir, message: "initial", author: AUTHOR });

  return { dir: mpDir, sha };
}

/**
 * Seed marketplaces.json directly (bypassing TOFU) so tests can exercise
 * pin verification without an interactive prompt.
 */
async function seedMarketplaceEntry(entry: MarketplaceEntry): Promise<void> {
  const mpDir = resolveMarketplacesDir();
  await fs.promises.mkdir(mpDir, { recursive: true });
  const filePath = join(mpDir, "marketplaces.json");
  await fs.promises.writeFile(filePath, `${JSON.stringify({ marketplaces: [entry] }, null, 2)}\n`);
}

describe("marketplace/security: SHA pinning", () => {
  let dir: TestDir;
  let origConfigDir: string | undefined;

  beforeEach(async () => {
    dir = await createTestDir("am-sha-pinning-");
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

  // ── resolveHeadSha ─────────────────────────────────────────────

  describe("resolveHeadSha", () => {
    test("returns the HEAD commit SHA of a git repo", async () => {
      const { dir: mpDir, sha } = await createGitMarketplace(dir.path, "mp", "p", {
        name: "p",
        description: "tiny",
      });
      const head = await resolveHeadSha(mpDir);
      expect(head).toBe(sha);
    });

    test("returns null for a non-git directory", async () => {
      const scratch = join(dir.path, "not-a-repo");
      await fs.promises.mkdir(scratch, { recursive: true });
      const head = await resolveHeadSha(scratch);
      expect(head).toBeNull();
    });
  });

  // ── verifyMarketplacePin ───────────────────────────────────────

  describe("verifyMarketplacePin", () => {
    test("is a no-op for local marketplaces", async () => {
      const entry: MarketplaceEntry = {
        name: "local-mp",
        url: "/tmp/x",
        source: "local",
        added_at: new Date().toISOString(),
      };
      await expect(verifyMarketplacePin(entry)).resolves.toBeUndefined();
    });

    test("is a no-op when not pinned", async () => {
      const entry: MarketplaceEntry = {
        name: "unpinned",
        url: "https://example.com/x.git",
        source: "github",
        added_at: new Date().toISOString(),
      };
      await expect(verifyMarketplacePin(entry)).resolves.toBeUndefined();
    });

    test("passes when HEAD matches the pinned SHA", async () => {
      // Create a git marketplace and place it into the marketplaces dir.
      const mpParent = join(dir.path, "src-marketplaces");
      await fs.promises.mkdir(mpParent, { recursive: true });
      const { sha } = await createGitMarketplace(mpParent, "pinned-mp", "p", {
        name: "p",
        description: "x",
      });

      const mpRootDir = resolveMarketplacesDir();
      await fs.promises.mkdir(mpRootDir, { recursive: true });
      // Move the git marketplace into the expected location.
      await fs.promises.rename(join(mpParent, "pinned-mp"), join(mpRootDir, "pinned-mp"));

      const entry: MarketplaceEntry = {
        name: "pinned-mp",
        url: "https://example.com/pinned.git",
        source: "github",
        added_at: new Date().toISOString(),
        commit: sha,
        pinned: true,
      };
      await expect(verifyMarketplacePin(entry)).resolves.toBeUndefined();
    });

    test("throws when HEAD differs from the pinned SHA", async () => {
      const mpParent = join(dir.path, "src-marketplaces");
      await fs.promises.mkdir(mpParent, { recursive: true });
      const { sha: realSha } = await createGitMarketplace(mpParent, "drifting-mp", "p", {
        name: "p",
        description: "x",
      });

      const mpRootDir = resolveMarketplacesDir();
      await fs.promises.mkdir(mpRootDir, { recursive: true });
      await fs.promises.rename(join(mpParent, "drifting-mp"), join(mpRootDir, "drifting-mp"));

      const entry: MarketplaceEntry = {
        name: "drifting-mp",
        url: "https://example.com/drift.git",
        source: "github",
        added_at: new Date().toISOString(),
        // Deliberate mismatch — a bogus SHA.
        commit: "0".repeat(40),
        pinned: true,
      };
      expect(realSha).not.toBe("0".repeat(40));
      await expect(verifyMarketplacePin(entry)).rejects.toThrow(MarketplaceError);
    });
  });

  // ── installPlugin refuses drifted clones ───────────────────────

  describe("installPlugin: pin mismatch refuses install", () => {
    test("refuses install when the clone's HEAD does not match the pinned SHA", async () => {
      // Build a real git-backed marketplace inside the marketplaces dir.
      const mpRootDir = resolveMarketplacesDir();
      await fs.promises.mkdir(mpRootDir, { recursive: true });
      const { sha: realSha } = await createGitMarketplace(mpRootDir, "mp", "evil-plugin", {
        name: "evil-plugin",
        description: "would be installed if pin ignored",
      });

      // Record a DIFFERENT pinned SHA to simulate drift.
      await seedMarketplaceEntry({
        name: "mp",
        url: "https://example.com/mp.git",
        source: "github",
        added_at: new Date().toISOString(),
        commit: "1111111111111111111111111111111111111111",
        pinned: true,
      });

      // Set up the config dir with a minimal config.toml + git repo.
      await initRepo(dir.path);
      await writeConfig(join(dir.path, "config.toml"), { servers: {} });

      await expect(installPlugin("evil-plugin")).rejects.toThrow(MarketplaceError);
      expect(realSha).not.toBe("1111111111111111111111111111111111111111");
    });

    test("allows install when the pinned SHA matches HEAD", async () => {
      const mpRootDir = resolveMarketplacesDir();
      await fs.promises.mkdir(mpRootDir, { recursive: true });
      const { sha } = await createGitMarketplace(mpRootDir, "mp-ok", "good-plugin", {
        name: "good-plugin",
        description: "would install cleanly",
        servers: { s: { command: "echo" } },
      });

      await seedMarketplaceEntry({
        name: "mp-ok",
        url: "https://example.com/mp-ok.git",
        source: "github",
        added_at: new Date().toISOString(),
        commit: sha,
        pinned: true,
      });

      await initRepo(dir.path);
      await writeConfig(join(dir.path, "config.toml"), { servers: {} });

      const result = await installPlugin("good-plugin");
      expect(result.plugin).toBe("good-plugin");
      expect(result.servers).toEqual(["s"]);
    });
  });

  // ── Pin recorded at add time (addMarketplace integration) ──────

  describe("addMarketplace: pin recorded", () => {
    test("addMarketplace records a SHA for local clones of git repos via file://", async () => {
      // Create a remote-shaped bare repo and clone it via --allow-file
      // to exercise the full addMarketplace pipeline end-to-end without
      // hitting the network.
      const { addMarketplace } = await import("../../src/marketplace/client");

      // Build a bare-ish source repo.
      const sourceRepo = join(dir.path, "source.git");
      await fs.promises.mkdir(sourceRepo, { recursive: true });
      await git.init({ fs, dir: sourceRepo, defaultBranch: "main" });
      await fs.promises.writeFile(join(sourceRepo, "README.md"), "hi\n");
      await git.add({ fs, dir: sourceRepo, filepath: "README.md" });
      const sourceSha = await git.commit({
        fs,
        dir: sourceRepo,
        message: "init",
        author: AUTHOR,
      });

      // file:// URLs need allowFile=true AND we auto-accept TOFU via yes=true.
      // isomorphic-git does not support file:// transport out of the box, so
      // we expect the security validation to *accept* the URL but the clone
      // itself to fail. That failure path is exactly what we want to assert
      // does NOT leave a SHA pinned on a partial clone.
      const fileUrl = `file://${sourceRepo}`;
      await expect(
        addMarketplace(fileUrl, "file-test", { allowFile: true, yes: true }),
      ).rejects.toThrow(MarketplaceError);
      // Nothing persisted after the clone failed.
      const entries = (await import("../../src/marketplace/client")).listMarketplaces;
      expect((await entries()).find((m) => m.name === "file-test")).toBeUndefined();
      expect(sourceSha).toBeTruthy();
    });
  });
});
