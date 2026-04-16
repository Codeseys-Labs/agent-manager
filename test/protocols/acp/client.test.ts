import { beforeEach, describe, expect, mock, test } from "bun:test";
import { AcpClientError, AmAcpClient, createAcpClient } from "../../../src/protocols/acp/client";
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

  describe("listAgents", () => {
    test("lists all built-in agents", () => {
      const agents = listAgents();
      expect(agents.length).toBeGreaterThan(10);
      const names = agents.map((a) => a.name);
      expect(names).toContain("claude");
      expect(names).toContain("codex");
      expect(names).toContain("gemini");
      expect(names).toContain("copilot");
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
  });

  describe("onSessionUpdate", () => {
    test("registers update handler", () => {
      const client = new AmAcpClient();
      const handler = mock(() => {});
      client.onSessionUpdate(handler);
      // Handler is stored, will be called when updates arrive
      expect(handler).not.toHaveBeenCalled();
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
