/**
 * WIKI-FIX-2 (ADR-0054 R3) — end-to-end proof that the wiki write path
 * auto-links REAL catalog entity names, resolved from an actual
 * `.agent-manager.toml`, not just literals passed into a unit test.
 *
 * Before the fix, `catalogEntityNames` was exported but had zero callers in
 * src/: the wiki always matched only its frozen static fallback vocabulary, so
 * a user's own MCP server name would never auto-link. These tests drive the
 * `am wiki` command layer (which owns catalog resolution via core/config) and
 * assert that a server declared in the project config gets a `[[wikilink]]` on
 * write — the discriminator works precisely because the server name is NOT in
 * the static fallback list and matches no NER regex on its own.
 *
 * Scaffolding mirrors test/commands/wiki.test.ts + wiki-wave-b.test.ts:
 *   - AM_CONFIG_DIR redirects the global wiki store into a tmp dir.
 *   - A project dir with `.agent-manager.toml` (declaring the server) + an
 *     `.am-wiki/` so resolveWikiDir() picks the project wiki, and process.chdir
 *     into it so resolveProjectConfig(process.cwd()) finds the config.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wikiCommand } from "../../src/commands/wiki";
import {
  WIKI_PROJECT_DIRNAME,
  ensureWikiDirs,
  readPage,
  resolveWikiDir,
  writePage,
} from "../../src/wiki/storage";
import type { WikiPage } from "../../src/wiki/types";
import { type TestDir, createTestDir } from "../helpers/tmp";

type SubcommandRunner = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> };

async function getSub(name: string): Promise<SubcommandRunner> {
  const subs = (wikiCommand as unknown as { subCommands: Record<string, () => Promise<unknown>> })
    .subCommands;
  const loader = subs[name];
  if (!loader) throw new Error(`subcommand not registered: ${name}`);
  return (await loader()) as SubcommandRunner;
}

let consoleOutput: string[] = [];
const origLog = console.log;
const origError = console.error;
const origConfigDir = process.env.AM_CONFIG_DIR;

function captureConsole(): void {
  consoleOutput = [];
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
  console.error = () => {};
}

function restoreConsole(): void {
  console.log = origLog;
  console.error = origError;
}

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date().toISOString();
  return {
    slug: "seed",
    title: "Seed",
    type: "entity",
    content: "Body.",
    tags: [],
    sources: [],
    backlinks: [],
    created: now,
    updated: now,
    ...overrides,
  };
}

describe("am wiki: catalog-derived NER auto-linking (WIKI-FIX-2 / ADR-0054 R3)", () => {
  let dir: TestDir;
  let configDir: string;
  let projectDir: string;
  let projectWiki: string;
  // Order-independence guard (seed 8c51): pin the cwd restore target to the repo
  // root rather than process.cwd() at module load, so a leaked (deleted) tmp cwd
  // from an earlier test file is never captured and reinstated.
  const origCwd = join(import.meta.dir, "..", "..");

  beforeEach(async () => {
    dir = await createTestDir("am-wiki-catalog-ner-");
    configDir = join(dir.path, "config");
    mkdirSync(configDir, { recursive: true });
    process.env.AM_CONFIG_DIR = configDir;

    // A real project with a real catalog: declare a server whose name is NOT in
    // the wiki's static fallback vocabulary and matches no standalone NER regex.
    projectDir = join(dir.path, "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, ".agent-manager.toml"),
      [
        "[servers.acme-mcp]",
        'command = "bunx"',
        'args = ["acme-mcp@latest"]',
        "",
        "[agents.scout]",
        'name = "scout"',
        'prompt = "scout the codebase"',
        "",
      ].join("\n"),
      "utf-8",
    );

    projectWiki = join(projectDir, WIKI_PROJECT_DIRNAME);
    await ensureWikiDirs(projectWiki);
    process.chdir(projectDir);

    captureConsole();
    process.exitCode = undefined;
  });

  afterEach(async () => {
    restoreConsole();
    process.chdir(origCwd);
    process.exitCode = undefined;
    if (origConfigDir === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup
      delete process.env.AM_CONFIG_DIR;
    } else {
      process.env.AM_CONFIG_DIR = origConfigDir;
    }
    if (dir) await dir.cleanup();
  });

  test("resolveWikiDir picks the project wiki under the project dir", () => {
    // Sanity: confirms the add command writes into projectWiki, where we seed.
    // Canonicalize both sides: on macOS the temp dir lives under /var which is a
    // symlink to /private/var, and resolveWikiDir() (via process.cwd() after
    // chdir) returns the resolved /private/var form while projectWiki was built
    // from the unresolved mkdtemp path. realpathSync makes the comparison
    // symlink-agnostic (no-op on Linux/Windows where no such symlink exists).
    expect(realpathSync(resolveWikiDir())).toBe(realpathSync(projectWiki));
  });

  test("am wiki add: a real catalog server name auto-links on write", async () => {
    // A wiki page named after the catalog server already exists (its slug is
    // the server name), so the name is link-worthy once NER tags it.
    await writePage(makePage({ slug: "acme-mcp", title: "Acme MCP" }), {
      wikiDir: projectWiki,
      maintainDerived: false,
    });

    // Add a NEW entry whose prose mentions the server. The add command resolves
    // the real catalog (acme-mcp) and threads it into NER.
    const add = await getSub("add");
    await add.run({
      args: {
        json: true,
        quiet: false,
        verbose: false,
        global: false,
        type: "fact",
        content: "Route everything through acme-mcp for now.",
        context: "",
        tags: "",
        confidence: "0.7",
      },
    });

    const payload = JSON.parse(consoleOutput.join("\n"));
    expect(payload.action).toBe("add");
    const newSlug: string = payload.entry.id;

    const persisted = await readPage(newSlug, projectWiki);
    expect(persisted).not.toBeNull();
    // The catalog server name was auto-linked — only possible because the real
    // catalog was resolved and forwarded into NER (the static fallback set does
    // not contain "acme-mcp").
    expect(persisted!.content).toContain("[[acme-mcp]]");
  });

  test("control: without a matching wiki page, no spurious link is produced", async () => {
    // No page named after the server exists, so even though NER tags the name,
    // generateWikilinks won't link it (knownSlugs gate). Proves we only link
    // catalog names that actually have a page.
    const add = await getSub("add");
    await add.run({
      args: {
        json: true,
        quiet: false,
        verbose: false,
        global: false,
        type: "fact",
        content: "Route everything through acme-mcp for now.",
        context: "",
        tags: "",
        confidence: "0.7",
      },
    });

    const payload = JSON.parse(consoleOutput.join("\n"));
    const newSlug: string = payload.entry.id;
    const persisted = await readPage(newSlug, projectWiki);
    expect(persisted!.content).not.toContain("[[acme-mcp]]");
    expect(persisted!.content).toContain("acme-mcp");
  });
});
