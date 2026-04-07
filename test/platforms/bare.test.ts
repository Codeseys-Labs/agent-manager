import { describe, expect, it } from "bun:test";
import { bare } from "../../src/platforms/bare";

describe("bare adapter", () => {
  describe("meta", () => {
    it("has correct name and displayName", () => {
      expect(bare.meta.name).toBe("bare");
      expect(bare.meta.displayName).toBe("Git");
    });
  });

  describe("detect()", () => {
    it("returns true for any URL (fallback)", () => {
      expect(bare.detect("git@github.com:user/repo.git")).toBe(true);
      expect(bare.detect("https://gitlab.com/user/repo.git")).toBe(true);
      expect(bare.detect("ssh://user@myserver.com/repo.git")).toBe(true);
      expect(bare.detect("/srv/git/repo.git")).toBe(true);
      expect(bare.detect("anything")).toBe(true);
    });
  });

  describe("optional methods", () => {
    it("has no login method", () => {
      expect(bare.login).toBeUndefined();
    });

    it("has no isAuthenticated method", () => {
      expect(bare.isAuthenticated).toBeUndefined();
    });

    it("has no storeKey method", () => {
      expect(bare.storeKey).toBeUndefined();
    });

    it("has no retrieveKey method", () => {
      expect(bare.retrieveKey).toBeUndefined();
    });

    it("has no createRepo method", () => {
      expect(bare.createRepo).toBeUndefined();
    });
  });
});
