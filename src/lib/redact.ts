/**
 * Secret redaction utilities for logs, error envelopes, and config dumps.
 *
 * Used by the MCP server (src/mcp/server.ts) to avoid leaking secrets into
 * tool responses or error messages returned to untrusted MCP clients.
 */

/**
 * Redact a TOML-style config object in place, replacing encrypted values
 * (prefixed with `enc:v1:`) with the placeholder "[encrypted]".
 *
 * This is a structural redactor — it walks the tree and only touches strings
 * matching the encrypted sentinel. Non-encrypted secrets (plaintext API keys
 * in env maps, etc.) should be caught by `redactSecretish` applied to the
 * output text, not this helper.
 */
export function redactConfigSecrets(obj: unknown): unknown {
  if (typeof obj === "string" && obj.startsWith("enc:v1:")) return "[encrypted]";
  if (Array.isArray(obj)) return obj.map(redactConfigSecrets);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, redactConfigSecrets(v)]),
    );
  }
  return obj;
}

/**
 * Patterns that match common secret formats seen in error messages and logs.
 *
 * These are intentionally greedy on the value side — we prefer false positives
 * (over-redaction) to false negatives (leaked secrets). Ordering matters:
 * more specific patterns first so they win before the generic fallbacks.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // Encrypted sentinel from src/core/secrets.ts (enc:v1:<base64>)
  { re: /enc:v1:[A-Za-z0-9+/=_-]+/g, replace: "[encrypted]" },
  // Bearer tokens: "Bearer <token>" or "Authorization: Bearer <token>"
  { re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: "Bearer [REDACTED]" },
  // AWS access key ids (AKIA/ASIA + 16 chars)
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: "[REDACTED_AWS_KEY]" },
  // GitHub personal access tokens (ghp_, gho_, ghu_, ghs_, ghr_ prefixes)
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED_GH_TOKEN]" },
  // Anthropic keys (sk-ant-...)
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replace: "[REDACTED_ANTHROPIC_KEY]" },
  // Generic OpenAI-style keys (sk-... min 20 char body)
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replace: "[REDACTED_API_KEY]" },
  // Google API keys (AIza + 35 chars)
  { re: /\bAIza[A-Za-z0-9_-]{35}\b/g, replace: "[REDACTED_GOOGLE_KEY]" },
  // Slack tokens (xox[baprs]-...)
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: "[REDACTED_SLACK_TOKEN]" },
  // key=value / key: value style where key hints at secret and value is long-ish
  // Must NOT consume the key itself (so we can still see which var was leaked).
  {
    re: /\b(api[_-]?key|apikey|secret|password|token|bearer|authorization|auth)\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})["']?/gi,
    replace: "$1=[REDACTED]",
  },
];

/**
 * Redact secret-shaped substrings from a free-form string (error messages,
 * stack traces, log lines). Returns a new string; does not mutate input.
 *
 * Safe to apply to any user-visible error text before it crosses a trust
 * boundary (MCP response, logs, HTTP body).
 */
export function redactSecretish(text: string): string {
  let out = text;
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Convenience: normalise an `unknown` error into a redacted, human-readable
 * message string. Combines `errorMessage` semantics with `redactSecretish`.
 *
 * Kept separate from `errorMessage` in src/lib/errors.ts so we don't force
 * redaction on CLI error output (which the user already trusts).
 */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecretish(raw);
}
