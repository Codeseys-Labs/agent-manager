/**
 * P1-H — default-profile passthrough signpost.
 *
 * `buildResolvedConfig` only narrows the catalog when a matching
 * `[profiles.<name>]` exists. When no profile is active (the fail-open
 * "default" passthrough), applyResolved fans out the ENTIRE catalog to every
 * detected tool with no signposting. This test locks the advisory behaviour:
 *
 *   - unscoped catalog + something to apply  -> notice returned in result.notices
 *   - a real `[profiles.<name>]` scopes apply -> no notice
 *   - empty catalog                          -> no notice (nothing to fan out)
 *
 * The controller is I/O-free (ADR-0040): it RETURNS notices in
 * `ApplyResolvedResult.notices`; callers (the CLI via info(), MCP/web via their
 * JSON payloads) decide how to surface them. The notice is advisory only — it
 * must not change the exit/result status.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { applyResolved } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("applyResolved — default-passthrough notice (P1-H)", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-apply-passthrough-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
  });

  afterEach(async () => {
    // Restore (or delete) AM_CONFIG_DIR — assigning `undefined` would coerce to
    // the string "undefined", so remove the key when there was no original.
    // `Reflect.deleteProperty` avoids Biome's noDelete rule while genuinely
    // unsetting the var (the bug an `= undefined` assignment would reintroduce).
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("unscoped catalog returns a passthrough notice", async () => {
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
    const result = await applyResolved(dir.path, { dryRun: true, target: "claude-code" });

    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("applying all 2 servers to 1 tool");
    expect(result.notices[0]).toContain("define a profile to scope this");
    // Advisory only — must not flip success.
    expect(result.failed).toHaveLength(0);
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

    const result = await applyResolved(dir.path, { dryRun: true, target: "claude-code" });

    expect(result.notices).toHaveLength(0);
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

    const result = await applyResolved(dir.path, {
      dryRun: true,
      target: "claude-code",
      profile: "narrow",
    });

    expect(result.notices).toHaveLength(0);
  });

  test("empty catalog produces no notice (nothing to fan out)", async () => {
    if (!dir) throw new Error("test setup failed");
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
    });

    const result = await applyResolved(dir.path, { dryRun: true, target: "claude-code" });

    expect(result.notices).toHaveLength(0);
  });
});
