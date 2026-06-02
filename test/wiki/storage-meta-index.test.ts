import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AllProjectsResult,
  buildWikiContext,
  listProjectWikis,
  loadMetaIndex,
  metaIndexPath,
  rebuildMetaIndex,
  searchAllProjects,
  writePage,
} from "../../src/wiki/storage";
import type { WikiPage } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ADR-0054 R5: a committed cross-project meta-index over `wiki/projects/*` +
// `wiki/global/`, plus `searchAllProjects` powering `am wiki search
// --all-projects`. ADR-0054 R7: `buildWikiContext` — task-aware, project>global,
// opt-in apply-time injection mechanism.

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date().toISOString();
  return {
    slug: "test-page",
    title: "Test Page",
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

describe("wiki/storage cross-project meta-index (ADR-0054 R5)", () => {
  let cfg: TestDir;
  let savedEnv: string | undefined;

  // Per-tier wiki directories under the central store.
  let projAlphaDir: string;
  let projBetaDir: string;
  let globalDir: string;

  beforeEach(async () => {
    cfg = await createTestDir("wiki-meta-cfg-");
    savedEnv = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = cfg.path;

    projAlphaDir = join(cfg.path, "wiki", "projects", "alpha");
    projBetaDir = join(cfg.path, "wiki", "projects", "beta");
    globalDir = join(cfg.path, "wiki", "global");
  });

  afterEach(async () => {
    if (savedEnv === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = savedEnv;
    }
    await cfg.cleanup();
  });

  test("listProjectWikis enumerates every project dir plus the global tier", async () => {
    // Seed a page in each project so the dirs exist on disk.
    await writePage(makePage({ slug: "a1" }), projAlphaDir);
    await writePage(makePage({ slug: "b1" }), projBetaDir);

    const tiers = listProjectWikis(cfg.path);
    const projects = tiers.map((t) => t.project);
    expect(projects).toContain("alpha");
    expect(projects).toContain("beta");
    // global is always present and last.
    expect(projects[projects.length - 1]).toBe("global");
  });

  test("rebuildMetaIndex writes meta-index.json keyed by slug/tag/entity across tiers", async () => {
    await writePage(
      makePage({
        slug: "deploy-notes",
        title: "Deploy Notes",
        tags: ["infra", "deploy"],
        entities: ["terraform"],
      }),
      projAlphaDir,
    );
    await writePage(
      makePage({ slug: "shared-style", title: "Shared Style", tags: ["infra"] }),
      globalDir,
    );

    const meta = await rebuildMetaIndex(cfg.path);

    // File is committed to disk (git-diffable JSON, ADR-0002).
    expect(existsSync(metaIndexPath(cfg.path))).toBe(true);

    // Keyed by slug.
    expect(meta.bySlug["deploy-notes"]).toBeDefined();
    expect(meta.bySlug["deploy-notes"][0].project).toBe("alpha");
    expect(meta.bySlug["shared-style"][0].project).toBe("global");

    // Keyed by tag — "infra" carried by BOTH a project page and the global page.
    const infraProjects = meta.byTag.infra.map((e) => e.project).sort();
    expect(infraProjects).toEqual(["alpha", "global"]);

    // Keyed by entity cross-reference.
    expect(meta.byEntity.terraform).toBeDefined();
    expect(meta.byEntity.terraform[0].slug).toBe("deploy-notes");

    // Project list excludes "global".
    expect(meta.projects).toEqual(["alpha"]);
  });

  test("loadMetaIndex returns the committed file and rebuilds when missing", async () => {
    await writePage(makePage({ slug: "x1", tags: ["t"] }), projAlphaDir);

    // No meta-index on disk yet → load triggers a rebuild.
    expect(existsSync(metaIndexPath(cfg.path))).toBe(false);
    const meta = await loadMetaIndex(cfg.path);
    expect(meta.bySlug.x1).toBeDefined();
    expect(existsSync(metaIndexPath(cfg.path))).toBe(true);
  });

  test("loadMetaIndex tolerates a corrupt file by rebuilding", async () => {
    await writePage(makePage({ slug: "y1" }), projBetaDir);
    // Corrupt the on-disk index.
    await rebuildMetaIndex(cfg.path);
    await cfg.write(join("wiki", "meta-index.json"), "{ not valid json");

    const meta = await loadMetaIndex(cfg.path);
    expect(meta.bySlug.y1).toBeDefined();
  });

  test("searchAllProjects aggregates ranked results across >1 project wiki", async () => {
    // Same searchable term in two different projects + the global tier.
    await writePage(
      makePage({
        slug: "alpha-kafka",
        title: "Kafka in Alpha",
        content: "We run Kafka for the alpha event bus.",
      }),
      projAlphaDir,
    );
    await writePage(
      makePage({
        slug: "beta-kafka",
        title: "Kafka in Beta",
        content: "Beta also depends on Kafka for streaming.",
      }),
      projBetaDir,
    );
    await writePage(
      makePage({
        slug: "global-kafka",
        title: "Kafka conventions",
        content: "Org-wide Kafka topic naming conventions.",
      }),
      globalDir,
    );

    const results: AllProjectsResult[] = await searchAllProjects("Kafka", 20);

    const byProject = new Set(results.map((r) => r.project));
    expect(byProject.has("alpha")).toBe(true);
    expect(byProject.has("beta")).toBe(true);
    expect(byProject.has("global")).toBe(true);

    // Every hit carries its owning tier + page.
    const slugs = results.map((r) => r.page.slug).sort();
    expect(slugs).toEqual(["alpha-kafka", "beta-kafka", "global-kafka"]);

    // Aggregated and sorted by score descending.
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test("searchAllProjects honors the limit on the aggregated set", async () => {
    await writePage(makePage({ slug: "a-svc", content: "service alpha" }), projAlphaDir);
    await writePage(makePage({ slug: "b-svc", content: "service beta" }), projBetaDir);
    await writePage(makePage({ slug: "g-svc", content: "service global" }), globalDir);

    const limited = await searchAllProjects("service", 2);
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  test("searchAllProjects returns [] for an empty query without touching disk", async () => {
    const results = await searchAllProjects("   ", 10);
    expect(results).toEqual([]);
    // No rebuild was triggered for an empty query.
    expect(existsSync(metaIndexPath(cfg.path))).toBe(false);
  });

  test("meta-index normalises a legacy numeric confidence to the enum", async () => {
    // Pre-R4 producers may still hand writePage a numeric confidence; on disk it
    // is normalised, and the meta-index entry must carry the enum, not a number.
    await writePage(makePage({ slug: "conf-page", confidence: 0.85 }), projAlphaDir);
    const meta = await rebuildMetaIndex(cfg.path);
    expect(meta.bySlug["conf-page"][0].confidence).toBe("high");
  });
});

describe("wiki/storage task-aware multi-tier wiki context (ADR-0054 R7)", () => {
  let cfg: TestDir;
  let savedEnv: string | undefined;
  let projectDir: string;
  let globalDir: string;

  beforeEach(async () => {
    cfg = await createTestDir("wiki-ctx-cfg-");
    savedEnv = process.env.AM_CONFIG_DIR;
    process.env.AM_CONFIG_DIR = cfg.path;
    // Two distinct tiers so project>global precedence is observable.
    projectDir = join(cfg.path, "wiki", "projects", "ctx-proj");
    globalDir = join(cfg.path, "wiki", "global");
  });

  afterEach(async () => {
    if (savedEnv === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = savedEnv;
    }
    await cfg.cleanup();
  });

  test("returns '' when both tiers are empty (safe default — no config bloat)", async () => {
    const block = await buildWikiContext({
      task: "deployment",
      projectWikiDir: projectDir,
      globalWikiDir: globalDir,
    });
    expect(block).toBe("");
  });

  test("task-aware: the block is scoped to the task query, not a fixed string", async () => {
    await writePage(
      makePage({
        slug: "auth-flow",
        title: "Auth Flow",
        content: "OAuth login and token refresh for the auth service.",
      }),
      projectDir,
    );
    await writePage(
      makePage({
        slug: "billing",
        title: "Billing",
        content: "Stripe invoices and dunning for the billing module.",
      }),
      projectDir,
    );

    const block = await buildWikiContext({
      task: "auth token refresh",
      projectWikiDir: projectDir,
      globalWikiDir: globalDir,
    });

    expect(block).toContain("Auth Flow");
    // The task heading reflects the actual task, not "project knowledge".
    expect(block).toContain('Agent Knowledge: "auth token refresh"');
    expect(block).toContain("<!-- am:wiki:begin -->");
    expect(block).toContain("<!-- am:wiki:end -->");
  });

  test("multi-tier: project tier wins a slug collision over global (project > global)", async () => {
    // Same slug in both tiers, different body. Project content must win.
    await writePage(
      makePage({
        slug: "shared",
        title: "Shared (project)",
        content: "PROJECT-LEVEL shared knowledge about caching.",
      }),
      projectDir,
    );
    await writePage(
      makePage({
        slug: "shared",
        title: "Shared (global)",
        content: "GLOBAL-LEVEL shared knowledge about caching.",
      }),
      globalDir,
    );

    const block = await buildWikiContext({
      task: "caching",
      projectWikiDir: projectDir,
      globalWikiDir: globalDir,
    });

    expect(block).toContain("PROJECT-LEVEL");
    expect(block).not.toContain("GLOBAL-LEVEL");
    // It is labelled with the project tier.
    expect(block).toContain("(project,");
  });

  test("multi-tier: global-only knowledge is still surfaced and tier-labelled", async () => {
    await writePage(
      makePage({
        slug: "org-policy",
        title: "Org Policy",
        content: "Org-wide secret-handling policy for every service.",
      }),
      globalDir,
    );

    const block = await buildWikiContext({
      task: "secret handling policy",
      projectWikiDir: projectDir,
      globalWikiDir: globalDir,
    });

    expect(block).toContain("Org Policy");
    expect(block).toContain("(global,");
  });

  test("agent bias: pages scoped to the target agent are front-loaded", async () => {
    await writePage(
      makePage({
        slug: "generic-notes",
        title: "Generic Notes",
        content: "deployment runbook deployment steps deployment checklist",
      }),
      projectDir,
    );
    await writePage(
      makePage({
        slug: "agent-notes",
        title: "Agent Notes",
        content: "deployment owned by the researcher agent",
        agent_id: "researcher",
      }),
      projectDir,
    );

    const block = await buildWikiContext({
      task: "deployment",
      agentId: "researcher",
      projectWikiDir: projectDir,
      globalWikiDir: globalDir,
    });

    // Agent-scoped page appears before the generic one in the rendered block.
    const agentIdx = block.indexOf("Agent Notes");
    const genericIdx = block.indexOf("Generic Notes");
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(genericIdx).toBeGreaterThanOrEqual(0);
    expect(agentIdx).toBeLessThan(genericIdx);
  });

  test("when project tier == global tier (global-only wiki), pages are not double-listed", async () => {
    await writePage(
      makePage({ slug: "once", title: "Once", content: "single tier knowledge about logging" }),
      globalDir,
    );
    const block = await buildWikiContext({
      task: "logging",
      // Both point at the same dir — the global-only-wiki case.
      projectWikiDir: globalDir,
      globalWikiDir: globalDir,
    });
    const occurrences = block.split("### Once").length - 1;
    expect(occurrences).toBe(1);
  });
});
