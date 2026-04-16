/**
 * Shared instruction generation for all output formats.
 *
 * Each adapter calls these functions instead of duplicating format logic.
 * Content resolution (inline vs file) is handled once here.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedInstruction } from "../adapters/types.ts";

const AM_BEGIN = "<!-- am:begin -->";
const AM_END = "<!-- am:end -->";

// ── Content Resolution ──────────────────────────────────────────

/**
 * Resolve instruction content from inline `content` or `content_file`.
 * If content_file, reads relative to configDir.
 */
export function resolveInstructionContent(
  instruction: { content?: string; content_file?: string },
  configDir: string,
): string {
  if (instruction.content) {
    return instruction.content;
  }
  if (instruction.content_file) {
    const absPath = resolve(configDir, instruction.content_file);
    return readFileSync(absPath, "utf-8");
  }
  throw new Error("Instruction must have either content or content_file");
}

// ── Target Filtering ────────────────────────────────────────────

/**
 * Filter instructions by target adapter name.
 * Instructions with no targets (empty array) match all targets.
 */
export function filterByTarget(
  instructions: Record<string, ResolvedInstruction>,
  target: string,
): Record<string, ResolvedInstruction> {
  const result: Record<string, ResolvedInstruction> = {};
  for (const [name, instr] of Object.entries(instructions)) {
    if (instr.targets.length === 0 || instr.targets.includes(target)) {
      result[name] = instr;
    }
  }
  return result;
}

// ── Marker-based Formats (CLAUDE.md, AGENTS.md) ────────────────

/**
 * Generate managed content block for CLAUDE.md.
 * Concatenates all instruction content, wrapped in am markers.
 * Preserves content outside markers in existingContent.
 */
export function generateClaudeMd(
  instructions: Record<string, ResolvedInstruction>,
  existingContent?: string,
): string {
  const parts: string[] = [];
  for (const [, instr] of Object.entries(instructions)) {
    parts.push(instr.content);
  }
  if (parts.length === 0) return existingContent ?? "";

  const managedContent = parts.join("\n\n");
  const block = `${AM_BEGIN}\n${managedContent}\n${AM_END}`;

  return spliceMarkerBlock(block, existingContent);
}

/**
 * Generate managed content block for AGENTS.md.
 * Same marker-based approach as CLAUDE.md.
 */
export function generateAgentsMd(
  instructions: Record<string, ResolvedInstruction>,
  existingContent?: string,
): string {
  const parts: string[] = [];
  for (const [, instr] of Object.entries(instructions)) {
    parts.push(instr.content);
  }
  if (parts.length === 0) return existingContent ?? "";

  const managedContent = parts.join("\n\n");
  const block = `${AM_BEGIN}\n${managedContent}\n${AM_END}`;

  return spliceMarkerBlock(block, existingContent);
}

/** Splice a managed block into existing content, preserving content outside markers. */
function spliceMarkerBlock(block: string, existingContent?: string): string {
  if (!existingContent) {
    return `${block}\n`;
  }

  const beginIdx = existingContent.indexOf(AM_BEGIN);
  const endIdx = existingContent.indexOf(AM_END);
  if (beginIdx !== -1 && endIdx !== -1) {
    const before = existingContent.slice(0, beginIdx);
    const after = existingContent.slice(endIdx + AM_END.length);
    return before + block + after;
  }

  // No existing markers — append
  return `${existingContent.trimEnd()}\n\n${block}\n`;
}

/**
 * Generate managed content block for GEMINI.md.
 * Same marker-based approach as CLAUDE.md.
 */
export function generateGeminiMd(
  instructions: Record<string, ResolvedInstruction>,
  existingContent?: string,
): string {
  const parts: string[] = [];
  for (const [, instr] of Object.entries(instructions)) {
    parts.push(instr.content);
  }
  if (parts.length === 0) return existingContent ?? "";

  const managedContent = parts.join("\n\n");
  const block = `${AM_BEGIN}\n${managedContent}\n${AM_END}`;

  return spliceMarkerBlock(block, existingContent);
}

// ── Wiki Context Injection ──────────────────────────────────────

const WIKI_BEGIN = "<!-- am:wiki:begin -->";
const WIKI_END = "<!-- am:wiki:end -->";

/**
 * Generate wiki context for injection into instruction files.
 * Returns a formatted markdown section, or empty string if wiki is empty
 * or inject_on_apply is not enabled.
 */
export async function generateWikiContext(
  configDir: string,
  settings?: Record<string, unknown>,
): Promise<string> {
  // Check if inject_on_apply is enabled
  const wikiSettings = settings?.wiki as Record<string, unknown> | undefined;
  if (!wikiSettings?.inject_on_apply) {
    return "";
  }

  // Dynamically import wiki modules to avoid circular dependencies
  try {
    const { listPages } = await import("../wiki/storage.ts");
    const pages = await listPages();

    if (pages.length === 0) {
      return "";
    }

    const { synthesizeContext } = await import("../wiki/synthesizer.ts");
    const context = await synthesizeContext("project knowledge", { topK: 5 });

    if (!context || context.startsWith("No knowledge found")) {
      return "";
    }

    return `${WIKI_BEGIN}\n## Agent Knowledge\n\n${context}\n${WIKI_END}`;
  } catch {
    // Wiki not available (no entries, missing directory, etc.)
    return "";
  }
}

/**
 * Splice a wiki context block into existing content, preserving content
 * outside wiki markers. If no wiki block exists, appends before the am:end marker.
 */
export function spliceWikiBlock(wikiBlock: string, content: string): string {
  if (!wikiBlock) return content;

  const beginIdx = content.indexOf(WIKI_BEGIN);
  const endIdx = content.indexOf(WIKI_END);

  if (beginIdx !== -1 && endIdx !== -1) {
    // Replace existing wiki block
    const before = content.slice(0, beginIdx);
    const after = content.slice(endIdx + WIKI_END.length);
    return before + wikiBlock + after;
  }

  // Insert before the am:end marker if present
  const amEndIdx = content.indexOf(AM_END);
  if (amEndIdx !== -1) {
    const before = content.slice(0, amEndIdx);
    const after = content.slice(amEndIdx);
    return `${before}\n${wikiBlock}\n${after}`;
  }

  // Append to end
  return `${content.trimEnd()}\n\n${wikiBlock}\n`;
}

// ── Cursor .mdc Format ──────────────────────────────────────────

/**
 * Generate a single .mdc file content for Cursor.
 * YAML frontmatter with description, globs, and alwaysApply.
 */
export function generateCursorMdc(instruction: ResolvedInstruction): string {
  const parts: string[] = ["---"];

  if (instruction.description) {
    parts.push(`description: "${instruction.description}"`);
  }

  if (instruction.globs.length > 0) {
    const globsStr = instruction.globs.map((g) => `"${g}"`).join(", ");
    parts.push(`globs: [${globsStr}]`);
  }

  if (instruction.scope === "always") {
    parts.push("alwaysApply: true");
  } else {
    parts.push("alwaysApply: false");
  }

  parts.push("---");
  parts.push("");
  parts.push(instruction.content);

  return `${parts.join("\n")}\n`;
}

// ── Windsurf Rule Format ────────────────────────────────────────

/** Map scope to Windsurf trigger value. */
function scopeToWindsurfTrigger(scope: "always" | "glob" | "agent-decision" | "manual"): string {
  switch (scope) {
    case "always":
      return "always_on";
    case "glob":
      return "glob";
    case "agent-decision":
      return "model_decision";
    case "manual":
      return "manual";
  }
}

/**
 * Generate a single .windsurf/rules/*.md file content.
 * YAML frontmatter with trigger and optional globs.
 */
export function generateWindsurfRule(instruction: ResolvedInstruction): string {
  const trigger = scopeToWindsurfTrigger(instruction.scope);
  let frontmatter = `---\ntrigger: ${trigger}\n`;
  if (instruction.scope === "glob" && instruction.globs.length > 0) {
    frontmatter += `globs: "${instruction.globs.join(",")}"\n`;
  }
  frontmatter += "---\n";

  return `${frontmatter}\n${instruction.content}\n`;
}

// ── Copilot Instruction Format ──────────────────────────────────

/**
 * Generate Copilot instruction file content.
 * - always scope: plain markdown (for copilot-instructions.md)
 * - glob scope: YAML frontmatter with applyTo (for .instructions.md)
 */
export function generateCopilotInstruction(instruction: ResolvedInstruction): string {
  if (instruction.scope === "glob" && instruction.globs.length > 0) {
    const applyTo = instruction.globs.join(",");
    return `---\napplyTo: "${applyTo}"\n---\n\n${instruction.content}\n`;
  }

  // always / agent-decision / manual — plain content
  return `${instruction.content}\n`;
}

// ── Kiro Steering Format ────────────────────────────────────────

/** Map scope to Kiro inclusion mode. */
function scopeToKiroInclusion(scope: "always" | "glob" | "agent-decision" | "manual"): string {
  switch (scope) {
    case "always":
      return "always";
    case "agent-decision":
      return "auto";
    case "glob":
      return "fileMatch";
    case "manual":
      return "manual";
  }
}

/**
 * Generate a single .kiro/steering/*.md file content.
 * YAML frontmatter with inclusion mode, managed content in am markers.
 * Preserves content outside markers in existingContent.
 */
export function generateKiroSteering(
  instruction: ResolvedInstruction,
  existingContent?: string,
): string {
  const inclusion = scopeToKiroInclusion(instruction.scope);
  const managedBlock = `${AM_BEGIN}\n${instruction.content}\n${AM_END}`;

  if (existingContent) {
    const beginIdx = existingContent.indexOf(AM_BEGIN);
    const endIdx = existingContent.indexOf(AM_END);
    if (beginIdx !== -1 && endIdx !== -1) {
      const before = existingContent.slice(0, beginIdx);
      const after = existingContent.slice(endIdx + AM_END.length);
      return before + managedBlock + after;
    }
    return `${existingContent.trimEnd()}\n\n${managedBlock}\n`;
  }

  // New file — generate with frontmatter
  const safeDesc = (instruction.description ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `---\ninclusion: ${inclusion}\ndescription: "${safeDesc}"\n---\n\n${managedBlock}\n`;
}
