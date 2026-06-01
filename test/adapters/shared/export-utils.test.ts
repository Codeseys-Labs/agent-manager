import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpServersJson, writeExportFiles } from "../../../src/adapters/shared/export-utils";
import type { ResolvedServer, WrittenFile } from "../../../src/adapters/types";

function makeServer(overrides: Partial<ResolvedServer> = {}): ResolvedServer {
  return {
    name: "srv",
    command: "node",
    args: [],
    env: {},
    transport: "stdio",
    description: "",
    tags: [],
    enabled: true,
    adapters: {},
    ...overrides,
  };
}

describe("buildMcpServersJson", () => {
  test("stdio server emits command/args/env, omitting empties", () => {
    const json = buildMcpServersJson(
      { a: makeServer({ command: "node", args: ["x.js"], env: { K: "v" } }) },
      "/nonexistent/path.json",
    );
    expect(JSON.parse(json)).toEqual({
      mcpServers: { a: { command: "node", args: ["x.js"], env: { K: "v" } } },
    });
    // Trailing newline preserved
    expect(json.endsWith("}\n")).toBe(true);
  });

  test("omits empty args and env", () => {
    const json = buildMcpServersJson({ a: makeServer() }, "/nope.json");
    expect(JSON.parse(json)).toEqual({ mcpServers: { a: { command: "node" } } });
  });

  test("remote (streamable-http) server emits url from command when remote:true", () => {
    const json = buildMcpServersJson(
      { r: makeServer({ command: "https://example.com/mcp", transport: "streamable-http" }) },
      "/nope.json",
      { remote: true },
    );
    expect(JSON.parse(json)).toEqual({
      mcpServers: { r: { url: "https://example.com/mcp" } },
    });
  });

  test("remote server emits command by default (remote omitted)", () => {
    const json = buildMcpServersJson(
      { r: makeServer({ command: "https://example.com/mcp", transport: "streamable-http" }) },
      "/nope.json",
    );
    expect(JSON.parse(json)).toEqual({
      mcpServers: { r: { command: "https://example.com/mcp" } },
    });
  });

  test("preserves existing non-managed top-level fields", () => {
    const tmp = mkdtempSync(join(tmpdir(), "am-eu-"));
    const path = join(tmp, "mcp.json");
    writeFileSync(path, JSON.stringify({ numStartups: 3, mcpServers: { old: {} } }));
    const json = buildMcpServersJson({ a: makeServer() }, path);
    const parsed = JSON.parse(json);
    expect(parsed.numStartups).toBe(3);
    expect(parsed.mcpServers).toEqual({ a: { command: "node" } });
  });

  test("merges adapter extras under adapterKey", () => {
    const json = buildMcpServersJson(
      { a: makeServer({ adapters: { foo: { alwaysAllow: ["x"], scope: "project" } } }) },
      "/nope.json",
      { adapterKey: "foo", skipExtras: ["scope"] },
    );
    expect(JSON.parse(json).mcpServers.a).toEqual({ command: "node", alwaysAllow: ["x"] });
  });

  test("mapExtra renames extra keys", () => {
    const json = buildMcpServersJson(
      { a: makeServer({ adapters: { foo: { alwaysAllow: true } } }) },
      "/nope.json",
      {
        adapterKey: "foo",
        mapExtra: (k, v) => (k === "alwaysAllow" ? ["always_allow", v] : [k, v]),
      },
    );
    expect(JSON.parse(json).mcpServers.a).toEqual({ command: "node", always_allow: true });
  });

  test("serversKey overrides the top-level key", () => {
    const json = buildMcpServersJson({ a: makeServer() }, "/nope.json", { serversKey: "servers" });
    expect(JSON.parse(json)).toEqual({ servers: { a: { command: "node" } } });
  });
});

describe("writeExportFiles", () => {
  test("writes files and marks written=true", () => {
    const tmp = mkdtempSync(join(tmpdir(), "am-eu-"));
    const files: WrittenFile[] = [
      { path: join(tmp, "nested", "a.json"), content: "hello\n", written: false },
    ];
    const warnings: string[] = [];
    writeExportFiles(files, warnings);
    expect(files[0].written).toBe(true);
    expect(readFileSync(files[0].path, "utf-8")).toBe("hello\n");
    expect(warnings).toEqual([]);
  });

  test("dryRun writes nothing and leaves written=false", () => {
    const tmp = mkdtempSync(join(tmpdir(), "am-eu-"));
    const files: WrittenFile[] = [{ path: join(tmp, "a.json"), content: "x", written: false }];
    const warnings: string[] = [];
    writeExportFiles(files, warnings, { dryRun: true });
    expect(files[0].written).toBe(false);
    expect(() => readFileSync(files[0].path, "utf-8")).toThrow();
  });
});
