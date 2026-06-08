/**
 * Deterministic LRUCache TTL tests via the injected clock seam (seed 06d8).
 *
 * Before the seam, TTL expiry was only reachable by monkeypatching
 * `globalThis.Date.now` (see client-resilience.test.ts) — a global mutation that
 * leaks across tests if a restore is missed. The constructor-injected `now`
 * lets us drive time with a local `let clock`, no globals, no real waits.
 */
import { describe, expect, test } from "bun:test";
import { LRUCache } from "../../src/registry/client";

describe("LRUCache TTL (injected clock)", () => {
  test("entry is valid up to AND AT expiresAt, gone strictly after (boundary)", () => {
    let clock = 1_000_000;
    const ttl = 5 * 60 * 1000;
    const cache = new LRUCache<string>(10, ttl, () => clock);

    cache.set("k", "v"); // expiresAt = 1_000_000 + ttl
    expect(cache.get("k")).toBe("v"); // fresh

    clock += ttl; // t === expiresAt; guard is strict `>` so STILL valid
    expect(cache.get("k")).toBe("v");

    clock += 1; // strictly past TTL → expired + evicted
    expect(cache.get("k")).toBeUndefined();
    // confirm it was deleted, not just hidden: re-get stays undefined
    expect(cache.get("k")).toBeUndefined();
  });

  test("independent entries expire on their own timelines", () => {
    let clock = 0;
    const ttl = 1000;
    const cache = new LRUCache<number>(10, ttl, () => clock);
    cache.set("a", 1);
    clock = 600;
    cache.set("b", 2); // a expires at 1000, b at 1600
    clock = 1001; // a expired, b still valid
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    clock = 1601;
    expect(cache.get("b")).toBeUndefined();
  });

  test("LRU eviction is independent of the clock (capacity bound)", () => {
    const clock = 0;
    const cache = new LRUCache<number>(2, 10_000, () => clock);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts "a" (oldest), capacity 2 — all still within TTL
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  test("a get() refreshes recency but NOT the TTL (expiry is set-relative)", () => {
    let clock = 0;
    const ttl = 1000;
    const cache = new LRUCache<string>(10, ttl, () => clock);
    cache.set("k", "v"); // expiresAt = 1000
    clock = 500;
    expect(cache.get("k")).toBe("v"); // accessed, but TTL is unchanged
    clock = 1001;
    expect(cache.get("k")).toBeUndefined(); // still expires at 1000, get didn't extend it
  });

  test("defaults to the system clock when no clock is injected", () => {
    const cache = new LRUCache<string>(10, 60_000); // no clock arg
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v"); // fresh against the real clock
  });
});
