/**
 * agent-enable-shim.test.ts — ADR-0033 Phase B.
 *
 * Covers:
 *   - Happy path: `am agent enable-shim aider --yes` writes the shim command
 *     to config.toml under [agents.aider.adapters.acp.command].
 *   - Unknown shim name exits 1 with a helpful error.
 *   - Without --yes (and non-JSON) prints the caveat and exits 2 without
 *     touching config.toml.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tryReadConfig } from "../../src/core/config";
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
    process.env.AM_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    restoreConsole();
    if (dir) await dir.cleanup();
    process.env.AM_CONFIG_DIR = undefined;
    // Reset exit code so a --yes-required failure in one test doesn't leak.
    process.exitCode = 0;
  });

  test("happy path — aider --yes writes adapters.acp.command to config.toml", async () => {
    const { agentEnableShimCommand } = await import(
      "../../src/commands/agent-enable-shim"
    );
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

    const config = await tryReadConfig(join(configDir, "config.toml"));
    expect(config).not.toBeNull();
    const aider = config?.agents?.aider as unknown as
      | {
          adapters?: { acp?: { command?: string } };
        }
      | undefined;
    expect(aider).toBeDefined();
    expect(aider?.adapters?.acp?.command).toBe("am-acp-shell aider");
  });

  test("unknown shim name exits 1 and does not write config", async () => {
    const { agentEnableShimCommand } = await import(
      "../../src/commands/agent-enable-shim"
    );
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
    const { agentEnableShimCommand } = await import(
      "../../src/commands/agent-enable-shim"
    );
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
    const { agentEnableShimCommand } = await import(
      "../../src/commands/agent-enable-shim"
    );
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
