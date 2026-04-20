/**
 * shell-wrapper.test.ts — ADR-0033 Phase B.
 *
 * Drives ShimAcpServer in-process (no subprocess — the test feeds JSON-RPC
 * frames directly). Covers:
 *   - Happy path: /bin/echo "hi" round-trips as one agent_message_chunk.
 *   - Stdin template: /bin/cat echoes the prompt back.
 *   - Error path: /bin/false → stopReason "refusal".
 *   - Timeout: /bin/sleep 10 with timeoutMs=100 kills the child.
 *   - Env leak: parent process AM_LEAK_TEST is NOT in the child's env dump.
 */

import { describe, expect, test } from "bun:test";
import {
  ShimAcpServer,
  __argNamedWarnedOnce,
  __resetArgNamedWarnedOnceForTests,
} from "../../../src/protocols/acp/shell-wrapper";

interface Frame {
  jsonrpc: "2.0";
  method?: string;
  id?: string | number | null;
  result?: unknown;
  error?: unknown;
  params?: Record<string, unknown>;
}

/** Build a server + emit collector. */
function makeServer(shim: ConstructorParameters<typeof ShimAcpServer>[0]): {
  server: ShimAcpServer;
  frames: Frame[];
} {
  const frames: Frame[] = [];
  const server = new ShimAcpServer(shim, (f) => frames.push(f as Frame));
  return { server, frames };
}

/** Drive initialize → session/new → session/prompt and return everything. */
async function driveOneTurn(
  shim: ConstructorParameters<typeof ShimAcpServer>[0],
  promptText: string,
): Promise<{
  initResponse: Frame | null;
  sessionId: string;
  updates: Frame[];
  promptResponse: Frame | null;
  frames: Frame[];
}> {
  const { server, frames } = makeServer(shim);
  const initResponse = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" },
  });
  const newSessResponse = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: process.cwd() },
  });
  const sessionId = (newSessResponse?.result as { sessionId?: string })?.sessionId ?? "";
  expect(sessionId).toMatch(/^shell-/);

  const promptResponse = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    },
  });
  const updates = frames.filter((f) => f.method === "session/update");
  return {
    initResponse: initResponse as Frame | null,
    sessionId,
    updates,
    promptResponse: promptResponse as Frame | null,
    frames,
  };
}

describe.skipIf(process.platform === "win32")("ShimAcpServer — arg-last template", () => {
  test("echoes prompt back as a single agent_message_chunk, stopReason=end_turn", async () => {
    // REV-5 LOW-2: use `printf '%s'` instead of `/bin/echo -n` for cross-OS
    // portability. On some Linux distros `/bin/echo` is a standalone binary
    // that prints `-n` literally instead of suppressing the newline. printf
    // is POSIX and consistent across macOS + all Linux distros.
    const { updates, promptResponse } = await driveOneTurn(
      {
        command: ["/usr/bin/printf", "%s"],
        promptTemplate: "arg-last",
        responseExtractor: "stdout",
      },
      "hi",
    );
    expect(updates).toHaveLength(1);
    const u = updates[0];
    const update = (u.params as { update: { content: { text: string } } }).update;
    expect(update.content.text).toBe("hi");
    expect(promptResponse?.result).toEqual({ stopReason: "end_turn" });
  });
});

describe.skipIf(process.platform === "win32")("ShimAcpServer — stdin template", () => {
  test("feeds prompt via stdin, cat echoes it back", async () => {
    const { updates, promptResponse } = await driveOneTurn(
      {
        command: ["/bin/cat"],
        promptTemplate: "stdin",
        responseExtractor: "stdout",
      },
      "stdin-hello",
    );
    expect(updates).toHaveLength(1);
    const update = (updates[0].params as { update: { content: { text: string } } }).update;
    expect(update.content.text).toBe("stdin-hello");
    expect(promptResponse?.result).toEqual({ stopReason: "end_turn" });
  });
});

describe.skipIf(process.platform === "win32")("ShimAcpServer — error path", () => {
  test("wrapping /bin/false returns stopReason=refusal, no crash", async () => {
    const { promptResponse, updates } = await driveOneTurn(
      {
        command: ["/bin/bash", "-c", "echo oops 1>&2; exit 1"],
        promptTemplate: "stdin",
        responseExtractor: "stdout",
      },
      "trigger",
    );
    // Still emits one chunk (per the ADR — one chunk + one stop).
    expect(updates).toHaveLength(1);
    const result = promptResponse?.result as { stopReason: string; error?: string };
    // Per the shim: non-zero exit + not cancelled + not timed out → "refusal".
    expect(result.stopReason).toBe("refusal");
    expect(result.error ?? "").toMatch(/exit|oops|1/i);
  });
});

describe.skipIf(process.platform === "win32")("ShimAcpServer — timeout path", () => {
  test("timeoutMs=100 kills a sleeping child and returns stopReason=error", async () => {
    // NOTE: we use `/bin/bash -c 'sleep 10'` rather than `/bin/sleep 10` with
    // arg-last because arg-last would append our prompt to sleep's argv
    // (`/bin/sleep 10 <prompt>`), and sleep errors out immediately on the
    // extra arg ("invalid time interval"). Going through bash -c gives us a
    // clean long-running child that ignores prompt input (stdin mode +
    // stdin-ignoring command).
    const t0 = Date.now();
    const { promptResponse } = await driveOneTurn(
      {
        command: ["/bin/bash", "-c", "sleep 10"],
        promptTemplate: "stdin",
        responseExtractor: "stdout",
        timeoutMs: 100,
      },
      "x",
    );
    const elapsed = Date.now() - t0;
    // 100ms budget + 500ms grace before SIGKILL + some scheduler slack.
    expect(elapsed).toBeLessThan(5_000);
    const result = promptResponse?.result as { stopReason: string; error?: string };
    expect(result.stopReason).toBe("error");
    expect(result.error ?? "").toMatch(/timeout|killed/i);
  });
});

describe.skipIf(process.platform === "win32")("ShimAcpServer — env leak probe", () => {
  test("parent AM_LEAK_TEST is NOT present in the wrapped process's env dump", async () => {
    const savedLeak = process.env.AM_LEAK_TEST;
    process.env.AM_LEAK_TEST = "should-not-escape-42";
    try {
      const { updates } = await driveOneTurn(
        {
          // `env` alone dumps all env vars to stdout — if the shim leaks, we'd
          // see AM_LEAK_TEST=should-not-escape-42 in the chunk text.
          command: ["/bin/bash", "-c", "env"],
          promptTemplate: "arg-last",
          responseExtractor: "stdout",
        },
        "x",
      );
      expect(updates).toHaveLength(1);
      const text = (updates[0].params as { update: { content: { text: string } } }).update.content
        .text;
      expect(text).not.toContain("should-not-escape-42");
      expect(text).not.toContain("AM_LEAK_TEST");
    } finally {
      if (savedLeak === undefined) process.env.AM_LEAK_TEST = undefined;
      else process.env.AM_LEAK_TEST = savedLeak;
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "ShimAcpServer — REV-4 MED-3: arg-named warn-once",
  () => {
    test("first arg-named prompt emits warning; second does not", async () => {
      // Reset rate-limiter state; capture console.warn output.
      __resetArgNamedWarnedOnceForTests();
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((a) => String(a)).join(" "));
      };
      try {
        // Two turns with the same agent name — second should NOT warn again.
        await driveOneTurn(
          {
            command: ["/usr/bin/printf", "%s"],
            promptTemplate: "arg-named",
            responseExtractor: "stdout",
          },
          "one",
        );
        await driveOneTurn(
          {
            command: ["/usr/bin/printf", "%s"],
            promptTemplate: "arg-named",
            responseExtractor: "stdout",
          },
          "two",
        );
      } finally {
        console.warn = originalWarn;
      }

      const argNamedWarnings = warnings.filter((w) => w.includes("arg-named"));
      expect(argNamedWarnings).toHaveLength(1);
      expect(argNamedWarnings[0]).toContain("falling back to arg-last");
      expect(argNamedWarnings[0]).toContain("/usr/bin/printf");
      // State persisted in the module-level Set across turns.
      expect(__argNamedWarnedOnce.has("/usr/bin/printf")).toBe(true);
    });

    test("warn-once tracked per wrapped command name", async () => {
      __resetArgNamedWarnedOnceForTests();
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((a) => String(a)).join(" "));
      };
      try {
        await driveOneTurn(
          {
            command: ["/usr/bin/printf", "%s"],
            promptTemplate: "arg-named",
          },
          "a",
        );
        // Distinct command → distinct warn-once key → second warning.
        // `/bin/true` ignores argv, exits 0 — perfect for this assertion.
        await driveOneTurn(
          {
            command: ["/bin/true"],
            promptTemplate: "arg-named",
          },
          "b",
        );
      } finally {
        console.warn = originalWarn;
      }

      // Two distinct agents → two warnings.
      const argNamedWarnings = warnings.filter((w) => w.includes("arg-named"));
      expect(argNamedWarnings).toHaveLength(2);
    });
  },
);

describe("ShimAcpServer — spec surface (initialize / session/load)", () => {
  test("initialize advertises loadSession: false and correct protocolVersion", async () => {
    const { server } = makeServer({
      command: ["/bin/true"],
      promptTemplate: "stdin",
      responseExtractor: "stdout",
    });
    const res = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const result = res?.result as {
      protocolVersion: string;
      agentCapabilities: { loadSession: boolean };
    };
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.agentCapabilities.loadSession).toBe(false);
  });

  test("session/load rejected with -32601", async () => {
    const { server } = makeServer({
      command: ["/bin/true"],
    });
    const res = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "session/load",
      params: { sessionId: "whatever" },
    });
    expect(res?.error).toMatchObject({ code: -32601 });
  });

  test("unknown method returns -32601", async () => {
    const { server } = makeServer({ command: ["/bin/true"] });
    const res = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "nonexistent/method",
    });
    expect(res?.error).toMatchObject({ code: -32601 });
  });
});
