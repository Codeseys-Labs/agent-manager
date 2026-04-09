import { describe, expect, test } from "bun:test";
import { AmError, formatError, requireConfig } from "../../src/lib/errors";

describe("AmError", () => {
  test("sets name, message, suggestion, and code", () => {
    const err = new AmError("something broke", "try restarting", "ERR_BROKE");
    expect(err.name).toBe("AmError");
    expect(err.message).toBe("something broke");
    expect(err.suggestion).toBe("try restarting");
    expect(err.code).toBe("ERR_BROKE");
  });

  test("works with only message (no optional fields)", () => {
    const err = new AmError("bare error");
    expect(err.name).toBe("AmError");
    expect(err.message).toBe("bare error");
    expect(err.suggestion).toBeUndefined();
    expect(err.code).toBeUndefined();
  });

  test("is instanceof Error", () => {
    const err = new AmError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AmError);
  });
});

describe("formatError", () => {
  test("AmError with json=true includes error, suggestion, code", () => {
    const err = new AmError("bad config", "run init", "CFG_ERR");
    const result = formatError(err, true);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("bad config");
    expect(parsed.suggestion).toBe("run init");
    expect(parsed.code).toBe("CFG_ERR");
  });

  test("AmError with json=true omits suggestion/code when absent", () => {
    const err = new AmError("bare");
    const result = formatError(err, true);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("bare");
    expect(parsed.suggestion).toBeUndefined();
    expect(parsed.code).toBeUndefined();
  });

  test("AmError with json=false returns human-readable with suggestion", () => {
    const err = new AmError("file missing", "check path");
    const result = formatError(err, false);
    expect(result).toBe("error: file missing\n  suggestion: check path");
  });

  test("AmError with json=false and no suggestion", () => {
    const err = new AmError("file missing");
    const result = formatError(err, false);
    expect(result).toBe("error: file missing");
  });

  test("plain Error with json=true returns JSON with error field", () => {
    const err = new Error("native error");
    const result = formatError(err, true);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("native error");
    expect(parsed.suggestion).toBeUndefined();
  });

  test("plain Error with json=false returns error: prefix", () => {
    const err = new Error("native error");
    const result = formatError(err, false);
    expect(result).toBe("error: native error");
  });

  test("string with json=true wraps in JSON", () => {
    const result = formatError("raw string", true);
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe("raw string");
  });

  test("string with json=false coerces to string", () => {
    const result = formatError("raw string", false);
    expect(result).toBe("error: raw string");
  });
});

describe("requireConfig", () => {
  test("returns value when config is valid", () => {
    const config = { servers: {} };
    // Should not throw
    expect(() => requireConfig(config)).not.toThrow();
  });

  test("throws AmError when config is null", () => {
    expect(() => requireConfig(null)).toThrow(AmError);
    try {
      requireConfig(null);
    } catch (e) {
      expect(e).toBeInstanceOf(AmError);
      expect((e as AmError).message).toBe("Config not found");
      expect((e as AmError).code).toBe("CONFIG_NOT_FOUND");
      expect((e as AmError).suggestion).toContain("am init");
    }
  });

  test("throws AmError when config is undefined", () => {
    expect(() => requireConfig(undefined)).toThrow(AmError);
  });
});
