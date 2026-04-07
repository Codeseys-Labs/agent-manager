import { describe, expect, it } from "bun:test";
import { detectPlatform, listPlatforms } from "../../src/platforms/registry";

describe("listPlatforms()", () => {
  it("returns all registered platform names", () => {
    const names = listPlatforms();
    expect(names).toContain("github");
    expect(names).toContain("gitlab");
    expect(names).toContain("bare");
  });
});

describe("detectPlatform()", () => {
  it("detects GitHub SSH URLs", () => {
    const p = detectPlatform("git@github.com:user/repo.git");
    expect(p.meta.name).toBe("github");
  });

  it("detects GitHub HTTPS URLs", () => {
    const p = detectPlatform("https://github.com/user/repo.git");
    expect(p.meta.name).toBe("github");
  });

  it("detects GitLab SSH URLs", () => {
    const p = detectPlatform("git@gitlab.com:user/repo.git");
    expect(p.meta.name).toBe("gitlab");
  });

  it("detects GitLab HTTPS URLs", () => {
    const p = detectPlatform("https://gitlab.com/user/repo.git");
    expect(p.meta.name).toBe("gitlab");
  });

  it("detects self-hosted GitLab URLs", () => {
    const p = detectPlatform("https://gitlab.mycompany.com/team/repo.git");
    expect(p.meta.name).toBe("gitlab");
  });

  it("falls back to bare for unknown remotes", () => {
    const p = detectPlatform("git@bitbucket.org:user/repo.git");
    expect(p.meta.name).toBe("bare");
  });

  it("falls back to bare for SSH URLs", () => {
    const p = detectPlatform("ssh://user@myserver.com/repo.git");
    expect(p.meta.name).toBe("bare");
  });

  it("falls back to bare for local paths", () => {
    const p = detectPlatform("/srv/git/repo.git");
    expect(p.meta.name).toBe("bare");
  });
});
