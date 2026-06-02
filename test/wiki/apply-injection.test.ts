/**
 * ADR-0054 R7 — task-aware multi-tier apply-time wiki injection.
 *
 * Two layers of proof:
 *  1. The injection MECHANISM (`buildWikiContext`) is task-aware + multi-tier +
 *     opt-in — covered in `storage-meta-index.test.ts`.
 *  2. The export PIPELINE actually delivers injected wiki context into a
 *     target's resolved output — covered here by running the real claude-code
 *     adapter export with `inject_on_apply` and asserting the wiki content
 *     lands in the emitted CLAUDE.md. This is the "injected content reaches the
 *     resolved output for a target" requirement.
 *
 * The adapter is exercised read-only (its source is owned by another strand).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exportConfig as exportClaudeCode } from "../../src/adapters/claude-code/export";
import type { ResolvedConfig } from "../../src/adapters/types";
import { buildWikiContext, ensureWikiDirs, writePage } from "../../src/wiki/storage";
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

describe("ADR-0054 R7 — apply-time wiki injection reaches the target output", () => {
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
    // The project becomes cwd so the wiki resolver (used by the export's
    // injection helper) finds the project `.am-wiki/`.
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

  async function seedProjectWiki(): Promise<void> {
    const projectWiki = join(project.path, ".am-wiki");
    await ensureWikiDirs(projectWiki);
    // The existing export-pipeline injection seam queries the wiki with the
    // fixed string "project knowledge" (the very narrowness R7's mechanism
    // fixes). Seed a page that matches it so this end-to-end pipeline test
    // proves injection REACHES the target output; the task-aware behaviour is
    // proven against buildWikiContext in storage-meta-index.test.ts.
    await writePage(
      makePage({
        slug: "project-knowledge-runbook",
        title: "Project Knowledge Runbook",
        content: "Project knowledge: always run the migration before flipping the feature flag.",
        tags: ["project", "knowledge"],
        confidence: "high",
      }),
      projectWiki,
    );
  }

  test("with inject_on_apply, wiki content is injected into the emitted CLAUDE.md for the target", async () => {
    await seedProjectWiki();

    const config = makeResolvedConfig({ wiki: { inject_on_apply: true } });
    const result = await exportClaudeCode(config, { projectPath: project.path, dryRun: false });

    const claudeMd = result.files.find((f) => f.path.endsWith("CLAUDE.md"));
    expect(claudeMd).toBeDefined();

    // The injected wiki content reaches the resolved output on disk.
    const written = readFileSync(claudeMd!.path, "utf-8");
    expect(written).toContain("<!-- am:wiki:begin -->");
    expect(written).toContain("always run the migration before flipping the feature flag.");
    // And the base instruction content is still present (injection augments, not replaces).
    expect(written).toContain("Follow the team conventions.");
  });

  test("without inject_on_apply, no wiki block is injected (opt-in safe default)", async () => {
    await seedProjectWiki();

    // No settings.wiki.inject_on_apply → injection must NOT fire.
    const config = makeResolvedConfig();
    const result = await exportClaudeCode(config, { projectPath: project.path, dryRun: false });

    const claudeMd = result.files.find((f) => f.path.endsWith("CLAUDE.md"));
    expect(claudeMd).toBeDefined();
    const written = readFileSync(claudeMd!.path, "utf-8");
    expect(written).not.toContain("<!-- am:wiki:begin -->");
    expect(written).not.toContain("always run the migration");
    // Base instruction still emitted.
    expect(written).toContain("Follow the team conventions.");
  });

  test("buildWikiContext block is splice-ready for the same target marker contract", async () => {
    // The R7 mechanism emits the SAME am:wiki marker contract the adapters
    // splice, so a target can adopt buildWikiContext without changing its
    // marker handling. Prove the block carries the markers + task heading.
    await seedProjectWiki();
    const projectWiki = join(project.path, ".am-wiki");

    const block = await buildWikiContext({
      task: "migration feature flag",
      projectWikiDir: projectWiki,
      globalWikiDir: join(configHome.path, "wiki", "global"),
    });

    expect(block).toContain("<!-- am:wiki:begin -->");
    expect(block).toContain("<!-- am:wiki:end -->");
    expect(block).toContain("Project Knowledge Runbook");
    expect(block).toContain('Agent Knowledge: "migration feature flag"');
  });
});
