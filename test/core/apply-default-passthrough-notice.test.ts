/**
 * P1-H — default-profile passthrough signpost.
 *
 * `buildResolvedConfig` only narrows the catalog when a matching
 * `[profiles.<name>]` exists. When no profile is active (the fail-open
 * "default" passthrough), applyResolved fans out the ENTIRE catalog to every
 * detected tool with no signposting. This test locks the advisory behaviour:
 *
 *   - unscoped catalog + something to apply  -> notice present (and printed to
 *     stderr, never stdout, so it can't pollute MCP/web JSON payloads)
 *   - a real `[profiles.<name>]` scopes apply -> no notice
 *   - empty catalog                          -> no notice (nothing to fan out)
 *
 * The notice is advisory only — it must not change the exit/result status.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { applyResolved } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import { type TestDir, createTestDir } from "../helpers/tmp";

/** Capture process.stderr.write output for the duration of `fn`. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stderr: buf };
  } finally {
    process.stderr.write = original;
  }
}

describe("applyResolved — default-passthrough notice (P1-H)", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-apply-passthrough-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
  });

  afterEach(async () => {
    if (originalEnv === undefined) process.env.AM_CONFIG_DIR = undefined;
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("unscoped catalog emits a notice and prints it to stderr", async () => {
    if (!dir) throw new Error("test setup failed");
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
        tavily: { command: "bunx", args: ["tavily-mcp"], transport: "stdio", enabled: true },
      },
    });

    // `target` forces exactly one adapter regardless of host detection, so the
    // notice is deterministic (2 servers × 1 tool).
    const { result, stderr } = await captureStderr(() =>
      applyResolved(dir!.path, { dryRun: true, target: "claude-code" }),
    );

    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("applying all 2 servers to 1 tool");
    expect(result.notices[0]).toContain("define a profile to scope this");
    // Advisory only — must not flip success.
    expect(result.failed).toHaveLength(0);
    // Printed to stderr (not the JSON-carrying stdout).
    expect(stderr).toContain("info: applying all 2 servers to 1 tool");
  });

  test("a matching profile scopes apply and suppresses the notice", async () => {
    if (!dir) throw new Error("test setup failed");
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "work" },
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
        tavily: { command: "bunx", args: ["tavily-mcp"], transport: "stdio", enabled: true },
      },
      profiles: {
        work: { servers: ["fetch"] },
      },
    });

    const { result, stderr } = await captureStderr(() =>
      applyResolved(dir!.path, { dryRun: true, target: "claude-code" }),
    );

    expect(result.notices).toHaveLength(0);
    expect(stderr).not.toContain("define a profile to scope this");
  });

  test("explicit --profile that matches a profile suppresses the notice", async () => {
    if (!dir) throw new Error("test setup failed");
    await writeConfig(join(dir.path, "config.toml"), {
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
      },
      profiles: {
        narrow: { servers: ["fetch"] },
      },
    });

    const { result } = await captureStderr(() =>
      applyResolved(dir!.path, { dryRun: true, target: "claude-code", profile: "narrow" }),
    );

    expect(result.notices).toHaveLength(0);
  });

  test("empty catalog produces no notice (nothing to fan out)", async () => {
    if (!dir) throw new Error("test setup failed");
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
    });

    const { result, stderr } = await captureStderr(() =>
      applyResolved(dir!.path, { dryRun: true, target: "claude-code" }),
    );

    expect(result.notices).toHaveLength(0);
    expect(stderr).not.toContain("define a profile to scope this");
  });
});
