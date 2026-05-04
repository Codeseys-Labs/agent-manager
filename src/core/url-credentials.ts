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
const PLACEHOLDER_VALUE = /^(?:\$\{[A-Z0-9_]+\}|\{\{[A-Z0-9_]+\}\}|<[A-Z0-9_]+>)$/;

export interface CredentialHit {
  /** Server name in the catalog */
  serverName: string;
  /** Full URL where the credential was found */
  url: string;
  /** Query param key that triggered the rule */
  queryKey: string;
  /** Redacted preview of the value (first 6 chars + …) */
  redactedValue: string;
  /** Suggested env-var name to replace it with */
  suggestedEnvVar: string;
}

export interface ServerLike {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Scan one URL string for credential-bearing query params. Returns [] when
 * the URL is credential-free (or not a URL at all). The caller (scanServers)
 * tacks on the server name.
 */
export function scanUrlForCredentials(url: string): Array<Omit<CredentialHit, "serverName">> {
  const hits: Array<Omit<CredentialHit, "serverName">> = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return hits; // not a URL, skip
  }
  const params = parsed.searchParams;
  for (const [key, value] of params.entries()) {
    if (!CREDENTIAL_QUERY_KEYS.some((re) => re.test(key))) continue;
    if (PLACEHOLDER_VALUE.test(value)) continue; // explicit interpolation
    if (value.length < 8) continue; // too short to be a real key
    hits.push({
      url,
      queryKey: key,
      redactedValue: `${value.slice(0, 6)}…`,
      suggestedEnvVar: `\${${key.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}}`,
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
  servers: Record<string, ServerLike & { adapters?: Record<string, Record<string, unknown>> }>,
): CredentialHit[] {
  const hits: CredentialHit[] = [];
  for (const [serverName, server] of Object.entries(servers ?? {})) {
    const urls: string[] = [];
    if (server.command && /^https?:\/\//i.test(server.command)) urls.push(server.command);
    // REV-NB-2 (2026-05-03): the Codex-CLI style passes the MCP URL via
    // `args`, not `command` (e.g. `{ command: "npx", args: ["mcp-remote",
    // "https://…?api_key=…"] }`). Walk every arg that parses as a URL.
    for (const arg of server.args ?? []) {
      if (typeof arg === "string" && /^https?:\/\//i.test(arg)) urls.push(arg);
    }
    // Adapter-specific url fields
    for (const adapter of Object.values(server.adapters ?? {})) {
      if (typeof adapter?.url === "string" && /^https?:\/\//i.test(adapter.url)) {
        urls.push(adapter.url);
      }
    }
    for (const url of urls) {
      for (const h of scanUrlForCredentials(url)) hits.push({ ...h, serverName });
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
    u.searchParams.set(queryKey, envVar);
    // Mask every OTHER credential-shaped param so the displayed URL is
    // safe to copy verbatim.
    for (const [k, _v] of u.searchParams.entries()) {
      if (k === queryKey) continue;
      if (CREDENTIAL_QUERY_KEYS.some((re) => re.test(k))) {
        u.searchParams.set(k, "***REDACTED***");
      }
    }
    // searchParams.set percent-encodes `${VAR}` → `%24%7BVAR%7D`. Undo
    // that for the human-readable hint — ${VAR} is what the user has to
    // type into their TOML verbatim.
    return u.toString().replace(encodeURIComponent(envVar), envVar);
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
    lines.push(
      `  servers.${h.serverName}.command = "${buildSuggestedReplacementUrl(
        h.url,
        h.queryKey,
        h.suggestedEnvVar,
      )}"`,
    );
  }
  lines.push("", "Then set the env var at run time (never commit the real value).");
  return lines.join("\n");
}
