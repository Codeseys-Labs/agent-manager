/**
 * ADR-0036 / DWL-T13: live-path enforcement of `variant.permission_policy`.
 *
 * Before this wiring, `am run` only used the `--no-auto-approve` CLI flag to
 * decide the ACP client's permission policy and ignored any variant-declared
 * policy. These tests assert the new precedence:
 *
 *   1. variant.permission_policy (when declared) overrides the CLI default
 *   2. otherwise fall back to --no-auto-approve → "deny", else "auto-approve"
 *
 * The live path goes through `client.connect(...)` which would normally spawn
 * a real subprocess. We swap `createAcpClient` via the test seam
 * (`__setRunAcpClientFactoryForTests`) and inject a fake client whose
 * `setPermissionPolicy` records its argument. The fake's `prompt` rejects to
 * bail out cleanly through the existing try/catch in runAgent — that surfaces
 * a non-zero process.exitCode, but the policy call has already happened by
 * then, which is what we're asserting on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { __setRunAcpClientFactoryForTests, runCommand } from "../../../src/commands/run";
import type { AmAcpClient } from "../../../src/protocols/acp/client";
import { type TestDir, createTestDir } from "../../helpers/tmp";

type RunArgs = Record<string, unknown>;

async function invokeRun(args: RunArgs): Promise<void> {
  await (runCommand as unknown as { run: (ctx: { args: RunArgs }) => Promise<void> }).run({ args });
}

// ── Console capture (silence runAgent's progress output) ──────

const origLog = console.log;
const origErr = console.error;
const origWrite = process.stdout.write.bind(process.stdout);

function captureConsole(): void {
  console.log = () => {};
  console.error = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
}

function restoreConsole(): void {
  console.log = origLog;
  console.error = origErr;
  process.stdout.write = origWrite;
}

// ── Fake client ───────────────────────────────────────────────

interface FakeClientRecord {
  policies: ("deny" | "auto-approve")[];
}

function makeFakeClient(record: FakeClientRecord): AmAcpClient {
  // Minimal stand-in for AmAcpClient. `setPermissionPolicy` records the
  // argument; `connect` and `newSession` resolve so runAgent reaches the
  // policy-set + prompt path; `prompt` rejects so we bail through the
  // existing try/catch/finally without spawning anything.
  const fake = {
    setPermissionPolicy(policy: "deny" | "auto-approve") {
      record.policies.push(policy);
    },
    setAllowedPaths(_paths: string[]) {},
    onSessionUpdate(_handler: unknown) {},
    async connect(_command: string, _opts?: unknown) {
      return { agentInfo: { name: "fake", version: "0.0.0" }, capabilities: {} };
    },
    async newSession(_opts: { cwd: string }) {
      return "fake-session-id";
    },
    async loadSession(_id: string, _opts: { cwd: string }) {
      throw new Error("fake: no such session");
    },
    async prompt(_sessionId: string, _content: unknown) {
      throw new Error("fake: prompt short-circuit (test bails here)");
    },
    async disconnect() {},
  };
  return fake as unknown as AmAcpClient;
}

// ── Suite ──────────────────────────────────────────────────────

describe("am run live-path permission policy (ADR-0036 / DWL-T13)", () => {
  let dir: TestDir;
  let record: FakeClientRecord;
  const originalConfigDir = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-run-perm-");
    process.env.AM_CONFIG_DIR = dir.path;
    record = { policies: [] };
    __setRunAcpClientFactoryForTests(() => makeFakeClient(record));
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    __setRunAcpClientFactoryForTests(null);
    process.exitCode = 0;
    if (originalConfigDir !== undefined) process.env.AM_CONFIG_DIR = originalConfigDir;
    // biome-ignore lint/performance/noDelete: env var cleanup
    else delete process.env.AM_CONFIG_DIR;
    if (dir) await dir.cleanup();
  });

  // ── A. Variant override forces "deny" ─────────────────────────

  test("variant declares permission_policy='deny', no --no-auto-approve → live path uses 'deny'", async () => {
    const config = `
[agents.claude-policy]
name = "claude-policy"
description = "Variant declares deny"

[agents.claude-policy.acp]
command = "/nonexistent/path/perm-policy-test --acp"

[agents.claude-policy.variants.strict]
protocol = "acp"
command = "/nonexistent/path/perm-policy-test"
permission_policy = "deny"
`;
    await writeFile(join(dir.path, "config.toml"), config);

    await invokeRun({
      agent: "claude-policy",
      prompt: "hello",
      variant: "strict",
      "no-auto-approve": false,
      json: true,
      quiet: true,
      verbose: false,
    });

    // The fake's prompt rejects, so runAgent's catch sets exitCode=1; we don't
    // assert on it here — the observable we care about is the recorded policy.
    expect(record.policies).toEqual(["deny"]);
  });

  // ── B. Variant override beats --no-auto-approve ───────────────

  test("variant declares 'auto-approve' + --no-auto-approve → live path uses 'auto-approve' (variant wins)", async () => {
    const config = `
[agents.claude-policy]
name = "claude-policy"
description = "Variant declares auto-approve"

[agents.claude-policy.acp]
command = "/nonexistent/path/perm-policy-test --acp"

[agents.claude-policy.variants.lax]
protocol = "acp"
command = "/nonexistent/path/perm-policy-test"
permission_policy = "auto-approve"
`;
    await writeFile(join(dir.path, "config.toml"), config);

    await invokeRun({
      agent: "claude-policy",
      prompt: "hello",
      variant: "lax",
      "no-auto-approve": true,
      json: true,
      quiet: true,
      verbose: false,
    });

    expect(record.policies).toEqual(["auto-approve"]);
  });

  // ── C. No variant policy → CLI flag still drives (regression guard) ─

  test("no variant policy + --no-auto-approve → live path uses 'deny' (existing behaviour preserved)", async () => {
    const config = `
[agents.fakeagent]
name = "fakeagent"
description = "no variant policy declared"

[agents.fakeagent.acp]
command = "/nonexistent/path/perm-policy-test --acp"
`;
    await writeFile(join(dir.path, "config.toml"), config);

    await invokeRun({
      agent: "fakeagent",
      prompt: "hello",
      "no-auto-approve": true,
      json: true,
      quiet: true,
      verbose: false,
    });

    expect(record.policies).toEqual(["deny"]);
  });

  // ── D. No variant policy, no --no-auto-approve → 'auto-approve' default ─

  test("no variant policy + no --no-auto-approve → live path uses 'auto-approve' (CLI default)", async () => {
    const config = `
[agents.fakeagent]
name = "fakeagent"
description = "no variant policy declared"

[agents.fakeagent.acp]
command = "/nonexistent/path/perm-policy-test --acp"
`;
    await writeFile(join(dir.path, "config.toml"), config);

    await invokeRun({
      agent: "fakeagent",
      prompt: "hello",
      "no-auto-approve": false,
      json: true,
      quiet: true,
      verbose: false,
    });

    expect(record.policies).toEqual(["auto-approve"]);
  });
});
