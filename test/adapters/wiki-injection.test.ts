/**
 * ADR-0054 R7 — apply-time wiki injection across the remaining instruction-
 * emitting adapters (Wave F).
 *
 * Phase-8 review found R7 wiki injection wired into only 4 of 13 adapters
 * (claude-code, codex-cli, forgecode, kilo-code). This proves the SAME wiring
 * now reaches every other adapter that emits a marker-wrappable / managed
 * instruction surface:
 *
 *   gemini-cli → GEMINI.md
 *   windsurf   → AGENTS.md
 *   copilot    → .github/copilot-instructions.md
 *   cursor     → .cursor/rules/am-wiki.mdc
 *   amazon-q   → .amazonq/rules/am-wiki.md
 *   cline      → .clinerules/am-wiki.md
 *   continue   → .continue/rules/am-wiki.md
 *   kiro       → .kiro/steering/am-wiki.md
 *   roo-code   → .roo/rules/am-wiki.md
 *
 * Each adapter is proven on TWO axes, mirroring the reference proof in
 * test/wiki/apply-injection.test.ts:
 *   1. inject_on_apply ON + task query → the task-matched wiki block (with its
 *      am:wiki markers and task-aware "Agent Knowledge" heading) reaches the
 *      adapter's instruction output. The task heading is emitted ONLY by the R7
 *      builder, so its presence proves the R7 path — not a coincidence.
 *   2. inject_on_apply OFF → no wiki block is emitted (opt-in gate, enforced in
 *      code in the shared caller), while the adapter's base instruction output
 *      still appears.
 *
 * Pure-MCP adapters (no instruction surface) correctly get NO injection and are
 * out of scope here; the 4 already-wired reference adapters are covered by
 * test/wiki/apply-injection.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { exportConfig as amazonQExport } from "../../src/adapters/amazon-q/export";
import { exportConfig as clineExport } from "../../src/adapters/cline/export";
import { exportConfig as continueExport } from "../../src/adapters/continue/export";
import { exportConfig as copilotExport } from "../../src/adapters/copilot/export";
import { exportConfig as cursorExport } from "../../src/adapters/cursor/export";
import { exportConfig as geminiExport } from "../../src/adapters/gemini-cli/export";
import { exportConfig as kiroExport } from "../../src/adapters/kiro/export";
import { exportConfig as rooCodeExport } from "../../src/adapters/roo-code/export";
import type { ExportOptions, ExportResult, ResolvedConfig } from "../../src/adapters/types";
import { exportConfig as windsurfExport } from "../../src/adapters/windsurf/export";
import { ensureWikiDirs, writePage } from "../../src/wiki/storage";
import type { WikiPage } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

const TASK = "kafka consumer rebalance";
const WIKI_BEGIN = "<!-- am:wiki:begin -->";
const TASK_HEADING = `Agent Knowledge: "${TASK}"`;
const WIKI_TITLE = "Kafka Rebalance Runbook";
const WIKI_BODY = "drain in-flight offsets first";

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date().toISOString();
  return {
    slug: "kafka-rebalance-runbook",
    title: WIKI_TITLE,
    type: "entity",
    content: "When the kafka consumer group rebalances, drain in-flight offsets first.",
    tags: ["kafka", "runbook"],
    confidence: "high",
    sources: [],
    backlinks: [],
    created: now,
    updated: now,
    ...overrides,
  };
}

function makeResolvedConfig(target: string, settings?: Record<string, unknown>): ResolvedConfig {
  return {
    servers: {},
    instructions: {
      "team-rules": {
        name: "team-rules",
        content: "Follow the team conventions.",
        // copilot's canonical instruction file only collects always-scoped
        // instructions, so use "always" so every adapter gets a base surface.
        scope: "always",
        globs: [],
        description: "",
        // Target the adapter under test so its instruction surface is emitted.
        targets: [target],
        adapters: {},
      },
    },
    skills: {},
    agents: {},
    profile: "default",
    adapters: {},
    ...(settings ? { settings } : {}),
  };
}

type ExportFn = (
  config: ResolvedConfig,
  options: ExportOptions,
  homeDir?: string,
) => Promise<ExportResult>;

interface Case {
  name: string;
  target: string;
  exportFn: ExportFn;
  /** Suffix the adapter's instruction file ends with (for find). */
  instructionFileSuffix: string;
}

const CASES: Case[] = [
  {
    name: "gemini-cli",
    target: "gemini-cli",
    exportFn: geminiExport,
    instructionFileSuffix: "GEMINI.md",
  },
  {
    name: "windsurf",
    target: "windsurf",
    exportFn: windsurfExport,
    instructionFileSuffix: "AGENTS.md",
  },
  {
    name: "copilot",
    target: "copilot",
    exportFn: copilotExport,
    instructionFileSuffix: join(".github", "copilot-instructions.md"),
  },
  {
    name: "cursor",
    target: "cursor",
    exportFn: cursorExport,
    instructionFileSuffix: join(".cursor", "rules", "am-wiki.mdc"),
  },
  {
    name: "amazon-q",
    target: "amazon-q",
    exportFn: amazonQExport,
    instructionFileSuffix: join(".amazonq", "rules", "am-wiki.md"),
  },
  {
    name: "cline",
    target: "cline",
    exportFn: clineExport,
    instructionFileSuffix: join(".clinerules", "am-wiki.md"),
  },
  {
    name: "continue",
    target: "continue",
    exportFn: continueExport,
    instructionFileSuffix: join(".continue", "rules", "am-wiki.md"),
  },
  {
    name: "kiro",
    target: "kiro",
    exportFn: kiroExport,
    instructionFileSuffix: join(".kiro", "steering", "am-wiki.md"),
  },
  {
    name: "roo-code",
    target: "roo-code",
    exportFn: rooCodeExport,
    instructionFileSuffix: join(".roo", "rules", "am-wiki.md"),
  },
];

describe("ADR-0054 R7 — apply-time wiki injection across remaining adapters", () => {
  let project: TestDir;
  let configHome: TestDir;
  let savedCwd: string;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    project = await createTestDir("r7-wf-proj-");
    configHome = await createTestDir("r7-wf-cfg-");
    savedEnv = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = configHome.path;
    savedCwd = process.cwd();
    // cwd becomes the project so the wiki resolver finds the project `.am-wiki/`.
    await project.write(".agent-manager.toml", "# am marker\n");
    process.chdir(project.path);

    // Seed a project-tier page that matches the TASK query — not the pre-R7
    // fixed "project knowledge" string — so a hit proves task-aware retrieval.
    const projectWiki = join(project.path, ".am-wiki");
    await ensureWikiDirs(projectWiki);
    await writePage(makePage(), projectWiki);
  });

  afterEach(async () => {
    process.chdir(savedCwd);
    if (savedEnv === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = savedEnv;
    }
    await project.cleanup();
    await configHome.cleanup();
  });

  for (const c of CASES) {
    test(`${c.name}: inject_on_apply ON → task-matched wiki block reaches instruction output`, async () => {
      const config = makeResolvedConfig(c.target, {
        wiki: { inject_on_apply: true, task: TASK },
      });
      const result = await c.exportFn(
        config,
        { projectPath: project.path, dryRun: true },
        configHome.path,
      );

      const instrFile = result.files.find((f) => f.path.endsWith(c.instructionFileSuffix));
      expect(instrFile).toBeDefined();
      // R7 markers + task-aware heading — only the R7 builder emits these.
      expect(instrFile!.content).toContain(WIKI_BEGIN);
      expect(instrFile!.content).toContain(TASK_HEADING);
      expect(instrFile!.content).toContain(WIKI_TITLE);
      expect(instrFile!.content).toContain(WIKI_BODY);
    });

    test(`${c.name}: inject_on_apply OFF → no wiki block, base instructions still emitted`, async () => {
      // Gate off → injection must NOT fire even though a matching page exists.
      const config = makeResolvedConfig(c.target, { wiki: { task: TASK } });
      const result = await c.exportFn(
        config,
        { projectPath: project.path, dryRun: true },
        configHome.path,
      );

      // No managed wiki file/block anywhere in the emitted output.
      const anyWiki = result.files.some(
        (f) =>
          f.content.includes(WIKI_BEGIN) ||
          f.path.endsWith("am-wiki.mdc") ||
          f.path.endsWith("am-wiki.md"),
      );
      expect(anyWiki).toBe(false);

      // The adapter still emits its base instruction surface (proves the OFF
      // case isn't passing merely because nothing was exported).
      const baseEmitted = result.files.some((f) =>
        f.content.includes("Follow the team conventions."),
      );
      expect(baseEmitted).toBe(true);
    });
  }

  test("continue: ON also registers the wiki rule in config.yaml's rules array", async () => {
    // Continue needs the rule referenced from the config or it won't load — the
    // managed `.continue/rules/am-wiki.md` body alone is not enough.
    const config = makeResolvedConfig("continue", {
      wiki: { inject_on_apply: true, task: TASK },
    });
    const result = await continueExport(
      config,
      { projectPath: project.path, dryRun: true },
      configHome.path,
    );

    const configFile = result.files.find((f) => f.path.endsWith("config.yaml"));
    expect(configFile).toBeDefined();
    expect(configFile!.content).toContain("file://.continue/rules/am-wiki.md");
  });
});
