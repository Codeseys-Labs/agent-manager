import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { MarketplaceError, addMarketplace, listMarketplaces } from "../../src/marketplace/client";
import { promptTrustOnFirstUse } from "../../src/marketplace/security";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("marketplace/security: trust-on-first-use", () => {
  let dir: TestDir;
  let origConfigDir: string | undefined;

  beforeEach(async () => {
    dir = await createTestDir("am-tofu-");
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

  // ── Unit: promptTrustOnFirstUse ────────────────────────────────

  describe("promptTrustOnFirstUse", () => {
    test("auto-accepts when opts.yes is true (no TTY needed)", async () => {
      const trusted = await promptTrustOnFirstUse("https://example.com/x.git", "abc123", {
        yes: true,
      });
      expect(trusted).toBe(true);
    });

    test("refuses in non-TTY environment without --yes", async () => {
      // Bun tests run under a non-TTY stdin by default.
      const trusted = await promptTrustOnFirstUse("https://example.com/x.git", "abc123", {
        yes: false,
      });
      expect(trusted).toBe(false);
    });

    test("force flag bypasses the prompt even without --yes", async () => {
      const trusted = await promptTrustOnFirstUse("https://example.com/x.git", null, {
        force: true,
      });
      expect(trusted).toBe(true);
    });
  });

  // ── Integration: addMarketplace TOFU gate ──────────────────────

  describe("addMarketplace: TOFU gate", () => {
    test("refuses to add a remote URL in non-TTY without --yes", async () => {
      // Non-TTY + no --yes → TOFU prompt returns false → MarketplaceError.
      await expect(
        addMarketplace("https://github.com/nonexistent/repo.git", "blocked"),
      ).rejects.toThrow(MarketplaceError);

      // No entry should be recorded.
      const entries = await listMarketplaces();
      expect(entries.find((m) => m.name === "blocked")).toBeUndefined();
    });

    test("--yes bypasses TOFU and proceeds to clone (which may fail for a fake URL)", async () => {
      // With yes=true we skip TOFU but the clone of a bogus URL will fail
      // during git.clone. The important assertion is that the error is NOT
      // about trust — it's about the clone itself, and no partial entry
      // lingers in marketplaces.json.
      let caught: Error | null = null;
      try {
        await addMarketplace("https://github.com/nonexistent-abc-999/repo.git", "tofu-bypassed", {
          yes: true,
          // Tighten the timeout so the test doesn't stall on a slow DNS.
          cloneTimeoutMs: 2000,
        });
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      // The message must NOT be the "was not trusted" TOFU error.
      expect(caught?.message).not.toMatch(/not trusted/i);

      const entries = await listMarketplaces();
      expect(entries.find((m) => m.name === "tofu-bypassed")).toBeUndefined();
    });

    test("local filesystem paths bypass TOFU entirely", async () => {
      // Local paths are trust-of-first-mount (we're running as you anyway).
      const localSrc = join(dir.path, "local-src");
      await fs.promises.mkdir(localSrc, { recursive: true });

      const entry = await addMarketplace(localSrc, "local-tofu-skip");
      expect(entry.name).toBe("local-tofu-skip");
      expect(entry.source).toBe("local");
      // No SHA pinning for local symlinks.
      expect(entry.commit).toBeUndefined();
    });

    test("URL validation rejects before reaching the TOFU prompt", async () => {
      // http URL without --allow-http should be rejected on scheme grounds,
      // NOT on TOFU grounds — proves the order (validation → TOFU → clone).
      await expect(
        addMarketplace("http://example.com/x.git", "http-blocked", { yes: true }),
      ).rejects.toThrow(/scheme/i);
    });

    test("embedded credentials rejected even with --yes", async () => {
      await expect(
        addMarketplace("https://user:secret@github.com/foo/bar.git", "creds-blocked", {
          yes: true,
        }),
      ).rejects.toThrow(/credential/i);
    });
  });
});
