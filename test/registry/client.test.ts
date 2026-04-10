import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { RegistryError, getPackage, search } from "../../src/registry/client";
import type { RegistryPackage, RegistrySearchResult } from "../../src/registry/types";

// ── Helpers ─────────────────────────────────────────────────────

const MOCK_PACKAGE: RegistryPackage = {
  name: "tavily-mcp",
  description: "Tavily web search MCP server",
  author: "tavily",
  version: "1.0.0",
  verified: true,
  tags: ["search", "web"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-06-01T00:00:00Z",
  server: {
    command: "bunx",
    args: ["tavily-mcp@latest"],
    transport: "stdio",
  },
};

const MOCK_SEARCH_RESULT: RegistrySearchResult = {
  packages: [MOCK_PACKAGE],
  total: 1,
  page: 1,
  per_page: 20,
};

// ── Tests ───────────────────────────────────────────────────────

describe("registry/client", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    // Set the registry URL to a test URL so we don't hit real endpoints
    process.env.AM_REGISTRY_URL = "https://test-registry.example.com";
    mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(MOCK_SEARCH_RESULT), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.AM_REGISTRY_URL = undefined;
  });

  // ── search ──────────────────────────────────────────────────

  describe("search", () => {
    test("returns typed results", async () => {
      const result = await search("tavily", undefined, { skipCache: true });
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0].name).toBe("tavily-mcp");
      expect(result.total).toBe(1);
      expect(mockFetch).toHaveBeenCalled();
    });

    test("passes query parameters correctly", async () => {
      await search("tavily", { tag: "search", verified: true, limit: 5 }, { skipCache: true });

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain("q=tavily");
      expect(calledUrl).toContain("tag=search");
      expect(calledUrl).toContain("verified=true");
      expect(calledUrl).toContain("limit=5");
    });
  });

  // ── getPackage ──────────────────────────────────────────────

  describe("getPackage", () => {
    test("returns package for valid name", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify(MOCK_PACKAGE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ) as unknown as typeof fetch;

      const pkg = await getPackage("tavily-mcp", { skipCache: true });
      expect(pkg).not.toBeNull();
      expect(pkg!.name).toBe("tavily-mcp");
      expect(pkg!.verified).toBe(true);
    });

    test("returns null for 404", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
      ) as unknown as typeof fetch;

      const pkg = await getPackage("nonexistent-package", { skipCache: true });
      expect(pkg).toBeNull();
    });
  });

  // ── Error handling ──────────────────────────────────────────

  describe("error handling", () => {
    test("throws RegistryError on non-404 HTTP error", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          }),
        ),
      ) as unknown as typeof fetch;

      await expect(search("test", undefined, { skipCache: true })).rejects.toThrow(RegistryError);
    });

    test("RegistryError has correct statusCode", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          }),
        ),
      ) as unknown as typeof fetch;

      try {
        await search("test", undefined, { skipCache: true });
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(RegistryError);
        expect((err as RegistryError).statusCode).toBe(500);
      }
    });

    test("throws RegistryError on network failure after retries", async () => {
      globalThis.fetch = mock(() =>
        Promise.reject(new Error("Network error")),
      ) as unknown as typeof fetch;

      await expect(search("test", undefined, { skipCache: true })).rejects.toThrow(RegistryError);
    }, 30_000); // Allow time for retries
  });
});
