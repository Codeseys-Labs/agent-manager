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
import { getDefaultBackend, interpolateEnvAsync, loadKey, selectBackendName } from "./secrets";
import type { SecretsBackend } from "./secrets-backend";
import { readActiveProfile } from "./state";
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

/**
 * Test-only adapter-resolution seam (mirrors the `__set...ForTests` pattern
 * in `src/commands/run.ts`). When set, `applyResolved` resolves adapters via
 * this override instead of the real registry. This lets the SEC-4 drift-gate
 * tests inject an adapter whose `diff()` throws WITHOUT globally mocking
 * `../adapters/registry` (`mock.module` is process-global in Bun and leaks
 * into other test files — it is NOT undone by `mock.restore()`). Each test
 * sets this in a try/finally and clears it with `null`. Never set in prod.
 */
type AdapterResolver = (target: string | undefined) => Promise<Adapter[]>;
let adapterResolverOverride: AdapterResolver | null = null;

/** @internal test seam — see `adapterResolverOverride`. */
export function __setAdapterResolverForTests(fn: AdapterResolver | null): void {
  adapterResolverOverride = fn;
}

/**
 * Deep-scan a config tree for any ADR-0042 age envelope (`enc:v2:age:`).
 *
 * Used by the apply pipeline to decide whether to load the age backend even
 * when the *write* backend is still legacy v1 — a config can hold v2
 * envelopes after `am secrets migrate --to age` while the default backend
 * setting lags. Without this, applying such a config would fail-loud on the
 * first v2 envelope (correct, but unhelpful when the user CAN decrypt).
 */
function configContainsAgeEnvelope(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith("enc:v2:age:");
  if (Array.isArray(value)) return value.some(configContainsAgeEnvelope);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(configContainsAgeEnvelope);
  }
  return false;
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

/**
 * CLI-default decision (Wave B apply-follow, LOW): the single source of truth
 * for the fail-closed apply posture shared by ALL FOUR write-local surfaces —
 * CLI (`am apply`), MCP (`am_apply`), web (`POST /api/apply`), and TUI (apply
 * button). Each surface derives its drift-gate behavior from this const rather
 * than hard-coding `diff: true` independently, so the safe posture cannot drift
 * apart across surfaces.
 *
 * `diff: true` makes a LIVE apply run `adapter.diff()` first and SKIP (not
 * overwrite) any adapter whose native config has drifted out of band, or whose
 * drift state cannot even be read (diff() threw). `force: false` means the
 * caller has NOT opted into overwriting — each surface exposes its own opt-in
 * (CLI `--force`, MCP `force=true`, web/TUI `{ force: true }`).
 *
 * Rationale for fail-closed-by-default (SEC-4b lineage, the 2026-04-15
 * `~/.claude.json` wipe class): the most common human invocation is a bare
 * `am apply`, and previously that blindly overwrote a hand-edited native config.
 * A first apply (no native file yet) reports `unmanaged`/`in-sync` — NOT
 * `drifted` — so fresh-init and round-trip UX are unaffected; only a genuinely
 * drifted target is gated. `AM_APPLY_BACKUP` remains the recovery path, and
 * `--force` is always one flag away.
 */
export const APPLY_SAFE_DEFAULTS = { diff: true, force: false } as const;

export interface ApplyResolvedOptions {
  dryRun?: boolean;
  /** Restrict to a single adapter by name. */
  target?: string;
  /**
   * P1-B: restrict to an explicit set of adapters by name (per-target
   * opt-in). When present, only these adapters are applied — a superset of
   * `target` for callers (e.g. the interactive CLI selection or a
   * `--targets a,b` flag) that need to scope the fan-out to more than one
   * tool without applying to every detected adapter. `target` (singular)
   * still works and is treated as a one-element `targets`. An unknown name
   * throws, mirroring the single-`target` path. The controller stays
   * I/O-free: it only resolves the named adapters; the surface owns how the
   * list was chosen (TTY prompt, flag, JSON body).
   */
  targets?: string[];
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
  /**
   * ADR-0038: when true, run `adapter.diff(resolved)` before export and
   * surface drift on each `ApplyAdapterResult`. Useful in dry-run for
   * preview, and in live mode to gate writes via `force` (below).
   */
  diff?: boolean;
  /**
   * ADR-0038: when true, force-overwrite even if the adapter shows
   * drift between native config and the catalog. Ignored when `diff`
   * is false (no drift gate exists in that path). Has no effect in
   * dry-run mode.
   */
  force?: boolean;
}

export interface ApplyAdapterResult {
  adapter: string;
  files: Array<{ path: string; written: boolean }>;
  warnings: string[];
  error?: string;
  /**
   * ADR-0038 (`--diff`): drift summary surfaced when the caller passed
   * `diff: true`. Omitted otherwise so legacy consumers don't see a
   * field they don't expect.
   */
  diff?: { status: "in-sync" | "drifted" | "unmanaged"; changes: number };
}

export interface ApplyResolvedResult {
  action: "apply";
  profile: string;
  dryRun: boolean;
  results: ApplyAdapterResult[];
  succeeded: string[];
  failed: Array<{ adapter: string; error: string }>;
  skipped: string[];
  /**
   * Advisory, non-error notices surfaced by the apply pipeline. Currently
   * carries the default-passthrough signpost (P1-H): when no profile scopes
   * the catalog, the ENTIRE catalog fans out to every detected tool. Machine
   * callers (MCP / web) can merge these into their own response; the CLI
   * renders them at info level.
   */
  notices: string[];
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

    // Format-aware decrypt (P0-3 fix). Always load the legacy AES key for
    // `enc:v1:` envelopes. ALSO load the age backend when EITHER the config
    // selects `age` OR the config already contains `enc:v2:age:` envelopes
    // (the post-`am secrets migrate` state) — so those are decrypted here
    // instead of leaking ciphertext into native configs. Any unknown `enc:`
    // prefix makes the decode walk throw — the apply aborts loudly rather
    // than writing corrupt secrets to disk.
    const encryptionKey = await loadKey(configDir);
    let ageBackend: SecretsBackend | null = null;
    if (selectBackendName(config) === "age" || configContainsAgeEnvelope(config)) {
      ageBackend = await getDefaultBackend(configDir, { config, override: "age" });
    }
    const { config: interpolated } = await interpolateEnvAsync(config, {
      encryptionKey: encryptionKey ?? undefined,
      ageBackend,
    });
    const resolved = buildResolvedConfig(interpolated, profileName, configDir);

    // P1-H default-passthrough signpost. `buildResolvedConfig` only filters
    // the catalog when a matching `[profiles.<name>]` exists; otherwise the
    // resolved config is the ENTIRE catalog (the fail-open "default"
    // passthrough — controller resolves to "default" when no profile is set,
    // and config.ts applies no filtering for a non-existent profile). When
    // that happens we have no idea the user *meant* to scope, so we add an
    // advisory notice telling them how many servers fan out to how many
    // tools and how to narrow it. This stays advisory (no exit code change).
    const notices: string[] = [];
    const profileScoped = interpolated.profiles?.[profileName] !== undefined;

    // Issue #3 URL-credential guard: refuse to write native configs that would
    // leak a credential embedded in a URL query param.
    //
    // MEMBERSHIP vs VALUES (review finding D): which servers get exported is
    // decided by `resolved` (built from the INTERPOLATED config — profile
    // server_tags/inherits can use `${VAR}` tags that only resolve after
    // interpolation). But the VALUES we must scan are the RAW pre-interpolation
    // ones, because `scanUrlForCredentials` exempts `${VAR}` placeholders — so a
    // properly-obfuscated `?tavilyApiKey=${TAVILYAPIKEY}` PASSES while a
    // hardcoded `?tavilyApiKey=tvly-…` is refused. Scanning raw values on the
    // RAW membership set (the old bug) missed `${VAR}`-tagged servers that DO
    // get exported; scanning interpolated values would wrongly refuse the
    // obfuscated case. Fix: take membership from `resolved`, re-key onto raw
    // `config.servers[name]` values, scan that.
    const guardServers: Record<string, unknown> = {};
    for (const name of Object.keys(resolved.servers ?? {})) {
      guardServers[name] = config.servers?.[name] ?? resolved.servers?.[name];
    }
    const credentialHits = scanServersForUrlCredentials(
      guardServers as Parameters<typeof scanServersForUrlCredentials>[0],
    );
    if (credentialHits.length > 0) {
      throw new Error(formatCredentialHits(credentialHits));
    }

    // Normalize the explicit-target selection: `targets[]` is the general
    // form; a singular `target` is folded in as a one-element list. Empty /
    // whitespace names are dropped so a stray `--targets ,` doesn't resolve
    // to an empty fan-out that silently writes nothing.
    const explicitTargets = [
      ...(options.targets ?? []),
      ...(options.target ? [options.target] : []),
    ]
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    let adapters: Adapter[];
    if (adapterResolverOverride) {
      // Test seam only — see `__setAdapterResolverForTests`.
      adapters = await adapterResolverOverride(options.target);
    } else if (explicitTargets.length > 0) {
      // De-dupe while preserving order so `--targets a,a,b` resolves once.
      const seen = new Set<string>();
      const resolved: Adapter[] = [];
      for (const name of explicitTargets) {
        if (seen.has(name)) continue;
        seen.add(name);
        const adapter = await getAdapter(name);
        if (!adapter) {
          throw new Error(`Adapter "${name}" not found. Available: ${listAdapters().join(", ")}`);
        }
        resolved.push(adapter);
      }
      adapters = resolved;
    } else {
      adapters = await getDetectedAdapters();
    }

    // Emit the P1-H signpost only when the catalog is unscoped AND there is
    // something to fan out (servers × tools). A scoped profile, an empty
    // catalog, or zero detected tools all make the notice noise.
    const serverCount = Object.keys(resolved.servers ?? {}).length;
    if (!profileScoped && serverCount > 0 && adapters.length > 0) {
      const serverWord = serverCount === 1 ? "server" : "servers";
      const toolWord = adapters.length === 1 ? "tool" : "tools";
      const notice = `applying all ${serverCount} ${serverWord} to ${adapters.length} ${toolWord} — define a profile to scope this`;
      // Advisory only. The controller is I/O-free by design (ADR-0040) — it
      // RETURNS notices in ApplyResolvedResult.notices; each caller decides how
      // to surface them (the CLI renders them via info(); MCP/web can merge them
      // into their JSON payloads or ignore them). No direct process I/O here.
      notices.push(notice);
    }

    const results: ApplyAdapterResult[] = [];
    const succeeded: string[] = [];
    const failed: Array<{ adapter: string; error: string }> = [];
    const skipped: string[] = [];

    for (const adapter of adapters) {
      try {
        // ADR-0038 (`--diff` / `--force`): when caller asks for diff, run
        // adapter.diff() against the resolved config first. The result is
        // attached to the per-adapter output AND used to gate the live
        // write: if drift is detected and `force` is not set, we skip the
        // write and surface a warning instead.
        let driftSummary:
          | { status: "in-sync" | "drifted" | "unmanaged"; changes: number }
          | undefined;
        let skipDueToDrift = false;
        // SEC-4: a thrown diff() means drift is UNKNOWN, not absent. In
        // `--diff` live mode without `--force` we must NOT assume the native
        // config is clean — that would silently overwrite a possibly-drifted
        // file (fail-open). Treat an exception as "drift unknown" and skip the
        // adapter (fail-closed/safe) with a clear warning. The warning carries
        // the diff failure reason so the user can re-run with --force after
        // inspecting. See the 2026-04-15 `~/.claude.json` wipe lineage.
        let skipDueToDiffError = false;
        let diffErrorMessage: string | undefined;
        if (options.diff) {
          try {
            const diff = await adapter.diff(resolved);
            driftSummary = { status: diff.status, changes: diff.changes.length };
            if (
              !options.dryRun &&
              !options.force &&
              diff.status === "drifted" &&
              diff.changes.length > 0
            ) {
              skipDueToDrift = true;
            }
          } catch (e: unknown) {
            // Drift is now UNKNOWN. We only have safe defaults for the live
            // gate: in dry-run we can't write anyway (preview), and with
            // --force the caller has explicitly opted into overwriting. In
            // live mode WITHOUT --force we fail closed — skip rather than
            // overwrite a config whose drift state we cannot confirm.
            driftSummary = undefined;
            if (!options.dryRun && !options.force) {
              skipDueToDiffError = true;
              diffErrorMessage = (e instanceof Error ? e.message : String(e)) || "diff failed";
            }
            // dry-run / --force: best-effort diff failed — fall through to
            // export() as before (no live gate to honor).
          }
        }

        if (skipDueToDiffError) {
          // SEC-4 fail-closed gate: diff() threw, so we can't confirm the
          // native config is in sync. Refuse to overwrite without --force.
          results.push({
            adapter: adapter.meta.name,
            files: [],
            warnings: [
              `drift check failed (${diffErrorMessage}); drift state unknown — refusing to overwrite. Re-run with --force to apply anyway.`,
            ],
          });
          skipped.push(adapter.meta.name);
          continue;
        }

        if (skipDueToDrift) {
          // Drift gate: refuse to overwrite without --force. Emit a
          // structured result (no files written) and a warning so JSON
          // consumers and humans both see the gate fired.
          results.push({
            adapter: adapter.meta.name,
            files: [],
            warnings: [
              `drift detected (${driftSummary?.changes ?? 0} change${
                (driftSummary?.changes ?? 0) === 1 ? "" : "s"
              }); refusing to overwrite — re-run with --force to apply anyway`,
            ],
            ...(driftSummary ? { diff: driftSummary } : {}),
          });
          skipped.push(adapter.meta.name);
          continue;
        }

        const result = await adapter.export(resolved, {
          projectPath: projectFile ? join(projectFile, "..") : options.projectPath,
          dryRun: !!options.dryRun,
        });
        results.push({
          adapter: adapter.meta.name,
          files: result.files.map((f) => ({ path: f.path, written: f.written })),
          warnings: result.warnings,
          ...(driftSummary ? { diff: driftSummary } : {}),
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
      notices,
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
