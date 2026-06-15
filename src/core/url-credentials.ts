/**
 * URL-credential detection (2026-05-03).
 *
 * GitHub issue #3 problem 2: HTTP MCP servers with the API key embedded as
 * a URL query parameter (e.g. `https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-…`)
 * must not be written plaintext to native configs — those files get committed
 * to the user's project repo and leak the key.
 *
 * The fix: scan every server's command/url for credential-bearing query
 * params BEFORE any `adapter.export()` runs. On a hit, refuse the apply
 * with an actionable error that names the offending server + suggests a
 * `${VAR}` substitution. The scan is cheap (regex), runs in the apply
 * pipeline, and shares its detection logic with the future
 * `am mcp superset` command (issue #3 problem 1).
 *
 * Why at the pipeline level and not per-adapter: 13 adapters each render
 * urls slightly differently (cursor.url, copilot.url, codex.url-from-command,
 * …). Scanning the *resolved* config catches them all with one rule set
 * and leaves the adapter writers free to render however they want.
 */

const CREDENTIAL_QUERY_KEYS = [
  /^api[_-]?key$/i,
  /^[a-z]+ApiKey$/i, // tavilyApiKey, exaApiKey
  // Require a separator to avoid false positives on compound nouns like
  // `publickey`, `sandboxkey`, `proxykey` (REV-1 2026-05-03): without the
  // separator, `/^[a-z]+_?key$/i` with case-insensitive matching also
  // trips on benign 8+-char values. The preceding part may itself contain
  // separators (my_access_key, tavily-api-key) — `[a-z][a-z_-]*` covers
  // that while still requiring the terminal `[_-]key`.
  /^[a-z][a-z_-]*[_-]key$/i, // exa_key, tavily_key, my-key, my_access_key
  /^access[_-]?key$/i,
  /^secret$/i,
  /^secret[_-]?key$/i,
  /^token$/i,
  /^auth[_-]?token$/i,
  /^access[_-]?token$/i,
  /^password$/i,
  /^pass$/i,
];

/**
 * Explicit placeholder patterns — values that look like `${VAR}` or
 * `{{TOKEN}}` are explicitly NOT credentials. Users use these for env
 * interpolation; flagging them defeats the entire purpose.
 */
// `${VAR}` / `$${VAR}` (TOML escape for a literal `${VAR}`) / `{{VAR}}` / `<VAR>`.
// Case-insensitive var names. A placeholder is never a leaked credential, so we
// exempt all of these — including the `$$`-escaped literal form — from the scan.
const PLACEHOLDER_VALUE = /^(?:\$\$?\{[A-Za-z0-9_]+\}|\{\{[A-Za-z0-9_]+\}\}|<[A-Za-z0-9_]+>)$/;

export interface CredentialHit {
  /** Server name in the catalog */
  serverName: string;
  /** Full URL where the credential was found */
  url: string;
  /** Query param key that triggered the rule */
  queryKey: string;
  /** Redacted preview of the value (first 6 chars + …) — for display/errors. */
  redactedValue: string;
  /**
   * The RAW credential value. Used by the obfuscate-on-ingest write path to
   * encrypt-and-store the secret under `suggestedEnvVar`. NEVER log/print this —
   * use `redactedValue` for any user-facing output.
   */
  rawValue: string;
  /** Suggested env-var name to replace it with (wrapped `${VAR}` form). */
  suggestedEnvVar: string;
  /**
   * Which field the credential URL lives in, so the write path can rewrite the
   * RIGHT location: `"command"`, `"args"` (with `argIndex`), `"adapter"`
   * (with `adapterName`), or `"env"` (with `envKey`). Without this, an
   * adapter-url hit was mis-rewritten as the command and the plaintext
   * survived (review finding A).
   */
  source: "command" | "args" | "adapter" | "env";
  /** Arg index when `source === "args"`. */
  argIndex?: number;
  /** Adapter name when `source === "adapter"` (e.g. "cursor"). */
  adapterName?: string;
  /** Env-var key when `source === "env"` (e.g. "MCP_ENDPOINT"). */
  envKey?: string;
}

export interface ServerLike {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * True when `key` names a credential (matches any CREDENTIAL_QUERY_KEYS rule).
 * Shared by the query-param scan and the userinfo scan so both honour the same
 * credential-name detection (M7: the length floor is relaxed for these keys).
 */
function isCredentialKey(key: string): boolean {
  return CREDENTIAL_QUERY_KEYS.some((re) => re.test(key));
}

/**
 * Derive a bare (un-wrapped) POSIX env-var name from a query-param key, e.g.
 * `tavilyApiKey` → `TAVILYAPIKEY`, `api_key` → `API_KEY`. The result is a valid
 * `settings.env` key and the base of the `${VAR}` placeholder. Bare (not
 * `${...}`) because the encryption/catalog path stores under this name.
 */
export function deriveBareEnvName(queryKey: string): string {
  return queryKey.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

/**
 * Rewrite ONLY the named query param of `url` to `replacement`, leaving every
 * other param (including sibling credentials) untouched. This is the
 * write-path-safe core: unlike `buildSuggestedReplacementUrl`, it does NOT mask
 * sibling credential params — the ingest pipeline rewrites each hit in its own
 * pass, so masking siblings here would destroy a value we still need to encrypt.
 * `${VAR}`-style replacements are de-percent-encoded so the stored command is
 * literally `?key=${VAR}` (what the interpolation engine expects).
 *
 * Guard: if `queryKey` is NOT an actual query param of the URL, `set()` would
 * APPEND a bogus `?key=replacement` while leaving the real credential (e.g. a
 * `user:pass@` userinfo authority) PLAINTEXT in place — a leak (seed 2ce0).
 * Userinfo credentials must go through `rewriteUserinfoCredential`, not here, so
 * when the key is absent we leave the URL untouched and let the caller's
 * post-check fail closed rather than emit a corrupted-yet-still-leaking URL.
 */
export function rewriteUrlParam(url: string, queryKey: string, replacement: string): string {
  try {
    const u = new URL(url);
    // Only rewrite a key that is genuinely present as a query param. Appending a
    // new param for a non-query key (e.g. a "password" userinfo key) corrupts the
    // URL without removing the real plaintext credential.
    if (!u.searchParams.has(queryKey)) return url;
    u.searchParams.set(queryKey, replacement);
    return u.toString().replace(encodeURIComponent(replacement), replacement);
  } catch {
    return url; // not a URL — leave as-is
  }
}

/**
 * Write-path-safe userinfo-credential rewrite. A userinfo credential
 * (`https://user:s3cret@host`) is NOT a query param, so `rewriteUrlParam` cannot
 * scrub it (it would append a bogus query param and leave `user:s3cret@` in the
 * authority — seed 2ce0). This rewrites the targeted userinfo field
 * (`username` or `password`) DIRECTLY to `replacement`, mirroring the display
 * path in `buildSuggestedReplacementUrl` but WITHOUT masking the sibling field
 * (the ingest loop encrypts each hit in its own pass, so masking the sibling
 * would destroy a value we still need to encrypt).
 *
 * URL setters percent-encode `${VAR}` braces, so the literal placeholder is
 * restored afterwards (what the interpolation engine expects to read back).
 */
export function rewriteUserinfoCredential(
  url: string,
  field: "username" | "password",
  replacement: string,
): string {
  try {
    const u = new URL(url);
    if (field === "password") u.password = replacement;
    else u.username = replacement;
    // The setter percent-encodes the placeholder's braces (e.g. `${VAR}` →
    // `$%7BVAR%7D`); restore the literal form so the stored URL is `user:${VAR}@`.
    const encoded = field === "password" ? u.password : u.username;
    const out = u.toString();
    return encoded && encoded !== replacement ? out.replace(encoded, replacement) : out;
  } catch {
    return url; // not a URL — leave as-is
  }
}

/** A bare URL-credential finding before the caller tags server + location. */
export type UrlCredentialMatch = Pick<
  CredentialHit,
  "url" | "queryKey" | "redactedValue" | "rawValue" | "suggestedEnvVar"
>;

/**
 * Scan one URL string for credential-bearing query params. Returns [] when
 * the URL is credential-free (or not a URL at all). The caller
 * (scanServersForUrlCredentials) tacks on the server name and location source.
 */
export function scanUrlForCredentials(url: string): UrlCredentialMatch[] {
  const hits: UrlCredentialMatch[] = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return hits; // not a URL, skip
  }
  // M7 gap 3: userinfo credentials (https://user:s3cret@host) are never query
  // params, so the loop below would miss them. A non-empty username OR password
  // in the URL authority is a leaked credential — emit a hit before walking the
  // query string. The percent-decoded password (then username) is the raw
  // secret; we synthesize a credential-named queryKey so the env-derivation and
  // formatting paths stay uniform.
  const userinfoSecrets: Array<{ key: string; value: string }> = [];
  if (parsed.password) {
    userinfoSecrets.push({ key: "password", value: decodeURIComponent(parsed.password) });
  }
  if (parsed.username) {
    userinfoSecrets.push({ key: "username", value: decodeURIComponent(parsed.username) });
  }
  for (const { key, value } of userinfoSecrets) {
    if (PLACEHOLDER_VALUE.test(value)) continue; // explicit interpolation
    hits.push({
      url,
      queryKey: key,
      redactedValue: `${value.slice(0, 6)}…`,
      rawValue: value,
      suggestedEnvVar: `\${${deriveBareEnvName(key)}}`,
    });
  }
  const params = parsed.searchParams;
  for (const [key, value] of params.entries()) {
    const credentialNamed = isCredentialKey(key);
    if (!credentialNamed) continue;
    if (PLACEHOLDER_VALUE.test(value)) continue; // explicit interpolation
    // M7 gap 2: the <8 length floor only bounds false positives on
    // NON-credential-named keys. A credential-NAMED key (token/api_key/secret/…)
    // is flagged regardless of length — a short `token=abc123` is still a leak.
    // (All keys reaching here are credential-named, so the floor is dropped;
    // kept conditional for intent + future non-credential heuristics.)
    if (!credentialNamed && value.length < 8) continue;
    hits.push({
      url,
      queryKey: key,
      redactedValue: `${value.slice(0, 6)}…`,
      rawValue: value,
      suggestedEnvVar: `\${${deriveBareEnvName(key)}}`,
    });
  }
  return hits;
}

/**
 * Walk a servers map and collect every URL-credential hit. The `url` source
 * is: (a) the `command` field when it's an http(s) URL (Codex-CLI style),
 * and (b) any `adapters.<name>.url` field (cursor/copilot/kiro style).
 */
export function scanServersForUrlCredentials(
  servers: Record<string, ServerLike & { adapters?: Record<string, unknown> }>,
): CredentialHit[] {
  const hits: CredentialHit[] = [];
  // Each candidate URL carries WHERE it lives, so the write path rewrites the
  // exact field (review finding A: an adapter url was previously mis-tagged as
  // the command and the plaintext survived).
  type Candidate =
    | { url: string; source: "command" }
    | { url: string; source: "args"; argIndex: number }
    | { url: string; source: "adapter"; adapterName: string }
    | { url: string; source: "env"; envKey: string };
  for (const [serverName, server] of Object.entries(servers ?? {})) {
    const candidates: Candidate[] = [];
    if (server.command && /^https?:\/\//i.test(server.command)) {
      candidates.push({ url: server.command, source: "command" });
    }
    // REV-NB-2 (2026-05-03): the Codex-CLI style passes the MCP URL via
    // `args`, not `command` (e.g. `{ command: "npx", args: ["mcp-remote",
    // "https://…?api_key=…"] }`). Walk every arg that parses as a URL.
    (server.args ?? []).forEach((arg, argIndex) => {
      if (typeof arg === "string" && /^https?:\/\//i.test(arg)) {
        candidates.push({ url: arg, source: "args", argIndex });
      }
    });
    // Adapter-specific url fields (cursor/copilot/kiro style).
    for (const [adapterName, rawAdapter] of Object.entries(server.adapters ?? {})) {
      const adapter = rawAdapter as { url?: unknown } | null | undefined;
      if (typeof adapter?.url === "string" && /^https?:\/\//i.test(adapter.url)) {
        candidates.push({ url: adapter.url, source: "adapter", adapterName });
      }
    }
    // M7 gap 1: a credential URL stashed in a server.env value (e.g.
    // `MCP_ENDPOINT=https://…?api_key=…`) was undetected because the scan
    // never iterated env. Walk every env value that parses as a URL.
    for (const [envKey, envValue] of Object.entries(server.env ?? {})) {
      if (typeof envValue === "string" && /^https?:\/\//i.test(envValue)) {
        candidates.push({ url: envValue, source: "env", envKey });
      }
    }
    for (const cand of candidates) {
      for (const h of scanUrlForCredentials(cand.url)) {
        hits.push({
          ...h,
          serverName,
          source: cand.source,
          ...(cand.source === "args" ? { argIndex: cand.argIndex } : {}),
          ...(cand.source === "adapter" ? { adapterName: cand.adapterName } : {}),
          ...(cand.source === "env" ? { envKey: cand.envKey } : {}),
        });
      }
    }
  }
  return hits;
}

/**
 * Build a replacement URL using URL.searchParams.set so ONLY the offending
 * query param is rewritten to the placeholder. Regex replace would edit
 * the first `=([^&]+)` match regardless of which param it belongs to.
 *
 * Additionally (REV-2 strengthening 2026-05-03): any OTHER credential-
 * shaped param in the same URL gets its value masked to ***REDACTED*** in
 * the suggested-fix output, so copy-pasting the hint never exposes a
 * second raw credential.
 */
export function buildSuggestedReplacementUrl(
  url: string,
  queryKey: string,
  envVar: string,
): string {
  try {
    const u = new URL(url);
    // M7 gap 3: userinfo credentials (`https://user:s3cret@host`) are NOT query
    // params, so the searchParams rewrite below would leave the raw
    // `user:s3cret@` in the authority and LEAK it in the displayed fix. Handle
    // userinfo first: rewrite the target field to the placeholder (when the hit
    // IS the userinfo field) and mask the sibling so the displayed URL is safe
    // to copy verbatim. URL setters reject `${VAR}` (it percent-encodes), so we
    // de-percent-encode the placeholder back to its literal form afterwards.
    const userinfoTarget = queryKey === "username" || queryKey === "password";
    // The URL userinfo setter percent-encodes the `${VAR}` braces (e.g.
    // `${PASSWORD}` → `$%7BPASSWORD%7D`). Capture the encoded form the setter
    // actually produced so we can restore the literal placeholder afterwards.
    let encodedPlaceholder = "";
    if (u.username || u.password) {
      if (u.password) {
        u.password = queryKey === "password" ? envVar : "***REDACTED***";
        if (queryKey === "password") encodedPlaceholder = u.password;
      }
      if (u.username) {
        u.username = queryKey === "username" ? envVar : "***REDACTED***";
        if (queryKey === "username") encodedPlaceholder = u.username;
      }
    }
    // Mask every OTHER credential-shaped param so the displayed URL is
    // safe to copy verbatim. (Display-only — the write path uses the
    // non-masking `rewriteUrlParam` instead.)
    for (const [k, _v] of u.searchParams.entries()) {
      if (!userinfoTarget && k === queryKey) continue;
      if (CREDENTIAL_QUERY_KEYS.some((re) => re.test(k))) {
        u.searchParams.set(k, "***REDACTED***");
      }
    }
    if (userinfoTarget) {
      // Target lives in userinfo, not the query string — nothing more to rewrite
      // there. Restore the literal `${VAR}` placeholder (the setter
      // percent-encoded its braces).
      const out = u.toString();
      return encodedPlaceholder ? out.replace(encodedPlaceholder, envVar) : out;
    }
    // Rewrite the target param last, via the shared core (handles the
    // `${VAR}` de-percent-encoding).
    return rewriteUrlParam(u.toString(), queryKey, envVar);
  } catch {
    return url; // fallback: show original if URL parse fails
  }
}

/** Build a human-readable error message from a set of hits. */
export function formatCredentialHits(hits: CredentialHit[]): string {
  if (hits.length === 0) return "";
  const lines: string[] = [
    `refusing to write native configs: ${hits.length} URL credential(s) detected in your catalog`,
    "",
    "Detected:",
  ];
  for (const h of hits) {
    lines.push(
      `  • server "${h.serverName}": query param "${h.queryKey}" = "${h.redactedValue}" in URL`,
    );
  }
  lines.push("", "Fix: replace each credential with an env-var placeholder in config.toml:");
  for (const h of hits) {
    // Point at the ACTUAL field the credential lives in, not always .command
    // (an adapter-url or args credential lives elsewhere — review finding A).
    const field =
      h.source === "adapter"
        ? `servers.${h.serverName}.adapters.${h.adapterName}.url`
        : h.source === "args"
          ? `servers.${h.serverName}.args[${h.argIndex}]`
          : h.source === "env"
            ? `servers.${h.serverName}.env.${h.envKey}`
            : `servers.${h.serverName}.command`;
    lines.push(
      `  ${field} = "${buildSuggestedReplacementUrl(h.url, h.queryKey, h.suggestedEnvVar)}"`,
    );
  }
  lines.push("", "Then set the env var at run time (never commit the real value).");
  return lines.join("\n");
}
