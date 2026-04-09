/**
 * Rule-based Named Entity Recognition for code-domain entities (ADR-0020).
 *
 * Extracts structured entities from text using patterns optimized for
 * developer documentation and agent session transcripts. No ML dependencies —
 * code-domain entities (file paths, package names, config keys, etc.) are
 * highly structured and regex-catchable.
 */

import type { EntityCategory, ExtractedEntity } from "./types";

// ── Known tool names ────────────────────────────────────────────

const KNOWN_TOOLS = [
  "Claude Code",
  "Codex CLI",
  "Cursor",
  "GitHub Copilot",
  "Windsurf",
  "ForgeCode",
  "Kilo Code",
  "Kiro",
  "Gemini CLI",
  "Cline",
  "Roo Code",
  "Amazon Q",
  "Continue.dev",
  "VS Code",
  "Visual Studio Code",
  "IntelliJ",
  "Neovim",
  "Vim",
  "Emacs",
  "MiniSearch",
  "MCP",
  "Zod",
  "Bun",
  "Node.js",
  "TypeScript",
  "JavaScript",
  "React",
  "Hono",
  "Silvery",
];

// ── Pattern definitions ─────────────────────────────────────────

interface EntityPattern {
  type: EntityCategory;
  regex: RegExp;
  /** Optional validator to filter false positives */
  validate?: (match: string) => boolean;
}

/**
 * File extensions commonly found in code projects.
 * Used to validate file path matches.
 */
const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|toml|yaml|yml|md|css|scss|html|sh|bash|py|rs|go|rb|java|c|cpp|h|hpp|xml|sql|graphql|gql|vue|svelte|astro|lock|env|gitignore|dockerignore|editorconfig)$/;

const PATTERNS: EntityPattern[] = [
  // URLs: https://... or http://...
  // Match before file paths to avoid partial matches
  {
    type: "url",
    regex: /https?:\/\/[^\s)<>,;"'`]+/g,
  },

  // File paths: /src/foo/bar.ts, ./relative/path.js, src/adapters/types.ts
  // Must contain at least one / and end with a recognized extension, or start with ./ or /
  {
    type: "file_path",
    regex: /(?:\.\.?\/|\/)?(?:[\w@.-]+\/)+[\w.-]+\.[\w]+/g,
    validate: (match) => {
      // Must have a code-like extension or be a clearly recognizable path
      if (CODE_EXTENSIONS.test(match)) return true;
      // Accept paths starting with ./ or / even without a known extension
      if (match.startsWith("./") || match.startsWith("/") || match.startsWith("../")) return true;
      return false;
    },
  },

  // Package names: @scope/package, @scope/package-name
  {
    type: "package_name",
    regex: /@[\w-]+\/[\w.-]+/g,
  },

  // Config keys: [servers.tavily], [profiles.work], settings.mcp_serve.allow_push
  // TOML section headers
  {
    type: "config_key",
    regex: /\[[\w.-]+(?:\.[\w.-]+)*\]/g,
  },

  // Dotted config keys in prose: settings.mcp_serve, servers.tavily.command
  {
    type: "config_key",
    regex: /(?:^|[\s(,])([a-z_][\w]*(?:\.[a-z_][\w]*){1,5})(?=[\s),.:;]|$)/gm,
    validate: (match) => {
      // Filter out common false positives
      const lower = match.trim();
      if (lower.startsWith("e.g") || lower.startsWith("i.e")) return false;
      // Must have at least 2 dotted segments
      return lower.split(".").length >= 2;
    },
  },

  // CLI commands: am add server, am apply --dry-run, bun test, npm install
  {
    type: "cli_command",
    regex:
      /(?:^|\s)((?:am|bun|npm|npx|bunx|yarn|pnpm|node|deno|git|docker|curl|wget)\s+[\w][\w ./-]*)/gm,
    validate: (match) => {
      // Must be more than just the command prefix
      const trimmed = match.trim();
      return trimmed.includes(" ") && trimmed.length >= 6;
    },
  },

  // Function names: buildResolvedConfig(), detectAdapter(), resolveProfile()
  // camelCase or PascalCase followed by ()
  {
    type: "function_name",
    regex: /\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[A-Z][a-zA-Z0-9]+)\(\)/g,
  },

  // Also match function_name without parens when used with backticks: `buildResolvedConfig`
  {
    type: "function_name",
    regex: /`([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[A-Z][a-zA-Z0-9]+)`/g,
  },
];

// ── Entity extraction ───────────────────────────────────────────

/**
 * Extract structured entities from text using rule-based patterns.
 * Returns deduplicated entities sorted by span position.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];

  // Extract tool names first (exact string matching)
  for (const tool of KNOWN_TOOLS) {
    let startIdx = 0;
    while (true) {
      const idx = text.indexOf(tool, startIdx);
      if (idx === -1) break;

      // Ensure word boundary: character before (if any) must not be alphanumeric
      if (idx > 0 && /\w/.test(text[idx - 1])) {
        startIdx = idx + 1;
        continue;
      }
      // Character after (if any) must not be alphanumeric (unless the tool name ends with special char)
      const endIdx = idx + tool.length;
      if (endIdx < text.length && /\w/.test(text[endIdx]) && /\w$/.test(tool)) {
        startIdx = idx + 1;
        continue;
      }

      entities.push({
        text: tool,
        type: "tool_name",
        span: [idx, endIdx],
      });
      startIdx = endIdx;
    }
  }

  // Extract regex-based entities
  for (const pattern of PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);

    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      // Use capture group 1 if it exists, otherwise full match
      const captured = match[1] ?? match[0];
      const capturedStart =
        match[1] !== undefined ? match.index + match[0].indexOf(match[1]) : match.index;
      const capturedEnd = capturedStart + captured.length;

      const trimmed = captured.trim();
      if (!trimmed) continue;

      // Apply optional validator
      if (pattern.validate && !pattern.validate(trimmed)) continue;

      entities.push({
        text: trimmed,
        type: pattern.type,
        span: [capturedStart, capturedEnd],
      });
    }
  }

  return deduplicateEntities(entities);
}

/**
 * Deduplicate entities, preferring longer matches when spans overlap.
 * For identical spans, prefer the more specific type.
 */
function deduplicateEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  if (entities.length <= 1) return entities;

  // Sort by start position, then by length descending (prefer longer matches)
  const sorted = [...entities].sort((a, b) => {
    if (a.span[0] !== b.span[0]) return a.span[0] - b.span[0];
    return b.span[1] - b.span[0] - (a.span[1] - a.span[0]);
  });

  const result: ExtractedEntity[] = [];
  let lastEnd = -1;

  for (const entity of sorted) {
    // Skip if this entity is completely contained within the previous one
    if (entity.span[0] < lastEnd && entity.span[1] <= lastEnd) continue;

    // Skip exact duplicates (same text and type)
    if (
      result.some(
        (r) => r.text === entity.text && r.type === entity.type && r.span[0] === entity.span[0],
      )
    ) {
      continue;
    }

    result.push(entity);
    if (entity.span[1] > lastEnd) {
      lastEnd = entity.span[1];
    }
  }

  return result;
}

// ── Wikilink generation ─────────────────────────────────────────

/**
 * Generate [[wikilinks]] from extracted entities against known page slugs.
 * Only links the first occurrence of each entity per document.
 */
export function generateWikilinks(text: string, knownSlugs: Set<string>): string {
  if (knownSlugs.size === 0) return text;

  const entities = extractEntities(text);
  const linked = new Set<string>();
  let result = text;
  let offset = 0;

  // Sort by span position for in-order replacement
  const sorted = [...entities].sort((a, b) => a.span[0] - b.span[0]);

  for (const entity of sorted) {
    const slug = entityToSlug(entity.text);
    if (!knownSlugs.has(slug)) continue;
    if (linked.has(slug)) continue;

    // Don't link inside existing [[...]] or code blocks
    const adjustedStart = entity.span[0] + offset;
    const before = result.slice(Math.max(0, adjustedStart - 2), adjustedStart);
    if (before.endsWith("[[") || before.endsWith("`")) continue;

    const original = result.slice(adjustedStart, entity.span[1] + offset);
    const replacement = `[[${original}]]`;
    result = result.slice(0, adjustedStart) + replacement + result.slice(entity.span[1] + offset);
    offset += replacement.length - original.length;
    linked.add(slug);
  }

  return result;
}

// ── Slug generation ─────────────────────────────────────────────

/** Convert entity text to a slug suitable for wiki page filename */
export function entityToSlug(entity: string): string {
  return entity
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
