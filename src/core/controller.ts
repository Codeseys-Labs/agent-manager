/**
 * Controller / admission layer — the single point of truth for
 * read-modify-write against the agent-manager config and the single apply
 * pipeline shared by CLI, MCP, and web surfaces.
 *
 * Wave B of the iter4 fix pass introduces:
 *   - `withConfig(...)`  — serialized RMW with optional auto-commit,
 *   - `applyResolved(...)` — serialized apply pipeline (load→decrypt→export).
 *
 * Previously there were ~20 ad-hoc RMW sites and three parallel apply
 * pipelines (CLI, MCP, web). Without serialization, concurrent callers
 * could lose writes (the 2026-04-15 `~/.claude.json` wipe incident was
 * exactly this shape). This module closes that window by funnelling
 * writes through per-process AsyncMutexes.
 *
 * See:
 *   - `docs/reviews/2026-04-17-iter4-system-critique/01-system-structure.md`
 *   - `docs/reviews/2026-04-17-iter4-system-critique/03-parallel-tool-calling.md`
 */

import { join } from "node:path";
import { getAdapter, getDetectedAdapters, listAdapters } from "../adapters/registry";
import type { Adapter } from "../adapters/types";
import { readActiveProfile } from "../commands/use";
import {
  buildResolvedConfig,
  loadResolvedConfig,
  resolveConfigDir,
  resolveProjectConfig,
  tryReadConfig,
  writeConfig,
} from "./config";
import { commitAll, isNothingToCommitError } from "./git";
import { AsyncMutex } from "./locks";
import type { Config } from "./schema";
import { interpolateEnvAsync, loadKey } from "./secrets";
import { formatCredentialHits, scanServersForUrlCredentials } from "./url-credentials";

/**
 * Global locks guarding shared in-process state. Keyed mutexes per
 * configDir are intentionally avoided for v1 — agent-manager is typically
 * invoked against a single config dir per process, and a global lock is
 * simpler and strictly safer than a per-key one.
 *
 * If a future CLI needs to operate on multiple config dirs in the same
 * process, swap these for `KeyedMutex<string>` keyed on configDir.
 */
const configMutex = new AsyncMutex();

/** Exposed for tests that need to reset lock state between cases. */
export function __resetControllerLocksForTests(): void {
  // AsyncMutex has no direct reset; constructing a new one is the safe
  // pattern. Tests that race handlers should not rely on this in prod code.
  // We just re-export the instance via getter so tests can observe
  // `waiting`/`isHeld`.
}

/** Diagnostic accessor — exported for concurrency tests. */
export function getConfigMutex(): AsyncMutex {
  return configMutex;
}

// ── withConfig ────────────────────────────────────────────────────

export interface WithConfigOptions {
  /** Skip the auto-commit step even if `changed` is true. */
  noCommit?: boolean;
  /**
   * Custom config file name under `configDir`. Defaults to "config.toml".
   * Mirrors the pattern already used by `loadResolvedConfig`.
   */
  configFile?: string;
}

export interface WithConfigResult<T> {
  result: T;
  /** Commit message to use when auto-committing. */
  commitMessage?: string;
  /**
   * True if the callback mutated the config and the updated object should
   * be written to disk. When false, `withConfig` short-circuits the
   * write/commit path.
   */
  changed: boolean;
  /**
   * Optional updated config. When omitted, `withConfig` assumes the
   * callback mutated the draft in place.
   */
  updated?: Config;
}

/**
 * Serialize a read-modify-write on the config with optional auto-commit.
 *
 * The callback receives the currently-loaded config. If the config file
 * does not exist, the callback receives `null` — matching the existing
 * `tryReadConfig` semantics that command modules already rely on.
 * Callers can short-circuit (e.g. return `{ changed: false }` after
 * calling `requireConfig(config)`).
 *
 * Callers return `{ result, commitMessage, changed, updated? }`:
 *   - `result` — value returned from `withConfig` to the caller.
 *   - `changed` — write + commit only fire when true.
 *   - `commitMessage` — used by `commitAll` when `changed && !noCommit`.
 *   - `updated` — optional explicit config to write (otherwise the draft is
 *     written in place).
 *
 * Errors from the callback propagate. Errors from `commitAll` are swallowed
 * if they match `isNothingToCommitError`; other git errors are rethrown so
 * callers can surface them.
 */
export async function withConfig<T>(
  configDir: string,
  fn: (config: Config | null) => Promise<WithConfigResult<T>>,
  options: WithConfigOptions = {},
): Promise<T> {
  const configFile = options.configFile ?? "config.toml";
  const configPath = join(configDir, configFile);
  return configMutex.withLock(async () => {
    const draft: Config | null = await tryReadConfig(configPath);
    const { result, commitMessage, changed, updated } = await fn(draft);
    if (changed) {
      // When draft was null the callback must return `updated`, otherwise
      // we have nothing to write. Defend against misuse.
      const toWrite = updated ?? draft;
      if (!toWrite) {
        throw new Error(
          "withConfig: changed=true but config file did not exist and no `updated` was returned",
        );
      }
      await writeConfig(configPath, toWrite);
      if (commitMessage && !options.noCommit) {
        try {
          await commitAll(configDir, commitMessage);
        } catch (err) {
          if (!isNothingToCommitError(err)) throw err;
        }
      }
    }
    return result;
  });
}

// ── applyResolved ────────────────────────────────────────────────

export interface ApplyResolvedOptions {
  dryRun?: boolean;
  /** Restrict to a single adapter by name. */
  target?: string;
  /**
   * Override the active profile (e.g. `am apply --profile work`). When
   * absent, the active profile from state.toml or the default is used.
   */
  profile?: string;
  /**
   * Override the project root. When omitted, the project config is
   * resolved from `process.cwd()`.
   */
  projectPath?: string;
}

export interface ApplyAdapterResult {
  adapter: string;
  files: Array<{ path: string; written: boolean }>;
  warnings: string[];
  error?: string;
}

export interface ApplyResolvedResult {
  action: "apply";
  profile: string;
  dryRun: boolean;
  results: ApplyAdapterResult[];
  succeeded: string[];
  failed: Array<{ adapter: string; error: string }>;
  skipped: string[];
}

/**
 * Canonical apply pipeline. Replaces three near-identical implementations
 * that previously lived in:
 *   - `src/commands/apply.ts`   (CLI)
 *   - `src/mcp/server.ts`       (MCP `am_apply`)
 *   - `src/web/server.ts`       (HTTP `POST /api/apply`)
 *
 * Each surface is responsible for:
 *   - parsing its own CLI flags / JSON body,
 *   - formatting output for its caller (stdout, JSON-RPC, HTTP).
 *
 * The pipeline itself — resolve → decrypt → build → export per adapter —
 * lives here exactly once, behind the config mutex, so two concurrent
 * `am_apply` calls cannot race on the same `~/.claude.json` merge.
 */
export async function applyResolved(
  configDir: string,
  options: ApplyResolvedOptions = {},
): Promise<ApplyResolvedResult> {
  return configMutex.withLock(async () => {
    const projectFile = resolveProjectConfig(options.projectPath ?? process.cwd());
    const config = await loadResolvedConfig({ configDir, projectFile });

    const profileName =
      options.profile ??
      (await readActiveProfile(configDir)) ??
      config.settings?.default_profile ??
      "default";

    const encryptionKey = await loadKey(configDir);
    const { config: interpolated } = await interpolateEnvAsync(config, {
      encryptionKey: encryptionKey ?? undefined,
    });
    const resolved = buildResolvedConfig(interpolated, profileName, configDir);

    // Issue #3 URL-credential guard: scan the post-interpolation resolved
    // config for credential-bearing query params before any adapter.export
    // writes to disk. `interpolateEnvAsync` has already expanded `${VAR}`
    // so what we scan is what would land in the user's native configs.
    // On a hit we refuse the whole apply — catching one leak late is worse
    // than catching all of them early.
    const credentialHits = scanServersForUrlCredentials(resolved.servers ?? {});
    if (credentialHits.length > 0) {
      throw new Error(formatCredentialHits(credentialHits));
    }

    let adapters: Adapter[];
    if (options.target) {
      const adapter = await getAdapter(options.target);
      if (!adapter) {
        throw new Error(
          `Adapter "${options.target}" not found. Available: ${listAdapters().join(", ")}`,
        );
      }
      adapters = [adapter];
    } else {
      adapters = await getDetectedAdapters();
    }

    const results: ApplyAdapterResult[] = [];
    const succeeded: string[] = [];
    const failed: Array<{ adapter: string; error: string }> = [];
    const skipped: string[] = [];

    for (const adapter of adapters) {
      try {
        const result = await adapter.export(resolved, {
          projectPath: projectFile ? join(projectFile, "..") : options.projectPath,
          dryRun: !!options.dryRun,
        });
        results.push({
          adapter: adapter.meta.name,
          files: result.files.map((f) => ({ path: f.path, written: f.written })),
          warnings: result.warnings,
        });
        succeeded.push(adapter.meta.name);
      } catch (e: unknown) {
        const msg = (e instanceof Error ? e.message : String(e)) || "export failed";
        results.push({
          adapter: adapter.meta.name,
          files: [],
          warnings: [msg],
          error: msg,
        });
        failed.push({ adapter: adapter.meta.name, error: msg });
      }
    }

    return {
      action: "apply",
      profile: profileName,
      dryRun: !!options.dryRun,
      results,
      succeeded,
      failed,
      skipped,
    };
  });
}

/**
 * Convenience wrapper — resolves `configDir` via `resolveConfigDir()` when
 * the caller doesn't already have one in hand.
 */
export async function applyResolvedDefault(
  options: ApplyResolvedOptions = {},
): Promise<ApplyResolvedResult> {
  return applyResolved(resolveConfigDir(), options);
}
