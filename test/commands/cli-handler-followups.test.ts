/**
 * TEST-1 follow-up — handler-run coverage for the commands the TEST-2 guard
 * (cli-handler-coverage-guard.test.ts) flagged as having no test that invokes
 * their `run()`: init, log, completion, flow, session, adapter, marketplace,
 * and the `secrets` parent's routing.
 *
 * Each test below drives a real command/subcommand `run()` with:
 *   - AM_CONFIG_DIR (and AM_KEY_PATH where relevant) pointed at per-test temp
 *     dirs, so nothing touches the developer's real config or keys;
 *   - console / stdout captured so the JSON or text output is assertable;
 *   - non-interactive flags so no prompt ever blocks.
 *
 * These are deliberately minimal — they assert the handler runs end-to-end and
 * produces its documented shape/exit code, not every branch (the per-command
 * suites and handler-coverage.test.ts cover the deep cases). Their job is to
 * keep the TEST-2 guard green and catch "added a command, forgot a handler
 * test" regressions.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import type { CommandDef } from "citty";

// `init`, `adapter list`, and `session list` all call into real adapter
// detection (getDetectedAdapters / session readers), which probes installed
// IDE CLIs via Bun.spawnSync([<cli>, "--version"]). On a dev box with IDE CLIs
// installed those serialized probes can exceed the 5s default under full-suite
// load (CI runners have none, so they're fast there). 30s gives headroom
// without hiding regressions — mirrors test/commands/import.test.ts.
setDefaultTimeout(30_000);
import { adapterCommand } from "../../src/commands/adapter";
import { completionCommand } from "../../src/commands/completion";
import { flowCommand } from "../../src/commands/flow";
import { initCommand } from "../../src/commands/init";
import { logCommand } from "../../src/commands/log";
import { marketplaceCommand } from "../../src/commands/marketplace";
import { secretsCommand } from "../../src/commands/secrets";
import { sessionCommand } from "../../src/commands/session";
import { writeConfig } from "../../src/core/config";
import { commitAll, initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ── capture ─────────────────────────────────────────────────────
let out: string[] = [];
let err: string[] = [];
const origLog = console.log;
const origError = console.error;
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origConfigDir = process.env.AM_CONFIG_DIR;
const origKeyPath = process.env.AM_KEY_PATH;
const origTTY = process.stdin.isTTY;

function capture(): void {
  out = [];
  err = [];
  console.log = (...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    err.push(a.map(String).join(" "));
  };
  // completion subcommands write directly to stdout.
  // biome-ignore lint/suspicious/noExplicitAny: stdout.write overload
  (process.stdout as any).write = (chunk: any) => {
    out.push(String(chunk));
    return true;
  };
}
function restore(): void {
  console.log = origLog;
  console.error = origError;
  process.stdout.write = origStdoutWrite;
}
function json(): any {
  return JSON.parse(out.join("\n"));
}

/**
 * Invoke a citty command's handler with the given args. The param is
 * `CommandDef<any>` because citty's `CommandDef` is invariant on its args
 * generic, so the concrete `CommandDef<{…}>` exports are not assignable to the
 * bare `CommandDef`.
 */
// biome-ignore lint/suspicious/noExplicitAny: citty CommandDef args generic is invariant
async function run(cmd: CommandDef<any>, args: Record<string, unknown>): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: citty CommandContext is over-strict for tests
  await (cmd as any).run({ args, cmd, rawArgs: [], data: undefined });
}

/** Resolve a subcommand from a parent's `subCommands` map (handles () => Promise and direct refs). */
// biome-ignore lint/suspicious/noExplicitAny: citty CommandDef args generic is invariant
async function sub(parent: CommandDef<any>, name: string): Promise<CommandDef<any>> {
  // biome-ignore lint/suspicious/noExplicitAny: subCommands resolver shape
  const map = (parent as any).subCommands as Record<string, unknown>;
  const entry = map[name];
  const resolved = typeof entry === "function" ? await (entry as () => unknown)() : entry;
  return resolved as CommandDef<any>;
}

const baseArgs = { json: false, quiet: false, verbose: false };

describe("CLI handler-run followups (TEST-1 / keeps TEST-2 green)", () => {
  let dir: TestDir;
  let keyDir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-followups-");
    keyDir = await createTestDir("am-followups-key-");
    process.env.AM_CONFIG_DIR = dir.path;
    process.env.AM_KEY_PATH = join(keyDir.path, "key");
    capture();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restore();
    process.exitCode = 0;
    process.stdin.isTTY = origTTY;
    restoreEnv("AM_CONFIG_DIR", origConfigDir);
    restoreEnv("AM_KEY_PATH", origKeyPath);
    if (dir) await dir.cleanup();
    if (keyDir) await keyDir.cleanup();
  });

  async function initConfigDir(config: Config = { servers: {} }): Promise<string> {
    await initRepo(dir.path);
    await writeConfig(join(dir.path, "config.toml"), config);
    await commitAll(dir.path, "init config");
    return dir.path;
  }

  // ── init ────────────────────────────────────────────────────────
  test("init --json initializes a fresh config dir and reports the action", async () => {
    // Force non-TTY so the interactive prompts never engage.
    process.stdin.isTTY = false;
    await run(initCommand, { ...baseArgs, project: false, yes: true, json: true });
    const payload = json();
    expect(payload).toBeDefined();
    // A fresh init writes config.toml under the temp config dir.
    expect(await dir.exists("config.toml")).toBe(true);
  });

  // ── log ─────────────────────────────────────────────────────────
  test("log --json returns the commit history of the config repo", async () => {
    await initConfigDir();
    await run(logCommand, { ...baseArgs, count: "20", json: true });
    const payload = json();
    expect(Array.isArray(payload.log)).toBe(true);
    expect(payload.log.length).toBeGreaterThan(0);
  });

  test("log on a non-repo surfaces a 'Run `am init` first' error + exit 1", async () => {
    // No initRepo — gitLog throws → the guarded error branch fires.
    await run(logCommand, { ...baseArgs, count: "20", json: false });
    expect(process.exitCode).toBe(1);
    expect(err.join("\n").toLowerCase()).toContain("am init");
  });

  // ── completion ──────────────────────────────────────────────────
  test("completion bash emits a bash completion script", async () => {
    const bash = await sub(completionCommand, "bash");
    await run(bash, {});
    const text = out.join("");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("am");
  });

  // ── flow ────────────────────────────────────────────────────────
  test("flow list --json returns an (empty) runs array for a fresh runs dir", async () => {
    const list = await sub(flowCommand, "list");
    await run(list, { ...baseArgs, runsDir: join(dir.path, "flow-runs"), json: true });
    const payload = json();
    expect(Array.isArray(payload.runs)).toBe(true);
    expect(payload.runs.length).toBe(0);
  });

  // ── session ─────────────────────────────────────────────────────
  test("session list --json returns a sessions array (shape, host-agnostic)", async () => {
    const list = await sub(sessionCommand, "list");
    await run(list, { ...baseArgs, adapter: undefined, sort: "date", json: true });
    // Either no readers (exit 1) or a sessions array — both are valid on a
    // host; assert the contract holds for whichever branch ran.
    if (process.exitCode === 1) {
      expect(err.join("\n").toLowerCase()).toContain("session");
    } else {
      const payload = json();
      expect(Array.isArray(payload.sessions)).toBe(true);
    }
  });

  // ── adapter ─────────────────────────────────────────────────────
  test("adapter list --json reports the registered adapters", async () => {
    const list = await sub(adapterCommand, "list");
    await run(list, { ...baseArgs, json: true });
    const payload = json();
    expect(Array.isArray(payload.adapters)).toBe(true);
    // The 13 built-in adapters are always registered.
    expect(payload.adapters.length).toBeGreaterThan(0);
    expect(payload.adapters.map((a: { name: string }) => a.name)).toContain("claude-code");
  });

  // ── marketplace ─────────────────────────────────────────────────
  test("marketplace list --json reports an empty catalog on a fresh config dir", async () => {
    await initConfigDir();
    const list = await sub(marketplaceCommand, "list");
    await run(list, { ...baseArgs, installed: false, json: true });
    const payload = json();
    expect(Array.isArray(payload.marketplaces)).toBe(true);
    expect(payload.marketplaces.length).toBe(0);
  });

  // ── secrets (parent routing) ────────────────────────────────────
  test("secrets parent routes every declared subcommand to a runnable handler", async () => {
    // The `secrets` parent has no own handler — it only ROUTES to sub-modules
    // (migrate / rewrap / rotate / revoke), each of which prompts for a
    // passphrase, so we do NOT invoke run() here (that would hang on a prompt).
    // Instead we resolve each child THROUGH the parent's subCommands map (the
    // parent's actual job) and assert it is a runnable citty command. The deep
    // per-child behavior is covered in secrets-rotate/revoke/*.test.ts.
    for (const name of ["migrate", "rewrap", "rotate", "revoke"]) {
      const child = await sub(secretsCommand, name);
      // biome-ignore lint/suspicious/noExplicitAny: citty command shape
      expect(typeof (child as any).run).toBe("function");
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    // biome-ignore lint/performance/noDelete: env var cleanup
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
