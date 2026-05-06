/**
 * Shared validation for `am pair accept|finalize` device names.
 *
 * Run K Phase-8 review (gpt-5.5 + gemini + deepseek intersection) flagged
 * that pair-finalize was missing input validation, allowing path
 * traversal via ../../etc/passwd. This module is the canonical name
 * validator; both pair-accept and pair-finalize import from here so
 * the rules cannot drift.
 *
 * The regex matches the same shape the AgeSecretsBackend uses for
 * recipient ids: alphanumeric + `.` `_` `-`. Path separators, `..`,
 * shell metacharacters, control chars, and unicode are all rejected.
 *
 * Cross-references:
 *   - ADRs/0047-am-pair-cross-device-key-handoff.md (Phase-1 design)
 *   - src/core/secrets-age.ts (parseRecipientFile id parsing)
 */

import { AmError } from "../lib/errors";

export const VALID_PAIR_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Maximum length for a device name. Filesystem ENAMETOOLONG kicks in
 * around 255; we cap well below that to avoid OS-error leakage. */
export const MAX_PAIR_NAME_LENGTH = 64;

export function validatePairName(raw: unknown, verbLabel: "accept" | "finalize"): string {
  const tag = verbLabel === "accept" ? "PAIR_ACCEPT" : "PAIR_FINALIZE";
  if (typeof raw !== "string" || raw.length === 0) {
    throw new AmError(
      `am pair ${verbLabel}: <name> argument is required.`,
      `Example: am pair ${verbLabel} laptop-2`,
      `${tag}_MISSING_NAME`,
    );
  }
  if (raw.length > MAX_PAIR_NAME_LENGTH) {
    throw new AmError(
      `am pair ${verbLabel}: name '${raw.slice(0, 32)}...' exceeds ${MAX_PAIR_NAME_LENGTH} characters.`,
      "Use a shorter device label.",
      `${tag}_NAME_TOO_LONG`,
    );
  }
  if (raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
    throw new AmError(
      `am pair ${verbLabel}: invalid name '${raw}' (path separators and '..' are not allowed).`,
      "Use a plain device label like 'laptop-2' or 'desktop-alice'.",
      `${tag}_INVALID_NAME`,
    );
  }
  if (!VALID_PAIR_NAME_RE.test(raw)) {
    throw new AmError(
      `am pair ${verbLabel}: invalid name '${raw}' (only A-Z, a-z, 0-9, '.', '_', '-' are allowed).`,
      "Use a plain device label like 'laptop-2' or 'desktop-alice'.",
      `${tag}_INVALID_NAME`,
    );
  }
  return raw;
}
