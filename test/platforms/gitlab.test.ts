import { describe, expect, it } from "bun:test";
import { gitlab } from "../../src/platforms/gitlab";

describe("gitlab adapter", () => {
  describe("meta", () => {
    it("has correct name and displayName", () => {
      expect(gitlab.meta.name).toBe("gitlab");
      expect(gitlab.meta.displayName).toBe("GitLab");
    });
  });

  describe("detect()", () => {
    it("returns true for gitlab.com SSH URL", () => {
      expect(gitlab.detect("git@gitlab.com:user/repo.git")).toBe(true);
    });

    it("returns true for gitlab.com HTTPS URL", () => {
      expect(gitlab.detect("https://gitlab.com/user/repo.git")).toBe(true);
    });

    it("returns true for gitlab.com URL without .git suffix", () => {
      expect(gitlab.detect("https://gitlab.com/user/repo")).toBe(true);
    });

    it("returns true for self-hosted GitLab", () => {
      expect(gitlab.detect("git@gitlab.example.com:group/repo.git")).toBe(true);
    });

    it("returns true for GitLab subgroup URL", () => {
      expect(gitlab.detect("https://gitlab.com/group/subgroup/repo.git")).toBe(true);
    });

    it("returns false for GitHub URL", () => {
      expect(gitlab.detect("git@github.com:user/repo.git")).toBe(false);
    });

    it("returns false for Bitbucket URL", () => {
      expect(gitlab.detect("git@bitbucket.org:user/repo.git")).toBe(false);
    });

    it("returns false for local path", () => {
      expect(gitlab.detect("/srv/git/repo.git")).toBe(false);
    });
  });

  describe("optional methods", () => {
    it("has login method", () => {
      expect(typeof gitlab.login).toBe("function");
    });

    it("has isAuthenticated method", () => {
      expect(typeof gitlab.isAuthenticated).toBe("function");
    });

    it("has storeKey method", () => {
      expect(typeof gitlab.storeKey).toBe("function");
    });

    it("has retrieveKey method", () => {
      expect(typeof gitlab.retrieveKey).toBe("function");
    });

    it("has createRepo method", () => {
      expect(typeof gitlab.createRepo).toBe("function");
    });
  });
});
