/**
 * Shared adapter utilities — reduces duplication across all 13 adapters.
 *
 * Common helpers for diff comparison, file I/O, and marker-based content splicing.
 */

import type { ResolvedServer } from "../types.ts";

// ── Marker constants ────────────────────────────────────────────

export const AM_BEGIN = "<!-- am:begin -->";
export const AM_END = "<!-- am:end -->";

// ── Line-ending normalization ───────────────────────────────────

/**
 * Normalize line endings to LF.
 *
 * Managed instruction blocks are always written with `\n`, but native files
 * read on Windows arrive with `\r\n` (and legacy files may use lone `\r`).
 * Comparing the two byte-for-byte produces permanent false drift on every
 * internal newline. Normalize both operands with this helper before comparing.
 */
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ── Sort / Normalize ────────────────────────────────────────────

/** Sort keys of an object for deterministic comparison. */
export function sortKeys<T extends Record<string, unknown>>(obj: T): T {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted as T;
}

/** Normalize a value for comparison (deep sort for objects/arrays). */
export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return sortKeys(value as Record<string, unknown>);
  return value;
}

// ── Server field comparison ─────────────────────────────────────

interface NativeServerLike {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  [key: string]: unknown;
}

/**
 * Compare a resolved server against a native server object, returning field-level diffs.
 *
 * Handles both stdio servers (command/args/env) and HTTP URL-based servers.
 * For HTTP servers, detected via `native.url`, `native.type === "http"`,
 * or `expected.transport` being "streamable-http" or "sse", the URL is compared
 * against `expected.command` (or an adapter-specific URL override).
 */
export function compareServerFields(
  expected: ResolvedServer,
  native: NativeServerLike,
  options?: { urlOverride?: string },
): { field: string; expected: unknown; actual: unknown }[] {
  const diffs: { field: string; expected: unknown; actual: unknown }[] = [];

  const isHttp =
    native.type === "http" ||
    !!native.url ||
    expected.transport === "streamable-http" ||
    expected.transport === "sse";

  if (isHttp) {
    // HTTP servers: compare URL only
    const expectedUrl = options?.urlOverride ?? expected.command;
    if (expectedUrl !== native.url) {
      diffs.push({
        field: "url",
        expected: expectedUrl,
        actual: native.url,
      });
    }
    return diffs;
  }

  // stdio servers: compare command, args, env
  if (expected.command !== (native.command ?? "")) {
    diffs.push({
      field: "command",
      expected: expected.command,
      actual: native.command ?? "",
    });
  }

  // Compare args (normalize: treat missing as [])
  const expectedArgs = expected.args ?? [];
  const nativeArgs = native.args ?? [];
  if (JSON.stringify(normalize(expectedArgs)) !== JSON.stringify(normalize(nativeArgs))) {
    diffs.push({
      field: "args",
      expected: expectedArgs,
      actual: nativeArgs,
    });
  }

  // Compare env (normalize: treat missing as {})
  const expectedEnv = expected.env ?? {};
  const nativeEnv = native.env ?? {};
  if (JSON.stringify(sortKeys(expectedEnv)) !== JSON.stringify(sortKeys(nativeEnv))) {
    diffs.push({
      field: "env",
      expected: expectedEnv,
      actual: nativeEnv,
    });
  }

  return diffs;
}

// ── File I/O helpers ────────────────────────────────────────────

/** Check if a file exists synchronously. */
export function fileExistsSync(path: string): boolean {
  try {
    require("node:fs").accessSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Read and parse a JSON file, returning null if missing or unparseable. */
export function readJsonFile(path: string): unknown | null {
  try {
    const fs = require("node:fs");
    const text = fs.readFileSync(path, "utf-8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Marker-based content splicing ───────────────────────────────

/**
 * Splice a managed block into existing content, preserving content outside
 * markers.
 *
 * Marker handling is fail-closed (H3) — mirrors the guard in
 * `core/instructions.ts`. The previous implementation spliced whenever *both*
 * an `am:begin` and an `am:end` existed regardless of order or pairing, which
 * corrupted user files in two ways:
 *   1. Out-of-order markers (`am:end` before `am:begin`): `after` started
 *      before `beginIdx`, dropping the region between the real markers and
 *      scrambling the surviving content.
 *   2. A single unpaired marker: the both-present guard was false, so it fell
 *      through to the append branch and emitted a SECOND managed block.
 *
 * We now only splice when the markers are well-formed
 * (`begin !== -1 && end !== -1 && end > begin`). When markers are PRESENT but
 * MALFORMED we refuse: return `existingContent` UNCHANGED and, when a
 * `warnings` sink is supplied, push a diagnostic for the caller to surface.
 *
 * @param label  Human-readable file label used in warnings (e.g. "AGENTS.md").
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
