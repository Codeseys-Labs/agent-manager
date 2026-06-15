import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerListResponse, ServerResponse } from "../../src/registry/types";

// We mock `fetch` at the global level instead of mocking the module.
// The registry client uses global fetch internally, speaking the v0 wire shape.

let consoleOutput: string[] = [];
let consoleErrors: string[] = [];
const origLog = console.log;
const origError = console.error;
const origFetch = globalThis.fetch;

function mockFetchResponse(data: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

function serverEntry(
  name: string,
  description: string,
  version: string,
  pkg: ServerResponse["server"]["packages"],
): ServerResponse {
  return {
    server: { name, description, version, packages: pkg },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        publishedAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-06-01T00:00:00Z",
        isLatest: true,
      },
    },
  };
}

describe("am search", () => {
  beforeEach(() => {
    consoleOutput = [];
    consoleErrors = [];
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    process.exitCode = undefined;
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origError;
    globalThis.fetch = origFetch;
    process.exitCode = undefined;
  });

  test("parses positional query argument and calls search", async () => {
    const result: ServerListResponse = {
      servers: [
        serverEntry("io.github.tavily/tavily-mcp", "Web search via Tavily", "1.0.0", [
          {
            registryType: "npm",
            identifier: "tavily-mcp",
            version: "1.0.0",
            transport: { type: "stdio" },
          },
        ]),
      ],
      metadata: { count: 1 },
    };
    mockFetchResponse(result);

    const { searchCommand } = await import("../../src/commands/search");
    await searchCommand.run!({
      args: {
        query: "tavily",
        json: false,
        quiet: false,
        verbose: false,
        "no-cache": true, // skip cache to force our mock
      } as any,
      rawArgs: [],
      cmd: searchCommand as any,
    });

    // Should have rendered the table with the remapped server name.
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("tavily-mcp");
  });

  test("formats output as table (non-json)", async () => {
    const result: ServerListResponse = {
      servers: [
        serverEntry("io.github.tavily/tavily-mcp", "Web search via Tavily", "1.0.0", [
          {
            registryType: "npm",
            identifier: "tavily-mcp",
            version: "1.0.0",
            transport: { type: "stdio" },
          },
        ]),
      ],
      metadata: { count: 1 },
    };
    mockFetchResponse(result);

    const { searchCommand } = await import("../../src/commands/search");
    await searchCommand.run!({
      args: { query: "tavily", json: false, quiet: false, verbose: false, "no-cache": true } as any,
      rawArgs: [],
      cmd: searchCommand as any,
    });

    const allOutput = consoleOutput.join("\n");
    // Table header
    expect(allOutput).toContain("Name");
    expect(allOutput).toContain("Description");
    // Row data
    expect(allOutput).toContain("tavily-mcp");
    expect(allOutput).toContain("Web search via Tavily");
    expect(allOutput).toContain("1 result(s)");
  });

  test("returns JSON array with --json", async () => {
    const result: ServerListResponse = {
      servers: [
        serverEntry("io.github.test/fetch-mcp", "Fetch URLs", "2.0.0", [
          {
            registryType: "pypi",
            identifier: "mcp-server-fetch",
            version: "2.0.0",
            transport: { type: "stdio" },
          },
        ]),
      ],
      metadata: { count: 1 },
    };
    mockFetchResponse(result);

    const { searchCommand } = await import("../../src/commands/search");
    await searchCommand.run!({
      args: { query: "fetch", json: true, quiet: false, verbose: false, "no-cache": true } as any,
      rawArgs: [],
      cmd: searchCommand as any,
    });

    expect(consoleOutput.length).toBeGreaterThan(0);
    const parsed = JSON.parse(consoleOutput[0]);
    expect(parsed.packages).toBeArray();
    expect(parsed.packages[0].name).toBe("io.github.test/fetch-mcp");
    // Remapped server config: pypi → uvx.
    expect(parsed.packages[0].server.command).toBe("uvx");
  });

  test("handles empty results", async () => {
    const result: ServerListResponse = { servers: [], metadata: { count: 0 } };
    mockFetchResponse(result);

    const { searchCommand } = await import("../../src/commands/search");
    await searchCommand.run!({
      args: {
        query: "nonexistent",
        json: false,
        quiet: false,
        verbose: false,
        "no-cache": true,
      } as any,
      rawArgs: [],
      cmd: searchCommand as any,
    });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain('No packages found for "nonexistent"');
  });

  test("handles network error gracefully", async () => {
    // Return HTTP 500 to trigger RegistryError without retry delays
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as unknown as typeof fetch;

    const { searchCommand } = await import("../../src/commands/search");
    await searchCommand.run!({
      args: { query: "test", json: false, quiet: false, verbose: false, "no-cache": true } as any,
      rawArgs: [],
      cmd: searchCommand as any,
    });

    expect(process.exitCode).toBe(1);
    const allErrors = consoleErrors.join("\n");
    expect(allErrors).toContain("500");
  });

  test("builds the v0 query string (search + version + limit; no tag/verified)", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ servers: [], metadata: { count: 0 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { searchCommand } = await import("../../src/commands/search");
    await searchCommand.run!({
      args: {
        query: "search",
        limit: "5",
        json: false,
        quiet: false,
        verbose: false,
        "no-cache": true,
      } as any,
      rawArgs: [],
      cmd: searchCommand as any,
    });

    expect(capturedUrl).toContain("search=search");
    expect(capturedUrl).toContain("version=latest");
    expect(capturedUrl).toContain("limit=5");
    expect(capturedUrl).not.toContain("tag=");
    expect(capturedUrl).not.toContain("verified=");
  });
});
