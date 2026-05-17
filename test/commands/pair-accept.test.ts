/**
 * ADR-0047 Wave T sub-task T1 — `am pair accept <name>`.
 *
 * Gates covered here (per the task brief):
 *   1. fresh accept: identity.age + recipients/<name>.pub are created.
 *   2. duplicate <name>: exits non-zero with actionable error.
 *   3. duplicate + --force: overwrites successfully.
 *   4. --dry-run: nothing is written; planned ops reported.
 *   5. --json + --dry-run: emits a valid DryRunEnvelope (ADR-0038).
 *   6. invalid name (contains '/' or '..'): rejected at arg parsing.
 *
 * Follows the console-capture + env-scoping pattern established by
 * `test/commands/secrets-revoke.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { pairAcceptCommand } from "../../src/commands/pair-accept";
import { isDryRunEnvelope } from "../../src/lib/dry-run-envelope";
import { type TestDir, createTestDir } from "../helpers/tmp";

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

// ── Fixture ──────────────────────────────────────────────────────

interface Fixture {
  dir: TestDir;
  identityDir: string;
  identityPath: string;
  recipientsDir: string;
  passphrase: string;
}

async function makeFixture(): Promise<Fixture> {
  const dir = await createTestDir("am-pair-accept-");
  const identityDir = join(dir.path, "identities");
  const identityPath = join(identityDir, "identity.age");
  const recipientsDir = join(identityDir, "recipients");
  const passphrase = `pw-${Math.random().toString(36).slice(2, 10)}`;

  // Minimal config.toml selecting the age backend.
  await dir.write("config.toml", `[settings.secrets]\nbackend = "age"\n`);

  return { dir, identityDir, identityPath, recipientsDir, passphrase };
}

async function invokePair(args: Record<string, unknown>): Promise<void> {
  const full = {
    "dry-run": false,
    force: false,
    json: false,
    quiet: false,
    verbose: false,
    ...args,
  };
  await (
    pairAcceptCommand as unknown as {
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

async function pathExists(p: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("ADR-0047 `am pair accept` — Wave T T1", () => {
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

  // Gate 1: fresh accept — both identity.age and recipients/<name>.pub created.
  test("fresh accept creates identity.age and writes recipients/<name>.pub", async () => {
    expect(await pathExists(fx.identityPath)).toBe(false);
    expect(await pathExists(fx.recipientsDir)).toBe(false);

    await invokePair({ name: "laptop-2", json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // Identity file exists (generated by backend.initialize()).
    expect(await pathExists(fx.identityPath)).toBe(true);

    // .pub exists at the expected location and is well-formed.
    const pubPath = join(fx.recipientsDir, "laptop-2.pub");
    expect(await pathExists(pubPath)).toBe(true);
    const body = await readFile(pubPath, "utf-8");
    expect(body).toMatch(/^# id: laptop-2$/m);
    const ageLine = body.split(/\r?\n/).find((l) => l.startsWith("age1"));
    expect(typeof ageLine).toBe("string");
    expect(ageLine!.startsWith("age1")).toBe(true);

    // JSON payload carries the file paths + recipient.
    const payload = jsonFromStdout();
    expect(payload.action).toBe("pair-accept");
    expect(payload.name).toBe("laptop-2");
    expect(payload.pubPath).toBe(pubPath);
    expect(payload.identityPath).toBe(fx.identityPath);
    expect(typeof payload.recipient).toBe("string");
    expect(String(payload.recipient).startsWith("age1")).toBe(true);
  });

  // Gate 2: duplicate name without --force → non-zero exit + actionable error.
  test("duplicate <name> without --force exits non-zero with actionable error", async () => {
    // First accept succeeds.
    await invokePair({ name: "laptop-2", json: true });
    expect(process.exitCode ?? 0).toBe(0);
    stdoutLines = [];
    stderrLines = [];

    // Second accept with the same name → must fail.
    await invokePair({ name: "laptop-2", json: true });
    expect(process.exitCode).toBe(1);

    const errorText = stderrLines.join("\n");
    expect(errorText).toMatch(/already exists/i);
    expect(errorText).toMatch(/--force/);
    expect(errorText).toContain("laptop-2");
  });

  // Gate 3: --force overwrites the existing .pub.
  test("duplicate <name> with --force overwrites successfully", async () => {
    await invokePair({ name: "laptop-2", json: true });
    expect(process.exitCode ?? 0).toBe(0);
    const pubPath = join(fx.recipientsDir, "laptop-2.pub");
    const firstBody = await readFile(pubPath, "utf-8");

    stdoutLines = [];
    stderrLines = [];
    await invokePair({ name: "laptop-2", force: true, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // The file still exists (identity is the same since identity.age is
    // already present, so the recipient line matches). The "added"
    // timestamp line may differ; assert the file is still structurally
    // valid rather than byte-identical.
    const secondBody = await readFile(pubPath, "utf-8");
    expect(secondBody).toMatch(/^# id: laptop-2$/m);
    const secondAge = secondBody.split(/\r?\n/).find((l) => l.startsWith("age1"));
    const firstAge = firstBody.split(/\r?\n/).find((l) => l.startsWith("age1"));
    expect(secondAge).toBe(firstAge);

    const payload = jsonFromStdout();
    expect(payload.overwritten).toBe(true);
  });

  // Gate 4: --dry-run writes nothing.
  test("--dry-run writes no files and reports planned ops", async () => {
    await invokePair({ name: "laptop-2", "dry-run": true });
    expect(process.exitCode ?? 0).toBe(0);

    // No identity file, no recipients directory.
    expect(await pathExists(fx.identityPath)).toBe(false);
    const pubPath = join(fx.recipientsDir, "laptop-2.pub");
    expect(await pathExists(pubPath)).toBe(false);
    // Either the recipients dir does not exist, or it exists and is empty.
    const recipientsExists = await pathExists(fx.recipientsDir);
    if (recipientsExists) {
      const listing = await readdir(fx.recipientsDir);
      expect(listing).toEqual([]);
    }

    // Non-json mode prints a "Would write ..." preview.
    const stdout = stdoutLines.join("\n");
    expect(stdout).toMatch(/would write/i);
    expect(stdout).toContain("laptop-2.pub");
  });

  // Gate 5: --dry-run --json emits a valid DryRunEnvelope (ADR-0038).
  test("--dry-run --json emits a valid DryRunEnvelope", async () => {
    await invokePair({ name: "laptop-2", "dry-run": true, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const payload = jsonFromStdout();
    expect(isDryRunEnvelope(payload)).toBe(true);
    expect(payload.action).toBe("pair-accept");
    expect(payload.reads_only).toBe(true);
    const wouldDo = payload.would_do as string[];
    expect(Array.isArray(wouldDo)).toBe(true);
    expect(wouldDo.join(" ")).toMatch(/recipients\/laptop-2\.pub/);
    const prevented = payload.mutations_prevented as string[];
    expect(prevented.length).toBeGreaterThan(0);

    const explanation = payload.explanation as Record<string, unknown>;
    expect(explanation.name).toBe("laptop-2");
    expect(explanation.identityExisted).toBe(false);
    expect(explanation.pubExisted).toBe(false);
  });

  // ADR-0047 DWL-T4 #1 — `[age].recipients` TOML round-trip.
  test("appends recipients/<name>.pub to .am-secrets.toml [age].recipients", async () => {
    await invokePair({ name: "laptop-2", json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const secretsTomlPath = join(fx.dir.path, ".am-secrets.toml");
    const raw = await readFile(secretsTomlPath, "utf-8");
    const parsed = TOML.parse(raw) as {
      age?: { recipients?: unknown };
    };
    expect(Array.isArray(parsed.age?.recipients)).toBe(true);
    expect(parsed.age?.recipients).toEqual(["recipients/laptop-2.pub"]);

    const payload = jsonFromStdout();
    expect(payload.secretsTomlPath).toBe(secretsTomlPath);
    expect(payload.secretsTomlChanged).toBe(true);
    expect(payload.recipientRelPath).toBe("recipients/laptop-2.pub");
  });

  test("--force re-accept does NOT duplicate the .am-secrets.toml entry", async () => {
    await invokePair({ name: "laptop-2", json: true });
    expect(process.exitCode ?? 0).toBe(0);
    stdoutLines = [];
    stderrLines = [];

    await invokePair({ name: "laptop-2", force: true, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const secretsTomlPath = join(fx.dir.path, ".am-secrets.toml");
    const raw = await readFile(secretsTomlPath, "utf-8");
    const parsed = TOML.parse(raw) as { age?: { recipients?: string[] } };
    expect(parsed.age?.recipients).toEqual(["recipients/laptop-2.pub"]);

    const payload = jsonFromStdout();
    expect(payload.secretsTomlChanged).toBe(false);
  });

  test("--dry-run reports the planned .am-secrets.toml append without writing it", async () => {
    await invokePair({ name: "laptop-2", "dry-run": true, json: true });
    expect(process.exitCode ?? 0).toBe(0);

    // .am-secrets.toml must NOT exist after dry-run.
    expect(await pathExists(join(fx.dir.path, ".am-secrets.toml"))).toBe(false);

    const payload = jsonFromStdout();
    expect(isDryRunEnvelope(payload)).toBe(true);
    const wouldDo = payload.would_do as string[];
    expect(wouldDo.join(" ")).toMatch(/\.am-secrets\.toml/);
    const prevented = payload.mutations_prevented as string[];
    expect(prevented.some((s) => s.includes(".am-secrets.toml"))).toBe(true);
  });

  test("multi-device accept appends each recipient in order", async () => {
    await invokePair({ name: "laptop-2", json: true });
    expect(process.exitCode ?? 0).toBe(0);
    stdoutLines = [];
    await invokePair({ name: "desktop-3", json: true });
    expect(process.exitCode ?? 0).toBe(0);

    const secretsTomlPath = join(fx.dir.path, ".am-secrets.toml");
    const raw = await readFile(secretsTomlPath, "utf-8");
    const parsed = TOML.parse(raw) as { age?: { recipients?: string[] } };
    expect(parsed.age?.recipients).toEqual(["recipients/laptop-2.pub", "recipients/desktop-3.pub"]);
  });

  // Gate 6: invalid name (contains '/' or '..') → rejected.
  test("invalid name containing '/' or '..' is rejected", async () => {
    // Path separator.
    await invokePair({ name: "foo/bar", json: true });
    expect(process.exitCode).toBe(1);
    let errorText = stderrLines.join("\n");
    expect(errorText).toMatch(/invalid name/i);

    // Reset exit code + streams for the second assertion.
    process.exitCode = 0;
    stdoutLines = [];
    stderrLines = [];

    // Parent traversal.
    await invokePair({ name: "..", json: true });
    expect(process.exitCode).toBe(1);
    errorText = stderrLines.join("\n");
    expect(errorText).toMatch(/invalid name/i);

    // Neither invocation should have touched the filesystem.
    expect(await pathExists(fx.identityPath)).toBe(false);
    const recipientsExists = await pathExists(fx.recipientsDir);
    if (recipientsExists) {
      const listing = await readdir(fx.recipientsDir);
      expect(listing).toEqual([]);
    }
  });
});
