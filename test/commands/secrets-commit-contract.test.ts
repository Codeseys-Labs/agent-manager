import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateIdentity, identityToRecipient } from "age-encryption";
import git from "isomorphic-git";
import { secretsRevokeCommand } from "../../src/commands/secrets-revoke";
import { secretsRewrapCommand } from "../../src/commands/secrets-rewrap";
import { secretsRotateCommand } from "../../src/commands/secrets-rotate";
import { commitAll, initRepo } from "../../src/core/git";
import { AgeSecretsBackend } from "../../src/core/secrets-age";
import { type TestDir, createTestDir } from "../helpers/tmp";

// age scrypt identity wrapping is slow under CI coverage; the 5s default
// would time out and leak global state across the shared bun process. See
// pair-finalize.test.ts for the full rationale. (Wave CI / P0-5.)
setDefaultTimeout(30_000);

interface Fixture {
  dir: TestDir;
  identityDir: string;
  tomlPath: string;
  passphrase: string;
  peer?: { id: string; publicKey: string };
}

const SCOPED_ENV_KEYS = [
  "AM_CONFIG_DIR",
  "AM_AGE_IDENTITY_DIR",
  "AM_AGE_PASSPHRASE",
  "AM_AGE_NEW_PASSPHRASE",
  "AM_SECRETS_BACKEND",
  "AM_KEY_PATH",
] as const;

const fixtures: Fixture[] = [];
let envSnap: Record<string, string | undefined> | null = null;

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

async function makeFixture(mode: "single" | "rewrap" | "revoke" = "single"): Promise<Fixture> {
  const dir = await createTestDir("am-secrets-commit-");
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

  let peer: Fixture["peer"];
  if (mode === "revoke") {
    const identityString = await generateIdentity();
    const publicKey = await identityToRecipient(identityString);
    peer = { id: "peer-alice", publicKey };
    await backend.addRecipient({ id: peer.id, publicKey, addedAt: new Date().toISOString() });
  }

  const envelope = await backend.encrypt("fixture-plaintext");

  if (mode === "rewrap") {
    const identityString = await generateIdentity();
    const publicKey = await identityToRecipient(identityString);
    peer = { id: "peer-bob", publicKey };
    await backend.addRecipient({ id: peer.id, publicKey, addedAt: new Date().toISOString() });
  }

  await writeFile(
    join(dir.path, "config.toml"),
    `[settings.secrets]
backend = "age"

[settings.secrets.rotation]
grace_period_days = 14
`,
    "utf-8",
  );
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

  await initRepo(dir.path);
  await commitAll(dir.path, "baseline: fixture");

  const fx = { dir, identityDir, tomlPath, passphrase, peer };
  fixtures.push(fx);
  return fx;
}

function activate(fx: Fixture): void {
  process.env.AM_CONFIG_DIR = fx.dir.path;
  process.env.AM_AGE_IDENTITY_DIR = fx.identityDir;
  process.env.AM_AGE_PASSPHRASE = fx.passphrase;
  process.env.AM_AGE_NEW_PASSPHRASE = undefined;
  process.env.AM_SECRETS_BACKEND = "age";
  process.exitCode = 0;
}

async function head(dir: string): Promise<{ oid: string; message: string }> {
  const [entry] = await git.log({ fs, dir, depth: 1 });
  return { oid: entry.oid, message: entry.commit.message.trim() };
}

async function invokeRewrap(args: Record<string, unknown>): Promise<void> {
  await (
    secretsRewrapCommand as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
    }
  ).run({
    args: {
      "dry-run": false,
      "no-backup": true,
      json: true,
      quiet: false,
      verbose: false,
      ...args,
    },
  });
}

async function invokeRotate(args: Record<string, unknown>): Promise<void> {
  await (
    secretsRotateCommand as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
    }
  ).run({
    args: {
      finalize: false,
      force: false,
      "dry-run": false,
      "no-backup": true,
      json: true,
      quiet: false,
      verbose: false,
      ...args,
    },
  });
}

async function invokeRevoke(args: Record<string, unknown>): Promise<void> {
  await (
    secretsRevokeCommand as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<void>;
    }
  ).run({
    args: {
      "dry-run": false,
      "no-backup": true,
      json: true,
      quiet: false,
      verbose: false,
      ...args,
    },
  });
}

describe("ADR-0051 secrets verbs auto-commit contract", () => {
  afterEach(async () => {
    process.exitCode = 0;
    if (envSnap) restoreEnv(envSnap);
    envSnap = null;
    for (const fx of fixtures.splice(0)) await fx.dir.cleanup();
  });

  test("rewrap commits a successful live run and --dry-run does not commit", async () => {
    envSnap = snapshotEnv();
    const live = await makeFixture("rewrap");
    activate(live);
    const before = await head(live.dir.path);
    await invokeRewrap({ file: live.tomlPath });
    expect(process.exitCode ?? 0).toBe(0);
    const after = await head(live.dir.path);
    expect(after.oid).not.toBe(before.oid);
    expect(after.message).toBe("secrets(rewrap): re-encrypt 1 file(s) to current recipients");

    const dry = await makeFixture("rewrap");
    activate(dry);
    const dryBefore = await head(dry.dir.path);
    await invokeRewrap({ file: dry.tomlPath, "dry-run": true });
    expect(process.exitCode ?? 0).toBe(0);
    const dryAfter = await head(dry.dir.path);
    expect(dryAfter.oid).toBe(dryBefore.oid);
  }, 30_000);

  test("rotate commits a successful live run and --dry-run does not commit", async () => {
    envSnap = snapshotEnv();
    const live = await makeFixture("single");
    activate(live);
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-rotate-live";
    const before = await head(live.dir.path);
    await invokeRotate({ file: live.tomlPath });
    expect(process.exitCode ?? 0).toBe(0);
    const after = await head(live.dir.path);
    expect(after.oid).not.toBe(before.oid);
    expect(after.message).toBe(
      "secrets(rotate): generate new identity + dual-encrypt for grace_period_days=14",
    );

    const dry = await makeFixture("single");
    activate(dry);
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-rotate-dry";
    const dryBefore = await head(dry.dir.path);
    await invokeRotate({ file: dry.tomlPath, "dry-run": true });
    expect(process.exitCode ?? 0).toBe(0);
    const dryAfter = await head(dry.dir.path);
    expect(dryAfter.oid).toBe(dryBefore.oid);
  }, 30_000);

  test("rotate --finalize commits a successful live run and --dry-run does not commit", async () => {
    envSnap = snapshotEnv();
    const live = await makeFixture("single");
    activate(live);
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-finalize-live";
    await invokeRotate({ file: live.tomlPath });
    expect(process.exitCode ?? 0).toBe(0);
    process.env.AM_AGE_PASSPHRASE = "new-pw-finalize-live";
    const before = await head(live.dir.path);
    await invokeRotate({ file: live.tomlPath, finalize: true, force: true });
    expect(process.exitCode ?? 0).toBe(0);
    const after = await head(live.dir.path);
    expect(after.oid).not.toBe(before.oid);
    expect(after.message).toBe(
      "secrets(rotate --finalize): drop old recipient + identity, 1 envelope(s) to new-only",
    );

    const dry = await makeFixture("single");
    activate(dry);
    process.env.AM_AGE_NEW_PASSPHRASE = "new-pw-finalize-dry";
    await invokeRotate({ file: dry.tomlPath });
    expect(process.exitCode ?? 0).toBe(0);
    process.env.AM_AGE_PASSPHRASE = "new-pw-finalize-dry";
    const dryBefore = await head(dry.dir.path);
    await invokeRotate({ file: dry.tomlPath, finalize: true, force: true, "dry-run": true });
    expect(process.exitCode ?? 0).toBe(0);
    const dryAfter = await head(dry.dir.path);
    expect(dryAfter.oid).toBe(dryBefore.oid);
  }, 45_000);

  test("revoke commits a successful live run and --dry-run does not commit", async () => {
    envSnap = snapshotEnv();
    const live = await makeFixture("revoke");
    activate(live);
    const before = await head(live.dir.path);
    await invokeRevoke({ fingerprint: live.peer!.id, file: live.tomlPath });
    expect(process.exitCode ?? 0).toBe(0);
    const after = await head(live.dir.path);
    expect(after.oid).not.toBe(before.oid);
    expect(after.message).toMatch(
      /^secrets\(revoke\): remove recipient [0-9a-f]{10}, rewrap 1 file\(s\)$/,
    );

    const dry = await makeFixture("revoke");
    activate(dry);
    const dryBefore = await head(dry.dir.path);
    await invokeRevoke({ fingerprint: dry.peer!.id, file: dry.tomlPath, "dry-run": true });
    expect(process.exitCode ?? 0).toBe(0);
    const dryAfter = await head(dry.dir.path);
    expect(dryAfter.oid).toBe(dryBefore.oid);
  }, 30_000);
});
