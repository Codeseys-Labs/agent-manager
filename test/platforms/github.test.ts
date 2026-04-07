import { describe, expect, it } from "bun:test";
import { github } from "../../src/platforms/github";

describe("github adapter", () => {
  describe("meta", () => {
    it("has correct name and displayName", () => {
      expect(github.meta.name).toBe("github");
      expect(github.meta.displayName).toBe("GitHub");
    });
  });

  describe("detect()", () => {
    it("returns true for github.com SSH URL", () => {
      expect(github.detect("git@github.com:user/repo.git")).toBe(true);
    });

    it("returns true for github.com HTTPS URL", () => {
      expect(github.detect("https://github.com/user/repo.git")).toBe(true);
    });

    it("returns true for github.com URL without .git suffix", () => {
      expect(github.detect("https://github.com/user/repo")).toBe(true);
    });

    it("returns false for GitLab URL", () => {
      expect(github.detect("git@gitlab.com:user/repo.git")).toBe(false);
    });

    it("returns false for Bitbucket URL", () => {
      expect(github.detect("git@bitbucket.org:user/repo.git")).toBe(false);
    });

    it("returns false for local path", () => {
      expect(github.detect("/srv/git/repo.git")).toBe(false);
    });
  });

  describe("optional methods", () => {
    it("has login method", () => {
      expect(typeof github.login).toBe("function");
    });

    it("has isAuthenticated method", () => {
      expect(typeof github.isAuthenticated).toBe("function");
    });

    it("has storeKey method", () => {
      expect(typeof github.storeKey).toBe("function");
    });

    it("retrieveKey always returns null (GitHub Secrets are write-only)", async () => {
      const result = await github.retrieveKey!("https://github.com/user/repo");
      expect(result).toBeNull();
    });

    it("has createRepo method", () => {
      expect(typeof github.createRepo).toBe("function");
    });
  });
});
