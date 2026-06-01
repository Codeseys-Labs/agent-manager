/**
 * SEC-3: A2A SSRF guard + Agent Card validation.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { A2AClient } from "../../../src/protocols/a2a/client";
import {
  A2AUrlError,
  isPrivateHost,
  parseAgentCard,
  validateRemoteUrl,
} from "../../../src/protocols/a2a/url-guard";

describe("SEC-3: validateRemoteUrl scheme allowlist", () => {
  test("rejects non-http(s) schemes", () => {
    expect(() => validateRemoteUrl("file:///etc/passwd")).toThrow(A2AUrlError);
    expect(() => validateRemoteUrl("ftp://example.com/x")).toThrow(A2AUrlError);
    expect(() => validateRemoteUrl("gopher://example.com")).toThrow(A2AUrlError);
    expect(() => validateRemoteUrl("data:text/plain,hi")).toThrow(A2AUrlError);
  });

  test("rejects malformed URLs", () => {
    expect(() => validateRemoteUrl("not a url")).toThrow(A2AUrlError);
    expect(() => validateRemoteUrl("")).toThrow(A2AUrlError);
  });

  test("allows public https URLs", () => {
    const u = validateRemoteUrl("https://agent.example.com/a2a");
    expect(u.hostname).toBe("agent.example.com");
  });
});

describe("SEC-3: validateRemoteUrl private-host policy", () => {
  test("rejects loopback / private / link-local targets by default", () => {
    expect(() => validateRemoteUrl("http://localhost:8080")).toThrow(A2AUrlError);
    expect(() => validateRemoteUrl("http://127.0.0.1:8080")).toThrow(A2AUrlError);
    expect(() => validateRemoteUrl("http://10.0.0.5")).toThrow(A2AUrlError);
    expect(() => validateRemoteUrl("http://192.168.1.1")).toThrow(A2AUrlError);
    expect(() => validateRemoteUrl("http://172.16.0.1")).toThrow(A2AUrlError);
    expect(() => validateRemoteUrl("http://169.254.169.254/latest/meta-data")).toThrow(A2AUrlError);
    expect(() => validateRemoteUrl("http://[::1]:8080")).toThrow(A2AUrlError);
  });

  test("permits private targets when explicitly opted in", () => {
    const u = validateRemoteUrl("http://localhost:8080", { allowPrivateNetwork: true });
    expect(u.hostname).toBe("localhost");
    expect(() =>
      validateRemoteUrl("http://127.0.0.1:9000", { allowPrivateNetwork: true }),
    ).not.toThrow();
  });
});

describe("SEC-3: isPrivateHost classification", () => {
  test("classifies internal hosts", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("foo.localhost")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("0.0.0.0")).toBe(true);
    expect(isPrivateHost("10.1.2.3")).toBe(true);
    expect(isPrivateHost("172.20.0.1")).toBe(true);
    expect(isPrivateHost("192.168.0.10")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("fd00::1")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
  });

  test("closes the loopback bypasses caught in review", () => {
    // Trailing-dot FQDN loopback.
    expect(isPrivateHost("localhost.")).toBe(true);
    expect(isPrivateHost("127.0.0.1.")).toBe(true);
    // IPv6-mapped IPv4 loopback in hex + expanded spellings.
    expect(isPrivateHost("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    expect(isPrivateHost("0:0:0:0:0:ffff:7f00:1")).toBe(true);
    expect(isPrivateHost("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254 metadata
    // Public stays public.
    expect(isPrivateHost("::ffff:8.8.8.8")).toBe(false);
  });

  test("treats public hosts as non-private", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false); // just outside 172.16/12
    expect(isPrivateHost("11.0.0.1")).toBe(false);
  });
});

describe("SEC-3: parseAgentCard validation", () => {
  test("accepts a well-formed card", () => {
    const card = parseAgentCard({
      name: "agent",
      description: "desc",
      version: "1.0.0",
      url: "https://agent.example.com",
      capabilities: { streaming: true },
      skills: [{ id: "s1", name: "Skill", description: "d" }],
    });
    expect(card.name).toBe("agent");
  });

  test("rejects a card missing required fields", () => {
    expect(() => parseAgentCard({ name: "x" })).toThrow(A2AUrlError);
    expect(() => parseAgentCard(null)).toThrow(A2AUrlError);
    expect(() => parseAgentCard("not an object")).toThrow(A2AUrlError);
    expect(() =>
      parseAgentCard({
        name: "x",
        description: "d",
        version: "1",
        url: "u",
        capabilities: {},
        skills: [{ id: 1 }], // wrong type
      }),
    ).toThrow(A2AUrlError);
  });
});

describe("SEC-3: A2AClient enforces the guard before fetching", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("discoverAgent on a file:// URL never issues a request", async () => {
    const mockFetch = mock(() => Promise.resolve(new Response("{}")));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const client = new A2AClient();
    await expect(client.discoverAgent("file:///etc/passwd")).rejects.toThrow(A2AUrlError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("discoverAgent on a loopback URL is refused without opt-in", async () => {
    const mockFetch = mock(() => Promise.resolve(new Response("{}")));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const client = new A2AClient();
    await expect(client.discoverAgent("http://127.0.0.1:8080")).rejects.toThrow(A2AUrlError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("sendTask on an internal URL is refused before any RPC", async () => {
    const mockFetch = mock(() => Promise.resolve(new Response("{}")));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const client = new A2AClient();
    await expect(
      client.sendTask("http://169.254.169.254", {
        id: "t1",
        message: { role: "user", parts: [{ type: "text", text: "hi" }] },
      }),
    ).rejects.toThrow(A2AUrlError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("discoverAgent validates the returned card shape", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ name: "bad" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const client = new A2AClient();
    // Public URL passes the SSRF guard, but the malformed card is rejected by Zod.
    await expect(client.discoverAgent("https://agent.example.com")).rejects.toThrow();
  });

  test("allows a public agent and validates its card", async () => {
    const validCard = {
      name: "agent",
      description: "desc",
      version: "1.0.0",
      url: "https://agent.example.com",
      capabilities: { streaming: false },
      skills: [],
    };
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(validCard), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const client = new A2AClient();
    const card = await client.discoverAgent("https://agent.example.com");
    expect(card?.name).toBe("agent");
    expect(mockFetch).toHaveBeenCalled();
  });
});
