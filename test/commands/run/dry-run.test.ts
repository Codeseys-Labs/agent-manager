/**
 * ADR-0038: `am run --dry-run` emits a structured explanation of what would
 * happen without spawning a subprocess, writing session files, or hitting
 * the network.
 *
 * These tests drive the `am run` command directly (no CLI parser), assert
 * the JSON shape from §"Shared output shape", and verify that no subprocess
 * is spawned (we use a config-override agent pointing at a nonexistent
 * binary — if dry-run were broken the live spawn path would surface a
 * spawn error).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  __emitDryRunForTests,
  __setDryRunWhichFnForTests,
  runCommand,
} from "../../../src/commands/run";
import type { UnifiedAgent } from "../../../src/core/agent-registry";
import { type TestDir, createTestDir } from "../../helpers/tmp";

type RunArgs = Record<string, unknown>;

async function invokeRun(args: RunArgs): Promise<void> {
  await (runCommand as unknown as { run: (ctx: { args: RunArgs }) => Promise<void> }).run({ args });
}

// ── Console capture ────────────────────────────────────────────

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
  // Dry-run writes to process.stdout.write directly for the table form.
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

// ── Suite ──────────────────────────────────────────────────────

describe("am run --dry-run (ADR-0038)", () => {
  let dir: TestDir;
  const originalConfigDir = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-run-dry-run-");
    process.env.AM_CONFIG_DIR = dir.path;
    // Write a minimal config with a fake agent pointing at a nonexistent
    // binary. If the dry-run branch fails to short-circuit, the live path
    // would try to spawn this and the test would surface a spawn error.
    const configToml = `
[agents.fakeagent]
name = "fakeagent"
description = "test-only agent; dry-run must not spawn it"

[agents.fakeagent.acp]
command = "/nonexistent/path/am-dry-run-fake-binary --acp"
`;
    await writeFile(join(dir.path, "config.toml"), configToml, "utf-8");
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    process.exitCode = 0; // reset so the next test's baseline is clean
    if (originalConfigDir) process.env.AM_CONFIG_DIR = originalConfigDir;
    else process.env.AM_CONFIG_DIR = undefined;
    if (dir) await dir.cleanup();
  });

  // ── JSON shape ──────────────────────────────────────────────

  test("--dry-run --json emits ADR-0038 JSON shape for a config agent", async () => {
    await invokeRun({
      agent: "fakeagent",
      prompt: "fix the failing tests",
      "dry-run": true,
      json: true,
      quiet: false,
      verbose: false,
    });

    // Exit 0 proves the live spawn path was not taken — a spawn against
    // /nonexistent/path/... would set exitCode=1 with a spawn error.
    expect(process.exitCode).toBe(0);
    const joined = stdoutLines.join("");
    const parsed = JSON.parse(joined);
    expect(parsed.action).toBe("run-agent");
    expect(parsed.reads_only).toBe(true);
    expect(Array.isArray(parsed.would_do)).toBe(true);
    expect(parsed.would_do.length).toBeGreaterThan(0);
    expect(parsed.mutations_prevented).toContain("process spawn");
    expect(parsed.mutations_prevented).toContain("session file write");

    // 2026-05-02 ADR-0038 patch: payload-level `warnings` array.
    expect(Array.isArray(parsed.warnings)).toBe(true);

    const e = parsed.explanation;
    expect(e.agent).toBe("fakeagent");
    expect(e.variant).toBeNull();
    expect(e.variant_source).toBeNull();
    expect(e.protocol).toBe("acp");
    expect(e.command).toBe("/nonexistent/path/am-dry-run-fake-binary");
    expect(e.args).toEqual(["--acp"]);
    // Absolute path → binary_resolved is null, but no spurious PATH warning
    // (the path IS the literal resolution).
    expect(e.binary_resolved).toBeNull();
    expect(parsed.warnings).not.toContain(expect.stringContaining("not found on PATH"));
    expect(Array.isArray(e.env_keys)).toBe(true);
    expect(Array.isArray(e.env_secrets_redacted)).toBe(true);
    expect(typeof e.cwd).toBe("string");
    expect(e.permission_policy).toBe("auto-approve");
    expect(Array.isArray(e.allowed_paths)).toBe(true);
    expect(e.allowed_paths.length).toBeGreaterThan(0);
  });

  test("--dry-run without --json emits a human-readable table", async () => {
    await invokeRun({
      agent: "fakeagent",
      prompt: "hello",
      "dry-run": true,
      json: false,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode).toBe(0);
    const joined = stdoutLines.join("");
    // Not valid JSON.
    expect(() => JSON.parse(joined)).toThrow();
    // Contains the expected labels.
    expect(joined).toContain("action:");
    expect(joined).toContain("run-agent");
    expect(joined).toContain("would_do:");
    expect(joined).toContain("mutations_prevented:");
    expect(joined).toContain("explanation:");
    expect(joined).toContain("agent:");
    expect(joined).toContain("fakeagent");
    expect(joined).toContain("permission_policy:");
    expect(joined).toContain("auto-approve");
  });

  // ── --explain was dropped for MVP (2026-05-02 ADR-0038 patch) ─────

  test("--explain is NOT a recognized flag (MVP has only --dry-run)", async () => {
    // Passing `explain: true` without `"dry-run": true` should not trigger
    // dry-run mode. The handler would try to live-spawn the fake binary
    // and surface an "Agent run failed" error (exitCode=1).
    await invokeRun({
      agent: "fakeagent",
      prompt: "hello",
      explain: true,
      json: true,
      quiet: false,
      verbose: false,
    });

    // Live path was taken → spawn error on stderr.
    expect(process.exitCode).toBe(1);
    const stderrJoined = stderrLines.join("\n");
    expect(stderrJoined).toMatch(/Agent run failed|spawn|ENOENT|not found/i);
  });

  // ── Side-effect guards ─────────────────────────────────────

  test("--dry-run on a nonexistent binary agent still exits 0 (no spawn attempted)", async () => {
    // The live spawn path for `/nonexistent/path/...` would set exitCode=1
    // with a spawn error. Dry-run must short-circuit before that path runs.
    await invokeRun({
      agent: "fakeagent",
      prompt: "hello",
      "dry-run": true,
      json: true,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode).toBe(0);
    // No spawn-error message on stderr (which the live path would produce).
    const stderrJoined = stderrLines.join("\n");
    expect(stderrJoined).not.toMatch(/spawn|ENOENT|not found/i);
    expect(stderrJoined).not.toMatch(/Agent run failed/);
  });

  test("--no-auto-approve + --dry-run surfaces permission_policy='deny'", async () => {
    await invokeRun({
      agent: "fakeagent",
      prompt: "hello",
      "dry-run": true,
      "no-auto-approve": true,
      json: true,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutLines.join(""));
    expect(parsed.explanation.permission_policy).toBe("deny");
  });

  // ── Exit codes ─────────────────────────────────────────────

  test("--dry-run for an unknown agent still exits 1 (same as live mode)", async () => {
    await invokeRun({
      agent: "definitely-not-a-real-agent-zxyv",
      prompt: "hello",
      "dry-run": true,
      json: false,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode).toBe(1);
    expect(stderrLines.join("\n")).toMatch(/Unknown agent/i);
    expect(stdoutLines.join("")).toBe("");
  });

  test("--dry-run for a tier-3 catalog-only agent still exits 1", async () => {
    await invokeRun({
      agent: "cline",
      prompt: "hello",
      "dry-run": true,
      json: false,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode).toBe(1);
    expect(stderrLines.join("\n")).toContain("catalog-only");
    expect(stdoutLines.join("")).toBe("");
  });

  // ── Tier-1 native agent ─────────────────────────────────────

  test("--dry-run for a tier-1 built-in agent surfaces tier='tier-1-native'", async () => {
    await invokeRun({
      agent: "claude",
      prompt: "hello",
      "dry-run": true,
      json: true,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutLines.join(""));
    expect(parsed.explanation.agent).toBe("claude");
    expect(parsed.explanation.tier).toBe("tier-1-native");
    expect(parsed.explanation.command.length).toBeGreaterThan(0);
  });
});

// ── Pure-function payload tests ────────────────────────────────

describe("buildDryRunPayload (__emitDryRunForTests): shape & redaction", () => {
  const entry: UnifiedAgent = {
    name: "claude",
    source: "acp-builtin",
    tier: "tier-1-native",
    acp: { command: "npx -y @agentclientprotocol/claude-agent-acp@latest" },
    runnable: true,
  };

  const baseArgs = {
    agent: "claude",
    prompt: "hello",
    noAutoApprove: false,
    dryRun: true,
    json: false,
    quiet: false,
    verbose: false,
  };

  test("env_secrets_redacted entries always use <redacted> placeholder (never raw value)", () => {
    const payload = __emitDryRunForTests(entry, baseArgs, "/tmp/cwd");
    for (const entryStr of payload.explanation.env_secrets_redacted) {
      expect(entryStr).toMatch(/=<redacted>$/);
    }
  });

  test("command and args come from parseCommand(entry.acp.command)", () => {
    const payload = __emitDryRunForTests(entry, baseArgs, "/tmp/cwd");
    expect(payload.explanation.command).toBe("npx");
    expect(payload.explanation.args).toContain("-y");
    expect(payload.explanation.args).toContain("@agentclientprotocol/claude-agent-acp@latest");
  });

  test("cwd is echoed into explanation and allowed_paths", () => {
    const payload = __emitDryRunForTests(entry, baseArgs, "/tmp/some-project");
    expect(payload.explanation.cwd).toBe("/tmp/some-project");
    expect(payload.explanation.allowed_paths).toEqual(["/tmp/some-project"]);
  });

  test("noAutoApprove=true flips permission_policy to 'deny'", () => {
    const payload = __emitDryRunForTests(entry, { ...baseArgs, noAutoApprove: true }, "/tmp/cwd");
    expect(payload.explanation.permission_policy).toBe("deny");
  });

  test("resolved variant overrides command and appends args", () => {
    const payload = __emitDryRunForTests(
      entry,
      baseArgs,
      "/tmp/cwd",
      {
        name: "bedrock",
        source: "cli-flag",
        protocol: "acp",
        command: "claude-agent-acp",
        args: ["--provider", "bedrock"],
        env: { AWS_PROFILE: "dev" },
      },
      "cli-flag",
    );
    expect(payload.explanation.variant).toBe("bedrock");
    expect(payload.explanation.variant_source).toBe("cli-flag");
    expect(payload.explanation.command).toBe("claude-agent-acp");
    expect(payload.explanation.args).toContain("--provider");
    expect(payload.explanation.args).toContain("bedrock");
    expect(payload.explanation.env_keys).toContain("AWS_PROFILE");
  });

  test("API_KEY-shaped variant env vars are flagged in env_secrets_redacted", () => {
    const payload = __emitDryRunForTests(entry, baseArgs, "/tmp/cwd", {
      name: "openrouter",
      source: "first-defined",
      protocol: "acp",
      env: { OPENROUTER_API_KEY: "sk-real-value-that-should-not-leak" },
    });
    expect(payload.explanation.env_keys).toContain("OPENROUTER_API_KEY");
    const redacted = payload.explanation.env_secrets_redacted;
    expect(redacted).toContain("OPENROUTER_API_KEY=<redacted>");
    // The real value must never leak into either list.
    expect(JSON.stringify(payload)).not.toContain("sk-real-value-that-should-not-leak");
  });

  test("${VAR}-interpolated env values are flagged in env_secrets_redacted", () => {
    const payload = __emitDryRunForTests(entry, baseArgs, "/tmp/cwd", {
      name: "openrouter",
      source: "first-defined",
      protocol: "acp",
      // A non-secret-shaped key whose value has ${VAR} — still redacted
      // because the template indicates an unresolved secret.
      env: { CUSTOM_PROFILE: "${AWS_PROFILE}" },
    });
    const redacted = payload.explanation.env_secrets_redacted;
    expect(redacted.some((r) => r.startsWith("CUSTOM_PROFILE="))).toBe(true);
  });
});

// ── binary_resolved + warnings (ADR-0038 2026-05-02 patch) ─────

describe("buildDryRunPayload: binary_resolved + warnings", () => {
  const entry: UnifiedAgent = {
    name: "claude",
    source: "acp-builtin",
    tier: "tier-1-native",
    acp: { command: "claude-agent-acp" },
    runnable: true,
  };

  const baseArgs = {
    agent: "claude",
    prompt: "hello",
    noAutoApprove: false,
    dryRun: true,
    json: false,
    quiet: false,
    verbose: false,
  };

  afterEach(() => {
    __setDryRunWhichFnForTests(null); // restore Bun.which
  });

  test("binary_resolved is populated when Bun.which finds the command", () => {
    __setDryRunWhichFnForTests(() => "/usr/local/bin/claude-agent-acp");
    const payload = __emitDryRunForTests(entry, baseArgs, "/tmp/cwd");
    expect(payload.explanation.binary_resolved).toBe("/usr/local/bin/claude-agent-acp");
    expect(payload.warnings).toEqual([]);
  });

  test("binary_resolved is null AND a warning is appended when the binary is not on PATH", () => {
    __setDryRunWhichFnForTests(() => null);
    const payload = __emitDryRunForTests(entry, baseArgs, "/tmp/cwd");
    expect(payload.explanation.binary_resolved).toBeNull();
    expect(payload.warnings.length).toBe(1);
    expect(payload.warnings[0]).toContain("claude-agent-acp");
    expect(payload.warnings[0]).toContain("not found on PATH");
  });

  test("absolute-path commands skip Bun.which — null without a warning", () => {
    __setDryRunWhichFnForTests(() => {
      throw new Error("Bun.which must not be called for absolute paths");
    });
    const absEntry: UnifiedAgent = {
      ...entry,
      acp: { command: "/nonexistent/path/bin --acp" },
    };
    const payload = __emitDryRunForTests(absEntry, baseArgs, "/tmp/cwd");
    expect(payload.explanation.binary_resolved).toBeNull();
    expect(payload.warnings).toEqual([]);
  });

  test("relative-path commands also skip Bun.which", () => {
    __setDryRunWhichFnForTests(() => {
      throw new Error("Bun.which must not be called for relative paths");
    });
    const relEntry: UnifiedAgent = {
      ...entry,
      acp: { command: "./local-agent --acp" },
    };
    const payload = __emitDryRunForTests(relEntry, baseArgs, "/tmp/cwd");
    expect(payload.explanation.binary_resolved).toBeNull();
    expect(payload.warnings).toEqual([]);
  });
});

// ── variant_source propagation ─────────────────────────────────

describe("buildDryRunPayload: variant_source", () => {
  const entry: UnifiedAgent = {
    name: "claude",
    source: "acp-builtin",
    tier: "tier-1-native",
    acp: { command: "npx -y @agentclientprotocol/claude-agent-acp@latest" },
    runnable: true,
  };

  const baseArgs = {
    agent: "claude",
    prompt: "hello",
    noAutoApprove: false,
    dryRun: true,
    json: false,
    quiet: false,
    verbose: false,
  };

  test("variant_source is null when no variant is selected", () => {
    const payload = __emitDryRunForTests(entry, baseArgs, "/tmp/cwd");
    expect(payload.explanation.variant).toBeNull();
    expect(payload.explanation.variant_source).toBeNull();
  });

  test.each([
    ["cli-flag" as const],
    ["project-default" as const],
    ["global-default" as const],
    ["first-defined" as const],
  ])("variant_source=%s is echoed in the explanation", (source) => {
    const payload = __emitDryRunForTests(
      entry,
      baseArgs,
      "/tmp/cwd",
      { name: "bedrock", source, protocol: "acp", command: "claude-agent-acp" },
      source,
    );
    expect(payload.explanation.variant).toBe("bedrock");
    expect(payload.explanation.variant_source).toBe(source);
  });
});
