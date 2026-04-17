import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

describe("am version", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("prints version string", async () => {
    const { versionCommand } = await import("../../src/commands/version");
    await versionCommand.run?.({ args: { json: false, quiet: false } } as any);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/\d+\.\d+\.\d+/);
  });

  test("version string includes semver format", async () => {
    const { versionCommand } = await import("../../src/commands/version");
    await versionCommand.run?.({ args: { json: false, quiet: false } } as any);

    const output = logSpy.mock.calls[0][0] as string;
    // Default dev fallback is "0.0.0-dev"; CI builds pass BUILD_VERSION
    // from package.json. Either way the string must be SemVer-shaped.
    expect(output).toMatch(/^\d+\.\d+\.\d+(-\w+)?$/);
  });
});
