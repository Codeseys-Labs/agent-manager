/**
 * Wizard-followup tests for `am setup` that close two review nits:
 *
 *  (a) Non-interactive key consent. The wizard intentionally does NOT generate
 *      an encryption key on a non-interactive run (that would write a machine
 *      secret without consent — see the comment at setup.ts step 3). These
 *      tests pin that contract: a `--yes` run leaves NO key, and the resulting
 *      doctor `Check[]` carries an "Encryption key … warn" entry.
 *
 *  (b) The interactive-path coverage gap. The other setup tests run without a
 *      TTY, so the `interactive` branch (clack prompts) was never exercised.
 *      Here we force `process.stdin.isTTY = true` and inject a deterministic
 *      clack double via the `__setClackForTests` seam (NOT a process-global
 *      `mock.module`, which leaks across parallel test files). This drives the
 *      real interactive code path: intro → prompts → outro, and asserts the
 *      user's prompt answers steer the wizard (e.g. "generate" creates a key).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  type ClackLike,
  __setClackForTests,
  __setDetectedAdaptersForTests,
  setupCommand,
} from "../../src/commands/setup";
import { __setAdapterResolverForTests } from "../../src/core/controller";
import { loadKey } from "../../src/core/secrets";
import { type TestDir, createTestDir } from "../helpers/tmp";

const origConfigDir = process.env.AM_CONFIG_DIR;
const origKeyPath = process.env.AM_KEY_PATH;
const origCI = process.env.CI;
const origTTY = process.stdin.isTTY;

const handler = setupCommand as unknown as {
  run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
};

function makeArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: undefined,
    ssh: false,
    tools: undefined,
    profile: undefined,
    "no-apply": true, // keep tests fast/hermetic — apply path is covered elsewhere
    force: false,
    "generate-key": false,
    yes: false,
    "non-interactive": false,
    json: false,
    quiet: false,
    verbose: false,
    ...overrides,
  };
}

/**
 * Build a clack double that records every interaction and returns scripted
 * answers. `answers` maps a prompt kind to its return value; unspecified kinds
 * fall back to a benign default that never blocks.
 */
function makeClackDouble(answers: {
  confirm?: boolean;
  select?: string;
  text?: string;
  multiselect?: string[];
}): { clack: ClackLike; calls: string[] } {
  const calls: string[] = [];
  // Built as an untyped record and cast to ClackLike at the boundary: clack's
  // select/multiselect/isCancel carry precise generic / type-guard signatures
  // that a hand-written double can't satisfy structurally, but at runtime the
  // wizard only needs these to return scripted values and never block.
  const clack = {
    intro: (msg: unknown) => {
      calls.push(`intro:${String(msg)}`);
    },
    outro: (msg: unknown) => {
      calls.push(`outro:${String(msg)}`);
    },
    note: () => {
      calls.push("note");
    },
    confirm: async () => {
      calls.push("confirm");
      return answers.confirm ?? true;
    },
    text: async () => {
      calls.push("text");
      return answers.text ?? "default";
    },
    select: async () => {
      calls.push("select");
      return answers.select ?? "skip";
    },
    multiselect: async () => {
      calls.push("multiselect");
      return answers.multiselect ?? [];
    },
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    isCancel: (_v: unknown): _v is symbol => false,
    cancel: (msg: unknown) => {
      calls.push(`cancel:${String(msg)}`);
    },
    log: {
      message: () => {},
      info: () => {},
      success: () => {},
      step: () => {},
      warn: () => {},
      warning: () => {},
      error: () => {},
    },
  } as unknown as ClackLike;
  return { clack, calls };
}

describe("am setup — non-interactive key consent (nit a)", () => {
  let dir: TestDir;
  let keyDir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-setup-consent-");
    keyDir = await createTestDir("am-setup-consent-key-");
    process.env.AM_CONFIG_DIR = join(dir.path, "cfg");
    // Redirect the key path to a tmp file that does NOT exist yet, so any
    // accidental key write is detectable (and never touches ~/).
    process.env.AM_KEY_PATH = join(keyDir.path, "key");
    __setDetectedAdaptersForTests(async () => []);
    __setAdapterResolverForTests(async () => []);
    process.exitCode = 0;
  });

  afterEach(async () => {
    __setDetectedAdaptersForTests(null);
    __setAdapterResolverForTests(null);
    __setClackForTests(null);
    process.exitCode = 0;
    restoreEnv("AM_CONFIG_DIR", origConfigDir);
    restoreEnv("AM_KEY_PATH", origKeyPath);
    if (dir) await dir.cleanup();
    if (keyDir) await keyDir.cleanup();
  });

  test("a --yes run does NOT generate an encryption key (consent-gated)", async () => {
    await handler.run({ args: makeArgs({ yes: true }) });

    const configDir = process.env.AM_CONFIG_DIR!;
    // No key on disk at the configured AM_KEY_PATH.
    expect(fs.existsSync(process.env.AM_KEY_PATH!)).toBe(false);
    // And loadKey agrees there is no key.
    expect(await loadKey(configDir)).toBeNull();
  });

  test("the doctor checks emitted in --json carry an Encryption-key warning", async () => {
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      out.push(a.map(String).join(" "));
    };
    try {
      await handler.run({ args: makeArgs({ yes: true, json: true }) });
    } finally {
      console.log = origLog;
    }

    const payload = JSON.parse(out.join("\n"));
    // keyGenerated MUST be false on a non-interactive run.
    expect(payload.keyGenerated).toBe(false);
    const keyCheck = (payload.checks as Array<{ name: string; status: string }>).find((c) =>
      c.name.startsWith("Encryption key"),
    );
    expect(keyCheck).toBeDefined();
    expect(keyCheck!.status).toBe("warn");
  });

  test("--generate-key is the non-interactive opt-in that DOES create a key", async () => {
    // The explicit opt-in resolution of nit (a): a scripted run can request a
    // key without a prompt. Contrast with the consent-gated default above.
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      out.push(a.map(String).join(" "));
    };
    try {
      await handler.run({ args: makeArgs({ yes: true, json: true, "generate-key": true }) });
    } finally {
      console.log = origLog;
    }

    const configDir = process.env.AM_CONFIG_DIR!;
    // The opt-in wrote a key at the configured path.
    expect(fs.existsSync(process.env.AM_KEY_PATH!)).toBe(true);
    expect(await loadKey(configDir)).not.toBeNull();

    const payload = JSON.parse(out.join("\n"));
    expect(payload.keyGenerated).toBe(true);
    // With a key present, the doctor Encryption-key check is no longer a warn.
    const keyCheck = (payload.checks as Array<{ name: string; status: string }>).find((c) =>
      c.name.startsWith("Encryption key"),
    );
    expect(keyCheck).toBeDefined();
    expect(keyCheck!.status).not.toBe("warn");
  });
});

describe("am setup — interactive path with injected clack (nit b)", () => {
  let dir: TestDir;
  let keyDir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-setup-interactive-");
    keyDir = await createTestDir("am-setup-interactive-key-");
    process.env.AM_CONFIG_DIR = join(dir.path, "cfg");
    process.env.AM_KEY_PATH = join(keyDir.path, "key");
    // Force the interactive guard ON: TTY present, no CI.
    process.stdin.isTTY = true;
    // biome-ignore lint/performance/noDelete: env var toggle for the test
    delete process.env.CI;
    __setDetectedAdaptersForTests(async () => []);
    __setAdapterResolverForTests(async () => []);
    process.exitCode = 0;
  });

  afterEach(async () => {
    __setDetectedAdaptersForTests(null);
    __setAdapterResolverForTests(null);
    __setClackForTests(null);
    process.stdin.isTTY = origTTY;
    restoreEnv("CI", origCI);
    restoreEnv("AM_CONFIG_DIR", origConfigDir);
    restoreEnv("AM_KEY_PATH", origKeyPath);
    process.exitCode = 0;
    if (dir) await dir.cleanup();
    if (keyDir) await keyDir.cleanup();
  });

  test("interactive run shows intro + outro and initializes config", async () => {
    // Decline the clone, decline secret generation ("skip"), keep default
    // profile, confirm/skip apply — a fully scripted, non-blocking run.
    const { clack, calls } = makeClackDouble({ confirm: false, select: "skip", text: "default" });
    __setClackForTests(clack);

    await handler.run({ args: makeArgs() });

    // The interactive branch ran end to end.
    expect(calls.some((c) => c.startsWith("intro:"))).toBe(true);
    expect(calls.some((c) => c.startsWith("outro:"))).toBe(true);
    // The clone prompt fired (configExists was false on a fresh dir).
    expect(calls).toContain("confirm");

    const configDir = process.env.AM_CONFIG_DIR!;
    expect(fs.existsSync(join(configDir, "config.toml"))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  test('choosing "generate" at the secret prompt writes a key (interactive consent)', async () => {
    // confirm:false declines the clone; select:"generate" opts into the key.
    const { clack, calls } = makeClackDouble({
      confirm: false,
      select: "generate",
      text: "default",
    });
    __setClackForTests(clack);

    await handler.run({ args: makeArgs() });

    expect(calls).toContain("select");
    // The user consented → a key now exists at the configured path.
    expect(fs.existsSync(process.env.AM_KEY_PATH!)).toBe(true);
    const configDir = process.env.AM_CONFIG_DIR!;
    expect(await loadKey(configDir)).not.toBeNull();
  });

  test("a cancelled clone prompt aborts with a non-zero exit code", async () => {
    // isCancel → true on the first prompt: the wizard must bail via cancel().
    const calls: string[] = [];
    const clack = {
      ...makeClackDouble({}).clack,
      confirm: async () => {
        calls.push("confirm");
        return true; // value is irrelevant; isCancel short-circuits
      },
      isCancel: (_v: unknown): _v is symbol => true,
      cancel: (msg: unknown) => {
        calls.push(`cancel:${String(msg)}`);
      },
    } as unknown as ClackLike;
    __setClackForTests(clack);

    await handler.run({ args: makeArgs() });

    expect(calls.some((c) => c.startsWith("cancel:"))).toBe(true);
    expect(process.exitCode).toBe(1);
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
