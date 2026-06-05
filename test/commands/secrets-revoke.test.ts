/**
 * ADR-0051 gate 4 — `am secrets revoke <fingerprint>`.
 *
 * Gates covered here (gate numbers from Wave P brief / ADR-0051
 * §"Verification gates", verb-local renumbering):
 *
 *   1. `revoke <fp>` removes the `.pub` file from `recipients/` AND
 *      rewraps every envelope to the remaining recipient set.
 *   2. After `revoke`, the peer who held the revoked identity can no
 *      longer decrypt the rewrapped envelope.
 *   3. `revoke <fp>` with no matching recipient exits non-zero with an
 *      actionable error.
 *   4. `revoke --dry-run` reports planned ops without writing anything.
 *   5. `revoke --json` emits a payload per ADR-0038 (`action`,
 *      `reads_only`, `would_do`, `mutations_prevented`).
 *   6. `revoke` never targets the user's OWN identity — the own
 *      recipient is not stored in `recipients/`, so even passing the
 *      own age public key fails cleanly with a non-zero exit.
 *   7. `revoke` is safe when `recipients/` is empty: exits non-zero
 *      with an actionable error (no silent no-op against nothing).
 *
 * Follows the same fixture + console-capture pattern as
 * `test/commands/secrets-rotate.test.ts` so reviewers only have to
 * learn one test shape for the four age-verbs.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { secretsRevokeCommand } from "../../src/commands/secrets-revoke";
import { AgeSecretsBackend } from "../../src/core/secrets-age";
import { isDryRunEnvelope } from "../../src/lib/dry-run-envelope";
import { type TestDir, createTestDir } from "../helpers/tmp";

// age scrypt identity wrapping is slow under CI coverage; the 5s default
// would time out and leak global state across the shared bun process. See
// pair-finalize.test.ts for the full rationale. (Wave CI / P0-5.)
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

interface PeerRecipient {
  /** Plaintext `AGE-SECRET-KEY-1...` for the peer. */
  identityString: string;
  /** `age1...` public recipient for the peer. */
  publicKey: string;
  /** Stable id used as `recipients/<id>.pub` filename. */
  id: string;
}

interface Fixture {
  dir: TestDir;
  identityDir: string;
  tomlPath: string;
  ownIdentityString: string;
  ownRecipient: string;
  passphrase: string;
  peer: PeerRecipient;
  /**
   * Envelope encrypted to {own + peer}, stored in the fixture TOML.
   * Built AFTER the peer was added as a recipient so that BOTH the
   * local identity AND the peer identity can decrypt the starting
   * envelope — which lets us prove that revocation actually cuts the
   * peer off (gate-2).
   */
  initialEnvelope: string;
}

async function makeFixture(): Promise<Fixture> {
  const dir = await createTestDir("am-secrets-revoke-");
  const identityDir = join(dir.path, "identities");
  const tomlPath = join(dir.path, "fixture.toml");
  const passphrase = `pw-${Math.random().toString(36).slice(2, 10)}`;

  const memStore = new Map<string, string>();
  const backend = new AgeSecretsBackend({
    identityPath: join(identityDir, "identity.age"),
    recipientsDir: join(identityDir, "recipients"),
    passphraseProvider: async () => passphrase,
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
  const ownRecipient = await backend.getRecipient();

  // Generate a standalone peer identity (simulates `am pair finalize`:
  // a second machine's pubkey is added to recipients/ under a stable
  // id, with NO access to the local identity file).
  const peerIdentityString = await generateIdentity();
  const peerRecipient = await identityToRecipient(peerIdentityString);
  const peer: PeerRecipient = {
    identityString: peerIdentityString,
    publicKey: peerRecipient,
    id: "peer-alice",
  };
  await backend.addRecipient({
    id: peer.id,
    publicKey: peer.publicKey,
    addedAt: new Date().toISOString(),
  });

  // Encrypt to {own, peer} via the default recipient-union path. Now
  // both identities can decrypt the starting envelope.
  const envelope = await backend.encrypt("fixture-plaintext");

  const configToml = `
[settings.secrets]
backend = "age"
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

  // Grab the own identity plaintext so tests can decrypt with it later.
  const wrapped = await readFile(join(identityDir, "identity.age"));
  const d = new Decrypter();
  d.addPassphrase(passphrase);
  const ownIdentityString = await d.decrypt(new Uint8Array(wrapped), "text");

  return {
    dir,
    identityDir,
    tomlPath,
    ownIdentityString,
    ownRecipient,
    passphrase,
    peer,
    initialEnvelope: envelope,
  };
}

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

async function readEnvelope(tomlPath: string): Promise<string> {
  const raw = await readFile(tomlPath, "utf-8");
  const m = /SECRET\s*=\s*"([^"]+)"/m.exec(raw);
  if (!m) throw new Error(`no SECRET in ${tomlPath}: ${raw}`);
  return m[1]!;
}

async function invokeRevoke(args: Record<string, unknown>): Promise<void> {
  const full = {
    "dry-run": false,
    "no-backup": false,
    json: false,
    quiet: false,
    verbose: false,
    ...args,
  };
  await (
    secretsRevokeCommand as unknown as {
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

// ── Tests ────────────────────────────────────────────────────────

describe("ADR-0051 `am secrets revoke` — gate 4", () => {
  let fx: Fixture;
  let envSnap: Record<string, string | undefined>;

  beforeEach(async () => {
    envSnap = snapshotEnv();
    fx = await makeFixture();
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
    // (stderrLines kept referenced so the variable isn't flagged as unused
    // in case a future test wants to assert on non-json output.)
    void stderrLines;
  });

  // Gate-local 1: revoke drops the peer .pub AND rewraps envelopes.
  test("revoke removes the recipient .pub and rewraps envelopes in discovered TOMLs", async () => {
    // Sanity: peer starts registered.
    const recipientsDir = join(fx.identityDir, "recipients");
    const before = await readdir(recipientsDir);
    expect(before).toContain(`${fx.peer.id}.pub`);

    await invokeRevoke({ fingerprint: fx.peer.id, file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // The .pub file is gone.
    const after = await readdir(recipientsDir);
    expect(after).not.toContain(`${fx.peer.id}.pub`);

    // The envelope was rewrapped (its ciphertext changed vs. the
    // starting value). Our local identity still decrypts it.
    const rewrapped = await readEnvelope(fx.tomlPath);
    expect(rewrapped.startsWith(AGE_PREFIX)).toBe(true);
    expect(rewrapped).not.toBe(fx.initialEnvelope);
    const pt = await decryptWithIdentity(rewrapped, fx.ownIdentityString);
    expect(pt).toBe("fixture-plaintext");

    // JSON payload carries the summary required by ADR-0051.
    const payload = jsonFromStdout();
    expect(payload.action).toBe("revoke");
    const recipient = payload.recipient as Record<string, unknown>;
    expect(recipient.id).toBe(fx.peer.id);
    expect(recipient.publicKey).toBe(fx.peer.publicKey);
    expect(typeof recipient.fingerprint).toBe("string");
    expect(Number(payload.rewrapped)).toBeGreaterThanOrEqual(1);
  });

  // Gate-local 2: the revoked peer can no longer decrypt new ciphertext.
  test("after revoke, the peer holding the revoked identity cannot decrypt the rewrapped envelope", async () => {
    // Pre-condition: peer CAN decrypt the starting envelope.
    const pre = await decryptWithIdentity(fx.initialEnvelope, fx.peer.identityString);
    expect(pre).toBe("fixture-plaintext");

    await invokeRevoke({ fingerprint: fx.peer.id, file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const rewrapped = await readEnvelope(fx.tomlPath);
    // The peer identity is no longer a recipient → decrypt must fail.
    await expect(decryptWithIdentity(rewrapped, fx.peer.identityString)).rejects.toThrow();
  });

  // Gate-local 3: revoke with an unknown fingerprint exits non-zero.
  test("revoke with a fingerprint that matches no recipient exits non-zero with an actionable error", async () => {
    await invokeRevoke({
      fingerprint: "deadbeef42", // 10-hex, but matches no .pub
      file: fx.tomlPath,
      json: true,
    });
    expect(process.exitCode).toBe(1);

    const payload = jsonFromStdout();
    expect(payload.action).toBe("revoke");
    expect(typeof payload.error).toBe("string");
    expect(String(payload.error)).toMatch(/no recipient matching/i);
    expect(String(payload.error)).toContain("deadbeef42");

    // Nothing on disk should have changed — peer .pub still present.
    const recipientsDir = join(fx.identityDir, "recipients");
    const listing = await readdir(recipientsDir);
    expect(listing).toContain(`${fx.peer.id}.pub`);
    const envelope = await readEnvelope(fx.tomlPath);
    expect(envelope).toBe(fx.initialEnvelope);
  });

  // Gate-local 4: --dry-run writes nothing.
  test("revoke --dry-run reports planned operations without mutating disk", async () => {
    const recipientsDir = join(fx.identityDir, "recipients");
    const beforeToml = await readFile(fx.tomlPath, "utf-8");
    const beforeListing = (await readdir(recipientsDir)).sort();

    await invokeRevoke({
      fingerprint: fx.peer.id,
      file: fx.tomlPath,
      "dry-run": true,
      json: true,
    });
    expect(process.exitCode ?? 0).toBe(0);

    // No mutations: TOML identical, peer .pub still on disk.
    const afterToml = await readFile(fx.tomlPath, "utf-8");
    expect(afterToml).toBe(beforeToml);
    const afterListing = (await readdir(recipientsDir)).sort();
    expect(afterListing).toEqual(beforeListing);
  });

  // Gate-local 5: --dry-run --json emits an ADR-0038 DryRunEnvelope.
  test("revoke --dry-run --json emits a DryRunEnvelope (ADR-0038)", async () => {
    await invokeRevoke({
      fingerprint: fx.peer.id,
      file: fx.tomlPath,
      "dry-run": true,
      json: true,
    });
    expect(process.exitCode ?? 0).toBe(0);

    const payload = jsonFromStdout();
    expect(isDryRunEnvelope(payload)).toBe(true);
    expect(payload.action).toBe("revoke");
    expect(payload.reads_only).toBe(true);
    const wouldDo = payload.would_do as string[];
    expect(Array.isArray(wouldDo)).toBe(true);
    expect(wouldDo.join(" ")).toMatch(/remove recipient/i);
    expect(wouldDo.join(" ")).toMatch(/rewrap/i);
    const prevented = payload.mutations_prevented as string[];
    expect(Array.isArray(prevented)).toBe(true);
    expect(prevented.length).toBeGreaterThan(0);
  });

  // Gate-local 6: the user's own identity cannot be revoked.
  // The own recipient is derived from identity.age and is NOT stored
  // under recipients/, so passing the own age public key matches no
  // `.pub` file and revoke refuses (same path as gate-local 3).
  test("revoke refuses to target the user's own identity (no .pub for own recipient)", async () => {
    // Pre-condition: own recipient file does NOT exist in recipients/.
    const recipientsDir = join(fx.identityDir, "recipients");
    const listing = await readdir(recipientsDir);
    for (const name of listing) {
      if (!name.endsWith(".pub")) continue;
      const body = await readFile(join(recipientsDir, name), "utf-8");
      expect(body).not.toContain(fx.ownRecipient);
    }

    await invokeRevoke({
      fingerprint: fx.ownRecipient, // full age1... key of the local identity
      file: fx.tomlPath,
      json: true,
    });
    expect(process.exitCode).toBe(1);

    const payload = jsonFromStdout();
    expect(payload.action).toBe("revoke");
    expect(String(payload.error)).toMatch(/no recipient matching/i);

    // identity.age on disk is untouched.
    const identityBytes = await readFile(join(fx.identityDir, "identity.age"));
    expect(identityBytes.byteLength).toBeGreaterThan(0);

    // Envelope on disk is untouched — no rewrap happened.
    const env = await readEnvelope(fx.tomlPath);
    expect(env).toBe(fx.initialEnvelope);
  });

  // Gate-local 7: recipients/ empty → revoke exits non-zero.
  test("revoke against an empty recipients/ directory exits non-zero with actionable error", async () => {
    // Drop the peer so recipients/ is empty.
    const { unlink } = await import("node:fs/promises");
    await unlink(join(fx.identityDir, "recipients", `${fx.peer.id}.pub`));

    await invokeRevoke({
      fingerprint: fx.peer.id,
      file: fx.tomlPath,
      json: true,
    });
    expect(process.exitCode).toBe(1);

    const payload = jsonFromStdout();
    expect(payload.action).toBe("revoke");
    expect(typeof payload.error).toBe("string");
    expect(String(payload.error)).toMatch(/no recipient matching/i);
  });

  // ── Skip-handling (R2-BUG1): a rewrap that would skip an envelope must NOT
  // leave on-disk state half-mutated. The safe-abort design scans first (a
  // read-only dry-run); if any envelope can't be rewrapped it aborts BEFORE
  // removing the recipient or touching any file — so the recipient simply
  // REMAINS registered and the TOML is byte-identical to before. This is
  // stronger than the old "remove-then-restore" because nothing is mutated.
  test("revoke with a skipped (corrupt) envelope aborts before mutating, leaving the recipient registered and files untouched", async () => {
    const recipientsDir = join(fx.identityDir, "recipients");
    // Sanity: peer starts registered.
    expect(await readdir(recipientsDir)).toContain(`${fx.peer.id}.pub`);

    // Inject a corrupted age envelope alongside the legitimate one. The
    // rewrap walker will try `backend.rewrap()` on it, fail to decrypt, and
    // bump `skipped` — which the safe-abort scan must catch up front.
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
    const tomlAtScan = await readFile(fx.tomlPath, "utf-8");

    await invokeRevoke({ fingerprint: fx.peer.id, file: fx.tomlPath, json: true });

    // Skipped envelope → non-zero exit.
    expect(process.exitCode).toBe(1);

    // The recipient was never removed (safe-abort), so the peer .pub is still
    // on disk — the revoked peer can still decrypt, which is exactly what the
    // non-zero exit + abort message tell the operator.
    const after = await readdir(recipientsDir);
    expect(after).toContain(`${fx.peer.id}.pub`);

    // CRUCIAL (R2-BUG1): NO file was mutated — the TOML is byte-identical to
    // what it was before the revoke attempt. No half-rewrapped envelopes.
    expect(await readFile(fx.tomlPath, "utf-8")).toBe(tomlAtScan);

    // JSON payload reports the abort + surfaces the skipped envelope(s) and
    // that the recipient remains registered. Exactly ONE JSON document.
    const payload = jsonFromStdout();
    expect(payload.action).toBe("revoke");
    expect(payload.aborted).toBe(true);
    expect(typeof payload.error).toBe("string");
    expect(String(payload.error)).toMatch(/abort/i);
    expect(String(payload.error)).toContain("remains registered");
    expect(Number(payload.skipped)).toBeGreaterThanOrEqual(1);
    // The offending file is surfaced so the operator can fix it.
    expect(payload.skipped_files).toContain(fx.tomlPath);
  });
});
