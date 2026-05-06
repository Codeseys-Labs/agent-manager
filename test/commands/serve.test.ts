import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mintSessionToken, serveCommand } from "../../src/commands/serve";
import { resolveArgs, resolveMeta } from "../helpers/citty";

describe("serve command", () => {
  test("meta name is 'serve'", async () => {
    expect((await resolveMeta(serveCommand))?.name).toBe("serve");
  });

  test("meta has description", async () => {
    expect((await resolveMeta(serveCommand))?.description).toBeTruthy();
    expect(typeof (await resolveMeta(serveCommand))?.description).toBe("string");
  });

  test("port arg exists with default '3456'", async () => {
    const args = await resolveArgs(serveCommand);
    expect(args?.port).toBeDefined();
    expect(args?.port?.default).toBe("3456");
  });

  describe("mintSessionToken (B1 bootstrap)", () => {
    test("returns 32-char lowercase hex (128 bits of entropy)", () => {
      const t = mintSessionToken();
      expect(t).toMatch(/^[0-9a-f]{32}$/);
    });

    test("is cryptographically random — two calls differ", () => {
      // If someone regresses to Math.random or a time-based seed, this would
      // still pass probabilistically, but fixed-value or static-seed bugs
      // would fail hard.
      const a = mintSessionToken();
      const b = mintSessionToken();
      const c = mintSessionToken();
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(a).not.toBe(c);
    });

    test("128 bits of entropy across a batch — no duplicates in 100 samples", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 100; i++) seen.add(mintSessionToken());
      expect(seen.size).toBe(100);
    });
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
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("expected a positive integer"));
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
