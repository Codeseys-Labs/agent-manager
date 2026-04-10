/**
 * Dynamic secret detection for MCP server configurations.
 *
 * Secret detection patterns derived from gitleaks (https://github.com/gitleaks/gitleaks)
 * and extended with AI/LLM provider-specific patterns for MCP server configs.
 *
 * Detects potential secrets (API keys, tokens, passwords) in server configs
 * during import, and provides options to encrypt or substitute with ${VAR}.
 */

/** Patterns for env var key names that likely contain secrets */
const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /auth/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  // Cloud provider key name patterns
  /aws_secret_access_key/i,
  /service_account/i,
  /azure/i,
  // AI/LLM provider key name patterns
  /mistral/i,
  /together/i,
  /fireworks/i,
  /cohere/i,
  // Developer tool key name patterns
  /vercel/i,
  /netlify/i,
  /supabase/i,
  /firebase/i,
  // Communication/SaaS key name patterns
  /discord/i,
  /twilio/i,
  // Search/Data key name patterns
  /algolia/i,
  /pinecone/i,
  /weaviate/i,
];

/** Patterns for actual secret values (API keys, tokens, etc.) */
const SECRET_VALUE_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  suggestedEnvVar: string;
}> = [
  // ── AI / LLM Provider Keys (highest priority for agent-manager) ────────────
  {
    name: "OpenAI API key (project/svc)",
    pattern: /^sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}$/,
    suggestedEnvVar: "OPENAI_API_KEY",
  },
  {
    name: "OpenAI API key",
    pattern: /^sk-[a-zA-Z0-9]{20,}$/,
    suggestedEnvVar: "OPENAI_API_KEY",
  },
  {
    name: "Anthropic API key (strict)",
    pattern: /^sk-ant-api03-[a-zA-Z0-9_-]{93}AA$/,
    suggestedEnvVar: "ANTHROPIC_API_KEY",
  },
  {
    name: "Anthropic Admin key",
    pattern: /^sk-ant-admin01-[a-zA-Z0-9_-]{93}AA$/,
    suggestedEnvVar: "ANTHROPIC_ADMIN_KEY",
  },
  {
    name: "Anthropic API key",
    pattern: /^sk-ant-[a-zA-Z0-9_-]{20,}$/,
    suggestedEnvVar: "ANTHROPIC_API_KEY",
  },
  {
    name: "HuggingFace token",
    pattern: /^hf_[a-zA-Z0-9]{20,}$/,
    suggestedEnvVar: "HUGGINGFACE_TOKEN",
  },
  {
    name: "HuggingFace org token",
    pattern: /^api_org_[a-zA-Z0-9]{20,}$/,
    suggestedEnvVar: "HUGGINGFACE_ORG_TOKEN",
  },
  {
    name: "Google AI / GCP API key",
    pattern: /^AIza[a-zA-Z0-9_-]{35}$/,
    suggestedEnvVar: "GOOGLE_API_KEY",
  },
  {
    name: "Replicate API token",
    pattern: /^r8_[a-zA-Z0-9]{40}$/,
    suggestedEnvVar: "REPLICATE_API_TOKEN",
  },
  {
    name: "Groq API key",
    pattern: /^gsk_[a-zA-Z0-9]{48,}$/,
    suggestedEnvVar: "GROQ_API_KEY",
  },
  {
    name: "Perplexity API key",
    pattern: /^pplx-[a-zA-Z0-9]{48}$/,
    suggestedEnvVar: "PERPLEXITY_API_KEY",
  },
  {
    name: "Cohere API key",
    pattern: /^[a-zA-Z0-9]{40}$/,
    suggestedEnvVar: "COHERE_API_KEY",
  },

  // ── Cloud Provider Keys ────────────────────────────────────────────────────
  {
    name: "AWS access key",
    pattern: /^(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}$/,
    suggestedEnvVar: "AWS_ACCESS_KEY_ID",
  },

  // ── Developer Tool Keys ────────────────────────────────────────────────────
  {
    name: "GitHub token",
    pattern: /^gh[ps]_[a-zA-Z0-9]{36,}$/,
    suggestedEnvVar: "GITHUB_TOKEN",
  },
  {
    name: "GitHub fine-grained token",
    pattern: /^github_pat_[a-zA-Z0-9_]{20,}$/,
    suggestedEnvVar: "GITHUB_TOKEN",
  },
  {
    name: "GitLab PAT",
    pattern: /^glpat-[a-zA-Z0-9_-]{20,}$/,
    suggestedEnvVar: "GITLAB_TOKEN",
  },

  // ── Search / Data ──────────────────────────────────────────────────────────
  {
    name: "Tavily API key",
    pattern: /^tvly-[a-zA-Z0-9]{20,}$/,
    suggestedEnvVar: "TAVILY_API_KEY",
  },

  // ── Communication / SaaS ───────────────────────────────────────────────────
  {
    name: "Slack Bot token",
    pattern: /^xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*$/,
    suggestedEnvVar: "SLACK_BOT_TOKEN",
  },
  {
    name: "Slack App token",
    pattern: /^xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+$/,
    suggestedEnvVar: "SLACK_APP_TOKEN",
  },
  {
    name: "Slack token",
    pattern: /^xox[pras]-[a-zA-Z0-9-]+$/,
    suggestedEnvVar: "SLACK_TOKEN",
  },
  {
    name: "SendGrid key",
    pattern: /^SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}$/,
    suggestedEnvVar: "SENDGRID_API_KEY",
  },
  {
    name: "Twilio API key",
    pattern: /^SK[0-9a-fA-F]{32}$/,
    suggestedEnvVar: "TWILIO_API_KEY",
  },

  // ── Payment ────────────────────────────────────────────────────────────────
  {
    name: "Stripe key",
    pattern: /^[sr]k_(test|live|prod)_[a-zA-Z0-9]{10,99}$/,
    suggestedEnvVar: "STRIPE_API_KEY",
  },

  // ── Generic Patterns (lower confidence) ────────────────────────────────────
  {
    name: "JWT token",
    pattern: /^eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}$/,
    suggestedEnvVar: "",
  },
  {
    name: "Private key",
    pattern: /^-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
    suggestedEnvVar: "",
  },
  {
    name: "Database connection URL",
    pattern: /^(?:postgres|mysql|mongodb):\/\/[^:]+:[^@]+@/,
    suggestedEnvVar: "DATABASE_URL",
  },
  {
    name: "Generic long secret",
    pattern: /^[a-zA-Z0-9_-]{40,}$/,
    suggestedEnvVar: "",
  }, // Only flagged if key name also matches
];

export interface DetectedSecret {
  location: "env" | "args" | "command";
  key?: string; // env var name (if in env)
  value: string; // the actual secret value
  index?: number; // arg index (if in args)
  patternName: string; // what type of secret was detected
  suggestedEnvVar: string; // suggested ${VAR} replacement
  confidence: "high" | "medium" | "low";
}

export interface SecretScanResult {
  serverName: string;
  secrets: DetectedSecret[];
}

/**
 * Scan a server config for potential secrets.
 * Checks env values, args array entries, and command string.
 */
export function scanServerForSecrets(
  name: string,
  server: { command: string; args?: string[]; env?: Record<string, string> },
): SecretScanResult {
  const secrets: DetectedSecret[] = [];

  // 1. Check env values
  if (server.env) {
    for (const [key, value] of Object.entries(server.env)) {
      // Skip already-templated values
      if (value.includes("${") || value.startsWith("enc:v1:")) continue;

      // Check if key name suggests a secret
      const keyIsSecret = SECRET_KEY_PATTERNS.some((p) => p.test(key));

      // Check if value matches a known secret pattern
      let matched = false;
      for (const sp of SECRET_VALUE_PATTERNS) {
        if (sp.pattern.test(value)) {
          secrets.push({
            location: "env",
            key,
            value,
            patternName: sp.name,
            suggestedEnvVar: sp.suggestedEnvVar || key,
            confidence:
              sp.name === "Generic long secret" || sp.name === "Cohere API key"
                ? keyIsSecret
                  ? "medium"
                  : "low"
                : sp.name === "JWT token" || sp.name === "Database connection URL"
                  ? "medium"
                  : "high",
          });
          matched = true;
          break;
        }
      }

      // If key name matches secret patterns but value didn't match known patterns,
      // flag as medium confidence if the value is long enough to be a token
      if (keyIsSecret && !matched && value.length > 15) {
        secrets.push({
          location: "env",
          key,
          value,
          patternName: "Secret env var name",
          suggestedEnvVar: key,
          confidence: "medium",
        });
      }
    }
  }

  // 2. Check args for inline secrets
  if (server.args) {
    for (let i = 0; i < server.args.length; i++) {
      const arg = server.args[i];
      if (arg.includes("${") || arg.startsWith("enc:v1:")) continue;

      for (const sp of SECRET_VALUE_PATTERNS) {
        if (sp.name === "Generic long secret") continue; // too noisy for args
        if (sp.pattern.test(arg)) {
          secrets.push({
            location: "args",
            value: arg,
            index: i,
            patternName: sp.name,
            suggestedEnvVar: sp.suggestedEnvVar,
            confidence: "high",
          });
          break;
        }
      }

      // Check for --key=value or --key value patterns
      const kvMatch = arg.match(/^--(api[_-]?key|token|secret|password|auth)=(.+)$/i);
      if (kvMatch) {
        secrets.push({
          location: "args",
          key: kvMatch[1],
          value: kvMatch[2],
          index: i,
          patternName: "Inline CLI secret",
          suggestedEnvVar: kvMatch[1].toUpperCase().replace(/-/g, "_"),
          confidence: "medium",
        });
      }
    }
  }

  // 3. Check command for inline env assignments: KEY=value command
  if (server.command) {
    const inlineEnvMatch = server.command.match(/^([A-Z_]+=\S+\s+)+/);
    if (inlineEnvMatch) {
      const assignments = inlineEnvMatch[0].trim().split(/\s+/);
      for (const assignment of assignments) {
        const [key, ...valueParts] = assignment.split("=");
        const value = valueParts.join("=");
        if (!key || !value) continue;
        if (value.includes("${")) continue;

        const keyIsSecret = SECRET_KEY_PATTERNS.some((p) => p.test(key));
        if (keyIsSecret) {
          secrets.push({
            location: "command",
            key,
            value,
            patternName: "Inline env in command",
            suggestedEnvVar: key,
            confidence: "medium",
          });
        }
      }
    }
  }

  return { serverName: name, secrets };
}

/**
 * Scan all servers in a config for potential secrets.
 */
export function scanConfigForSecrets(
  servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>,
): SecretScanResult[] {
  const results: SecretScanResult[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const result = scanServerForSecrets(name, server);
    if (result.secrets.length > 0) {
      results.push(result);
    }
  }
  return results;
}

/**
 * Apply substitution: replace a detected secret's value with a ${VAR} reference.
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
            ? `args[${secret.index}]`
            : "command";
      lines.push(
        `  ${result.serverName.padEnd(20)} ${loc.padEnd(20)} ${redactSecret(secret.value).padEnd(20)} ${secret.confidence.padEnd(8)} ${secret.patternName}`,
      );
    }
  }

  const header = `${"Server".padEnd(20)} ${"Location".padEnd(20)} ${"Value".padEnd(20)} ${"Conf.".padEnd(8)} Type`;
  const separator = "─".repeat(90);

  return [`${total} potential secret(s) found:\n`, header, separator, ...lines].join("\n");
}
