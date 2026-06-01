import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_GROUPS, renderGroupedHelp } from "../../src/help";

/**
 * Hidden aliases registered in cli.ts that intentionally do NOT appear in
 * the grouped help output (ADR-0029: "Hidden aliases are omitted from help
 * but still route").
 *
 *   - `agents` — pure alias for `agent` (same `agentsCommand` export).
 *   - `acp`    — niche protocol-ops surface (`am acp session …`); the
 *                user-facing entry points are `run` and `flow`, both grouped.
 */
const HIDDEN_ALIASES = new Set(["agents", "acp"]);

/**
 * Parse the `subCommands: { … }` block of src/cli.ts and return every
 * registered key. Reading the source (rather than hardcoding the list)
 * keeps this coverage test honest: a command added to cli.ts but never
 * grouped will fail here (P1-G — `pair`, `secrets`, `mcp-superset` were
 * silently absent from help before this test parsed cli.ts directly).
 */
function registeredSubcommands(): string[] {
  const src = readFileSync(join(import.meta.dir, "../../src/cli.ts"), "utf-8");
  const block = src.match(/subCommands:\s*\{([\s\S]*?)\n\s*\},/);
  if (!block) throw new Error("could not locate subCommands block in cli.ts");
  const names: string[] = [];
  // Each entry is `name: () => import(...)` or `"quoted-name": () => …`.
  const re = /(?:^|\n)\s*(?:"([\w-]+)"|([\w-]+)):\s*\(\)\s*=>/g;
  for (let m = re.exec(block[1]); m !== null; m = re.exec(block[1])) {
    names.push(m[1] ?? m[2]);
  }
  return names;
}

describe("grouped help output (ADR-0029)", () => {
  describe("COMMAND_GROUPS", () => {
    it("contains every non-alias subcommand registered in cli.ts", () => {
      // Derive the command list from cli.ts itself so help can never silently
      // drift from the real command surface (P1-G).
      const groupedNames = new Set(COMMAND_GROUPS.flatMap((g) => g.commands.map(([name]) => name)));
      const registered = registeredSubcommands().filter((c) => !HIDDEN_ALIASES.has(c));

      // Sanity: parsing actually found the commands we expect to be present.
      expect(registered).toContain("pair");
      expect(registered).toContain("secrets");
      expect(registered).toContain("mcp-superset");

      for (const cmd of registered) {
        // Accept either an exact match or a subcommand prefix match
        // (e.g. "wiki" is satisfied by "wiki list", "wiki show", etc.).
        const present =
          groupedNames.has(cmd) || [...groupedNames].some((name) => name.startsWith(`${cmd} `));
        expect(present, `command "${cmd}" is not in any COMMAND_GROUPS group`).toBe(true);
      }
    });

    it("lists no command that is not a registered (non-alias) subcommand", () => {
      // Inverse coverage: every grouped name must map back to a real cli.ts
      // command (top-level token before any space, e.g. "wiki list" -> "wiki").
      const registered = new Set(registeredSubcommands());
      for (const group of COMMAND_GROUPS) {
        for (const [name] of group.commands) {
          const top = name.split(" ")[0];
          expect(registered.has(top), `grouped command "${name}" has no cli.ts entry`).toBe(true);
        }
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
      // Post-ADR-0031: tagline shifted to "control plane for AI agents".
      expect(output).toContain("control plane for AI agents");
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

    it("groups are ordered: Config, Git, Registry, Marketplace, Agent, Wiki, Tool, Interface", () => {
      const headings = COMMAND_GROUPS.map((g) => g.heading);
      expect(headings).toEqual([
        "Config commands",
        "Git commands",
        "Registry commands",
        "Marketplace commands",
        "Agent commands",
        "Wiki commands",
        "Tool commands",
        "Interface commands",
      ]);
    });
  });
});
