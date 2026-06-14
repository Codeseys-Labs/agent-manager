/**
 * mcp-serve-stdio.test.ts — end-to-end stdio transport round-trip (ws5-e7f6 gap 3).
 *
 * The other mcp-serve tests drive `McpServer.handleRequest()` in-process. This
 * test exercises the REAL stdio loop (`McpServer.serve()` reached via
 * `am mcp-serve`): it spawns the CLI as a subprocess, writes newline-delimited
 * JSON-RPC requests to its stdin, and reads framed responses from its stdout —
 * the exact wire an MCP client (agent) uses. That covers the stdin streaming +
 * `drainStdinBuffer` line-framing + `process.stdout.write(JSON + "\n")` path
 * that the in-process tests cannot.
 *
 * The protocol requires an `initialize` handshake before `tools/list`, so the
 * round-trip is: write initialize → read its response → write tools/list →
 * read its response → kill the long-lived server.
 *
 * Sandboxed: AM_CONFIG_DIR + HOME/USERPROFILE point at mktemp dirs (own per
 * test → parallel-safe). `--allow-unsafe-local` only relaxes the WRITE-tier
 * auth gate; we exercise read-only methods, so it is not strictly required, but
 * it keeps the server from being noisy about a missing token.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { bunExe } from "../helpers/bun-exe";
import { type TestDir, createTestDir } from "../helpers/tmp";

// Spawns a subprocess and waits for two framed responses; cold start dominates.
setDefaultTimeout(60_000);

let configDirHandle: TestDir;
let homeDirHandle: TestDir;

/**
 * Read newline-delimited JSON-RPC frames from a ReadableStream until `count`
 * complete lines have been parsed, or the stream ends. Returns the parsed
 * objects. Bounded by the test timeout so a hung server fails loudly.
 */
async function readFrames(
  stream: ReadableStream<Uint8Array>,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Array<Record<string, unknown>> = [];

  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1 && frames.length < count) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        frames.push(JSON.parse(line) as Record<string, unknown>);
      }
      nl = buffer.indexOf("\n");
    }
  }
  reader.releaseLock();
  return frames;
}

describe("mcp-serve stdio transport (real serve() loop, subprocess round-trip)", () => {
  beforeEach(async () => {
    configDirHandle = await createTestDir("am-mcp-stdio-config-");
    homeDirHandle = await createTestDir("am-mcp-stdio-home-");
  });

  afterEach(async () => {
    await configDirHandle.cleanup();
    await homeDirHandle.cleanup();
  });

  test("initialize → tools/list round-trips well-formed JSON-RPC responses over stdio", async () => {
    const proc = Bun.spawn([bunExe(), "run", "src/cli.ts", "mcp-serve", "--allow-unsafe-local"], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        AM_CONFIG_DIR: configDirHandle.path,
        HOME: homeDirHandle.path,
        USERPROFILE: homeDirHandle.path,
        // Deterministic: never inherit an ambient profile binding.
        AM_MCP_PROFILE: "",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // 1. initialize handshake — mandatory before any tools/* method.
      const initReq = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "stdio-roundtrip-test", version: "0.0.0" },
        },
      };
      // 2. tools/list — the round-trip payload we assert on.
      const listReq = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

      proc.stdin.write(`${JSON.stringify(initReq)}\n`);
      proc.stdin.write(`${JSON.stringify(listReq)}\n`);
      await proc.stdin.flush();

      const frames = await readFrames(proc.stdout, 2);
      expect(frames.length).toBe(2);

      // ── initialize response: well-formed JSON-RPC + correct server identity ──
      const initResp = frames.find((f) => f.id === 1) as Record<string, any>;
      expect(initResp).toBeDefined();
      expect(initResp.jsonrpc).toBe("2.0");
      expect(initResp.error).toBeUndefined();
      expect(initResp.result.protocolVersion).toBeTruthy();
      expect(initResp.result.capabilities.tools).toBeDefined();
      expect(initResp.result.serverInfo.name).toBe("agent-manager");

      // ── tools/list response: well-formed, returns a non-empty tool list ──
      const listResp = frames.find((f) => f.id === 2) as Record<string, any>;
      expect(listResp).toBeDefined();
      expect(listResp.jsonrpc).toBe("2.0");
      expect(listResp.error).toBeUndefined();
      expect(Array.isArray(listResp.result.tools)).toBe(true);
      expect(listResp.result.tools.length).toBeGreaterThan(0);
      // Every advertised tool has the MCP-required name + inputSchema shape.
      for (const tool of listResp.result.tools) {
        expect(typeof tool.name).toBe("string");
        expect(tool.inputSchema).toBeDefined();
      }
      // The core read-only listing tool is always advertised.
      const names = listResp.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("am_list_servers");
    } finally {
      // Long-lived loop — close stdin (ends the for-await) and hard-kill to be
      // sure the subprocess never outlives the test.
      try {
        proc.stdin.end();
      } catch {
        // stdin may already be closed; ignore.
      }
      proc.kill();
      await proc.exited;
    }
  });
});
