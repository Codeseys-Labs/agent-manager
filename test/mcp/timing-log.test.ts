/**
 * AM_MCP_TIMING=1 emits a grep-friendly timing line to stderr per
 * tools/call dispatch. Off by default (no spam). Shipped 2026-05-02
 * from the all-pillars review P2 §5.2 observability finding.
 *
 * The format is locked for downstream tooling:
 *   `[am-mcp-timing] <tool> ms=<N> ok=<true|false>\n`
 *
 * Test strategy: we can't easily intercept process.stderr.write inside
 * the McpServer unless we swap it. Bun provides `Bun.stderr` but the
 * production code uses Node's `process.stderr.write`. We patch that
 * function for the duration of each test, restore it, and inspect the
 * captured strings.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "../../src/mcp/server";

function installStderrCapture(): { capture: string[]; restore: () => void } {
  const capture: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // The real signature has several overloads; we only need the string path.
  process.stderr.write = ((chunk: unknown) => {
    if (typeof chunk === "string") capture.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    capture,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

describe("AM_MCP_TIMING=1 tool-call timing log", () => {
  const originalFlag = process.env.AM_MCP_TIMING;
  let cap: ReturnType<typeof installStderrCapture> | undefined;

  afterEach(() => {
    if (originalFlag === undefined) process.env.AM_MCP_TIMING = undefined;
    else process.env.AM_MCP_TIMING = originalFlag;
    cap?.restore();
    cap = undefined;
  });

  test("emits timing line when AM_MCP_TIMING=1", async () => {
    process.env.AM_MCP_TIMING = "1";
    cap = installStderrCapture();

    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      enforceInitGate: false,
    });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "am_list_profiles", arguments: {} },
    });

    expect(resp).not.toBeNull();
    const timingLines = cap.capture.filter((s) => s.startsWith("[am-mcp-timing]"));
    expect(timingLines).toHaveLength(1);
    // Format: `[am-mcp-timing] <tool> ms=<N> ok=<true|false>\n`
    expect(timingLines[0]).toMatch(
      /^\[am-mcp-timing\] am_list_profiles ms=[0-9]+(\.[0-9]+)? ok=(true|false)\n$/,
    );
  });

  test("does NOT emit when AM_MCP_TIMING is unset", async () => {
    process.env.AM_MCP_TIMING = undefined;
    cap = installStderrCapture();

    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      enforceInitGate: false,
    });
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "am_list_profiles", arguments: {} },
    });

    const timingLines = cap.capture.filter((s) => s.startsWith("[am-mcp-timing]"));
    expect(timingLines).toHaveLength(0);
  });

  test("emits ok=false when the tool throws", async () => {
    // am_acp_session_cancel with an invalid sessionId throws, so use that.
    // We also need to opt into the write-remote tier for session cancel.
    // Simplest approach: use any read-only tool whose handler can be made
    // to throw. am_wiki_synthesize with no wiki dir throws a typed error.
    // Actually easiest: use a bogus-args call to a validated tool, but
    // validation short-circuits before the handler runs (no timing line).
    //
    // So we trigger a real handler throw by calling am_config_show with
    // a nonexistent config dir. But config-show resolves configDir from
    // env. Instead: inject a bad handler via the test hook.
    process.env.AM_MCP_TIMING = "1";
    cap = installStderrCapture();

    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      enforceInitGate: false,
    });

    // Swap am_status's handler to one that throws synchronously.
    const tools = server.getTools();
    const entry = tools.find((t) => t.def.name === "am_status");
    if (!entry) throw new Error("am_status tool missing");
    const origHandler = entry.handler as unknown;
    (entry as unknown as { handler: unknown }).handler = async () => {
      throw new Error("forced test failure");
    };
    try {
      await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "am_status", arguments: {} },
      });
    } finally {
      (entry as unknown as { handler: unknown }).handler = origHandler;
    }

    const timingLines = cap.capture.filter((s) => s.startsWith("[am-mcp-timing]"));
    expect(timingLines).toHaveLength(1);
    expect(timingLines[0]).toContain("am_status");
    expect(timingLines[0]).toContain("ok=false");
  });
});
