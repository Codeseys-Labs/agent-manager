/**
 * Unified Agent Registry — merges config, ACP built-in, A2A roster, and
 * catalog-only (adapter-only) agents into a single view.
 *
 * Resolution order (highest wins):
 *   1. Config agents ([agents.<name>.acp] / [agents.<name>.a2a] in TOML)
 *   2. Built-in agents (tier-1 native ACP, tier-3 catalog-only)
 *   3. A2A roster (agents.toml in config directory)
 *
 * ADR-0030 introduced the unified registry.
 * ADR-0033 introduced the tier structure replacing the old 16-entry
 * `BUILT_IN_ACP_AGENTS` dict with `BUILT_IN_AGENTS` — each entry now
 * declares its tier (native / shim / catalog-only) so `am agent list` and
 * `am run` can tell the user the truth about what works.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { isNotFound } from "../lib/errors";

// ── Tier-based built-in registry (ADR-0033) ────────────────────

/**
 * Agent tiers — see ADR-0033.
 *
 * - tier-1-native:     Upstream publishes a documented ACP binary we
 *                      have verified end-to-end. Spawnable by `am run`.
 * - tier-2-shim:       Wrappable CLIs that don't speak ACP natively; the
 *                      acp-shell wrapper (Phase B, not in this Phase A)
 *                      bridges them. Currently unpopulated in this file.
 * - tier-3-catalog-only: No spawnable ACP runtime exists (VSCode extensions,
 *                      IDE-only products). `am apply` writes their config,
 *                      `am run` refuses with a helpful message.
 */
export type AgentTier = "tier-1-native" | "tier-2-shim" | "tier-3-catalog-only";

export interface BuiltInAgentSpec {
  /**
   * Spawn command. Empty string (`""`) means the agent is catalog-only and
   * cannot be run. Callers MUST check for `""` before constructing an ACP
   * client.
   */
  command: string;
  tier: AgentTier;
  /** Upstream ACP documentation URL. Present for tier-1; omitted for tier-3. */
  docsUrl?: string;
  /**
   * Optional binary name that, when present on PATH, is preferred over the
   * `npx …` `command` above. Saves the 2–5s npx cold-start on every
   * invocation once the user has `npm i -g` (or their package manager's
   * equivalent) the adapter package.
   *
   * Borrowed from openclaw/acpx's `resolveInstalledBuiltInAgentLaunch`
   * pattern — see `docs/references/openclaw-acpx.md` for scope/attribution.
   * Only populated for agents whose upstream adapter is distributed as an
   * npx package (claude, codex). Agents whose `command` already points at
   * a real on-PATH binary (e.g. `gemini --acp`) don't need this field — the
   * `command` itself IS the native invocation.
   */
  localBinary?: string;
}

/**
 * The canonical built-in agent registry. Replaces the old
 * `BUILT_IN_ACP_AGENTS` flat dict — the dict had 16 entries, only 4 of
 * which were actually verified end-to-end (claude, codex, gemini, kiro).
 * See `docs/reviews/2026-04-18-acp-shell-wrapper/` for the audit.
 *
 * Tier breakdown:
 *   - tier-1-native: claude, codex, gemini, kiro (verified live-smoke).
 *   - tier-2-shim:   (intentionally empty in Phase A — shim wrapper lands
 *                    in Phase B per ADR-0033).
 *   - tier-3-catalog-only: cline, continue, copilot, cursor, kilo-code,
 *                    roo-code, windsurf. These have paired adapters but
 *                    no spawnable ACP runtime.
 *
 * Removed entirely (were nominal — no upstream binary):
 *   - devin:     Cognition SaaS, no CLI.
 *   - amp:       sourcegraph/amp 404, no public ACP docs.
 *   - aider:     wrappable via shim (→ Phase B). Removed from Phase A.
 *   - amazon-q:  wrappable via shim (→ Phase B). Removed from Phase A.
 *   - augment:   binary was wrong (`augment-cli`); real name is `auggie`.
 *                Will return as tier-1 after Phase B live-smoke.
 *   - goose:     flag unverified, likely consumes ACP not serves it.
 *                Candidate for Phase B shim or re-verify.
 *   - sourcegraph (cody): repo 404, no CLI with ACP. Candidate for shim.
 */
export const BUILT_IN_AGENTS: Record<string, BuiltInAgentSpec> = {
  // ── Tier 1 — native ACP, verified end-to-end ─────────────────
  claude: {
    command: "npx -y @agentclientprotocol/claude-agent-acp@latest",
    tier: "tier-1-native",
    docsUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
    // When the user has `@agentclientprotocol/claude-agent-acp` installed
    // globally, the shipped binary is `claude-agent-acp`. Prefer it over the
    // npx cold-start path.
    localBinary: "claude-agent-acp",
  },
  codex: {
    command: "npx @zed-industries/codex-acp@latest",
    tier: "tier-1-native",
    docsUrl: "https://github.com/zed-industries/codex-acp",
    // `@zed-industries/codex-acp` ships a `codex-acp` bin. Prefer it over
    // the npx cold-start.
    localBinary: "codex-acp",
  },
  gemini: {
    command: "gemini --acp",
    tier: "tier-1-native",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
  },
  kiro: {
    command: "kiro-cli-chat acp",
    tier: "tier-1-native",
    // Amazon internal; no public docs URL.
  },

  // ── Tier 2 — shim-wrapped CLIs (Phase B, ADR-0033) ───────────
  //
  // Each tier-2 entry has `command: ""` so the agent is NOT auto-spawnable.
  // The user must run `am agent enable-shim <name>` to opt in, which writes
  // `[agents.<name>].acp.command = "am-acp-shell <name>"` to their
  // config.toml. Once enabled, `resolveAgent()` sees the config override
  // and routes `am run <name>` through the shim. Until enabled, running the
  // agent returns a helpful "enable via am agent enable-shim <name>" message.
  //
  // The three initial shims per ADR-0033 Phase B. Shim configs live in
  // src/protocols/acp/shell-wrapper.ts BUILT_IN_SHIMS.
  aider: {
    command: "",
    tier: "tier-2-shim",
    docsUrl: "https://aider.chat/docs/scripting.html",
  },
  "amazon-q": {
    command: "",
    tier: "tier-2-shim",
    docsUrl: "https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line.html",
  },
  cody: {
    command: "",
    tier: "tier-2-shim",
    docsUrl: "https://sourcegraph.com/docs/cody",
  },

  // ── Tier 3 — catalog-only (adapter-only, not spawnable) ──────
  // Each entry has `command: ""` so resolveAgent() can synthesize a
  // runnable=false UnifiedAgent and `am run` can refuse with a helpful
  // message ("use it from its native UI").
  cline: {
    command: "",
    tier: "tier-3-catalog-only",
  },
  continue: {
    command: "",
    tier: "tier-3-catalog-only",
  },
  copilot: {
    // GitHub Copilot is available via the VSCode extension and `gh copilot`
    // CLI. Per R-C, the CLI's `--acp` flag is not documented upstream; ACP
    // support is "PREVIEW" and not reliable. Treating as catalog-only until
    // live-smoke verification proves otherwise.
    command: "",
    tier: "tier-3-catalog-only",
  },
  cursor: {
    // Upstream binary rename is unclear (was `cursor-agent`, possibly
    // `agent`). Until we verify a spawnable binary exists, treat as
    // catalog-only so users aren't greeted by "command not found".
    command: "",
    tier: "tier-3-catalog-only",
  },
  "kilo-code": {
    command: "",
    tier: "tier-3-catalog-only",
  },
  "roo-code": {
    command: "",
    tier: "tier-3-catalog-only",
  },
  windsurf: {
    command: "",
    tier: "tier-3-catalog-only",
  },
};

/**
 * @deprecated Use {@link BUILT_IN_AGENTS}. Kept for source compatibility
 * with older callers. Only tier-1-native entries are surfaced here —
 * tier-3 (catalog-only) agents have no spawn command and would break
 * anything that assumed `BUILT_IN_ACP_AGENTS[name]` yields a runnable
 * command. Removal targeted for 0.6.0 per ADR-0033.
 */
export const BUILT_IN_ACP_AGENTS: Record<string, string> = Object.fromEntries(
  Object.entries(BUILT_IN_AGENTS)
    .filter(([_, s]) => s.tier === "tier-1-native")
    .map(([name, s]) => [name, s.command]),
);

// ── Types ──────────────────────────────────────────────────────

export interface UnifiedAgent {
  name: string;
  description?: string;
  /**
   * Which source produced this entry.
   *   - "config":         user's config.toml [agents.<name>.*] override
   *   - "acp-builtin":    tier-1-native (and future tier-2-shim) BUILT_IN_AGENTS
   *   - "a2a-roster":     discovered A2A agent in agents.toml
   *   - "catalog-only":   tier-3 entry in BUILT_IN_AGENTS (no spawn command)
   */
  source: "config" | "acp-builtin" | "a2a-roster" | "catalog-only";
  acp?: { command: string };
  a2a?: { url: string };
  /** Tier from {@link BUILT_IN_AGENTS}. Absent for pure config / a2a entries. */
  tier?: AgentTier;
  /** True if the agent's runtime is actually available locally (PATH or paired adapter). */
  installed?: boolean;
  /** Tool version if cheaply derivable. */
  version?: string;
  /**
   * True if `am run` can spawn this agent. False for tier-3 catalog-only
   * entries. Absent means "unknown / defaults to true" — callers should
   * treat `runnable === false` as the only refusal signal.
   */
  runnable?: boolean;
}

/** Shape of [agents.<name>] in config TOML for the unified registry. */
export interface ConfigAgentEntry {
  description?: string;
  acp?: { command: string };
  a2a?: { url: string };
}

/** Shape of the config TOML relevant to the unified registry. */
export interface UnifiedRegistryConfig {
  agents?: Record<string, ConfigAgentEntry>;
}

// ── A2A roster reading ─────────────────────────────────────────

interface RosterToml {
  agents?: Record<
    string,
    {
      url: string;
      description?: string;
      added_at: string;
      last_seen?: string;
    }
  >;
}

async function readRoster(
  configDir: string,
): Promise<Record<string, { url: string; description?: string }>> {
  const rosterPath = join(configDir, "agents.toml");
  let raw: string;
  try {
    raw = await readFile(rosterPath, "utf-8");
  } catch (err: unknown) {
    if (isNotFound(err)) return {};
    throw err;
  }

  const parsed = TOML.parse(raw) as unknown as RosterToml;
  const agents = parsed.agents ?? {};
  const result: Record<string, { url: string; description?: string }> = {};
  for (const [name, entry] of Object.entries(agents)) {
    result[name] = { url: entry.url, description: entry.description };
  }
  return result;
}

// ── Helpers ────────────────────────────────────────────────────

/** True when this BuiltInAgentSpec represents a spawnable (tier-1/tier-2) runtime. */
function isSpawnable(spec: BuiltInAgentSpec): boolean {
  return spec.command !== "" && spec.tier !== "tier-3-catalog-only";
}

/** Build a UnifiedAgent from a BUILT_IN_AGENTS entry. */
function builtInToUnified(name: string, spec: BuiltInAgentSpec): UnifiedAgent {
  if (isSpawnable(spec)) {
    return {
      name,
      source: "acp-builtin",
      acp: { command: spec.command },
      tier: spec.tier,
      runnable: true,
    };
  }
  // Non-spawnable: either tier-3 catalog-only OR tier-2-shim without user
  // opt-in. Keep tier metadata so `am agent list` can render the correct
  // label and `am run` can print a useful hint.
  return {
    name,
    source: "catalog-only",
    tier: spec.tier,
    runnable: false,
  };
}

// ── Resolution ─────────────────────────────────────────────────

/**
 * Resolve an agent name to a UnifiedAgent entry.
 *
 * Resolution order:
 *   1. Config agents (from the parsed config object)
 *   2. Built-in registry (tier-1-native spawnable + tier-3 catalog-only)
 *   3. A2A roster (agents.toml)
 *
 * For sources 2+3, entries are merged: if the same name appears in both
 * the built-in registry and the A2A roster, the result has both acp and a2a
 * fields (if the built-in is spawnable) or just a2a + tier metadata.
 *
 * Config agents take full priority — when a name appears in config,
 * built-in and roster entries for that name are ignored.
 */
export function resolveAgent(
  name: string,
  config?: UnifiedRegistryConfig,
  rosterAgents?: Record<string, { url: string; description?: string }>,
): UnifiedAgent | null {
  // 1. Config override
  const configAgent = config?.agents?.[name];
  if (configAgent && (configAgent.acp || configAgent.a2a)) {
    return {
      name,
      description: configAgent.description,
      source: "config",
      ...(configAgent.acp ? { acp: { command: configAgent.acp.command } } : {}),
      ...(configAgent.a2a ? { a2a: { url: configAgent.a2a.url } } : {}),
      runnable: Boolean(configAgent.acp),
    };
  }

  // 2+3. Merge built-in + A2A roster
  const builtInSpec = BUILT_IN_AGENTS[name];
  const rosterEntry = rosterAgents?.[name];

  if (builtInSpec && rosterEntry) {
    const base = builtInToUnified(name, builtInSpec);
    return {
      ...base,
      description: rosterEntry.description,
      a2a: { url: rosterEntry.url },
    };
  }

  if (builtInSpec) {
    return builtInToUnified(name, builtInSpec);
  }

  if (rosterEntry) {
    return {
      name,
      description: rosterEntry.description,
      source: "a2a-roster",
      a2a: { url: rosterEntry.url },
      runnable: true,
    };
  }

  return null;
}

/**
 * Async variant of resolveAgent that reads the A2A roster from disk.
 * Use this when you don't already have roster data loaded.
 */
export async function resolveAgentAsync(
  name: string,
  config?: UnifiedRegistryConfig,
  configDir?: string,
): Promise<UnifiedAgent | null> {
  const rosterAgents = configDir ? await readRoster(configDir) : undefined;
  return resolveAgent(name, config, rosterAgents);
}

/**
 * List all agents across all sources, merged without duplicates.
 *
 * Config agents take priority over built-in and roster entries.
 * Built-in and roster entries for the same name are merged into one entry.
 */
export function listAllAgents(
  config?: UnifiedRegistryConfig,
  rosterAgents?: Record<string, { url: string; description?: string }>,
): UnifiedAgent[] {
  const result = new Map<string, UnifiedAgent>();

  // 1. Built-in agents (tier-1 + tier-3). Lowest priority, added first.
  for (const [name, spec] of Object.entries(BUILT_IN_AGENTS)) {
    result.set(name, builtInToUnified(name, spec));
  }

  // 2. A2A roster agents — merge with existing built-in entries
  if (rosterAgents) {
    for (const [name, entry] of Object.entries(rosterAgents)) {
      const existing = result.get(name);
      if (existing) {
        // Merge: add A2A to existing built-in entry
        existing.a2a = { url: entry.url };
        if (entry.description) existing.description = entry.description;
      } else {
        result.set(name, {
          name,
          description: entry.description,
          source: "a2a-roster",
          a2a: { url: entry.url },
          runnable: true,
        });
      }
    }
  }

  // 3. Config agents (highest priority, override everything)
  if (config?.agents) {
    for (const [name, agent] of Object.entries(config.agents)) {
      if (!agent.acp && !agent.a2a) continue;
      result.set(name, {
        name,
        description: agent.description,
        source: "config",
        ...(agent.acp ? { acp: { command: agent.acp.command } } : {}),
        ...(agent.a2a ? { a2a: { url: agent.a2a.url } } : {}),
        runnable: Boolean(agent.acp),
      });
    }
  }

  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Options controlling `listAllAgentsAsync` behaviour.
 */
export interface ListAllAgentsAsyncOptions {
  /**
   * When true, populate `installed` / `version` on each returned agent by
   * running the cheap agent-detection pipeline. Config-source agents are
   * assumed installed (the user declared them). Default: true.
   * Disable via `detect: false` on hot paths that must avoid even cheap I/O.
   */
  detect?: boolean;
}

/**
 * Async variant of listAllAgents that reads the A2A roster from disk and —
 * unless explicitly disabled — fills in `installed` / `version` on each
 * agent using `detectAllAgents()`.
 *
 * Tier-3 catalog-only entries get `installed` from their paired adapter's
 * detect() signal (PATH is never the right check for a VSCode extension).
 */
export async function listAllAgentsAsync(
  config?: UnifiedRegistryConfig,
  configDir?: string,
  options?: ListAllAgentsAsyncOptions,
): Promise<UnifiedAgent[]> {
  const rosterAgents = configDir ? await readRoster(configDir) : undefined;
  const agents = listAllAgents(config, rosterAgents);

  const detect = options?.detect !== false;
  if (!detect) return agents;

  // Populate installed/version fields. Lazy import to avoid a cycle between
  // core/agent-registry and core/agent-detection (the latter imports
  // BUILT_IN_AGENTS from here).
  const { detectAllAgents } = await import("./agent-detection");
  const detections = await detectAllAgents();

  return agents.map((agent) => {
    // Config-source agents: user-declared commands/URLs — assume installed.
    if (agent.source === "config") {
      return { ...agent, installed: true };
    }
    const detection = detections[agent.name];
    if (!detection) {
      // A2A-only roster entries or unknown agents — leave `installed`
      // unset, the caller can treat as "unknown" or probe via HTTP ping.
      return agent;
    }
    return {
      ...agent,
      installed: detection.installed,
      ...(detection.version ? { version: detection.version } : {}),
    };
  });
}

// ── Shared refusal (ADR-0033, REV-1 #7) ─────────────────────────

/**
 * Canonical user-facing message for "this agent is catalog-only — `am run`
 * cannot spawn it." One source of truth across `am run`, `am flow run`,
 * and `am_agent_invoke`.
 *
 * REV-4 HIGH-1 fix: tier-2-shim agents that have NOT been enabled yet are
 * NOT catalog-only — they have a clear path forward (`am agent enable-shim
 * <name>`). Previous wording called them VSCode extensions, which is
 * factually wrong for aider/amazon-q/cody. Split into two functions.
 *
 * Callers decide how to surface the result (throw, exit 1, JSON-RPC error, etc.).
 */
export function tierRefusalMessage(agentName: string): string {
  return (
    `"${agentName}" is a catalog-only (tier-3) integration. ` +
    "am writes its config via `am apply` but cannot spawn it — it has no " +
    "standalone ACP runtime (VSCode extensions, IDE-only products). " +
    "Use it from its native UI; run `am agent list --tier native` for " +
    "runnable alternatives. See ADR-0033."
  );
}

/**
 * Tier-2 hint for a shim-wrapped agent that the user has not yet opted in to.
 * Separate from tierRefusalMessage because the next step is different:
 * tier-3 has no recovery; tier-2 just needs `enable-shim`.
 */
export function shimNotEnabledMessage(agentName: string): string {
  return (
    `"${agentName}" is a Tier-2 wrapped agent and requires opt-in before ` +
    "`am run` will spawn it. Run:\n" +
    `  am agent enable-shim ${agentName} --yes\n\n` +
    "Tier-2 inherits the wrapped CLI's trust posture — `--yes` / " +
    "`--no-interactive` flags on the wrapped tool bypass am's approval UI. " +
    "See ADR-0033 Phase B for the full security note."
  );
}

/**
 * Type guard: true when an agent is a tier-3 catalog-only (no recovery).
 * REV-4 HIGH-1: narrowed from `runnable === false` to `tier === "tier-3"`,
 * because unenabled tier-2 shims ALSO have runnable === false but they
 * belong on the isShimNotEnabled path, not catalog-only.
 */
export function isCatalogOnly(agent: Pick<UnifiedAgent, "runnable" | "tier">): boolean {
  return agent.tier === "tier-3-catalog-only";
}

/**
 * Type guard: true for a tier-2-shim entry that hasn't been enabled yet.
 * Callers should check this BEFORE isCatalogOnly so the tier-2 specific
 * hint wins for aider/amazon-q/cody.
 */
export function isShimNotEnabled(agent: Pick<UnifiedAgent, "runnable" | "tier">): boolean {
  return agent.tier === "tier-2-shim" && agent.runnable === false;
}

// ── Local-binary preference (Phase C, ADR-0033; borrowed from acpx) ──

/**
 * `Bun.which` shim — separated so tests can stub it without touching PATH.
 * Mirrors the pattern in agent-detection.ts but kept local here to avoid a
 * cross-module dependency loop when callers already have a BuiltInAgentSpec
 * in hand.
 */
type WhichFn = (name: string) => string | null;
let resolveWhichFn: WhichFn = (name) => (Bun.which(name) as string | null) ?? null;

/**
 * Swap the PATH-resolution implementation. Tests call this with a mock, and
 * pass `null` to restore the default. Production code should never call
 * this — `Bun.which` is authoritative.
 */
export function __setLaunchWhichFnForTests(fn: WhichFn | null): void {
  resolveWhichFn = fn ?? ((name) => (Bun.which(name) as string | null) ?? null);
}

/**
 * Resolve the preferred launch command for a built-in agent, preferring a
 * locally-installed binary over the `npx` cold-start when available.
 *
 * Borrowed from openclaw/acpx's `resolveInstalledBuiltInAgentLaunch`
 * (<https://github.com/openclaw/acpx/blob/main/src/agent-registry.ts>, MIT).
 * See `docs/references/openclaw-acpx.md` for attribution + scope boundary.
 *
 * Rationale: `npx -y @agentclientprotocol/claude-agent-acp@latest` costs
 * 2–5s of cold-start on every invocation even when the package is already
 * cached — npx still walks the registry to resolve `@latest`. If the user
 * has the adapter installed globally (`npm i -g @agentclientprotocol/
 * claude-agent-acp`), its shipped binary is on PATH as `claude-agent-acp`
 * and we can skip npx entirely.
 *
 * Returns the original `spec.command` when:
 *   - `spec.localBinary` is unset (agent opted out of local-bin preference), OR
 *   - the binary name is not on PATH.
 *
 * Returns the local binary path when it IS on PATH.
 */
export function resolveInstalledBuiltInAgentLaunch(
  _name: string,
  spec: BuiltInAgentSpec,
): string {
  if (!spec.localBinary) return spec.command;
  const resolved = resolveWhichFn(spec.localBinary);
  if (!resolved) return spec.command;
  return resolved;
}
