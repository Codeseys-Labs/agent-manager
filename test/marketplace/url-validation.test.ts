import { describe, expect, test } from "bun:test";
import {
  MarketplaceSecurityError,
  isLocalPath,
  validateMarketplaceUrl,
} from "../../src/marketplace/security";

describe("marketplace/security: URL validation", () => {
  // ── Scheme enforcement ─────────────────────────────────────────

  test("accepts https:// URLs", () => {
    expect(() => validateMarketplaceUrl("https://github.com/foo/bar.git")).not.toThrow();
  });

  test("rejects http:// by default", () => {
    expect(() => validateMarketplaceUrl("http://github.com/foo/bar.git")).toThrow(
      MarketplaceSecurityError,
    );
  });

  test("allows http:// when allowHttp is set", () => {
    expect(() =>
      validateMarketplaceUrl("http://github.com/foo/bar.git", { allowHttp: true }),
    ).not.toThrow();
  });

  test("rejects git:// (unencrypted git protocol)", () => {
    expect(() => validateMarketplaceUrl("git://github.com/foo/bar.git")).toThrow(
      MarketplaceSecurityError,
    );
  });

  test("rejects ssh:// URLs", () => {
    expect(() => validateMarketplaceUrl("ssh://git@github.com/foo/bar.git")).toThrow(
      MarketplaceSecurityError,
    );
  });

  test("rejects ftp:// URLs", () => {
    expect(() => validateMarketplaceUrl("ftp://example.com/bar.git")).toThrow(
      MarketplaceSecurityError,
    );
  });

  test("rejects file:// by default", () => {
    expect(() => validateMarketplaceUrl("file:///tmp/fake.git")).toThrow(MarketplaceSecurityError);
  });

  test("allows file:// when allowFile is set", () => {
    expect(() => validateMarketplaceUrl("file:///tmp/fake.git", { allowFile: true })).not.toThrow();
  });

  test("rejects malformed URLs", () => {
    expect(() => validateMarketplaceUrl("not a url")).toThrow(MarketplaceSecurityError);
    expect(() => validateMarketplaceUrl("https://")).toThrow(MarketplaceSecurityError);
  });

  // ── Credential rejection ───────────────────────────────────────

  test("rejects URLs with embedded username + password", () => {
    expect(() => validateMarketplaceUrl("https://alice:secret@github.com/foo/bar.git")).toThrow(
      MarketplaceSecurityError,
    );
  });

  test("rejects URLs with only a username", () => {
    expect(() => validateMarketplaceUrl("https://token@github.com/foo/bar.git")).toThrow(
      MarketplaceSecurityError,
    );
  });

  // ── Port enforcement ───────────────────────────────────────────

  test("accepts default ports", () => {
    expect(() => validateMarketplaceUrl("https://github.com:443/foo/bar.git")).not.toThrow();
  });

  test("rejects non-standard port on https by default", () => {
    expect(() => validateMarketplaceUrl("https://github.com:8443/foo/bar.git")).toThrow(
      MarketplaceSecurityError,
    );
  });

  test("allows non-standard port when allowNonstandardPort is set", () => {
    expect(() =>
      validateMarketplaceUrl("https://github.com:8443/foo/bar.git", {
        allowNonstandardPort: true,
      }),
    ).not.toThrow();
  });

  test("rejects non-standard port on http even with allowHttp", () => {
    expect(() =>
      validateMarketplaceUrl("http://example.com:8080/x.git", { allowHttp: true }),
    ).toThrow(MarketplaceSecurityError);
  });

  // ── Local path detection ───────────────────────────────────────

  test("isLocalPath detects absolute paths", () => {
    expect(isLocalPath("/tmp/foo")).toBe(true);
    expect(isLocalPath("/Users/x/y")).toBe(true);
  });

  test("isLocalPath detects relative paths", () => {
    expect(isLocalPath("./foo")).toBe(true);
    expect(isLocalPath("../bar")).toBe(true);
    expect(isLocalPath(".")).toBe(true);
    expect(isLocalPath("..")).toBe(true);
  });

  test("isLocalPath rejects URLs", () => {
    expect(isLocalPath("https://github.com/foo/bar.git")).toBe(false);
    expect(isLocalPath("file:///tmp/x")).toBe(false);
    expect(isLocalPath("")).toBe(false);
  });
});
