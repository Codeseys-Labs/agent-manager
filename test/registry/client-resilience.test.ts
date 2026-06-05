/**
 * R-TEST1 — registry client resilience (src/registry/client.ts).
 *
 * The existing test/registry/client.test.ts covers the happy 200 / 404 / 500 /
 * network-failure shapes. This file exercises the resilience machinery that was
 * previously untested:
 *
 *   - 429 → backoff → retry → 200 (rate-limit recovery; retry COUNT asserted).
 *   - cache-fallback: prime the cache, then make fetch fail on every attempt —
 *     the final attempt returns a synthetic `X-Cache: fallback` 200 from cache.
 *   - LRU eviction past CACHE_MAX_ENTRIES (oldest key evicted).
 *   - getVersions happy + 404 (→ []) + error.
 *   - resolveLatest happy + null.
 *
 * == Test seams used ==
 *  - `globalThis.fetch` — the only network seam (client.ts has no injection
 *    point). Snapshotted and restored in afterEach.
 *  - `globalThis.setTimeout` — the backoff `sleep()` uses the real timer with
 *    RETRY_DELAYS up to 4s. We stub setTimeout to fire its callback synchronously
 *    so retry/backoff paths run in milliseconds instead of seconds, while still
 *    counting the fetch attempts. Restored in afterEach.
 *
 * == Missing seam (flagged as backlog) ==
 *  TTL EXPIRY: LRUCache.get() compares `Date.now() > entry.expiresAt`, and
 *  `expiresAt` is stamped via `Date.now() + CACHE_TTL_MS` (5 min) at set()-time.
 *  There is NO injectable clock — the cache reads `Date.now()` inline and the
 *  module-level `cache` singleton is not exported for inspection. We exercise
 *  TTL expiry by snapshotting and overriding `globalThis.Date.now` (restored in
 *  afterEach), which is the least-invasive way to drive the clock without a real
 *  5-minute wait. A first-class clock seam on LRUCache (constructor-injected
 *  `now()`) would make this deterministic without monkey-patching a global — see
 *  the TTL test comment. The cache singleton is also process-global, so each
 *  test uses a UNIQUE base URL to keep cache keys from colliding across cases.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  RegistryError,
  getPackage,
  getVersions,
  resolveLatest,
  search,
} from "../../src/registry/client";
import type { RegistryPackage, RegistrySearchResult } from "../../src/registry/types";

const MOCK_PACKAGE: RegistryPackage = {
  name: "tavily-mcp",
  description: "Tavily web search MCP server",
  author: "tavily",
  version: "1.0.0",
  verified: true,
  tags: ["search", "web"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-06-01T00:00:00Z",
  server: { command: "bunx", args: ["tavily-mcp@latest"], transport: "stdio" },
};

const MOCK_SEARCH_RESULT: RegistrySearchResult = {
  packages: [MOCK_PACKAGE],
  total: 1,
  page: 1,
  per_page: 20,
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("registry/client resilience", () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalDateNow = Date.now;
  let urlCounter = 0;

  beforeEach(() => {
    // Unique base URL per test so the process-global cache singleton's keys
    // (which are the full URL) never collide between cases.
    urlCounter += 1;
    process.env.AM_REGISTRY_URL = `https://test-registry-${urlCounter}.example.com`;

    // Fire backoff sleeps synchronously: the client's sleep() wraps setTimeout,
    // so this collapses RETRY_DELAYS (1s/2s/4s) to near-zero while preserving
    // the retry control flow + fetch call count.
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    Date.now = originalDateNow;
    Reflect.deleteProperty(process.env, "AM_REGISTRY_URL");
  });

  // ── 429 backoff-and-retry ───────────────────────────────────────

  describe("429 rate-limit backoff", () => {
    test("retries on 429 then succeeds on the 3rd attempt", async () => {
      let attempt = 0;
      const fetchMock = mock(() => {
        attempt += 1;
        if (attempt < 3) {
          return Promise.resolve(new Response("rate limited", { status: 429 }));
        }
        return Promise.resolve(jsonResponse(MOCK_SEARCH_RESULT));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await search("q", undefined, { skipCache: true });
      expect(result.total).toBe(1);
      // 429, 429, 200 → exactly 3 fetches (2 backoff sleeps in between).
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    test("exhausts retries on persistent 429 → throws RegistryError(429)", async () => {
      const fetchMock = mock(() => Promise.resolve(new Response("rate limited", { status: 429 })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      let caught: unknown;
      try {
        await search("q", undefined, { skipCache: true });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RegistryError);
      expect((caught as RegistryError).statusCode).toBe(429);
      // MAX_RETRIES=3 → attempts 0..3 inclusive = 4 fetches before giving up.
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  // ── cache-fallback on network failure ───────────────────────────

  describe("cache fallback", () => {
    test("returns primed cache value with X-Cache: fallback when fetch fails", async () => {
      // 1) Prime: a successful fetch (skipCache OFF) stores the value.
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse(MOCK_PACKAGE)),
      ) as unknown as typeof fetch;
      const primed = await getPackage("tavily-mcp"); // cached under this base URL
      expect(primed?.name).toBe("tavily-mcp");

      // 2) Now every fetch rejects (offline). With cache present and skipCache
      //    OFF, fetchWithRetry returns a synthetic X-Cache: fallback 200 instead
      //    of throwing — the caller gets the primed value back.
      globalThis.fetch = mock(() =>
        Promise.reject(new Error("ECONNREFUSED")),
      ) as unknown as typeof fetch;

      const fallback = await getPackage("tavily-mcp");
      expect(fallback).not.toBeNull();
      expect(fallback?.name).toBe("tavily-mcp");
    });

    test("network failure with skipCache:true (no cache consulted) throws RegistryError(0)", async () => {
      globalThis.fetch = mock(() =>
        Promise.reject(new Error("ECONNREFUSED")),
      ) as unknown as typeof fetch;

      let caught: unknown;
      try {
        await getPackage("never-cached", { skipCache: true });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RegistryError);
      expect((caught as RegistryError).statusCode).toBe(0);
    });
  });

  // ── LRU eviction ────────────────────────────────────────────────

  describe("LRU eviction at CACHE_MAX_ENTRIES", () => {
    test("evicts the oldest entry once capacity (50) is exceeded", async () => {
      const CACHE_MAX_ENTRIES = 50;
      // Each getVersions(name) call caches under a distinct URL
      // (/api/packages/<name>/versions). Prime CACHE_MAX_ENTRIES distinct keys
      // with a live fetch, then add ONE more to force eviction of the oldest.
      const liveFetch = mock(() => Promise.resolve(jsonResponse(["1.0.0"])));
      globalThis.fetch = liveFetch as unknown as typeof fetch;

      // Prime entries pkg-0 .. pkg-49 (the first inserted, pkg-0, is the LRU head).
      for (let i = 0; i < CACHE_MAX_ENTRIES; i++) {
        await getVersions(`pkg-${i}`);
      }
      // One extra entry → set() evicts the oldest key (pkg-0).
      await getVersions(`pkg-${CACHE_MAX_ENTRIES}`);

      const fetchCountAfterPriming = liveFetch.mock.calls.length;

      // A cached read should NOT hit the network: re-request a still-cached key
      // (pkg-49, recently inserted) and confirm no new fetch.
      await getVersions("pkg-49");
      expect(liveFetch.mock.calls.length).toBe(fetchCountAfterPriming);

      // The evicted oldest key (pkg-0) must MISS the cache and hit the network
      // again — proving it was evicted, not merely shuffled.
      await getVersions("pkg-0");
      expect(liveFetch.mock.calls.length).toBe(fetchCountAfterPriming + 1);
    });
  });

  // ── TTL expiry (clock-stubbed; see missing-seam note at top) ─────

  describe("TTL expiry", () => {
    test("a cached entry past its TTL is re-fetched", async () => {
      // No injectable clock on LRUCache — drive `Date.now` directly. See the
      // file header's missing-seam note: a constructor-injected `now()` on
      // LRUCache would remove the need to monkey-patch a global here.
      let fakeNow = 1_000_000;
      Date.now = () => fakeNow;

      const liveFetch = mock(() => Promise.resolve(jsonResponse(["2.0.0"])));
      globalThis.fetch = liveFetch as unknown as typeof fetch;

      await getVersions("ttl-pkg"); // cached with expiresAt = fakeNow + 5min
      expect(liveFetch.mock.calls.length).toBe(1);

      // Still within TTL → served from cache, no new fetch.
      fakeNow += 60_000; // +1 min
      await getVersions("ttl-pkg");
      expect(liveFetch.mock.calls.length).toBe(1);

      // Advance past the 5-minute TTL → cache miss → re-fetch.
      fakeNow += 5 * 60 * 1000 + 1;
      await getVersions("ttl-pkg");
      expect(liveFetch.mock.calls.length).toBe(2);
    });
  });

  // ── getVersions ─────────────────────────────────────────────────

  describe("getVersions", () => {
    test("returns the version list on 200", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse(["1.0.0", "1.1.0", "2.0.0"])),
      ) as unknown as typeof fetch;
      const versions = await getVersions("multi-version-pkg", { skipCache: true });
      expect(versions).toEqual(["1.0.0", "1.1.0", "2.0.0"]);
    });

    test("returns [] on 404", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
      ) as unknown as typeof fetch;
      const versions = await getVersions("missing-pkg", { skipCache: true });
      expect(versions).toEqual([]);
    });

    test("propagates non-404 RegistryError on 500", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("boom", { status: 500, statusText: "Internal Server Error" })),
      ) as unknown as typeof fetch;
      await expect(getVersions("err-pkg", { skipCache: true })).rejects.toBeInstanceOf(
        RegistryError,
      );
    });
  });

  // ── resolveLatest ───────────────────────────────────────────────

  describe("resolveLatest", () => {
    test("resolves to the package on 200", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse(MOCK_PACKAGE)),
      ) as unknown as typeof fetch;
      const pkg = await resolveLatest("tavily-mcp", { skipCache: true });
      expect(pkg).not.toBeNull();
      expect(pkg?.version).toBe("1.0.0");
    });

    test("returns null when the package is missing (404)", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
      ) as unknown as typeof fetch;
      const pkg = await resolveLatest("nope", { skipCache: true });
      expect(pkg).toBeNull();
    });
  });
});
