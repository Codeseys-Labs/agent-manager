import { describe, expect, test } from "bun:test";
import { AmError, errorCode, errorMessage, formatError, isNotFound, requireConfig } from "../../src/lib/errors";

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

describe("errorMessage", () => {
  test("extracts message from Error instance", () => {
    expect(errorMessage(new Error("broken"))).toBe("broken");
  });

  test("extracts message from AmError instance", () => {
    expect(errorMessage(new AmError("config failed", "run init"))).toBe("config failed");
  });

  test("coerces non-Error to string", () => {
    expect(errorMessage("raw string error")).toBe("raw string error");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("isNotFound", () => {
  test("returns true for ENOENT error", () => {
    const err = new Error("no such file") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    expect(isNotFound(err)).toBe(true);
  });

  test("returns false for other error codes", () => {
    const err = new Error("permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    expect(isNotFound(err)).toBe(false);
  });

  test("returns false for plain Error without code", () => {
    expect(isNotFound(new Error("generic"))).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isNotFound("ENOENT")).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});

describe("errorCode", () => {
  test("extracts code from Node.js errno error", () => {
    const err = new Error("not found") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    expect(errorCode(err)).toBe("ENOENT");
  });

  test("returns undefined for Error without code", () => {
    expect(errorCode(new Error("generic"))).toBeUndefined();
  });

  test("returns undefined for non-Error values", () => {
    expect(errorCode("string")).toBeUndefined();
    expect(errorCode(42)).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
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
