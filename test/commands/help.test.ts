import { describe, it, expect } from "bun:test";
import { COMMAND_GROUPS, renderGroupedHelp } from "../../src/help";

describe("grouped help output (ADR-0029)", () => {
  describe("COMMAND_GROUPS", () => {
    it("contains all registered subcommands (excluding hidden aliases)", () => {
      // Every command that appears in cli.ts subCommands should be in a group,
      // except hidden aliases like "agents" (alias for "agent").
      const groupedNames = new Set(
        COMMAND_GROUPS.flatMap((g) => g.commands.map(([name]) => name)),
      );
      const registeredCommands = [
        "init", "add", "list", "use", "apply", "status", "config", "profile",
        "doctor", "import", "push", "pull", "undo", "log", "secret", "version",
        "adapter", "mcp-serve", "serve", "tui", "session", "search", "install",
        "uninstall", "update", "wiki", "agent", "run", "completion", "marketplace",
      ];
      for (const cmd of registeredCommands) {
        expect(groupedNames.has(cmd)).toBe(true);
      }
    });

    it("has no duplicate command names across groups", () => {
      const seen = new Set<string>();
      for (const group of COMMAND_GROUPS) {
        for (const [name] of group.commands) {
          expect(seen.has(name)).toBe(false);
          seen.add(name);
        }
      }
    });

    it("has 8 groups", () => {
      expect(COMMAND_GROUPS).toHaveLength(8);
    });
  });

  describe("renderGroupedHelp", () => {
    const output = renderGroupedHelp("1.2.3");

    it("includes the version", () => {
      expect(output).toContain("v1.2.3");
    });

    it("includes the tagline", () => {
      expect(output).toContain("chezmoi for AI agent configs");
    });

    it("renders all group headings", () => {
      for (const group of COMMAND_GROUPS) {
        expect(output).toContain(`${group.heading}:`);
      }
    });

    it("renders all commands with descriptions", () => {
      for (const group of COMMAND_GROUPS) {
        for (const [name, desc] of group.commands) {
          expect(output).toContain(name);
          expect(output).toContain(desc);
        }
      }
    });

    it("includes global flags section", () => {
      expect(output).toContain("Global flags:");
      expect(output).toContain("--profile");
      expect(output).toContain("--json");
      expect(output).toContain("--verbose");
      expect(output).toContain("--quiet");
    });

    it("includes usage hint for subcommand help", () => {
      expect(output).toContain("am <command> --help");
    });

    it("groups are ordered: Config, Git, Registry, Marketplace, Agent, Knowledge, Tool, Interface", () => {
      const headings = COMMAND_GROUPS.map((g) => g.heading);
      expect(headings).toEqual([
        "Config commands",
        "Git commands",
        "Registry commands",
        "Marketplace commands",
        "Agent commands",
        "Knowledge commands",
        "Tool commands",
        "Interface commands",
      ]);
    });
  });
});
