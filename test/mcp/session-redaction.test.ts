/**
 * W-m2-session-redact (security): am_session_export and am_session_search must
 * NOT disclose raw, unredacted session transcripts to a tokenless MCP client.
 *
 * Background:
 *   - Read-only tools bypass the write-tier auth gate. The two session-content
 *     tools (am_session_export / am_session_search) were tier:"read-only" and
 *     returned VERBATIM message content (formatMarkdown / formatJson emit raw
 *     `m.content`; search returns 200-char raw snippets). So any tokenless
 *     client could pull a transcript wholesale even with AM_MCP_TOKEN set.
 *
 * Fix (two layers):
 *   1. Token-gate: add am_session_export + am_session_search to
 *      SENSITIVE_READONLY_TOOLS so they are refused tokenless when AM_MCP_TOKEN
 *      is configured — exactly like am_config_show.
 *   2. Defense-in-depth: pipe their handler output through redactSecretish so
 *      even an authorized (or tokenless-local) export is secret-redacted.
 *
 * am_session_list returns only id/count/timestamp summaries (no content) and
 * stays UNGATED — we assert it still works tokenless.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Session, SessionSummary } from "../../src/core/session";
import { McpServer, checkSensitiveReadAuth } from "../../src/mcp/server";

type JsonRpcResult = Record<string, any>;

// A known secret planted in a transcript. The redactSecretish backstop must
// strip it from any export/search output. Use a real-shaped Anthropic key so a
// SECRET_PATTERNS rule fires (sk-ant-… → [REDACTED_ANTHROPIC_KEY]).
const PLANTED_SECRET = "sk-ant-PLAINTEXTplaintextplaintext0123456789";

const FAKE_ADAPTER_NAME = "claude-code";

function makeSession(): Session {
  return {
    id: "sess-1",
    adapter: FAKE_ADAPTER_NAME,
    project: "/tmp/proj",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    endedAt: new Date("2026-01-01T01:00:00Z"),
    messages: [
      {
        role: "user",
        content: `here is my api key ${PLANTED_SECRET} please use it`,
        timestamp: new Date("2026-01-01T00:00:01Z"),
      },
      {
        role: "assistant",
        content: "ok, noted.",
        timestamp: new Date("2026-01-01T00:00:02Z"),
      },
    ],
  };
}

function makeStubReader() {
  const session = makeSession();
  const summary: SessionSummary = {
    id: session.id,
    adapter: FAKE_ADAPTER_NAME,
    project: session.project,
    messageCount: session.messages.length,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  };
  return {
    hasSessionStorage: () => true,
    listSessions: async () => [summary],
    loadSession: async (id: string) => (id === session.id ? session : null),
  };
}

// Snapshot the genuine registry module up front. Bun's `mock.restore()` does
// NOT undo `mock.module()`, so we explicitly re-install the real exports after
// each test or the stub leaks into every later-loaded test file in the run.
let REAL_REGISTRY: Record<string, unknown> | undefined;

beforeAll(async () => {
  REAL_REGISTRY = { ...(await import("../../src/adapters/registry")) };
});

describe("W-m2-session-redact — session-content tools are token-gated", () => {
  beforeEach(async () => {
    const realRegistry = await import("../../src/adapters/registry");
    const reader = makeStubReader();
    const stubAdapter = {
      meta: { name: FAKE_ADAPTER_NAME, displayName: FAKE_ADAPTER_NAME, version: "0.0.0" },
      detect: () => ({ installed: true, paths: {} }),
      sessionReader: reader,
    };
    mock.module("../../src/adapters/registry", () => ({
      ...realRegistry,
      listAdapters: () => [FAKE_ADAPTER_NAME],
      getAdapter: async (name: string) => (name === FAKE_ADAPTER_NAME ? stubAdapter : undefined),
    }));
  });

  afterEach(() => {
    mock.restore();
    if (REAL_REGISTRY) mock.module("../../src/adapters/registry", () => REAL_REGISTRY);
  });

  // ── (a) token-gating: tokenless refused when AM_MCP_TOKEN set ──────────

  test("tokenless am_session_export is REFUSED when AM_MCP_TOKEN is configured", async () => {
    const server = new McpServer({ auth: { token: "operator-secret", allowUnsafeLocal: false } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "am_session_export",
        arguments: { id: "sess-1", adapter: FAKE_ADAPTER_NAME },
      },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toMatch(/Authentication required|gated/i);
    // And crucially: the transcript (and its secret) never reached the client.
    expect(result.content[0].text).not.toContain(PLANTED_SECRET);
    expect(result.content[0].text).not.toContain("here is my api key");
  });

  test("tokenless am_session_search is REFUSED when AM_MCP_TOKEN is configured", async () => {
    const server = new McpServer({ auth: { token: "operator-secret", allowUnsafeLocal: false } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "am_session_search", arguments: { query: "api key" } },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBe(true);
    const content = JSON.parse(result.content[0].text);
    expect(content.error).toMatch(/Authentication required|gated/i);
    expect(result.content[0].text).not.toContain(PLANTED_SECRET);
  });

  // ── (b) defense-in-depth: authorized export is still redacted ──────────

  test("authorized am_session_export redacts a planted secret in the transcript", async () => {
    const server = new McpServer({ auth: { token: "operator-secret", allowUnsafeLocal: false } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        _meta: { authorization: "Bearer operator-secret" },
        name: "am_session_export",
        arguments: { id: "sess-1", adapter: FAKE_ADAPTER_NAME },
      },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const raw = result.content[0].text as string;
    // The secret is gone; the redaction marker is present.
    expect(raw).not.toContain(PLANTED_SECRET);
    expect(raw).toContain("[REDACTED_ANTHROPIC_KEY]");
    // Non-secret content survives so the export is still useful.
    expect(raw).toContain("ok, noted.");
  });

  test("authorized am_session_search redacts a planted secret in snippets", async () => {
    const server = new McpServer({ auth: { token: "operator-secret", allowUnsafeLocal: false } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        _meta: { authorization: "Bearer operator-secret" },
        name: "am_session_search",
        arguments: { query: "api key" },
      },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const raw = result.content[0].text as string;
    expect(raw).not.toContain(PLANTED_SECRET);
    expect(raw).toContain("[REDACTED_ANTHROPIC_KEY]");
  });

  // Tokenless-local (no token configured) export is allowed but STILL redacted.
  test("tokenless-local am_session_export (no token configured) redacts the secret", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "am_session_export",
        arguments: { id: "sess-1", adapter: FAKE_ADAPTER_NAME },
      },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const raw = result.content[0].text as string;
    expect(raw).not.toContain(PLANTED_SECRET);
    expect(raw).toContain("[REDACTED_ANTHROPIC_KEY]");
  });

  test("am_session_export JSON format is also redacted", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "am_session_export",
        arguments: { id: "sess-1", adapter: FAKE_ADAPTER_NAME, format: "json" },
      },
    });
    const result = resp?.result as JsonRpcResult;
    expect(result.isError).toBeUndefined();
    const raw = result.content[0].text as string;
    expect(raw).not.toContain(PLANTED_SECRET);
    expect(raw).toContain("[REDACTED_ANTHROPIC_KEY]");
  });

  // ── am_session_list stays UNGATED (summaries only, no content) ─────────

  test("am_session_list works tokenless even when AM_MCP_TOKEN is configured", async () => {
    const server = new McpServer({ auth: { token: "operator-secret", allowUnsafeLocal: false } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "am_session_list", arguments: {} },
    });
    const result = resp?.result as JsonRpcResult;
    // No auth error — list is summaries-only and intentionally ungated.
    expect(result.isError).toBeUndefined();
    const content = JSON.parse(result.content[0].text);
    expect(Array.isArray(content.sessions)).toBe(true);
    // No transcript content leaks through the list summaries.
    expect(result.content[0].text).not.toContain(PLANTED_SECRET);
  });
});

// ── Unit: checkSensitiveReadAuth covers the two session-content tools ────

describe("W-m2-session-redact — checkSensitiveReadAuth membership", () => {
  test("am_session_export refused tokenless when token configured", () => {
    const r = checkSensitiveReadAuth(
      "am_session_export",
      { token: "secret", allowUnsafeLocal: false },
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/Authentication required|gated/i);
  });

  test("am_session_search refused tokenless when token configured", () => {
    const r = checkSensitiveReadAuth(
      "am_session_search",
      { token: "secret", allowUnsafeLocal: false },
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
    );
    expect(r.allowed).toBe(false);
  });

  test("am_session_list is NOT a sensitive tool (always allowed)", () => {
    const r = checkSensitiveReadAuth(
      "am_session_list",
      { token: "secret", allowUnsafeLocal: false },
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
    );
    expect(r.allowed).toBe(true);
  });

  test("am_session_export/search allowed tokenless when NO token configured", () => {
    for (const name of ["am_session_export", "am_session_search"]) {
      const r = checkSensitiveReadAuth(
        name,
        { token: undefined, allowUnsafeLocal: false },
        { jsonrpc: "2.0", id: 1, method: "tools/call" },
      );
      expect(r.allowed).toBe(true);
    }
  });

  test("am_session_export/search allowed with a matching bearer token", () => {
    for (const name of ["am_session_export", "am_session_search"]) {
      const r = checkSensitiveReadAuth(
        name,
        { token: "secret", allowUnsafeLocal: false },
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { _meta: { authorization: "Bearer secret" } },
        },
      );
      expect(r.allowed).toBe(true);
    }
  });
});
