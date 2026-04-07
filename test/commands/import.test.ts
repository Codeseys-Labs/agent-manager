import { describe, test, expect } from "bun:test";
import { extractServerIdentity } from "../../src/commands/import";

describe("extractServerIdentity", () => {
  test("strips npx -y prefix and @version suffix", () => {
    expect(extractServerIdentity("npx", ["-y", "tavily-mcp@latest"])).toBe("tavily-mcp");
  });

  test("strips bunx prefix and @version suffix", () => {
    expect(extractServerIdentity("bunx", ["tavily-mcp@latest"])).toBe("tavily-mcp");
  });

  test("strips uvx prefix", () => {
    expect(extractServerIdentity("uvx", ["mcp-server-fetch"])).toBe("mcp-server-fetch");
  });

  test("extracts hostname from proxy endpoint", () => {
    expect(
      extractServerIdentity("uvx", ["mcp-proxy", "--endpoint", "https://mcp.exa.ai/sse"]),
    ).toBe("mcp.exa.ai");
  });

  test("strips absolute path to basename", () => {
    expect(extractServerIdentity("/usr/local/bin/aws-outlook-mcp")).toBe("aws-outlook-mcp");
  });

  test("returns plain command as-is", () => {
    expect(extractServerIdentity("aws-outlook-mcp")).toBe("aws-outlook-mcp");
  });

  test("handles pipx run prefix", () => {
    expect(extractServerIdentity("pipx", ["run", "some-tool@1.2.3"])).toBe("some-tool");
  });

  test("handles scoped package with @version", () => {
    // "@upstash/context7-mcp@latest" — the last @ is the version separator
    expect(extractServerIdentity("bunx", ["@upstash/context7-mcp@latest"])).toBe("@upstash/context7-mcp");
  });

  test("deduplicates identical servers", () => {
    const servers = [
      { name: "tavily", command: "bunx", args: ["tavily-mcp@latest"] },
      { name: "tavily-2", command: "npx", args: ["-y", "tavily-mcp@0.2.0"] },
    ];

    const identities = new Map<string, string>();
    let dupes = 0;

    for (const srv of servers) {
      const identity = extractServerIdentity(srv.command, srv.args);
      if (identities.has(identity)) {
        dupes++;
      } else {
        identities.set(identity, srv.name);
      }
    }

    expect(dupes).toBe(1);
    expect(identities.get("tavily-mcp")).toBe("tavily");
  });
});
