/**
 * Tiered secret detection for MCP server configurations.
 *
 * Tier 1 (built-in): Env var key name matching. If a server env key is named
 * something like API_KEY, TOKEN, SECRET, PASSWORD, etc., the value is treated
 * as a secret regardless of its format. This covers the vast majority of MCP
 * server configs, where secrets are passed as named env vars.
 *
 * Tier 2 (betterleaks): For inline secrets in args, command strings, and
 * values where the key name doesn't make it obvious — delegate to betterleaks.
 * It has 200+ rules, BPE tokenization, and CEL validation.
 *
 * The philosophy: am-cli handles structural detection (key names are env vars,
 * env vars have well-known naming conventions). betterleaks handles value-based
 * detection (regex + entropy + tokenization on arbitrary strings).
 */

import {
  type CredentialHit,
  deriveBareEnvName,
  rewriteUrlParam,
  scanServersForUrlCredentials,
} from "./url-credentials";

// ── Tier 1: Env var key name patterns ────────────────────────────────────────
// If a key matches ANY of these, we treat the value as a secret.

const SECRET_KEY_PATTERNS: RegExp[] = [
  // Generic secret indicators
  /api[_-]?key/i,
  /secret/i,
  /\btoken\b/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /\bauth\b/i,

  // Generic suffix-anchored secret indicators. `\b…\b` word boundaries do NOT
  // fire on `_`/`-` (both are word chars), so `/\btoken\b/` misses MY_TOKEN /
  // FOO_AUTH and there was no bare key/pwd pattern at all — FOO_KEY, *_TOKEN,
  // *_PWD slipped through as plaintext while the scan reported clean (false
  // negative → committed credential). Anchor on a `_`/`-`/start prefix and the
  // END of the string so blast radius is bounded to the *suffix* (e.g.
  // LICENSE_KEY / PUBLIC_KEY now match — acceptable, substitution is reversible)
  // rather than a free `key` substring (which would catch KEYBOARD, MONKEY…).
  /(^|[_-])(key|token|secret|password|pass|pwd|credential)$/i,
  // Anchored bearer: matches a bare `BEARER` or a bearer-SUFFIXED key
  // (AUTH_BEARER). A free `/bearer/i` substring match treated config flags as
  // secrets (BEARER_ENABLED, BEARER_TOKEN_TTL) and false-fired on FORBEARER /
  // BEARERTOWN — harmless config encrypted as a credential. Anchoring on a
  // `_`/`-`/start prefix and the END of the string bounds the match to the
  // bearer suffix. BEARER_TOKEN already matches via the `token$` suffix group
  // above, so it stays a secret without re-admitting the false positives.
  /(^|[_-])bearer$/i,

  // Cloud providers
  /aws[_-]secret/i,
  /aws[_-]access/i,

  // AI/LLM providers (env var naming conventions)
  /openai/i,
  /anthropic/i,
  /mistral/i,
  /together/i,
  /fireworks/i,
  /cohere/i,
  /groq/i,
  /replicate/i,
  /hugging/i,
  /perplexity/i,
  /google[_-]ai/i,
  /gemini/i,
  /deepseek/i,

  // Developer tools
  /github/i,
  /gitlab/i,
  /vercel/i,
  /netlify/i,
  /supabase/i,
  /firebase/i,
  /heroku/i,
  /railway/i,
  /fly[_-]?io/i,

  // Communication/SaaS
  /slack/i,
  /discord/i,
  /twilio/i,
  /sendgrid/i,

  // Search/Data
  /tavily/i,
  /algolia/i,
  /pinecone/i,
  /weaviate/i,

  // Payment
  /stripe/i,

  // Databases
  /database[_-]?url/i,
  /\bdb[_-]pass/i,
  /redis[_-]?url/i,
  /mongo[_-]?uri/i,
];

// ── Types ────────────────────────────────────────────────────────────────────

export interface DetectedSecret {
  /** Where the secret was found */
  location: "env" | "args" | "command";
  /** Env var name (if location is env) OR query-param key (if url-credential) */
  key?: string;
  /** The actual secret value */
  value: string;
  /** Arg index (if location is args, including a url-credential found in args) */
  index?: number;
  /** How it was detected */
  source: "key-name" | "betterleaks" | "url-credential";
  /**
   * For a url-credential: where the credential-bearing URL lives. `substituteSecret`
   * uses this to pick the right field to rewrite via `rewriteUrlParam`. `"adapter"`
   * means it lives in `server.adapters[adapterName].url`; `"env"` means it lives
   * in `server.env[envKey]` (M7: a credential URL stashed in an env value).
   */
  urlSource?: "command" | "args" | "adapter" | "env";
  /** Adapter name when urlSource === "adapter". */
  adapterName?: string;
  /** Env-var key when urlSource === "env" (the env entry holding the URL). */
  envKey?: string;
  /** Suggested ${VAR} replacement name (bare name, e.g. TAVILYAPIKEY) */
  suggestedEnvVar: string;
}

export interface SecretScanResult {
  serverName: string;
  secrets: DetectedSecret[];
}

// ── Tier 1: Key-name-based detection ─────────────────────────────────────────

/**
 * Check if an env var key name indicates the value is a secret.
 */
export function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * Tier 1 scan: detect secrets by env var key name.
 * If a key name matches our patterns, the value is a secret. Period.
 * This handles the structural case — MCP servers use named env vars.
 */
export function scanServerEnvVars(
  name: string,
  server: { command: string; args?: string[]; env?: Record<string, string> },
): SecretScanResult {
  const secrets: DetectedSecret[] = [];

  if (!server.env) return { serverName: name, secrets };

  for (const [key, value] of Object.entries(server.env)) {
    // Skip already-templated or encrypted values. Match any `enc:` envelope
    // (legacy `enc:v1:` AES-GCM and ADR-0042 `enc:v2:age:`) so v2 ciphertext
    // is not re-flagged as a plaintext secret.
    if (value.includes("${") || value.startsWith("enc:")) continue;
    // Skip empty/trivial values
    if (value.length === 0 || value === "true" || value === "false") continue;

    if (isSecretKeyName(key)) {
      secrets.push({
        location: "env",
        key,
        value,
        source: "key-name",
        suggestedEnvVar: key, // Use the original key name — it's already a good env var name
      });
    }
  }

  return { serverName: name, secrets };
}

/**
 * Tier 1 scan across all servers.
 */
export function scanConfigEnvVars(
  servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>,
): SecretScanResult[] {
  const results: SecretScanResult[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const result = scanServerEnvVars(name, server);
    if (result.secrets.length > 0) {
      results.push(result);
    }
  }
  return results;
}

// ── Tier 2: BetterLeaks integration ──────────────────────────────────────────

/**
 * Tier 2 scan: shell out to betterleaks for inline secret detection
 * in args, command strings, and env values that Tier 1 didn't catch.
 *
 * Returns null if betterleaks is not available.
 */
export async function scanServerWithBetterleaks(
  name: string,
  server: { command: string; args?: string[]; env?: Record<string, string> },
): Promise<SecretScanResult | null> {
  const { scanWithBetterleaks } = await import("./betterleaks");

  // Build a text representation of the server config for betterleaks to scan
  const lines: string[] = [];
  lines.push(`command = "${server.command}"`);
  if (server.args) {
    for (const arg of server.args) {
      lines.push(`arg = "${arg}"`);
    }
  }
  if (server.env) {
    for (const [key, value] of Object.entries(server.env)) {
      // Skip values already handled by Tier 1, plus any `enc:` envelope
      // (v1 AES-GCM or v2 age) so encrypted ciphertext is never sent to
      // betterleaks as a candidate plaintext secret.
      if (value.includes("${") || value.startsWith("enc:")) continue;
      if (isSecretKeyName(key)) continue; // Tier 1 already caught this
      lines.push(`${key} = "${value}"`);
    }
  }

  const content = lines.join("\n");
  const findings = scanWithBetterleaks(content);
  if (findings === null) return null; // betterleaks not available

  const secrets: DetectedSecret[] = findings.map((f) => ({
    location: "args" as const, // betterleaks findings from the text representation
    value: f.Secret,
    source: "betterleaks" as const,
    suggestedEnvVar: f.RuleID.toUpperCase().replace(/-/g, "_"),
  }));

  return { serverName: name, secrets };
}

// ── Combined scan (Tier 1 + optional Tier 2) ─────────────────────────────────

/**
 * Tier 1.5: URL-embedded credentials (e.g. `?tavilyApiKey=tvly-…` in a server's
 * command/args/adapter url). Tier-1 only looks at env KEY NAMES and Tier-2's
 * betterleaks rules don't reliably match query-param creds, so these would
 * otherwise slip past every audit/ingest path while the apply guard refuses
 * them. We reuse the SAME detector the apply guard uses
 * (`scanServersForUrlCredentials`) and map each hit to a DetectedSecret so URL
 * creds flow through the identical substitute+encrypt+scan lifecycle as env
 * secrets. Bare `suggestedEnvVar` (e.g. TAVILYAPIKEY) matches the env-secret
 * contract (`substituteSecret` wraps it in `${…}`).
 */
export function scanServerForUrlCredentials(
  name: string,
  server: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    adapters?: Record<string, unknown>;
  },
): DetectedSecret[] {
  const hits: CredentialHit[] = scanServersForUrlCredentials({ [name]: server });
  // The hit now carries its exact location (command/args/adapter) from the
  // detector — map it straight through so substituteSecret rewrites the RIGHT
  // field. (Previously this guessed via findIndex and collapsed adapter-url
  // hits to "command", leaving the adapter plaintext — review finding A.)
  return hits.map((h) => ({
    location: "command" as const, // DetectedSecret.location stays "command" for url-credential; urlSource disambiguates
    key: h.queryKey,
    value: h.rawValue,
    source: "url-credential" as const,
    urlSource: h.source,
    ...(h.source === "args" ? { index: h.argIndex } : {}),
    ...(h.source === "adapter" ? { adapterName: h.adapterName } : {}),
    ...(h.source === "env" ? { envKey: h.envKey } : {}),
    suggestedEnvVar: deriveBareEnvName(h.queryKey),
  }));
}

/**
 * Full scan: Tier 1 (key names) always, Tier 1.5 (URL query-param creds), and
 * Tier 2 (betterleaks) when available.
 */
export async function scanServerForSecrets(
  name: string,
  server: { command: string; args?: string[]; env?: Record<string, string> },
): Promise<SecretScanResult> {
  // Tier 1: always runs, zero dependencies
  const tier1 = scanServerEnvVars(name, server);

  // Tier 1.5: URL-embedded query-param credentials (zero dependencies)
  const urlSecrets = scanServerForUrlCredentials(name, server);

  // Tier 2: only if betterleaks is installed
  let tier2: SecretScanResult | null = null;
  try {
    tier2 = await scanServerWithBetterleaks(name, server);
  } catch {
    // betterleaks not available, that's fine
  }

  // Merge: Tier 1 + Tier 1.5 (URL) + any Tier 2 findings not already covered by value.
  const allSecrets = [...tier1.secrets];
  for (const s of urlSecrets) {
    if (!allSecrets.some((e) => e.value === s.value)) allSecrets.push(s);
  }
  if (tier2) {
    for (const secret of tier2.secrets) {
      // Skip if an earlier tier already found this value (e.g. betterleaks
      // re-flags a tavily key the URL tier already mapped to a ${VAR}).
      const alreadyCovered = allSecrets.some((s) => s.value === secret.value);
      if (!alreadyCovered) {
        allSecrets.push(secret);
      }
    }
  }

  return { serverName: name, secrets: allSecrets };
}

/**
 * Synthetic server name used for `settings.env` findings so they flow through
 * the same report/JSON shape as server findings. `settings` is not a valid MCP
 * server name (no server can be named via a reserved word here), so it's a safe
 * sentinel for "this secret lives in [settings.env], not under any server".
 */
export const SETTINGS_ENV_SCOPE = "settings";

/**
 * Full scan of `settings.env` — the global env block (`SettingsSchema.env`,
 * a `Record<string,string>`). `scanConfigForSecrets` only ever looked at
 * `config.servers`, so a plaintext secret stashed in `settings.env` was
 * invisible to `am secret scan` (false-clean → committed credential, M6).
 *
 * Runs the SAME Tier-1 (key name) + Tier-2 (betterleaks) value detection used
 * for `server.env`, by treating the env block as a synthetic server with no
 * command/args (so only the env values are inspected). URL-credential (Tier
 * 1.5) detection is skipped — settings.env holds plain string values, not
 * command/args/adapter URLs.
 *
 * Returns a `SecretScanResult` tagged with the `SETTINGS_ENV_SCOPE` server name
 * (empty `secrets` when nothing is found). Callers MUST surface findings in the
 * same report shape so `formatScanReport`, the JSON output, and the M5 exit-code
 * gate all count them.
 */
export async function scanSettingsEnvForSecrets(
  env: Record<string, string> | undefined,
): Promise<SecretScanResult> {
  return scanServerForSecrets(SETTINGS_ENV_SCOPE, { command: "", env });
}

/**
 * Full scan across all servers.
 */
export async function scanConfigForSecrets(
  servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>,
): Promise<SecretScanResult[]> {
  const results: SecretScanResult[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const result = await scanServerForSecrets(name, server);
    if (result.secrets.length > 0) {
      results.push(result);
    }
  }
  return results;
}

/**
 * Pick a collision-safe `settings.env` key for a URL-credential secret.
 *
 * Two unrelated servers can derive the SAME bare name (both have `?api_key=…` →
 * `API_KEY`) yet hold DIFFERENT secrets. Because `encryptValue` is
 * non-deterministic (random nonce), we cannot compare ciphertexts to tell
 * "same secret, fine to reuse" from "different secret, must not clobber". So we
 * fail safe: if the bare name is already taken, namespace by server name
 * (`<SERVER>_<bare>`), and append a numeric suffix if even that is taken.
 * Over-namespacing is harmless; clobbering a different secret is not.
 *
 * Env-var (Tier-1) secrets intentionally reuse the original key name (same
 * provider, same var) and are NOT routed through this — only URL creds are.
 */
export function pickEnvVarName(
  existingEnv: Record<string, string> | undefined,
  bareName: string,
  serverName: string,
): string {
  if (!existingEnv || !(bareName in existingEnv)) return bareName;
  const prefix = serverName.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  const namespaced = `${prefix}_${bareName}`;
  if (!(namespaced in existingEnv)) return namespaced;
  let n = 2;
  while (`${namespaced}_${n}` in existingEnv) n++;
  return `${namespaced}_${n}`;
}

// ── Substitution + Display Utilities ─────────────────────────────────────────

/** A server shape substituteSecret can mutate, including adapter url fields.
 * `adapters` is `Record<string, unknown>` to match the schema's passthrough
 * type; the adapter url branch narrows each entry at the point of use. */
type SubstitutableServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  adapters?: Record<string, unknown>;
};

/**
 * Replace a detected secret's value with a ${VAR} reference, IN PLACE.
 *
 * Returns `true` if the substitution removed the plaintext, `false` if it could
 * NOT (e.g. an arg/betterleaks finding with no index, or a location this fn
 * doesn't know how to rewrite). Callers MUST check the return: encrypting +
 * counting a secret as "fixed" while the plaintext survives is the worst
 * failure mode (review findings A + F). On `false`, the caller must refuse
 * rather than store an encrypted copy alongside the surviving plaintext.
 */
export function substituteSecret(
  server: SubstitutableServer,
  secret: DetectedSecret,
  envVarName: string,
): boolean {
  const placeholder = `\${${envVarName}}`;
  switch (secret.location) {
    case "env": {
      if (server.env && secret.key) {
        server.env[secret.key] = placeholder;
        return true;
      }
      return false;
    }
    case "args": {
      // Includes betterleaks findings (source:"betterleaks") that point at an
      // arg. Without a resolvable index we CANNOT rewrite — return false so the
      // caller refuses instead of falsely reporting it encrypted (finding F).
      if (server.args && secret.index !== undefined && secret.index < server.args.length) {
        const arg = server.args[secret.index];
        // replaceAll (not replace): a value repeated in the same arg must be
        // fully scrubbed, else one plaintext copy survives while we return true
        // and the caller encrypts+counts it (CodeRabbit: provably-removed).
        const next = arg.replaceAll(secret.value, placeholder);
        if (next === arg) return false; // value not present at that index → no-op
        server.args[secret.index] = next;
        return !next.includes(secret.value);
      }
      // Betterleaks finding with no index: try to locate the value in any arg
      // or the command so we still obfuscate it rather than silently no-op.
      if (server.args) {
        for (let i = 0; i < server.args.length; i++) {
          if (server.args[i].includes(secret.value)) {
            server.args[i] = server.args[i].replaceAll(secret.value, placeholder);
            return true;
          }
        }
      }
      if (server.command.includes(secret.value)) {
        server.command = server.command.replaceAll(secret.value, placeholder);
        return true;
      }
      return false;
    }
    case "command": {
      // URL-embedded credential: rewrite ONLY the offending query param to the
      // placeholder, via rewriteUrlParam (URL.searchParams-safe; does not touch
      // sibling params). The credential URL may live in command, an arg, or an
      // adapter url field.
      if (secret.source === "url-credential" && secret.key) {
        if (secret.urlSource === "args" && server.args && secret.index !== undefined) {
          const before = server.args[secret.index];
          server.args[secret.index] = rewriteUrlParam(before, secret.key, placeholder);
          return !server.args[secret.index].includes(secret.value);
        }
        if (secret.urlSource === "adapter" && secret.adapterName) {
          const adapter = server.adapters?.[secret.adapterName] as { url?: unknown } | undefined;
          if (adapter && typeof adapter.url === "string") {
            const rewritten = rewriteUrlParam(adapter.url, secret.key, placeholder);
            adapter.url = rewritten;
            return !rewritten.includes(secret.value);
          }
          return false; // adapter/url vanished — cannot rewrite
        }
        // M7: a credential URL stashed in an env value. Rewrite the EXACT env
        // entry — falling through to the command rewrite below would scan the
        // wrong field, detect-but-not-substitute, and leave the plaintext in
        // env (the "detection > substitution = plaintext leak" failure mode).
        if (secret.urlSource === "env" && secret.envKey) {
          if (server.env && typeof server.env[secret.envKey] === "string") {
            const rewritten = rewriteUrlParam(server.env[secret.envKey], secret.key, placeholder);
            server.env[secret.envKey] = rewritten;
            return !rewritten.includes(secret.value);
          }
          return false; // env entry vanished — cannot rewrite (fail closed)
        }
        server.command = rewriteUrlParam(server.command, secret.key, placeholder);
        return !server.command.includes(secret.value);
      }
      // Legacy inline `key=value` form in the command string (non-URL).
      if (secret.key) {
        const before = server.command;
        // replaceAll + value-gone post-check: a repeated key=value must be fully
        // scrubbed before we report success (CodeRabbit: provably-removed).
        server.command = server.command.replaceAll(
          `${secret.key}=${secret.value}`,
          `${secret.key}=${placeholder}`,
        );
        return server.command !== before && !server.command.includes(secret.value);
      }
      return false;
    }
  }
}

/**
 * Redact a secret value for display (show first/last 4 chars).
 */
export function redactSecret(value: string): string {
  if (value.length <= 12) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Format scan results as a human-readable report.
 */
export function formatScanReport(results: SecretScanResult[]): string {
  if (results.length === 0) return "No secrets detected.";

  const lines: string[] = [];
  let total = 0;

  for (const result of results) {
    for (const secret of result.secrets) {
      total++;
      const loc =
        secret.source === "url-credential"
          ? // Point at the REAL editable field. For adapter the URL lives in a
            // genuine `.url` field; for command/args the URL *is* the command
            // string or the arg itself — appending `.url` there sent users to a
            // path they can't edit (CodeRabbit). Tag the query-param so the user
            // knows which one to fix.
            secret.urlSource === "adapter"
            ? `adapters.${secret.adapterName}.url?${secret.key}`
            : secret.urlSource === "args"
              ? `args[${secret.index ?? "?"}]?${secret.key}`
              : `command?${secret.key}`
          : secret.location === "env"
            ? `env.${secret.key}`
            : secret.location === "args"
              ? `args[${secret.index ?? "?"}]`
              : "command";
      const tier =
        secret.source === "key-name"
          ? "key-name"
          : secret.source === "url-credential"
            ? "url"
            : "betterleaks";
      lines.push(
        `  ${result.serverName.padEnd(20)} ${loc.padEnd(25)} ${redactSecret(secret.value).padEnd(20)} ${tier}`,
      );
    }
  }

  const header = `${"Server".padEnd(20)} ${"Location".padEnd(25)} ${"Value".padEnd(20)} Source`;
  const separator = "─".repeat(80);

  return [`${total} secret(s) found:\n`, header, separator, ...lines].join("\n");
}
