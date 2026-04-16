import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { debug, error, info, output, parsePositiveInt } from "../../src/lib/output";

describe("output()", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("json=true calls console.log with JSON.stringify(data)", () => {
    const data = { servers: ["a", "b"] };
    output(data, { json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
  });

  test("json=false does not call console.log", () => {
    output({ x: 1 }, { json: false });
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("json=false with empty opts does not call console.log", () => {
    output({ x: 1 }, {});
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("info()", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("default opts calls console.log with message", () => {
    info("hello world", {});
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("hello world");
  });

  test("json=true suppresses output", () => {
    info("hello", { json: true });
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("quiet=true suppresses output", () => {
    info("hello", { quiet: true });
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("error()", () => {
  let errSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  test("json=false calls console.error with 'error: msg'", () => {
    error("something failed", { json: false });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("error: something failed");
  });

  test("json=true calls console.error with JSON {error: msg}", () => {
    error("something failed", { json: true });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const call = errSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(call);
    expect(parsed.error).toBe("something failed");
  });
});

describe("debug()", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("verbose=true calls console.log with [debug] prefix", () => {
    debug("trace info", { verbose: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("  [debug] trace info");
  });

  test("verbose=false suppresses output", () => {
    debug("trace info", { verbose: false });
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("verbose undefined suppresses output", () => {
    debug("trace info", {});
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("verbose=true but json=true suppresses output", () => {
    debug("trace info", { verbose: true, json: true });
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("parsePositiveInt()", () => {
  test("parses valid positive integer", () => {
    expect(parsePositiveInt("42", "timeout")).toBe(42);
  });

  test("returns default when value is undefined", () => {
    expect(parsePositiveInt(undefined, "timeout", 300)).toBe(300);
  });

  test("throws when value is undefined and no default", () => {
    expect(() => parsePositiveInt(undefined, "timeout")).toThrow("positive integer");
  });

  test("throws on non-numeric string", () => {
    expect(() => parsePositiveInt("abc", "timeout")).toThrow("positive integer");
  });

  test("throws on negative value", () => {
    expect(() => parsePositiveInt("-1", "timeout")).toThrow("positive integer");
  });

  test("zero should throw — parsePositiveInt requires > 0", () => {
    expect(() => parsePositiveInt("0", "timeout")).toThrow("positive integer");
  });
});
