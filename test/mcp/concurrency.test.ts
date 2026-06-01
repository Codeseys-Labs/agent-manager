/**
 * Business-layer concurrency safety tests (Wave B of iter4 fix pass).
 *
 * The MCP protocol layer dispatches batch requests with `Promise.all`
 * (intentional — parallelism at the transport level is fine). The *business*
 * layer must not interleave read-modify-write on the config. These tests
 * exercise real handlers through `McpServer.handleRequest`/`handleBatch`
 * and assert that concurrent writers all land in the final TOML, not that
 * the last-writer wins.
 *
 * Before Wave B: two `am_add_server` calls racing would read the same
 * baseline config, each write their own updated copy, and the second
 * writer would overwrite the first's server. Verified by running this
 * test against HEAD^^ — it fails. After Wave B (withConfig serializes
 * writers on a per-process AsyncMutex), both writes land.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import type { Config } from "../../src/core/schema";
import { McpServer } from "../../src/mcp/server";
import { type TestDir, createTestDir } from "../helpers/tmp";

type JsonRpcResult = Record<string, any>;

const auth = { auth: { token: undefined, allowUnsafeLocal: true } };

async function setupConfig(config: Config): Promise<{ dir: TestDir; configDir: string }> {
  const dir = await createTestDir("am-mcp-conc-");
  const configDir = dir.path;
  process.env.AM_CONFIG_DIR = configDir;
  await initRepo(configDir);
  await writeConfig(join(configDir, "config.toml"), config);
  return { dir, configDir };
}

function callTool(server: McpServer, id: number, name: string, args: Record<string, unknown> = {}) {
  return server.handleRequest({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

describe("MCP concurrency safety (Wave B)", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  afterEach(async () => {
    if (originalEnv) {
      process.env.AM_CONFIG_DIR = originalEnv;
    } else {
      process.env.AM_CONFIG_DIR = undefined;
    }
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("2x am_add_server concurrent — both servers land in config", async () => {
    const ctx = await setupConfig({ servers: {} });
    dir = ctx.dir;

    const server = new McpServer(auth);
    const [respA, respB] = await Promise.all([
      callTool(server, 1, "am_add_server", { name: "alpha", command: "cmd-a" }),
      callTool(server, 2, "am_add_server", { name: "beta", command: "cmd-b" }),
    ]);

    expect((respA?.result as JsonRpcResult).isError).not.toBe(true);
    expect((respB?.result as JsonRpcResult).isError).not.toBe(true);

    const final = await readConfig(join(ctx.configDir, "config.toml"));
    expect(final.servers?.alpha?.command).toBe("cmd-a");
    expect(final.servers?.beta?.command).toBe("cmd-b");
  });

  test("2x am_apply concurrent — no writes are lost", async () => {
    // Apply with an empty adapter set (nothing detected in the tmpdir)
    // still exercises the full `applyResolved` pipeline and would
    // previously race if two calls interleaved their state.toml reads.
    //
    // Timeout raised from bun:test's default 5s to 30s (2026-05-03): this
    // test was flaky under full-suite load (187 files in parallel on WSL2)
    // because `applyResolved` + `getDetectedAdapters` + loading 13 adapters'
    // detect() results exceeds 5s on loaded hosts. Same fix pattern as
    // test/adapters/registry.test.ts getDetectedAdapters. Not masking a
    // real concurrency bug — the test passes 5/5 in isolation; only the
    // full-suite race produces the timeout. Tracked as the resolution of
    // task #32 (run-A 2026-05-01 baseline flake).
    const ctx = await setupConfig({
      servers: {
        shared: { command: "echo", transport: "stdio", enabled: true },
      },
    });
    dir = ctx.dir;

    const server = new McpServer(auth);
    const [respA, respB] = await Promise.all([
      callTool(server, 10, "am_apply", { dryRun: true }),
      callTool(server, 11, "am_apply", { dryRun: true }),
    ]);

    // Neither call may return an error envelope — the lock must serialize,
    // not reject.
    const parseResult = (r: unknown) =>
      JSON.parse(((r as JsonRpcResult).content[0] as { text: string }).text);
    const a = parseResult(respA?.result);
    const b = parseResult(respB?.result);
    expect(a.action).toBe("apply");
    expect(b.action).toBe("apply");
    expect(a.dryRun).toBe(true);
    expect(b.dryRun).toBe(true);
  }, 30_000);

  test("am_apply + am_add_server race — ordering stays coherent", async () => {
    const ctx = await setupConfig({ servers: {} });
    dir = ctx.dir;

    const server = new McpServer(auth);
    // Race an apply (which reads the config under the lock) against an
    // add (which writes under the same lock). Either the add lands first
    // and apply sees it, or apply lands first and add sees the empty
    // state — but neither may observe a half-merged config.
    const [applyResp, addResp] = await Promise.all([
      callTool(server, 20, "am_apply", { dryRun: true }),
      callTool(server, 21, "am_add_server", { name: "gamma", command: "cmd-g" }),
    ]);

    expect((applyResp?.result as JsonRpcResult).isError).not.toBe(true);
    expect((addResp?.result as JsonRpcResult).isError).not.toBe(true);

    // After both complete, the server must exist regardless of who ran first.
    const final = await readConfig(join(ctx.configDir, "config.toml"));
    expect(final.servers?.gamma?.command).toBe("cmd-g");
    // 30s override (matches the "2x am_apply" test above): am_apply runs all 13
    // adapters' detect() under the AsyncMutex, and the per-adapter filesystem
    // probes are markedly slower on the Windows runner — the default 5s timed
    // out there. The mutex behavior under test is unchanged; only wall-time differs.
  }, 30_000);

  test("batch request with 3 writers — all three lands, none lost", async () => {
    const ctx = await setupConfig({ servers: {} });
    dir = ctx.dir;

    const server = new McpServer(auth);
    // `handleBatch` runs these in parallel via Promise.all at the protocol
    // layer. The business-layer mutex must still serialize the RMW.
    const batch = [
      {
        jsonrpc: "2.0" as const,
        id: 30,
        method: "tools/call",
        params: { name: "am_add_server", arguments: { name: "one", command: "c1" } },
      },
      {
        jsonrpc: "2.0" as const,
        id: 31,
        method: "tools/call",
        params: { name: "am_add_server", arguments: { name: "two", command: "c2" } },
      },
      {
        jsonrpc: "2.0" as const,
        id: 32,
        method: "tools/call",
        params: { name: "am_add_server", arguments: { name: "three", command: "c3" } },
      },
    ];
    const responses = await server.handleBatch(batch);
    expect(responses.length).toBe(3);
    for (const r of responses) {
      expect((r?.result as JsonRpcResult)?.isError).not.toBe(true);
    }

    const final = await readConfig(join(ctx.configDir, "config.toml"));
    expect(Object.keys(final.servers ?? {}).sort()).toEqual(["one", "three", "two"]);
  });

  test("read-only pair runs concurrently without serialization", async () => {
    // Two read-only tool calls must be safe to parallelize — the lock
    // only gates writers. This is primarily a smoke test: both calls
    // must resolve without racing on config reads.
    const ctx = await setupConfig({
      servers: {
        only: { command: "x", transport: "stdio", enabled: true },
      },
    });
    dir = ctx.dir;

    const server = new McpServer(auth);
    const [a, b] = await Promise.all([
      callTool(server, 40, "am_list_servers", {}),
      callTool(server, 41, "am_list_servers", {}),
    ]);

    const parseResult = (r: unknown) =>
      JSON.parse(((r as JsonRpcResult).content[0] as { text: string }).text);
    const ra = parseResult(a?.result);
    const rb = parseResult(b?.result);
    expect(ra.servers.length).toBe(1);
    expect(rb.servers.length).toBe(1);
    expect(ra.servers[0].name).toBe("only");
    expect(rb.servers[0].name).toBe("only");
  });
});
