/**
 * ADR-0047 DWL-T4 #2 — `am pair finalize` (no positional argument).
 *
 * Auto-detect mode: scans `recipients/*.pub`, compares against
 * `.am-secrets.toml` `[age].recipients`, and finalizes the delta.
 *
 * Gates:
 *   1. No new recipients (covered set already complete) -> exit 0,
 *      no-op message, no mutations.
 *   2. One uncovered recipient -> rewrap happens; TOML array updated;
 *      peer can decrypt the rewrapped envelope.
 *   3. Two uncovered recipients -> both processed in stable order;
 *      TOML array contains both, in lexicographic order.
 *   4. `--dry-run` reports planned changes without mutating disk.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { pairFinalizeCommand } from "../../src/commands/pair-finalize";
import { AgeSecretsBackend } from "../../src/core/secrets-age";
import { isDryRunEnvelope } from "../../src/lib/dry-run-envelope";
import { type TestDir, createTestDir } from "../helpers/tmp";

// age scrypt identity wrapping is slow under CI coverage; the 5s default
// would time out and leak global state across the shared bun process. See
// pair-finalize.test.ts for the full rationale. (Wave CI / P0-5.)
setDefaultTimeout(30_000);

const AGE_PREFIX = "enc:v2:age:";

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

interface PeerIdentity {
  identityString: string;
  publicKey: string;
  id: string;
  pubContent: string;
}

interface Fixture {
  dir: TestDir;
  identityDir: string;
  recipientsDir: string;
  tomlPath: string;
  passphrase: string;
  ownIdentityString: string;
  ownRecipient: string;
  initialEnvelope: string;
}

async function makeFixture(): Promise<Fixture> {
  const dir = await createTestDir("am-pair-finalize-auto-");
  const identityDir = join(dir.path, "identities");
  const recipientsDir = join(identityDir, "recipients");
  const tomlPath = join(dir.path, "fixture.toml");
  const passphrase = `pw-${Math.random().toString(36).slice(2, 10)}`;

  const memStore = new Map<string, string>();
  const backend = new AgeSecretsBackend({
    identityPath: join(identityDir, "identity.age"),
    recipientsDir,
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

  const envelope = await backend.encrypt("auto-fixture-plaintext");

  const configToml = `[settings.secrets]\nbackend = "age"\n`;
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

  const wrapped = await readFile(join(identityDir, "identity.age"));
  const d = new Decrypter();
  d.addPassphrase(passphrase);
  const ownIdentityString = await d.decrypt(new Uint8Array(wrapped), "text");

  return {
    dir,
    identityDir,
    recipientsDir,
    tomlPath,
    passphrase,
    ownIdentityString,
    ownRecipient,
    initialEnvelope: envelope,
  };
}

async function makePeer(id: string): Promise<PeerIdentity> {
  const identityString = await generateIdentity();
  const publicKey = await identityToRecipient(identityString);
  const pubContent = `# id: ${id}\n# added: ${new Date().toISOString()}\n${publicKey}\n`;
  return { identityString, publicKey, id, pubContent };
}

async function writePeerPub(fx: Fixture, peer: PeerIdentity): Promise<string> {
  await mkdir(fx.recipientsDir, { recursive: true });
  const pubPath = join(fx.recipientsDir, `${peer.id}.pub`);
  await writeFile(pubPath, peer.pubContent, "utf-8");
  return pubPath;
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

async function readSecretsToml(dir: string): Promise<{ age?: { recipients?: string[] } }> {
  const raw = await readFile(join(dir, ".am-secrets.toml"), "utf-8");
  return TOML.parse(raw) as { age?: { recipients?: string[] } };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function invokeFinalize(args: Record<string, unknown>): Promise<void> {
  const full = {
    "dry-run": false,
    "no-rewrap": false,
    "no-pull": true,
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

describe("ADR-0047 `am pair finalize` (autodetect, DWL-T4 #2)", () => {
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
    void fx.ownIdentityString;
    void fx.ownRecipient;
  });

  test("exit 0 with no-op message when there are no uncovered recipients", async () => {
    const peer = await makePeer("laptop-2");
    await writePeerPub(fx, peer);
    await writeFile(
      join(fx.dir.path, ".am-secrets.toml"),
      `[age]\nrecipients = ["recipients/laptop-2.pub"]\n`,
      "utf-8",
    );

    const beforeEnvelope = await readEnvelope(fx.tomlPath);
    await invokeFinalize({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const payload = jsonFromStdout();
    expect(payload.action).toBe("pair-finalize");
    expect(payload.mode).toBe("autodetect");
    expect(payload.new_recipients).toEqual([]);
    expect(payload.message).toMatch(/no new recipients/i);

    const afterEnvelope = await readEnvelope(fx.tomlPath);
    expect(afterEnvelope).toBe(beforeEnvelope);
  });

  test("exit 0 when no .pub files exist on disk at all", async () => {
    expect(await pathExists(fx.recipientsDir)).toBe(false);
    await invokeFinalize({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const payload = jsonFromStdout();
    expect(payload.new_recipients).toEqual([]);
  });

  test("one uncovered recipient is finalized: rewrap happens, TOML updated", async () => {
    const peer = await makePeer("laptop-2");
    await writePeerPub(fx, peer);

    await invokeFinalize({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const rewrapped = await readEnvelope(fx.tomlPath);
    expect(rewrapped.startsWith(AGE_PREFIX)).toBe(true);
    expect(rewrapped).not.toBe(fx.initialEnvelope);

    const pt = await decryptWithIdentity(rewrapped, peer.identityString);
    expect(pt).toBe("auto-fixture-plaintext");

    const parsed = await readSecretsToml(fx.dir.path);
    expect(parsed.age?.recipients).toEqual(["recipients/laptop-2.pub"]);

    const payload = jsonFromStdout();
    expect(payload.mode).toBe("autodetect");
    expect(payload.new_recipients).toEqual(["laptop-2"]);
    expect(payload.recipient_paths).toEqual(["recipients/laptop-2.pub"]);
    expect(Number(payload.rewrapped)).toBeGreaterThanOrEqual(1);
    expect(payload.secretsTomlChanged).toBe(true);
  });

  test("two uncovered recipients are finalized in stable lexicographic order", async () => {
    const peerA = await makePeer("desktop-3");
    const peerB = await makePeer("laptop-2");
    await writePeerPub(fx, peerA);
    await writePeerPub(fx, peerB);

    await invokeFinalize({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const parsed = await readSecretsToml(fx.dir.path);
    expect(parsed.age?.recipients).toEqual(["recipients/desktop-3.pub", "recipients/laptop-2.pub"]);

    const rewrapped = await readEnvelope(fx.tomlPath);
    expect(await decryptWithIdentity(rewrapped, peerA.identityString)).toBe(
      "auto-fixture-plaintext",
    );
    expect(await decryptWithIdentity(rewrapped, peerB.identityString)).toBe(
      "auto-fixture-plaintext",
    );

    const payload = jsonFromStdout();
    expect(payload.new_recipients).toEqual(["desktop-3", "laptop-2"]);
  });

  test("only the delta is finalized when some recipients are already covered", async () => {
    const peerA = await makePeer("desktop-3");
    const peerB = await makePeer("laptop-2");
    await writePeerPub(fx, peerA);
    await writePeerPub(fx, peerB);

    await writeFile(
      join(fx.dir.path, ".am-secrets.toml"),
      `[age]\nrecipients = ["recipients/desktop-3.pub"]\n`,
      "utf-8",
    );

    await invokeFinalize({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const payload = jsonFromStdout();
    expect(payload.new_recipients).toEqual(["laptop-2"]);

    const parsed = await readSecretsToml(fx.dir.path);
    expect(parsed.age?.recipients).toEqual(["recipients/desktop-3.pub", "recipients/laptop-2.pub"]);
  });

  test("--dry-run reports planned changes and writes nothing", async () => {
    const peer = await makePeer("laptop-2");
    await writePeerPub(fx, peer);

    const beforeEnvelope = await readEnvelope(fx.tomlPath);

    await invokeFinalize({ file: fx.tomlPath, "dry-run": true, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    expect(await pathExists(join(fx.dir.path, ".am-secrets.toml"))).toBe(false);
    expect(await readEnvelope(fx.tomlPath)).toBe(beforeEnvelope);

    const payload = jsonFromStdout();
    expect(isDryRunEnvelope(payload)).toBe(true);
    expect(payload.action).toBe("pair-finalize");
    expect(payload.mode).toBe("autodetect");
    expect(payload.reads_only).toBe(true);
    const explanation = payload.explanation as Record<string, unknown>;
    expect(explanation.new_recipients).toEqual(["laptop-2"]);
  });

  test("ignores the _rotation-old.pub sidecar during autodetect", async () => {
    const peer = await makePeer("laptop-2");
    await writePeerPub(fx, peer);

    await mkdir(fx.recipientsDir, { recursive: true });
    await writeFile(
      join(fx.recipientsDir, "_rotation-old.pub"),
      "# id: _rotation-old\nage1rotationoldfakepublickey00000000000000000000000\n",
      "utf-8",
    );

    await invokeFinalize({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const parsed = await readSecretsToml(fx.dir.path);
    expect(parsed.age?.recipients).toEqual(["recipients/laptop-2.pub"]);
  });
});
