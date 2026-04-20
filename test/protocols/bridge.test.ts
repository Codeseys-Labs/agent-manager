import { afterAll, beforeAll, describe, expect, it, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import type { ResolvedConfig } from "../../src/adapters/types";
import {
  type A2AServerOptions,
  createA2ARoutes,
  createTaskStore,
  defaultTaskHandler,
  getAppTaskStore,
} from "../../src/protocols/a2a/server";
import type { Message } from "../../src/protocols/a2a/types";
import {
  type BridgeRequest,
  createBridgeTaskHandler,
  createBridgedTaskHandler,
  isValidAgentName,
  parseBridgeRequest,
} from "../../src/protocols/bridge";

// ── Helpers ─────────────────────────────────────────────────────

function makeResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    servers: {},
    instructions: {},
    skills: {},
    agents: {},
    profile: "default",
    adapters: {},
    ...overrides,
  };
}

function makeMessage(parts: Message["parts"]): Message {
  return { role: "user", parts };
}

function textMessage(text: string): Message {
  return makeMessage([{ type: "text", text }]);
}

function dataMessage(data: Record<string, unknown>): Message {
  return makeMessage([{ type: "data", data }]);
}

function jsonRpcRequest(app: ReturnType<typeof createA2ARoutes>, body: unknown) {
  return app.request("/a2a", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForTask(
  store: ReturnType<typeof createTaskStore>,
  taskId: string,
  timeoutMs = 5000,
): Promise<void> {
  const terminal = new Set(["completed", "failed", "canceled"]);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = store.get(taskId);
    if (task && terminal.has(task.status.state)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

// ── Setup ──────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "am-bridge-test-"));
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
  process.env.AM_CONFIG_DIR = undefined;
  await rm(tmpDir, { recursive: true, force: true });
});

// ── parseBridgeRequest ─────────────────────────────────────────

describe("parseBridgeRequest", () => {
  test('parses "run claude: fix tests" -> agent=claude, prompt="fix tests"', () => {
    const result = parseBridgeRequest(textMessage("run claude: fix tests"));
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("claude");
    expect(result!.prompt).toBe("fix tests");
  });

  test('parses "run codex: add error handling" with extra spaces', () => {
    const result = parseBridgeRequest(textMessage("run codex:   add error handling  "));
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("codex");
    expect(result!.prompt).toBe("add error handling");
  });

  test("parses case-insensitively", () => {
    const result = parseBridgeRequest(textMessage("RUN gemini: analyze code"));
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("gemini");
    expect(result!.prompt).toBe("analyze code");
  });

  test("parses data part {agent, prompt}", () => {
    const result = parseBridgeRequest(dataMessage({ agent: "claude", prompt: "fix tests" }));
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("claude");
    expect(result!.prompt).toBe("fix tests");
  });

  test("prefers data part over text part", () => {
    const msg = makeMessage([
      { type: "text", text: "run codex: do something" },
      { type: "data", data: { agent: "claude", prompt: "fix tests" } },
    ]);
    const result = parseBridgeRequest(msg);
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("claude"); // data part wins
  });

  test("returns null for non-matching text", () => {
    const result = parseBridgeRequest(textMessage("status"));
    expect(result).toBeNull();
  });

  test("returns null for data part missing agent field", () => {
    const result = parseBridgeRequest(dataMessage({ prompt: "fix tests" }));
    expect(result).toBeNull();
  });

  test("returns null for data part missing prompt field", () => {
    const result = parseBridgeRequest(dataMessage({ agent: "claude" }));
    expect(result).toBeNull();
  });

  test("returns null for empty message", () => {
    const result = parseBridgeRequest(makeMessage([]));
    expect(result).toBeNull();
  });

  test("returns null for text without colon separator", () => {
    const result = parseBridgeRequest(textMessage("run claude fix tests"));
    expect(result).toBeNull();
  });

  // ── CRITICAL-1: Agent name sanitization ──────────────────────

  test("rejects path traversal in agent name (text part)", () => {
    const result = parseBridgeRequest(textMessage("run ../../../etc/passwd: test"));
    expect(result).toBeNull();
  });

  test("rejects path traversal in agent name (data part)", () => {
    const result = parseBridgeRequest(
      dataMessage({ agent: "../../../etc/passwd", prompt: "test" }),
    );
    expect(result).toBeNull();
  });

  test("rejects shell metacharacters in agent name", () => {
    const result = parseBridgeRequest(textMessage("run agent;rm -rf /: test"));
    expect(result).toBeNull();
  });

  test("rejects agent name with spaces", () => {
    const result = parseBridgeRequest(dataMessage({ agent: "agent name", prompt: "test" }));
    expect(result).toBeNull();
  });

  test("rejects agent name with null bytes", () => {
    const result = parseBridgeRequest(dataMessage({ agent: "agent\x00evil", prompt: "test" }));
    expect(result).toBeNull();
  });

  test("rejects agent name longer than 64 characters", () => {
    const longName = "a".repeat(65);
    const result = parseBridgeRequest(dataMessage({ agent: longName, prompt: "test" }));
    expect(result).toBeNull();
  });

  test("accepts agent name at exactly 64 characters", () => {
    const name64 = "a".repeat(64);
    const result = parseBridgeRequest(dataMessage({ agent: name64, prompt: "test" }));
    expect(result).not.toBeNull();
    expect(result!.agent).toBe(name64);
  });

  test("accepts valid agent names with hyphens and underscores", () => {
    const result = parseBridgeRequest(textMessage("run my-custom_agent-2: test"));
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("my-custom_agent-2");
  });

  test("rejects agent name with dots", () => {
    const result = parseBridgeRequest(textMessage("run agent.evil: test"));
    expect(result).toBeNull();
  });

  test("rejects agent name with forward slashes", () => {
    const result = parseBridgeRequest(dataMessage({ agent: "usr/bin/env", prompt: "id" }));
    expect(result).toBeNull();
  });
});

// ── isValidAgentName (direct unit tests) ──────────────────────

describe("isValidAgentName", () => {
  test("accepts simple lowercase names", () => {
    expect(isValidAgentName("claude")).toBe(true);
  });

  test("accepts names with hyphens and underscores", () => {
    expect(isValidAgentName("my-custom_agent-2")).toBe(true);
  });

  test("accepts uppercase names", () => {
    expect(isValidAgentName("MyAgent")).toBe(true);
  });

  test("accepts single character name", () => {
    expect(isValidAgentName("a")).toBe(true);
  });

  test("accepts 64-character name (max length)", () => {
    expect(isValidAgentName("a".repeat(64))).toBe(true);
  });

  test("rejects 65-character name (exceeds max)", () => {
    expect(isValidAgentName("a".repeat(65))).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidAgentName("")).toBe(false);
  });

  test("rejects dots", () => {
    expect(isValidAgentName("agent.evil")).toBe(false);
  });

  test("rejects forward slashes", () => {
    expect(isValidAgentName("usr/bin/env")).toBe(false);
  });

  test("rejects backslashes", () => {
    expect(isValidAgentName("agent\\evil")).toBe(false);
  });

  test("rejects spaces", () => {
    expect(isValidAgentName("agent name")).toBe(false);
  });

  test("rejects semicolons", () => {
    expect(isValidAgentName("agent;rm")).toBe(false);
  });

  test("rejects pipe characters", () => {
    expect(isValidAgentName("agent|curl")).toBe(false);
  });

  test("rejects backticks", () => {
    expect(isValidAgentName("agent`whoami`")).toBe(false);
  });

  test("rejects dollar signs", () => {
    expect(isValidAgentName("agent$HOME")).toBe(false);
  });

  test("rejects null bytes", () => {
    expect(isValidAgentName("agent\x00evil")).toBe(false);
  });
});

// ── createBridgeTaskHandler ────────────────────────────────────

describe("createBridgeTaskHandler", () => {
  test("returns error when agent is not in ACP registry", async () => {
    const handler = createBridgeTaskHandler();
    const config = makeResolvedConfig();
    const msg = textMessage("run nonexistent-agent: do stuff");

    const result = await handler(msg, config);

    expect(result.message.role).toBe("agent");
    const textPart = result.message.parts.find((p) => p.type === "text");
    expect(textPart).toBeDefined();
    expect((textPart as { text: string }).text).toContain("not available locally");
    expect((textPart as { text: string }).text).toContain("nonexistent-agent");
  });

  test("returns guidance when message doesn't match bridge pattern", async () => {
    const handler = createBridgeTaskHandler();
    const config = makeResolvedConfig();
    const msg = textMessage("just a regular message");

    const result = await handler(msg, config);

    expect(result.message.role).toBe("agent");
    const textPart = result.message.parts.find((p) => p.type === "text");
    expect(textPart).toBeDefined();
    expect((textPart as { text: string }).text).toContain("does not match bridge pattern");
  });

  test(
    "returns error when ACP connect fails (agent binary not found)",
    async () => {
      // "claude" is in the built-in ACP registry but the binary won't be
      // installed. The bridge's ACP client has its own internal initTimeout
      // (~10s default). We pass a shorter timeout here AND give the Bun test
      // itself a generous cap so the bridge's SIGTERM+exit cycle has room
      // without racing the default 5s test timeout.
      const handler = createBridgeTaskHandler({ timeout: 3000 });
      const config = makeResolvedConfig();
      const msg = textMessage("run claude: fix tests");

      const result = await handler(msg, config);

      // Should fail because the ACP agent binary is not actually installed
      expect(result.message.role).toBe("agent");
      const textPart = result.message.parts.find((p) => p.type === "text");
      expect(textPart).toBeDefined();
      expect((textPart as { text: string }).text).toContain("failed to execute");
    },
    20_000,
  );
});

// ── createBridgedTaskHandler (composite) ──────────────────────

describe("createBridgedTaskHandler", () => {
  test("routes bridge pattern to bridge handler, not default handler", async () => {
    const defaultCalled: string[] = [];
    const mockDefault = async (msg: Message, _config: ResolvedConfig) => {
      const textPart = msg.parts.find((p) => p.type === "text") as { text: string } | undefined;
      defaultCalled.push(textPart?.text ?? "");
      return {
        message: {
          role: "agent" as const,
          parts: [{ type: "text" as const, text: "default handler response" }],
        },
      };
    };

    const handler = createBridgedTaskHandler(mockDefault);
    const config = makeResolvedConfig();

    // Bridge pattern — should NOT call default handler
    const bridgeResult = await handler(textMessage("run nonexistent: test"), config);
    expect(defaultCalled).toHaveLength(0);
    const textPart = bridgeResult.message.parts.find((p) => p.type === "text");
    expect((textPart as { text: string }).text).toContain("not available locally");
  });

  test("falls through to default handler for non-bridge messages", async () => {
    const defaultCalled: string[] = [];
    const mockDefault = async (msg: Message, _config: ResolvedConfig) => {
      const textPart = msg.parts.find((p) => p.type === "text") as { text: string } | undefined;
      defaultCalled.push(textPart?.text ?? "");
      return {
        message: {
          role: "agent" as const,
          parts: [{ type: "text" as const, text: "default handler response" }],
        },
      };
    };

    const handler = createBridgedTaskHandler(mockDefault);
    const config = makeResolvedConfig();

    // Non-bridge message — should call default handler
    const result = await handler(textMessage("status"), config);
    expect(defaultCalled).toHaveLength(1);
    expect(defaultCalled[0]).toBe("status");
    const textPart = result.message.parts.find((p) => p.type === "text");
    expect((textPart as { text: string }).text).toBe("default handler response");
  });
});

// ── A2A server with bridge enabled ─────────────────────────────

describe("A2A server with enableBridge", () => {
  test("bridge-enabled server routes 'run <agent>: ...' to bridge handler", async () => {
    const store = createTaskStore();
    const config = makeResolvedConfig();
    const app = createA2ARoutes({
      config,
      cardOptions: { baseUrl: "http://localhost:9090" },
      enableBridge: true,
      taskStore: store,
    });

    const res = await jsonRpcRequest(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/send",
      params: {
        id: "bridge-task-001",
        message: {
          role: "user",
          parts: [{ type: "text", text: "run nonexistent-agent: do something" }],
        },
      },
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      result: { id: string; status: { state: string } };
    };
    expect(data.result.id).toBe("bridge-task-001");
    expect(data.result.status.state).toBe("working");

    // Wait for handler to complete
    await waitForTask(store, "bridge-task-001");

    const task = store.get("bridge-task-001");
    expect(task).toBeDefined();
    expect(task!.status.state).toBe("completed");

    // The response should mention the agent is not available locally
    const agentMsg = task!.status.message;
    expect(agentMsg).toBeDefined();
    const textPart = agentMsg!.parts.find((p) => p.type === "text");
    expect((textPart as { text: string }).text).toContain("not available locally");
  });

  test("bridge-enabled server falls through to default for non-bridge messages", async () => {
    const store = createTaskStore();
    const config = makeResolvedConfig();
    const app = createA2ARoutes({
      config,
      cardOptions: { baseUrl: "http://localhost:9090" },
      enableBridge: true,
      taskStore: store,
    });

    const res = await jsonRpcRequest(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/send",
      params: {
        id: "bridge-fallthrough-001",
        message: {
          role: "user",
          parts: [{ type: "text", text: "status" }],
        },
      },
    });

    expect(res.status).toBe(200);

    await waitForTask(store, "bridge-fallthrough-001");

    const task = store.get("bridge-fallthrough-001");
    expect(task).toBeDefined();
    expect(task!.status.state).toBe("completed");

    // Should get the default handler's "status" response
    const agentMsg = task!.status.message;
    expect(agentMsg).toBeDefined();
    const textPart = agentMsg!.parts.find((p) => p.type === "text");
    expect((textPart as { text: string }).text).toContain("agent-manager status");
  });

  test("bridge-disabled server does not intercept run messages", async () => {
    const store = createTaskStore();
    const config = makeResolvedConfig();
    const app = createA2ARoutes({
      config,
      cardOptions: { baseUrl: "http://localhost:9090" },
      enableBridge: false, // explicitly disabled
      taskStore: store,
    });

    const res = await jsonRpcRequest(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/send",
      params: {
        id: "no-bridge-001",
        message: {
          role: "user",
          parts: [{ type: "text", text: "run claude: fix tests" }],
        },
      },
    });

    expect(res.status).toBe(200);

    await waitForTask(store, "no-bridge-001");

    const task = store.get("no-bridge-001");
    expect(task).toBeDefined();
    expect(task!.status.state).toBe("completed");

    // Default handler treats "run claude: fix tests" as an unrecognized command
    const agentMsg = task!.status.message;
    expect(agentMsg).toBeDefined();
    const textPart = agentMsg!.parts.find((p) => p.type === "text");
    expect((textPart as { text: string }).text).toContain("Unrecognized command");
  });

  test("bridge routes data part {agent, prompt} correctly", async () => {
    const store = createTaskStore();
    const config = makeResolvedConfig();
    const app = createA2ARoutes({
      config,
      cardOptions: { baseUrl: "http://localhost:9090" },
      enableBridge: true,
      taskStore: store,
    });

    const res = await jsonRpcRequest(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/send",
      params: {
        id: "bridge-data-001",
        message: {
          role: "user",
          parts: [{ type: "data", data: { agent: "nonexistent", prompt: "do stuff" } }],
        },
      },
    });

    expect(res.status).toBe(200);

    await waitForTask(store, "bridge-data-001");

    const task = store.get("bridge-data-001");
    expect(task!.status.state).toBe("completed");
    const textPart = task!.status.message!.parts.find((p) => p.type === "text");
    expect((textPart as { text: string }).text).toContain("not available locally");
  });
});
