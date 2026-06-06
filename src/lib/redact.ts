/**
 * Secret redaction utilities for logs, error envelopes, and config dumps.
 *
 * Used by the MCP server (src/mcp/server.ts) to avoid leaking secrets into
 * tool responses or error messages returned to untrusted MCP clients.
 */

/**
 * Redact a TOML-style config object in place, replacing encrypted values
 * (any `enc:` envelope — legacy `enc:v1:` AES-GCM or ADR-0042 `enc:v2:age:`)
 * with the placeholder "[encrypted]".
 *
 * This is a structural redactor — it walks the tree and only touches strings
 * matching the encrypted sentinel. Non-encrypted secrets (plaintext API keys
 * in env maps, etc.) should be caught by `redactSecretish` applied to the
 * output text, not this helper.
 *
 * The sentinel match is the broad `enc:` prefix (not just `enc:v1:`) so that
 * v2 age ciphertext is never leaked through MCP `config_show`, and so any
 * future envelope format is redacted by default rather than by omission.
 */
export function redactConfigSecrets(obj: unknown): unknown {
  if (typeof obj === "string" && obj.startsWith("enc:")) return "[encrypted]";
  if (Array.isArray(obj)) return obj.map(redactConfigSecrets);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, redactConfigSecrets(v)]),
    );
  }
  return obj;
}

/**
 * Defense-in-depth redactor for config dumps that may carry PLAINTEXT secrets.
 *
 * `redactConfigSecrets` only rewrites `enc:`-prefixed envelopes. A secret added
 * by hand, or imported before the encryption key existed, lives in the config
 * as a bare plaintext string (e.g. `settings.env.TAVILY_API_KEY = "tvly-..."`,
 * `servers.foo.env.OPENAI_API_KEY = "sk-..."`). Those pass through
 * `redactConfigSecrets` VERBATIM — the exact data the MCP auth gate is meant to
 * protect.
 *
 * Strategy (most reliable first):
 *   1. Redact-by-KEY: any object property literally named `env` whose value is
 *      an object is treated as an environment map. EVERY string value inside it
 *      is masked to "[redacted]" regardless of shape. This catches novel secret
 *      formats that no regex would match, and covers `settings.env`,
 *      `servers.*.env`, `profiles.*.env`, and `agents.*.variants.*.env`
 *      uniformly. Already-redacted `enc:`/`[encrypted]` placeholders are left
 *      intact so the v1/v2 envelope signal survives.
 *   2. Backstop: every OTHER string leaf is run through `redactSecretish`, so a
 *      secret-shaped value living outside an env map (a URL with an embedded
 *      token, an Authorization header field, etc.) is still masked.
 *
 * Returns a new structure; does not mutate the input. Intended to run AFTER
 * `redactConfigSecrets` on its output, before the config crosses the MCP trust
 * boundary in `am_config_show`.
 */
/**
 * Substrings that mark an object-property name as holding a first-class secret
 * OUTSIDE an `env`/`headers` map and NOT reliably secret-shaped (so the
 * redactSecretish backstop would miss it). Reviews R2-SEC3 + R4-MED1:
 * `settings.a2a.auth_token`, header `Authorization`, AND opaque values under
 * schema-permitted passthrough/adapters keys like `apiToken`,
 * `customBackendCreds`, `my_auth_token` all leaked. We match by SUBSTRING
 * (case-insensitive, separators stripped) so `apiToken`, `clientSecret`,
 * `backendCredential`, `xApiKey` are all caught — over-redaction of a benign
 * key containing "token"/"secret" is an acceptable trade for a config dump that
 * crosses a trust boundary.
 */
const SECRET_KEY_SUBSTRINGS = [
  "token",
  "secret",
  "password",
  "passphrase",
  "cred", // matches `cred`, `creds`, `credential(s)`
  "apikey",
  "authorization",
  "privatekey",
];

/** True when a property name looks like it holds a secret (substring match). */
function isSecretKeyName(key: string): boolean {
  const norm = key.toLowerCase().replace(/[_-]/g, "");
  return SECRET_KEY_SUBSTRINGS.some((s) => norm.includes(s));
}

/**
 * Object keys whose VALUE is an entirely-secret-bearing map (every string leaf
 * masked by location): `env`, `headers`, and the `adapters` passthrough subtable
 * (R4-MED1 — adapters extras can carry token-ish keys with opaque values that
 * no shape regex matches).
 */
const SECRET_MAP_KEYS = new Set(["env", "headers", "adapters"]);

/**
 * Strip the `user:password@` (or `:token@`) userinfo segment from any URL-shaped
 * string, replacing it with `[redacted]@`. Git remotes and MCP server URLs can
 * embed a live credential (e.g. `https://x-access-token:ghp_xxx@github.com/...`)
 * that no token-shape regex reliably catches. Non-URL strings pass through
 * unchanged. Used both as a config-leaf pass and (via SECRET_PATTERNS) on
 * free-form error text.
 */
/**
 * Query-param key names that carry a credential in a URL. Mirrors
 * CREDENTIAL_QUERY_KEYS in src/core/url-credentials.ts (the APPLY-time scanner,
 * GitHub issue #3) so the config-DISCLOSURE boundary masks the same params the
 * apply boundary already strips — e.g. `?tavilyApiKey=tvly-…` (R4-SEC1).
 */
const CREDENTIAL_QUERY_KEY_RE = [
  /^[a-z]+[_-]?api[_-]?key$/i,
  /^api[_-]?key$/i,
  /^access[_-]?token$/i,
  /^auth[_-]?token$/i,
  /^(?:access[_-]?)?key$/i,
  /^token$/i,
  /^secret$/i,
  /^password$/i,
  /^(?:client[_-]?)?secret$/i,
];

/**
 * Strip embedded credentials from a URL-shaped string: both the
 * `scheme://user:token@host` userinfo segment AND credential-bearing query
 * params (`?tavilyApiKey=…`, `?token=…`). Non-URL strings, and URLs without
 * credentials, pass through unchanged.
 */
export function stripUrlUserinfo(text: string): string {
  // 1) userinfo: scheme://userinfo@host — everything between `://` and the `@`
  //    that precedes the host. Conservative: require a scheme + a host char
  //    after `@` so we don't maul `a@b` prose.
  let out = text.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/g,
    (_m, scheme) => `${scheme}[redacted]@`,
  );
  // 2) credential query params. Only attempt when the string looks like a URL
  //    with a query; parse via URL so we touch only param VALUES, then restore.
  if (out.includes("://") && out.includes("?")) {
    try {
      const u = new URL(out);
      let changed = false;
      for (const key of [...u.searchParams.keys()]) {
        if (CREDENTIAL_QUERY_KEY_RE.some((re) => re.test(key))) {
          u.searchParams.set(key, "[redacted]");
          changed = true;
        }
      }
      if (changed) {
        // URL re-encodes `[redacted]` brackets to %5B…%5D — undo so the marker
        // is human-legible, matching the userinfo replacement above.
        out = u.toString().replace(/%5Bredacted%5D/gi, "[redacted]");
      }
    } catch {
      // Not a parseable absolute URL → leave the userinfo-stripped form as-is.
    }
  }
  return out;
}

export function redactConfigPlaintextSecrets(obj: unknown): unknown {
  const walk = (value: unknown, inSecretSlot = false): unknown => {
    if (typeof value === "string") {
      // Preserve structural redaction markers untouched.
      if (value === "[encrypted]" || value === "[redacted]") return value;
      if (value.startsWith("enc:")) return value;
      // Inside an env map or a known secret-named slot, the value IS a secret
      // by location — mask it whole regardless of shape.
      if (inSecretSlot) return "[redacted]";
      // Outside secret slots: strip any embedded URL credential, then mask
      // secret-SHAPED substrings.
      return redactSecretish(stripUrlUserinfo(value));
    }
    if (Array.isArray(value)) {
      return value.map((v) => walk(v, inSecretSlot));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => {
          const key = k.toLowerCase();
          // env/headers/adapters objects are entirely secret-bearing-by-location
          // slots; a scalar property whose NAME looks like a secret is a secret
          // slot too (substring match — apiToken, clientSecret, etc.).
          const isSecretMap = SECRET_MAP_KEYS.has(key) && v !== null && typeof v === "object";
          const isNamedSecretScalar = isSecretKeyName(k) && typeof v === "string";
          // R4-LOW: a secret used as a KEY NAME (e.g. `[tokens]` with a
          // ghp_… key) must be masked too — the walker only ever transformed
          // values, never keys. Scrub secret-shaped key text.
          const safeKey = redactSecretish(stripUrlUserinfo(k));
          return [safeKey, walk(v, inSecretSlot || isSecretMap || isNamedSecretScalar)];
        }),
      );
    }
    return value;
  };
  return walk(obj);
}

/**
 * Patterns that match common secret formats seen in error messages and logs.
 *
 * These are intentionally greedy on the value side — we prefer false positives
 * (over-redaction) to false negatives (leaked secrets). Ordering matters:
 * more specific patterns first so they win before the generic fallbacks.
 *
 * Wave B (2026-04-16) additions:
 *   - SSH/PEM private keys (OpenSSH, RSA, EC, DSA, ENCRYPTED) — multiline
 *   - JWT tokens (eyJ.eyJ.sig)
 *   - xoxp/xoxa/xoxr Slack tokens that include dots and underscores
 *
 * Deliberately NOT added:
 *   - Generic high-entropy base64 (>= 40 chars of `[A-Za-z0-9+/=]`). The
 *     hit rate is too low vs. false positives: UUIDs-in-base64, opaque
 *     request IDs, container image digests, CSP nonces, workload identity
 *     tokens (non-secret), and many public certs all match. Over-redaction
 *     would strip useful diagnostic context from error envelopes and make
 *     user-reported bugs harder to reproduce. The targeted patterns above
 *     catch the credential families we actually care about.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // Encrypted sentinel from src/core/secrets.ts. Must match the FULL envelope
  // so no ciphertext body survives:
  //   - v2 age:     enc:v2:age:<b64>
  //   - v1 AES-GCM: enc:v1:<iv_b64>:<ct_b64>  — TWO base64 segments joined by a
  //     colon. The optional `(?::[A-Za-z0-9+/=_-]+)?` tail swallows the iv:ct
  //     join; without it the match stopped at the iv and leaked <ct_b64>
  //     (pre-existing bug surfaced in the Wave 2 review).
  // v2 must precede the generic v-arm so `enc:v2:age:...` isn't half-matched.
  { re: /enc:v2:age:[A-Za-z0-9+/=_-]+/g, replace: "[encrypted]" },
  { re: /enc:v\d+:[A-Za-z0-9+/=_-]+(?::[A-Za-z0-9+/=_-]+)?/g, replace: "[encrypted]" },
  // SSH/PEM private keys — multiline, non-greedy body. Must precede generic
  // Bearer/sk- rules so we don't half-redact the body. The `m` flag lets `.`
  // match newlines under the `s` flag (dotall).
  {
    re: /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED |PGP |)PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |EC |DSA |ENCRYPTED |PGP |)PRIVATE KEY-----/g,
    replace: "[REDACTED_PRIVATE_KEY]",
  },
  // JWT tokens: three dot-separated base64url segments, first starts with
  // `eyJ` (the `{"` header). Minimum lengths guard against matching e.g.
  // `eyJ.eyJ.X` random short strings.
  {
    re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
    replace: "[REDACTED_JWT]",
  },
  // URL userinfo: scheme://user:token@host → scheme://[redacted]@host. Git
  // remotes and MCP server URLs embed live credentials here; error envelopes
  // (e.g. a failed `git push` to https://x-access-token:ghp_xxx@host) would
  // otherwise echo the token verbatim (Wave-4 review R3-SEC).
  {
    re: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/g,
    replace: "$1[redacted]@",
  },
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
  // Slack tokens (xox[baprs]-...) — extended character class to cover the
  // newer xoxp/xoxa/xoxr token formats that include `.` and `_` in the
  // trailing segment.
  { re: /\bxox[baprs]-[A-Za-z0-9._-]{10,}\b/g, replace: "[REDACTED_SLACK_TOKEN]" },
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
