import { describe, expect, it } from "bun:test";
import {
  SUBCOMMANDS,
  TOP_LEVEL_COMMANDS,
  generateBashCompletion,
  generateFishCompletion,
  generateZshCompletion,
} from "../../src/commands/completion";

describe("am completion", () => {
  describe("TOP_LEVEL_COMMANDS", () => {
    const expected = [
      "init",
      "add",
      "list",
      "use",
      "apply",
      "status",
      "config",
      "profile",
      "push",
      "pull",
      "undo",
      "log",
      "search",
      "install",
      "uninstall",
      "update",
      "agent",
      "run",
      "wiki",
      "import",
      "adapter",
      "doctor",
      "secret",
      "session",
      "version",
      "mcp-serve",
      "tui",
      "serve",
      "flow",
      "marketplace",
      "completion",
      "init-project",
    ] as const;

    for (const cmd of expected) {
      it(`includes ${cmd}`, () => {
        expect(TOP_LEVEL_COMMANDS).toContain(cmd);
      });
    }
  });

  describe("SUBCOMMANDS", () => {
    it("has agent subcommands", () => {
      expect(SUBCOMMANDS.agent).toContain("list");
      expect(SUBCOMMANDS.agent).toContain("add");
      expect(SUBCOMMANDS.agent).toContain("remove");
      expect(SUBCOMMANDS.agent).toContain("ping");
      expect(SUBCOMMANDS.agent).toContain("delegate");
      expect(SUBCOMMANDS.agent).toContain("cancel");
    });

    it("has wiki subcommands", () => {
      expect(SUBCOMMANDS.wiki).toContain("search");
      expect(SUBCOMMANDS.wiki).toContain("add");
      expect(SUBCOMMANDS.wiki).toContain("show");
      expect(SUBCOMMANDS.wiki).toContain("delete");
      expect(SUBCOMMANDS.wiki).toContain("harvest");
      expect(SUBCOMMANDS.wiki).toContain("ingest");
      expect(SUBCOMMANDS.wiki).toContain("lint");
      expect(SUBCOMMANDS.wiki).toContain("graph");
      expect(SUBCOMMANDS.wiki).toContain("synthesize");
      expect(SUBCOMMANDS.wiki).toContain("briefing");
      expect(SUBCOMMANDS.wiki).toContain("export");
      expect(SUBCOMMANDS.wiki).toContain("import");
    });

    it("has config subcommands", () => {
      expect(SUBCOMMANDS.config).toContain("validate");
      expect(SUBCOMMANDS.config).toContain("show");
    });

    it("has profile subcommands", () => {
      expect(SUBCOMMANDS.profile).toContain("list");
      expect(SUBCOMMANDS.profile).toContain("show");
      expect(SUBCOMMANDS.profile).toContain("create");
      expect(SUBCOMMANDS.profile).toContain("delete");
    });

    it("has secret subcommands", () => {
      expect(SUBCOMMANDS.secret).toContain("set");
      expect(SUBCOMMANDS.secret).toContain("get");
      expect(SUBCOMMANDS.secret).toContain("list");
      expect(SUBCOMMANDS.secret).toContain("scan");
      expect(SUBCOMMANDS.secret).toContain("install-scanner");
      expect(SUBCOMMANDS.secret).toContain("generate-key");
      expect(SUBCOMMANDS.secret).toContain("import-key");
    });

    it("has session subcommands", () => {
      expect(SUBCOMMANDS.session).toContain("list");
      expect(SUBCOMMANDS.session).toContain("export");
      expect(SUBCOMMANDS.session).toContain("search");
    });

    it("has adapter subcommands", () => {
      expect(SUBCOMMANDS.adapter).toContain("list");
    });

    it("has run subcommands", () => {
      expect(SUBCOMMANDS.run).toContain("agents");
      expect(SUBCOMMANDS.run).toContain("session");
    });

    it("has flow subcommands", () => {
      expect(SUBCOMMANDS.flow).toContain("run");
      expect(SUBCOMMANDS.flow).toContain("list");
      expect(SUBCOMMANDS.flow).toContain("status");
    });

    it("has marketplace subcommands", () => {
      expect(SUBCOMMANDS.marketplace).toContain("add");
      expect(SUBCOMMANDS.marketplace).toContain("list");
      expect(SUBCOMMANDS.marketplace).toContain("install");
      expect(SUBCOMMANDS.marketplace).toContain("update");
      expect(SUBCOMMANDS.marketplace).toContain("remove");
      expect(SUBCOMMANDS.marketplace).toContain("search");
      expect(SUBCOMMANDS.marketplace).toContain("uninstall");
    });
  });

  describe("generateBashCompletion", () => {
    const output = generateBashCompletion();

    it("outputs a valid bash script with complete command", () => {
      expect(output).toContain("complete -F _am_completions am");
    });

    it("includes all top-level commands", () => {
      for (const cmd of TOP_LEVEL_COMMANDS) {
        expect(output).toContain(cmd);
      }
    });

    it("includes agent subcommands in case statement", () => {
      expect(output).toContain("agent)");
      for (const sub of SUBCOMMANDS.agent) {
        expect(output).toContain(sub);
      }
    });

    it("includes wiki subcommands in case statement", () => {
      expect(output).toContain("wiki)");
      for (const sub of SUBCOMMANDS.wiki) {
        expect(output).toContain(sub);
      }
    });

    it("includes global flags", () => {
      expect(output).toContain("--json");
      expect(output).toContain("--quiet");
      expect(output).toContain("--verbose");
      expect(output).toContain("--help");
      expect(output).toContain("--profile");
    });
  });

  describe("generateZshCompletion", () => {
    const output = generateZshCompletion();

    it("starts with #compdef am", () => {
      expect(output).toStartWith("#compdef am");
    });

    it("includes all top-level commands", () => {
      for (const cmd of TOP_LEVEL_COMMANDS) {
        expect(output).toContain(cmd);
      }
    });

    it("includes agent subcommands", () => {
      expect(output).toContain("agent)");
      for (const sub of SUBCOMMANDS.agent) {
        expect(output).toContain(sub);
      }
    });

    it("includes wiki subcommands", () => {
      expect(output).toContain("wiki)");
    });

    it("includes global flags", () => {
      expect(output).toContain("--json");
      expect(output).toContain("--quiet");
      expect(output).toContain("--verbose");
      expect(output).toContain("--help");
    });
  });

  describe("generateFishCompletion", () => {
    const output = generateFishCompletion();

    it("includes __am_needs_command helper function", () => {
      expect(output).toContain("function __am_needs_command");
    });

    it("includes __am_using_command helper function", () => {
      expect(output).toContain("function __am_using_command");
    });

    it("includes all top-level commands", () => {
      for (const cmd of TOP_LEVEL_COMMANDS) {
        expect(output).toContain(cmd);
      }
    });

    it("includes agent subcommand completions", () => {
      expect(output).toContain("__am_using_command agent");
      for (const sub of SUBCOMMANDS.agent) {
        expect(output).toContain(`-a '${sub}'`);
      }
    });

    it("includes wiki subcommand completions", () => {
      expect(output).toContain("__am_using_command wiki");
    });

    it("includes global flag completions", () => {
      expect(output).toContain("-l 'json'");
      expect(output).toContain("-l 'quiet'");
      expect(output).toContain("-l 'verbose'");
      expect(output).toContain("-l 'help'");
    });
  });
});
