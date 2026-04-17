/**
 * MCP protocol conformance tests (Wave C, 2026-04-16).
 *
 * Covers the fixes landed in Wave C per
 * docs/reviews/2026-04-16-iter2-adapter-schemas-and-vision/05-protocol-conformance.md:
 *   a. JSON-RPC envelope validation (jsonrpc === "2.0")
 *   b. Request id validation (not null, must be string/number)
 *   c. Initialize-state gating (-32002 before init, ping allowed)
 *   d. protocolVersion negotiation (-32602 on mismatch, echo on match)
 *   e. Batch ID deduplication (-32600 on duplicate id in a batch)
 */

import { describe, expect, test } from "bun:test";
import {
  McpServer,
  PREFERRED_MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from "../../src/mcp/server";

// ── (a) jsonrpc envelope validation ─────────────────────────────

describe("MCP conformance: jsonrpc envelope validation", () => {
  test("rejects jsonrpc: '1.0' with -32600", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      // @ts-expect-error — intentionally invalid
      jsonrpc: "1.0",
      id: 1,
      method: "tools/list",
    });
    expect(resp).not.toBeNull();
    expect(resp?.error).toBeDefined();
    expect(resp?.error?.code).toBe(-32600);
    expect(resp?.error?.message.toLowerCase()).toContain("jsonrpc");
    expect(resp?.result).toBeUndefined();
  });

  test("rejects missing jsonrpc field with -32600", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    // Cast through unknown — intentionally sending an envelope that's
    // missing the `jsonrpc` field to exercise the validator.
    const resp = await server.handleRequest({
      id: 1,
      method: "tools/list",
    } as unknown as Parameters<typeof server.handleRequest>[0]);
    expect(resp).not.toBeNull();
    expect(resp?.error?.code).toBe(-32600);
  });

  test("rejects empty method with -32600", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "",
    });
    expect(resp?.error?.code).toBe(-32600);
  });
});

// ── (b) request id validation ──────────────────────────────────

describe("MCP conformance: request id validation", () => {
  test("rejects id: null on a request (non-notification) with -32600", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: null,
      method: "tools/list",
    });
    expect(resp).not.toBeNull();
    expect(resp?.error?.code).toBe(-32600);
    expect(resp?.error?.message.toLowerCase()).toContain("null");
    // Echoed id stays null per JSON-RPC envelope rules.
    expect(resp?.id).toBeNull();
  });

  test("rejects id: boolean with -32600", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      // @ts-expect-error — intentionally invalid
      id: true,
      method: "tools/list",
    });
    expect(resp?.error?.code).toBe(-32600);
  });

  test("accepts string id", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: "abc",
      method: "initialize",
      params: {},
    });
    expect(resp?.id).toBe("abc");
    expect(resp?.error).toBeUndefined();
    expect(resp?.result).toBeDefined();
  });

  test("accepts numeric id", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 42,
      method: "initialize",
      params: {},
    });
    expect(resp?.id).toBe(42);
  });

  test("notifications (no id) return null response for known notification", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    // notifications/initialized has no id — null response is correct.
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(resp).toBeNull();
  });
});

// ── (c) initialize-state gating ────────────────────────────────

describe("MCP conformance: initialize-state gating", () => {
  test("rejects tools/list before initialize with -32002", async () => {
    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      enforceInitGate: true,
    });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(resp?.error?.code).toBe(-32002);
    expect(resp?.error?.message.toLowerCase()).toContain("not initialized");
  });

  test("rejects tools/call before initialize with -32002", async () => {
    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      enforceInitGate: true,
    });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "am_list_servers", arguments: {} },
    });
    expect(resp?.error?.code).toBe(-32002);
  });

  test("allows initialize before initialize", async () => {
    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      enforceInitGate: true,
    });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(resp?.error).toBeUndefined();
    expect(resp?.result).toBeDefined();
  });

  test("allows ping before initialize", async () => {
    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      enforceInitGate: true,
    });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: {},
    });
    expect(resp?.error).toBeUndefined();
    expect(resp?.result).toBeDefined();
  });

  test("permits tools/list after initialize", async () => {
    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      enforceInitGate: true,
    });
    await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const resp = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(resp?.error).toBeUndefined();
    expect(resp?.result).toBeDefined();
  });

  test("failed negotiation does NOT mark session initialized", async () => {
    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      enforceInitGate: true,
    });
    // Bogus protocol version triggers -32602.
    const bad = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "9999-01-01" },
    });
    expect(bad?.error?.code).toBe(-32602);

    // Second call (tools/list) should still be gated.
    const resp = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(resp?.error?.code).toBe(-32002);
  });
});

// ── (d) protocolVersion negotiation ────────────────────────────

describe("MCP conformance: protocolVersion negotiation", () => {
  test("echoes requested version when supported", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    // Request a version we DO support.
    const supported = SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: supported },
    });
    expect(resp?.result).toBeDefined();
    expect((resp?.result as { protocolVersion: string }).protocolVersion).toBe(supported);
  });

  test("returns -32602 with supported list when version unsupported", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(resp?.error?.code).toBe(-32602);
    expect(resp?.error?.message).toContain("Unsupported protocol version");
    // Error data contains the supported list so clients can retry with a match.
    expect(resp?.error?.data).toBeDefined();
    const data = resp?.error?.data as { supported: string[]; requested: string };
    expect(Array.isArray(data.supported)).toBe(true);
    expect(data.supported).toEqual([...SUPPORTED_MCP_PROTOCOL_VERSIONS]);
    expect(data.requested).toBe("1999-01-01");
  });

  test("missing protocolVersion defaults to preferred version", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect((resp?.result as { protocolVersion: string }).protocolVersion).toBe(
      PREFERRED_MCP_PROTOCOL_VERSION,
    );
  });

  test("does not silently coerce a different requested version", async () => {
    // The old behavior always returned "2024-11-05" regardless of the
    // client's request. Per spec that is a silent coercion. Our fix
    // returns a negotiated match, or an error.
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    // 2025-11-25 is in our supported list, so it should be echoed.
    expect((resp?.result as { protocolVersion: string }).protocolVersion).toBe("2025-11-25");
  });
});

// ── (e) batch id dedup ─────────────────────────────────────────

describe("MCP conformance: batch id deduplication", () => {
  test("rejects duplicate id in batch with -32600 for the duplicate only", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const batch = [
      { jsonrpc: "2.0" as const, id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0" as const, id: 1, method: "ping", params: {} },
    ];
    const responses = await server.handleBatch(batch);
    expect(responses).toHaveLength(2);
    // First one succeeded.
    expect(responses[0]?.error).toBeUndefined();
    expect(responses[0]?.id).toBe(1);
    // Second one rejected for duplicate id.
    expect(responses[1]?.error?.code).toBe(-32600);
    expect(responses[1]?.error?.message.toLowerCase()).toContain("duplicate");
    expect(responses[1]?.id).toBe(1);
  });

  test("permits multiple notifications (no id) in a batch", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const batch = [
      // Two unknown notifications — no id, no response expected, no dedup.
      { jsonrpc: "2.0" as const, method: "notifications/initialized" },
      { jsonrpc: "2.0" as const, method: "notifications/initialized" },
    ];
    const responses = await server.handleBatch(batch);
    // Both are null (notifications don't produce responses).
    expect(responses).toEqual([null, null]);
  });

  test("permits distinct ids in a batch", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const batch = [
      { jsonrpc: "2.0" as const, id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0" as const, id: 2, method: "ping", params: {} },
      { jsonrpc: "2.0" as const, id: "three", method: "ping", params: {} },
    ];
    const responses = await server.handleBatch(batch);
    expect(responses).toHaveLength(3);
    for (const r of responses) expect(r?.error).toBeUndefined();
    expect(responses.map((r) => r?.id)).toEqual([1, 2, "three"]);
  });
});
