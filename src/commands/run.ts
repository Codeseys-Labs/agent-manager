/**
 * CLI: am run — Drive ACP-compatible coding agents headlessly.
 *
 * Usage:
 *   am run claude "fix the failing tests"          — one-shot: spawn, prompt, wait, exit
 *   am run codex "add error handling to api.ts"    — different agent, same interface
 *   am run --session backend claude "continue"     — named session (resume previous work)
 *   am run --cwd /path/to/project claude "refactor" — override working directory
 *
 * Subcommands (for live ACP session management):
 *   am run session list                            — list active ACP sessions
 *   am run session cancel <sessionId>              — cancel active session
 *
 * Note: `am run agents` is DEPRECATED — use `am agent list` (ADR-0031 M2).
 * Note: `am run session` manages LIVE ACP sessions (via JSON-RPC to the agent
 *       subprocess). For cross-tool transcript browsing (read-only disk harvest
 *       of Claude Code, Codex, etc.), use `am session` instead. Different
 *       concepts, intentionally kept separate.
 *
 * See ADR-0026 Phase 2, ADR-0031 Pillar 3.
 */

import { join } from "node:path";
import { defineCommand } from "citty";
import {
  type UnifiedAgent,
  type UnifiedRegistryConfig,
  isCatalogOnly,
  isShimNotEnabled,
  listAllAgentsAsync,
  resolveAgentAsync,
  shimNotEnabledMessage,
  tierRefusalMessage,
} from "../core/agent-registry";
import { resolveConfigDir } from "../core/config";
import { tryReadConfig, tryReadProjectConfig } from "../core/config";
import type { Config, ProjectConfig } from "../core/schema";
import { isSecretKeyName } from "../core/secret-detection";
import {
  type ResolvedVariant,
  VariantResolverError,
  type VariantSource,
  isVariantsEnabled,
  resolveVariant,
} from "../core/variant-resolver";
import type { DryRunEnvelope } from "../lib/dry-run-envelope";
import { debug, error, info, output, parsePositiveInt, warn } from "../lib/output";
import { AcpClientError, AmAcpClient, createAcpClient } from "../protocols/acp/client";
import { sandboxEnv } from "../protocols/acp/env-sandbox";
import { parseCommand } from "../protocols/acp/registry";
import type { SessionUpdate } from "../protocols/acp/types";

// ── Helpers ────────────────────────────────────────────────────

/** Load unified registry config and config dir for agent resolution. */
async function loadRegistryContext(): Promise<{
  registryConfig: UnifiedRegistryConfig | undefined;
  configDir: string;
  /** Full global config — includes [agents.<name>.variants] for ADR-0036. */
  globalConfig: Config | undefined;
  /** Project config (from CWD upward search) — may also carry variants. */
  projectConfig: ProjectConfig | undefined;
}> {
  const configDir = resolveConfigDir();
  const config = await tryReadConfig(join(configDir, "config.toml"));
  // Build UnifiedRegistryConfig from [agents.*] entries that have acp/a2a sub-sections
  // The TOML config's agents section may have entries with acp/a2a sub-tables
  const registryConfig = config as UnifiedRegistryConfig | undefined;
  // ADR-0036: variant resolution needs the typed Config + ProjectConfig.
  // Project config lookup is cheap — check CWD; no recursive walk is required
  // for the MVP (users who need project-level defaults put them in the same
  // directory they run `am run` from).
  const projectConfig =
    (await tryReadProjectConfig(join(process.cwd(), ".agent-manager.toml"))) ?? undefined;
  return {
    registryConfig,
    configDir,
    globalConfig: config ?? undefined,
    projectConfig,
  };
}

/** Format a session update for human-readable output. */
function formatUpdate(update: SessionUpdate, opts: { verbose?: boolean }): string | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") return update.content.text;
      return null;
    case "agent_thought_chunk":
      if (opts.verbose && update.content.type === "text")
        return `[thinking] ${update.content.text}`;
      return null;
    case "tool_call":
      return `[tool] ${update.title}`;
    case "tool_call_update":
      if (update.status === "completed") return `[tool] ${update.title ?? "tool"} done`;
      if (update.status === "failed") return `[tool] ${update.title ?? "tool"} failed`;
      return null;
    case "plan":
      return `[plan] ${update.entries.length} step(s)`;
    case "usage_update":
      if (opts.verbose) return `[usage] ${update.used}/${update.size} tokens`;
      return null;
    default:
      return null;
  }
}

// ── Core run logic ────────────────────────────────────────────

interface RunAgentArgs {
  agent: string;
  prompt: string;
  session?: string;
  cwd?: string;
  timeout?: string;
  noAutoApprove: boolean;
  dryRun: boolean;
  /** ADR-0036: explicit variant name from `--variant <name>`. Ignored when
   *  `AM_VARIANTS=1` is not set (see isVariantsEnabled). */
  variant?: string;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
}

// ── Dry-run (ADR-0038) ─────────────────────────────────────────

// VariantSource type imported from variant-resolver (ADR-0036) — single
// source of truth for the resolution-source vocabulary:
//   - "cli-flag"         : `--variant <name>` explicitly passed.
//   - "project-default"  : `default_variant` read from .agent-manager.toml.
//   - "global-default"   : `default_variant` read from the global config.
//   - "sole-variant"     : exactly one variant declared; picked implicitly.
//   - null               : no variants declared at all (back-compat).
// Ambiguous cases (>1 variant, no default, no --variant) throw at resolve time
// rather than picking a silent winner — see ADR-0036 Correction 1.

/** Shape of the dry-run explanation payload defined by ADR-0038. */
interface DryRunExplanation {
  agent: string;
  variant: string | null;
  variant_source: VariantSource;
  tier: string | null;
  protocol: "acp";
  command: string;
  args: string[];
  /**
   * Resolved absolute path of the `command` binary on PATH. null when the
   * binary is not installed. Added in the 2026-05-02 ADR-0038 patch —
   * `Bun.which` is cheap, read-only, and lets operators see whether a
   * live run would actually succeed. Exit code stays 0 on miss: dry-run
   * explains, doesn't assert runnability (the `warnings` field calls it out).
   */
  binary_resolved: string | null;
  env_keys: string[];
  env_secrets_redacted: string[];
  cwd: string;
  /** Effective permission policy for the live run (CLI-flag-derived today). */
  permission_policy: "deny" | "auto-approve";
  /**
   * Permission policy declared on the selected variant (ADR-0036). Surfaced
   * so operators see what the variant ASKS for, even though the MVP does NOT
   * enforce it (schema-only). `null` when no variant override is present.
   *
   * When this differs from `permission_policy` a `warnings` entry is emitted
   * so operators know the declared policy is being ignored until the
   * enforcement-wiring follow-up ships.
   */
  variant_permission_policy: "deny" | "auto-approve" | null;
  allowed_paths: string[];
}

/**
 * `am run --dry-run` envelope. Aliased to the shared `DryRunEnvelope<T>`
 * (ADR-0038, src/lib/dry-run-envelope.ts) so every dry-run-emitting
 * command rides the same canonical shape. The `action` literal is
 * narrowed to `"run-agent"` for this command; the `explanation` payload
 * carries the ADR-0038 resolved-spawn fields.
 */
type DryRunPayload = DryRunEnvelope<DryRunExplanation> & { action: "run-agent" };

/**
 * `Bun.which` shim — defaults to the real thing, tests can stub it to assert
 * both the "binary found" and "binary missing" branches without touching PATH.
 */
type WhichFn = (name: string) => string | null;
let whichFn: WhichFn = (name) => (Bun.which(name) as string | null) ?? null;

/**
 * Swap the PATH-resolution implementation. Tests call this with a mock and
 * pass `null` to restore the default.
 */
export function __setDryRunWhichFnForTests(fn: WhichFn | null): void {
  whichFn = fn ?? ((name) => (Bun.which(name) as string | null) ?? null);
}

export interface ShimPreflightResult {
  ok: boolean;
  resolved?: string;
  /** Human-readable error when ok=false. */
  error?: string;
  /** Install-path hint when ok=false. */
  hint?: string;
}

/**
 * Pre-flight check for tier-2 shims: `am-acp-shell <name>` can only spawn
 * when the `am-acp-shell` binary is on PATH. Prior-rc6 binaries shipped
 * only `am`, so users on those installs hit an opaque ENOENT when they
 * try a tier-2 shim. This function translates that case into a typed
 * result the run command prints before spawning.
 *
 * Exported so tests can exercise both branches without spawning.
 */
export function checkShimPreflight(command: string): ShimPreflightResult {
  const parsed = parseCommand(command);
  if (parsed.executable !== "am-acp-shell") return { ok: true };
  const resolved = whichFn("am-acp-shell");
  if (resolved) return { ok: true, resolved };
  return {
    ok: false,
    error:
      "`am-acp-shell` not found on PATH — tier-2 shim cannot spawn. Reinstall agent-manager (rc6+) to install both binaries.",
    hint: "curl -fsSL https://raw.githubusercontent.com/Codeseys-Labs/agent-manager/main/install.sh | sh",
  };
}

/**
 * Novice-recovery preflight (2026-05-03-E, per Codex-B audit): before
 * spawning any native agent, check that its executable is actually on
 * PATH. Without this, `am run claude "hello"` on a machine without the
 * claude CLI installed used to fail deep inside AmAcpClient.connect with
 * an opaque EPERM/ENOENT from the send() call. The new preflight refuses
 * upfront with an actionable message.
 *
 * Skip rules:
 *  - `am-acp-shell` command → handled by checkShimPreflight (distinct path)
 *  - absolute / relative path → user has taken explicit control; no PATH probe
 *  - npx/bunx/uvx/pipx wrappers → these fetch on demand; PATH-probing the
 *    wrapper is not the question the user cares about. We skip and let
 *    the deeper spawn surface the error if the WRAPPER itself is missing
 *    (rare: npx ships with node, bunx with bun).
 */
const PACKAGE_RUNNER_WRAPPERS = new Set(["npx", "bunx", "uvx", "pipx"]);

export function checkNativeAgentPreflight(command: string, agentName: string): ShimPreflightResult {
  const parsed = parseCommand(command);
  const exe = parsed.executable;
  // Tier-2 shim is a different check.
  if (exe === "am-acp-shell") return { ok: true };
  // Absolute or relative path — user controls. Skip probe.
  // FINAL-REV-W2 (2026-05-03-E): also cover Windows forms since
  // bun-windows-x64 is a supported build target. parseCommand
  // (shell-style) consumes backslashes as escapes so `.\bin\claude`
  // arrives as `.binclaude`. We match `.` or `..` followed by any
  // non-/ character to catch that form defensively.
  if (
    exe.startsWith("/") ||
    exe.startsWith("./") ||
    exe.startsWith("../") ||
    exe.startsWith(".\\") ||
    exe.startsWith("..\\") ||
    // Post-parse Windows relative (backslash-stripped): `.bin…` / `..share…`
    /^\.{1,2}[A-Za-z]/.test(exe) ||
    // Windows drive-letter absolute path. Accept `C:\`, `C:/`, and the
    // shell-parsed form `C:Program` (backslash consumed).
    /^[A-Za-z]:(?:[\\/]|[A-Za-z])/.test(exe)
  ) {
    return { ok: true };
  }
  // Package-runner wrappers fetch on demand. Probe the wrapper itself
  // (e.g. npx) — if even THAT isn't on PATH we surface that clearly.
  if (PACKAGE_RUNNER_WRAPPERS.has(exe)) {
    const resolved = whichFn(exe);
    if (resolved) return { ok: true, resolved };
    return {
      ok: false,
      error: `Package runner "${exe}" not found on PATH — agent "${agentName}" cannot spawn.`,
      hint: `Install the runtime that ships "${exe}" (e.g. Node.js for npx, Bun for bunx) and retry.`,
    };
  }
  const resolved = whichFn(exe);
  if (resolved) return { ok: true, resolved };
  return {
    ok: false,
    error: `Native agent "${agentName}" expects "${exe}" on PATH, but it was not found.`,
    hint: `Install the CLI that provides "${exe}", OR run \`am agent list --runnable\` to see which agents are available right now.`,
  };
}

/**
 * Build the dry-run payload for `am run`.
 *
 * Pure-ish function — no subprocess spawn, no network, no disk writes.
 * `Bun.which` IS called to populate `binary_resolved` (2026-05-02 ADR-0038
 * patch): it's cheap, read-only, and tells the operator whether a live run
 * would actually find the binary. On miss the exit code stays 0 (dry-run
 * explains, doesn't assert runnability); a warning is appended instead.
 *
 * A `resolvedVariant` (from ADR-0036) may override the agent's top-level
 * command/args/env. When absent (AM_VARIANTS not set, or the agent declares
 * no variants) the dry-run falls back to the entry's `acp.command`.
 *
 * `variantSource` explains WHERE the variant was chosen. Null when no
 * variant was selected.
 */
function buildDryRunPayload(
  entry: UnifiedAgent,
  args: RunAgentArgs,
  cwd: string,
  resolvedVariant?: ResolvedVariant | null,
  variantSource?: VariantSource,
): DryRunPayload {
  // Variant command/args take priority over the agent's top-level acp.command.
  const acpCommand = resolvedVariant?.command ?? entry.acp?.command ?? "";
  const parsed = parseCommand(acpCommand);
  const extraArgs = resolvedVariant?.args ?? [];
  const finalArgs = [...parsed.args, ...extraArgs];

  // Layer the variant env on top of the sandboxed base env — this mirrors
  // what `AmAcpClient.connect` will do at real spawn time (sandboxEnv merges
  // the `extra` overlay on top of the allow-listed parent env).
  const env = sandboxEnv(resolvedVariant?.env);
  const envKeys = Object.keys(env).sort();
  const envSecretsRedacted: string[] = [];
  for (const key of envKeys) {
    const value = env[key];
    // Mark as "redacted" if the key name looks secret-shaped OR the value
    // was produced by ${VAR} interpolation (indicating a templated secret).
    // sandboxEnv's allow-list strips AWS_* / *_TOKEN / *_SECRET / *_KEY etc,
    // so this is defence-in-depth — anything that makes it onto the resolved
    // env AND has a secret-shaped name gets flagged in the preview.
    if (isSecretKeyName(key) || (typeof value === "string" && value.includes("${"))) {
      envSecretsRedacted.push(`${key}=<redacted>`);
    }
  }

  // Permission policy (ADR-0036 Correction 3 + Codex review):
  // The dry-run MUST reflect what the LIVE path will actually do so operators
  // don't get a false sense of security. Live path ignores variant.permission_policy
  // in the MVP (schema-accepted but not enforced), so dry-run uses the same
  // CLI-flag-only resolution. Variant's permission_policy is surfaced separately
  // in `explanation.variant_permission_policy` so operators can see what's declared.
  // TODO(ADR-0036 follow-up): wire variant.permission_policy to enforcement —
  //   runAgent() should call client.setPermissionPolicy(resolvedVariant.permission_policy)
  //   when present, overriding the CLI-flag default. Hook point: around line ~424
  //   in runAgent(), before the existing args.noAutoApprove branch.
  const permissionPolicy: "deny" | "auto-approve" = args.noAutoApprove ? "deny" : "auto-approve";
  const variantPermissionPolicy: "deny" | "auto-approve" | null =
    resolvedVariant?.permission_policy ?? null;

  const variantName = resolvedVariant?.name ?? null;
  const resolveStep = variantName
    ? `resolve agent '${entry.name}' variant '${variantName}'${entry.tier ? ` (${entry.tier})` : ""}`
    : `resolve agent '${entry.name}'${entry.tier ? ` (${entry.tier})` : ""}`;

  // PATH resolution for the chosen `command`. Skipped for absolute or
  // relative paths (those are literal file references — `Bun.which` won't
  // resolve them and a "not on PATH" warning would be misleading).
  const warnings: string[] = [];
  let binaryResolved: string | null = null;
  if (parsed.executable.startsWith("/") || parsed.executable.startsWith("./")) {
    binaryResolved = null;
  } else {
    const resolved = whichFn(parsed.executable);
    if (resolved) {
      binaryResolved = resolved;
    } else {
      warnings.push(
        `binary '${parsed.executable}' not found on PATH — a live run would fail to spawn`,
      );
    }
  }

  // ADR-0036 Correction 3: when a variant declares permission_policy but it
  // differs from the effective (CLI-derived) policy, warn operators loudly
  // that the declaration is NOT being enforced in this MVP.
  if (variantPermissionPolicy !== null && variantPermissionPolicy !== permissionPolicy) {
    warnings.push(
      `variant declares permission_policy='${variantPermissionPolicy}' but MVP enforces '${permissionPolicy}' (CLI-flag-derived); variant permission_policy is schema-only until ADR-0036 follow-up.`,
    );
  }

  return {
    action: "run-agent",
    would_do: [resolveStep, "spawn subprocess via ACP", "send prompt and stream updates"],
    reads_only: true,
    mutations_prevented: ["process spawn", "session file write"],
    warnings,
    explanation: {
      agent: entry.name,
      variant: variantName,
      variant_source: variantSource ?? null,
      tier: entry.tier ?? null,
      protocol: "acp",
      command: parsed.executable,
      args: finalArgs,
      binary_resolved: binaryResolved,
      env_keys: envKeys,
      env_secrets_redacted: envSecretsRedacted,
      cwd,
      permission_policy: permissionPolicy,
      variant_permission_policy: variantPermissionPolicy,
      allowed_paths: [cwd],
    },
  };
}

/** Render the dry-run payload as a human-readable table. */
function renderDryRunTable(payload: DryRunPayload): string {
  const lines: string[] = [];
  const e = payload.explanation;
  lines.push(`action:            ${payload.action}`);
  lines.push(`reads_only:        ${payload.reads_only}`);
  lines.push("would_do:");
  for (const step of payload.would_do) lines.push(`  - ${step}`);
  lines.push("mutations_prevented:");
  for (const m of payload.mutations_prevented) lines.push(`  - ${m}`);
  if (payload.warnings.length > 0) {
    lines.push("warnings:");
    for (const w of payload.warnings) lines.push(`  - ${w}`);
  }
  lines.push("explanation:");
  lines.push(`  agent:             ${e.agent}`);
  lines.push(`  variant:           ${e.variant ?? "<none>"}`);
  lines.push(`  variant_source:    ${e.variant_source ?? "<none>"}`);
  lines.push(`  tier:              ${e.tier ?? "<none>"}`);
  lines.push(`  protocol:          ${e.protocol}`);
  lines.push(`  command:           ${e.command}`);
  lines.push(`  args:              ${e.args.length === 0 ? "<none>" : e.args.join(" ")}`);
  lines.push(`  binary_resolved:   ${e.binary_resolved ?? "<not on PATH>"}`);
  lines.push(`  env_keys:          ${e.env_keys.length === 0 ? "<none>" : e.env_keys.join(", ")}`);
  lines.push(
    `  env_secrets_redacted: ${
      e.env_secrets_redacted.length === 0 ? "<none>" : e.env_secrets_redacted.join(", ")
    }`,
  );
  lines.push(`  cwd:               ${e.cwd}`);
  lines.push(`  permission_policy: ${e.permission_policy}`);
  lines.push(`  allowed_paths:     ${e.allowed_paths.join(", ")}`);
  return lines.join("\n");
}

/**
 * Emit the dry-run payload (JSON when --json, readable table otherwise) and
 * return. Exported for tests.
 */
export function __emitDryRunForTests(
  entry: UnifiedAgent,
  args: RunAgentArgs,
  cwd: string,
  resolvedVariant?: ResolvedVariant | null,
  variantSource?: VariantSource,
): DryRunPayload {
  return buildDryRunPayload(entry, args, cwd, resolvedVariant, variantSource);
}

async function runAgent(args: RunAgentArgs): Promise<void> {
  const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
  const agentName = args.agent;
  const promptText = args.prompt;
  const sessionName = args.session;
  const cwd = args.cwd || process.cwd();
  const timeoutSecs = parsePositiveInt(args.timeout, "timeout", 300);

  const { registryConfig, configDir, globalConfig, projectConfig } = await loadRegistryContext();

  // Resolve the agent via unified registry
  const entry = await resolveAgentAsync(agentName, registryConfig, configDir);
  if (!entry) {
    error(`Unknown agent "${agentName}". Run \`am agent list\` to list available agents.`, opts);
    process.exitCode = 1;
    return;
  }

  // ADR-0036: resolve variant BEFORE dry-run / tier checks so the preview
  // and the live path agree on what would be spawned.
  //
  // Gating: variants are opt-in via `AM_VARIANTS=1` during the first release
  // after ADR-0036 accepts. When the flag is off we skip the resolver AND
  // we refuse an explicit `--variant` flag with an informative error (the
  // alternative — silently ignoring `--variant` — would surprise the user).
  let resolvedVariant: ResolvedVariant | null = null;
  let variantSource: VariantSource = null;
  if (isVariantsEnabled()) {
    try {
      resolvedVariant = resolveVariant(agentName, args.variant, globalConfig, projectConfig);
      // variantSource comes straight from the resolver (ADR-0036) — single
      // source of truth for where the chosen variant came from.
      variantSource = resolvedVariant.source;
    } catch (err: unknown) {
      if (err instanceof VariantResolverError) {
        error(err.message, opts);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  } else if (args.variant !== undefined) {
    error("--variant requires AM_VARIANTS=1 (ADR-0036 is opt-in for this release).", opts);
    process.exitCode = 1;
    return;
  }

  // ADR-0033: tier-2 shims that haven't been enabled get a different hint —
  // they have a clear next step (`enable-shim`), unlike tier-3 which has no
  // recovery. Check tier-2 FIRST so the recovery path wins.
  if (isShimNotEnabled(entry)) {
    error(shimNotEnabledMessage(agentName), opts);
    process.exitCode = 1;
    return;
  }
  if (isCatalogOnly(entry)) {
    error(tierRefusalMessage(agentName), opts);
    process.exitCode = 1;
    return;
  }

  if (!entry.acp) {
    error(
      `Unknown agent "${agentName}" or no ACP (local) endpoint. Run \`am agent list\` to list available agents.`,
      opts,
    );
    process.exitCode = 1;
    return;
  }

  debug(`Resolved agent: ${agentName} -> ${entry.acp.command} (${entry.source})`, opts);

  // Pre-flight check: tier-2 shims spawn via `am-acp-shell <name>`, so that
  // binary must be on PATH. Binary users who installed am via pre-rc6
  // install.sh or Homebrew formula got only `am` — the second binary
  // landed later (see docs/reviews/2026-04-18-acp-shell-wrapper/
  // REV-5-post-rc6-audit.md HIGH-1). A missing am-acp-shell used to
  // surface as an opaque ENOENT from Bun.spawn; `checkShimPreflight`
  // translates that into an actionable error.
  if (!args.dryRun) {
    const connectCmd = resolvedVariant?.command ?? entry.acp.command;
    const shimPreflight = checkShimPreflight(connectCmd);
    if (!shimPreflight.ok) {
      error(`${shimPreflight.error} (agent: ${agentName})`, opts);
      if (shimPreflight.hint) info(shimPreflight.hint, opts);
      process.exitCode = 1;
      return;
    }
    if (shimPreflight.resolved) {
      debug(`Pre-flight: am-acp-shell resolves to ${shimPreflight.resolved}`, opts);
    }
    // Codex-B audit (2026-05-03-E): native agents got no preflight; a
    // missing CLI surfaced as EPERM deep in ACP. Probe here.
    const nativePreflight = checkNativeAgentPreflight(connectCmd, agentName);
    if (!nativePreflight.ok) {
      error(nativePreflight.error ?? "Agent cannot spawn", opts);
      if (nativePreflight.hint) info(nativePreflight.hint, opts);
      process.exitCode = 1;
      return;
    }
  }

  // ADR-0038: dry-run short-circuits BEFORE any subprocess spawn or
  // permission-policy side effect. Resolution + validation has already run;
  // we just render the plan and return with exit 0.
  if (args.dryRun) {
    const payload = buildDryRunPayload(entry, args, cwd, resolvedVariant, variantSource);
    if (args.json) {
      output(payload, opts);
    } else if (!args.quiet) {
      // Route straight to stdout (not `info`) — the table IS the command's
      // output, not incidental progress that --quiet should suppress.
      process.stdout.write(`${renderDryRunTable(payload)}\n`);
    }
    return;
  }

  const client = createAcpClient();

  // Permission policy:
  //   --no-auto-approve → "deny" (already the class default post-2026-05-02
  //                               secure-by-default flip; re-affirmed here
  //                               for clarity).
  //   (default)         → "auto-approve" — `am run` is headless by design;
  //                       the operator has decided to trust the agent.
  if (args.noAutoApprove) {
    client.setPermissionPolicy("deny");
  } else {
    client.setPermissionPolicy("auto-approve");
  }

  // Accumulate text for streaming output (non-JSON mode)
  if (!args.json && !args.quiet) {
    client.onSessionUpdate((update: SessionUpdate) => {
      const text = formatUpdate(update, { verbose: args.verbose });
      if (text !== null) {
        // For agent text, write without newline to stream
        if (update.sessionUpdate === "agent_message_chunk") {
          process.stdout.write(text);
        } else {
          console.log(text);
        }
      }
    });
  }

  try {
    // 1. Connect
    // ADR-0036: when a variant is resolved, its `command` replaces the
    // agent's top-level `acp.command`. Variant `args` are appended after the
    // parsed command tokens (via ConnectOptions.args). Variant `env` is
    // overlaid on the sandboxed base env inside `AmAcpClient.connect` via
    // `sandboxEnv(opts?.env)`.
    const connectCommand = resolvedVariant?.command ?? entry.acp.command;
    info(`Connecting to ${agentName}...`, opts);
    const conn = await client.connect(connectCommand, {
      initTimeout: 30_000,
      args: resolvedVariant?.args,
      env: resolvedVariant?.env,
    });
    debug(
      `Connected: ${conn.agentInfo?.name ?? "unknown"} v${conn.agentInfo?.version ?? "?"}${
        resolvedVariant?.name ? ` [variant: ${resolvedVariant.name}]` : ""
      }`,
      opts,
    );

    // 2. Create or load session
    let sessionId: string;
    if (sessionName) {
      // Try to load existing session first
      try {
        await client.loadSession(sessionName, { cwd });
        sessionId = sessionName;
        debug(`Loaded session: ${sessionId}`, opts);
      } catch {
        // Session doesn't exist — create new with the given name
        sessionId = await client.newSession({ cwd });
        debug(`Created new session: ${sessionId} (named: ${sessionName})`, opts);
      }
    } else {
      sessionId = await client.newSession({ cwd });
      debug(`Created session: ${sessionId}`, opts);
    }

    // 3. Send prompt with timeout
    info("", opts); // blank line before agent output
    const result = await Promise.race([
      client.prompt(sessionId, [{ type: "text", text: promptText }]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new AcpClientError("Prompt timed out", "TIMEOUT")),
          timeoutSecs * 1000,
        ),
      ),
    ]);

    // Ensure newline after streamed text
    if (!args.json && !args.quiet) {
      process.stdout.write("\n");
    }

    // 4. Output result
    if (args.json) {
      output(
        {
          agent: agentName,
          sessionId,
          stopReason: result.stopReason,
          text: result.text,
          toolCalls: result.toolCalls.map((tc) => ({
            id: tc.toolCallId,
            title: tc.title,
            status: tc.status,
            kind: tc.kind,
          })),
          usage: result.usage ?? null,
        },
        opts,
      );
    } else {
      if (result.toolCalls.length > 0) {
        info(`\n${result.toolCalls.length} tool call(s)`, opts);
      }
      info(`\nStop reason: ${result.stopReason}`, opts);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    error(`Agent run failed: ${message}`, opts);
    process.exitCode = 1;
  } finally {
    await client.disconnect();
  }
}

// ── Subcommand: am run agents (DEPRECATED alias) ───────────────
//
// Deprecation (ADR-0031 M2): this subcommand duplicated `am agent list`.
// The canonical surface is `am agent list` under the `agent` group
// (ADR-0029). This alias forwards to the same unified registry listing
// and prints a deprecation notice on stderr. Scheduled for removal at
// agent-manager 0.6.0 (two minor versions after introduction).

const agentsSubcommand = defineCommand({
  meta: {
    name: "agents",
    description: "DEPRECATED: use `am agent list` instead (same output, canonical surface)",
  },
  args: {
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    warn("`am run agents` is deprecated — use `am agent list` (same output).", opts);
    const { registryConfig, configDir } = await loadRegistryContext();
    const agents = await listAllAgentsAsync(registryConfig, configDir);

    if (args.json) {
      output({ agents, deprecated: "Use `am agent list` instead." }, opts);
      return;
    }

    info(`${"Name".padEnd(20)} ${"Protocol".padEnd(12)} ${"Source".padEnd(14)} Endpoint`, opts);
    info(`${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(14)} ${"─".repeat(44)}`, opts);
    for (const agent of agents) {
      const protocol = agent.acp && agent.a2a ? "ACP/A2A" : agent.acp ? "ACP" : "A2A";
      const endpoint = agent.acp?.command ?? agent.a2a?.url ?? "—";
      info(
        `${agent.name.padEnd(20)} ${protocol.padEnd(12)} ${agent.source.padEnd(14)} ${endpoint}`,
        opts,
      );
    }
    info(`\n${agents.length} agent(s) available`, opts);
  },
});

// ── Subcommand: am run session list/cancel ─────────────────────

const sessionListSubcommand = defineCommand({
  meta: { name: "list", description: "List active ACP sessions for an agent" },
  args: {
    agent: { type: "positional", description: "Agent name", required: true },
    cwd: { type: "string", description: "Filter by working directory" },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const agentName = args.agent as string;
    const { registryConfig, configDir } = await loadRegistryContext();
    const entry = await resolveAgentAsync(agentName, registryConfig, configDir);

    if (!entry || !entry.acp) {
      error(`Unknown agent "${agentName}" or no ACP endpoint.`, opts);
      process.exitCode = 1;
      return;
    }

    const client = createAcpClient();
    try {
      await client.connect(entry.acp.command, { initTimeout: 30_000 });
      const response = await client.listSessions(args.cwd as string | undefined);

      if (args.json) {
        output({ agent: agentName, sessions: response.sessions }, opts);
        return;
      }

      if (response.sessions.length === 0) {
        info("No active sessions.", opts);
        return;
      }

      info(`${"Session ID".padEnd(40)} ${"CWD".padEnd(30)} ${"Updated"}`, opts);
      info(`${"─".repeat(40)} ${"─".repeat(30)} ${"─".repeat(20)}`, opts);
      for (const s of response.sessions) {
        const updated = s.updatedAt ? s.updatedAt.slice(0, 16).replace("T", " ") : "—";
        info(`${s.sessionId.padEnd(40)} ${s.cwd.padEnd(30)} ${updated}`, opts);
      }
      info(`\n${response.sessions.length} session(s)`, opts);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Failed to list sessions: ${message}`, opts);
      process.exitCode = 1;
    } finally {
      await client.disconnect();
    }
  },
});

const sessionCancelSubcommand = defineCommand({
  meta: { name: "cancel", description: "Cancel an active ACP session" },
  args: {
    agent: { type: "positional", description: "Agent name", required: true },
    sessionId: { type: "positional", description: "Session ID to cancel", required: true },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", default: false },
    verbose: { type: "boolean", alias: "v", default: false },
  },
  async run({ args }) {
    const opts = { json: args.json, quiet: args.quiet, verbose: args.verbose };
    const agentName = args.agent as string;
    const sessionId = args.sessionId as string;
    const { registryConfig, configDir } = await loadRegistryContext();
    const entry = await resolveAgentAsync(agentName, registryConfig, configDir);

    if (!entry || !entry.acp) {
      error(`Unknown agent "${agentName}" or no ACP endpoint.`, opts);
      process.exitCode = 1;
      return;
    }

    const client = createAcpClient();
    try {
      await client.connect(entry.acp.command, { initTimeout: 30_000 });
      await client.cancel(sessionId);

      if (args.json) {
        output({ action: "cancel", agent: agentName, sessionId }, opts);
      } else {
        info(`Cancelled session ${sessionId} on ${agentName}.`, opts);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Failed to cancel session: ${message}`, opts);
      process.exitCode = 1;
    } finally {
      await client.disconnect();
    }
  },
});

const sessionSubcommand = defineCommand({
  meta: {
    name: "session",
    description: "Manage LIVE ACP agent sessions (for transcript browsing, see `am session`)",
  },
  subCommands: {
    list: () => Promise.resolve(sessionListSubcommand),
    cancel: () => Promise.resolve(sessionCancelSubcommand),
  },
});

/**
 * Iter4 Wave A: `am acp` top-level namespace for ACP-specific live-session
 * management. Moved out from under `am run` because the `run` root has
 * positional args (`<agent> <prompt>`) and citty treated subcommands as a
 * higher-precedence lookup, making `am run claude "..."` unreachable.
 *
 * Today only `session` lives here. Future: `am acp detect`, `am acp probe`.
 */
export const acpCommand = defineCommand({
  meta: {
    name: "acp",
    description: "ACP protocol operations (live sessions, agent probing)",
  },
  subCommands: {
    session: () => Promise.resolve(sessionSubcommand),
  },
});

// ── Export top-level command ────────────────────────────────────

export const runCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run an ACP-compatible coding agent or manage sessions",
  },
  args: {
    agent: {
      type: "positional",
      description: "Agent name (e.g., claude, codex, gemini) or full command",
      required: true,
    },
    prompt: {
      type: "positional",
      description: "Prompt to send to the agent",
    },
    session: {
      type: "string",
      alias: "s",
      description: "Named session ID (resume or create)",
    },
    cwd: {
      type: "string",
      description: "Working directory for the agent session",
    },
    timeout: {
      type: "string",
      description: "Timeout in seconds for the agent response (default: 300)",
    },
    "no-auto-approve": {
      type: "boolean",
      description: "Deny all permission requests from the agent (default: auto-approve)",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description:
        "Explain what would happen without spawning the subprocess (ADR-0038). Emits resolved command/args/env.",
      default: false,
    },
    // Future: --explain as a dedicated post-execution verb, ADR-0038
    // §"The explain verb — deferred". MVP ships only --dry-run.
    variant: {
      type: "string",
      description:
        "Variant name to launch this agent with (ADR-0036). Requires AM_VARIANTS=1. Falls back to default_variant or first-defined variant.",
    },
    json: { type: "boolean", description: "JSON output", default: false },
    quiet: { type: "boolean", alias: "q", description: "Suppress progress output", default: false },
    verbose: {
      type: "boolean",
      alias: "v",
      description: "Show thinking and usage details",
      default: false,
    },
  },
  // Iter4 Wave A: removed conflicting `agents` and `session` subcommands.
  // citty was routing the first positional through subCommand lookup, making
  // `am run claude "hello"` unreachable. `agents` deprecation is complete —
  // use `am agent list`. Live sessions live under `am acp session` (new
  // top-level namespace) via the exported sessionSubcommand below.
  async run({ args }) {
    // The main `am run <agent> <prompt>` form
    const promptText = args.prompt as string | undefined;
    if (!promptText) {
      error(
        'Usage: am run <agent> "<prompt>". ' +
          "For agent discovery use `am agent list`. " +
          "For live sessions use `am acp session list/cancel`.",
        {
          json: args.json,
          quiet: args.quiet,
        },
      );
      process.exitCode = 1;
      return;
    }

    const raw = args as Record<string, unknown>;
    const dryRun = Boolean(raw["dry-run"]);

    await runAgent({
      agent: args.agent as string,
      prompt: promptText,
      session: args.session as string | undefined,
      cwd: args.cwd as string | undefined,
      timeout: args.timeout as string | undefined,
      noAutoApprove: (raw["no-auto-approve"] as boolean) ?? false,
      dryRun,
      variant: args.variant as string | undefined,
      json: args.json,
      quiet: args.quiet,
      verbose: args.verbose,
    });
  },
});
