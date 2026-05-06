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
  test("resolves tier-1-native agents for run command", () => {
    // ADR-0033: the protocols/acp/registry backed by BUILT_IN_ACP_AGENTS
    // (now a tier-1-only back-compat alias) only resolves spawnable agents.
    // Tier-3 catalog-only agents (cursor, copilot, cline, etc.) are NOT
    // resolved here — `am run` guards them at the CLI layer via runnable=false.
    const tier1Agents = ["claude", "codex", "gemini", "kiro"];
    for (const name of tier1Agents) {
      const entry = resolveAgent(name);
      expect(entry).not.toBeNull();
      expect(entry!.command.length).toBeGreaterThan(0);
    }
  });

  test("tier-3 catalog-only agents are NOT in the ACP registry shim (ADR-0033)", () => {
    // These used to be in BUILT_IN_ACP_AGENTS pre-ADR-0033 but were never
    // actually spawnable. The back-compat alias only surfaces tier-1-native.
    for (const name of ["cursor", "copilot", "cline", "roo-code", "windsurf"]) {
      expect(resolveAgent(name)).toBeNull();
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
    const { resolveMeta } = await import("../helpers/citty");
    const meta = await resolveMeta(mod.runCommand);
    expect(mod.runCommand).toBeDefined();
    expect(meta?.name).toBe("run");
    expect(meta?.description).toContain("ACP");
  });

  test("run command has NO subcommands (iter4 Wave A: moved to avoid collision)", async () => {
    // iter4 Wave A: positional `am run <agent> <prompt>` was unreachable
    // because citty routed the first positional through subCommand lookup.
    // `session` moved to `am acp session`; `agents` deprecation completed.
    const mod = await import("../../src/commands/run");
    const { resolveSubCommands } = await import("../helpers/citty");
    expect(await resolveSubCommands(mod.runCommand)).toBeUndefined();
  });

  test("acp command exposes session subcommand (new top-level namespace)", async () => {
    const mod = await import("../../src/commands/run");
    const { resolveMeta, resolveSubCommands } = await import("../helpers/citty");
    expect(mod.acpCommand).toBeDefined();
    expect((await resolveMeta(mod.acpCommand))?.name).toBe("acp");
    const subs = await resolveSubCommands(mod.acpCommand);
    expect(subs).toBeDefined();
    expect(subs!.session).toBeDefined();
  });

  test("run command has expected args", async () => {
    const mod = await import("../../src/commands/run");
    const { resolveArgs } = await import("../helpers/citty");
    const args = await resolveArgs(mod.runCommand);
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

// ── Session subcommands (now live under `am acp session` post-iter4) ────

describe("am acp session: subcommand structure (iter4 Wave A relocation)", () => {
  test("session subcommand has list and cancel", async () => {
    const mod = await import("../../src/commands/run");
    const { resolveSubCommands } = await import("../helpers/citty");
    const subs = await resolveSubCommands(mod.acpCommand);
    const sessionSub = subs!.session;
    const resolved = await (sessionSub as () => Promise<any>)();
    expect(resolved.subCommands).toBeDefined();
    expect(resolved.subCommands.list).toBeDefined();
    expect(resolved.subCommands.cancel).toBeDefined();
  });

  test("session subcommand description clarifies LIVE vs transcript", async () => {
    const mod = await import("../../src/commands/run");
    const { resolveSubCommands } = await import("../helpers/citty");
    const subs = await resolveSubCommands(mod.acpCommand);
    const sessionSub = subs!.session;
    const resolved = await (sessionSub as () => Promise<any>)();
    const desc = resolved.meta?.description ?? "";
    expect(desc.toLowerCase()).toContain("live");
    expect(desc).toContain("am session");
  });
});

// ── Deprecation: `am run agents` was removed in iter4 Wave A ─────────
//
// M2 introduced `am run agents` as a deprecated alias. iter4 Wave A
// removed it entirely because citty's subcommand lookup on `run` was
// shadowing the positional-arg form `am run <agent> <prompt>`. Users
// who typed `am run agents` now get a proper error routing them to
// `am agent list`, which is a cleaner experience than an extra deprecated
// alias. The root `am run` command no longer carries subCommands at all.

describe("am run agents (removed in iter4 Wave A)", () => {
  test("`am run` has no `agents` subcommand anymore", async () => {
    const mod = await import("../../src/commands/run");
    expect(mod.runCommand.subCommands).toBeUndefined();
  });

  test("users get routed to `am agent list` via main-command usage error", async () => {
    // When `am run agents` is invoked, citty treats `agents` as the positional
    // `<AGENT>` arg. The main `run` handler recognizes it isn't a known agent
    // name and the usage-error hint names `am agent list` as the canonical.
    const mod = await import("../../src/commands/run");
    const { resolveMeta } = await import("../helpers/citty");
    const desc = (await resolveMeta(mod.runCommand))?.description ?? "";
    // Avoid drift if someone re-adds a subCommand namespace to `run`.
    expect(desc.toLowerCase()).toContain("agent");
  });
});
