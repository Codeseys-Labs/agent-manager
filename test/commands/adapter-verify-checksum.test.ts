/**
 * Security regression: `am adapter verify` must verify the pinned checksum
 * BEFORE spawning the adapter binary.
 *
 * H6 (adversarial review): `verifySubcommand` called
 * `CommunityAdapterProxy.create(config.command)` with NO preceding
 * `verifyChecksum`. The loader (loader.ts:132) verifies the pin before every
 * spawn, but `verify` — the very command the loader's error message tells users
 * to run to "inspect the adapter" — would happily execute tampered bytes. The
 * documented recovery path therefore ran untrusted/tampered code.
 *
 * The fix: BEFORE spawning, verify the on-disk bytes against the recorded pin
 * (the same `verifyChecksum` call the loader makes). On mismatch, REFUSE: no
 * spawn, emit a verification-error result (status:"error", checksum-mismatch
 * message), exit nonzero. A clean adapter still verifies and spawns as before.
 *
 * Also covers a static `--no-exec` mode that only verifies the checksum and
 * reports without spawning.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { runCommand } from "citty";
import { killAllProxies, setCommunityAdapterConfig } from "../../src/adapters/community/loader.ts";
import { adapterCommand } from "../../src/commands/adapter.ts";
import { type TestDir, createTestDir } from "../helpers/tmp.ts";

/**
 * Compute "sha256:<hex>" of a file on disk. Mirrors
 * src/commands/adapter.ts::computeChecksum so fixtures match the pin format.
 */
async function hashFile(path: string): Promise<string> {
  const data = await Bun.file(path).arrayBuffer();
  return `sha256:${createHash("sha256").update(Buffer.from(data)).digest("hex")}`;
}

// A minimal JSON-RPC adapter the verify path can spawn + validate. Written into
// the sandbox so the test can tamper the bytes on disk. The spawn-tripwire path
// is BAKED INTO the script body (not passed via env) because the proxy scrubs
// the child env via sandboxEnv() — an env-var tripwire would be stripped and
// could not distinguish "never spawned" from "spawned but env removed". A file
// written from a hardcoded absolute path proves the binary actually executed.
function adapterBody(tripwirePath: string): string {
  return `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
// Spawn tripwire: if the binary runs at all, it leaves a mark. A passing
// "refuses to spawn on tamper" test proves this file was never touched.
try { appendFileSync(${JSON.stringify(tripwirePath)}, "spawned\\n"); } catch {}
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const { id, method } = JSON.parse(line);
    let result;
    switch (method) {
      case "adapter/initialize":
        result = { protocolVersion: "1.0", adapterVersion: "0.1.0" };
        break;
      case "adapter/meta":
        result = { name: "verifytest", displayName: "Verify Test", version: "0.1.0", capabilities: [] };
        break;
      case "adapter/detect":
        result = { installed: true, version: "1.0.0" };
        break;
      default:
        result = {};
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
  } catch {}
});
`;
}

describe("am adapter verify — checksum gate before spawn (H6)", () => {
  let dir: TestDir;
  let savedConfigDir: string | undefined;
  let tripwirePath: string;

  beforeEach(async () => {
    dir = await createTestDir("am-adapter-verify-checksum-");
    savedConfigDir = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = dir.path;
    // Spawn tripwire file lives in the sandbox; the adapter body appends to it
    // ONLY if it actually runs. We assert it stays absent on the tamper path.
    tripwirePath = join(dir.path, "spawn-tripwire.log");
    killAllProxies();
  });

  afterEach(async () => {
    killAllProxies();
    if (savedConfigDir === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup (assigning undefined coerces to the string "undefined" and poisons later tests)
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = savedConfigDir;
    }
    await dir.cleanup();
    process.exitCode = 0;
  });

  /** Install a git-sourced adapter with a pinned checksum of the current bytes. */
  async function installGitAdapter(): Promise<{ command: string; pin: string }> {
    const command = await dir.write(
      join("adapters", "verifytest", "bin", "adapter.js"),
      adapterBody(tripwirePath),
    );
    await Bun.spawn(["chmod", "+x", command]).exited;
    const pin = await hashFile(command);
    await setCommunityAdapterConfig(dir.path, "verifytest", {
      source: "git+https://example.com/am-adapter-verifytest.git",
      command,
      installed_at: "2026-06-14T00:00:00Z",
      checksum: pin,
    });
    return { command, pin };
  }

  /**
   * Install a `local:` adapter with NO stored checksum — exactly what
   * `am adapter install <local-path>` produces (local sources are the user's
   * own code under active development, so install records no pin). The loader's
   * verifyChecksum warn-and-skips this case; verify --no-exec must not pretend
   * an integrity check happened.
   */
  async function installLocalAdapterNoPin(): Promise<{ command: string }> {
    const command = await dir.write(
      join("adapters", "verifytest", "bin", "adapter.js"),
      adapterBody(tripwirePath),
    );
    await Bun.spawn(["chmod", "+x", command]).exited;
    await setCommunityAdapterConfig(dir.path, "verifytest", {
      source: "local:/some/dev/path/am-adapter-verifytest",
      command,
      installed_at: "2026-06-14T00:00:00Z",
      // NOTE: no `checksum` — local adapters are pinned with none.
    });
    return { command };
  }

  test("REFUSES to spawn a tampered git adapter, exits nonzero, reports the mismatch", async () => {
    const { command, pin } = await installGitAdapter();

    // Attacker overwrites the on-disk binary AFTER install — hash now differs
    // from the recorded pin.
    await Bun.write(command, `${adapterBody(tripwirePath)}\n// TAMPERED PAYLOAD\n`);
    const tamperedHash = await hashFile(command);
    expect(tamperedHash).not.toBe(pin);

    let captured = "";
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      captured += `${a.map(String).join(" ")}\n`;
    };
    try {
      await runCommand(adapterCommand, {
        rawArgs: ["verify", "verifytest", "--json"],
      });
    } finally {
      console.log = origLog;
    }

    // Must have failed (refused).
    expect(process.exitCode).not.toBe(0);

    // The binary must NEVER have been executed: the spawn tripwire stays absent.
    expect(await Bun.file(tripwirePath).exists()).toBe(false);

    // The JSON result must be an error reporting the checksum mismatch.
    const parsed = JSON.parse(captured);
    expect(parsed.adapter).toBe("verifytest");
    expect(parsed.status).toBe("error");
    expect(parsed.error).toContain("checksum mismatch");
  });

  test("a clean (untampered) git adapter still verifies and spawns", async () => {
    await installGitAdapter();

    let captured = "";
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      captured += `${a.map(String).join(" ")}\n`;
    };
    try {
      await runCommand(adapterCommand, {
        rawArgs: ["verify", "verifytest", "--json"],
      });
    } finally {
      console.log = origLog;
    }

    // Clean adapter verifies AND spawns (the proxy handshake ran).
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    expect(await Bun.file(tripwirePath).exists()).toBe(true);

    const parsed = JSON.parse(captured);
    expect(parsed.adapter).toBe("verifytest");
    expect(parsed.status).toBe("ok");
    expect(parsed.meta?.name).toBe("verifytest");
    expect(parsed.detected).toBe(true);
  });

  test("--no-exec verifies the checksum WITHOUT spawning the binary", async () => {
    await installGitAdapter();

    let captured = "";
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      captured += `${a.map(String).join(" ")}\n`;
    };
    try {
      await runCommand(adapterCommand, {
        rawArgs: ["verify", "verifytest", "--no-exec", "--json"],
      });
    } finally {
      console.log = origLog;
    }

    // Static verification succeeds...
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    // ...but the binary was NEVER spawned.
    expect(await Bun.file(tripwirePath).exists()).toBe(false);

    const parsed = JSON.parse(captured);
    expect(parsed.adapter).toBe("verifytest");
    expect(parsed.status).toBe("ok");
    expect(parsed.checksumVerified).toBe(true);
  });

  test("--no-exec on a local adapter with NO pin reports checksumVerified:false, NOT true (seed 38bf)", async () => {
    // Regression: verifyChecksum warn-SKIPS a local adapter that has no stored
    // checksum (returns without throwing). The old --no-exec path then claimed
    // status:"ok", checksumVerified:true even though NOTHING was verified — a
    // lie for a command whose whole job is integrity confirmation.
    await installLocalAdapterNoPin();

    let captured = "";
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      captured += `${a.map(String).join(" ")}\n`;
    };
    try {
      await runCommand(adapterCommand, {
        rawArgs: ["verify", "verifytest", "--no-exec", "--json"],
      });
    } finally {
      console.log = origLog;
    }

    // It does not fail — skipping a local pin is allowed — but it must NEVER
    // be spawned (this is --no-exec).
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    expect(await Bun.file(tripwirePath).exists()).toBe(false);

    const parsed = JSON.parse(captured);
    expect(parsed.adapter).toBe("verifytest");
    // The whole point of the fix: NOT true, because no checksum was verified.
    expect(parsed.checksumVerified).toBe(false);
    // And the status must signal that the check was skipped, not "ok".
    expect(parsed.status).toBe("skipped");
  });

  test("--no-exec on a tampered adapter fails closed without spawning", async () => {
    const { command, pin } = await installGitAdapter();
    await Bun.write(command, `${adapterBody(tripwirePath)}\n// TAMPERED PAYLOAD\n`);
    expect(await hashFile(command)).not.toBe(pin);

    let captured = "";
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      captured += `${a.map(String).join(" ")}\n`;
    };
    try {
      await runCommand(adapterCommand, {
        rawArgs: ["verify", "verifytest", "--no-exec", "--json"],
      });
    } finally {
      console.log = origLog;
    }

    expect(process.exitCode).not.toBe(0);
    expect(await Bun.file(tripwirePath).exists()).toBe(false);

    const parsed = JSON.parse(captured);
    expect(parsed.status).toBe("error");
    expect(parsed.error).toContain("checksum mismatch");
  });
});
