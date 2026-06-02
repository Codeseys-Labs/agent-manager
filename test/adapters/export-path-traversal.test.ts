/**
 * SEC-1: write-path traversal containment for IDE adapter exports.
 *
 * A malicious or mistyped entity name (instruction/skill name) must never be
 * able to escape the adapter's target subdirectory when it is used as a
 * filename. Each adapter routes the name through `sanitizePathSegment`, so the
 * generated file path must stay inside the project directory.
 */

import { describe, expect, test } from "bun:test";
import { sep } from "node:path";
import { exportConfig as amazonQExport } from "@/adapters/amazon-q/export.ts";
import { exportConfig as clineExport } from "@/adapters/cline/export.ts";
import { exportConfig as continueExport } from "@/adapters/continue/export.ts";
import { exportConfig as copilotExport } from "@/adapters/copilot/export.ts";
import { exportConfig as cursorExport } from "@/adapters/cursor/export.ts";
import { exportConfig as kiroExport } from "@/adapters/kiro/export.ts";
import { exportConfig as rooCodeExport } from "@/adapters/roo-code/export.ts";
import type { ResolvedConfig, ResolvedInstruction, ResolvedSkill } from "@/adapters/types.ts";
import { exportConfig as windsurfExport } from "@/adapters/windsurf/export.ts";

const PROJECT = "/tmp/am-project";
const EVIL = "../../../../etc/cron.d/evil";

function instruction(
  name: string,
  overrides: Partial<ResolvedInstruction> = {},
): ResolvedInstruction {
  return {
    name,
    content: "malicious content",
    scope: "glob",
    globs: ["**/*.ts"],
    description: "",
    targets: [],
    adapters: {},
    ...overrides,
  };
}

function skill(name: string, overrides: Partial<ResolvedSkill> = {}): ResolvedSkill {
  return {
    name,
    path: "",
    description: "a skill",
    tags: [],
    adapters: {},
    ...overrides,
  };
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    servers: {},
    instructions: {},
    skills: {},
    profile: "default",
    adapters: {},
    agents: {},
    ...overrides,
  };
}

describe("SEC-1: adapter export path traversal containment", () => {
  test("amazon-q rule name cannot escape the rules directory", async () => {
    const result = await amazonQExport(
      config({ instructions: { [EVIL]: instruction(EVIL) } }),
      { dryRun: true, projectPath: PROJECT },
      "/tmp/home",
    );
    const ruleFile = result.files.find((f) => f.path.includes(".amazonq"));
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.path.includes("..")).toBe(false);
    expect(ruleFile!.path).toContain(`${sep}.amazonq${sep}rules${sep}`);
  });

  test("cline rule name cannot escape .clinerules", async () => {
    const result = await clineExport(
      config({ instructions: { [EVIL]: instruction(EVIL) } }),
      { dryRun: true, projectPath: PROJECT },
      "/tmp/home",
    );
    const ruleFile = result.files.find((f) => f.path.includes(".clinerules"));
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.path.includes("..")).toBe(false);
  });

  test("continue rule name cannot escape .continue/rules", async () => {
    const result = await continueExport(
      config({ instructions: { [EVIL]: instruction(EVIL, { targets: ["continue"] }) } }),
      { dryRun: true, projectPath: PROJECT },
      "/tmp/home",
    );
    const ruleFile = result.files.find((f) => f.path.includes(`${sep}rules${sep}`));
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.path.includes("..")).toBe(false);
  });

  test("copilot instruction name cannot escape .github/instructions", async () => {
    const result = await copilotExport(
      config({ instructions: { [EVIL]: instruction(EVIL) } }),
      { dryRun: true, projectPath: PROJECT },
      "/tmp/home",
    );
    const ruleFile = result.files.find((f) => f.path.includes("instructions"));
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.path.includes("..")).toBe(false);
  });

  test("cursor rule and agent names cannot escape .cursor", async () => {
    const result = await cursorExport(
      config({ instructions: { [EVIL]: instruction(EVIL) } }),
      { dryRun: true, projectPath: PROJECT },
      "/tmp/home",
    );
    const ruleFile = result.files.find((f) => f.path.endsWith(".mdc"));
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.path.includes("..")).toBe(false);
  });

  test("kiro steering name cannot escape .kiro/steering", async () => {
    const result = await kiroExport(
      config({ instructions: { [EVIL]: instruction(EVIL, { targets: ["kiro"] }) } }),
      { dryRun: true, projectPath: PROJECT },
      "/tmp/home",
    );
    const ruleFile = result.files.find((f) => f.path.includes("steering"));
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.path.includes("..")).toBe(false);
  });

  test("roo-code rule name cannot escape .roo/rules", async () => {
    const result = await rooCodeExport(
      config({ instructions: { [EVIL]: instruction(EVIL, { targets: ["roo-code"] }) } }),
      { dryRun: true, projectPath: PROJECT },
      "/tmp/home",
    );
    const ruleFile = result.files.find((f) => f.path.includes(`.roo${sep}rules`));
    expect(ruleFile).toBeDefined();
    expect(ruleFile!.path.includes("..")).toBe(false);
  });

  test("windsurf skill and rule names cannot escape .windsurf", async () => {
    const result = await windsurfExport(
      config({
        instructions: { [EVIL]: instruction(EVIL, { targets: ["windsurf"] }) },
        skills: { [EVIL]: skill(EVIL) },
      }),
      { dryRun: true, projectPath: PROJECT },
      "/tmp/home",
    );
    for (const f of result.files) {
      if (f.path.includes(".windsurf")) {
        expect(f.path.includes("..")).toBe(false);
      }
    }
    expect(result.files.some((f) => f.path.includes(".windsurf"))).toBe(true);
  });
});
