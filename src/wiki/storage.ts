/**
 * Markdown-file-based knowledge storage with MiniSearch BM25 indexing (ADR-0020).
 *
 * Stores wiki pages as individual .md files with YAML frontmatter.
 *
 * Layout (ADR-0022 — dual wiki location strategy):
 *   ~/.config/agent-manager/wiki/
 *     global/            — cross-project knowledge
 *       entities/
 *       concepts/
 *       ...
 *     projects/<name>/   — per-project knowledge
 *       entities/
 *       concepts/
 *       ...
 *
 *   ~/code/my-app/.agent-manager/wiki -> ~/.../wiki/projects/my-app  (symlink)
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import MiniSearch from "minisearch";
import { resolveConfigDir, resolveProjectConfig } from "../core/config";
import { isNotFound } from "../lib/errors";
import { sanitizePathSegment } from "../lib/safe-path";
// ADR-0054 R1: writePage maintains the graph + wikilink edges + search index
// on the write path. These imports form a deliberate cycle with graph.ts
// (which imports ensureWikiDirs/resolveWikiDir from here) — safe because every
// reference is inside a function body, never at module-evaluation time.
import { addPageToGraph, loadGraph, saveGraph } from "./graph";
import { type NerOptions, generateWikilinks } from "./ner";
import { type WikiPage, confidenceToScore, normalizeConfidence } from "./types";
import type {
  EntityType,
  KnowledgeEntry,
  KnowledgeFilter,
  KnowledgeSource,
  Provenance,
  WikiIndex,
  WikiPageType,
} from "./types";

// ── Paths ───────────────────────────────────────────────────────

const PAGE_SUBDIRS: Record<WikiPageType, string> = {
  entity: "entities",
  concept: "concepts",
  summary: "summaries",
  synthesis: "synthesis",
  decision: "decisions",
};

/** Resolve the wiki directory based on context (project vs global). (ADR-0022/ADR-0044) */
/**
 * Returns true iff `path` exists AND points at a real directory.
 *
 * - Symlinks are followed (statSync, not lstatSync) so a symlinked wiki dir
 *   under the legacy ADR-0022 layout still resolves correctly.
 * - Regular files at the wiki path are rejected (defence against accidental
 *   `touch .am-wiki` or `mkdir -p` on the wrong inode).
 * - ENOENT, EACCES, and any other stat failure -> false (treated as absent).
 */
function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function resolveWikiDir(opts?: { global?: boolean; projectDir?: string }): string {
  const configDir = resolveConfigDir();

  if (opts?.global) {
    return join(configDir, "wiki", "global");
  }

  // Check if we're in a project with a local wiki. ADR-0044's `.am-wiki/`
  // takes precedence over ADR-0022's legacy `.agent-manager/wiki` symlink.
  // Both candidates must be directories — a regular file at that path is
  // treated as "not present" (defence against `mkdir -p` on the wrong inode).
  const projectFile = resolveProjectConfig(opts?.projectDir ?? process.cwd());
  if (projectFile) {
    const projectDir = dirname(projectFile);
    const wikiDir = join(projectDir, WIKI_PROJECT_DIRNAME);
    if (isExistingDirectory(wikiDir)) return wikiDir;

    const wikiLink = join(projectDir, LEGACY_WIKI_PROJECT_DIRNAME);
    // statSync follows the symlink — directories accepted, files rejected.
    if (isExistingDirectory(wikiLink)) return wikiLink;
  }

  // Fall back to global wiki
  return join(configDir, "wiki", "global");
}

/** Returns the wiki directory path (delegates to resolveWikiDir). */
export function getWikiDir(): string {
  return resolveWikiDir();
}

/** Resolve the project name from git remote or directory name. (ADR-0022) */
export function resolveProjectName(projectDir: string): string {
  // Try to read git remote
  try {
    const gitConfigPath = join(projectDir, ".git", "config");
    const gitConfig = readFileSync(gitConfigPath, "utf-8");
    const remoteMatch = gitConfig.match(/url\s*=\s*.*[/:]([^/\s]+?)(?:\.git)?$/m);
    if (remoteMatch?.[1]) return remoteMatch[1];
  } catch {
    /* no git or no remote */
  }

  // Fall back to directory basename
  return basename(projectDir);
}

/** Get the wiki directory for a specific project (in the central AM repo). (ADR-0022) */
export function getProjectWikiDir(projectName: string): string {
  return join(resolveConfigDir(), "wiki", "projects", projectName);
}

/** Create the symlink from project to central AM wiki. (ADR-0022) */
export function createProjectWikiLink(projectDir: string, projectName: string): void {
  const amDir = join(projectDir, ".agent-manager");
  const wikiLink = join(amDir, "wiki");
  const target = getProjectWikiDir(projectName);

  // Ensure the target directory exists in the central AM repo
  require("node:fs").mkdirSync(target, { recursive: true });

  // Ensure .agent-manager dir exists in the project
  require("node:fs").mkdirSync(amDir, { recursive: true });

  // Create symlink (skip if exists and points to right target)
  if (existsSync(wikiLink)) {
    try {
      const stat = lstatSync(wikiLink);
      if (stat.isSymbolicLink()) {
        const existingTarget = readlinkSync(wikiLink);
        if (existingTarget === target) return; // already correct
      }
    } catch {
      /* can't read, recreate */
    }
    // Remove existing
    rmSync(wikiLink, { recursive: true, force: true });
  }

  const symlinkType = process.platform === "win32" ? "junction" : undefined;
  symlinkSync(target, wikiLink, symlinkType);
}

/**
 * Ensure `.agent-manager/wiki` is in the project's `.gitignore`.
 *
 * **@deprecated** Since ADR-0044 (Wave B). Use {@link ensureAmWikiGitignore}
 * which adds `.am-wiki/` instead. Retained for backward compatibility with
 * ADR-0022 legacy callers — no new flow should invoke this. See
 * ADR-0022 §5 and ADR-0044 §3-4.
 */
export function ensureWikiGitignore(projectDir: string): void {
  const gitignorePath = join(projectDir, ".gitignore");
  const entry = ".agent-manager/wiki";

  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      if (content.includes(entry)) return; // already there
      // Append
      const separator = content.endsWith("\n") ? "" : "\n";
      require("node:fs").appendFileSync(gitignorePath, `${separator}${entry}\n`);
    } else {
      require("node:fs").writeFileSync(gitignorePath, `${entry}\n`);
    }
  } catch {
    /* best effort */
  }
}

// ── ADR-0044: Two-tier wiki layout ─────────────────────────────────
//
// ADR-0022 placed the project wiki at `.agent-manager/wiki/` as a
// symlink to the global store. ADR-0044 amends §3-4 of ADR-0022:
// project wiki moves to `.am-wiki/` and is a copy, not a symlink.
// The symlink helpers above remain for backward compatibility.
// `detectLegacyWikiLayout()` is the discovery primitive for the
// `am wiki migrate` command and for `am wiki init`'s deprecation
// warning.

/** Project-level wiki directory (ADR-0044). */
export const WIKI_PROJECT_DIRNAME = ".am-wiki";

/** Legacy project wiki path used by ADR-0022 — ADR-0044 supersedes this. */
export const LEGACY_WIKI_PROJECT_DIRNAME = join(".agent-manager", "wiki");

export interface WikiLayoutDetection {
  /** True if the project has a legacy `.agent-manager/wiki/` directory or symlink. */
  hasLegacy: boolean;
  /** True if the project has a current-form `.am-wiki/` directory. */
  hasNew: boolean;
  /** Absolute path to the legacy location (whether or not it exists). */
  legacyPath: string;
  /** Absolute path to the current-form location (whether or not it exists). */
  newPath: string;
}

/**
 * Inspect a project directory and report which wiki layout(s) are
 * present. Used by `am wiki init` (to print a deprecation warning) and
 * `am wiki migrate` (to decide what to do).
 *
 * Pure: never mutates the filesystem. Symlinks count as "present" for
 * the legacy path because that's the original ADR-0022 mechanism.
 */
export function detectLegacyWikiLayout(projectDir: string): WikiLayoutDetection {
  const legacyPath = join(projectDir, LEGACY_WIKI_PROJECT_DIRNAME);
  const newPath = join(projectDir, WIKI_PROJECT_DIRNAME);
  return {
    hasLegacy: existsSync(legacyPath),
    hasNew: existsSync(newPath),
    legacyPath,
    newPath,
  };
}

/**
 * Byte-identity check for two files. Returns true iff both files exist and
 * have identical byte contents. A missing destination returns false so the
 * caller can treat it as "copy required". Any other IO error propagates.
 */
async function filesAreIdentical(a: string, b: string): Promise<boolean> {
  if (!existsSync(a) || !existsSync(b)) return false;
  const [abuf, bbuf] = await Promise.all([readFile(a), readFile(b)]);
  return abuf.equals(bbuf);
}

/**
 * ADR-0044 §2 task 2 — materialise entries from the global project store
 * into a project's `.am-wiki/` directory.
 *
 * This is the copy-based replacement for ADR-0022's symlink mechanism: a
 * project works against a local snapshot of the wiki, and changes flow
 * back to the global store only via an explicit `pushToGlobal` / publish
 * step. The function is idempotent — byte-identical files are classified
 * as `skipped` instead of re-copied; files that differ between local and
 * global are OVERWRITTEN (global wins) and land in `copied`.
 *
 * Callers that want to preserve local edits must implement their own
 * conflict UI on top of this primitive (tracked: ADR-0044 task 8 / pull).
 *
 * @param projectDir Absolute path to the project directory.
 * @param slugs      Either "all" (copy every entry under every PAGE_SUBDIRS
 *                   subdir of the global store) or an explicit list of slug
 *                   strings. Missing slugs are returned in `skipped` — never
 *                   throw.
 * @returns `{ copied, skipped }` — both arrays sorted alphabetically and
 *          holding bare slugs (no `.md` extension).
 */
export async function materialiseProject(
  projectDir: string,
  slugs: string[] | "all",
  opts?: { projectName?: string },
): Promise<{ copied: string[]; skipped: string[] }> {
  const projectName = opts?.projectName ?? resolveProjectName(projectDir);
  // ADR-0022 layout: per-project mirror at `wiki/projects/<name>/`, distinct
  // from the cross-project store at `wiki/global/`. ADR-0044 only changes
  // how the project-level slot is materialised (copy vs symlink), not the
  // global store layout.
  const projectStoreDir = getProjectWikiDir(projectName);
  const destRoot = join(projectDir, WIKI_PROJECT_DIRNAME);

  const copied: string[] = [];
  const skipped: string[] = [];
  const wantAll = slugs === "all";
  const wantedSet = wantAll ? null : new Set(slugs as string[]);
  const foundSlugs = new Set<string>();

  // If the global project store doesn't exist, there's nothing to copy.
  // For explicit slug lists we still need to report every requested slug
  // as skipped (below).
  const globalExists = existsSync(projectStoreDir);

  if (globalExists) {
    for (const subdir of Object.values(PAGE_SUBDIRS)) {
      const srcDir = join(projectStoreDir, subdir);
      if (!existsSync(srcDir)) continue;

      let entries: string[];
      try {
        entries = await readdir(srcDir);
      } catch (err: unknown) {
        if (isNotFound(err)) continue;
        throw err;
      }

      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const slug = entry.slice(0, -3);
        if (!wantAll && !wantedSet!.has(slug)) continue;
        foundSlugs.add(slug);

        const srcPath = join(srcDir, entry);
        const destSubdir = join(destRoot, subdir);
        const destPath = join(destSubdir, entry);

        await mkdir(destSubdir, { recursive: true });

        if (await filesAreIdentical(srcPath, destPath)) {
          skipped.push(slug);
        } else {
          await copyFile(srcPath, destPath);
          copied.push(slug);
        }
      }
    }
  }

  // For explicit slug lists, any requested slug we never found in the
  // global store is reported as skipped (never throws — see ADR-0044 §2).
  if (!wantAll) {
    for (const slug of Array.from(wantedSet!)) {
      if (!foundSlugs.has(slug)) skipped.push(slug);
    }
  }

  copied.sort();
  skipped.sort();
  return { copied, skipped };
}

/**
 * ADR-0044 §2 task 3 — promote a single project-local entry into the
 * global project store. Inverse of `materialiseProject` at the one-entry
 * granularity used by `am wiki publish <slug>`.
 *
 * Behavior:
 *   - Locates `<projectDir>/.am-wiki/<subdir>/<slug>.md` by walking every
 *     PAGE_SUBDIRS subdir. Throws if no such file exists.
 *   - If the global slot is empty → copy, return `{ pushed: slug, conflict: false }`.
 *   - If the global slot holds a byte-identical file → no-op,
 *     `{ pushed: slug, conflict: false }`.
 *   - If the global slot holds a different file and `opts.force !== true` →
 *     return `{ pushed: null, conflict: true }` WITHOUT overwriting. Caller is
 *     expected to surface a diff and retry with `force: true`.
 *   - If `opts.force === true` → overwrite, return `{ pushed: slug, conflict: false }`.
 *
 * The return shape is a discriminated pair: `pushed` is the slug only on a
 * successful push (including idempotent no-ops), and `null` on conflict. This
 * prevents callers from treating a conflict as a successful push by inspecting
 * only the `pushed` field.
 *
 * @param projectDir Absolute path to the project directory.
 * @param slug       Slug of the `.am-wiki/<subdir>/<slug>.md` entry to push.
 * @param opts.force Force overwrite even when the global slot differs.
 */
export async function pushToGlobal(
  projectDir: string,
  slug: string,
  opts?: { force?: boolean },
): Promise<{ pushed: string | null; conflict: boolean }> {
  const localRoot = join(projectDir, WIKI_PROJECT_DIRNAME);

  // SEC-2: contain the slug to a single safe path segment before using it to
  // build local/global file paths (it ultimately derives from a user-supplied
  // entry id).
  const safeSlug = sanitizePathSegment(slug);

  // Locate the entry under one of the PAGE_SUBDIRS subdirs.
  let localPath: string | null = null;
  let foundSubdir: string | null = null;
  for (const subdir of Object.values(PAGE_SUBDIRS)) {
    const candidate = join(localRoot, subdir, `${safeSlug}.md`);
    if (existsSync(candidate)) {
      localPath = candidate;
      foundSubdir = subdir;
      break;
    }
  }

  if (!localPath || !foundSubdir) {
    throw new Error(`Entry not found: ${slug}`);
  }

  const projectName = resolveProjectName(projectDir);
  const globalSubdir = join(getProjectWikiDir(projectName), foundSubdir);
  const globalPath = join(globalSubdir, `${safeSlug}.md`);

  await mkdir(globalSubdir, { recursive: true });

  if (existsSync(globalPath)) {
    if (await filesAreIdentical(localPath, globalPath)) {
      return { pushed: slug, conflict: false };
    }
    if (!opts?.force) {
      return { pushed: null, conflict: true };
    }
  }

  await copyFile(localPath, globalPath);
  return { pushed: slug, conflict: false };
}

function searchIndexPath(baseDir?: string): string {
  return join(baseDir ?? getWikiDir(), "index.json");
}

function pageDir(type: WikiPageType, baseDir?: string): string {
  return join(baseDir ?? getWikiDir(), PAGE_SUBDIRS[type]);
}

function pagePath(slug: string, type: WikiPageType, baseDir?: string): string {
  // SEC-2: the slug is derived from a user/agent-controlled entry id. Sanitize
  // it to a single safe path segment so a slug like `../../escape` cannot break
  // out of the wiki directory on write/read/delete.
  return join(pageDir(type, baseDir), `${sanitizePathSegment(slug)}.md`);
}

// ── Directory setup ─────────────────────────────────────────────

/** Create wiki subdirectories if missing. Accepts optional base directory. */
export async function ensureWikiDirs(baseDir?: string): Promise<void> {
  const wikiDir = baseDir ?? getWikiDir();
  await mkdir(wikiDir, { recursive: true });
  for (const sub of [...Object.values(PAGE_SUBDIRS), "raw"]) {
    await mkdir(join(wikiDir, sub), { recursive: true });
  }
}

// ── YAML Frontmatter parsing (inline, no dependency) ────────────

const FRONTMATTER_DELIM = "---";

/**
 * Parse YAML frontmatter from markdown content.
 * Handles simple key-value pairs and YAML arrays (both inline [...] and block - item).
 */
export function parseFrontmatter(content: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith(FRONTMATTER_DELIM)) {
    return { metadata: {}, body: content };
  }

  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) return { metadata: {}, body: content };

  const rest = trimmed.slice(firstNewline + 1);
  const endIdx = rest.indexOf(`\n${FRONTMATTER_DELIM}`);
  if (endIdx === -1) return { metadata: {}, body: content };

  const yamlBlock = rest.slice(0, endIdx);
  const body = rest.slice(endIdx + 1 + FRONTMATTER_DELIM.length).replace(/^\n/, "");

  const metadata: Record<string, unknown> = {};
  let currentKey = "";
  let collectingArray = false;
  let arrayItems: string[] = [];

  for (const line of yamlBlock.split("\n")) {
    // Block array item: "  - value"
    if (collectingArray && /^\s+-\s+/.test(line)) {
      const val = line.replace(/^\s+-\s+/, "").trim();
      arrayItems.push(unquoteYaml(val));
      continue;
    }

    // If we were collecting array items, flush them
    if (collectingArray) {
      metadata[currentKey] = arrayItems;
      collectingArray = false;
      arrayItems = [];
    }

    // Key-value pair: "key: value"
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (!key) continue;
    currentKey = key;

    // Inline array: [a, b, c]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1);
      if (inner.trim() === "") {
        metadata[key] = [];
      } else {
        metadata[key] = inner.split(",").map((s) => unquoteYaml(s.trim()));
      }
      continue;
    }

    // Empty value — might be followed by block array
    if (rawValue === "") {
      collectingArray = true;
      arrayItems = [];
      continue;
    }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      metadata[key] = Number.parseFloat(rawValue);
      continue;
    }

    // Boolean
    if (rawValue === "true") {
      metadata[key] = true;
      continue;
    }
    if (rawValue === "false") {
      metadata[key] = false;
      continue;
    }

    // String (may be quoted)
    metadata[key] = unquoteYaml(rawValue);
  }

  // Flush trailing array
  if (collectingArray) {
    metadata[currentKey] = arrayItems;
  }

  return { metadata, body };
}

/** Remove surrounding quotes from a YAML string value */
function unquoteYaml(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Serialize metadata and body into a markdown string with YAML frontmatter.
 */
export function serializeFrontmatter(metadata: Record<string, unknown>, body: string): string {
  const lines: string[] = [FRONTMATTER_DELIM];

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${quoteYamlIfNeeded(String(item))}`);
        }
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${quoteYamlIfNeeded(String(value))}`);
    }
  }

  lines.push(FRONTMATTER_DELIM);
  lines.push(body);
  return lines.join("\n");
}

/** Quote a YAML string value if it contains special characters */
function quoteYamlIfNeeded(s: string): string {
  if (/[:#\[\]{},>|&*!%@`]/.test(s) || s.includes("\n") || s.startsWith(" ") || s.endsWith(" ")) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

// ── Page CRUD ───────────────────────────────────────────────────

/** Options controlling {@link writePage}'s write-path side-effects (ADR-0054 R1). */
export interface WritePageOptions {
  /** Wiki directory to write into (defaults to the resolved wiki dir). */
  wikiDir?: string;
  /**
   * When false, skip the live graph + search-index maintenance and the
   * wikilink auto-insertion. Used by batch paths (rebuild, materialise) that
   * manage those artifacts themselves to avoid write amplification. Default true.
   */
  maintainDerived?: boolean;
  /**
   * Catalog entity names (servers/agents/skills/instructions) for NER-driven
   * wikilink generation (ADR-0054 R3). Forwarded to {@link generateWikilinks}.
   */
  ner?: NerOptions;
}

/**
 * Collect every existing page slug under `wikiDir` without parsing bodies.
 * Used to seed wikilink auto-insertion so we only link to pages that exist.
 */
async function collectKnownSlugs(wikiDir?: string): Promise<Set<string>> {
  const slugs = new Set<string>();
  for (const type of Object.keys(PAGE_SUBDIRS) as WikiPageType[]) {
    const dir = pageDir(type, wikiDir);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err: unknown) {
      if (isNotFound(err)) continue;
      throw err;
    }
    for (const file of files) {
      if (file.endsWith(".md")) slugs.add(file.slice(0, -3));
    }
  }
  return slugs;
}

/**
 * Write a wiki page to disk as a markdown file with frontmatter.
 *
 * ADR-0054 R1 — the write path is now live: before serialising, the body is
 * run through {@link generateWikilinks} (catalog-aware via `opts.ner`) so
 * `[[wikilinks]]` are inserted incrementally; after the atomic rename the page
 * is folded into the knowledge graph ({@link addPageToGraph}) and the
 * MiniSearch index ({@link updateSearchIndex}) so backlinks, wikilink edges,
 * orphan detection, and search all stay current instead of going stale between
 * manual rebuilds. The graph/index updates are incremental (single-page
 * add/discard, not a full rebuild) to bound write amplification, and can be
 * disabled with `opts.maintainDerived = false` for batch callers.
 *
 * Accepts either an options object or, for backward compatibility, a bare
 * `wikiDir` string as the second argument (the historical signature).
 */
export async function writePage(page: WikiPage, opts?: WritePageOptions | string): Promise<void> {
  const options: WritePageOptions = typeof opts === "string" ? { wikiDir: opts } : (opts ?? {});
  const wikiDir = options.wikiDir;
  const maintainDerived = options.maintainDerived !== false;

  await ensureWikiDirs(wikiDir);

  // ADR-0054 R3/R1: auto-insert wikilinks against existing page slugs before
  // serialising, so harvested/synthesised pages participate in the graph from
  // the moment they are written. Skipped when derived maintenance is disabled.
  let body = page.content;
  if (maintainDerived) {
    const knownSlugs = await collectKnownSlugs(wikiDir);
    if (knownSlugs.size > 0) {
      body = generateWikilinks(body, knownSlugs, options.ner);
    }
  }

  // ADR-0054 R4: confidence is persisted as the canonical enum. Normalise any
  // legacy numeric value (or numeric string) to the enum before serialising so
  // the on-disk frontmatter is always one of low|medium|high.
  const normalizedConfidence = normalizeConfidence(page.confidence);

  const metadata: Record<string, unknown> = {
    title: page.title,
    type: page.type,
    slug: page.slug,
    tags: page.tags,
    sources: page.sources,
    backlinks: page.backlinks,
    created: page.created,
    updated: page.updated,
  };
  if (normalizedConfidence !== undefined) {
    metadata.confidence = normalizedConfidence;
  }
  // ADR-0020 frontmatter fields (ADR-0054 R4). Only serialise when present so
  // pages that never set them stay diff-clean.
  if (page.entities !== undefined) {
    metadata.entities = page.entities;
  }
  if (page.coverage !== undefined) {
    metadata.coverage = page.coverage;
  }
  if (page.supersedes !== undefined) {
    metadata.supersedes = page.supersedes;
  }
  if (page.superseded_by !== undefined) {
    metadata.superseded_by = page.superseded_by;
  }
  if (page.agent_id !== undefined) {
    metadata.agent_id = page.agent_id;
  }

  const content = serializeFrontmatter(metadata, body);
  const filePath = pagePath(page.slug, page.type, wikiDir);

  // Atomic write
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, filePath);

  if (!maintainDerived) return;

  // ── Live derived-artifact maintenance (ADR-0054 R1) ──
  // The page written above (with wikilinks inserted) is the source of truth for
  // the graph and index. Build a normalised in-memory copy so callers' objects
  // are not mutated and downstream consumers see the enum confidence.
  const persisted: WikiPage = {
    ...page,
    content: body,
    ...(normalizedConfidence !== undefined ? { confidence: normalizedConfidence } : {}),
  };

  // Knowledge graph: incremental single-page fold-in (extracts wikilink +
  // entity-mention edges and refreshes backlinks). Best-effort — a graph write
  // failure must not lose the page that was already durably written.
  try {
    const graph = await loadGraph(wikiDir);
    await addPageToGraph(persisted, graph, options.ner);
    await saveGraph(graph, wikiDir);
  } catch {
    /* derived artifact — page is already persisted; rebuild can recover */
  }

  // Search index: incremental discard+add (not a full rebuild).
  try {
    await updateSearchIndex(persisted, wikiDir);
  } catch {
    /* derived artifact — searchPages falls back to a rebuild on next load */
  }
}

/** Read a wiki page by slug. Searches all type subdirectories. */
export async function readPage(slug: string, wikiDir?: string): Promise<WikiPage | null> {
  for (const type of Object.keys(PAGE_SUBDIRS) as WikiPageType[]) {
    const filePath = pagePath(slug, type, wikiDir);
    try {
      const raw = await readFile(filePath, "utf-8");
      return parseWikiPage(raw, slug);
    } catch (err: unknown) {
      if (isNotFound(err)) continue;
      throw err;
    }
  }
  return null;
}

/** Delete a wiki page by slug. Returns true if found and deleted. */
export async function deletePage(slug: string, wikiDir?: string): Promise<boolean> {
  for (const type of Object.keys(PAGE_SUBDIRS) as WikiPageType[]) {
    const filePath = pagePath(slug, type, wikiDir);
    try {
      await rm(filePath);
      return true;
    } catch (err: unknown) {
      if (isNotFound(err)) continue;
      throw err;
    }
  }
  return false;
}

/** List all wiki pages, optionally filtered by type and/or tag */
export async function listPages(filter?: {
  type?: WikiPageType;
  tag?: string;
  wikiDir?: string;
}): Promise<WikiPage[]> {
  const pages: WikiPage[] = [];
  const types = filter?.type ? [filter.type] : (Object.keys(PAGE_SUBDIRS) as WikiPageType[]);

  for (const type of types) {
    const dir = pageDir(type, filter?.wikiDir);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err: unknown) {
      if (isNotFound(err)) continue;
      throw err;
    }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const slug = file.replace(/\.md$/, "");
      try {
        const raw = await readFile(join(dir, file), "utf-8");
        const page = parseWikiPage(raw, slug);
        if (page) {
          if (filter?.tag && !page.tags.includes(filter.tag)) continue;
          pages.push(page);
        }
      } catch {
        // Skip malformed pages
      }
    }
  }

  return pages;
}

/** Parse raw markdown+frontmatter into a WikiPage */
function parseWikiPage(raw: string, fallbackSlug: string): WikiPage | null {
  const { metadata, body } = parseFrontmatter(raw);

  const slug = (metadata.slug as string) ?? fallbackSlug;
  const title = (metadata.title as string) ?? slug;
  const type = (metadata.type as WikiPageType) ?? "entity";
  const tags = Array.isArray(metadata.tags) ? (metadata.tags as string[]) : [];
  const sources = Array.isArray(metadata.sources) ? (metadata.sources as string[]) : [];
  const backlinks = Array.isArray(metadata.backlinks) ? (metadata.backlinks as string[]) : [];
  const created = (metadata.created as string) ?? new Date().toISOString();
  const updated = (metadata.updated as string) ?? created;
  // ADR-0054 R4 one-time migration: pre-R4 pages stored a numeric confidence;
  // normalise whatever is on disk (number, enum string, or numeric string) to
  // the canonical enum so reads never break across the schema change.
  const confidence = normalizeConfidence(metadata.confidence);
  const agent_id = typeof metadata.agent_id === "string" ? metadata.agent_id : undefined;

  // ADR-0020 frontmatter fields (ADR-0054 R4).
  const entities = Array.isArray(metadata.entities) ? (metadata.entities as string[]) : undefined;
  const coverage = typeof metadata.coverage === "number" ? metadata.coverage : undefined;
  const supersedes = typeof metadata.supersedes === "string" ? metadata.supersedes : undefined;
  const superseded_by =
    typeof metadata.superseded_by === "string" ? metadata.superseded_by : undefined;

  return {
    slug,
    title,
    type,
    content: body,
    tags,
    sources,
    backlinks,
    created,
    updated,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(entities !== undefined ? { entities } : {}),
    ...(coverage !== undefined ? { coverage } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
    ...(superseded_by !== undefined ? { superseded_by } : {}),
    ...(agent_id ? { agent_id } : {}),
  };
}

// ── MiniSearch BM25 ─────────────────────────────────────────────

const MINISEARCH_OPTIONS = {
  fields: ["title", "content", "tags_joined"] as string[],
  storeFields: ["title", "type", "tags", "updated", "slug"] as string[],
  searchOptions: { boost: { title: 2, tags_joined: 1.5 }, fuzzy: 0.2, prefix: true },
  idField: "slug" as const,
  extractField: (doc: WikiPage, fieldName: string) => {
    if (fieldName === "tags_joined") {
      return doc.tags.join(" ");
    }
    return (doc as unknown as Record<string, unknown>)[fieldName] as string;
  },
};

function createMiniSearchInstance(): MiniSearch<WikiPage> {
  return new MiniSearch<WikiPage>(MINISEARCH_OPTIONS);
}

/** Search wiki pages using BM25 via MiniSearch */
export async function searchPages(
  query: string,
  limit = 20,
  wikiDir?: string,
): Promise<Array<{ page: WikiPage; score: number }>> {
  if (!query.trim()) return [];

  const index = await loadSearchIndex(wikiDir);
  const allResults = index.search(query);
  const results = allResults.slice(0, limit);

  // Load full pages for each result
  const out: Array<{ page: WikiPage; score: number }> = [];
  for (const result of results) {
    const page = await readPage(result.id as string, wikiDir);
    if (page) {
      out.push({ page, score: result.score });
    }
  }
  return out;
}

/** Rebuild the MiniSearch index from all pages on disk */
export async function rebuildSearchIndex(wikiDir?: string): Promise<void> {
  const pages = await listPages({ wikiDir });
  const index = createMiniSearchInstance();
  index.addAll(pages);
  await saveSearchIndex(index, wikiDir);
}

/** Load the serialized MiniSearch index, or rebuild if missing */
export async function loadSearchIndex(wikiDir?: string): Promise<MiniSearch<WikiPage>> {
  try {
    const raw = await readFile(searchIndexPath(wikiDir), "utf-8");
    const data = JSON.parse(raw);
    return MiniSearch.loadJSON<WikiPage>(JSON.stringify(data), MINISEARCH_OPTIONS);
  } catch {
    // Index doesn't exist or is corrupt — rebuild
    await rebuildSearchIndex(wikiDir);
    // Try loading again after rebuild
    try {
      const raw = await readFile(searchIndexPath(wikiDir), "utf-8");
      const data = JSON.parse(raw);
      return MiniSearch.loadJSON<WikiPage>(JSON.stringify(data), MINISEARCH_OPTIONS);
    } catch {
      // Return empty index
      return createMiniSearchInstance();
    }
  }
}

/** Save the MiniSearch index to disk */
export async function saveSearchIndex(
  index: MiniSearch<WikiPage>,
  wikiDir?: string,
): Promise<void> {
  await ensureWikiDirs(wikiDir);
  const data = index.toJSON();
  const filePath = searchIndexPath(wikiDir);
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, filePath);
}

/** Update the search index after adding/modifying a page */
async function updateSearchIndex(page: WikiPage, wikiDir?: string): Promise<void> {
  const index = await loadSearchIndex(wikiDir);
  try {
    index.discard(page.slug);
  } catch {
    // Page wasn't in index yet
  }
  // Need to vacuum after discard to reclaim space
  index.vacuum();
  index.add(page);
  await saveSearchIndex(index, wikiDir);
}

/** Remove a page from the search index */
async function removeFromSearchIndex(slug: string, wikiDir?: string): Promise<void> {
  const index = await loadSearchIndex(wikiDir);
  try {
    index.discard(slug);
    index.vacuum();
    await saveSearchIndex(index, wikiDir);
  } catch {
    // Page wasn't in index
  }
}

// ── Legacy compatibility layer ──────────────────────────────────
// Maps KnowledgeEntry CRUD to wiki pages internally.

/** Convert a KnowledgeEntry to a WikiPage */
function entryToPage(entry: KnowledgeEntry): WikiPage {
  const slug = entry.id;
  const now = new Date().toISOString();
  return {
    slug,
    title: entry.content.split("\n")[0].slice(0, 100) || entry.entity_type,
    type: "entity",
    content: `${entry.content}\n\n${entry.context ? `> Context: ${entry.context}\n` : ""}`,
    tags: [...entry.tags, entry.entity_type],
    sources: entry.source.session_id ? [entry.source.session_id] : [],
    backlinks: entry.references,
    created: entry.extracted_at,
    updated: entry.provenance?.last_modified ?? now,
    confidence: entry.confidence,
    // Round-trip the agent_id via page frontmatter so agent-scoped filters
    // (queryEntries({agent_id}), synthesizeContext({agentId})) work.
    ...(entry.source.agent_id ? { agent_id: entry.source.agent_id } : {}),
  };
}

/** Convert a WikiPage back to a KnowledgeEntry (best-effort) */
function pageToEntry(page: WikiPage): KnowledgeEntry {
  // Extract entity_type from tags (first matching known type)
  const knownTypes: EntityType[] = [
    "fact",
    "procedure",
    "preference",
    "relationship",
    "capability",
  ];
  const entityType: EntityType =
    (page.tags.find((t) => knownTypes.includes(t as EntityType)) as EntityType) ?? "fact";
  const tags = page.tags.filter((t) => !knownTypes.includes(t as EntityType));

  // Split content back into content + context
  const contentParts = page.content.split("\n\n> Context: ");
  const content = contentParts[0].trim();
  const context = contentParts.length > 1 ? contentParts[1].replace(/\n$/, "") : "";

  const now = new Date().toISOString();
  return {
    id: page.slug,
    source: {
      type: page.sources.length > 0 ? "session_harvest" : "manual",
      session_id: page.sources[0],
      // Preserve agent_id across the round-trip so queryEntries filters work.
      ...(page.agent_id ? { agent_id: page.agent_id } : {}),
      timestamp: page.created,
    },
    extracted_at: page.created,
    // KnowledgeEntry.confidence is numeric (0.0-1.0). page.confidence is now
    // the ADR-0020 enum (ADR-0054 R4) — map it back to a representative score.
    // Tolerate a stray legacy number too.
    confidence:
      typeof page.confidence === "number"
        ? page.confidence
        : page.confidence !== undefined
          ? confidenceToScore(page.confidence)
          : 0.5,
    entity_type: entityType,
    content,
    context,
    tags,
    references: page.backlinks,
    provenance: {
      created_by: "wiki",
      created_at: page.created,
      last_modified: page.updated,
      modification_history: [{ timestamp: page.created, action: "created", by: "wiki" }],
      verified: false,
    },
  };
}

// ── Legacy CRUD (backward compatible) ───────────────────────────

/** Add a knowledge entry (creates a wiki page internally) */
export async function addEntry(entry: KnowledgeEntry): Promise<void> {
  // Check for duplicate
  const existing = await readPage(entry.id);
  if (existing) {
    throw new Error(`Entry with id "${entry.id}" already exists`);
  }

  const page = entryToPage(entry);
  // writePage now maintains the search index + graph on the write path
  // (ADR-0054 R1), so the previously-separate updateSearchIndex call here is
  // redundant and would double-write the index.
  await writePage(page);
}

/** Get a single entry by ID */
export async function getEntry(id: string): Promise<KnowledgeEntry | null> {
  const page = await readPage(id);
  if (!page) return null;
  return pageToEntry(page);
}

/** Update an entry by ID with partial data */
export async function updateEntry(id: string, updates: Partial<KnowledgeEntry>): Promise<void> {
  const page = await readPage(id);
  if (!page) {
    throw new Error(`Entry "${id}" not found`);
  }

  const existing = pageToEntry(page);
  const updated = { ...existing, ...updates, id };
  const updatedPage = entryToPage(updated);

  // Delete old page first (in case type changed)
  await deletePage(id);
  // writePage maintains the search index + graph on the write path (ADR-0054
  // R1); no separate updateSearchIndex call needed.
  await writePage(updatedPage);
}

/** Delete an entry by ID */
export async function deleteEntry(id: string): Promise<void> {
  const deleted = await deletePage(id);
  if (!deleted) {
    throw new Error(`Entry "${id}" not found`);
  }
  await removeFromSearchIndex(id);
}

/** Query entries using structured filters */
export async function queryEntries(filter: KnowledgeFilter): Promise<KnowledgeEntry[]> {
  const pages = await listPages();
  let entries = pages.map(pageToEntry);

  if (filter.entity_type) {
    entries = entries.filter((e) => e.entity_type === filter.entity_type);
  }

  if (filter.tags && filter.tags.length > 0) {
    const filterTags = new Set(filter.tags);
    entries = entries.filter((e) => e.tags.some((t) => filterTags.has(t)));
  }

  if (filter.agent_id) {
    entries = entries.filter((e) => e.source.agent_id === filter.agent_id);
  }

  if (filter.min_confidence !== undefined) {
    entries = entries.filter((e) => e.confidence >= filter.min_confidence!);
  }

  if (filter.max_confidence !== undefined) {
    entries = entries.filter((e) => e.confidence <= filter.max_confidence!);
  }

  if (filter.after) {
    const afterDate = new Date(filter.after).getTime();
    entries = entries.filter((e) => new Date(e.extracted_at).getTime() >= afterDate);
  }

  if (filter.before) {
    const beforeDate = new Date(filter.before).getTime();
    entries = entries.filter((e) => new Date(e.extracted_at).getTime() <= beforeDate);
  }

  if (filter.query) {
    const q = filter.query.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.content.toLowerCase().includes(q) ||
        e.context.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  return entries;
}

/** Full-text search using MiniSearch BM25 */
export async function searchEntries(query: string): Promise<KnowledgeEntry[]> {
  if (!query.trim()) return [];

  const results = await searchPages(query, 100);
  return results.map((r) => pageToEntry(r.page));
}

/** Rebuild the wiki index from all entries (legacy compat) */
export async function rebuildIndex(wikiDir?: string): Promise<WikiIndex> {
  const pages = await listPages({ wikiDir });
  const entries = pages.map(pageToEntry);

  const tags: Record<string, number> = {};
  const entityTypes: Record<EntityType, number> = {
    fact: 0,
    procedure: 0,
    preference: 0,
    relationship: 0,
    capability: 0,
  };
  const agentIdSet = new Set<string>();

  for (const entry of entries) {
    for (const tag of entry.tags) {
      tags[tag] = (tags[tag] ?? 0) + 1;
    }
    entityTypes[entry.entity_type] = (entityTypes[entry.entity_type] ?? 0) + 1;
    if (entry.source.agent_id) {
      agentIdSet.add(entry.source.agent_id);
    }
  }

  const index: WikiIndex = {
    version: 1,
    entry_count: entries.length,
    last_updated: new Date().toISOString(),
    tags,
    entity_types: entityTypes,
    agent_ids: Array.from(agentIdSet).sort(),
  };

  // Also rebuild the MiniSearch index
  await rebuildSearchIndex(wikiDir);

  return index;
}

/** Get the current wiki index */
export async function getIndex(wikiDir?: string): Promise<WikiIndex> {
  return rebuildIndex(wikiDir);
}

/** Get all entries */
export async function getAllEntries(wikiDir?: string): Promise<KnowledgeEntry[]> {
  const pages = await listPages({ wikiDir });
  return pages.map(pageToEntry);
}
