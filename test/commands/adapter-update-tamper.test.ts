/**
 * Security regression: `am adapter update` must not launder tampered bytes.
 *
 * H5 (adversarial review): for git/local sources the update path skipped the
 * checksum verification, SPAWNED whatever bytes were on disk, and then re-pinned
 * `computeChecksum(command)` as the new "trusted" checksum. An attacker who could
 * write to the on-disk adapter binary could therefore get their tampered bytes
 * blessed with a fresh pin — the loader would then happily spawn them on every
 * subsequent run.
 *
 * The fix: BEFORE spawning or re-pinning a git/local adapter, verify the existing
 * on-disk bytes against the recorded pin (the same `verifyChecksum` call the
 * loader makes). On mismatch, REFUSE: no spawn, no re-pin, result action
 * "tampered". For unchanged adapters the stored pin must not change.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { runCommand } from "citty";
import {
  getCommunityAdapterConfig,
  killAllProxies,
  setCommunityAdapterConfig,
} from "../../src/adapters/community/loader.ts";
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

// A minimal JSON-RPC adapter the update path can spawn + validate. Written into
// the sandbox so the test can tamper the bytes on disk.
const ADAPTER_BODY = `#!/usr/bin/env bun
import { createInterface } from "node:readline";
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
        result = { name: "tampertest", displayName: "Tamper Test", version: "0.1.0", capabilities: [] };
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

describe("am adapter update — tamper laundering (H5)", () => {
  let dir: TestDir;
  let savedConfigDir: string | undefined;

  beforeEach(async () => {
    dir = await createTestDir("am-adapter-update-tamper-");
    savedConfigDir = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = dir.path;
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
      join("adapters", "tampertest", "bin", "adapter.js"),
      ADAPTER_BODY,
    );
    await Bun.spawn(["chmod", "+x", command]).exited;
    const pin = await hashFile(command);
    await setCommunityAdapterConfig(dir.path, "tampertest", {
      source: "git+https://example.com/am-adapter-tampertest.git",
      command,
      installed_at: "2026-06-14T00:00:00Z",
      checksum: pin,
    });
    return { command, pin };
  }

  test("REFUSES to update a git adapter whose on-disk bytes were tampered, and does NOT re-pin", async () => {
    const { command, pin } = await installGitAdapter();

    // Attacker overwrites the on-disk binary AFTER install — hash now differs
    // from the recorded pin.
    await Bun.write(command, `${ADAPTER_BODY}\n// TAMPERED PAYLOAD\n`);
    const tamperedHash = await hashFile(command);
    expect(tamperedHash).not.toBe(pin);

    await runCommand(adapterCommand, {
      rawArgs: ["update", "tampertest", "--json"],
    });

    // Must have failed (refused).
    expect(process.exitCode).not.toBe(0);

    // The stored pin must be UNCHANGED — the tampered hash must NOT have been
    // blessed as the new trusted checksum.
    const config = await getCommunityAdapterConfig(dir.path, "tampertest");
    expect(config?.checksum).toBe(pin);
    expect(config?.checksum).not.toBe(tamperedHash);
  });

  test("re-pins nothing for an untouched git adapter (pin is stable across update)", async () => {
    const { pin } = await installGitAdapter();

    await runCommand(adapterCommand, {
      rawArgs: ["update", "tampertest", "--json"],
    });

    const config = await getCommunityAdapterConfig(dir.path, "tampertest");
    // Pin must remain exactly the install-time pin: an unchanged local/git
    // adapter must never silently re-pin a different value.
    expect(config?.checksum).toBe(pin);
  });
});
