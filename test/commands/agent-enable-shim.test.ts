/**
 * agent-enable-shim.test.ts — ADR-0033 Phase B.
 *
 * Covers:
 *   - Happy path: `am agent enable-shim aider --yes` writes the shim command
 *     to config.toml under [agents.aider.acp.command] (the path resolveAgent
 *     actually reads — REV-4 CRIT-1 fix).
 *   - Unknown shim name exits 1 with a helpful error.
 *   - Without --yes (and non-JSON) prints the caveat and exits 2 without
 *     touching config.toml.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tryReadConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import { type TestDir, createTestDir } from "../helpers/tmp";

let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const origLog = console.log;
const origError = console.error;

function resetConsole() {
  consoleOutput = [];
  consoleErrors = [];
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
}

function restoreConsole() {
  console.log = origLog;
  console.error = origError;
}

describe("am agent enable-shim", () => {
  let dir: TestDir;
  let configDir: string;

  beforeEach(async () => {
    resetConsole();
    dir = await createTestDir("am-enable-shim-");
    configDir = dir.path;
    // withConfig() will try to commitAll() after a successful write. Without
    // a git repo that throws. Init one so the tests exercise the real code
    // path (lock → write → commit).
    await initRepo(configDir);
    process.env.AM_CONFIG_DIR = configDir;
    // Clear any exitCode leaked from prior test files — bun:test shares the
    // process, and a preceding test that sets process.exitCode = 1 (e.g.
    // the tier-filter invalid-name test in agents.test.ts) would poison our
    // happy-path assertions otherwise.
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    if (dir) await dir.cleanup();
    Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    // Reset exit code so a --yes-required failure in one test doesn't leak.
    process.exitCode = 0;
  });

  test("happy path — aider --yes writes acp.command and resolveAgent returns it", async () => {
    const { agentEnableShimCommand } = await import("../../src/commands/agent-enable-shim");
    await agentEnableShimCommand.run!({
      args: {
        _: ["enable-shim", "aider"],
        name: "aider",
        yes: true,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      data: undefined,
      rawArgs: [],
      cmd: agentEnableShimCommand,
    } as any);

    expect(process.exitCode ?? 0).toBe(0);

    // REV-4 CRIT-1 regression guard: assert both the write path AND the
    // resolution path. The prior test checked only `adapters.acp.command`,
    // which nothing reads — enable-shim "succeeded" but am run aider still
    // hit the tier-3 refusal.
    const config = await tryReadConfig(join(configDir, "config.toml"));
    expect(config).not.toBeNull();
    const aider = config?.agents?.aider as unknown as
      | { acp?: { command?: string }; shim_enabled?: boolean }
      | undefined;
    expect(aider).toBeDefined();
    expect(aider?.shim_enabled).toBe(true);
    expect(aider?.acp?.command).toBe("am-acp-shell aider");

    // End-to-end: resolveAgent (the function `am run` actually calls) must
    // return the shim command, not the tier-2 built-in with command: "".
    const { resolveAgent } = await import("../../src/core/agent-registry");
    const resolved = resolveAgent("aider", config ?? undefined);
    expect(resolved).not.toBeNull();
    expect(resolved?.acp?.command).toBe("am-acp-shell aider");
    expect(resolved?.source).toBe("config");
    expect(resolved?.runnable).toBe(true);
  });

  test("unknown shim name exits 1 and does not write config", async () => {
    const { agentEnableShimCommand } = await import("../../src/commands/agent-enable-shim");
    await agentEnableShimCommand.run!({
      args: {
        _: ["enable-shim", "nonexistent-agent"],
        name: "nonexistent-agent",
        yes: true,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      data: undefined,
      rawArgs: [],
      cmd: agentEnableShimCommand,
    } as any);

    expect(process.exitCode).toBe(1);
    const joined = consoleErrors.join("\n");
    expect(joined).toMatch(/Unknown shim|nonexistent-agent/i);
    const config = await tryReadConfig(join(configDir, "config.toml"));
    // No config means we never wrote one.
    expect(config).toBeNull();
  });

  test("without --yes (non-JSON) prints caveat, exits 2, leaves config untouched", async () => {
    const { agentEnableShimCommand } = await import("../../src/commands/agent-enable-shim");
    await agentEnableShimCommand.run!({
      args: {
        _: ["enable-shim", "aider"],
        name: "aider",
        yes: false,
        json: false,
        quiet: false,
        verbose: false,
      } as any,
      data: undefined,
      rawArgs: [],
      cmd: agentEnableShimCommand,
    } as any);

    expect(process.exitCode).toBe(2);
    const joined = consoleOutput.join("\n");
    // The caveat text includes the phrase "trust posture" (from ADR-0033).
    expect(joined).toMatch(/trust posture/i);
    // Should not have enabled the shim yet.
    const config = await tryReadConfig(join(configDir, "config.toml"));
    expect(config?.agents?.aider).toBeUndefined();
  });

  test("without --yes in --json mode errors with the scripting hint, exits 2", async () => {
    const { agentEnableShimCommand } = await import("../../src/commands/agent-enable-shim");
    await agentEnableShimCommand.run!({
      args: {
        _: ["enable-shim", "aider"],
        name: "aider",
        yes: false,
        json: true,
        quiet: false,
        verbose: false,
      } as any,
      data: undefined,
      rawArgs: [],
      cmd: agentEnableShimCommand,
    } as any);

    expect(process.exitCode).toBe(2);
    const stderr = consoleErrors.join("\n");
    expect(stderr).toMatch(/requires --yes/i);
  });
});
