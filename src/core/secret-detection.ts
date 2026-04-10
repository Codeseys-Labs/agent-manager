/**
 * Dynamic secret detection for MCP server configurations.
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
];

/** Patterns for actual secret values (API keys, tokens, etc.) */
const SECRET_VALUE_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  suggestedEnvVar: string;
}> = [
  { name: "OpenAI API key", pattern: /^sk-[a-zA-Z0-9]{20,}$/, suggestedEnvVar: "OPENAI_API_KEY" },
  {
    name: "Anthropic API key",
    pattern: /^sk-ant-[a-zA-Z0-9_-]{20,}$/,
    suggestedEnvVar: "ANTHROPIC_API_KEY",
  },
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
    name: "Tavily API key",
    pattern: /^tvly-[a-zA-Z0-9]{20,}$/,
    suggestedEnvVar: "TAVILY_API_KEY",
  },
  {
    name: "AWS access key",
    pattern: /^AKIA[A-Z0-9]{16}$/,
    suggestedEnvVar: "AWS_ACCESS_KEY_ID",
  },
  {
    name: "Stripe key",
    pattern: /^[sr]k_(test|live)_[a-zA-Z0-9]{20,}$/,
    suggestedEnvVar: "STRIPE_API_KEY",
  },
  {
    name: "SendGrid key",
    pattern: /^SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}$/,
    suggestedEnvVar: "SENDGRID_API_KEY",
  },
  {
    name: "Slack token",
    pattern: /^xox[bpras]-[a-zA-Z0-9-]+$/,
    suggestedEnvVar: "SLACK_TOKEN",
  },
  {
    name: "HuggingFace token",
    pattern: /^hf_[a-zA-Z0-9]{20,}$/,
    suggestedEnvVar: "HUGGINGFACE_TOKEN",
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
              sp.name === "Generic long secret" ? (keyIsSecret ? "medium" : "low") : "high",
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
