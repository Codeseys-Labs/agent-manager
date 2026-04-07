import type { Config } from "./schema";

export interface InterpolateOptions {
  strict?: boolean;
  extraEnv?: Record<string, string>;
}

export interface InterpolateResult {
  config: Config;
  warnings: string[];
}

// Matches ${VAR} but not $${VAR} (escaped)
const VAR_PATTERN = /\$\$\{[^}]+\}|\$\{([^}]+)\}/g;

/**
 * Deep-walk all string values in config, resolving `${VAR}` references.
 *
 * - `${VAR}` resolves from process.env first, then extraEnv
 * - `$${VAR}` escapes to the literal string `${VAR}`
 * - Unresolved variables: warn (non-strict) or throw (strict)
 */
export function interpolateEnv(
  config: Config,
  options: InterpolateOptions = {},
): InterpolateResult {
  const { strict = false, extraEnv = {} } = options;
  const warnings: string[] = [];

  function resolveValue(value: string): string {
    return value.replace(VAR_PATTERN, (match, varName?: string) => {
      // Escaped: $${VAR} → literal ${VAR}
      if (match.startsWith("$$")) {
        return match.slice(1); // drop first $
      }

      // Resolve from process.env first, then extraEnv
      const resolved = process.env[varName!] ?? extraEnv[varName!];
      if (resolved !== undefined) {
        return resolved;
      }

      // Unresolved
      const msg = `Unresolved variable: \${${varName}}`;
      if (strict) {
        throw new Error(msg);
      }
      warnings.push(msg);
      return match; // leave as-is
    });
  }

  function walkValue(value: unknown): unknown {
    if (typeof value === "string") {
      return resolveValue(value);
    }
    if (Array.isArray(value)) {
      return value.map(walkValue);
    }
    if (value !== null && typeof value === "object") {
      return walkObject(value as Record<string, unknown>);
    }
    return value;
  }

  function walkObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = walkValue(val);
    }
    return result;
  }

  const interpolated = walkObject(config as Record<string, unknown>) as Config;
  return { config: interpolated, warnings };
}
