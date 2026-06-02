/**
 * ADR-0054 R7 — task-aware multi-tier apply-time wiki injection.
 *
 * This proves the WIRING (not just the mechanism): R7's `buildWikiContext`
 * output genuinely reaches a resolved/exported target's output via the single
 * shared caller (`core/instructions.generateWikiContext`), which every wiki-
 * injecting adapter routes through. The proof is deliberately built so it can
 * ONLY pass through the R7 path:
 *
 *  1. The injected wiki content is keyed to a TASK-SPECIFIC query
 *     (`settings.wiki.task`) and the seeded page matches that task — NOT the
 *     pre-R7 fixed "project knowledge" string. So a page that lands in the
 *     emitted CLAUDE.md proves task-aware retrieval reached the export.
 *  2. A GLOBAL-tier-only page reaches the output too, proving the multi-tier
 *     (project + global) R7 builder — not the old single-tier synthesizer —
 *     produced the block.
 *  3. With `inject_on_apply` off, nothing is injected (opt-in gate, enforced in
 *     code in the shared caller).
 *
 * The claude-code adapter is exercised read-only (it already routes through the
 * shared caller); we own everything else this pass.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportConfig as exportClaudeCode } from "../../src/adapters/claude-code/export";
import type { ResolvedConfig } from "../../src/adapters/types";
import {
  buildWikiContext,
  ensureWikiDirs,
  resolveWikiDir,
  writePage,
} from "../../src/wiki/storage";
import type { WikiPage } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date().toISOString();
  return {
    slug: "p",
    title: "Page",
    type: "entity",
    content: "Body content.",
    tags: [],
    sources: [],
    backlinks: [],
    created: now,
    updated: now,
    ...overrides,
  };
}

function makeResolvedConfig(settings?: Record<string, unknown>): ResolvedConfig {
  return {
    servers: {},
    instructions: {
      "team-rules": {
        name: "team-rules",
        content: "Follow the team conventions.",
        scope: "always",
        globs: [],
        description: "",
        targets: [],
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

describe("ADR-0054 R7 — buildWikiContext output reaches the target export", () => {
  let project: TestDir;
  let configHome: TestDir;
  let savedCwd: string;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    project = await createTestDir("r7-proj-");
    configHome = await createTestDir("r7-cfg-");
    savedEnv = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = configHome.path;
    savedCwd = process.cwd();
    // The project becomes cwd so the wiki resolver (used by the shared injection
    // caller and buildWikiContext) finds the project `.am-wiki/`.
    await project.write(".agent-manager.toml", "# am marker\n");
    process.chdir(project.path);
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

  /** Seed a project-tier page matching a TASK-SPECIFIC query (not the fixed string). */
  async function seedProjectTaskPage(): Promise<void> {
    const projectWiki = join(project.path, ".am-wiki");
    await ensureWikiDirs(projectWiki);
    await writePage(
      makePage({
        slug: "kafka-rebalance-runbook",
        title: "Kafka Rebalance Runbook",
        // Deliberately does NOT contain the pre-R7 "project knowledge" phrase —
        // it only matches the task-aware query below.
        content: "When the kafka consumer group rebalances, drain in-flight offsets first.",
        tags: ["kafka", "runbook"],
        confidence: "high",
      }),
      projectWiki,
    );
  }

  /** Seed a global-tier page so the multi-tier path is observable. */
  async function seedGlobalPage(): Promise<void> {
    const globalWiki = join(configHome.path, "wiki", "global");
    await ensureWikiDirs(globalWiki);
    await writePage(
      makePage({
        slug: "org-kafka-policy",
        title: "Org Kafka Policy",
        content: "Org-wide kafka topic naming policy applies to every service.",
        tags: ["kafka"],
        confidence: "medium",
      }),
      globalWiki,
    );
  }

  test("inject_on_apply + task query: the task-matched wiki page lands in the emitted CLAUDE.md", async () => {
    await seedProjectTaskPage();

    // Task-aware: the query is settings.wiki.task, NOT the pre-R7 fixed string.
    const config = makeResolvedConfig({
      wiki: { inject_on_apply: true, task: "kafka consumer rebalance" },
    });
    const result = await exportClaudeCode(config, { projectPath: project.path, dryRun: false });

    const claudeMd = result.files.find((f) => f.path.endsWith("CLAUDE.md"));
    expect(claudeMd).toBeDefined();

    const written = readFileSync(claudeMd!.path, "utf-8");
    expect(written).toContain("<!-- am:wiki:begin -->");
    // R7 task heading reflects the actual task — only the R7 builder emits this.
    expect(written).toContain('Agent Knowledge: "kafka consumer rebalance"');
    expect(written).toContain("Kafka Rebalance Runbook");
    expect(written).toContain("drain in-flight offsets first");
    // Augments, not replaces: the base instruction survives.
    expect(written).toContain("Follow the team conventions.");
  });

  test("multi-tier: BOTH a project page and a distinct global page reach the export", async () => {
    // A distinct project `.am-wiki/` tier AND a global tier, each with its own
    // page matching the task. The pre-R7 single-tier synthesizer queried ONE
    // dir; both pages landing — tier-labelled — proves the multi-tier R7 builder
    // queried project AND global.
    await seedProjectTaskPage();
    await seedGlobalPage();

    const config = makeResolvedConfig({
      wiki: { inject_on_apply: true, task: "kafka" },
    });
    const result = await exportClaudeCode(config, { projectPath: project.path, dryRun: false });

    const claudeMd = result.files.find((f) => f.path.endsWith("CLAUDE.md"));
    const written = readFileSync(claudeMd!.path, "utf-8");
    expect(written).toContain("<!-- am:wiki:begin -->");
    // Project-tier page, labelled project.
    expect(written).toContain("Kafka Rebalance Runbook");
    expect(written).toContain("(project,");
    // Global-tier page, labelled global — only the multi-tier builder reaches it.
    expect(written).toContain("Org Kafka Policy");
    expect(written).toContain("(global,");
  });

  test("without inject_on_apply, no wiki block is injected (opt-in gate, enforced in code)", async () => {
    await seedProjectTaskPage();

    // Gate off → injection must NOT fire even though a matching page exists.
    const config = makeResolvedConfig({ wiki: { task: "kafka consumer rebalance" } });
    const result = await exportClaudeCode(config, { projectPath: project.path, dryRun: false });

    const claudeMd = result.files.find((f) => f.path.endsWith("CLAUDE.md"));
    const written = readFileSync(claudeMd!.path, "utf-8");
    expect(written).not.toContain("<!-- am:wiki:begin -->");
    expect(written).not.toContain("Kafka Rebalance Runbook");
    // Base instruction still emitted.
    expect(written).toContain("Follow the team conventions.");
  });

  test("buildWikiContext block carries the same am:wiki marker contract the adapters splice", async () => {
    // Belt-and-braces: the block buildWikiContext returns is splice-ready for
    // the same marker pair the adapters use, so the wiring above is contractual,
    // not coincidental.
    await seedProjectTaskPage();
    const block = await buildWikiContext({
      task: "kafka consumer rebalance",
      projectWikiDir: resolveWikiDir(),
      globalWikiDir: join(configHome.path, "wiki", "global"),
    });
    expect(block).toContain("<!-- am:wiki:begin -->");
    expect(block).toContain("<!-- am:wiki:end -->");
    expect(block).toContain("Kafka Rebalance Runbook");
    expect(block).toContain('Agent Knowledge: "kafka consumer rebalance"');
  });
});
