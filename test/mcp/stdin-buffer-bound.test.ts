/**
 * SEC-5: MCP stdio buffer bound.
 *
 * The stdin read loop accumulates bytes until a newline delimits a JSON-RPC
 * message. A peer that streams bytes without a newline must not be able to
 * grow the buffer without limit — the buffer is capped at
 * MAX_STDIN_LINE_BYTES, past which the line is rejected as a parse error and
 * discarded. `drainStdinBuffer` is the pure primitive that enforces this.
 */

import { describe, expect, test } from "bun:test";
import { MAX_STDIN_LINE_BYTES, McpServer } from "../../src/mcp/server";

describe("SEC-5: McpServer.drainStdinBuffer line bound", () => {
  test("splits complete lines and keeps the remainder", () => {
    const { lines, remainder } = McpServer.drainStdinBuffer('{"a":1}\n{"b":2}\npartial');
    expect(lines).toEqual([{ line: '{"a":1}' }, { line: '{"b":2}' }]);
    expect(remainder).toBe("partial");
  });

  test("an unterminated oversized remainder is rejected and discarded", () => {
    const huge = "x".repeat(MAX_STDIN_LINE_BYTES + 1);
    const { lines, remainder } = McpServer.drainStdinBuffer(huge);
    expect(lines).toEqual([{ overflow: true }]);
    // Buffer is reset rather than retained — it cannot grow unbounded.
    expect(remainder).toBe("");
  });

  test("a complete-but-oversized line is rejected before JSON.parse", () => {
    const huge = `${"x".repeat(MAX_STDIN_LINE_BYTES + 1)}\n`;
    const { lines, remainder } = McpServer.drainStdinBuffer(huge);
    expect(lines).toEqual([{ overflow: true }]);
    expect(remainder).toBe("");
  });

  test("an under-cap unterminated remainder is retained for the next chunk", () => {
    const part = "y".repeat(1024);
    const { lines, remainder } = McpServer.drainStdinBuffer(part);
    expect(lines).toEqual([]);
    expect(remainder).toBe(part);
  });

  test("repeated newline-free chunks cannot grow the retained buffer past the cap", () => {
    // Simulate the serve() loop accumulating chunks without ever seeing \n.
    let buffer = "";
    const chunk = "z".repeat(1_000_000); // 1 MB chunks
    let overflowCount = 0;
    for (let i = 0; i < 32; i++) {
      buffer += chunk;
      const { lines, remainder } = McpServer.drainStdinBuffer(buffer);
      buffer = remainder;
      if (lines.some((l) => "overflow" in l && l.overflow)) overflowCount++;
      // The retained buffer must never exceed the cap.
      expect(buffer.length).toBeLessThanOrEqual(MAX_STDIN_LINE_BYTES);
    }
    // At least one overflow must have fired (32 MB > 16 MiB cap).
    expect(overflowCount).toBeGreaterThan(0);
  });

  test("a normal-sized valid line round-trips through the bound", () => {
    const msg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const { lines, remainder } = McpServer.drainStdinBuffer(`${msg}\n`);
    expect(lines).toEqual([{ line: msg }]);
    expect(remainder).toBe("");
    // Sanity: the retained line parses.
    const only = lines[0];
    if (!("overflow" in only)) {
      expect(JSON.parse(only.line).method).toBe("ping");
    }
  });
});
