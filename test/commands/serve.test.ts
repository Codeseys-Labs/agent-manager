import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  LAN_HOST,
  LOOPBACK_HOST,
  displayHostForBind,
  mintSessionToken,
  serveCommand,
} from "../../src/commands/serve";
import { resolveArgs, resolveMeta, resolveRun } from "../helpers/citty";

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
    let originalExitCode: typeof process.exitCode;

    beforeEach(() => {
      errSpy = spyOn(console, "error").mockImplementation(() => {});
      logSpy = spyOn(console, "log").mockImplementation(() => {});
      originalExitCode = process.exitCode;
      process.exitCode = undefined;
    });

    afterEach(() => {
      errSpy.mockRestore();
      logSpy.mockRestore();
      process.exitCode = originalExitCode === 1 ? 0 : originalExitCode;
    });

    test("NaN port sets exitCode = 1", async () => {
      await resolveRun(serveCommand, { port: "abc" });
      expect(process.exitCode).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("expected a positive integer"));
    });

    test("port 0 sets exitCode = 1", async () => {
      await resolveRun(serveCommand, { port: "0" });
      expect(process.exitCode).toBe(1);
    });

    test("port 65536 sets exitCode = 1", async () => {
      await resolveRun(serveCommand, { port: "65536" });
      expect(process.exitCode).toBe(1);
    });

    test("negative port sets exitCode = 1", async () => {
      await resolveRun(serveCommand, { port: "-1" });
      expect(process.exitCode).toBe(1);
    });
  });

  // ── SEC-BIND: loopback-by-default inbound bind ──────────────────
  //
  // `am serve` must NOT silently bind every interface (0.0.0.0). The default
  // bind is loopback (127.0.0.1, this machine only); LAN exposure is an
  // explicit opt-in. The printed URL must stay accurate to the actual bind.

  describe("displayHostForBind helper", () => {
    test("loopback bind prints localhost", () => {
      expect(displayHostForBind(LOOPBACK_HOST)).toBe("localhost");
    });

    test("wildcard bind prints localhost (canonical local URL)", () => {
      expect(displayHostForBind(LAN_HOST)).toBe("localhost");
    });

    test("explicit interface bind prints that interface verbatim", () => {
      expect(displayHostForBind("192.168.1.50")).toBe("192.168.1.50");
    });

    test("LOOPBACK_HOST is 127.0.0.1, LAN_HOST is 0.0.0.0", () => {
      expect(LOOPBACK_HOST).toBe("127.0.0.1");
      expect(LAN_HOST).toBe("0.0.0.0");
    });
  });

  describe("serve bind hostname", () => {
    let errSpy: ReturnType<typeof spyOn>;
    let logSpy: ReturnType<typeof spyOn>;
    let serveSpy: ReturnType<typeof spyOn>;
    let originalExitCode: typeof process.exitCode;
    let captured: { hostname?: string; port?: number } | undefined;

    beforeEach(() => {
      captured = undefined;
      errSpy = spyOn(console, "error").mockImplementation(() => {});
      logSpy = spyOn(console, "log").mockImplementation(() => {});
      originalExitCode = process.exitCode;
      process.exitCode = undefined;
      // Capture the actual Bun.serve bind options without opening a socket.
      serveSpy = spyOn(Bun, "serve").mockImplementation((opts: any) => {
        captured = { hostname: opts?.hostname, port: opts?.port };
        return { stop() {}, port: opts?.port, hostname: opts?.hostname } as any;
      });
    });

    afterEach(() => {
      errSpy.mockRestore();
      logSpy.mockRestore();
      serveSpy.mockRestore();
      process.exitCode = originalExitCode === 1 ? 0 : originalExitCode;
    });

    test("default bind is loopback (127.0.0.1), NOT 0.0.0.0", async () => {
      await resolveRun(serveCommand, { port: "3456", bridge: false, lan: false });
      expect(captured?.hostname).toBe("127.0.0.1");
      expect(captured?.hostname).not.toBe("0.0.0.0");
      // Printed URL must match the bind (loopback → localhost).
      const printed = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(printed).toContain("http://localhost:3456/?token=");
      // No LAN warning when bound to loopback.
      expect(printed).not.toContain("reachable from other machines");
    });

    test("--lan opts into wildcard bind (0.0.0.0) and warns", async () => {
      await resolveRun(serveCommand, { port: "3456", bridge: false, lan: true });
      expect(captured?.hostname).toBe("0.0.0.0");
      const printed = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      // URL stays accurate (localhost is the dialable local form for wildcard).
      expect(printed).toContain("http://localhost:3456/?token=");
      // LAN exposure is loudly warned.
      expect(printed).toContain("reachable from other machines");
    });

    test("--host wins over --lan and is printed verbatim", async () => {
      await resolveRun(serveCommand, {
        port: "3456",
        bridge: false,
        lan: true,
        host: "192.168.1.50",
      });
      expect(captured?.hostname).toBe("192.168.1.50");
      const printed = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
      expect(printed).toContain("http://192.168.1.50:3456/?token=");
      expect(printed).toContain("reachable from other machines");
    });

    test("host arg exists; default is undefined (loopback resolved in run)", async () => {
      const args = await resolveArgs(serveCommand);
      expect(args?.host).toBeDefined();
      expect(args?.lan).toBeDefined();
      expect(args?.lan?.default).toBe(false);
    });
  });
});
