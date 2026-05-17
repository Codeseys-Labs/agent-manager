/**
 * Smoke test: `am pair` router registration (Wave T sub-task T3).
 *
 * Verifies that `pairCommand` is correctly wired as a multi-verb parent
 * with `accept`, `finalize`, and `add` subcommands. `add` is a deprecated
 * alias for `accept` — same code path, plus a stderr deprecation warning.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveMeta, resolveSubCommands } from "../helpers/citty";
import { type TestDir, createTestDir } from "../helpers/tmp";

describe("am pair: router registration", () => {
  test("pairCommand exports with meta", async () => {
    const mod = await import("../../src/commands/pair");
    expect(mod.pairCommand).toBeDefined();
    const meta = await resolveMeta(mod.pairCommand);
    expect(meta).toBeDefined();
    expect(meta.name).toBe("pair");
    expect(meta.description).toContain("ADR-0047");
  });

  test("pairCommand has accept, finalize, and add subcommands", async () => {
    const mod = await import("../../src/commands/pair");
    const subs = await resolveSubCommands(mod.pairCommand);
    expect(subs).toBeDefined();
    expect(subs.accept).toBeDefined();
    expect(subs.finalize).toBeDefined();
    expect(subs.add).toBeDefined();
  });

  test("accept subcommand resolves to pairAcceptCommand", async () => {
    const mod = await import("../../src/commands/pair");
    const subs = await resolveSubCommands(mod.pairCommand);
    const resolved = await (subs.accept as () => Promise<any>)();
    const acceptMeta = await resolveMeta(resolved);
    expect(acceptMeta.name).toBe("accept");
    expect(acceptMeta.description).toContain("ADR-0047");
    expect(resolved.args).toBeDefined();
    expect(resolved.args.name).toBeDefined();
    expect(resolved.args.name.type).toBe("positional");
    expect(resolved.args.name.required).toBe(true);
  });

  test("finalize subcommand resolves to pairFinalizeCommand", async () => {
    const mod = await import("../../src/commands/pair");
    const subs = await resolveSubCommands(mod.pairCommand);
    const resolved = await (subs.finalize as () => Promise<any>)();
    const finalizeMeta = await resolveMeta(resolved);
    expect(finalizeMeta.name).toBe("finalize");
    expect(finalizeMeta.description).toContain("ADR-0047");
    expect(resolved.args).toBeDefined();
    expect(resolved.args.name).toBeDefined();
    expect(resolved.args.name.type).toBe("positional");
    expect(resolved.args.name.required).toBe(true);
  });

  test("add subcommand resolves with deprecated note in description", async () => {
    const mod = await import("../../src/commands/pair");
    const subs = await resolveSubCommands(mod.pairCommand);
    const resolved = await (subs.add as () => Promise<any>)();
    const addMeta = await resolveMeta(resolved);
    expect(addMeta.name).toBe("add");
    expect(addMeta.description.toLowerCase()).toContain("deprecated");
    expect(addMeta.description).toContain("am pair accept");
    // Args are inherited from pairAcceptCommand — same positional `name`.
    expect(resolved.args).toBeDefined();
    expect(resolved.args.name).toBeDefined();
    expect(resolved.args.name.type).toBe("positional");
    expect(resolved.args.name.required).toBe(true);
  });
});

// ── Deprecation alias behavior ───────────────────────────────────

const SCOPED_ENV_KEYS = [
  "AM_CONFIG_DIR",
  "AM_AGE_IDENTITY_DIR",
  "AM_AGE_PASSPHRASE",
  "AM_SECRETS_BACKEND",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of SCOPED_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let stdoutLines: string[] = [];
let stderrLines: string[] = [];
const origLog = console.log;
const origErr = console.error;
const origWrite = process.stdout.write.bind(process.stdout);

function captureConsole(): void {
  stdoutLines = [];
  stderrLines = [];
  console.log = (...chunks: unknown[]) => {
    stdoutLines.push(chunks.map(String).join(" "));
  };
  console.error = (...chunks: unknown[]) => {
    stderrLines.push(chunks.map(String).join(" "));
  };
  process.stdout.write = ((chunk: unknown) => {
    stdoutLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
}

function restoreConsole(): void {
  console.log = origLog;
  console.error = origErr;
  process.stdout.write = origWrite;
}

interface Fixture {
  dir: TestDir;
  identityDir: string;
  recipientsDir: string;
  passphrase: string;
}

async function makeFixture(prefix: string): Promise<Fixture> {
  const dir = await createTestDir(prefix);
  const identityDir = join(dir.path, "identities");
  const recipientsDir = join(identityDir, "recipients");
  const passphrase = `pw-${Math.random().toString(36).slice(2, 10)}`;
  await dir.write("config.toml", `[settings.secrets]\nbackend = "age"\n`);
  return { dir, identityDir, recipientsDir, passphrase };
}

async function invokeAlias(cmd: unknown, args: Record<string, unknown>): Promise<void> {
  const full = {
    "dry-run": false,
    force: false,
    json: false,
    quiet: false,
    verbose: false,
    ...args,
  };
  await (cmd as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run({
    args: full,
  });
}

describe("am pair add: deprecation alias behavior", () => {
  let fx: Fixture;
  let envSnap: Record<string, string | undefined>;

  beforeEach(async () => {
    envSnap = snapshotEnv();
    fx = await makeFixture("am-pair-add-");
    process.env.AM_CONFIG_DIR = fx.dir.path;
    process.env.AM_AGE_IDENTITY_DIR = fx.identityDir;
    process.env.AM_AGE_PASSPHRASE = fx.passphrase;
    process.env.AM_SECRETS_BACKEND = "age";
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    process.exitCode = 0;
    restoreEnv(envSnap);
    if (fx) await fx.dir.cleanup();
  });

  test("`am pair add` emits deprecation warning on stderr", async () => {
    const mod = await import("../../src/commands/pair");
    const subs = await resolveSubCommands(mod.pairCommand);
    const addCmd = await (subs.add as () => Promise<any>)();

    await invokeAlias(addCmd, { name: "laptop-add", "dry-run": true });
    expect(process.exitCode ?? 0).toBe(0);

    const stderr = stderrLines.join("\n");
    expect(stderr).toMatch(/deprecated/i);
    expect(stderr).toContain("am pair accept");
  });

  test("`am pair add --json` emits warning as JSON envelope on stderr", async () => {
    const mod = await import("../../src/commands/pair");
    const subs = await resolveSubCommands(mod.pairCommand);
    const addCmd = await (subs.add as () => Promise<any>)();

    await invokeAlias(addCmd, { name: "laptop-add-json", "dry-run": true, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const stderr = stderrLines.join("\n");
    // Find the JSON warning line — `warn()` emits {level: "warn", message}.
    const warnLine = stderrLines.find((l) => l.includes('"level"') && l.includes('"warn"'));
    expect(warnLine).toBeDefined();
    const parsed = JSON.parse(warnLine!) as { level: string; message: string };
    expect(parsed.level).toBe("warn");
    expect(parsed.message).toMatch(/deprecated/i);
    expect(parsed.message).toContain("am pair accept");
    void stderr;
  });

  test("`am pair add <name>` produces the same recipients/<name>.pub as `am pair accept <name>`", async () => {
    // Live (non-dry-run) flow: invoke add, then in a fresh fixture invoke
    // accept, and compare the resulting .pub recipient line. The `# added:`
    // timestamp line will differ — strip it before comparing.
    const mod = await import("../../src/commands/pair");
    const subs = await resolveSubCommands(mod.pairCommand);
    const addCmd = await (subs.add as () => Promise<any>)();
    const acceptCmd = await (subs.accept as () => Promise<any>)();

    // Run #1: alias path.
    await invokeAlias(addCmd, { name: "device-x" });
    expect(process.exitCode ?? 0).toBe(0);
    const aliasPubPath = join(fx.recipientsDir, "device-x.pub");
    const aliasBody = await readFile(aliasPubPath, "utf-8");

    // Tear down + re-create fixture so the second run starts from
    // a clean identity (otherwise the recipient line would trivially
    // match because identity.age is reused).
    await fx.dir.cleanup();
    fx = await makeFixture("am-pair-add-");
    process.env.AM_CONFIG_DIR = fx.dir.path;
    process.env.AM_AGE_IDENTITY_DIR = fx.identityDir;
    process.env.AM_AGE_PASSPHRASE = fx.passphrase;
    stdoutLines = [];
    stderrLines = [];

    // Run #2: canonical accept path.
    await invokeAlias(acceptCmd, { name: "device-x" });
    expect(process.exitCode ?? 0).toBe(0);
    const acceptPubPath = join(fx.recipientsDir, "device-x.pub");
    const acceptBody = await readFile(acceptPubPath, "utf-8");

    // Both files have the same shape: `# id:` header, `# added:` timestamp,
    // and an `age1...` recipient line. The timestamp differs across runs;
    // strip it. The recipient line will differ because each fixture has its
    // own freshly-generated identity — but the SHAPE must be identical.
    function strip(body: string): string {
      return body
        .split(/\r?\n/)
        .map((l) => (l.startsWith("# added:") ? "# added: <ts>" : l))
        .map((l) => (l.startsWith("age1") ? "age1<recipient>" : l))
        .join("\n");
    }
    expect(strip(aliasBody)).toBe(strip(acceptBody));

    // Both should carry the `# id: device-x` header and exactly one age1 line.
    expect(aliasBody).toMatch(/^# id: device-x$/m);
    expect(acceptBody).toMatch(/^# id: device-x$/m);
    const aliasAge = aliasBody.split(/\r?\n/).filter((l) => l.startsWith("age1"));
    const acceptAge = acceptBody.split(/\r?\n/).filter((l) => l.startsWith("age1"));
    expect(aliasAge.length).toBe(1);
    expect(acceptAge.length).toBe(1);
  });
});
