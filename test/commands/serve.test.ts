import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { serveCommand } from "../../src/commands/serve";

describe("serve command", () => {
  test("meta name is 'serve'", () => {
    expect(serveCommand.meta?.name).toBe("serve");
  });

  test("meta has description", () => {
    expect(serveCommand.meta?.description).toBeTruthy();
    expect(typeof serveCommand.meta?.description).toBe("string");
  });

  test("port arg exists with default '3456'", () => {
    expect(serveCommand.args?.port).toBeDefined();
    expect(serveCommand.args?.port?.default).toBe("3456");
  });

  describe("port validation", () => {
    let errSpy: ReturnType<typeof spyOn>;
    let logSpy: ReturnType<typeof spyOn>;
    let originalExitCode: number | undefined;

    beforeEach(() => {
      errSpy = spyOn(console, "error").mockImplementation(() => {});
      logSpy = spyOn(console, "log").mockImplementation(() => {});
      originalExitCode = process.exitCode;
      process.exitCode = undefined;
    });

    afterEach(() => {
      errSpy.mockRestore();
      logSpy.mockRestore();
      process.exitCode = originalExitCode;
    });

    test("NaN port sets exitCode = 1", async () => {
      await serveCommand.run?.({ args: { port: "abc" } } as any);
      expect(process.exitCode).toBe(1);
      expect(errSpy).toHaveBeenCalledWith("error: Invalid port number");
    });

    test("port 0 sets exitCode = 1", async () => {
      await serveCommand.run?.({ args: { port: "0" } } as any);
      expect(process.exitCode).toBe(1);
    });

    test("port 65536 sets exitCode = 1", async () => {
      await serveCommand.run?.({ args: { port: "65536" } } as any);
      expect(process.exitCode).toBe(1);
    });

    test("negative port sets exitCode = 1", async () => {
      await serveCommand.run?.({ args: { port: "-1" } } as any);
      expect(process.exitCode).toBe(1);
    });
  });
});
