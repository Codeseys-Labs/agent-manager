import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  MarketplaceError,
  addMarketplace,
  deriveMarketplaceName,
  listMarketplaces,
  readMarketplacesFile,
  removeMarketplace,
  resolveMarketplacesDir,
} from "../../src/marketplace/client";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("marketplace/client", () => {
  let dir: TestDir;
  let origConfigDir: string | undefined;

  beforeEach(async () => {
    dir = await createTestDir("am-marketplace-client-");
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

  // ── deriveMarketplaceName ──────────────────────────────────────

  describe("deriveMarketplaceName", () => {
    test("extracts repo name from GitHub URL", () => {
      expect(deriveMarketplaceName("https://github.com/user/my-plugins.git")).toBe("my-plugins");
    });

    test("extracts repo name from URL without .git", () => {
      expect(deriveMarketplaceName("https://github.com/user/plugins")).toBe("plugins");
    });

    test("handles trailing slashes", () => {
      expect(deriveMarketplaceName("https://github.com/user/plugins/")).toBe("plugins");
    });

    test("returns 'marketplace' for empty path", () => {
      expect(deriveMarketplaceName("")).toBe("marketplace");
    });

    test("derives last segment from a Windows local path (backslash separators)", () => {
      // Local-path marketplaces on Windows use `\`; splitting only on `/` would
      // return the whole path as the name. (CodeRabbit #23 / xplat.)
      expect(deriveMarketplaceName("C:\\repos\\my-market")).toBe("my-market");
      expect(deriveMarketplaceName("C:\\repos\\my-market\\")).toBe("my-market");
    });

    test("derives last segment from a POSIX local path", () => {
      expect(deriveMarketplaceName("/home/user/repos/my-market")).toBe("my-market");
    });
  });

  // ── readMarketplacesFile ───────────────────────────────────────

  describe("readMarketplacesFile", () => {
    test("returns empty list when file does not exist", async () => {
      const data = await readMarketplacesFile();
      expect(data.marketplaces).toEqual([]);
    });

    test("reads existing marketplaces.json", async () => {
      const mpDir = resolveMarketplacesDir();
      await fs.promises.mkdir(mpDir, { recursive: true });
      await fs.promises.writeFile(
        join(mpDir, "marketplaces.json"),
        JSON.stringify({
          marketplaces: [
            {
              name: "test",
              url: "https://example.com/test.git",
              source: "github",
              added_at: "2024-01-01",
            },
          ],
        }),
      );

      const data = await readMarketplacesFile();
      expect(data.marketplaces).toHaveLength(1);
      expect(data.marketplaces[0].name).toBe("test");
    });
  });

  // ── addMarketplace (local) ─────────────────────────────────────

  describe("addMarketplace (local)", () => {
    test("adds a local marketplace via symlink", async () => {
      // Create a local "marketplace" directory
      const localDir = join(dir.path, "local-marketplace");
      await fs.promises.mkdir(localDir, { recursive: true });

      const entry = await addMarketplace(localDir, "local-test");
      expect(entry.name).toBe("local-test");
      expect(entry.source).toBe("local");

      // Verify symlink exists
      const mpDir = resolveMarketplacesDir();
      const linkTarget = await fs.promises.readlink(join(mpDir, "local-test"));
      expect(linkTarget).toBe(localDir);

      // Verify marketplaces.json was updated
      const data = await readMarketplacesFile();
      expect(data.marketplaces).toHaveLength(1);
    });

    test("throws on duplicate name", async () => {
      const localDir = join(dir.path, "local-marketplace");
      await fs.promises.mkdir(localDir, { recursive: true });

      await addMarketplace(localDir, "dup-test");
      await expect(addMarketplace(localDir, "dup-test")).rejects.toThrow(MarketplaceError);
    });

    test("throws on nonexistent local path", async () => {
      await expect(addMarketplace("/nonexistent/path/to/marketplace", "bad-local")).rejects.toThrow(
        MarketplaceError,
      );
    });
  });

  // ── removeMarketplace ──────────────────────────────────────────

  describe("removeMarketplace", () => {
    test("removes a local marketplace", async () => {
      const localDir = join(dir.path, "local-marketplace");
      await fs.promises.mkdir(localDir, { recursive: true });
      await addMarketplace(localDir, "to-remove");

      await removeMarketplace("to-remove");

      const data = await readMarketplacesFile();
      expect(data.marketplaces).toHaveLength(0);

      // Verify symlink was removed
      const mpDir = resolveMarketplacesDir();
      const exists = await Bun.file(join(mpDir, "to-remove")).exists();
      expect(exists).toBe(false);
    });

    test("throws when marketplace not found", async () => {
      await expect(removeMarketplace("nonexistent")).rejects.toThrow(MarketplaceError);
    });
  });

  // ── listMarketplaces ───────────────────────────────────────────

  describe("listMarketplaces", () => {
    test("returns empty array when none added", async () => {
      const result = await listMarketplaces();
      expect(result).toEqual([]);
    });

    test("returns all added marketplaces", async () => {
      const dir1 = join(dir.path, "mp1");
      const dir2 = join(dir.path, "mp2");
      await fs.promises.mkdir(dir1, { recursive: true });
      await fs.promises.mkdir(dir2, { recursive: true });

      await addMarketplace(dir1, "first");
      await addMarketplace(dir2, "second");

      const result = await listMarketplaces();
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("first");
      expect(result[1].name).toBe("second");
    });
  });
});
