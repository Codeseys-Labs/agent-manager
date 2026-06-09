/**
 * Apply pipeline URL-credential refusal (issue #3 problem 2, 2026-05-03).
 *
 * The guard lives in `applyResolved` BEFORE any adapter.export runs. It
 * scans the post-env-interpolation `resolved.servers` for URLs carrying
 * credential-bearing query params (?tavilyApiKey=…, ?api_key=…) and
 * throws if any are found. The throw aborts the whole apply — catching
 * one leak late is worse than catching all of them early.
 *
 * What this test pins:
 *   - A config with a naked tavilyApiKey in the command URL causes
 *     applyResolved to throw with the expected error shape.
 *   - The error mentions the offending server name + suggests ${VAR}.
 *   - A config with `${TAVILY_API_KEY}` as the placeholder is NOT
 *     flagged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { applyResolved } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("applyResolved — URL-credential refusal (issue #3)", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-apply-urlcred-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
  });

  afterEach(async () => {
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("refuses to apply when a server URL carries a plaintext API key", async () => {
    if (!dir) throw new Error("test setup failed");
    await writeConfig(join(dir.path, "config.toml"), {
      servers: {
        tavily: {
          command: "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-FAKEFIXTURE1234567890",
          transport: "streamable-http",
          enabled: true,
        },
      },
    });

    await expect(applyResolved(dir.path, { dryRun: true })).rejects.toThrow(/URL credential/i);
  });

  test("error message names the offending server", async () => {
    if (!dir) throw new Error("test setup failed");
    await writeConfig(join(dir.path, "config.toml"), {
      servers: {
        my_exa: {
          command: "https://mcp.exa.ai/mcp/?exaApiKey=exa-abcdefghijklmnopqrst1234567890",
          transport: "streamable-http",
          enabled: true,
        },
      },
    });

    try {
      await applyResolved(dir.path, { dryRun: true });
      expect.unreachable("apply must throw on URL credential");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("my_exa");
      expect(msg).toContain("exaApiKey");
      // Must NEVER leak the raw value.
      expect(msg).not.toContain("exa-abcdefghijklmnopqrst1234567890");
    }
  });

  test("passes when the URL uses ${VAR} placeholder (legitimate interpolation)", async () => {
    if (!dir) throw new Error("test setup failed");
    await writeConfig(join(dir.path, "config.toml"), {
      servers: {
        tavily: {
          command: "https://mcp.tavily.com/mcp/?tavilyApiKey=$${TAVILY_API_KEY}",
          transport: "streamable-http",
          enabled: true,
        },
      },
    });
    // Double-$$ is how TOML preserves `${...}` literal through the
    // interpolation pass when no matching env var exists. In practice the
    // user would set TAVILY_API_KEY and expect the resolved value to pass
    // the check (or they'd use AM_SECRET encryption). For this test we
    // just assert the placeholder form doesn't get rejected.
    await expect(applyResolved(dir.path, { dryRun: true })).resolves.toBeTruthy();
  });

  test("passes for stdio-only servers (no URL to scan)", async () => {
    if (!dir) throw new Error("test setup failed");
    await writeConfig(join(dir.path, "config.toml"), {
      servers: {
        context7: {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          transport: "stdio",
          enabled: true,
        },
      },
    });
    await expect(applyResolved(dir.path, { dryRun: true })).resolves.toBeTruthy();
  });
});
