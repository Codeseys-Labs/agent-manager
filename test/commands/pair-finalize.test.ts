/**
 * ADR-0047 Wave T sub-task T2 — `am pair finalize <name>`.
 *
 * Gates covered here:
 *
 *   1. Happy path: recipients/<name>.pub exists; finalize runs; the named
 *      pubkey can decrypt the rewrapped envelopes (verified by spinning up
 *      a Decrypter with a fixture identity).
 *   2. Missing pub file: exits non-zero with actionable error
 *      ("recipients/<name>.pub not found").
 *   3. Malformed pub file (not age1...): exits non-zero with the parse
 *      error AND the path.
 *   4. Already-finalized name (recipient already in set): exits non-zero
 *      unless --force, which causes a re-rewrap.
 *   5. --no-rewrap: registers the recipient, skips the rewrap pass.
 *   6. --dry-run: no files written, no envelopes touched.
 *   7. --json: emits valid DryRunEnvelope per ADR-0038.
 *
 * Follows the same fixture + console-capture pattern as
 * `test/commands/secrets-revoke.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { pairFinalizeCommand } from "../../src/commands/pair-finalize";
import { AgeSecretsBackend } from "../../src/core/secrets-age";
import { isDryRunEnvelope } from "../../src/lib/dry-run-envelope";
import { type TestDir, createTestDir } from "../helpers/tmp";

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

interface PeerIdentity {
  /** Plaintext `AGE-SECRET-KEY-1...` for the peer. */
  identityString: string;
  /** `age1...` public recipient for the peer. */
  publicKey: string;
  /** Stable id used as `recipients/<id>.pub` filename. */
  id: string;
  /** Raw content of the .pub file (ready to write). */
  pubContent: string;
}

interface Fixture {
  dir: TestDir;
  identityDir: string;
  tomlPath: string;
  ownIdentityString: string;
  ownRecipient: string;
  passphrase: string;
  peer: PeerIdentity;
  /** Envelope encrypted to the OWN identity only (before finalize). */
  initialEnvelope: string;
}

async function makeFixture(): Promise<Fixture> {
  const dir = await createTestDir("am-pair-finalize-");
  const identityDir = join(dir.path, "identities");
  const tomlPath = join(dir.path, "fixture.toml");
  const passphrase = `pw-${Math.random().toString(36).slice(2, 10)}`;

  const memStore = new Map<string, string>();
  const backend = new AgeSecretsBackend({
    identityPath: join(identityDir, "identity.age"),
    // Use an empty recipients dir during setup so encrypt targets only
    // the own identity. Tests will populate recipients/ later.
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

  // Generate a standalone peer identity (simulates a new device that ran
  // `am pair accept laptop-2`).
  const peerIdentityString = await generateIdentity();
  const peerRecipient = await identityToRecipient(peerIdentityString);
  const peerId = "laptop-2";
  const pubContent = `# id: ${peerId}\n# added: ${new Date().toISOString()}\n${peerRecipient}\n`;
  const peer: PeerIdentity = {
    identityString: peerIdentityString,
    publicKey: peerRecipient,
    id: peerId,
    pubContent,
  };

  // IMPORTANT: Encrypt to the own identity ONLY. The recipients dir is
  // empty at this point, so the default encrypt target is just the own
  // identity. We write the peer's .pub file later, per-test.
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

/** Write the peer's .pub file into the recipients dir. */
async function writePeerPub(fx: Fixture): Promise<string> {
  const recipientsDir = join(fx.identityDir, "recipients");
  await mkdir(recipientsDir, { recursive: true });
  const pubPath = join(recipientsDir, `${fx.peer.id}.pub`);
  await writeFile(pubPath, fx.peer.pubContent, "utf-8");
  return pubPath;
}

/** Remove a file if it exists (non-throwing). */
async function rmIfExists(p: string): Promise<void> {
  try {
    await (await import("node:fs/promises")).unlink(p);
  } catch {
    /* ok */
  }
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

async function invokeFinalize(args: Record<string, unknown>): Promise<void> {
  const full = {
    "dry-run": false,
    "no-rewrap": false,
    force: false,
    json: false,
    quiet: false,
    verbose: false,
    ...args,
  };
  await (
    pairFinalizeCommand as unknown as {
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

describe("ADR-0047 `am pair finalize` — Wave T sub-task T2", () => {
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
    void stderrLines;
  });

  // Gate 1: Happy path — .pub exists, finalize runs, peer can decrypt.
  test("registers the new recipient and rewraps envelopes so the peer can decrypt", async () => {
    // Place the peer's .pub in recipients/, simulating what pair accept
    // would have committed and what we would have pulled.
    await writePeerPub(fx);

    // Pre-condition: peer CANNOT decrypt the starting envelope (only
    // encrypted to the own identity).
    await expect(decryptWithIdentity(fx.initialEnvelope, fx.peer.identityString)).rejects.toThrow();

    await invokeFinalize({ file: fx.tomlPath, name: fx.peer.id, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // The envelope was rewrapped — ciphertext differs from the initial.
    const rewrapped = await readEnvelope(fx.tomlPath);
    expect(rewrapped.startsWith(AGE_PREFIX)).toBe(true);
    expect(rewrapped).not.toBe(fx.initialEnvelope);

    // Own identity still decrypts.
    const pt = await decryptWithIdentity(rewrapped, fx.ownIdentityString);
    expect(pt).toBe("fixture-plaintext");

    // Peer identity NOW decrypts — this is the negative-proof pattern.
    const ptPeer = await decryptWithIdentity(rewrapped, fx.peer.identityString);
    expect(ptPeer).toBe("fixture-plaintext");

    // JSON payload carries the required fields.
    const payload = jsonFromStdout();
    expect(payload.action).toBe("pair-finalize");
    expect(payload.name).toBe(fx.peer.id);
    expect(payload.publicKey).toBe(fx.peer.publicKey);
    expect(Number(payload.rewrapped)).toBeGreaterThanOrEqual(1);
  });

  // Gate 2: Missing pub file → exits non-zero.
  test("exits non-zero with actionable error when recipients/<name>.pub does not exist", async () => {
    // Do NOT write the .pub file — the command should fail because
    // recipients/<name>.pub is missing.

    await invokeFinalize({ file: fx.tomlPath, name: fx.peer.id, json: true });
    expect(process.exitCode).toBe(1);

    // The error is reported via amError to stderr, so check stderr.
    const stderrText = stderrLines.join("\n");
    expect(stderrText).toMatch(/not found/i);
    expect(stderrText).toContain(fx.peer.id);

    // Envelope untouched.
    const env = await readEnvelope(fx.tomlPath);
    expect(env).toBe(fx.initialEnvelope);
  });

  // Gate 3: Malformed pub file → exits non-zero.
  test("exits non-zero when the .pub file does not contain an age1... key", async () => {
    // Write a malformed .pub file.
    const recipientsDir = join(fx.identityDir, "recipients");
    await mkdir(recipientsDir, { recursive: true });
    const pubPath = join(recipientsDir, `${fx.peer.id}.pub`);
    await writeFile(pubPath, "not-an-age-key\n", "utf-8");

    await invokeFinalize({ file: fx.tomlPath, name: fx.peer.id, json: true });
    expect(process.exitCode).toBe(1);

    // The error is reported via amError to stderr.
    const stderrText = stderrLines.join("\n");
    expect(stderrText).toMatch(/invalid/i);
    expect(stderrText).toContain(pubPath);

    // Envelope untouched.
    const env = await readEnvelope(fx.tomlPath);
    expect(env).toBe(fx.initialEnvelope);
  });

  // Gate 4: Idempotent re-finalize (was "exits non-zero when already
  // registered" but the corrected ADR-0047 semantics make finalize
  // idempotent — running it twice is harmless and produces fresh
  // ciphertext each time).
  test("re-finalize is idempotent: second call succeeds and re-rewraps", async () => {
    // Write the peer .pub and run first finalize.
    await writePeerPub(fx);
    await invokeFinalize({ file: fx.tomlPath, name: fx.peer.id, json: true });
    expect(process.exitCode ?? 0).toBe(0);
    const firstEnvelope = await readEnvelope(fx.tomlPath);

    // Second finalize: succeeds; ciphertext changes (fresh ephemeral
    // key per age encrypt) but plaintext recovers.
    stdoutLines = [];
    process.exitCode = 0;
    await invokeFinalize({ file: fx.tomlPath, name: fx.peer.id, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const secondEnvelope = await readEnvelope(fx.tomlPath);
    expect(secondEnvelope).not.toBe(firstEnvelope);
    expect(secondEnvelope.startsWith(AGE_PREFIX)).toBe(true);

    // Peer can still decrypt after second finalize.
    const peerPlaintext = await decryptWithIdentity(secondEnvelope, fx.peer.identityString);
    expect(peerPlaintext).toBe("fixture-plaintext");
  });

  // Gate 5: --no-rewrap: registers recipient, skips rewrap.
  test("--no-rewrap registers the recipient but does not rewrap envelopes", async () => {
    await writePeerPub(fx);

    await invokeFinalize({ file: fx.tomlPath, name: fx.peer.id, "no-rewrap": true, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // Recipient registered.
    const recipientsDir = join(fx.identityDir, "recipients");
    const listing = await readdir(recipientsDir);
    expect(listing).toContain(`${fx.peer.id}.pub`);

    // Envelope NOT rewrapped — identical to initial.
    const env = await readEnvelope(fx.tomlPath);
    expect(env).toBe(fx.initialEnvelope);

    // Peer still CANNOT decrypt (no rewrap happened).
    await expect(decryptWithIdentity(fx.initialEnvelope, fx.peer.identityString)).rejects.toThrow();

    const payload = jsonFromStdout();
    expect(payload.action).toBe("pair-finalize");
    expect(payload.no_rewrap).toBe(true);
    expect(Number(payload.rewrapped)).toBe(0);
  });

  // Gate 6: --dry-run writes nothing.
  test("--dry-run reports planned operations without mutating disk", async () => {
    await writePeerPub(fx);

    const beforeToml = await readFile(fx.tomlPath, "utf-8");
    const recipientsDir = join(fx.identityDir, "recipients");
    const beforeListing = (await readdir(recipientsDir)).sort();

    await invokeFinalize({
      file: fx.tomlPath,
      name: fx.peer.id,
      "dry-run": true,
      json: true,
    });
    expect(process.exitCode ?? 0).toBe(0);

    // No mutations: TOML identical, .pub still on disk.
    const afterToml = await readFile(fx.tomlPath, "utf-8");
    expect(afterToml).toBe(beforeToml);
    const afterListing = (await readdir(recipientsDir)).sort();
    expect(afterListing).toEqual(beforeListing);

    // Envelope identical.
    const env = await readEnvelope(fx.tomlPath);
    expect(env).toBe(fx.initialEnvelope);
  });

  // Gate 7: --json --dry-run emits a valid DryRunEnvelope (ADR-0038).
  test("--json --dry-run emits a DryRunEnvelope (ADR-0038)", async () => {
    await writePeerPub(fx);

    await invokeFinalize({
      file: fx.tomlPath,
      name: fx.peer.id,
      "dry-run": true,
      json: true,
    });
    expect(process.exitCode ?? 0).toBe(0);

    const payload = jsonFromStdout();
    expect(isDryRunEnvelope(payload)).toBe(true);
    expect(payload.action).toBe("pair-finalize");
    expect(payload.reads_only).toBe(true);

    const wouldDo = payload.would_do as string[];
    expect(Array.isArray(wouldDo)).toBe(true);
    expect(wouldDo.some((s) => s.includes("register") || s.includes("rewrap"))).toBe(true);

    const prevented = payload.mutations_prevented as string[];
    expect(Array.isArray(prevented)).toBe(true);
    expect(prevented.length).toBeGreaterThan(0);

    const explanation = payload.explanation as Record<string, unknown>;
    expect(explanation.name).toBe(fx.peer.id);
    expect(explanation.publicKey).toBe(fx.peer.publicKey);
  });
});
