/**
 * Shared instruction generation for all output formats.
 *
 * Each adapter calls these functions instead of duplicating format logic.
 * Content resolution (inline vs file) is handled once here.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedInstruction } from "./resolved.ts";

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
 *
 * When `warnings` is supplied it is threaded into {@link spliceMarkerBlock} so a
 * malformed-marker refusal (fail-closed, H3) surfaces a diagnostic instead of
 * being silently dropped.
 */
export function generateClaudeMd(
  instructions: Record<string, ResolvedInstruction>,
  existingContent?: string,
  warnings?: string[],
): string {
  const parts: string[] = [];
  for (const [, instr] of Object.entries(instructions)) {
    parts.push(instr.content);
  }
  if (parts.length === 0) return existingContent ?? "";

  const managedContent = parts.join("\n\n");
  const block = `${AM_BEGIN}\n${managedContent}\n${AM_END}`;

  return spliceMarkerBlock(block, existingContent, warnings, "CLAUDE.md");
}

/**
 * Generate managed content block for AGENTS.md.
 * Same marker-based approach as CLAUDE.md.
 *
 * When `warnings` is supplied it is threaded into {@link spliceMarkerBlock} so a
 * malformed-marker refusal (fail-closed, H3) surfaces a diagnostic instead of
 * being silently dropped (e.g. the windsurf adapter routes through here).
 */
export function generateAgentsMd(
  instructions: Record<string, ResolvedInstruction>,
  existingContent?: string,
  warnings?: string[],
): string {
  const parts: string[] = [];
  for (const [, instr] of Object.entries(instructions)) {
    parts.push(instr.content);
  }
  if (parts.length === 0) return existingContent ?? "";

  const managedContent = parts.join("\n\n");
  const block = `${AM_BEGIN}\n${managedContent}\n${AM_END}`;

  return spliceMarkerBlock(block, existingContent, warnings, "AGENTS.md");
}

/**
 * Splice a managed block into existing content, preserving content outside
 * markers.
 *
 * Marker handling is fail-closed (H3). The previous implementation spliced
 * whenever *both* an `am:begin` and an `am:end` existed, regardless of order
 * or pairing, which corrupted user files in two ways:
 *   1. Out-of-order markers (`am:end` before `am:begin`): `after` started
 *      before `beginIdx`, so the region between the real markers was dropped
 *      and the surviving content was scrambled.
 *   2. A single unpaired marker: the both-present guard was false, so it fell
 *      through to the append branch and emitted a SECOND managed block.
 *
 * We now only splice when the markers are well-formed
 * (`begin !== -1 && end !== -1 && end > begin`). When markers are PRESENT but
 * MALFORMED we refuse: the function returns `existingContent` UNCHANGED and,
 * when a `warnings` sink is supplied, pushes a diagnostic so the caller can
 * surface it. We never silently splice or append over malformed markers —
 * leaving the file untouched is the only non-destructive option.
 *
 * @param label  Human-readable file label used in warnings (e.g. "CLAUDE.md").
 */
export function spliceMarkerBlock(
  block: string,
  existingContent?: string,
  warnings?: string[],
  label = "instruction file",
): string {
  if (!existingContent) {
    return `${block}\n`;
  }

  const beginIdx = existingContent.indexOf(AM_BEGIN);
  const endIdx = existingContent.indexOf(AM_END);
  const hasBegin = beginIdx !== -1;
  const hasEnd = endIdx !== -1;

  // Well-formed paired markers — splice in place.
  if (hasBegin && hasEnd && endIdx > beginIdx) {
    const before = existingContent.slice(0, beginIdx);
    const after = existingContent.slice(endIdx + AM_END.length);
    return before + block + after;
  }

  // Markers present but malformed (out-of-order or unpaired) — refuse rather
  // than corrupt the file. Return existing content unchanged.
  if (hasBegin || hasEnd) {
    warnings?.push(
      `${label}: refusing to update managed block — am:begin/am:end markers are malformed ` +
        `(${
          hasBegin && hasEnd
            ? "am:end precedes am:begin"
            : hasBegin
              ? "missing am:end"
              : "missing am:begin"
        }). Fix or remove the markers and re-run.`,
    );
    return existingContent;
  }

  // No existing markers — append
  return `${existingContent.trimEnd()}\n\n${block}\n`;
}

/**
 * Generate managed content block for GEMINI.md.
 * Same marker-based approach as CLAUDE.md.
 *
 * When `warnings` is supplied it is threaded into {@link spliceMarkerBlock} so a
 * malformed-marker refusal (fail-closed, H3) surfaces a diagnostic instead of
 * being silently dropped (the gemini-cli adapter routes through here).
 */
export function generateGeminiMd(
  instructions: Record<string, ResolvedInstruction>,
  existingContent?: string,
  warnings?: string[],
): string {
  const parts: string[] = [];
  for (const [, instr] of Object.entries(instructions)) {
    parts.push(instr.content);
  }
  if (parts.length === 0) return existingContent ?? "";

  const managedContent = parts.join("\n\n");
  const block = `${AM_BEGIN}\n${managedContent}\n${AM_END}`;

  return spliceMarkerBlock(block, existingContent, warnings, "GEMINI.md");
}

// ── Wiki Context Injection ──────────────────────────────────────

const WIKI_BEGIN = "<!-- am:wiki:begin -->";
const WIKI_END = "<!-- am:wiki:end -->";

/**
 * Generate wiki context for injection into instruction files (ADR-0054 R7).
 *
 * This is the SINGLE shared caller of {@link buildWikiContext} — every adapter
 * that injects wiki knowledge (claude-code, codex-cli, forgecode, kilo-code)
 * routes through here, so the opt-in gate and task derivation are enforced in
 * ONE place rather than re-promised per adapter.
 *
 * Gate (opt-in, ADR-0054 R7): injection fires only when
 * `settings.wiki.inject_on_apply` is truthy; otherwise this returns "" so a
 * native config is never silently bloated with knowledge.
 *
 * When enabled it delegates to {@link buildWikiContext}, which is task-aware
 * (the query is `settings.wiki.task` when present, else the historical
 * "project knowledge" fallback) and multi-tier (project tier first, then the
 * global tier, de-duped by slug with project winning). The block carries the
 * same `am:wiki` markers {@link spliceWikiBlock} expects, so adapters splice it
 * unchanged. Returns "" when both tiers are empty (cheap skip).
 */
export async function generateWikiContext(
  _configDir: string,
  settings?: Record<string, unknown>,
): Promise<string> {
  // Opt-in gate enforced in code (ADR-0054 R7), not just documented.
  const wikiSettings = settings?.wiki as Record<string, unknown> | undefined;
  if (!wikiSettings?.inject_on_apply) {
    return "";
  }

  // Dynamically import the wiki module to avoid a static core→wiki cycle.
  try {
    const { buildWikiContext } = await import("../wiki/storage.ts");

    // Task-aware: prefer an explicit `settings.wiki.task` query; the project
    // wiki dir is resolved from cwd inside buildWikiContext (project XOR
    // global), and the global tier from configDir. An `agent_id` knob biases
    // retrieval toward that agent's pages when present.
    const task = typeof wikiSettings.task === "string" ? wikiSettings.task : undefined;
    const agentId = typeof wikiSettings.agent_id === "string" ? wikiSettings.agent_id : undefined;

    return await buildWikiContext({
      ...(task ? { task } : {}),
      ...(agentId ? { agentId } : {}),
    });
  } catch {
    // Wiki not available (no entries, missing directory, etc.)
    return "";
  }
}

/**
 * Splice a wiki context block into existing content, preserving content
 * outside wiki markers. If no wiki block exists, appends before the am:end marker.
 *
 * Marker handling is fail-closed, mirroring {@link spliceMarkerBlock} (H3). We
 * only replace an existing wiki block when the markers are well-formed
 * (`begin !== -1 && end !== -1 && end > begin`). When the `am:wiki` markers are
 * PRESENT but MALFORMED (out-of-order or unpaired) we refuse: the function
 * returns `content` UNCHANGED and, when a `warnings` sink is supplied, pushes a
 * diagnostic so the caller can surface it. The previous guard checked only
 * presence (`!== -1`), so a reversed `am:wiki:end`/`am:wiki:begin` pair sliced
 * with `after` starting before `beginIdx`, dropping the content between the real
 * markers and scrambling the file.
 *
 * @param label  Human-readable file label used in warnings (e.g. "AGENTS.md").
 */
export function spliceWikiBlock(
  wikiBlock: string,
  content: string,
  warnings?: string[],
  label = "instruction file",
): string {
  if (!wikiBlock) return content;

  const beginIdx = content.indexOf(WIKI_BEGIN);
  const endIdx = content.indexOf(WIKI_END);
  const hasBegin = beginIdx !== -1;
  const hasEnd = endIdx !== -1;

  // Well-formed paired wiki markers — replace existing wiki block in place.
  if (hasBegin && hasEnd && endIdx > beginIdx) {
    const before = content.slice(0, beginIdx);
    const after = content.slice(endIdx + WIKI_END.length);
    return before + wikiBlock + after;
  }

  // Wiki markers present but malformed (out-of-order or unpaired) — refuse
  // rather than corrupt the file. Return content unchanged.
  if (hasBegin || hasEnd) {
    warnings?.push(
      `${label}: refusing to inject wiki context — am:wiki:begin/am:wiki:end markers are malformed ` +
        `(${
          hasBegin && hasEnd
            ? "am:wiki:end precedes am:wiki:begin"
            : hasBegin
              ? "missing am:wiki:end"
              : "missing am:wiki:begin"
        }). Fix or remove the markers and re-run.`,
    );
    return content;
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
  warnings?: string[],
): string {
  const inclusion = scopeToKiroInclusion(instruction.scope);
  const managedBlock = `${AM_BEGIN}\n${instruction.content}\n${AM_END}`;

  if (existingContent) {
    // Route through the shared splice helper so the fail-closed marker guard
    // (H3) applies identically to Kiro steering files: well-formed markers are
    // replaced in place; malformed (out-of-order / unpaired) markers cause the
    // existing content to be returned UNCHANGED rather than corrupted.
    return spliceMarkerBlock(managedBlock, existingContent, warnings, ".kiro/steering file");
  }

  // New file — generate with frontmatter
  const safeDesc = (instruction.description ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `---\ninclusion: ${inclusion}\ndescription: "${safeDesc}"\n---\n\n${managedBlock}\n`;
}
