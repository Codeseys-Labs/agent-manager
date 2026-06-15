import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import {
  MarketplaceError,
  addMarketplace,
  deriveMarketplaceName,
  listMarketplaces,
  readMarketplacesFile,
  removeMarketplace,
  resolveMarketplacesDir,
  validateMarketplaceName,
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
      Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    }
    if (dir) await dir.cleanup();
  });

  // ── validateMarketplaceName (path-traversal guard) ─────────────

  describe("validateMarketplaceName", () => {
    test("accepts a simple lowercase name", () => {
      expect(() => validateMarketplaceName("my-market")).not.toThrow();
    });

    test("accepts digits, dash, and underscore", () => {
      expect(() => validateMarketplaceName("a0_b-c9")).not.toThrow();
    });

    test("rejects a parent-directory traversal name", () => {
      expect(() => validateMarketplaceName("../evil")).toThrow(MarketplaceError);
      expect(() => validateMarketplaceName("../../etc")).toThrow(MarketplaceError);
    });

    test("rejects a forward-slash separator (escapes the marketplaces dir)", () => {
      expect(() => validateMarketplaceName("a/b")).toThrow(MarketplaceError);
      expect(() => validateMarketplaceName("/etc/passwd")).toThrow(MarketplaceError);
    });

    test("rejects a backslash separator (Windows escape)", () => {
      expect(() => validateMarketplaceName("a\\b")).toThrow(MarketplaceError);
    });

    test("rejects an empty string", () => {
      expect(() => validateMarketplaceName("")).toThrow(MarketplaceError);
    });

    test("rejects uppercase, whitespace, and leading dash", () => {
      expect(() => validateMarketplaceName("Foo")).toThrow(MarketplaceError);
      expect(() => validateMarketplaceName("a b")).toThrow(MarketplaceError);
      expect(() => validateMarketplaceName("-foo")).toThrow(MarketplaceError);
    });

    test("rejects names longer than 64 chars", () => {
      expect(() => validateMarketplaceName("a".repeat(65))).toThrow(MarketplaceError);
    });
  });

  // ── addMarketplace: name validation BEFORE any filesystem op ────

  describe("addMarketplace: rejects traversal --name before touching the FS", () => {
    test("a '../evil' name is rejected and creates no symlink/clone outside the dir", async () => {
      // A real local target exists so the ONLY thing standing between the
      // attacker and an escaping symlink is name validation.
      const localDir = join(dir.path, "real-target");
      await fs.promises.mkdir(localDir, { recursive: true });

      const escapeProbe = join(dir.path, "escape-probe");

      await expect(addMarketplace(localDir, "../escape-probe")).rejects.toThrow(MarketplaceError);

      // Nothing was created at the escaped path …
      expect(await Bun.file(escapeProbe).exists()).toBe(false);
      // … and the marketplaces index was not mutated.
      const data = await readMarketplacesFile();
      expect(data.marketplaces).toHaveLength(0);
    });

    test("an absolute-path name is rejected", async () => {
      const localDir = join(dir.path, "real-target");
      await fs.promises.mkdir(localDir, { recursive: true });
      await expect(addMarketplace(localDir, "/tmp/abs-evil")).rejects.toThrow(MarketplaceError);
    });

    test("a valid --name still proceeds (local symlink)", async () => {
      const localDir = join(dir.path, "real-target");
      await fs.promises.mkdir(localDir, { recursive: true });
      const entry = await addMarketplace(localDir, "good-name");
      expect(entry.name).toBe("good-name");
      const data = await readMarketplacesFile();
      expect(data.marketplaces).toHaveLength(1);
    });
  });

  // ── removeMarketplace: traversal name cannot rm outside the dir ─

  describe("removeMarketplace: rejects traversal name before rm", () => {
    test("a '../victim' name is rejected and does NOT delete the escaped path", async () => {
      const marketplacesDir = resolveMarketplacesDir();
      await fs.promises.mkdir(marketplacesDir, { recursive: true });

      // Plant a "victim" directory that sits OUTSIDE the marketplaces dir but
      // would be reached by join(marketplacesDir, "../victim").
      const victim = join(dirname(marketplacesDir), "victim");
      await fs.promises.mkdir(victim, { recursive: true });
      await fs.promises.writeFile(join(victim, "precious.txt"), "do-not-delete");

      // Forge a marketplaces.json entry whose NAME is a traversal string so the
      // lookup succeeds and we reach the rm path under the old (vulnerable) code.
      await fs.promises.writeFile(
        join(marketplacesDir, "marketplaces.json"),
        JSON.stringify({
          marketplaces: [
            {
              name: "../victim",
              url: "https://example.com/x.git",
              source: "github",
              added_at: "2024-01-01",
            },
          ],
        }),
      );

      await expect(removeMarketplace("../victim")).rejects.toThrow(MarketplaceError);

      // The escaped directory and its contents survive.
      expect(await Bun.file(join(victim, "precious.txt")).exists()).toBe(true);
    });
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

    test("removes a legacy entry whose name no longer passes name validation", async () => {
      // An entry added before the name regex existed (e.g. uppercase) must stay
      // removable. validateMarketplaceName() would reject it on lookup, leaving
      // no cleanup path. removeMarketplace skips the regex (keeping only the
      // traversal floor) so the trusted local entry can still be removed.
      const legacyName = "UPPERCASE-Name";
      // Sanity: this name genuinely fails today's add-path validation.
      expect(() => validateMarketplaceName(legacyName)).toThrow(MarketplaceError);

      const mpDir = resolveMarketplacesDir();
      await fs.promises.mkdir(join(mpDir, legacyName), { recursive: true });
      await fs.promises.writeFile(
        join(mpDir, "marketplaces.json"),
        JSON.stringify({
          marketplaces: [
            {
              name: legacyName,
              url: "https://example.com/x.git",
              source: "github",
              added_at: "2024-01-01",
            },
          ],
        }),
      );

      // Should succeed (NOT throw) and remove the entry.
      await removeMarketplace(legacyName);

      const data = await readMarketplacesFile();
      expect(data.marketplaces).toHaveLength(0);
      // The on-disk directory is gone too.
      expect(await Bun.file(join(mpDir, legacyName)).exists()).toBe(false);
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
