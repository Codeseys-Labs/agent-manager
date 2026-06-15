/**
 * TLS-enforcement tests for the registry client (W-m4-tls-enforce).
 *
 * AM_REGISTRY_URL is attacker-influenceable env. A cleartext http:// (or any
 * non-https) base URL silently downgrades every registry fetch to a
 * MITM-able channel. getBaseUrl() must FAIL CLOSED: reject any non-https
 * scheme unless the host is loopback or the operator explicitly opts in via
 * AM_REGISTRY_ALLOW_HTTP=1.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getBaseUrl } from "../../src/registry/client";

describe("registry/client getBaseUrl — TLS enforcement", () => {
  beforeEach(() => {
    Reflect.deleteProperty(process.env, "AM_REGISTRY_URL");
    Reflect.deleteProperty(process.env, "AM_REGISTRY_ALLOW_HTTP");
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "AM_REGISTRY_URL");
    Reflect.deleteProperty(process.env, "AM_REGISTRY_ALLOW_HTTP");
  });

  test("default base URL (no env) is the https registry", () => {
    expect(getBaseUrl()).toBe("https://registry.modelcontextprotocol.io");
  });

  test("accepts an https:// override", () => {
    process.env.AM_REGISTRY_URL = "https://registry.example.com";
    expect(getBaseUrl()).toBe("https://registry.example.com");
  });

  test("REJECTS a cleartext http:// override (MITM downgrade)", () => {
    process.env.AM_REGISTRY_URL = "http://evil.example";
    expect(() => getBaseUrl()).toThrow(/AM_REGISTRY_URL/);
    expect(() => getBaseUrl()).toThrow(/http/);
  });

  test("REJECTS a non-http(s) scheme (e.g. ftp://)", () => {
    process.env.AM_REGISTRY_URL = "ftp://evil.example/registry";
    expect(() => getBaseUrl()).toThrow(/AM_REGISTRY_URL/);
  });

  test("REJECTS a malformed URL", () => {
    process.env.AM_REGISTRY_URL = "not a url";
    expect(() => getBaseUrl()).toThrow(/AM_REGISTRY_URL/);
  });

  test("allows http://localhost (loopback dev registry)", () => {
    process.env.AM_REGISTRY_URL = "http://localhost:8080";
    expect(getBaseUrl()).toBe("http://localhost:8080");
  });

  test("allows http://127.0.0.1 (loopback dev registry)", () => {
    process.env.AM_REGISTRY_URL = "http://127.0.0.1:3000";
    expect(getBaseUrl()).toBe("http://127.0.0.1:3000");
  });

  test("allows http://[::1] (IPv6 loopback)", () => {
    process.env.AM_REGISTRY_URL = "http://[::1]:8080";
    expect(getBaseUrl()).toBe("http://[::1]:8080");
  });

  test("allows a non-loopback http:// only with AM_REGISTRY_ALLOW_HTTP=1 opt-in", () => {
    process.env.AM_REGISTRY_URL = "http://internal-registry.corp";
    expect(() => getBaseUrl()).toThrow(/AM_REGISTRY_URL/);
    process.env.AM_REGISTRY_ALLOW_HTTP = "1";
    expect(getBaseUrl()).toBe("http://internal-registry.corp");
  });

  test("AM_REGISTRY_ALLOW_HTTP does NOT relax non-http(s) schemes", () => {
    process.env.AM_REGISTRY_ALLOW_HTTP = "1";
    process.env.AM_REGISTRY_URL = "ftp://evil.example";
    expect(() => getBaseUrl()).toThrow(/AM_REGISTRY_URL/);
  });
});
