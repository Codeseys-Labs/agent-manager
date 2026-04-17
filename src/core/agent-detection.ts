/**
 * Agent installation detection — answer "is this ACP agent actually
 * installed locally?" without spawning the binary.
 *
 * Two tiers:
 *   Tier 1 (PATH check):      `Bun.which(<binary>)` — cheap, ~microseconds.
 *   Tier 2 (adapter derived): reuse an existing adapter's detect() result
 *                             when the paired adapter already knows how to
 *                             find the IDE/host tool on disk.
 *
 * Results are cached per-process; tests can call `resetAgentDetectionCache()`.
 *
 * See docs/reviews/2026-04-17-iter4-system-critique/02-agent-auto-detection.md
 * for the full design and R2 mapping rationale.
 */

import { getAdapter } from "../adapters/registry";
import type { DetectResult } from "../adapters/types";
import { BUILT_IN_ACP_AGENTS } from "./agent-registry";

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
}

// ── Agent → binary / adapter mapping ───────────────────────────

/**
 * Agent name → primary binary to PATH-check.
 *
 * Notes:
 *  - `claude` and `codex` use `npx …@latest` at runtime; the PATH binary
 *    that really tells us "the IDE is installed" is the host CLI.
 *  - `cursor`, `copilot`, `kiro`, `amazon-q`, `windsurf`, `roo-code`,
 *    `cline` all have paired adapters that detect the IDE/extension, but
 *    the ACP runtime ships as a separate CLI (see the map).
 *  - The remaining six have no paired adapter and rely on PATH only.
 */
export const AGENT_BINARIES: Record<string, string> = {
  // paired with an adapter; PATH binary is the IDE itself
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  // paired with an adapter; PATH binary is a *separate* ACP CLI
  cursor: "cursor-agent",
  copilot: "copilot",
  kiro: "kiro-cli-chat",
  "amazon-q": "q",
  cline: "cline",
  "roo-code": "roo",
  windsurf: "windsurf-cli",
  // no adapter — PATH-only
  aider: "aider",
  amp: "amp",
  augment: "augment-cli",
  goose: "goose",
  devin: "devin",
  sourcegraph: "cody",
};

/**
 * Agent name → adapter name whose detect() provides the Tier-2 signal.
 * Agents not in this map rely entirely on PATH check.
 */
export const AGENT_ADAPTER_MAP: Record<string, string> = {
  claude: "claude-code",
  codex: "codex-cli",
  gemini: "gemini-cli",
  cursor: "cursor",
  copilot: "copilot",
  kiro: "kiro",
  "amazon-q": "amazon-q",
  cline: "cline",
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
 * Returns `{ installed: false, source: "none" }` for unknown agent names.
 */
export function detectAgentByPath(name: string): AgentDetection {
  const cached = pathCache.get(name);
  if (cached) return cached;

  const binary = AGENT_BINARIES[name];
  if (!binary) {
    const miss: AgentDetection = { installed: false, source: "none" };
    pathCache.set(name, miss);
    return miss;
  }

  const resolved = whichFn(binary);
  const hit: AgentDetection = resolved
    ? { installed: true, source: "path", binary: resolved }
    : { installed: false, source: "none" };
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
    const result = cache.get(adapterName);
    if (!result) {
      out[agentName] = { installed: false, source: "none", adapterDetected: false };
      continue;
    }
    out[agentName] = {
      installed: result.installed,
      source: result.installed ? "adapter" : "none",
      adapterDetected: result.installed,
      ...(result.version ? { version: result.version } : {}),
    };
  }
  return out;
}

// ── Combined ───────────────────────────────────────────────────

/**
 * Combined Tier-1 + Tier-2 detection for every agent in
 * `BUILT_IN_ACP_AGENTS`. The PATH check is authoritative for `installed`
 * when it hits; otherwise we fall back to the adapter signal. `source`
 * records which tier provided the verdict.
 *
 * Cheap — no RPC probes, no subprocess spawn. Runs all I/O concurrently.
 * Cached across invocations for the lifetime of the process.
 */
export async function detectAllAgents(): Promise<Record<string, AgentDetection>> {
  if (allCache) return allCache;

  const adapterResults = await detectAgentsViaAdapters();

  const result: Record<string, AgentDetection> = {};
  for (const name of Object.keys(BUILT_IN_ACP_AGENTS)) {
    const pathResult = detectAgentByPath(name);
    const adapterResult = adapterResults[name];

    if (pathResult.installed) {
      // PATH hit is authoritative. Fold in adapter metadata when present.
      result[name] = {
        installed: true,
        source: "path",
        binary: pathResult.binary,
        adapterDetected: adapterResult?.adapterDetected ?? false,
        ...(adapterResult?.version ? { version: adapterResult.version } : {}),
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
      };
      continue;
    }

    result[name] = {
      installed: false,
      source: "none",
      adapterDetected: adapterResult?.adapterDetected ?? false,
    };
  }

  allCache = result;
  return result;
}
