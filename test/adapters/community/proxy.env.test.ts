/**
 * proxy.env.test.ts — B-03 / Union security: community-adapter env-leak fix.
 *
 * Pins the contract that CommunityAdapterProxy.create() routes the spawned
 * subprocess's environment through `sandboxEnv()` so that secrets present in
 * the parent (`AM_ENCRYPTION_KEY`, `AM_MCP_TOKEN`, `ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `GITHUB_TOKEN`, AWS_*, ...) do NOT leak into community
 * adapters. Mirrors the AmAcpClient sandboxing landed in REV-2 HIGH-3.
 *
 * Strategy: spawn an env-dumping JSON-RPC adapter, ask it for its env via a
 * custom `adapter/dump-env` method, assert no secret-shaped names survived
 * but the allowlist (PATH, HOME, LANG, TERM) did.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommunityAdapterProxy } from "../../../src/adapters/community/proxy";

const ENV_DUMP_ADAPTER = `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const { id, method } = JSON.parse(line);
    let result;
    switch (method) {
      case "adapter/initialize":
        result = { protocolVersion: "1.0", adapterVersion: "0.0.1" };
        break;
      case "adapter/meta":
        result = { name: "env-dump", displayName: "Env Dump", version: "0.0.1", capabilities: [] };
        break;
      case "adapter/schema":
        result = {};
        break;
      case "adapter/dump-env":
        result = { env: { ...process.env } };
        break;
      default:
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } }) + "\\n");
        return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
  } catch {}
});
`;

// Vars we plant in process.env so we can detect leaks. None of these should
// reach the child.
const SECRETS = {
  AM_ENCRYPTION_KEY: "secret-encryption-key-XYZ",
  AM_MCP_TOKEN: "secret-mcp-token-XYZ",
  ANTHROPIC_API_KEY: "sk-ant-XYZ",
  OPENAI_API_KEY: "sk-openai-XYZ",
  GITHUB_TOKEN: "ghp_XYZ",
  AWS_SESSION_TOKEN: "aws-session-XYZ",
} as const;

let tmpDir: string;
let scriptPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "am-community-env-"));
  scriptPath = join(tmpDir, "env-dump-adapter.ts");
  await writeFile(scriptPath, ENV_DUMP_ADAPTER, { mode: 0o755 });

  for (const k of Object.keys(SECRETS)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(SECRETS)) process.env[k] = v;

  // Ensure allowlist vars are present so we can verify they survive.
  if (!process.env.PATH) process.env.PATH = "/usr/bin:/bin";
  if (!process.env.HOME) process.env.HOME = "/tmp";
  if (!process.env.LANG) process.env.LANG = "C";
  if (!process.env.TERM) process.env.TERM = "xterm";
});

afterEach(async () => {
  for (const k of Object.keys(SECRETS)) {
    if (saved[k] === undefined) process.env[k] = undefined;
    else process.env[k] = saved[k];
  }
  await rm(tmpDir, { recursive: true, force: true });
});

async function dumpChildEnv(opts?: { env?: Record<string, string> }): Promise<
  Record<string, string>
> {
  const proxy = await CommunityAdapterProxy.create("bun", [scriptPath], opts);
  try {
    // call() is private — reach in for the test. The proxy exposes high-level
    // methods (detect/import/...) that wouldn't return our env. This is the
    // tightest way to assert the spawned-subprocess env without a real adapter.
    const result = (await (
      proxy as unknown as {
        call: (m: string, p?: Record<string, unknown>) => Promise<unknown>;
      }
    ).call("adapter/dump-env")) as { env: Record<string, string> };
    return result.env;
  } finally {
    proxy.kill();
  }
}

describe("CommunityAdapterProxy env sandbox (B-03)", () => {
  it("does NOT leak AM_ENCRYPTION_KEY to child", async () => {
    const env = await dumpChildEnv();
    expect(env.AM_ENCRYPTION_KEY).toBeUndefined();
  });

  it("does NOT leak AM_MCP_TOKEN to child", async () => {
    const env = await dumpChildEnv();
    expect(env.AM_MCP_TOKEN).toBeUndefined();
  });

  it("does NOT leak ANTHROPIC_API_KEY / OPENAI_API_KEY / GITHUB_TOKEN / AWS_SESSION_TOKEN", async () => {
    const env = await dumpChildEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
  });

  it("DOES pass PATH, HOME, LANG, TERM (allowlist survivors)", async () => {
    const env = await dumpChildEnv();
    expect(env.PATH).toBeDefined();
    expect(env.PATH).toBe(process.env.PATH!);
    expect(env.HOME).toBeDefined();
    expect(env.LANG).toBeDefined();
    expect(env.TERM).toBeDefined();
  });

  it("explicit opts.env is applied after sandbox", async () => {
    const env = await dumpChildEnv({ env: { MY_EXPLICIT_VAR: "applied" } });
    expect(env.MY_EXPLICIT_VAR).toBe("applied");
    // And secrets are still scrubbed even when opts.env is supplied.
    expect(env.AM_ENCRYPTION_KEY).toBeUndefined();
  });

  it("structural: proxy.ts statically imports sandboxEnv from acp/env-sandbox", async () => {
    // Mirror REV-4 LOW-2 guard on client.ts — a refactor that drops the
    // import should fail this test instead of silently regressing the fix.
    const src = await Bun.file(
      new URL("../../../src/adapters/community/proxy.ts", import.meta.url),
    ).text();
    expect(src).toContain("env-sandbox");
    expect(src).toMatch(/sandboxEnv\s*\(/);
  });
});
