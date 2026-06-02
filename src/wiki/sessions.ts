/**
 * Multi-adapter session enumeration for the wiki harvester (ADR-0054 R8).
 *
 * The harvester used to be wired for only claude-code in practice, so the vast
 * majority of agent sessions never fed the wiki ("the shelf stays empty"). This
 * module closes that gap by enumerating sessions across the adapters that
 * actually ship a {@link SessionReader} — claude-code plus the next most common
 * tools — and streaming them to the caller for harvest.
 *
 * It does NOT reimplement any reader: it consumes the existing per-adapter
 * `SessionReader` interface (`hasSessionStorage` / `listSessions` /
 * `loadSession`) via the adapter registry. The registry dependency is injected
 * (defaulting to the real one) so the enumeration logic is unit-testable without
 * touching the filesystem.
 *
 * Layering: `src/wiki/*` may depend on the adapter registry the same way
 * `src/commands/wiki.ts` already does; the registry itself only imports
 * `src/adapters/types.ts`, so there is no cycle back into `src/wiki/*`.
 */

import { getAdapter, listAdapters } from "../adapters/registry";
import type { Adapter } from "../adapters/types";
import type { Session, SessionSummary } from "../core/session";

/**
 * The harvest adapter priority order (ADR-0054 R8).
 *
 * claude-code first (the primary harvest target), then the next five most
 * common tools that expose a `SessionReader`. Every name here has an existing
 * `src/adapters/<name>/session.ts`; this list is the "top-6" the ADR calls for.
 * Adapters with a reader that are NOT in this list (e.g. roo-code, gemini-cli)
 * are still reachable via {@link enumerateSessions} when `adapters` is passed
 * explicitly or when `all` is set — the constant only fixes the *default*
 * priority for the unqualified `am wiki ingest`/`harvest` path.
 */
export const TOP_HARVEST_ADAPTERS: readonly string[] = [
  "claude-code",
  "codex-cli",
  "cursor",
  "copilot",
  "cline",
  "windsurf",
] as const;

/** Minimal adapter-lookup surface this module needs (injected for tests). */
export interface AdapterSource {
  /** All known adapter names (built-in order). */
  listAdapters(): string[];
  /** Resolve a single adapter by name (may be undefined). */
  getAdapter(name: string): Promise<Adapter | undefined>;
}

/** Default source: the real adapter registry. */
const defaultAdapterSource: AdapterSource = {
  listAdapters,
  getAdapter,
};

/** A session summary annotated with the adapter that produced it. */
export interface EnumeratedSession {
  adapter: string;
  summary: SessionSummary;
}

export interface EnumerateOptions {
  /**
   * Explicit adapter list. When omitted, defaults to {@link TOP_HARVEST_ADAPTERS}
   * (claude-code + the top-5), unless {@link EnumerateOptions.all} is set.
   */
  adapters?: readonly string[];
  /**
   * Enumerate across EVERY adapter that exposes a session reader (not just the
   * top-6). Ignored when `adapters` is provided explicitly.
   */
  all?: boolean;
  /** Restrict enumeration to a single project path (forwarded to the reader). */
  project?: string;
  /**
   * Cap the total number of summaries returned across all adapters. Adapters
   * are visited in priority order, so the cap favours higher-priority tools.
   * Omit (or pass <= 0) for no cap.
   */
  limit?: number;
  /** Injected adapter source (defaults to the real registry). */
  source?: AdapterSource;
}

/**
 * Resolve the ordered list of adapter names to harvest from.
 *
 * - explicit `adapters` wins;
 * - else `all` → every adapter that has a `sessionReader`, in registry order;
 * - else the {@link TOP_HARVEST_ADAPTERS} default.
 */
async function resolveAdapterNames(
  opts: EnumerateOptions,
  source: AdapterSource,
): Promise<string[]> {
  if (opts.adapters) return [...opts.adapters];
  if (opts.all) {
    const names: string[] = [];
    for (const name of source.listAdapters()) {
      const adapter = await source.getAdapter(name);
      if (adapter?.sessionReader) names.push(name);
    }
    return names;
  }
  return [...TOP_HARVEST_ADAPTERS];
}

/**
 * Enumerate session summaries across the selected adapters (ADR-0054 R8).
 *
 * Adapters without a `sessionReader`, or whose storage is absent
 * (`hasSessionStorage() === false`), or whose `listSessions` throws, are
 * silently skipped — a single broken/empty tool must never abort a harvest
 * sweep. Results preserve adapter priority order; within an adapter the reader's
 * own ordering is preserved.
 */
export async function enumerateSessions(opts: EnumerateOptions = {}): Promise<EnumeratedSession[]> {
  const source = opts.source ?? defaultAdapterSource;
  const names = await resolveAdapterNames(opts, source);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : undefined;

  const out: EnumeratedSession[] = [];

  for (const name of names) {
    if (limit !== undefined && out.length >= limit) break;

    let adapter: Adapter | undefined;
    try {
      adapter = await source.getAdapter(name);
    } catch {
      continue;
    }
    const reader = adapter?.sessionReader;
    if (!reader) continue;

    try {
      if (!reader.hasSessionStorage()) continue;
    } catch {
      continue;
    }

    let summaries: SessionSummary[];
    try {
      summaries = await reader.listSessions(opts.project);
    } catch {
      continue;
    }

    for (const summary of summaries) {
      if (limit !== undefined && out.length >= limit) break;
      // Normalise the adapter field — some readers stamp it, but enumeration is
      // the authoritative source of which adapter the summary came from.
      out.push({ adapter: name, summary: { ...summary, adapter: name } });
    }
  }

  return out;
}

/**
 * Load a single enumerated session via its adapter's reader (ADR-0054 R8).
 * Returns null when the adapter/reader is gone or the load fails — callers skip
 * nulls rather than aborting a sweep.
 */
export async function loadEnumeratedSession(
  enumerated: EnumeratedSession,
  source: AdapterSource = defaultAdapterSource,
): Promise<Session | null> {
  let adapter: Adapter | undefined;
  try {
    adapter = await source.getAdapter(enumerated.adapter);
  } catch {
    return null;
  }
  const reader = adapter?.sessionReader;
  if (!reader) return null;
  try {
    return await reader.loadSession(enumerated.summary.id);
  } catch {
    return null;
  }
}
