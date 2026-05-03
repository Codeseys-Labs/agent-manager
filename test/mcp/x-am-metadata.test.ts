/**
 * ADR-0037 Phase 1 (2026-05-03): every tool in `tools/list` must carry
 * an `x-am` metadata object with required fields. Pin the contract.
 *
 * Required fields per ADR-0037 §"Field definitions":
 *   - group: enum of 6 tool groups
 *   - tier: "read-only" | "write-local" | "write-remote"
 *   - auth_required: boolean
 *   - deprecated: boolean
 *   - deprecation (optional, present when deprecated=true): { replacement, removal_version }
 *   - progress_supported: boolean
 *
 * Output schema + error_codes + progress_shape are Phase 2/3 — NOT
 * required in this MVP; test does not assert their presence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/core/config";
import { initRepo } from "../../src/core/git";
import {
  type AmToolMetadata,
  DEPRECATED_ALIASES,
  McpServer,
  PROGRESS_SUPPORTED,
  buildToolMetadata,
} from "../../src/mcp/server";
import { type TestDir, createTestDir } from "../helpers/tmp";

type JsonRpcResult = Record<string, any>;

const VALID_GROUPS = new Set(["core", "registry", "a2a", "wiki", "session", "acp"]);
const VALID_TIERS = new Set(["read-only", "write-local", "write-remote"]);

describe("ADR-0037 Phase 1 — x-am tool metadata", () => {
  let dir: TestDir | undefined;
  const originalEnv = process.env.AM_CONFIG_DIR;

  beforeEach(async () => {
    dir = await createTestDir("am-mcp-xam-");
    process.env.AM_CONFIG_DIR = dir.path;
    await initRepo(dir.path);
    // Enable ALL tool groups so tools/list surfaces every tool.
    await writeConfig(join(dir.path, "config.toml"), {
      settings: {
        mcp_serve: { tools: ["core", "registry", "a2a", "wiki", "session", "acp"] },
      },
    });
  });

  afterEach(async () => {
    if (originalEnv === undefined) process.env.AM_CONFIG_DIR = undefined;
    else process.env.AM_CONFIG_DIR = originalEnv;
    if (dir) await dir.cleanup();
    dir = undefined;
  });

  test("every tool in tools/list has an x-am object", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (resp?.result as JsonRpcResult).tools as Array<
      Record<string, unknown> & { name: string }
    >;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool["x-am"]).toBeDefined();
      expect(typeof tool["x-am"]).toBe("object");
    }
  });

  test("every tool's x-am carries the 5 required fields", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (resp?.result as JsonRpcResult).tools as Array<{
      name: string;
      "x-am": AmToolMetadata;
    }>;
    for (const tool of tools) {
      const xam = tool["x-am"];
      expect(xam.group, `tool ${tool.name} missing group`).toBeDefined();
      expect(VALID_GROUPS.has(xam.group)).toBe(true);
      expect(xam.tier, `tool ${tool.name} missing tier`).toBeDefined();
      expect(VALID_TIERS.has(xam.tier)).toBe(true);
      expect(typeof xam.auth_required).toBe("boolean");
      expect(typeof xam.deprecated).toBe("boolean");
      expect(typeof xam.progress_supported).toBe("boolean");
    }
  });

  test("auth_required matches tier (write-tiers require auth, read-only doesn't)", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (resp?.result as JsonRpcResult).tools as Array<{
      name: string;
      "x-am": AmToolMetadata;
    }>;
    for (const tool of tools) {
      const xam = tool["x-am"];
      if (xam.tier === "read-only") {
        expect(xam.auth_required, `${tool.name} is read-only but auth_required=true`).toBe(false);
      } else {
        expect(xam.auth_required, `${tool.name} is ${xam.tier} but auth_required=false`).toBe(true);
      }
    }
  });

  test("deprecated aliases carry deprecation={replacement,removal_version}", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (resp?.result as JsonRpcResult).tools as Array<{
      name: string;
      "x-am": AmToolMetadata;
    }>;
    const byName = new Map(tools.map((t) => [t.name, t["x-am"]]));

    // Every registered alias must surface as deprecated.
    for (const [oldName, info] of Object.entries(DEPRECATED_ALIASES)) {
      const xam = byName.get(oldName);
      if (!xam) continue; // alias may be hidden under filter; skip
      expect(xam.deprecated, `${oldName} not flagged deprecated`).toBe(true);
      expect(xam.deprecation).toEqual(info);
    }

    // Non-deprecated tools must NOT carry a deprecation field.
    for (const tool of tools) {
      if (!DEPRECATED_ALIASES[tool.name]) {
        expect(tool["x-am"].deprecated).toBe(false);
        expect(tool["x-am"].deprecation).toBeUndefined();
      }
    }
  });

  test("progress_supported matches PROGRESS_SUPPORTED registry", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (resp?.result as JsonRpcResult).tools as Array<{
      name: string;
      "x-am": AmToolMetadata;
    }>;
    for (const tool of tools) {
      const expected = PROGRESS_SUPPORTED.has(tool.name);
      expect(tool["x-am"].progress_supported).toBe(expected);
    }
  });

  test("buildToolMetadata is a pure function (snapshot-level contract)", () => {
    // Lock shape for a canonical known tool: am_apply is write-local core.
    const meta = buildToolMetadata("am_apply", "write-local");
    expect(meta).toEqual({
      group: "core",
      tier: "write-local",
      auth_required: true,
      deprecated: false,
      progress_supported: false,
    });

    // Lock a deprecated tool: am_run_agent → am_agent_invoke.
    const runMeta = buildToolMetadata("am_run_agent", "write-remote");
    expect(runMeta).toEqual({
      group: "acp",
      tier: "write-remote",
      auth_required: true,
      deprecated: true,
      deprecation: { replacement: "am_agent_invoke", removal_version: "v0.4" },
      progress_supported: true, // shares invokeAgentImpl
    });

    // Lock a read-only tool: am_list_servers.
    const listMeta = buildToolMetadata("am_list_servers", "read-only");
    expect(listMeta).toEqual({
      group: "core",
      tier: "read-only",
      auth_required: false,
      deprecated: false,
      progress_supported: false,
    });
  });

  test("x-am does not break MCP clients that ignore unknown fields", async () => {
    const server = new McpServer({ auth: { token: undefined, allowUnsafeLocal: true } });
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (resp?.result as JsonRpcResult).tools as Array<{
      name: string;
      description: string;
      inputSchema: unknown;
    }>;
    // Every tool still has the three required MCP fields. x-am is
    // ADDITIONAL, not replacing anything.
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
    }
  });

  test("DEPRECATED_ALIASES registry is complete vs warnDeprecated call sites", async () => {
    // Structural guarantee: every warnDeprecated("oldName", "newName") call in
    // the source must have a corresponding entry in DEPRECATED_ALIASES. If a
    // future PR adds a new alias warning but forgets to register it here,
    // tools/list would understate the deprecation surface.
    const src = await Bun.file(new URL("../../src/mcp/server.ts", import.meta.url)).text();
    const matches = Array.from(src.matchAll(/warnDeprecated\("([^"]+)", "([^"]+)"\)/g));
    expect(matches.length).toBeGreaterThan(0);
    for (const [, oldName, newName] of matches) {
      const entry = DEPRECATED_ALIASES[oldName];
      expect(
        entry,
        `warnDeprecated("${oldName}", ...) lacks DEPRECATED_ALIASES entry`,
      ).toBeDefined();
      expect(entry!.replacement).toBe(newName);
    }
  });
});
