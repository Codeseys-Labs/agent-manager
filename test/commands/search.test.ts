import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RegistrySearchResult } from "../../src/registry/types";

// We mock `fetch` at the global level instead of mocking the module.
// The registry client uses global fetch internally.

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

function mockFetchError(message: string) {
  globalThis.fetch = (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
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
    const result: RegistrySearchResult = {
      packages: [
        {
          name: "tavily-mcp",
          description: "Web search via Tavily",
          author: "tavily",
          version: "1.0.0",
          verified: true,
          tags: ["search"],
          downloads: 1000,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-06-01T00:00:00Z",
          server: { command: "bunx", args: ["tavily-mcp@latest"] },
        },
      ],
      total: 1,
      page: 1,
      per_page: 20,
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

    // Should have rendered the table with tavily-mcp
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("tavily-mcp");
  });

  test("formats output as table (non-json)", async () => {
    const result: RegistrySearchResult = {
      packages: [
        {
          name: "tavily-mcp",
          description: "Web search via Tavily",
          author: "tavily",
          version: "1.0.0",
          verified: true,
          tags: ["search"],
          downloads: 500,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-06-01T00:00:00Z",
          server: { command: "bunx", args: ["tavily-mcp@latest"] },
        },
      ],
      total: 1,
      page: 1,
      per_page: 20,
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
    expect(allOutput).toContain("1 of 1 result(s)");
  });

  test("returns JSON array with --json", async () => {
    const result: RegistrySearchResult = {
      packages: [
        {
          name: "fetch-mcp",
          description: "Fetch URLs",
          author: "test",
          version: "2.0.0",
          verified: false,
          tags: ["utility"],
          downloads: 100,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-06-01T00:00:00Z",
          server: { command: "uvx", args: ["mcp-server-fetch"] },
        },
      ],
      total: 1,
      page: 1,
      per_page: 20,
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
    expect(parsed.packages[0].name).toBe("fetch-mcp");
  });

  test("handles empty results", async () => {
    const result: RegistrySearchResult = {
      packages: [],
      total: 0,
      page: 1,
      per_page: 20,
    };
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

  test("passes tag filter via query params", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ packages: [], total: 0, page: 1, per_page: 20 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { searchCommand } = await import("../../src/commands/search");
    await searchCommand.run!({
      args: {
        query: "search",
        tag: "web",
        verified: true,
        limit: "5",
        json: false,
        quiet: false,
        verbose: false,
        "no-cache": true,
      } as any,
      rawArgs: [],
      cmd: searchCommand as any,
    });

    expect(capturedUrl).toContain("tag=web");
    expect(capturedUrl).toContain("verified=true");
    expect(capturedUrl).toContain("limit=5");
  });
});
