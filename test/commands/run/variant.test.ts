/**
 * ADR-0036: `am run --variant <name>` — selects which variant of an agent
 * to launch. These tests drive the `am run` command directly (no CLI
 * parser), focusing on:
 *
 *   - `--variant` flag is declared on runCommand
 *   - Variants are always-on since the AM_VARIANTS=1 rollout gate was removed.
 *     resolved variant's command/args/env in the explanation
 *   - Unknown variant name yields the "available: …" error message
 *
 * The live-path (client.connect receiving variant env/args) is exercised
 * indirectly here via the dry-run preview which goes through the same
 * variant-resolver code path. These tests stay in dry-run mode so no real
 * subprocess spawns; the config points `acp.command` at a nonexistent
 * binary as a belt-and-suspenders guard against a future regression that
 * lets the live path escape.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../../../src/commands/run";
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

// ── Test config ────────────────────────────────────────────────
//
// Config agent `claude-test` with two variants. `acp.command` points at a
// nonexistent binary so any code path that tries to spawn for real fails
// loudly rather than silently attempting to run npx.
const CLAUDE_WITH_VARIANTS = `
[agents.claude-test]
name = "claude-test"
description = "Test agent with variants"

[agents.claude-test.acp]
command = "/nonexistent/path/am-variant-test-binary --acp"

[agents.claude-test.variants.anthropic]
protocol = "acp"
command = "/nonexistent/path/am-variant-test-binary --acp"

[agents.claude-test.variants.anthropic.env]
ANTHROPIC_API_KEY = "direct-key"

[agents.claude-test.variants.bedrock]
protocol = "acp"
command = "/nonexistent/path/am-bedrock-test-binary"
args = ["--provider", "bedrock"]

[agents.claude-test.variants.bedrock.env]
CLAUDE_CODE_USE_BEDROCK = "1"
AWS_REGION = "us-east-1"
`;

// ── Suite ──────────────────────────────────────────────────────

describe("am run --variant (ADR-0036)", () => {
  let dir: TestDir;
  const originalConfigDir = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-run-variant-");
    process.env.AM_CONFIG_DIR = dir.path;
    captureConsole();
    process.exitCode = 0;
  });

  afterEach(async () => {
    restoreConsole();
    process.exitCode = 0;
    // `process.env.X = undefined` coerces to the STRING "undefined"; use
    // delete to actually unset the variable.
    if (originalConfigDir !== undefined) process.env.AM_CONFIG_DIR = originalConfigDir;
    // biome-ignore lint/performance/noDelete: env var cleanup
    else delete process.env.AM_CONFIG_DIR;
    if (dir) await dir.cleanup();
  });

  // ── Flag registration ───────────────────────────────────────

  test("runCommand declares --variant as a string flag", () => {
    const args = runCommand.args as Record<string, { type: string; description?: string }>;
    expect(args.variant).toBeDefined();
    expect(args.variant.type).toBe("string");
    expect(args.variant.description?.toLowerCase()).toContain("variant");
  });

  // ── Happy-path resolution via dry-run ───────────────────────

  test("--variant bedrock surfaces resolved command/args/env", async () => {
    await writeFile(join(dir.path, "config.toml"), CLAUDE_WITH_VARIANTS);

    await invokeRun({
      agent: "claude-test",
      prompt: "hello",
      variant: "bedrock",
      "dry-run": true,
      json: true,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    const parsed = JSON.parse(stdoutLines.join(""));
    expect(parsed.explanation.variant).toBe("bedrock");
    // Bedrock variant command beats top-level acp.command.
    expect(parsed.explanation.command).toBe("/nonexistent/path/am-bedrock-test-binary");
    expect(parsed.explanation.args).toEqual(["--provider", "bedrock"]);
    expect(parsed.explanation.env_keys).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(parsed.explanation.env_keys).toContain("AWS_REGION");
  });

  test("ADR-0036 Correction 1: >1 variants + no default + no --variant → ambiguous error", async () => {
    await writeFile(join(dir.path, "config.toml"), CLAUDE_WITH_VARIANTS);

    await invokeRun({
      agent: "claude-test",
      prompt: "hello",
      "dry-run": true,
      json: false, // plain-text error for direct string assertion
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode).toBe(1);
    const err = stderrLines.join("\n");
    expect(err.toLowerCase()).toContain("ambiguous");
    expect(err).toContain("default_variant");
    expect(err).toContain("--variant");
  });

  test("exactly one variant declared picks it implicitly", async () => {
    const soleVariantConfig = `
[agents.claude-sole]
name = "claude-sole"
description = "Single-variant test agent"

[agents.claude-sole.acp]
command = "/nonexistent/path/am-sole-test-binary --acp"

[agents.claude-sole.variants.direct]
protocol = "acp"
command = "/nonexistent/path/am-sole-variant-binary"
`;
    await writeFile(join(dir.path, "config.toml"), soleVariantConfig);

    await invokeRun({
      agent: "claude-sole",
      prompt: "hello",
      "dry-run": true,
      json: true,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    const parsed = JSON.parse(stdoutLines.join(""));
    expect(parsed.explanation.variant).toBe("direct");
    expect(parsed.explanation.variant_source).toBe("sole-variant");
  });

  // ── Error path ─────────────────────────────────────────────

  test("unknown variant name produces a clear error listing available variants", async () => {
    await writeFile(join(dir.path, "config.toml"), CLAUDE_WITH_VARIANTS);

    await invokeRun({
      agent: "claude-test",
      prompt: "hello",
      variant: "vertex",
      "dry-run": true,
      json: false, // plain-text error for a direct string assertion
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode).toBe(1);
    const err = stderrLines.join("\n");
    expect(err).toContain('variant "vertex" not defined for "claude-test"');
    expect(err).toContain("anthropic");
    expect(err).toContain("bedrock");
  });

  // ── Correction 3: variant.permission_policy schema-only, not enforced ──

  test("variant.permission_policy differing from effective policy emits a warning", async () => {
    const configWithPolicyOverride = `
[agents.claude-policy]
name = "claude-policy"
description = "Variant declares auto-approve but CLI default is also auto-approve"

[agents.claude-policy.acp]
command = "/nonexistent/path/am-policy-test-binary --acp"

[agents.claude-policy.variants.strict]
protocol = "acp"
command = "/nonexistent/path/am-policy-test-binary"
permission_policy = "deny"
`;
    await writeFile(join(dir.path, "config.toml"), configWithPolicyOverride);

    // Variant declares "deny", CLI default is "auto-approve" → mismatch,
    // expect a warning surfaced in dry-run output.
    await invokeRun({
      agent: "claude-policy",
      prompt: "hello",
      variant: "strict",
      "dry-run": true,
      json: true,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    const parsed = JSON.parse(stdoutLines.join(""));
    // Live policy stays CLI-derived ("auto-approve") — variant's is NOT enforced.
    expect(parsed.explanation.permission_policy).toBe("auto-approve");
    expect(parsed.explanation.variant_permission_policy).toBe("deny");
    // A warning calls out the mismatch so operators don't get a false sense
    // of security.
    expect(parsed.warnings).toBeDefined();
    const warningText = (parsed.warnings as string[]).join(" | ");
    expect(warningText).toContain("permission_policy");
    expect(warningText.toLowerCase()).toContain("schema-only");
  });

  // ── Back-compat (no variants) ──────────────────────────────

  test("agent without variants is a no-op (null variant in dry-run)", async () => {
    // No config.toml → claude comes from the built-in tier-1 registry, which
    // has no variants. Resolver returns name=null and the dry-run falls back
    // to the top-level acp.command path.
    await invokeRun({
      agent: "claude",
      prompt: "hello",
      "dry-run": true,
      json: true,
      quiet: false,
      verbose: false,
    });

    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    const parsed = JSON.parse(stdoutLines.join(""));
    expect(parsed.explanation.variant).toBeNull();
    expect(parsed.explanation.command.length).toBeGreaterThan(0);
  });
});
