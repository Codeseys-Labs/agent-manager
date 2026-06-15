import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { RegistryError, getPackage, search } from "../../src/registry/client";
import type { ServerListResponse, ServerResponse } from "../../src/registry/types";

// ── Fixtures (real /v0/servers wire shape) ──────────────────────

// A stdio npm server with a SECRET, REQUIRED env var — the exact shape that
// exercises the isRequired→required rename (previously every var was optional).
const TAVILY_SERVER: ServerResponse = {
  server: {
    name: "io.github.tavily/tavily-mcp",
    description: "Tavily web search MCP server",
    version: "1.0.0",
    repository: { url: "https://github.com/tavily/tavily-mcp", source: "github" },
    packages: [
      {
        registryType: "npm",
        identifier: "tavily-mcp",
        version: "1.0.0",
        transport: { type: "stdio" },
        environmentVariables: [
          {
            name: "TAVILY_API_KEY",
            description: "Tavily API key",
            isRequired: true,
            isSecret: true,
          },
        ],
      },
    ],
  },
  _meta: {
    "io.modelcontextprotocol.registry/official": {
      status: "active",
      publishedAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-06-01T00:00:00Z",
      isLatest: true,
    },
  },
};

const SEARCH_RESPONSE: ServerListResponse = {
  servers: [TAVILY_SERVER],
  metadata: { count: 1 },
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
        new Response(JSON.stringify(SEARCH_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(process.env, "AM_REGISTRY_URL");
  });

  // ── search ──────────────────────────────────────────────────

  describe("search", () => {
    test("remaps v0 servers[] to internal RegistryPackage[]", async () => {
      const result = await search("tavily", undefined, { skipCache: true });
      expect(result.packages).toHaveLength(1);
      const pkg = result.packages[0];
      expect(pkg.name).toBe("io.github.tavily/tavily-mcp");
      expect(pkg.version).toBe("1.0.0");
      // Author derived from reverse-DNS org.
      expect(pkg.author).toBe("tavily");
      // Defaults for fields the v0 API does not expose.
      expect(pkg.verified).toBe(false);
      expect(pkg.tags).toEqual([]);
      // npm → npx, identifier pinned to version.
      expect(pkg.server.command).toBe("npx");
      expect(pkg.server.args).toEqual(["tavily-mcp@1.0.0"]);
      expect(pkg.server.transport).toBe("stdio");
      // isRequired → required (the critical rename).
      expect(pkg.server.env).toEqual([
        { name: "TAVILY_API_KEY", description: "Tavily API key", required: true },
      ]);
      expect(mockFetch).toHaveBeenCalled();
    });

    test("builds the /v0/servers query string (search + version + limit + cursor)", async () => {
      await search("tavily", { limit: 5, cursor: "opaque-cursor" }, { skipCache: true });

      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain("/v0/servers?");
      expect(calledUrl).toContain("search=tavily");
      expect(calledUrl).toContain("version=latest");
      expect(calledUrl).toContain("limit=5");
      expect(calledUrl).toContain("cursor=opaque-cursor");
      // Dropped server-side-nonexistent params.
      expect(calledUrl).not.toContain("tag=");
      expect(calledUrl).not.toContain("verified=");
      expect(calledUrl).not.toContain("q=");
    });

    test("clamps limit to the server-side max of 100", async () => {
      await search("tavily", { limit: 5000 }, { skipCache: true });
      const calledUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain("limit=100");
    });

    test("skips a malformed list entry lacking .server instead of throwing", async () => {
      // A list entry with no `.server` is malformed; mapServerResponse would
      // read `detail.name` off undefined and throw a raw TypeError. The guard
      // filters it out so the call resolves with only the well-formed entries.
      const malformedEntry = {
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            publishedAt: "2024-01-01T00:00:00Z",
            isLatest: true,
          },
        },
      } as unknown as ServerResponse;
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ servers: [TAVILY_SERVER, malformedEntry], metadata: { count: 2 } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ) as unknown as typeof fetch;

      const result = await search("tavily", undefined, { skipCache: true });
      // Malformed entry skipped, not thrown — only the well-formed one survives.
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0].name).toBe("io.github.tavily/tavily-mcp");
    });

    test("surfaces nextCursor from the list metadata", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ servers: [TAVILY_SERVER], metadata: { nextCursor: "next-page" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ) as unknown as typeof fetch;

      const result = await search("tavily", undefined, { skipCache: true });
      expect(result.nextCursor).toBe("next-page");
    });
  });

  // ── remote-only server remap ────────────────────────────────

  describe("remote-only server remap", () => {
    test("synthesizes command/url/transport from remotes[] when no packages", async () => {
      const remoteServer: ServerResponse = {
        server: {
          name: "io.modelcontextprotocol.anonymous/mcp-fs",
          description: "Cloud-hosted MCP filesystem server",
          version: "2.0.0",
          remotes: [{ type: "streamable-http", url: "https://mcp-fs.example.io/http" }],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            publishedAt: "2024-02-01T00:00:00Z",
            isLatest: true,
          },
        },
      };
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ servers: [remoteServer], metadata: { count: 1 } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ) as unknown as typeof fetch;

      const result = await search("fs", undefined, { skipCache: true });
      const pkg = result.packages[0];
      // Remote-only: command synthesized from the url (am stores the url in command).
      expect(pkg.server.command).toBe("https://mcp-fs.example.io/http");
      expect(pkg.server.transport).toBe("streamable-http");
      expect(pkg.server.url).toBe("https://mcp-fs.example.io/http");
      // No packages → no args, no env.
      expect(pkg.server.args).toBeUndefined();
      expect(pkg.server.env).toBeUndefined();
    });
  });

  // ── getPackage ──────────────────────────────────────────────

  describe("getPackage", () => {
    test("reverse-DNS name hits /versions/latest and remaps", async () => {
      let calledUrl = "";
      globalThis.fetch = mock((input: string | URL | Request) => {
        calledUrl = typeof input === "string" ? input : input.toString();
        return Promise.resolve(
          new Response(JSON.stringify(TAVILY_SERVER), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }) as unknown as typeof fetch;

      const pkg = await getPackage("io.github.tavily/tavily-mcp", { skipCache: true });
      expect(calledUrl).toContain("/v0/servers/io.github.tavily%2Ftavily-mcp/versions/latest");
      expect(pkg).not.toBeNull();
      expect(pkg!.name).toBe("io.github.tavily/tavily-mcp");
      expect(pkg!.server.command).toBe("npx");
    });

    test("short name resolves via search-then-match", async () => {
      let calledUrl = "";
      globalThis.fetch = mock((input: string | URL | Request) => {
        calledUrl = typeof input === "string" ? input : input.toString();
        return Promise.resolve(
          new Response(JSON.stringify(SEARCH_RESPONSE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }) as unknown as typeof fetch;

      const pkg = await getPackage("tavily-mcp", { skipCache: true });
      // Short name → search route, not a /versions/latest route.
      expect(calledUrl).toContain("/v0/servers?");
      expect(calledUrl).toContain("search=tavily-mcp");
      expect(pkg).not.toBeNull();
      // Trailing-segment match against the reverse-DNS name.
      expect(pkg!.name).toBe("io.github.tavily/tavily-mcp");
    });

    test("returns null when a short name has no match (empty servers[])", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ servers: [], metadata: { count: 0 } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ) as unknown as typeof fetch;

      const pkg = await getPackage("nonexistent-package", { skipCache: true });
      expect(pkg).toBeNull();
    });

    test("returns null for 404 on a reverse-DNS name", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
      ) as unknown as typeof fetch;

      const pkg = await getPackage("io.github.ghost/nope", { skipCache: true });
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
