/**
 * Skill → agent dependency closure (R2/297e).
 *
 * A Claude-Code-style skill body (SKILL.md text) can delegate work to a
 * named subagent via the `Task` tool, e.g.:
 *
 *     Task(subagent_type='hyperresearch-fetcher', ...)
 *     Task(subagent_type="code-reviewer")
 *
 * or, in prose / instructions, a bare `subagent_type='...'` reference. When a
 * skill names a subagent that the catalog does not provide, the skill is
 * broken the moment it runs: the Task call references an agent that doesn't
 * exist. Nothing in `am status` / `am doctor` flagged this before — this
 * parser is the detection primitive those surfaces cross-check against the
 * catalog's known agents.
 *
 * The parser is text-only and read-only: it never resolves or fetches the
 * referenced agent, it just extracts the de-duplicated set of `subagent_type`
 * names that appear in the body. It matches both single- and double-quoted
 * values and tolerates whitespace around the `=`/`:` separator.
 *
 * This is deliberately independent of the portability scanner
 * (`src/core/portability.ts`) — different signal, different parser.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig } from "./resolved";

// Matches a `subagent_type` reference and captures the quoted agent name.
//
// Covers the two shapes the seed calls out:
//   - `Task(subagent_type='name')`  / `Task(subagent_type="name")`
//   - bare `subagent_type='name'`   / `subagent_type: "name"`
//
// We anchor on the `subagent_type` keyword (not on `Task(`) so a reference
// written in prose or a YAML-ish list is still caught; the optional `Task(`
// prefix is naturally absorbed because we don't require it. The separator may
// be `=` or `:` (TOML/YAML/kwarg styles all appear in the wild) with optional
// surrounding whitespace. The value is a single- or double-quoted string; we
// capture whichever quote style was used and the inner name.
const SUBAGENT_TYPE_RE = /subagent_type\s*[:=]\s*(['"])([^'"]+)\1/g;

/**
 * Extract the de-duplicated list of agent names a skill body references via
 * `subagent_type='...'` / `Task(subagent_type="...")`.
 *
 * @param body Raw SKILL.md text (or any skill body string).
 * @returns Referenced agent names in first-seen order, de-duplicated. Empty
 *   array for a body with no `subagent_type` references (or empty input).
 */
export function parseSkillAgentRefs(body: string): string[] {
  if (!body) return [];

  const seen = new Set<string>();
  const refs: string[] = [];

  // Fresh lastIndex — the regex is global so it can collect every match.
  SUBAGENT_TYPE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard global-regex iteration.
  while ((m = SUBAGENT_TYPE_RE.exec(body)) !== null) {
    const name = m[2].trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      refs.push(name);
    }
    // Defensive: a zero-length match would stall the loop. The pattern always
    // consumes at least the keyword + quotes, but keep the guard anyway.
    if (m.index === SUBAGENT_TYPE_RE.lastIndex) SUBAGENT_TYPE_RE.lastIndex++;
  }

  return refs;
}

/** A skill that references an agent the catalog does not provide. */
export interface MissingSkillDep {
  /** Catalog name of the skill whose body holds the dangling reference. */
  skill: string;
  /** The referenced `subagent_type` name that no catalog agent satisfies. */
  agent: string;
}

/**
 * Build the set of agent identifiers a catalog provides, so a skill's
 * `subagent_type` reference can be resolved.
 *
 * A reference is considered satisfied if it matches EITHER the agent's catalog
 * key name OR its declared `subagent_type` value. In Claude Code these are
 * usually the same string, but agents may set an explicit `subagent_type`
 * distinct from their catalog name, so we accept both to avoid false positives.
 */
function knownAgentIdentifiers(resolved: ResolvedConfig): Set<string> {
  const known = new Set<string>();
  for (const [name, agent] of Object.entries(resolved.agents ?? {})) {
    known.add(name);
    if (agent.subagent_type) known.add(agent.subagent_type);
  }
  return known;
}

/**
 * Read a skill's SKILL.md body. `path` is the skill directory (the convention
 * `am add skill` stores: a directory containing SKILL.md). Returns the file
 * text, or `undefined` if the body cannot be read — an unreadable/absent body
 * is treated as "no references" rather than a hard error, mirroring the
 * best-effort body reads elsewhere (import portability lint, etc.).
 */
function readSkillBody(skillPath: string): string | undefined {
  if (!skillPath) return undefined;
  try {
    return readFileSync(join(skillPath, "SKILL.md"), "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Cross-check every catalog skill's `subagent_type` references against the
 * catalog's known agents and return the dangling ones.
 *
 * For each skill in `resolved.skills`, read its SKILL.md body, parse the
 * `subagent_type` references, and emit a {@link MissingSkillDep} for each
 * referenced agent that no catalog agent provides. Findings are returned in
 * skill order, then reference order within a skill, de-duplicated per
 * (skill, agent) pair. Skills with unreadable bodies or no references
 * contribute nothing.
 *
 * This is the shared detection primitive behind `am status` (the
 * `missing-deps` envelope field + human warning) and `am doctor` (the
 * skill→agent dependency Check).
 */
export function findMissingSkillAgentDeps(resolved: ResolvedConfig): MissingSkillDep[] {
  const known = knownAgentIdentifiers(resolved);
  const missing: MissingSkillDep[] = [];

  for (const [skillName, skill] of Object.entries(resolved.skills ?? {})) {
    const body = readSkillBody(skill.path);
    if (!body) continue;
    for (const agent of parseSkillAgentRefs(body)) {
      if (!known.has(agent)) {
        missing.push({ skill: skillName, agent });
      }
    }
  }

  return missing;
}
