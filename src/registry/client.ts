import type {
  Argument,
  Package,
  RegistryEnvVar,
  RegistryPackage,
  RegistrySearchFilters,
  RegistrySearchResult,
  RegistryServerConfig,
  Remote,
  ServerDetail,
  ServerListResponse,
  ServerResponse,
} from "./types";

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

/** Hosts for which a cleartext http:// registry is acceptable (local dev). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Resolve the registry base URL, enforcing TLS.
 *
 * AM_REGISTRY_URL is attacker-influenceable env (a poisoned shell profile, a
 * malicious CI step, a hijacked `.envrc`). A cleartext http:// (or any non-https)
 * base silently downgrades every registry fetch to a MITM-able channel, so we
 * FAIL CLOSED: only https:// is accepted, with two narrow exceptions —
 *   - a loopback host (localhost / 127.0.0.1 / ::1) over http, for local dev;
 *   - an explicit operator opt-in via AM_REGISTRY_ALLOW_HTTP=1, for trusted
 *     internal cleartext registries.
 * Non-http(s) schemes (ftp://, file://, …) are never allowed.
 *
 * Exported so tests can drive the policy directly without a network round-trip.
 */
export function getBaseUrl(): string {
  const raw = process.env.AM_REGISTRY_URL;
  if (raw === undefined || raw === "") return DEFAULT_BASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RegistryError(
      `Invalid AM_REGISTRY_URL "${raw}": not a valid URL. Expected an https:// registry URL.`,
      0,
    );
  }

  if (parsed.protocol === "https:") return raw;

  if (parsed.protocol === "http:") {
    // hostname strips the port and IPv6 brackets; check both forms.
    const host = parsed.hostname;
    const isLoopback = LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(`[${host}]`);
    if (isLoopback) return raw;
    if (process.env.AM_REGISTRY_ALLOW_HTTP === "1") return raw;
    throw new RegistryError(
      `Refusing to use cleartext AM_REGISTRY_URL "${raw}": http:// downgrades the registry connection to a MITM-able channel. Use an https:// URL, target a loopback host (localhost/127.0.0.1), or set AM_REGISTRY_ALLOW_HTTP=1 to opt in.`,
      0,
    );
  }

  throw new RegistryError(
    `Refusing to use AM_REGISTRY_URL "${raw}": scheme "${parsed.protocol}" is not allowed. Only https:// (or loopback http://) registry URLs are permitted.`,
    0,
  );
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

// ── Remap layer (v0 wire shape → internal RegistryPackage) ──────
//
// The live API speaks the MCP registry v0 schema (ServerResponse / ServerDetail
// / Package / Remote / KeyValueInput). The rest of `am` (install/update/search/
// mcp) depends on the internal RegistryPackage contract. These helpers are the
// single boundary that translates between the two — consumers are untouched.

const MAX_SEARCH_LIMIT = 100;

// registryType → launcher command. runtimeHint, when the publisher supplies it,
// overrides this (it is exactly "the command to run the package").
const REGISTRY_TYPE_COMMAND: Record<string, string> = {
  npm: "npx",
  pypi: "uvx",
  oci: "docker",
  nuget: "dnx",
};

/** Render one v0 Argument to a CLI token (named → `--flag value`-ish, positional → value). */
function argTokens(arg: Argument): string[] {
  const value = arg.value ?? arg.default ?? arg.valueHint;
  if (arg.type === "named" && arg.name) {
    return value !== undefined ? [arg.name, value] : [arg.name];
  }
  // Positional (or untyped): emit the value if we have one, else the hint.
  return value !== undefined ? [value] : [];
}

/** Derive a {command,args} pair from a v0 Package. */
function packageInvocation(pkg: Package): { command: string; args: string[] } {
  const command = pkg.runtimeHint ?? REGISTRY_TYPE_COMMAND[pkg.registryType] ?? pkg.identifier;
  const runtimeArgs = (pkg.runtimeArguments ?? []).flatMap(argTokens);
  const packageArgs = (pkg.packageArguments ?? []).flatMap(argTokens);

  // For npm-style launchers the identifier is the package spec (e.g. `npx
  // tavily-mcp@1.0.0`); pin the version when present. For oci/docker the
  // identifier already carries its tag, so don't re-append. When runtimeHint
  // supplied the command verbatim we still pass the identifier as the target.
  let target = pkg.identifier;
  if (pkg.version && (pkg.registryType === "npm" || pkg.registryType === "pypi")) {
    target = `${pkg.identifier}@${pkg.version}`;
  }

  return { command, args: [...runtimeArgs, target, ...packageArgs] };
}

/** Translate the v0 transport string to the internal transport union. */
function normalizeTransport(t: string | undefined): RegistryServerConfig["transport"] {
  if (t === "sse") return "sse";
  if (t === "streamable-http") return "streamable-http";
  return "stdio";
}

/** Map a v0 KeyValueInput env var to the internal RegistryEnvVar (isRequired→required). */
function mapEnvVar(kv: {
  name: string;
  description?: string;
  isRequired?: boolean;
  default?: string;
}): RegistryEnvVar {
  return {
    name: kv.name,
    description: kv.description ?? "",
    // CRITICAL: the live field is `isRequired`; the internal contract uses
    // `required`. Honor it so install.ts no longer treats every var as optional.
    required: kv.isRequired ?? false,
    ...(kv.default !== undefined ? { default: kv.default } : {}),
  };
}

/** Build the internal server config from a package (preferred) or a remote. */
function deriveServerConfig(detail: ServerDetail): RegistryServerConfig {
  const pkg = detail.packages?.[0];
  if (pkg) {
    const { command, args } = packageInvocation(pkg);
    const env = (pkg.environmentVariables ?? []).map(mapEnvVar);
    const transport = normalizeTransport(pkg.transport?.type);
    const config: RegistryServerConfig = {
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(env.length > 0 ? { env } : {}),
      transport,
    };
    // Local stdio packages never carry a url. Remote-typed packages may.
    if (transport !== "stdio" && pkg.transport?.url) {
      config.url = pkg.transport.url;
    }
    return config;
  }

  // Remote-only server: synthesize the command from the url (schema.ts:42-44 —
  // `am` stores the remote URL in `command` for remote transports). Pick the
  // streamable-http remote first, falling back to whatever is present.
  const remotes = detail.remotes ?? [];
  const remote: Remote | undefined =
    remotes.find((r) => r.type === "streamable-http") ?? remotes[0];
  if (remote) {
    return {
      command: remote.url,
      transport: normalizeTransport(remote.type),
      url: remote.url,
    };
  }

  // Neither packages nor remotes — degenerate. Keep command non-empty-ish so
  // downstream schema validation has something; default to stdio.
  return { command: detail.name, transport: "stdio" };
}

/** Derive a display author from a reverse-DNS server name (e.g. io.github.foo/bar → foo). */
function deriveAuthor(name: string): string {
  const slash = name.indexOf("/");
  const org = slash >= 0 ? name.slice(0, slash) : name;
  const parts = org.split(".").filter(Boolean);
  // Reverse-DNS: the org token is the last DNS label before the name segment
  // (io.github.<org>) — fall back to the whole org string when it isn't DNS-y.
  return parts.length > 0 ? parts[parts.length - 1] : org;
}

/** Remap one v0 ServerResponse to the internal RegistryPackage contract. */
export function mapServerResponse(raw: ServerResponse): RegistryPackage {
  const detail = raw.server;
  const meta = raw._meta?.["io.modelcontextprotocol.registry/official"];
  const publishedAt = meta?.publishedAt ?? "";
  const updatedAt = meta?.updatedAt ?? publishedAt;

  return {
    name: detail.name,
    description: detail.description,
    author: deriveAuthor(detail.name),
    version: detail.version,
    ...(detail.repository?.url ? { repository: detail.repository.url } : {}),
    ...(detail.websiteUrl ? { homepage: detail.websiteUrl } : {}),
    // The v0 API does not expose downloads/verification/tags/license — supply
    // sensible internal defaults the consumers already tolerate.
    downloads: undefined,
    verified: false,
    tags: [],
    created_at: publishedAt,
    updated_at: updatedAt,
    server: deriveServerConfig(detail),
  };
}

/** Remap a v0 ServerListResponse to the internal RegistrySearchResult. */
export function mapListResponse(raw: ServerListResponse): RegistrySearchResult {
  return {
    // Skip (don't throw on) a malformed entry missing `.server` — mapServerResponse
    // would read `detail.name` off undefined. Mirrors getPackage's null-on-missing
    // posture for the single-server route.
    packages: (raw.servers ?? [])
      .filter((s): s is ServerResponse => !!s?.server)
      .map(mapServerResponse),
    ...(raw.metadata?.nextCursor ? { nextCursor: raw.metadata.nextCursor } : {}),
  };
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
  params.set("search", query);
  // Always pin to the latest version of each server — `am` resolves a single
  // installable, not a version history.
  params.set("version", "latest");
  if (filters?.limit) {
    params.set("limit", String(Math.min(filters.limit, MAX_SEARCH_LIMIT)));
  }
  if (filters?.cursor) params.set("cursor", filters.cursor);

  const path = `/v0/servers?${params.toString()}`;
  const skipCache = opts?.skipCache ?? false;

  try {
    const raw = await getJson<ServerListResponse>(path, { skipCache });
    return mapListResponse(raw);
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    throw new RegistryError(`Search failed: ${(err as Error).message}`, 0);
  }
}

/**
 * Get a specific package by name from the registry.
 *
 * There is no bare `/v0/servers/{name}` route, so resolution is:
 *   - reverse-DNS name (contains "/"): GET /v0/servers/{name}/versions/latest
 *   - short name: GET /v0/servers?search=<name>&version=latest, pick best match
 * Returns null when no server matches.
 */
export async function getPackage(
  name: string,
  opts?: RegistryClientOptions,
): Promise<RegistryPackage | null> {
  const skipCache = opts?.skipCache ?? false;

  if (name.includes("/")) {
    try {
      const raw = await getJson<ServerResponse>(
        `/v0/servers/${encodeURIComponent(name)}/versions/latest`,
        { skipCache },
      );
      // A null/empty body is the "not found" shape for the latest-version route.
      if (!raw?.server) return null;
      return mapServerResponse(raw);
    } catch (err) {
      if (err instanceof RegistryError && err.statusCode === 404) return null;
      throw err;
    }
  }

  // Short name: search then match. version=latest collapses to one entry/server.
  let raw: ServerListResponse;
  try {
    const params = new URLSearchParams({ search: name, version: "latest" });
    raw = await getJson<ServerListResponse>(`/v0/servers?${params.toString()}`, { skipCache });
  } catch (err) {
    if (err instanceof RegistryError && err.statusCode === 404) return null;
    throw err;
  }

  const servers = raw?.servers ?? [];
  if (servers.length === 0) return null;

  // Prefer an exact name match, then a trailing-segment match (the part after
  // the reverse-DNS prefix), else the first result.
  const exact = servers.find((s) => s.server.name === name);
  const segment = servers.find((s) => {
    const n = s.server.name;
    const seg = n.includes("/") ? n.slice(n.indexOf("/") + 1) : n;
    return seg === name;
  });
  const match = exact ?? segment ?? servers[0];
  return mapServerResponse(match);
}

/**
 * Get all available versions for a package.
 */
export async function getVersions(name: string, opts?: RegistryClientOptions): Promise<string[]> {
  const skipCache = opts?.skipCache ?? false;
  try {
    const raw = await getJson<ServerListResponse>(
      `/v0/servers/${encodeURIComponent(name)}/versions`,
      { skipCache },
    );
    return (raw?.servers ?? []).map((s) => s.server.version);
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
