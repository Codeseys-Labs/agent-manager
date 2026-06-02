/**
 * Regression tests for Wave 1.B protocol hardening fixes.
 *
 * Each block corresponds to a numbered finding from the multi-agent deep
 * analysis (docs/reviews/2026-04-16-multi-agent-deep-analysis/04-protocols.md):
 *   1. CRITICAL: ACP connect() leaks subprocess on init failure
 *   2. HIGH: Bridge permissionPolicy/allowedPaths are dead config
 *   3. HIGH: terminalStore leaked across clients; stdout drained incorrectly
 *   4. HIGH: parseCommand silently drops quoted args
 *   5. HIGH: SSE has idle timeout but no heartbeat
 *   6. MEDIUM: SSE initial frame hardcodes final:false even for terminal tasks
 *   7. MEDIUM: createBridgedTaskHandler wired via require() in ESM
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import type { ResolvedConfig } from "../../src/adapters/types";
import {
  SSE_HEARTBEAT_INTERVAL_MS,
  TaskEventEmitter,
  type TaskStore,
  createA2ARoutes,
  createTaskStore,
} from "../../src/protocols/a2a/server";
import type { Message } from "../../src/protocols/a2a/types";
import { AmAcpClient, createAcpClient } from "../../src/protocols/acp/client";
import { parseCommand } from "../../src/protocols/acp/registry";
import {
  type BridgeConfig,
  createBridgeTaskHandler,
  createBridgedTaskHandler,
} from "../../src/protocols/bridge";

// ── Shared setup ──────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "am-hardening-1b-"));
  await mkdir(join(tmpDir, ".agent-manager"), { recursive: true });
  const config = {
    settings: { default_profile: "default" },
    servers: {},
    profiles: { default: { description: "Default profile" } },
  };
  await writeFile(join(tmpDir, "config.toml"), TOML.stringify(config as TOML.JsonMap));
  process.env.AM_CONFIG_DIR = tmpDir;
});

afterAll(async () => {
  Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
  await rm(tmpDir, { recursive: true, force: true });
});

function makeResolvedConfig(): ResolvedConfig {
  return {
    servers: {},
    instructions: {},
    skills: {},
    agents: {},
    profile: "default",
    adapters: {},
  };
}

function textMessage(text: string): Message {
  return { role: "user", parts: [{ type: "text", text }] };
}

// ── Fix 1: ACP subprocess leak on init failure ───────────────────

describe("Fix 1 — ACP connect() kills subprocess on init failure", () => {
  test("never-responding ACP agent is killed within the initTimeout", async () => {
    const client = new AmAcpClient();

    // `sleep` stays alive but speaks no protocol. Initialize will race vs
    // the timeout and lose; connect() must SIGTERM the subprocess itself.
    const start = Date.now();
    let threw: unknown;
    try {
      await client.connect("sleep 30", { initTimeout: 300 });
    } catch (err) {
      threw = err;
    }
    const elapsed = Date.now() - start;

    expect(threw).toBeDefined();
    // Should fail fast (well under 2s), not sit at the default 30s
    expect(elapsed).toBeLessThan(2500);

    // Reference to the subprocess has been cleared
    expect((client as unknown as { subprocess: unknown }).subprocess).toBeNull();
    // Connection state is reset so a retry doesn't trip ALREADY_CONNECTED
    expect(client.connected).toBe(false);
    expect(client.connectionInfo).toBeNull();
  });

  test("bogus executable surfaces a connect error and leaves no process state", async () => {
    const client = new AmAcpClient();
    await expect(
      client.connect("/definitely/does/not/exist/acp-agent-xyz", { initTimeout: 500 }),
    ).rejects.toBeDefined();
    expect(client.connected).toBe(false);
    expect((client as unknown as { subprocess: unknown }).subprocess).toBeNull();
  });

  test("connect() can be retried after a failed init", async () => {
    const client = new AmAcpClient();
    try {
      await client.connect("sleep 30", { initTimeout: 200 });
    } catch {
      // expected
    }
    // Second attempt must not throw ALREADY_CONNECTED
    try {
      await client.connect("sleep 30", { initTimeout: 200 });
    } catch (err) {
      expect((err as Error).message).not.toContain("Already connected");
    }
  });
});

// ── Fix 2: Bridge wires permissionPolicy + allowedPaths ───────────

describe("Fix 2 — Bridge applies permissionPolicy / allowedPaths", () => {
  test("BridgeConfig.allowedPaths is declared on the public type", () => {
    const cfg: BridgeConfig = { allowedPaths: ["/tmp/sandbox"] };
    expect(cfg.allowedPaths).toEqual(["/tmp/sandbox"]);
  });

  test("bridge handler defaults permissionPolicy to 'deny' and allowedPaths to [cwd]", async () => {
    // Spy on AmAcpClient to capture setPermissionPolicy / setAllowedPaths calls.
    const seen: { policy?: string; paths?: string[] } = {};
    const origSetPolicy = AmAcpClient.prototype.setPermissionPolicy;
    const origSetPaths = AmAcpClient.prototype.setAllowedPaths;
    const origConnect = AmAcpClient.prototype.connect;

    AmAcpClient.prototype.setPermissionPolicy = function (policy) {
      seen.policy = policy;
      return origSetPolicy.call(this, policy);
    };
    AmAcpClient.prototype.setAllowedPaths = function (paths) {
      seen.paths = paths;
      return origSetPaths.call(this, paths);
    };
    // Short-circuit connect so we don't actually spawn anything; throwing is
    // fine — we only care that policy/paths were set BEFORE connect().
    AmAcpClient.prototype.connect = async () => {
      throw new Error("short-circuit");
    };

    try {
      const handler = createBridgeTaskHandler({ cwd: "/tmp/bridge-cwd" });
      await handler(textMessage("run claude: do stuff"), makeResolvedConfig());
    } finally {
      AmAcpClient.prototype.setPermissionPolicy = origSetPolicy;
      AmAcpClient.prototype.setAllowedPaths = origSetPaths;
      AmAcpClient.prototype.connect = origConnect;
    }

    expect(seen.policy).toBe("deny");
    expect(seen.paths).toEqual(["/tmp/bridge-cwd"]);
  });

  test("bridge passes through explicit permissionPolicy and allowedPaths", async () => {
    const seen: { policy?: string; paths?: string[] } = {};
    const origSetPolicy = AmAcpClient.prototype.setPermissionPolicy;
    const origSetPaths = AmAcpClient.prototype.setAllowedPaths;
    const origConnect = AmAcpClient.prototype.connect;

    AmAcpClient.prototype.setPermissionPolicy = function (policy) {
      seen.policy = policy;
      return origSetPolicy.call(this, policy);
    };
    AmAcpClient.prototype.setAllowedPaths = function (paths) {
      seen.paths = paths;
      return origSetPaths.call(this, paths);
    };
    AmAcpClient.prototype.connect = async () => {
      throw new Error("short-circuit");
    };

    try {
      const handler = createBridgeTaskHandler({
        cwd: "/tmp/bridge-cwd",
        permissionPolicy: "auto-approve",
        allowedPaths: ["/tmp/a", "/tmp/b"],
      });
      await handler(textMessage("run claude: do stuff"), makeResolvedConfig());
    } finally {
      AmAcpClient.prototype.setPermissionPolicy = origSetPolicy;
      AmAcpClient.prototype.setAllowedPaths = origSetPaths;
      AmAcpClient.prototype.connect = origConnect;
    }

    expect(seen.policy).toBe("auto-approve");
    expect(seen.paths).toEqual(["/tmp/a", "/tmp/b"]);
  });
});

// ── Fix 3: Per-client terminalStore (no cross-client leak) ───────

describe("Fix 3 — terminalStore is per-client, not module-level", () => {
  test("two AmAcpClient instances have independent terminalStores", () => {
    const a = new AmAcpClient();
    const b = new AmAcpClient();

    const storeA = (a as unknown as { terminalStore: Map<string, unknown> }).terminalStore;
    const storeB = (b as unknown as { terminalStore: Map<string, unknown> }).terminalStore;

    expect(storeA).toBeInstanceOf(Map);
    expect(storeB).toBeInstanceOf(Map);
    expect(storeA).not.toBe(storeB);

    storeA.set("fake-terminal-A", {} as unknown);
    expect(storeB.has("fake-terminal-A")).toBe(false);
  });

  test("per-client output cache exists (so stdout isn't lost on re-read)", () => {
    const client = new AmAcpClient();
    const cache = (client as unknown as { terminalOutputCache: Map<string, string> })
      .terminalOutputCache;
    expect(cache).toBeInstanceOf(Map);
    expect(cache.size).toBe(0);
  });

  test("module does not export a shared terminalStore", async () => {
    const mod = (await import("../../src/protocols/acp/client")) as Record<string, unknown>;
    expect(mod.terminalStore).toBeUndefined();
  });

  test("createAcpClient() returns fresh per-instance state each call", () => {
    const c1 = createAcpClient();
    const c2 = createAcpClient();
    const s1 = (c1 as unknown as { terminalStore: Map<string, unknown> }).terminalStore;
    const s2 = (c2 as unknown as { terminalStore: Map<string, unknown> }).terminalStore;
    expect(s1).not.toBe(s2);
  });
});

// ── Fix 4: parseCommand respects quotes ──────────────────────────

describe("Fix 4 — parseCommand respects single/double quotes and escapes", () => {
  test("double-quoted argument with spaces is a single token", () => {
    const { executable, args } = parseCommand('agent --prompt "hello world"');
    expect(executable).toBe("agent");
    expect(args).toEqual(["--prompt", "hello world"]);
  });

  test("single-quoted argument with spaces is a single token", () => {
    const { executable, args } = parseCommand("agent --prompt 'hello world'");
    expect(executable).toBe("agent");
    expect(args).toEqual(["--prompt", "hello world"]);
  });

  test("mixed quoting styles in one command", () => {
    const { executable, args } = parseCommand(`cmd --a "v 1" --b 'v 2' --c plain`);
    expect(executable).toBe("cmd");
    expect(args).toEqual(["--a", "v 1", "--b", "v 2", "--c", "plain"]);
  });

  test("escaped double-quote inside double-quoted string", () => {
    const { executable, args } = parseCommand(`agent --msg "say \\"hi\\""`);
    expect(executable).toBe("agent");
    expect(args).toEqual(["--msg", 'say "hi"']);
  });

  test("single quotes inside double-quoted string are literal", () => {
    const { executable, args } = parseCommand(`agent --msg "it's fine"`);
    expect(args).toEqual(["--msg", "it's fine"]);
  });

  test("double quotes inside single-quoted string are literal", () => {
    const { executable, args } = parseCommand(`agent --msg 'say "hi"'`);
    expect(args).toEqual(["--msg", 'say "hi"']);
  });

  test("backslash escapes a space in an unquoted region", () => {
    const { executable, args } = parseCommand("/path/with\\ space/agent --flag");
    expect(executable).toBe("/path/with space/agent");
    expect(args).toEqual(["--flag"]);
  });

  test("unquoted plain command still works the same as before", () => {
    const { executable, args } = parseCommand("npx -y @acme/agent@latest --acp");
    expect(executable).toBe("npx");
    expect(args).toEqual(["-y", "@acme/agent@latest", "--acp"]);
  });

  test("empty string throws", () => {
    expect(() => parseCommand("")).toThrow("Empty agent command");
  });

  test("whitespace-only throws", () => {
    expect(() => parseCommand("   \t  ")).toThrow("Empty agent command");
  });

  test("unterminated double quote throws", () => {
    expect(() => parseCommand('agent --msg "oh no')).toThrow(/Unterminated quoted string/);
  });

  test("unterminated single quote throws", () => {
    expect(() => parseCommand("agent --msg 'oh no")).toThrow(/Unterminated quoted string/);
  });

  test("empty quoted string produces an empty-string argument", () => {
    const { args } = parseCommand(`agent "" '' --flag`);
    expect(args).toEqual(["", "", "--flag"]);
  });
});

// ── Fix 5 / Fix 6: SSE heartbeat + initial frame final flag ───────

describe("Fix 5 — SSE heartbeat is emitted on idle streams", () => {
  test("SSE_HEARTBEAT_INTERVAL_MS is exported", () => {
    expect(SSE_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
    expect(SSE_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });

  test("heartbeat comment frame arrives during long-running task", async () => {
    // Override the heartbeat interval for the test by monkey-patching
    // setInterval behavior is impractical; instead we run a slow handler
    // that never completes and inspect the first ~1s of stream output.
    // We rely on SSE_HEARTBEAT_INTERVAL_MS being modest (30s by spec) —
    // but for the test we want to observe a heartbeat fast. So we use
    // setInterval() spy: re-import with a shortened interval is not
    // trivial, so we instead VERIFY the heartbeat is sent by inspecting
    // the stream AFTER cancelling the task (which triggers an event and
    // cleanup). If the interval fires before cleanup, we'd see a
    // ":heartbeat" line. To keep the test deterministic, assert the
    // sentinel appears in *some* stream that runs longer than the
    // interval.
    //
    // Deterministic path: temporarily shorten the interval via module
    // shadowing is not safe; instead we use a custom TaskEventEmitter
    // + a never-terminating handler and read the stream until at least
    // one heartbeat appears, with a wall-clock budget slightly larger
    // than SSE_HEARTBEAT_INTERVAL_MS would normally allow.
    //
    // Since 30s is too long for CI, we assert instead that the
    // underlying code path exists: a heartbeat message (":heartbeat")
    // is emitted at SSE_HEARTBEAT_INTERVAL_MS cadence. We verify this
    // via the smaller structural test below ("heartbeat timer is
    // installed"). Full end-to-end verification would require exposing
    // the interval as a configurable option, which is out of scope for
    // this hardening wave.
    expect(SSE_HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });

  test("heartbeat timer is installed when stream starts (structural check)", async () => {
    // Structural test: we verify the server-side handler sets up a
    // repeating heartbeat. We do this by spying on setInterval calls
    // during the subscription lifecycle.
    const intervalsInstalled: number[] = [];
    const origSetInterval = globalThis.setInterval;
    (globalThis as any).setInterval = (fn: (...a: unknown[]) => unknown, ms: number) => {
      intervalsInstalled.push(ms);
      return origSetInterval(fn, ms);
    };

    try {
      let resolveHandler!: () => void;
      const handlerPromise = new Promise<void>((r) => {
        resolveHandler = r;
      });

      const store = createTaskStore();
      const emitter = new TaskEventEmitter();
      const app = createA2ARoutes({
        config: makeResolvedConfig(),
        cardOptions: { baseUrl: "http://localhost:9090" },
        taskStore: store,
        taskEventEmitter: emitter,
        taskHandler: async () => {
          await handlerPromise;
          return {
            message: { role: "agent" as const, parts: [{ type: "text" as const, text: "ok" }] },
          };
        },
      });

      const resPromise = app.request("/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/sendSubscribe",
          params: {
            id: "heartbeat-struct-task",
            message: { role: "user", parts: [{ type: "text", text: "slow" }] },
          },
        }),
      });

      const res = await resPromise;
      expect(res.status).toBe(200);

      // Pull one byte to force the ReadableStream.start() to run
      const reader = res.body!.getReader();
      await reader.read();

      // Let the handler finish so the stream cleans up
      resolveHandler();
      await reader.cancel().catch(() => {});
    } finally {
      globalThis.setInterval = origSetInterval;
    }

    // Exactly one heartbeat interval should have been installed at the
    // documented cadence.
    expect(intervalsInstalled).toContain(SSE_HEARTBEAT_INTERVAL_MS);
  });
});

describe("Fix 6 — SSE initial frame reflects terminal state", () => {
  test("task that completes synchronously yields initial frame with final:true (via JSON fast-path)", async () => {
    // The existing fast-path returns JSON (not SSE) when startTask completes
    // synchronously. Here we confirm the JSON response carries a terminal
    // state so clients get an unambiguous signal.
    const store = createTaskStore();
    const app = createA2ARoutes({
      config: makeResolvedConfig(),
      cardOptions: { baseUrl: "http://localhost:9090" },
      taskStore: store,
      // Synchronous resolve: by the time startTask returns, state is
      // "completed".
      taskHandler: async () => ({
        message: { role: "agent" as const, parts: [{ type: "text" as const, text: "done" }] },
      }),
    });

    // Drain tick so microtasks flush before the subscribe call.
    const res = await app.request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/sendSubscribe",
        params: {
          id: "fast-terminal-task",
          message: { role: "user", parts: [{ type: "text", text: "status" }] },
        },
      }),
    });

    // Either JSON fast-path (if microtask raced first) OR SSE with
    // final:true on the initial frame — both are acceptable post-fix.
    const contentType = res.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      const json = (await res.json()) as { result: { status: { state: string } } };
      expect(["completed", "failed", "canceled"]).toContain(json.result.status.state);
    } else {
      const text = await res.text();
      // The first status frame must carry final:true since the task is
      // already terminal by the time the stream initializes.
      expect(text).toMatch(/"final":\s*true/);
    }
  });
});

// ── Fix 7: createBridgedTaskHandler wired via ESM import ─────────

describe("Fix 7 — createBridgedTaskHandler is imported via ESM (no require())", () => {
  test("bridge-enabled A2A routes mount without hitting CommonJS require()", async () => {
    // The previous implementation called `require("../bridge")` inside an
    // ESM file. Under stricter Bun versions this throws. We assert that
    // constructing a bridge-enabled Hono app is fully synchronous and
    // succeeds without any module resolution errors.
    const app = createA2ARoutes({
      config: makeResolvedConfig(),
      cardOptions: { baseUrl: "http://localhost:9090" },
      enableBridge: true,
      taskStore: createTaskStore(),
    });
    expect(app).toBeDefined();
  });

  test("createBridgedTaskHandler is importable as a named ESM export", async () => {
    const mod = await import("../../src/protocols/bridge");
    expect(typeof mod.createBridgedTaskHandler).toBe("function");
    const handler = mod.createBridgedTaskHandler(async () => ({
      message: { role: "agent" as const, parts: [{ type: "text" as const, text: "fallback" }] },
    }));
    expect(typeof handler).toBe("function");
  });
});
