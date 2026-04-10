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
  /** Env var name (if location is env) */
  key?: string;
  /** The actual secret value */
  value: string;
  /** Arg index (if location is args) */
  index?: number;
  /** How it was detected */
  source: "key-name" | "betterleaks";
  /** Suggested ${VAR} replacement name */
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
    // Skip already-templated or encrypted values
    if (value.includes("${") || value.startsWith("enc:v1:")) continue;
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
      // Skip values already handled by Tier 1
      if (value.includes("${") || value.startsWith("enc:v1:")) continue;
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
 * Full scan: Tier 1 (key names) always, Tier 2 (betterleaks) when available.
 */
export async function scanServerForSecrets(
  name: string,
  server: { command: string; args?: string[]; env?: Record<string, string> },
): Promise<SecretScanResult> {
  // Tier 1: always runs, zero dependencies
  const tier1 = scanServerEnvVars(name, server);

  // Tier 2: only if betterleaks is installed
  let tier2: SecretScanResult | null = null;
  try {
    tier2 = await scanServerWithBetterleaks(name, server);
  } catch {
    // betterleaks not available, that's fine
  }

  // Merge: Tier 1 results + any Tier 2 findings not already covered
  const allSecrets = [...tier1.secrets];
  if (tier2) {
    for (const secret of tier2.secrets) {
      // Skip if Tier 1 already found this value
      const alreadyCovered = tier1.secrets.some((s) => s.value === secret.value);
      if (!alreadyCovered) {
        allSecrets.push(secret);
      }
    }
  }

  return { serverName: name, secrets: allSecrets };
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

// ── Substitution + Display Utilities ─────────────────────────────────────────

/**
 * Replace a detected secret's value with a ${VAR} reference.
 */
export function substituteSecret(
  server: { command: string; args?: string[]; env?: Record<string, string> },
  secret: DetectedSecret,
  envVarName: string,
): void {
  switch (secret.location) {
    case "env": {
      if (server.env && secret.key) {
        server.env[secret.key] = `\${${envVarName}}`;
      }
      break;
    }
    case "args": {
      if (server.args && secret.index !== undefined) {
        const arg = server.args[secret.index];
        server.args[secret.index] = arg.replace(secret.value, `\${${envVarName}}`);
      }
      break;
    }
    case "command": {
      if (secret.key) {
        server.command = server.command.replace(
          `${secret.key}=${secret.value}`,
          `${secret.key}=\${${envVarName}}`,
        );
      }
      break;
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
        secret.location === "env"
          ? `env.${secret.key}`
          : secret.location === "args"
            ? `args[${secret.index ?? "?"}]`
            : "command";
      const tier = secret.source === "key-name" ? "key-name" : "betterleaks";
      lines.push(
        `  ${result.serverName.padEnd(20)} ${loc.padEnd(25)} ${redactSecret(secret.value).padEnd(20)} ${tier}`,
      );
    }
  }

  const header = `${"Server".padEnd(20)} ${"Location".padEnd(25)} ${"Value".padEnd(20)} Source`;
  const separator = "─".repeat(80);

  return [`${total} secret(s) found:\n`, header, separator, ...lines].join("\n");
}
