import type { RegistryPackage, RegistrySearchFilters, RegistrySearchResult } from "./types";

// ── LRU Cache ───────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Exported (seed 06d8) so tests can construct an instance with an injected
// clock and drive TTL expiry deterministically — no real waits, no global
// Date mutation. Production callers omit `now` and get the system clock.
export class LRUCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  constructor(
    private maxSize: number,
    private ttlMs: number,
    // Injectable clock seam: defaults to the system clock; tests pass a
    // controllable `() => number`. Bind the reference (not a closure) so it's
    // captured once at construction.
    private now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Strict `>`: an entry is still valid at exactly expiresAt and expires one
    // tick later (test boundary: advance by ttlMs + 1 to cross it).
    if (this.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict oldest if at capacity
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

// ── Registry Client ─────────────────────────────────────────────

export interface RegistryClientOptions {
  baseUrl?: string;
  skipCache?: boolean;
}

const DEFAULT_BASE_URL = "https://registry.modelcontextprotocol.io";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ENTRIES = 50;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

const cache = new LRUCache<unknown>(CACHE_MAX_ENTRIES, CACHE_TTL_MS);

function getBaseUrl(): string {
  return process.env.AM_REGISTRY_URL ?? DEFAULT_BASE_URL;
}

async function fetchWithRetry(url: string, opts: { skipCache?: boolean } = {}): Promise<Response> {
  const cacheKey = url;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
      });

      if (resp.status === 429) {
        // Rate limited — retry with exponential backoff
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        throw new RegistryError("Rate limited by registry. Try again in a few seconds.", 429);
      }

      if (!resp.ok) {
        throw new RegistryError(
          `Registry returned ${resp.status}: ${resp.statusText}`,
          resp.status,
        );
      }

      return resp;
    } catch (err) {
      if (err instanceof RegistryError) throw err;

      // Network error — retry or fall back to cache
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }

      // Final attempt failed — check cache
      if (!opts.skipCache) {
        const cached = cache.get(cacheKey);
        if (cached !== undefined) {
          // Return a synthetic response from cache — caller will use getJson helper
          return new Response(JSON.stringify(cached), {
            status: 200,
            headers: { "X-Cache": "fallback" },
          });
        }
      }

      throw new RegistryError(
        `Cannot reach the MCP registry at ${getBaseUrl()}. Check your network connection.`,
        0,
      );
    }
  }

  // Should not reach here
  throw new RegistryError("Unexpected retry exhaustion", 0);
}

async function getJson<T>(path: string, opts: { skipCache?: boolean } = {}): Promise<T> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;
  const cacheKey = url;

  // Check cache first
  if (!opts.skipCache) {
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached as T;
  }

  const resp = await fetchWithRetry(url, opts);
  const data = (await resp.json()) as T;

  // Store in cache
  cache.set(cacheKey, data);
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Error class ─────────────────────────────────────────────────

export class RegistryError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Search the MCP registry for packages matching a query.
 */
export async function search(
  query: string,
  filters?: RegistrySearchFilters,
  opts?: RegistryClientOptions,
): Promise<RegistrySearchResult> {
  const params = new URLSearchParams();
  params.set("q", query);
  if (filters?.tag) params.set("tag", filters.tag);
  if (filters?.verified !== undefined) params.set("verified", String(filters.verified));
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.page) params.set("page", String(filters.page));

  const path = `/api/packages?${params.toString()}`;
  const skipCache = opts?.skipCache ?? false;

  try {
    return await getJson<RegistrySearchResult>(path, { skipCache });
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    throw new RegistryError(`Search failed: ${(err as Error).message}`, 0);
  }
}

/**
 * Get a specific package by name from the registry.
 */
export async function getPackage(
  name: string,
  opts?: RegistryClientOptions,
): Promise<RegistryPackage | null> {
  const skipCache = opts?.skipCache ?? false;
  try {
    return await getJson<RegistryPackage>(`/api/packages/${encodeURIComponent(name)}`, {
      skipCache,
    });
  } catch (err) {
    if (err instanceof RegistryError && err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * Get all available versions for a package.
 */
export async function getVersions(name: string, opts?: RegistryClientOptions): Promise<string[]> {
  const skipCache = opts?.skipCache ?? false;
  try {
    return await getJson<string[]>(`/api/packages/${encodeURIComponent(name)}/versions`, {
      skipCache,
    });
  } catch (err) {
    if (err instanceof RegistryError && err.statusCode === 404) return [];
    throw err;
  }
}

/**
 * Resolve the latest version of a package.
 * Returns the full package with the latest version, or null if not found.
 */
export async function resolveLatest(
  name: string,
  opts?: RegistryClientOptions,
): Promise<RegistryPackage | null> {
  return getPackage(name, opts);
}
