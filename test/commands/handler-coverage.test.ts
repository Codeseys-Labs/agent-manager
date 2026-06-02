/**
 * TEST-1 (Wave A) — command-HANDLER coverage.
 *
 * The pre-existing per-command tests mostly exercise the underlying helpers
 * (writeConfig, encryptValue, loadKey, …) rather than the citty command's own
 * `run()` handler. The discovery review flagged that the handlers themselves —
 * arg parsing, output shape, exit codes, error branches — were largely
 * untested. This file closes that gap for the highest-value handlers by driving
 * the actual `<cmd>Command.run()` with:
 *   - AM_CONFIG_DIR pointed at a per-test temp dir (full isolation),
 *   - AM_KEY_PATH redirected so no test ever touches the real key,
 *   - console captured so JSON payloads and error lines are assertable,
 *   - the controller's apply seam forced empty so apply never touches the
 *     real machine's tools.
 *
 * Every test here invokes a real command handler (parent or subcommand). Parent
 * commands that only fan out to subCommands (secret, profile, config) are
 * driven through their `subCommands.<name>()` resolver, which returns the
 * runnable child command.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandDef } from "citty";
import { applyCommand } from "../../src/commands/apply";
import { configCommand } from "../../src/commands/config";
import { doctorCommand } from "../../src/commands/doctor";
import { importCommand } from "../../src/commands/import";
import { listCommand } from "../../src/commands/list";
import { profileCommand } from "../../src/commands/profile";
import { pullCommand } from "../../src/commands/pull";
import { pushCommand } from "../../src/commands/push";
import { secretCommand } from "../../src/commands/secret";
import { statusCommand } from "../../src/commands/status";
import { undoCommand } from "../../src/commands/undo";
import { useCommand } from "../../src/commands/use";
import { readActiveProfile } from "../../src/commands/use";
import { loadResolvedConfig, writeConfig } from "../../src/core/config";
import { __setAdapterResolverForTests } from "../../src/core/controller";
import { commitAll, initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { generateKey, loadKey, saveKey } from "../../src/core/secrets";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ── console capture ─────────────────────────────────────────────
let out: string[] = [];
let err: string[] = [];
const origLog = console.log;
const origError = console.error;
const origConfigDir = process.env.AM_CONFIG_DIR;
const origKeyPath = process.env.AM_KEY_PATH;
const origCwd = process.cwd();

function capture(): void {
  out = [];
  err = [];
  console.log = (...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    err.push(a.map(String).join(" "));
  };
}
function restore(): void {
  console.log = origLog;
  console.error = origError;
}
function json(): any {
  return JSON.parse(out.join("\n"));
}

/**
 * Invoke a citty command's handler with the given args (other ctx is stubbed).
 *
 * The param is `CommandDef<any>` because citty's `CommandDef` is invariant on
 * its args generic, so the concrete `CommandDef<{json,…}>` exports are not
 * assignable to the bare `CommandDef`. `any` here only widens the input — the
 * handler call is already cast.
 */
async function run(cmd: CommandDef<any>, args: Record<string, unknown>): Promise<void> {
  await (cmd as any).run({ args, cmd, rawArgs: [], data: undefined });
}

/** Resolve a subcommand from a parent's `subCommands` map. */
async function sub(parent: CommandDef<any>, name: string): Promise<CommandDef<any>> {
  const map = (parent as any).subCommands as Record<string, () => Promise<CommandDef<any>>>;
  return map[name]();
}

const baseArgs = { json: false, quiet: false, verbose: false };

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    settings: { default_profile: "default" },
    servers: {
      tavily: {
        command: "bunx",
        args: ["tavily-mcp@latest"],
        transport: "stdio",
        enabled: true,
        tags: ["search"],
      },
    },
    instructions: {
      "ts-rules": { content: "Use strict TypeScript.", scope: "always" },
    },
    profiles: {
      default: { description: "Default profile" },
      work: { description: "Work profile", inherits: "default", servers: ["tavily"] },
    },
    ...overrides,
  };
}

/** Create an initialized config dir (git repo + valid config.toml + key). */
async function initConfigDir(dir: TestDir, config: Config = makeConfig()): Promise<string> {
  const configDir = dir.path;
  await initRepo(configDir);
  await writeConfig(join(configDir, "config.toml"), config);
  await commitAll(configDir, "init config");
  return configDir;
}

describe("command handlers (TEST-1)", () => {
  let dir: TestDir;
  let keyDir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-handler-");
    keyDir = await createTestDir("am-handler-key-");
    process.env.AM_CONFIG_DIR = dir.path;
    process.env.AM_KEY_PATH = join(keyDir.path, "key");
    // Several handlers (status, list, config) resolve PROJECT config via
    // resolveProjectConfig(process.cwd()), which walks UP the tree. Running
    // from inside this repo would let the repo's real .agent-manager.toml leak
    // into the assertions. chdir into the temp config dir (under the OS
    // tmpdir, no .agent-manager.toml up-tree) so each test sees ONLY the
    // AM_CONFIG_DIR we control and a null project file.
    process.chdir(dir.path);
    __setAdapterResolverForTests(async () => []);
    capture();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restore();
    __setAdapterResolverForTests(null);
    process.exitCode = 0;
    process.chdir(origCwd);
    if (origConfigDir === undefined) {
      // biome-ignore lint/performance/noDelete: env cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = origConfigDir;
    }
    if (origKeyPath === undefined) {
      // biome-ignore lint/performance/noDelete: env cleanup
      delete process.env.AM_KEY_PATH;
    } else {
      process.env.AM_KEY_PATH = origKeyPath;
    }
    if (dir) await dir.cleanup();
    if (keyDir) await keyDir.cleanup();
  });

  // ── list ──────────────────────────────────────────────────────
  describe("list", () => {
    test("--json lists servers from config", async () => {
      await initConfigDir(dir);
      await run(listCommand, { ...baseArgs, entity: "servers", json: true, active: false });
      const payload = json();
      expect(payload.servers.map((s: { name: string }) => s.name)).toContain("tavily");
    });

    test("lists profiles with --json", async () => {
      await initConfigDir(dir);
      await run(listCommand, { ...baseArgs, entity: "profiles", json: true, active: false });
      const names = json().profiles.map((p: { name: string }) => p.name);
      expect(names).toContain("default");
      expect(names).toContain("work");
    });

    test("rejects an unknown entity type with exit code 1", async () => {
      await initConfigDir(dir);
      await run(listCommand, { ...baseArgs, entity: "widgets", json: true, active: false });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("unknown entity type");
    });

    test("missing config resolves to an empty catalog (loadResolvedConfig returns {}), not an error", async () => {
      // No initConfigDir — config.toml absent. loadResolvedConfig merges from
      // defaults and returns {} rather than throwing, so `list` reports an
      // empty servers array and exits 0. (The CONFIG_NOT_FOUND try/catch in
      // list.ts only fires if loadResolvedConfig itself throws, which it does
      // not for a missing file — list.ts is not in this wave's write-set, so
      // we pin the ACTUAL behavior here.)
      await run(listCommand, { ...baseArgs, entity: "servers", json: true, active: false });
      expect(process.exitCode).toBe(0);
      expect(json().servers).toEqual([]);
    });

    test("empty servers list prints a helpful hint (text mode)", async () => {
      await initConfigDir(dir, makeConfig({ servers: {} }));
      await run(listCommand, { ...baseArgs, entity: "servers", json: false, active: false });
      expect(out.join("\n")).toContain("No servers configured");
    });
  });

  // ── status ────────────────────────────────────────────────────
  describe("status", () => {
    test("--json aggregates profile, server count, git, and (empty) tools", async () => {
      await initConfigDir(dir);
      await run(statusCommand, { ...baseArgs, json: true });
      const payload = json();
      expect(payload.profile).toBe("default");
      expect(typeof payload.servers).toBe("number");
      expect(payload.git).toBeDefined();
      // Adapter resolution is NOT seamed by status (it uses getDetectedAdapters),
      // so tools may be non-empty on the host; just assert the shape.
      expect(Array.isArray(payload.tools)).toBe(true);
    });

    test("missing config resolves to an empty catalog (0 servers), not an error", async () => {
      // As with `list`, loadResolvedConfig returns {} for an absent config.toml
      // rather than throwing, so `status` reports 0 servers and exits 0. (The
      // CONFIG_NOT_FOUND branch in status.ts is unreachable for a missing file;
      // status.ts is outside this wave's write-set, so we pin the real shape.)
      await run(statusCommand, { ...baseArgs, json: true });
      expect(process.exitCode).toBe(0);
      const payload = json();
      expect(payload.servers).toBe(0);
      expect(payload.profile).toBe("default");
    });
  });

  // ── doctor ────────────────────────────────────────────────────
  describe("doctor", () => {
    test("--json reports a healthy flag and a Check[] including the config dir", async () => {
      await initConfigDir(dir);
      await run(doctorCommand, { ...baseArgs, json: true });
      const payload = json();
      expect(typeof payload.healthy).toBe("boolean");
      expect(Array.isArray(payload.checks)).toBe(true);
      const byName = new Map(
        payload.checks.map((c: { name: string; status: string }) => [c.name, c.status]),
      );
      expect(byName.get("Config directory")).toBe("ok");
      expect(byName.get("Git repository")).toBe("ok");
      // A valid config.toml is reported ok → no failures → healthy.
      expect(payload.healthy).toBe(true);
    });

    test("a missing config.toml makes doctor report a failure + exit 1", async () => {
      // git repo but NO config.toml.
      await initRepo(dir.path);
      await run(doctorCommand, { ...baseArgs, json: false });
      // collectDoctorChecks marks config.toml fail → exit 1.
      expect(process.exitCode).toBe(1);
      expect(out.join("\n")).toContain("Health check: FAIL");
    });
  });

  // ── use ───────────────────────────────────────────────────────
  describe("use", () => {
    test("writes the active profile to state.toml", async () => {
      const configDir = await initConfigDir(dir);
      await run(useCommand, { ...baseArgs, profile: "work", json: true });
      expect(json().profile).toBe("work");
      expect(await readActiveProfile(configDir)).toBe("work");
    });

    test("rejects an unknown profile with PROFILE_NOT_FOUND + exit 1", async () => {
      const configDir = await initConfigDir(dir);
      await run(useCommand, { ...baseArgs, profile: "ghost", json: true });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("not found");
      // state.toml must NOT have been written.
      expect(await readActiveProfile(configDir)).toBeNull();
    });
  });

  // ── profile ───────────────────────────────────────────────────
  describe("profile", () => {
    test("list --json marks the active profile", async () => {
      await initConfigDir(dir);
      const listCmd = await sub(profileCommand, "list");
      await run(listCmd, { ...baseArgs, json: true });
      const payload = json();
      expect(payload.activeProfile).toBe("default");
      const active = payload.profiles.find((p: { active: boolean }) => p.active);
      expect(active.name).toBe("default");
    });

    test("show --json resolves a profile's servers", async () => {
      await initConfigDir(dir);
      const showCmd = await sub(profileCommand, "show");
      await run(showCmd, { ...baseArgs, name: "work", json: true });
      const payload = json();
      expect(payload.name).toBe("work");
      expect(payload.servers).toContain("tavily");
    });

    test("create adds a new profile and auto-commits", async () => {
      const configDir = await initConfigDir(dir);
      const createCmd = await sub(profileCommand, "create");
      await run(createCmd, {
        ...baseArgs,
        name: "staging",
        inherits: undefined,
        description: "Staging",
        json: true,
      });
      expect(json().profile).toBe("staging");
      const cfg = await loadResolvedConfig({ configDir, projectFile: null });
      expect(cfg.profiles?.staging).toBeDefined();
    });

    test("create rejects a duplicate profile name with exit 1", async () => {
      await initConfigDir(dir);
      const createCmd = await sub(profileCommand, "create");
      await run(createCmd, {
        ...baseArgs,
        name: "work",
        inherits: undefined,
        description: undefined,
        json: false,
      });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("already exists");
    });

    test("delete removes a profile (--yes / non-interactive)", async () => {
      const configDir = await initConfigDir(dir);
      const deleteCmd = await sub(profileCommand, "delete");
      await run(deleteCmd, { ...baseArgs, name: "work", yes: true, json: true });
      expect(json().profile).toBe("work");
      const cfg = await loadResolvedConfig({ configDir, projectFile: null });
      expect(cfg.profiles?.work).toBeUndefined();
    });

    test("delete refuses a profile that another profile inherits from", async () => {
      // 'work' inherits 'default' → deleting 'default' must be refused.
      await initConfigDir(dir);
      const deleteCmd = await sub(profileCommand, "delete");
      await run(deleteCmd, { ...baseArgs, name: "default", yes: true, json: false });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("inherits");
    });
  });

  // ── config ────────────────────────────────────────────────────
  describe("config", () => {
    test("validate --json reports a valid config", async () => {
      await initConfigDir(dir);
      const validateCmd = await sub(configCommand, "validate");
      await run(validateCmd, { ...baseArgs, json: true });
      const payload = json();
      expect(payload.valid).toBe(true);
      expect(payload.errors).toEqual([]);
    });

    test("validate --json flags a missing config.toml as invalid", async () => {
      const validateCmd = await sub(configCommand, "validate");
      await run(validateCmd, { ...baseArgs, json: true });
      const payload = json();
      expect(payload.valid).toBe(false);
      expect(payload.errors.join(" ")).toContain("config.toml");
      // NOTE: in --json mode validateCommand emits the {valid,errors} envelope
      // and returns BEFORE the exit-code branch (config.ts:97-99 vs :114), so
      // the non-zero exit code is a TEXT-mode contract — pinned below. config.ts
      // is outside this wave's write-set, so we assert the real behavior.
    });

    test("validate (text mode) sets exit 1 for a missing config.toml", async () => {
      const validateCmd = await sub(configCommand, "validate");
      await run(validateCmd, { ...baseArgs, json: false });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("config.toml");
    });

    test("show --json emits the parsed raw config", async () => {
      await initConfigDir(dir);
      const showCmd = await sub(configCommand, "show");
      await run(showCmd, { ...baseArgs, resolved: false, json: true });
      const payload = json();
      expect(payload.settings.default_profile).toBe("default");
      expect(payload.servers.tavily).toBeDefined();
    });

    test("show on a missing config surfaces CONFIG_NOT_FOUND + exit 1", async () => {
      const showCmd = await sub(configCommand, "show");
      await run(showCmd, { ...baseArgs, resolved: false, json: true });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("config not found");
    });
  });

  // ── secret ────────────────────────────────────────────────────
  describe("secret", () => {
    test("set → get round-trips an encrypted value", async () => {
      const configDir = await initConfigDir(dir);
      await saveKey(configDir, await generateKey());

      const setCmd = await sub(secretCommand, "set");
      await run(setCmd, {
        ...baseArgs,
        name: "API_TOKEN",
        value: "sk-live-xyz",
        server: undefined,
        json: true,
      });
      expect(json().action).toBe("set");

      capture();
      const getCmd = await sub(secretCommand, "get");
      await run(getCmd, { ...baseArgs, name: "API_TOKEN", server: undefined, json: true });
      expect(json().value).toBe("sk-live-xyz");
    });

    test("set fails clearly when no encryption key exists", async () => {
      await initConfigDir(dir); // no saveKey
      const setCmd = await sub(secretCommand, "set");
      await run(setCmd, {
        ...baseArgs,
        name: "API_TOKEN",
        value: "v",
        server: undefined,
        json: false,
      });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("no encryption key");
    });

    test("set --server fails when the server does not exist", async () => {
      const configDir = await initConfigDir(dir);
      await saveKey(configDir, await generateKey());
      const setCmd = await sub(secretCommand, "set");
      await run(setCmd, {
        ...baseArgs,
        name: "K",
        value: "v",
        server: "nonexistent",
        json: false,
      });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("not found");
    });

    test("get on an unknown secret exits 1", async () => {
      const configDir = await initConfigDir(dir);
      await saveKey(configDir, await generateKey());
      const getCmd = await sub(secretCommand, "get");
      await run(getCmd, { ...baseArgs, name: "MISSING", server: undefined, json: false });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("not found");
    });

    test("list --json reports encrypted secret names (not values)", async () => {
      const configDir = await initConfigDir(dir);
      await saveKey(configDir, await generateKey());
      const setCmd = await sub(secretCommand, "set");
      await run(setCmd, {
        ...baseArgs,
        name: "GLOBAL_KEY",
        value: "secret",
        server: undefined,
        json: true,
      });
      capture();
      const listSecretCmd = await sub(secretCommand, "list");
      await run(listSecretCmd, { ...baseArgs, json: true });
      const names = json().secrets.map((s: { name: string }) => s.name);
      expect(names).toContain("GLOBAL_KEY");
    });

    test("scan --json reports a detected plaintext secret in a server env", async () => {
      // A server with an obvious secret env var triggers the tier-1 key-name scan.
      const config = makeConfig({
        servers: {
          tavily: {
            command: "bunx",
            args: ["tavily-mcp@latest"],
            transport: "stdio",
            enabled: true,
            env: { TAVILY_API_KEY: "sk-supersecretplaintext-1234567890" },
          },
        },
      });
      await initConfigDir(dir, config);
      const scanCmd = await sub(secretCommand, "scan");
      await run(scanCmd, { ...baseArgs, fix: false, json: true });
      const payload = json();
      expect(payload.action).toBe("scan");
      expect(Array.isArray(payload.secrets)).toBe(true);
      const flat = payload.secrets.flatMap((r: { secrets: unknown[] }) => r.secrets);
      expect(flat.length).toBeGreaterThan(0);
    });

    test("scan --fix substitutes + encrypts and generates a key when absent", async () => {
      const config = makeConfig({
        servers: {
          tavily: {
            command: "bunx",
            args: ["tavily-mcp@latest"],
            transport: "stdio",
            enabled: true,
            env: { TAVILY_API_KEY: "sk-supersecretplaintext-1234567890" },
          },
        },
      });
      const configDir = await initConfigDir(dir, config);
      const scanCmd = await sub(secretCommand, "scan");
      await run(scanCmd, { ...baseArgs, fix: true, json: true });
      const payload = json();
      expect(payload.action).toBe("scan-fix");
      expect(payload.substituted).toBeGreaterThan(0);
      // A key was generated by the fix path.
      expect(await loadKey(configDir)).not.toBeNull();
    });
  });

  // ── push / pull ───────────────────────────────────────────────
  describe("push / pull (no-remote error branches)", () => {
    test("push with no remote configured surfaces NO_REMOTE + exit 1", async () => {
      await initConfigDir(dir); // git repo, but no remote added
      await run(pushCommand, { ...baseArgs, json: false });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("no remote");
    });

    test("pull with no remote configured surfaces NO_REMOTE + exit 1", async () => {
      await initConfigDir(dir);
      await run(pullCommand, { ...baseArgs, json: false });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("no remote");
    });

    test("push on a non-repo surfaces CONFIG_NOT_FOUND + exit 1", async () => {
      // No initRepo: getStatus throws → CONFIG_NOT_FOUND branch.
      await run(pushCommand, { ...baseArgs, json: false });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("config not found");
    });
  });

  // ── undo ──────────────────────────────────────────────────────
  describe("undo (guards)", () => {
    test("on a non-repo it cannot read the log and exits 1", async () => {
      await run(undoCommand, { ...baseArgs, apply: false });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("cannot read git log");
    });

    test("with only the initial commit it refuses with 'Nothing to undo'", async () => {
      // initRepo creates exactly one commit; initConfigDir adds a second.
      // Here we want a single-commit repo to hit the guard.
      await initRepo(dir.path);
      await run(undoCommand, { ...baseArgs, apply: false });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("nothing to undo");
    });

    test("reverts the most recent commit when one exists", async () => {
      // initConfigDir: initRepo (commit 1) + commitAll (commit 2).
      await initConfigDir(dir);
      await run(undoCommand, { ...baseArgs, apply: false, json: true });
      const payload = json();
      expect(payload.action).toBe("undo");
      expect(payload.reverted).toBe("init config");
      // --apply not passed → applied stays false (stale-config warning path).
      expect(payload.applied).toBe(false);
    });
  });

  // ── apply ─────────────────────────────────────────────────────
  describe("apply", () => {
    test("--json with no detected tools emits the canonical empty envelope", async () => {
      await initConfigDir(dir); // adapter resolver seamed to [] in beforeEach
      await run(applyCommand, {
        ...baseArgs,
        "dry-run": false,
        diff: false,
        force: false,
        target: undefined,
        profile: undefined,
        json: true,
      });
      const payload = json();
      expect(payload.action).toBe("apply");
      expect(payload.results).toEqual([]);
      expect(payload.succeeded).toBe(0);
    });

    test("--dry-run --json emits the ADR-0038 dry-run envelope (reads_only)", async () => {
      await initConfigDir(dir);
      await run(applyCommand, {
        ...baseArgs,
        "dry-run": true,
        diff: false,
        force: false,
        target: undefined,
        profile: undefined,
        json: true,
      });
      const payload = json();
      expect(payload.action).toBe("apply");
      expect(payload.reads_only).toBe(true);
      expect(payload.mutations_prevented).toContain("adapter file writes");
    });
  });

  // ── import ────────────────────────────────────────────────────
  describe("import", () => {
    test("an unknown adapter surfaces ADAPTER_NOT_FOUND + exit 1", async () => {
      await initConfigDir(dir);
      await run(importCommand, {
        ...baseArgs,
        source: "not-a-real-adapter",
        auto: false,
        report: false,
        marketplace: false,
        "no-encrypt": false,
      });
      expect(process.exitCode).toBe(1);
      expect(err.join("\n").toLowerCase()).toContain("not found");
    });
  });
});
