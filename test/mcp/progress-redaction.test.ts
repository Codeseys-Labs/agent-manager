/**
 * progress-redaction.test.ts — REV-2 HIGH-1 / ADR-0033 Phase B prelaunch gate.
 *
 * Before the fix, an ACP `agent_message_chunk` containing `sk-ant-...` was
 * forwarded verbatim by McpServer.emitProgress into `notifications/progress`
 * params — so any MCP client logging progress frames to disk got the key.
 * The fix: redact every string leaf in the progress payload via
 * redactSecretish before emission.
 *
 * We drive this two ways:
 *   (1) Direct unit test of `redactProgressMessage` on a hand-built update
 *       object (matches the ACP session_update shape in src/mcp/server.ts:2256).
 *   (2) End-to-end via `McpServer.setProgressSink` — we swap the sink, invoke
 *       a tool that emits a progress notification with a secret-bearing text,
 *       assert the captured frame is scrubbed.
 */

import { describe, expect, test } from "bun:test";
import { McpServer, redactProgressMessage } from "../../src/mcp/server";

describe("redactProgressMessage — structural walker", () => {
  test("redacts Anthropic keys in a plain string leaf", () => {
    const out = redactProgressMessage("here is your sk-ant-TESTLEAK12345678901234567890");
    expect(out).not.toContain("TESTLEAK12345678901234567890");
    expect(out).toContain("[REDACTED_ANTHROPIC_KEY]");
  });

  test("redacts secrets nested in an ACP session_update payload", () => {
    const update = {
      kind: "acp.session_update",
      sessionId: "sess-1",
      agent: "claude",
      data: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "The credential is sk-ant-FAKELEAK123456789012345 — do not share",
        },
      },
    };
    const out = redactProgressMessage(update) as {
      data: { content: { text: string } };
    };
    expect(out.data.content.text).not.toContain("FAKELEAK123456789012345");
    expect(out.data.content.text).toContain("[REDACTED_ANTHROPIC_KEY]");
  });

  test("redacts AWS access keys in nested arrays", () => {
    const payload = {
      updates: [{ text: "AKIAIOSFODNN7EXAMPLE" }, { text: "clean line" }],
    };
    const out = redactProgressMessage(payload) as {
      updates: Array<{ text: string }>;
    };
    expect(out.updates[0].text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out.updates[0].text).toContain("[REDACTED_AWS_KEY]");
    expect(out.updates[1].text).toBe("clean line");
  });

  test("leaves benign objects unchanged", () => {
    const payload = { status: "running", progress: 0.5, total: 1 };
    expect(redactProgressMessage(payload)).toEqual(payload);
  });

  test("passes through non-string non-object leaves (numbers, booleans, null)", () => {
    expect(redactProgressMessage(42)).toBe(42);
    expect(redactProgressMessage(true)).toBe(true);
    expect(redactProgressMessage(null)).toBe(null);
    expect(redactProgressMessage(undefined)).toBe(undefined);
  });
});

describe("McpServer.emitProgress — secrets scrubbed before emission", () => {
  test("injected sk-ant-TESTLEAK in an ACP chunk does NOT reach the sink", async () => {
    const server = new McpServer({
      auth: { token: undefined, allowUnsafeLocal: true },
      enforceInitGate: false,
    });

    // Capture every progress frame that hits the sink.
    const captured: unknown[] = [];
    server.setProgressSink((notif) => {
      captured.push(notif);
    });

    // Inject a synthetic tool that emits a session_update-shaped progress
    // payload containing a fake Anthropic key. We swap an existing tool's
    // handler for the duration of the test — same indirection used by
    // test/mcp/agent-invoke.test.ts:313-349.
    const tools = server.getTools();
    const entry = tools.find((t) => t.def.name === "am_status");
    if (!entry) throw new Error("am_status tool missing (pre-condition for this test)");
    const originalHandler = entry.handler as unknown;
    const leakText = "here is your sk-ant-TESTLEAK1234567890123456789012345";
    (entry as unknown as { handler: unknown }).handler = async (
      _args: unknown,
      ctx: { emitProgress: (p: { message: unknown }) => void },
    ) => {
      ctx.emitProgress({
        message: {
          kind: "acp.session_update",
          sessionId: "s1",
          agent: "claude",
          data: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: leakText },
          },
        },
      });
      return { ok: true };
    };

    try {
      const res = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "am_status",
          arguments: {},
          _meta: { progressToken: "probe-token" },
        },
      });
      // Tool returned fine, but we're here for the side effect.
      expect(res).toBeTruthy();
    } finally {
      (entry as unknown as { handler: unknown }).handler = originalHandler;
    }

    // At least one progress frame should have been captured — assert the
    // leak text is gone and the redaction placeholder is present.
    expect(captured.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("TESTLEAK1234567890123456789012345");
    expect(serialized).toContain("[REDACTED_ANTHROPIC_KEY]");
  });
});
