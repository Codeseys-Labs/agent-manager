/**
 * Agent installation detection — answer "is this ACP agent actually
 * installed locally?" without spawning the binary.
 *
 * Two tiers (orthogonal to the ADR-0033 agent tiers):
 *   Tier 1 (PATH check):      `Bun.which(<binary>)` — cheap, ~microseconds.
 *   Tier 2 (adapter derived): reuse an existing adapter's detect() result
 *                             when the paired adapter already knows how to
 *                             find the IDE/host tool on disk.
 *
 * Results are cached per-process; tests can call `resetAgentDetectionCache()`.
 *
 * See docs/reviews/2026-04-17-iter4-system-critique/02-agent-auto-detection.md
 * for the full design and R2 mapping rationale.
 *
 * ADR-0033 split the old 16-entry `BUILT_IN_ACP_AGENTS` into tiered
 * `BUILT_IN_AGENTS`. This file was pruned alongside — PATH mappings exist
 * only for agents currently in BUILT_IN_AGENTS. Tier-3 (catalog-only)
 * entries have their PATH-check suppressed since the adapter's detect()
 * is the authoritative signal (a VSCode extension isn't on PATH).
 */

import { getAdapter } from "../adapters/registry";
import type { DetectResult } from "../adapters/types";
import { type AgentTier, BUILT_IN_AGENTS } from "./agent-registry";

// ── Types ──────────────────────────────────────────────────────

export interface AgentDetection {
  /** Final installed verdict combining PATH + adapter tiers. */
  installed: boolean;
  /** Which signal produced `installed: true`. */
  source: "path" | "adapter" | "none";
  /** Absolute path to the resolved binary when source === "path". */
  binary?: string;
  /** True when the paired adapter's detect() reported installed. */
  adapterDetected?: boolean;
  /** Tool version string if cheaply derivable from the adapter. */
  version?: string;
  /**
   * Tier from the canonical {@link BUILT_IN_AGENTS} entry, when known.
   * Exposed so `am agent list` and friends don't have to re-lookup.
   */
  tier?: AgentTier;
}

// ── Agent → binary / adapter mapping ───────────────────────────

/**
 * Agent name → primary binary to PATH-check.
 *
 * Populated only for names in BUILT_IN_AGENTS (ADR-0033). Tier-3
 * catalog-only agents are excluded — their detect() signal comes from
 * their paired adapter (the IDE extension), not from PATH.
 *
 * Notes:
 *  - `claude` and `codex` use `npx …@latest` at runtime; the PATH binary
 *    that really tells us "the IDE is installed" is the host CLI.
 *  - `gemini` and `kiro` ship as first-party CLIs.
 */
export const AGENT_BINARIES: Record<string, string> = {
  // tier-1-native
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  kiro: "kiro-cli-chat",
  // NOTE: no tier-3 entries here. Catalog-only agents are detected via
  // their paired adapter (see AGENT_ADAPTER_MAP), never via PATH.
};

/**
 * Agent name → adapter name whose detect() provides the Tier-2 signal.
 * Includes every entry in BUILT_IN_AGENTS (ADR-0033):
 *   - tier-1-native agents have an adapter providing the IDE-installed signal.
 *   - tier-3-catalog-only agents use the adapter as their ONLY install signal
 *     (they have no spawnable binary).
 */
export const AGENT_ADAPTER_MAP: Record<string, string> = {
  // tier-1-native
  claude: "claude-code",
  codex: "codex-cli",
  gemini: "gemini-cli",
  kiro: "kiro",
  // tier-3-catalog-only
  cline: "cline",
  continue: "continue",
  copilot: "copilot",
  cursor: "cursor",
  "kilo-code": "kilo-code",
  "roo-code": "roo-code",
  windsurf: "windsurf",
};

// ── Cache ──────────────────────────────────────────────────────

let pathCache = new Map<string, AgentDetection>();
let adapterCache: Map<string, DetectResult> | null = null;
let allCache: Record<string, AgentDetection> | null = null;

/**
 * Reset the per-process detection cache. Intended for tests — production
 * code should rely on module lifetime for caching.
 */
export function resetAgentDetectionCache(): void {
  pathCache = new Map();
  adapterCache = null;
  allCache = null;
}

/**
 * Swap the `Bun.which` implementation for testing.
 *
 * Default implementation is `Bun.which`. Callers set a mock with
 * `__setWhichFn(mock)` and restore with `__setWhichFn(null)`.
 */
type WhichFn = (name: string) => string | null;
let whichFn: WhichFn = (name: string) => (Bun.which(name) as string | null) ?? null;
export function __setWhichFn(fn: WhichFn | null): void {
  whichFn = fn ?? ((name) => (Bun.which(name) as string | null) ?? null);
  pathCache = new Map(); // PATH results invalidated when the fn changes
  allCache = null;
}

// ── Tier 1: PATH check ─────────────────────────────────────────

/**
 * Cheap PATH check for a single agent. Caches the first result per process
 * so repeated calls are free. No subprocess spawn, no RPC.
 *
 * Returns `{ installed: false, source: "none" }` for unknown agent names
 * and for tier-3 catalog-only agents (those don't expose a PATH binary).
 */
export function detectAgentByPath(name: string): AgentDetection {
  const cached = pathCache.get(name);
  if (cached) return cached;

  const tier = BUILT_IN_AGENTS[name]?.tier;
  const binary = AGENT_BINARIES[name];
  if (!binary) {
    const miss: AgentDetection = {
      installed: false,
      source: "none",
      ...(tier ? { tier } : {}),
    };
    pathCache.set(name, miss);
    return miss;
  }

  const resolved = whichFn(binary);
  const hit: AgentDetection = resolved
    ? { installed: true, source: "path", binary: resolved, ...(tier ? { tier } : {}) }
    : { installed: false, source: "none", ...(tier ? { tier } : {}) };
  pathCache.set(name, hit);
  return hit;
}

// ── Tier 2: adapter-derived ────────────────────────────────────

async function getAdapterDetectCache(): Promise<Map<string, DetectResult>> {
  if (adapterCache) return adapterCache;
  const cache = new Map<string, DetectResult>();
  // We only look up adapters referenced by AGENT_ADAPTER_MAP — no need to
  // scan every registered adapter in the repo.
  const needed = new Set(Object.values(AGENT_ADAPTER_MAP));
  await Promise.all(
    [...needed].map(async (adapterName) => {
      try {
        const adapter = await getAdapter(adapterName);
        if (!adapter) return;
        const result = await adapter.detect();
        cache.set(adapterName, result);
      } catch {
        // Missing or broken adapter is not fatal — treat as "not detected".
      }
    }),
  );
  adapterCache = cache;
  return cache;
}

/**
 * Tier 2: derive an installation verdict from each paired adapter's
 * `detect()` result. Returns a map keyed by agent name. Only includes
 * agents that have an adapter mapping.
 */
export async function detectAgentsViaAdapters(): Promise<Record<string, AgentDetection>> {
  const cache = await getAdapterDetectCache();
  const out: Record<string, AgentDetection> = {};
  for (const [agentName, adapterName] of Object.entries(AGENT_ADAPTER_MAP)) {
    const tier = BUILT_IN_AGENTS[agentName]?.tier;
    const result = cache.get(adapterName);
    if (!result) {
      out[agentName] = {
        installed: false,
        source: "none",
        adapterDetected: false,
        ...(tier ? { tier } : {}),
      };
      continue;
    }
    out[agentName] = {
      installed: result.installed,
      source: result.installed ? "adapter" : "none",
      adapterDetected: result.installed,
      ...(result.version ? { version: result.version } : {}),
      ...(tier ? { tier } : {}),
    };
  }
  return out;
}

// ── Combined ───────────────────────────────────────────────────

/**
 * Combined Tier-1 + Tier-2 detection for every agent in
 * {@link BUILT_IN_AGENTS}. The PATH check is authoritative for `installed`
 * when it hits; otherwise we fall back to the adapter signal. `source`
 * records which tier provided the verdict.
 *
 * For tier-3 catalog-only agents (no spawnable binary, no PATH entry),
 * the adapter signal is the ONLY signal. `runnable` on the paired
 * `UnifiedAgent` remains `false` regardless — that's a product decision,
 * not an install one.
 *
 * Cheap — no RPC probes, no subprocess spawn. Runs all I/O concurrently.
 * Cached across invocations for the lifetime of the process.
 */
export async function detectAllAgents(): Promise<Record<string, AgentDetection>> {
  if (allCache) return allCache;

  const adapterResults = await detectAgentsViaAdapters();

  const result: Record<string, AgentDetection> = {};
  for (const [name, spec] of Object.entries(BUILT_IN_AGENTS)) {
    const pathResult = detectAgentByPath(name);
    const adapterResult = adapterResults[name];
    const tier = spec.tier;

    if (pathResult.installed) {
      // PATH hit is authoritative. Fold in adapter metadata when present.
      result[name] = {
        installed: true,
        source: "path",
        binary: pathResult.binary,
        adapterDetected: adapterResult?.adapterDetected ?? false,
        ...(adapterResult?.version ? { version: adapterResult.version } : {}),
        tier,
      };
      continue;
    }

    if (adapterResult?.installed) {
      // Adapter says the IDE/host tool is present but the ACP binary isn't
      // on PATH. Surface this as "host-only" by leaving `installed=true`
      // via the adapter source — callers can disambiguate via
      // `adapterDetected` + absent `binary`.
      result[name] = {
        installed: true,
        source: "adapter",
        adapterDetected: true,
        ...(adapterResult.version ? { version: adapterResult.version } : {}),
        tier,
      };
      continue;
    }

    result[name] = {
      installed: false,
      source: "none",
      adapterDetected: adapterResult?.adapterDetected ?? false,
      tier,
    };
  }

  allCache = result;
  return result;
}
