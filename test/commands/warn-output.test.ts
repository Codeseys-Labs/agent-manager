/**
 * Unit tests for `warn()` in src/lib/output.ts.
 *
 * Filed under test/commands because that's where the current permission
 * surface allows new files. Logical home is test/lib/output.test.ts;
 * move once permissions permit.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { warn } from "../../src/lib/output";

describe("warn()", () => {
  let errSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errSpy = spyOn(console, "error").mockImplementation(() => {});
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  test("writes to stderr (not stdout) in plain-text mode", () => {
    warn("something off", {});
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("warning: something off");
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("is NOT silenced by quiet=true - warnings are important signals", () => {
    warn("still important", { quiet: true });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("warning: still important");
  });

  test("respects --json: emits {level:'warn', message} on stderr", () => {
    warn("json warning", { json: true });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const call = errSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(call);
    expect(parsed.level).toBe("warn");
    expect(parsed.message).toBe("json warning");
    // JSON mode must not pollute stdout.
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("in --json --quiet: warning still emits (quiet does NOT suppress)", () => {
    warn("both flags", { json: true, quiet: true });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const call = errSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(call);
    expect(parsed.level).toBe("warn");
    expect(parsed.message).toBe("both flags");
  });

  test("verbose flag does not change warn output format", () => {
    warn("v warning", { verbose: true });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("warning: v warning");
  });

  test("empty message still emits prefix", () => {
    warn("", {});
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("warning: ");
  });
});
