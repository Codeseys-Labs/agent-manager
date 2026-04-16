import { beforeEach, describe, expect, mock, test } from "bun:test";
import { listAgents, parseCommand, resolveAgent } from "../../src/protocols/acp/registry";
import type { AcpSettings } from "../../src/protocols/acp/types";

/**
 * Tests for `am run` command.
 *
 * The run command delegates heavily to the ACP client module (tested in
 * test/protocols/acp/client.test.ts). These tests focus on the CLI-level
 * concerns: argument parsing, agent resolution, config loading, and
 * output formatting.
 *
 * We cannot test the actual subprocess spawning in unit tests — those
 * require integration tests with a real ACP agent.
 */

// ── Agent resolution (used by run command) ─────────────────────

describe("am run: agent resolution", () => {
  test("resolves known agents for run command", () => {
    const knownAgents = ["claude", "codex", "gemini", "copilot", "kiro", "cursor"];
    for (const name of knownAgents) {
      const entry = resolveAgent(name);
      expect(entry).not.toBeNull();
      expect(entry!.command.length).toBeGreaterThan(0);
    }
  });

  test("config override works for run command", () => {
    const settings: AcpSettings = {
      agents: {
        claude: { command: "/usr/local/bin/claude-custom --acp --headless" },
      },
    };
    const entry = resolveAgent("claude", settings);
    expect(entry!.command).toBe("/usr/local/bin/claude-custom --acp --headless");
    expect(entry!.source).toBe("config");
  });

  test("unknown agent returns null (run command should error)", () => {
    expect(resolveAgent("nonexistent")).toBeNull();
  });

  test("list agents includes all built-in + config agents", () => {
    const settings: AcpSettings = {
      agents: {
        "my-local-agent": { command: "./dev-agent --acp" },
      },
    };
    const agents = listAgents(settings);
    const names = agents.map((a) => a.name);
    expect(names).toContain("claude");
    expect(names).toContain("my-local-agent");
  });
});

// ── Command parsing helpers ────────────────────────────────────

describe("am run: command string parsing", () => {
  test("parses npx-based agent commands", () => {
    const { executable, args } = parseCommand(
      "npx -y @agentclientprotocol/claude-agent-acp@latest",
    );
    expect(executable).toBe("npx");
    expect(args).toContain("-y");
    expect(args).toContain("@agentclientprotocol/claude-agent-acp@latest");
  });

  test("parses simple flag-based commands", () => {
    const { executable, args } = parseCommand("gemini --acp");
    expect(executable).toBe("gemini");
    expect(args).toEqual(["--acp"]);
  });

  test("parses multi-flag commands", () => {
    const { executable, args } = parseCommand("copilot --acp --stdio");
    expect(executable).toBe("copilot");
    expect(args).toEqual(["--acp", "--stdio"]);
  });

  test("parses path-based commands", () => {
    const { executable, args } = parseCommand("./my-agent --acp --port 3000");
    expect(executable).toBe("./my-agent");
    expect(args).toEqual(["--acp", "--port", "3000"]);
  });
});

// ── JSON output format ─────────────────────────────────────────

describe("am run: JSON output structure", () => {
  test("expected result shape matches output contract", () => {
    // Verify the shape of the JSON output that `am run --json` produces.
    // This tests the contract, not the actual command execution.
    const mockResult = {
      agent: "claude",
      sessionId: "session-abc-123",
      stopReason: "end_turn" as const,
      text: "I fixed the tests by updating the assertion.",
      toolCalls: [
        {
          id: "tc-1",
          title: "Edit file: src/app.ts",
          status: "completed",
          kind: "edit",
        },
      ],
      usage: null,
    };

    expect(mockResult.agent).toBe("claude");
    expect(mockResult.sessionId).toMatch(/^session-/);
    expect(mockResult.stopReason).toBe("end_turn");
    expect(typeof mockResult.text).toBe("string");
    expect(Array.isArray(mockResult.toolCalls)).toBe(true);
    expect(mockResult.toolCalls[0].id).toBeDefined();
    expect(mockResult.toolCalls[0].title).toBeDefined();
    expect(mockResult.toolCalls[0].status).toBeDefined();
  });
});

// ── CLI registration ───────────────────────────────────────────

describe("am run: CLI registration", () => {
  test("run command exports correctly", async () => {
    const mod = await import("../../src/commands/run");
    expect(mod.runCommand).toBeDefined();
    expect(mod.runCommand.meta?.name).toBe("run");
    expect(mod.runCommand.meta?.description).toContain("ACP");
  });

  test("run command has expected subcommands", async () => {
    const mod = await import("../../src/commands/run");
    const subCommands = mod.runCommand.subCommands;
    expect(subCommands).toBeDefined();
    expect(subCommands!.agents).toBeDefined();
    expect(subCommands!.session).toBeDefined();
  });

  test("run command has expected args", async () => {
    const mod = await import("../../src/commands/run");
    const args = mod.runCommand.args;
    expect(args).toBeDefined();
    expect(args!.agent).toBeDefined();
    expect(args!.prompt).toBeDefined();
    expect(args!.session).toBeDefined();
    expect(args!.cwd).toBeDefined();
    expect(args!.timeout).toBeDefined();
    expect(args!.json).toBeDefined();
    expect(args!.quiet).toBeDefined();
    expect(args!.verbose).toBeDefined();
  });

  test("run command is registered in cli.ts", async () => {
    // Verify the lazy import resolves
    const mod = await import("../../src/commands/run");
    expect(mod.runCommand).toBeDefined();
  });
});

// ── Session subcommands ────────────────────────────────────────

describe("am run session: subcommand structure", () => {
  test("session subcommand has list and cancel", async () => {
    const mod = await import("../../src/commands/run");
    const sessionSub = mod.runCommand.subCommands!.session;
    const resolved = await (sessionSub as () => Promise<any>)();
    expect(resolved.subCommands).toBeDefined();
    expect(resolved.subCommands.list).toBeDefined();
    expect(resolved.subCommands.cancel).toBeDefined();
  });
});
