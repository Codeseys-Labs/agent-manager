/**
 * ADR-0051 — `am secrets rewrap` skip-handling.
 *
 * `am secrets rewrap` re-encrypts every `enc:v2:age:` envelope in the
 * discovered TOMLs to the CURRENT recipient set. Historically it
 * computed only `totalFound`/`totalRewrapped`, never read the per-file
 * `skipped` count, and ALWAYS exited 0 — so a partial rewrap (some
 * envelopes left wrapped to the old recipient set) printed
 * "Total: 3/5 rewrapped" with exit 0 and no signal that 2 are now out
 * of sync with `recipients/`.
 *
 * These tests assert the fix: a forced-skip scenario now exits
 * non-zero, surfaces the skipped file(s), and the happy path still
 * exits 0. Mirrors the fixture + console-capture pattern of
 * `secrets-rotate.test.ts` / `secrets-revoke.test.ts` so reviewers only
 * have to learn one test shape across the four age-verbs.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { secretsRewrapCommand } from "../../src/commands/secrets-rewrap";
import { AgeSecretsBackend } from "../../src/core/secrets-age";
import { type TestDir, createTestDir } from "../helpers/tmp";

// age scrypt identity wrapping is slow under CI coverage; the 5s default
// would time out and leak global state across the shared bun process.
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

interface Fixture {
  dir: TestDir;
  identityDir: string;
  tomlPath: string;
  passphrase: string;
  initialEnvelope: string;
}

async function makeFixture(): Promise<Fixture> {
  const dir = await createTestDir("am-secrets-rewrap-");
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

  return { dir, identityDir, tomlPath, passphrase, initialEnvelope: envelope };
}

async function invokeRewrap(args: Record<string, unknown>): Promise<void> {
  const full = {
    "dry-run": false,
    "no-backup": false,
    json: false,
    quiet: false,
    verbose: false,
    ...args,
  };
  await (
    secretsRewrapCommand as unknown as {
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

describe("ADR-0051 `am secrets rewrap` — skip handling", () => {
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

  // Happy path: every envelope rewraps → exit 0.
  test("rewrap with no skips exits 0 and reports all envelopes rewrapped", async () => {
    await invokeRewrap({ file: fx.tomlPath, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const payload = jsonFromStdout();
    expect(payload.action).toBe("rewrap");
    expect(payload.error).toBeUndefined();
    const totals = payload.totals as Record<string, number>;
    expect(totals.found).toBeGreaterThanOrEqual(1);
    expect(totals.rewrapped).toBe(totals.found);
    expect(totals.skipped).toBe(0);
  });

  // Skip path: a corrupted envelope can't be rewrapped → exit 1 + warning.
  test("rewrap with a skipped (corrupt) envelope exits non-zero and surfaces the skipped file", async () => {
    // Inject a corrupted age envelope alongside the legitimate one. The
    // rewrap walker tries `backend.rewrap()`, fails to decrypt, bumps
    // `skipped`, and writes the ORIGINAL value back — which the command
    // must now treat as a partial failure (exit non-zero + warn).
    const tomlBefore = await readFile(fx.tomlPath, "utf-8");
    const corrupted = `${AGE_PREFIX}AAAAcorruptedpayloadthatcannotbedecryptedAAAA==`;
    const tomlWithBadEnv = tomlBefore.replace(
      /(\s*\[servers\.test\.env\]\s*\n)(\s*SECRET\s*=\s*"[^"]+"\s*\n)/,
      (_m, header, secLine) =>
        `${header}${secLine}${secLine.replace(/SECRET/, "BROKEN").replace(/"[^"]+"/, `"${corrupted}"`)}`,
    );
    expect(tomlWithBadEnv).not.toBe(tomlBefore);
    await writeFile(fx.tomlPath, tomlWithBadEnv, "utf-8");

    await invokeRewrap({ file: fx.tomlPath, json: true });

    // Partial rewrap → non-zero exit.
    expect(process.exitCode).toBe(1);

    const payload = jsonFromStdout();
    expect(payload.action).toBe("rewrap");
    const totals = payload.totals as Record<string, number>;
    expect(totals.skipped).toBeGreaterThanOrEqual(1);
    // The error/warning surfaces the skip and the offending file path.
    expect(typeof payload.error).toBe("string");
    expect(String(payload.error)).toMatch(/incomplete|skipped|out of sync/i);
    expect(String(payload.error)).toContain(fx.tomlPath);
  });

  // Dry-run never mutates → a skip there is informational, exit stays 0.
  test("rewrap --dry-run does not flip the exit code even with a corrupt envelope", async () => {
    const tomlBefore = await readFile(fx.tomlPath, "utf-8");
    const corrupted = `${AGE_PREFIX}AAAAcorruptedpayloadthatcannotbedecryptedAAAA==`;
    const tomlWithBadEnv = tomlBefore.replace(
      /(\s*\[servers\.test\.env\]\s*\n)(\s*SECRET\s*=\s*"[^"]+"\s*\n)/,
      (_m, header, secLine) =>
        `${header}${secLine}${secLine.replace(/SECRET/, "BROKEN").replace(/"[^"]+"/, `"${corrupted}"`)}`,
    );
    await writeFile(fx.tomlPath, tomlWithBadEnv, "utf-8");

    await invokeRewrap({ file: fx.tomlPath, "dry-run": true, json: true });
    expect(process.exitCode ?? 0).toBe(0);
  });
});
