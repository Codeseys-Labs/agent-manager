/**
 * Path-segment sanitization for write-path safety (WAVE SEC / SEC-1, SEC-2).
 *
 * Several code paths derive a filesystem path segment from a user- or
 * catalog-controlled string — entity names in IDE adapter exports
 * (`src/adapters/*\/export.ts`) and wiki page slugs (`src/wiki/storage.ts`).
 * Without sanitization a name like `../../evil` or `/etc/passwd` escapes the
 * intended target directory when passed to `path.join`.
 *
 * Two entry points:
 *   - {@link sanitizePathSegment} — best-effort coercion to a single safe
 *     segment. Replaces every disallowed character, collapses leading dots,
 *     and guarantees a non-empty result. Use when a slightly-mangled but
 *     contained filename is acceptable (the historical adapter behaviour).
 *   - {@link assertSafePathSegment} — strict gate. Throws on clearly-malicious
 *     input (path separators, `..`, leading `/`, null bytes, empty). Use when
 *     a caller would rather fail loudly than silently rewrite a name.
 *
 * Both treat the segment as a *single* path component: directory separators
 * are never allowed to survive.
 */

/** Thrown by {@link assertSafePathSegment} for clearly-malicious input. */
export class UnsafePathSegmentError extends Error {
  constructor(
    public readonly segment: string,
    reason: string,
  ) {
    super(`Unsafe path segment ${JSON.stringify(segment)}: ${reason}`);
    this.name = "UnsafePathSegmentError";
  }
}

/** Characters that must never appear in a single path segment. */
// Forward slash, backslash, and NUL. (Drive/colon handling is covered by the
// generic replacement in sanitizePathSegment.)
const PATH_SEPARATOR_RE = /[/\\\0]/;

/**
 * Return true iff `segment` is unsafe to use as a single path component:
 * empty/whitespace, contains a path separator or null byte, is a `.`/`..`
 * traversal token, or begins with a separator.
 */
export function isUnsafePathSegment(segment: string): boolean {
  if (typeof segment !== "string") return true;
  if (segment.length === 0) return true;
  if (PATH_SEPARATOR_RE.test(segment)) return true;
  // `.` and `..` are traversal/self tokens; any name that is only dots is
  // rejected (e.g. `...`).
  if (/^\.+$/.test(segment)) return true;
  return false;
}

/**
 * Strict gate: throw {@link UnsafePathSegmentError} when `segment` cannot be
 * safely used as a single filename, otherwise return it unchanged.
 */
export function assertSafePathSegment(segment: string, label = "name"): string {
  if (typeof segment !== "string" || segment.length === 0) {
    throw new UnsafePathSegmentError(String(segment), `${label} is empty`);
  }
  if (segment.includes("\0")) {
    throw new UnsafePathSegmentError(segment, "contains a null byte");
  }
  if (segment.includes("/") || segment.includes("\\")) {
    throw new UnsafePathSegmentError(segment, "contains a path separator");
  }
  if (/^\.+$/.test(segment)) {
    throw new UnsafePathSegmentError(segment, "is a path-traversal token");
  }
  if (segment.includes("..")) {
    throw new UnsafePathSegmentError(segment, "contains '..'");
  }
  return segment;
}

/**
 * Best-effort coercion of `segment` to a single safe path component.
 *
 * - Replaces every character outside `[A-Za-z0-9._-]` with `-` (this strips
 *   path separators, null bytes, colons, and shell metacharacters).
 * - Collapses any run of dots so the result can never be `.`, `..`, or contain
 *   a `..` parent-dir token, and strips leading dots so it is never a hidden
 *   file or traversal token.
 * - Guarantees a non-empty result by falling back to `fallback` (default
 *   `"unnamed"`) when sanitization would otherwise yield an empty string.
 *
 * The output is guaranteed to satisfy {@link isUnsafePathSegment} === false.
 */
export function sanitizePathSegment(segment: string, fallback = "unnamed"): string {
  let s = typeof segment === "string" ? segment : "";
  // Collapse anything that isn't a conservative filename character. This maps
  // path separators (`/`, `\`), null bytes, colons, and shell metacharacters
  // to `-`.
  s = s.replace(/[^A-Za-z0-9._-]/g, "-");
  // Collapse any run of dots to a single dot so we can never produce a `..`
  // (parent-dir) token anywhere in the segment.
  s = s.replace(/\.{2,}/g, ".");
  // Strip leading dots so we never produce `.`, `.hidden`, or a hidden file.
  s = s.replace(/^\.+/, "");
  // Collapse runs of separator dashes and trim them from the ends for tidiness.
  s = s.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (s.length === 0 || /^\.+$/.test(s)) {
    s = fallback;
  }
  return s;
}
