/**
 * SEC-4b regression: the MCP `am_apply` tool must inherit the CLI's
 * fail-closed drift gate.
 *
 * Before this fix, `am_apply` called `applyResolved` WITHOUT `diff: true`, so
 * an agent invoking it would blindly OVERWRITE a native config that a human
 * (or another tool) edited out of band — the 2026-04-15 `~/.claude.json` wipe
 * class of bug, just on a different surface.
 *
 * Corrected behavior: `am_apply` defaults `diff: true`. The controller runs
 * `adapter.diff()` and SKIPS any adapter that is drifted (or whose drift state
 * cannot be read because diff() threw). `force: true` is the explicit opt-in
 * to overwrite, matching the CLI's `--force`.
 *
 * Adapters are injected via the controller's `__setAdapterResolverForTests`
 * seam (cleared in afterEach) — NOT `mock.module`, which is process-global in
 * Bun and leaks into other test files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Adapter, DiffResult, ExportResult, ResolvedConfig } from "../../src/adapters/types";
import { writeConfig } from "../../src/core/config";
import { __setAdapterResolverForTests } from "../../src/core/controller";
import { initRepo } from "../../src/core/git";
import { McpServer } from "../../src/mcp/server";
import { type TestDir, createTestDir } from "../helpers/tmp";

const auth = { auth: { token: undefined, allowUnsafeLocal: true } };

// Tracks whether export() ran — proves the gate skipped (false) vs. wrote (true).
let exportCalled = false;

function baseAdapter(name: string): Omit<Adapter, "diff"> {
  return {
    meta: { name, displayName: name, version: "0.0.0", capabilities: [] },
    detect() {
      return { installed: true, paths: {} };
    },
    import() {
      return { servers: [], instructions: [], skills: [], warnings: [] };
    },
    export(_config: ResolvedConfig, _options): ExportResult {
      exportCalled = true;
      return { files: [{ path: `/tmp/${name}.json`, content: "{}", written: true }], warnings: [] };
    },
  };
}

function driftedAdapter(name: string): Adapter {
  return {
    ...baseAdapter(name),
    diff(): DiffResult {
      return {
        status: "drifted",
        changes: [{ entity: "server", name: "fetch", type: "modified" }],
      };
    },
  };
}

function throwingAdapter(name: string): Adapter {
  return {
    ...baseAdapter(name),
    diff(): DiffResult {
      throw new Error("simulated diff() failure");
    },
  };
}

function callTool(server: McpServer, id: number, name: string, args: Record<string, unknown> = {}) {
  return server.handleRequest({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function parseToolResult(resp: unknown): Record<string, unknown> {
  const result = (resp as { result?: { content?: Array<{ text?: string }> } }).result;
  const text = result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("MCP am_apply — fail-closed drift gate (SEC-4b)", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    exportCalled = false;
    dir = await createTestDir("am-mcp-failclosed-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
    await writeConfig(join(dir.path, "config.toml"), {
      settings: { default_profile: "default" },
      servers: {
        fetch: { command: "uvx", args: ["mcp-server-fetch"], transport: "stdio", enabled: true },
      },
    });
  });

  afterEach(async () => {
    __setAdapterResolverForTests(null);
    if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("drifted adapter is SKIPPED, not overwritten (default force=false)", async () => {
    __setAdapterResolverForTests(async () => [driftedAdapter("drifted-fake")]);
    const server = new McpServer(auth);
    const resp = await callTool(server, 1, "am_apply", {});
    const payload = parseToolResult(resp);

    // The load-bearing assertion: export() must NOT have run.
    expect(exportCalled).toBe(false);
    expect(payload.action).toBe("apply");
    expect(payload.skipped).toEqual(["drifted-fake"]);
    // The adapter result carries the refusal warning, zero files written.
    const results = payload.results as Array<{
      adapter: string;
      files: number;
      warnings: string[];
    }>;
    const entry = results.find((r) => r.adapter === "drifted-fake");
    expect(entry?.files).toBe(0);
    expect((entry?.warnings ?? []).join(" ")).toContain("drift detected");
  });

  test("diff() that throws → SKIPPED (drift state unknown, fail-closed)", async () => {
    __setAdapterResolverForTests(async () => [throwingAdapter("throwing-fake")]);
    const server = new McpServer(auth);
    const resp = await callTool(server, 2, "am_apply", {});
    const payload = parseToolResult(resp);

    expect(exportCalled).toBe(false);
    expect(payload.skipped).toEqual(["throwing-fake"]);
    const results = payload.results as Array<{ adapter: string; warnings: string[] }>;
    const entry = results.find((r) => r.adapter === "throwing-fake");
    expect((entry?.warnings ?? []).join(" ")).toContain("drift check failed");
  });

  test("force=true overwrites the drifted adapter (explicit opt-in)", async () => {
    __setAdapterResolverForTests(async () => [driftedAdapter("drifted-fake")]);
    const server = new McpServer(auth);
    const resp = await callTool(server, 3, "am_apply", { force: true });
    const payload = parseToolResult(resp);

    expect(exportCalled).toBe(true);
    expect(payload.skipped).toEqual([]);
    const results = payload.results as Array<{ adapter: string; files: number }>;
    expect(results.find((r) => r.adapter === "drifted-fake")?.files).toBe(1);
  });

  test("dryRun=true previews regardless of drift (no write, not gated)", async () => {
    __setAdapterResolverForTests(async () => [driftedAdapter("drifted-fake")]);
    const server = new McpServer(auth);
    const resp = await callTool(server, 4, "am_apply", { dryRun: true });
    const payload = parseToolResult(resp);

    // dry-run writes nothing regardless; the live gate doesn't apply, so the
    // adapter is processed (preview) rather than skipped.
    expect(payload.dryRun).toBe(true);
    expect(payload.skipped).toEqual([]);
  });
});
