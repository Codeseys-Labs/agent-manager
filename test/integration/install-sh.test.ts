import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { type TestDir, createTestDir } from "../helpers/tmp";

// End-to-end tests for install.sh's integrity behaviour (Wave 4 / P1-F).
// We stand up a local HTTP server that mimics the GitHub release layout
// (`/releases/download/v<ver>/<artifact>` + `checksums.sha256`) and point the
// installer at it via AM_BASE_URL. This exercises the real shell verification
// path (anchored grep + fail-closed branches) without touching the network.
//
// Requires `sha256sum` or `shasum` on the runner (the installer needs one and
// the success-path assertions are meaningless without it). Bun's test runner
// is invoked from environments that have coreutils, so we assert its presence
// rather than skipping silently.

setDefaultTimeout(30_000);

const INSTALL_SH = join(import.meta.dir, "../..", "install.sh");
const VERSION = "9.9.9";

// install.sh detects the host platform; build the artifact names it will request.
function platformArtifacts(): { am: string; shell: string } {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (os === "windows") {
    return { am: "am-windows-x64.exe", shell: "am-acp-shell-windows-x64.exe" };
  }
  return { am: `am-${os}-${arch}`, shell: `am-acp-shell-${os}-${arch}` };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface FakeRelease {
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
}

// Serve a fake release. `checksumsOverride` lets a test corrupt or truncate the
// manifest; `bodies` maps artifact filename -> file content.
function startFakeRelease(opts: {
  bodies: Record<string, string>;
  checksums: string;
}): FakeRelease {
  const prefix = `/releases/download/v${VERSION}/`;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith(prefix)) {
        return new Response("not found", { status: 404 });
      }
      const name = url.pathname.slice(prefix.length);
      if (name === "checksums.sha256") {
        return new Response(opts.checksums);
      }
      const body = opts.bodies[name];
      if (body === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(body);
    },
  });
  return { server, baseUrl: `http://localhost:${server.port}` };
}

async function runInstall(
  release: FakeRelease,
  prefix: string,
  extraArgs: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(
    ["sh", INSTALL_SH, "--version", VERSION, "--prefix", prefix, ...extraArgs],
    {
      env: {
        ...process.env,
        AM_BASE_URL: release.baseUrl,
        AM_API_URL: release.baseUrl, // not hit when --version is given
        AM_INSECURE: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, code: await proc.exited };
}

let testDir: TestDir;

beforeEach(async () => {
  testDir = await createTestDir("am-install-sh-");
});

afterEach(async () => {
  await testDir.cleanup();
});

describe("install.sh integrity (P1-F)", () => {
  // Windows runners use the .exe + a different shell story; install.sh is a
  // POSIX script meant for macOS/Linux. Skip the e2e shell run on win32.
  const maybe = process.platform === "win32" ? test.skip : test;

  maybe("happy path: installs both binaries when checksums match", async () => {
    const { am, shell } = platformArtifacts();
    const amBody = "FAKE_AM_BINARY_CONTENT";
    const shellBody = "FAKE_ACP_SHELL_BINARY_CONTENT";
    const checksums = `${sha256(amBody)}  ${am}\n${sha256(shellBody)}  ${shell}\n`;
    const release = startFakeRelease({
      bodies: { [am]: amBody, [shell]: shellBody },
      checksums,
    });
    try {
      const prefix = join(testDir.path, "out");
      const { stdout, code } = await runInstall(release, prefix, []);
      expect(code).toBe(0);
      expect(stdout).toContain("Checksum OK");
      // Both binaries land in <prefix>/bin/.
      const amDest = process.platform === "win32" ? "out/bin/am.exe" : "out/bin/am";
      const shellDest =
        process.platform === "win32" ? "out/bin/am-acp-shell.exe" : "out/bin/am-acp-shell";
      expect(await testDir.exists(amDest)).toBe(true);
      expect(await testDir.exists(shellDest)).toBe(true);
      expect(await testDir.read(amDest)).toBe(amBody);
      expect(await testDir.read(shellDest)).toBe(shellBody);
    } finally {
      release.server.stop(true);
    }
  });

  maybe("anchored grep: am picks its own checksum, not am-acp-shell's", async () => {
    // Regression for M1: an unanchored substring grep for "am-linux-x64" would
    // also match "am-acp-shell-linux-x64". Give the two binaries DIFFERENT
    // content; if the installer grabbed the wrong checksum line the `am`
    // verification would fail. Order the manifest so the shell line comes first.
    const { am, shell } = platformArtifacts();
    const amBody = "AM_CONTENT_DISTINCT";
    const shellBody = "SHELL_CONTENT_DISTINCT";
    const checksums = `${sha256(shellBody)}  ${shell}\n${sha256(amBody)}  ${am}\n`;
    const release = startFakeRelease({
      bodies: { [am]: amBody, [shell]: shellBody },
      checksums,
    });
    try {
      const prefix = join(testDir.path, "out");
      const { stdout, code } = await runInstall(release, prefix, []);
      expect(code).toBe(0);
      // Two "Checksum OK" lines = both binaries verified against the RIGHT hash.
      expect(stdout.match(/Checksum OK/g)?.length).toBe(2);
    } finally {
      release.server.stop(true);
    }
  });

  maybe("fail-closed: corrupted binary fails checksum verification", async () => {
    const { am, shell } = platformArtifacts();
    const amBody = "GENUINE_AM";
    const shellBody = "GENUINE_SHELL";
    // Manifest lists a hash for `am` that does NOT match the served body.
    const checksums = `${sha256("SOMETHING_ELSE")}  ${am}\n${sha256(shellBody)}  ${shell}\n`;
    const release = startFakeRelease({
      bodies: { [am]: amBody, [shell]: shellBody },
      checksums,
    });
    try {
      const prefix = join(testDir.path, "out");
      const { stderr, code } = await runInstall(release, prefix, []);
      expect(code).not.toBe(0);
      expect(stderr).toContain("Checksum verification failed");
    } finally {
      release.server.stop(true);
    }
  });

  maybe("fail-closed: artifact missing from manifest refuses to install", async () => {
    // The `am` line is absent from checksums.sha256 entirely. Pre-fix this
    // installed unverified; now it must exit non-zero.
    const { am, shell } = platformArtifacts();
    const checksums = `${sha256("SHELL_ONLY")}  ${shell}\n`;
    const release = startFakeRelease({
      bodies: { [am]: "AM_BODY", [shell]: "SHELL_ONLY" },
      checksums,
    });
    try {
      const prefix = join(testDir.path, "out");
      const { stderr, code } = await runInstall(release, prefix, []);
      expect(code).not.toBe(0);
      expect(stderr).toContain("not found in checksums file");
      expect(stderr).toContain("refusing to install unverified");
    } finally {
      release.server.stop(true);
    }
  });

  maybe("--insecure: missing-from-manifest artifact installs with a warning", async () => {
    const { am, shell } = platformArtifacts();
    const checksums = `${sha256("SHELL_ONLY")}  ${shell}\n`;
    const release = startFakeRelease({
      bodies: { [am]: "AM_BODY", [shell]: "SHELL_ONLY" },
      checksums,
    });
    try {
      const prefix = join(testDir.path, "out");
      const { stderr, code } = await runInstall(release, prefix, ["--insecure"]);
      expect(code).toBe(0);
      expect(stderr).toContain("installing UNVERIFIED");
      const amDest = "out/bin/am";
      expect(await testDir.exists(amDest)).toBe(true);
    } finally {
      release.server.stop(true);
    }
  });

  test("--dry-run reports checksum verification by default", async () => {
    const proc = Bun.spawn(["sh", INSTALL_SH, "--dry-run", "--version", VERSION], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("Would verify checksums");
    expect(stdout).not.toContain("Would SKIP checksum");
  });

  test("--dry-run --insecure reports skipped verification", async () => {
    const proc = Bun.spawn(["sh", INSTALL_SH, "--dry-run", "--insecure", "--version", VERSION], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("Would SKIP checksum verification");
  });
});
