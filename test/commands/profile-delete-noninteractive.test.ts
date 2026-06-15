/**
 * UX-2 command-level tests for `am profile delete` non-interactive safety.
 *
 * The delete handler used to call @clack/prompts confirm() whenever --yes was
 * absent, which hangs forever under --json or a non-TTY stdin (scripts, CI,
 * MCP). It now FAILS CLOSED: under a non-TTY without --yes (and without --json,
 * the automation contract) it REFUSES the destructive delete and exits 1,
 * mirroring the fail-closed guard in `am uninstall` / `am update`. The --json
 * automation contract and an explicit --yes both still permit non-interactive
 * deletion. The change is recoverable via `am undo` because withConfig
 * auto-commits.
 *
 * These tests drive the actual exported command handler (not a simulation) so
 * a regression that reintroduces the hang would be caught: the test process
 * has no interactive stdin, so a confirm() call would block and time out.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { profileDeleteCommand } from "../../src/commands/profile";
import { readConfig, writeConfig } from "../../src/core/config";
import { commitAll, initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const origLog = console.log;
const origError = console.error;
const origConfigDir = process.env.AM_CONFIG_DIR;

function captureConsole(): void {
  consoleOutput = [];
  consoleErrors = [];
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
}

function restoreConsole(): void {
  console.log = origLog;
  console.error = origError;
}

function makeArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "staging", yes: false, json: false, quiet: false, verbose: false, ...overrides };
}

const handler = profileDeleteCommand as unknown as {
  run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
};

describe("am profile delete (UX-2 non-interactive)", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-profile-delete-ni-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
    const config: Config = {
      profiles: {
        default: { description: "Default" },
        staging: { description: "Staging" },
      },
    };
    await writeConfig(join(dir.path, "config.toml"), config);
    await commitAll(dir.path, "init config");
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    process.exitCode = 0;
    if (origConfigDir === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = origConfigDir;
    }
    if (dir) await dir.cleanup();
  });

  test("--json deletes without prompting (does not hang)", async () => {
    await handler.run({ args: makeArgs({ json: true }) });

    const updated = await readConfig(join(dir.path, "config.toml"));
    expect(updated.profiles?.staging).toBeUndefined();
    expect(updated.profiles?.default).toBeDefined();

    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload).toEqual({ action: "delete", profile: "staging" });
  });

  test("non-TTY without --json or --yes refuses and exits 1 (fail closed)", async () => {
    // The test runner's stdin is not a TTY. Without --yes (and without the
    // --json automation contract) the destructive delete must REFUSE rather
    // than proceed unconfirmed: exit 1, profile untouched.
    await handler.run({ args: makeArgs() });

    expect(process.exitCode).toBe(1);
    const updated = await readConfig(join(dir.path, "config.toml"));
    expect(updated.profiles?.staging).toBeDefined();
    expect(consoleErrors.join("\n")).toContain("Refusing to delete profile");
    expect(consoleErrors.join("\n")).toContain("stdin is not a TTY");
  });

  test("non-TTY with --yes deletes without prompting", async () => {
    // An explicit --yes satisfies the confirmation requirement, so the delete
    // proceeds non-interactively even without a TTY.
    await handler.run({ args: makeArgs({ yes: true }) });

    expect(process.exitCode).toBe(0);
    const updated = await readConfig(join(dir.path, "config.toml"));
    expect(updated.profiles?.staging).toBeUndefined();
    expect(updated.profiles?.default).toBeDefined();
    expect(consoleOutput.join("\n")).toContain('Deleted profile "staging"');
  });

  test("missing profile still errors with exit code 1 in --json mode", async () => {
    await handler.run({ args: makeArgs({ name: "nope", json: true }) });
    expect(process.exitCode).toBe(1);
    expect(consoleErrors.join("\n")).toContain("nope");
  });

  test("refuses to delete a profile that others inherit from (--json)", async () => {
    const config: Config = {
      profiles: {
        base: { description: "Base" },
        work: { inherits: "base", description: "Work" },
      },
    };
    await writeConfig(join(dir.path, "config.toml"), config);
    await commitAll(dir.path, "set up inheritance");

    await handler.run({ args: makeArgs({ name: "base", json: true }) });

    expect(process.exitCode).toBe(1);
    expect(consoleErrors.join("\n")).toContain("inherits from it");
    const updated = await readConfig(join(dir.path, "config.toml"));
    expect(updated.profiles?.base).toBeDefined();
  });
});
