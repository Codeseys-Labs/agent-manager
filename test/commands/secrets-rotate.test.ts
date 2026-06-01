/**
 * ADR-0051 Phase-1 verification — `am secrets rotate` (+ `--finalize`).
 *
 * Gates covered in this file (from Wave P task brief, aligned with ADR-0051
 * §"Verification gates"):
 *
 *   1. `rotate` generates a new identity AND keeps the OLD recipient
 *      registered so envelopes are dual-encrypted during the grace window.
 *   2. After `rotate`, the NEW identity can decrypt the rewrapped envelope.
 *   3. After `rotate`, the OLD identity can STILL decrypt the rewrapped
 *      envelope (grace window).
 *   4. After `rotate --finalize`, the OLD identity can NO LONGER decrypt a
 *      freshly-encrypted envelope (new-only recipient set).
 *   5. `rotate --finalize` BEFORE grace expires exits non-zero unless
 *      `--force` is passed.
 *   7. `--dry-run` reports planned changes without writing anything.
 *   8. `--json` dry-run output conforms to `DryRunEnvelope` (ADR-0038).
 *
 * Gate 6 (`revoke`) lives in `secrets-revoke.test.ts`.
 *
 * These tests drive `secretsRotateCommand.run({ args })` directly (citty
 * pattern, same as `test/commands/dry-run-envelope.test.ts`). Each test
 * stands up its own identity directory + TOML fixture, so no test touches
 * the developer's real `~/.config/agent-manager` state.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Decrypter } from "age-encryption";
import { secretsRotateCommand } from "../../src/commands/secrets-rotate";
import { AgeSecretsBackend } from "../../src/core/secrets-age";
import { isDryRunEnvelope } from "../../src/lib/dry-run-envelope";
import { type TestDir, createTestDir } from "../helpers/tmp";

// age scrypt key-wrapping is 8-9s per fixture under CI coverage; the 5s
// default would time out and leak global state across the shared bun
// process. See pair-finalize.test.ts for the full rationale. (Wave CI/P0-5.)
setDefaultTimeout(30_000);

const AGE_PREFIX = "enc:v2:age:";

// ── Console capture ──────────────────────────────────────────────

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

// ── Env scoping ──────────────────────────────────────────────────

const SCOPED_ENV_KEYS = [
  "AM_CONFIG_DIR",
  "AM_AGE_IDENTITY_DIR",
  "AM_AGE_PASSPHRASE",
  "AM_AGE_NEW_PASSPHRASE",
  "AM_SECRETS_BACKEND",
  "AM_KEY_PATH",
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

// ── Test fixture ─────────────────────────────────────────────────

interface Fixture {
  dir: TestDir;
  identityDir: string;
  tomlPath: string;
  oldIdentityString: string; // plaintext "AGE-SECRET-KEY-1..." of the initial identity
  oldRecipient: string;
  oldPassphrase: string;
  /** Initial envelope encrypted with the old identity. */
  initialEnvelope: string;
}

/**
 * Build a self-contained test fixture: a config dir with an age backend
 * initialised (identity written, passphrase cached), and a TOML file with
 * a single `enc:v2:age:` envelope that round-trips against the initial
 * identity. The caller can then run rotate/revoke/rewrap commands and
 * verify on-disk + decrypt behavior.
 */
async function makeFixture(
  opts: { passphrase?: string; configToml?: string } = {},
): Promise<Fixture> {
  const dir = await createTestDir("am-secrets-rotate-");
  const identityDir = join(dir.path, "identities");
  const tomlPath = join(dir.path, "fixture.toml");
  const oldPassphrase = opts.passphrase ?? `old-pw-${Math.random().toString(36).slice(2, 10)}`;

  // Build a setup backend via the public constructor (not getDefaultBackend)
  // so we can inject an in-memory keychain and avoid touching the OS one.
  const memStore = new Map<string, string>();
  const backend = new AgeSecretsBackend({
    identityPath: join(identityDir, "identity.age"),
    recipientsDir: join(identityDir, "recipients"),
    passphraseProvider: async () => oldPassphrase,
    keychain: {
      async getPassword(service: string, account: string) {
        return memStore.get(`${service}::${account}`) ?? null;
      },
      async setPassword(service: string, account: string, password: string) {
        memStore.set(`${service}::${account}`, password);
      },
      async deletePassword(service: string, account: string) {
        memStore.delete(`${service}::${account}`);
      },
    },
  });
  await backend.initialize();
  const oldRecipient = await backend.getRecipient();
  const envelope = await backend.encrypt("fixture-plaintext");

  // Write a main config.toml (so `settings.secrets.backend = "age"` is picked
  // up by getDefaultBackend) and a separate fixture.toml holding the envelope
  // under a `--file` target. This keeps TOML discovery deterministic.
  const configToml =
    opts.configToml ??
    `
[settings.secrets]
backend = "age"

[settings.secrets.rotation]
grace_period_days = 14
`;
  await writeFile(join(dir.path, "config.toml"), configToml, "utf-8");
  await writeFile(
    tomlPath,
    `[servers.test]
command = "echo"
transport = "stdio"
enabled = true

[servers.test.env]
SECRET = "${envelope}"
`,
    "utf-8",
  );

  // Pull the plaintext identity string via readFile + manual age-decrypt so
  // tests can construct an explicit Decrypter later and prove "identity X
  // can decrypt envelope Y".
  const { Decrypter: D } = await import("age-encryption");
  const wrapped = await readFile(join(identityDir, "identity.age"));
  const d = new D();
  d.addPassphrase(oldPassphrase);
  const oldIdentityString = await d.decrypt(new Uint8Array(wrapped), "text");

  return {
    dir,
    identityDir,
    tomlPath,
    oldIdentityString,
    oldRecipient,
    oldPassphrase,
    initialEnvelope: envelope,
  };
}

/** Decrypt an `enc:v2:age:` envelope with an explicit identity string. */
async function decryptWithIdentity(envelope: string, identityString: string): Promise<string> {
  if (!envelope.startsWith(AGE_PREFIX)) {
    throw new Error(`not an age envelope: ${envelope.slice(0, 20)}`);
  }
  const payload = envelope.slice(AGE_PREFIX.length);
  const bin = atob(payload);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const d = new Decrypter();
  d.addIdentity(identityString);
  return d.decrypt(bytes, "text");
}

/** Read back the `SECRET` envelope from the fixture TOML. */
async function readEnvelope(tomlPath: string): Promise<string> {
  const raw = await readFile(tomlPath, "utf-8");
  const m = /SECRET\s*=\s*"([^"]+)"/m.exec(raw);
  if (!m) throw new Error(`no SECRET in ${tomlPath}: ${raw}`);
  return m[1]!;
}

/**
 * Invoke the citty command's `.run({ args })` entrypoint. We pass dashed
 * keys exactly as the command declares them (`"dry-run"`, `"no-backup"`).
 */
async function invokeRotate(args: Record<string, unknown>): Promise<void> {
  // Pre-fill defaults for the many boolean flags citty would otherwise
  // leave undefined; the command reads them unconditionally.
  const full = {
    finalize: false,
    force: false,
    "dry-run": false,
    "no-backup": false,
    json: false,
    quiet: false,
    verbose: false,
    ...args,
  };
  await (
    secretsRotateCommand as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
    }
  ).run({ args: full });
}

function jsonFromStdout(): Record<string, unknown> {
  const joined = stdoutLines.join("\n");
  const first = joined.indexOf("{");
  const last = joined.lastIndexOf("}");
  if (first < 0 || last < 0) {
    throw new Error(`no JSON in stdout: ${joined}`);
  }
  return JSON.parse(joined.slice(first, last + 1)) as Record<string, unknown>;
}

// ── Gate setup ───────────────────────────────────────────────────

describe("ADR-0051 `am secrets rotate` — Phase 1 verification gates", () => {
  let fx: Fixture;
  let envSnap: Record<string, string | undefined>;

  beforeEach(async () => {
    envSnap = snapshotEnv();
    fx = await makeFixture();
    process.env.AM_CONFIG_DIR = fx.dir.path;
    process.env.AM_AGE_IDENTITY_DIR = fx.identityDir;
    process.env.AM_AGE_PASSPHRASE = fx.oldPassphrase;
    process.env.AM_SECRETS_BACKEND = "age";
    process.env.AM_AGE_NEW_PASSPHRASE = undefined;
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    process.exitCode = 0;
    restoreEnv(envSnap);
    if (fx) await fx.dir.cleanup();
  });

  // Gate 1: rotate generates a new identity AND dual-encrypts to both recipients
  test("gate-1: rotate generates a new identity + dual-encrypts (old recipient retained as sidecar)", async () => {
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-1";

    await invokeRotate({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // 1a. new identity file on disk, distinct from the archived old one.
    const newIdentityFile = join(fx.identityDir, "identity.age");
    const oldArchive = join(fx.identityDir, "identity.age.old");
    const newBytes = await readFile(newIdentityFile);
    const oldBytes = await readFile(oldArchive);
    expect(newBytes.byteLength).toBeGreaterThan(0);
    expect(oldBytes.byteLength).toBeGreaterThan(0);
    expect(Buffer.compare(newBytes, oldBytes)).not.toBe(0);

    // 1b. old recipient is registered as a sidecar under recipients/.
    const rotationOldSidecar = join(fx.identityDir, "recipients", "_rotation-old.pub");
    const sidecarBody = await readFile(rotationOldSidecar, "utf-8");
    expect(sidecarBody).toContain(fx.oldRecipient);

    // 1c. rotation-state sidecar written with both recipients.
    const state = JSON.parse(
      await readFile(join(fx.identityDir, ".am-rotation-state.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(state.old_recipient).toBe(fx.oldRecipient);
    expect(typeof state.new_recipient).toBe("string");
    expect(state.new_recipient).not.toBe(fx.oldRecipient);
    expect(state.grace_period_days).toBe(14);
  });

  // Gate 2: new identity can decrypt the rewrapped envelope.
  test("gate-2: after rotate, NEW identity decrypts the rewrapped envelope", async () => {
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-2";

    await invokeRotate({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // Read the rewrapped envelope back.
    const newEnvelope = await readEnvelope(fx.tomlPath);
    expect(newEnvelope.startsWith(AGE_PREFIX)).toBe(true);

    // Load the NEW identity by decrypting identity.age with AM_AGE_NEW_PASSPHRASE.
    const wrapped = await readFile(join(fx.identityDir, "identity.age"));
    const d = new Decrypter();
    d.addPassphrase("new-pw-2");
    const newIdentityString = await d.decrypt(new Uint8Array(wrapped), "text");

    const plaintext = await decryptWithIdentity(newEnvelope, newIdentityString);
    expect(plaintext).toBe("fixture-plaintext");
  }, 30_000);

  // Gate 3: old identity still decrypts during grace window.
  test("gate-3: after rotate, OLD identity STILL decrypts (grace window)", async () => {
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-3";

    await invokeRotate({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const newEnvelope = await readEnvelope(fx.tomlPath);
    // The OLD identity string was captured before rotation; it must still
    // decrypt the NEW dual-encrypted envelope (that's the whole point of
    // the grace window).
    const plaintext = await decryptWithIdentity(newEnvelope, fx.oldIdentityString);
    expect(plaintext).toBe("fixture-plaintext");
  }, 30_000);

  // Gate 4: --finalize drops old recipient; old identity can no longer decrypt
  // the ENVELOPES produced AFTER finalize.
  test("gate-4: rotate --finalize --force re-encrypts with new-only recipient; OLD identity fails to decrypt", async () => {
    // Step 1: rotate (grace=14).
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-4";
    await invokeRotate({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // Step 2: finalize with --force (grace hasn't elapsed yet, which is
    // realistic for a test run; the --force flag is what gate-5 protects).
    stdoutLines.length = 0;
    stderrLines.length = 0;
    process.exitCode = 0;
    // After rotate, unlock now needs the NEW passphrase.
    process.env.AM_AGE_PASSPHRASE = "new-pw-4";
    await invokeRotate({ file: fx.tomlPath, json: true, finalize: true, force: true });
    expect(process.exitCode ?? 0).toBe(0);

    // Sidecar + state + .old archive are all gone.
    const oldSidecar = join(fx.identityDir, "recipients", "_rotation-old.pub");
    await expect(readFile(oldSidecar)).rejects.toThrow();
    await expect(readFile(join(fx.identityDir, "identity.age.old"))).rejects.toThrow();
    await expect(readFile(join(fx.identityDir, ".am-rotation-state.json"))).rejects.toThrow();

    // Envelope was re-encrypted to new-only — old identity must fail.
    const finalEnvelope = await readEnvelope(fx.tomlPath);
    await expect(decryptWithIdentity(finalEnvelope, fx.oldIdentityString)).rejects.toThrow();
  }, 30_000);

  // Gate 5: finalize inside grace window without --force exits non-zero.
  test("gate-5: rotate --finalize inside grace window exits non-zero unless --force", async () => {
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-5";
    await invokeRotate({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // Now attempt finalize — grace is 14 days, so we're well inside it.
    stdoutLines.length = 0;
    stderrLines.length = 0;
    process.exitCode = 0;
    process.env.AM_AGE_PASSPHRASE = "new-pw-5";
    await invokeRotate({ file: fx.tomlPath, json: true, finalize: true /* no force */ });
    expect(process.exitCode).toBe(1);

    const payload = jsonFromStdout();
    expect(payload.action).toBe("rotate-finalize");
    expect(typeof payload.error).toBe("string");
    expect(String(payload.error)).toMatch(/grace period not elapsed/i);

    // Sidecar and state are still intact — the command refused to finalize.
    await expect(readFile(join(fx.identityDir, ".am-rotation-state.json"))).resolves.toBeDefined();
  }, 30_000);

  test("gate-5 corollary: --force overrides the grace-window check", async () => {
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-5b";
    await invokeRotate({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    stdoutLines.length = 0;
    stderrLines.length = 0;
    process.exitCode = 0;
    process.env.AM_AGE_PASSPHRASE = "new-pw-5b";
    await invokeRotate({
      file: fx.tomlPath,
      json: true,
      finalize: true,
      force: true,
    });
    expect(process.exitCode ?? 0).toBe(0);

    // State cleared → rotation considered complete.
    await expect(readFile(join(fx.identityDir, ".am-rotation-state.json"))).rejects.toThrow();
  }, 30_000);

  // Gate 7: dry-run reports without writing.
  test("gate-7: --dry-run reports planned ops but touches no files", async () => {
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-7";

    const before = {
      toml: await readFile(fx.tomlPath, "utf-8"),
      identity: await readFile(join(fx.identityDir, "identity.age")),
    };
    const oldExists = async (p: string): Promise<boolean> => {
      try {
        await readFile(p);
        return true;
      } catch {
        return false;
      }
    };

    await invokeRotate({ file: fx.tomlPath, "dry-run": true, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // No mutations anywhere: TOML unchanged, identity file unchanged, no
    // archive/sidecar/state-file written.
    const after = {
      toml: await readFile(fx.tomlPath, "utf-8"),
      identity: await readFile(join(fx.identityDir, "identity.age")),
    };
    expect(after.toml).toBe(before.toml);
    expect(Buffer.compare(after.identity, before.identity)).toBe(0);
    expect(await oldExists(join(fx.identityDir, "identity.age.old"))).toBe(false);
    expect(await oldExists(join(fx.identityDir, "recipients", "_rotation-old.pub"))).toBe(false);
    expect(await oldExists(join(fx.identityDir, ".am-rotation-state.json"))).toBe(false);
  });

  // Gate 8: --json --dry-run conforms to DryRunEnvelope.
  test("gate-8: --dry-run --json emits a DryRunEnvelope (ADR-0038)", async () => {
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-8";

    await invokeRotate({ file: fx.tomlPath, "dry-run": true, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const payload = jsonFromStdout();
    expect(isDryRunEnvelope(payload)).toBe(true);
    expect(payload.action).toBe("rotate");
    expect(Array.isArray(payload.would_do)).toBe(true);
    expect((payload.would_do as string[]).join(" ")).toMatch(/generate|new age identity/i);
    expect(Array.isArray(payload.mutations_prevented)).toBe(true);
    expect((payload.mutations_prevented as string[]).length).toBeGreaterThan(0);
  });
});

// ── grace_period_days = 0 (immediate cutover) ────────────────────
// Not one of the 8 gates in the Wave P task brief, but the ADR explicitly
// requires grace=0 to skip dual-encryption. Covering it with a single
// targeted test strengthens gate-1's generalisation.

describe("ADR-0051 `am secrets rotate` — grace_period_days = 0 (immediate cutover)", () => {
  let fx: Fixture;
  let envSnap: Record<string, string | undefined>;

  beforeEach(async () => {
    envSnap = snapshotEnv();
    fx = await makeFixture({
      configToml: `
[settings.secrets]
backend = "age"

[settings.secrets.rotation]
grace_period_days = 0
`,
    });
    process.env.AM_CONFIG_DIR = fx.dir.path;
    process.env.AM_AGE_IDENTITY_DIR = fx.identityDir;
    process.env.AM_AGE_PASSPHRASE = fx.oldPassphrase;
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

  test("grace=0 performs immediate cutover: OLD identity fails to decrypt the rewrapped envelope", async () => {
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-grace0";

    await invokeRotate({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // No sidecar/state/archive should linger — grace=0 is equivalent to
    // an immediate finalize.
    const noFile = async (p: string): Promise<boolean> => {
      try {
        await readFile(p);
        return false;
      } catch {
        return true;
      }
    };
    expect(await noFile(join(fx.identityDir, "identity.age.old"))).toBe(true);
    expect(await noFile(join(fx.identityDir, "recipients", "_rotation-old.pub"))).toBe(true);
    expect(await noFile(join(fx.identityDir, ".am-rotation-state.json"))).toBe(true);

    // Old identity cannot decrypt the rewrapped envelope.
    const rewrapped = await readEnvelope(fx.tomlPath);
    await expect(decryptWithIdentity(rewrapped, fx.oldIdentityString)).rejects.toThrow();
  }, 30_000);
});

// ── ADR-0051 / gpt-5.5 Phase-8 must-fix #1 ────────────────────────
// Crash-safe finalize ordering. The finalize flow MUST rewrap to the
// NEW-only recipient set BEFORE deleting the archived OLD identity and
// the rotation-state sidecar, so a rewrap failure leaves the rotation
// recoverable instead of orphaning envelopes against a deleted recipient.

describe("ADR-0051 `am secrets rotate --finalize` — safe ordering (gpt-5.5 must-fix #1)", () => {
  let fx: Fixture;
  let envSnap: Record<string, string | undefined>;

  beforeEach(async () => {
    envSnap = snapshotEnv();
    fx = await makeFixture();
    process.env.AM_CONFIG_DIR = fx.dir.path;
    process.env.AM_AGE_IDENTITY_DIR = fx.identityDir;
    process.env.AM_AGE_PASSPHRASE = fx.oldPassphrase;
    process.env.AM_SECRETS_BACKEND = "age";
    process.env.AM_AGE_NEW_PASSPHRASE = undefined;
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    process.exitCode = 0;
    restoreEnv(envSnap);
    if (fx) await fx.dir.cleanup();
  });

  test("safe-ordering: rewrap failure on a corrupted envelope restores the OLD recipient sidecar AND keeps the archive on disk", async () => {
    // Step 1: rotate with grace > 0 so we land in dual-encrypt state
    // and the finalize path does a real rewrap pass (not the grace=0
    // immediate-cutover shortcut).
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-finalize-corrupt";
    await invokeRotate({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // Sanity: dual-encrypt artifacts present.
    const oldSidecar = join(fx.identityDir, "recipients", "_rotation-old.pub");
    const oldArchive = join(fx.identityDir, "identity.age.old");
    const stateFile = join(fx.identityDir, ".am-rotation-state.json");
    await expect(readFile(oldSidecar)).resolves.toBeDefined();
    await expect(readFile(oldArchive)).resolves.toBeDefined();
    await expect(readFile(stateFile)).resolves.toBeDefined();

    // Inject a corrupted age envelope into the TOML alongside the
    // legitimate one (same `[servers.test.env]` table). The rewrap
    // walker will try `backend.rewrap()` on it, fail to decrypt, and
    // bump the per-file `skipped` count — which the safe-ordering
    // finalize must treat as "abort + restore". Note: the rotate pass
    // already round-tripped the TOML through @iarna/toml, which
    // re-emits sub-tables indented; tolerate either form.
    const tomlBefore = await readFile(fx.tomlPath, "utf-8");
    const corrupted = `${AGE_PREFIX}AAAAcorruptedpayloadthatcannotbedecryptedAAAA==`;
    const tomlWithBadEnv = tomlBefore.replace(
      /(\s*\[servers\.test\.env\]\s*\n)(\s*SECRET\s*=\s*"[^"]+"\s*\n)/,
      (_m, header, secLine) =>
        `${header}${secLine}${secLine.replace(/SECRET/, "BROKEN").replace(/"[^"]+"/, `"${corrupted}"`)}`,
    );
    expect(tomlWithBadEnv).not.toBe(tomlBefore);
    expect(tomlWithBadEnv).toContain(corrupted);
    await writeFile(fx.tomlPath, tomlWithBadEnv, "utf-8");

    // Step 2: finalize --force → must abort with non-zero exit, restore
    // the OLD recipient sidecar, and leave the archive + state file in
    // place so the operator can fix the bad envelope and retry.
    stdoutLines.length = 0;
    stderrLines.length = 0;
    process.exitCode = 0;
    process.env.AM_AGE_PASSPHRASE = "new-pw-finalize-corrupt";
    await invokeRotate({ file: fx.tomlPath, json: true, finalize: true, force: true });

    expect(process.exitCode).toBe(1);

    // Sidecar restored — i.e. rotation is back in dual-encrypt grace
    // state, NOT half-finalized with a deleted recipient.
    const sidecarBody = await readFile(oldSidecar, "utf-8");
    expect(sidecarBody).toContain(fx.oldRecipient);

    // Archive + state file still present (commit stage was never reached).
    await expect(readFile(oldArchive)).resolves.toBeDefined();
    await expect(readFile(stateFile)).resolves.toBeDefined();

    // JSON output reports the abort so callers/CI can tell.
    const payload = jsonFromStdout();
    expect(payload.action).toBe("rotate-finalize");
    expect(typeof payload.error).toBe("string");
    expect(String(payload.error)).toMatch(/finalize aborted|skipped|unrewrapped/i);
  }, 30_000);

  test("safe-ordering: full rewrap success commits — sidecar, archive, and state file are all removed", async () => {
    // Step 1: rotate (grace=14 default).
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-finalize-clean";
    await invokeRotate({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // Step 2: finalize --force with a healthy TOML — every envelope
    // rewraps cleanly, so finalize commits and the OLD material is
    // cleaned up exactly as it was before this safety patch.
    stdoutLines.length = 0;
    stderrLines.length = 0;
    process.exitCode = 0;
    process.env.AM_AGE_PASSPHRASE = "new-pw-finalize-clean";
    await invokeRotate({ file: fx.tomlPath, json: true, finalize: true, force: true });

    expect(process.exitCode ?? 0).toBe(0);

    // OLD material gone.
    await expect(
      readFile(join(fx.identityDir, "recipients", "_rotation-old.pub")),
    ).rejects.toThrow();
    await expect(readFile(join(fx.identityDir, "identity.age.old"))).rejects.toThrow();
    await expect(readFile(join(fx.identityDir, ".am-rotation-state.json"))).rejects.toThrow();

    // OLD identity can no longer decrypt the now-NEW-only envelope.
    const finalEnvelope = await readEnvelope(fx.tomlPath);
    await expect(decryptWithIdentity(finalEnvelope, fx.oldIdentityString)).rejects.toThrow();

    // JSON output reports finalized phase.
    const payload = jsonFromStdout();
    expect(payload.action).toBe("rotate-finalize");
    expect(payload.phase).toBe("finalized");
  }, 30_000);
});
