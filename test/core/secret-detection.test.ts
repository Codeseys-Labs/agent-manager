import { describe, expect, test } from "bun:test";
import {
  type DetectedSecret,
  formatScanReport,
  isSecretKeyName,
  redactSecret,
  scanConfigEnvVars,
  scanConfigForSecrets,
  scanServerEnvVars,
  scanServerForSecrets,
  substituteSecret,
} from "../../src/core/secret-detection";

// ── Tier 1: Key-name-based detection (synchronous, always works) ─────────

describe("isSecretKeyName", () => {
  test("matches common secret key patterns", () => {
    expect(isSecretKeyName("API_KEY")).toBe(true);
    expect(isSecretKeyName("OPENAI_API_KEY")).toBe(true);
    expect(isSecretKeyName("SECRET_TOKEN")).toBe(true);
    expect(isSecretKeyName("MY_PASSWORD")).toBe(true);
    expect(isSecretKeyName("AUTH_CREDENTIAL")).toBe(true);
    expect(isSecretKeyName("PRIVATE_KEY")).toBe(true);
    expect(isSecretKeyName("ACCESS_KEY_ID")).toBe(true);
  });

  test("matches AI provider key names", () => {
    expect(isSecretKeyName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSecretKeyName("OPENAI_KEY")).toBe(true);
    expect(isSecretKeyName("MISTRAL_API_KEY")).toBe(true);
    expect(isSecretKeyName("GROQ_API_KEY")).toBe(true);
    expect(isSecretKeyName("REPLICATE_TOKEN")).toBe(true);
    expect(isSecretKeyName("HUGGINGFACE_TOKEN")).toBe(true);
    expect(isSecretKeyName("COHERE_API_KEY")).toBe(true);
    expect(isSecretKeyName("TAVILY_API_KEY")).toBe(true);
    expect(isSecretKeyName("PERPLEXITY_API_KEY")).toBe(true);
    expect(isSecretKeyName("DEEPSEEK_API_KEY")).toBe(true);
  });

  test("matches cloud provider key names", () => {
    expect(isSecretKeyName("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isSecretKeyName("AWS_ACCESS_KEY_ID")).toBe(true);
  });

  test("matches developer tool key names", () => {
    expect(isSecretKeyName("GITHUB_TOKEN")).toBe(true);
    expect(isSecretKeyName("GITLAB_TOKEN")).toBe(true);
    expect(isSecretKeyName("SUPABASE_KEY")).toBe(true);
    expect(isSecretKeyName("FIREBASE_API_KEY")).toBe(true);
  });

  test("does NOT match non-secret key names", () => {
    expect(isSecretKeyName("PORT")).toBe(false);
    expect(isSecretKeyName("NODE_ENV")).toBe(false);
    expect(isSecretKeyName("DEBUG")).toBe(false);
    expect(isSecretKeyName("LOG_LEVEL")).toBe(false);
    expect(isSecretKeyName("HOSTNAME")).toBe(false);
    expect(isSecretKeyName("MAX_RETRIES")).toBe(false);
  });
});

describe("scanServerEnvVars (Tier 1)", () => {
  test("detects secret by key name", () => {
    const result = scanServerEnvVars("my-server", {
      command: "npx",
      args: ["mcp-server"],
      env: {
        OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz",
      },
    });

    expect(result.serverName).toBe("my-server");
    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].location).toBe("env");
    expect(result.secrets[0].key).toBe("OPENAI_API_KEY");
    expect(result.secrets[0].source).toBe("key-name");
    expect(result.secrets[0].suggestedEnvVar).toBe("OPENAI_API_KEY");
  });

  test("detects multiple secrets in one server", () => {
    const result = scanServerEnvVars("multi-secret", {
      command: "npx",
      env: {
        ANTHROPIC_API_KEY: "sk-ant-some-value",
        TAVILY_API_KEY: "tvly-some-value",
        PORT: "3000",
      },
    });

    expect(result.secrets).toHaveLength(2);
    expect(result.secrets.map((s) => s.key)).toContain("ANTHROPIC_API_KEY");
    expect(result.secrets.map((s) => s.key)).toContain("TAVILY_API_KEY");
  });

  test("ignores already-templated ${VAR} values", () => {
    const result = scanServerEnvVars("templated", {
      command: "npx",
      env: {
        OPENAI_API_KEY: "${OPENAI_API_KEY}",
      },
    });

    expect(result.secrets).toHaveLength(0);
  });

  test("ignores already-encrypted enc:v1: values", () => {
    const result = scanServerEnvVars("encrypted", {
      command: "npx",
      env: {
        OPENAI_API_KEY: "enc:v1:nonce:ciphertext",
      },
    });

    expect(result.secrets).toHaveLength(0);
  });

  test("ignores empty and trivial values", () => {
    const result = scanServerEnvVars("trivial", {
      command: "npx",
      env: {
        AUTH_TOKEN: "",
        SECRET_FLAG: "true",
        API_KEY: "false",
      },
    });

    expect(result.secrets).toHaveLength(0);
  });

  test("ignores non-secret key names regardless of value", () => {
    const result = scanServerEnvVars("non-secret", {
      command: "npx",
      env: {
        PORT: "sk-ant-api03-this-looks-like-a-key-but-port-isnt-secret",
        DEBUG: "super-secret-looking-value-12345678901234567890",
      },
    });

    expect(result.secrets).toHaveLength(0);
  });

  test("returns empty for server with no env", () => {
    const result = scanServerEnvVars("no-env", {
      command: "npx",
      args: ["mcp-server"],
    });

    expect(result.secrets).toHaveLength(0);
  });
});

describe("scanConfigEnvVars (Tier 1)", () => {
  test("scans multiple servers", () => {
    const results = scanConfigEnvVars({
      "server-a": {
        command: "npx",
        env: { OPENAI_API_KEY: "sk-abc123" },
      },
      "server-b": {
        command: "npx",
        env: { GITHUB_TOKEN: "ghp_1234567890" },
      },
      "server-c": {
        command: "npx",
        env: { PORT: "3000" },
      },
    });

    expect(results).toHaveLength(2);
    expect(results[0].serverName).toBe("server-a");
    expect(results[1].serverName).toBe("server-b");
  });

  test("returns empty array when no secrets found", () => {
    const results = scanConfigEnvVars({
      "clean-server": {
        command: "npx",
        env: { PORT: "3000", NODE_ENV: "production" },
      },
    });

    expect(results).toHaveLength(0);
  });
});

// ── Combined scan (async, includes Tier 2 when available) ────────────────

describe("scanServerForSecrets (combined)", () => {
  test("detects env var secrets (async interface)", async () => {
    const result = await scanServerForSecrets("my-server", {
      command: "npx",
      env: {
        OPENAI_API_KEY: "sk-test-value",
        PORT: "3000",
      },
    });

    expect(result.serverName).toBe("my-server");
    expect(result.secrets.length).toBeGreaterThanOrEqual(1);
    const envSecret = result.secrets.find((s) => s.key === "OPENAI_API_KEY");
    expect(envSecret).toBeDefined();
    expect(envSecret!.source).toBe("key-name");
  });
});

describe("scanConfigForSecrets (combined)", () => {
  test("scans all servers (async interface)", async () => {
    const results = await scanConfigForSecrets({
      s1: { command: "npx", env: { ANTHROPIC_API_KEY: "sk-ant-test" } },
      s2: { command: "npx", env: { PORT: "3000" } },
    });

    expect(results).toHaveLength(1);
    expect(results[0].serverName).toBe("s1");
  });
});

// ── Substitution ─────────────────────────────────────────────────────────

describe("substituteSecret", () => {
  test("replaces env value with ${VAR}", () => {
    const server = {
      command: "npx",
      env: { OPENAI_API_KEY: "sk-real-key-value" },
    };
    const secret: DetectedSecret = {
      location: "env",
      key: "OPENAI_API_KEY",
      value: "sk-real-key-value",
      source: "key-name",
      suggestedEnvVar: "OPENAI_API_KEY",
    };

    substituteSecret(server, secret, "OPENAI_API_KEY");
    expect(server.env.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
  });

  test("replaces arg value with ${VAR}", () => {
    const server = {
      command: "npx",
      args: ["--api-key=sk-test-value"],
    };
    const secret: DetectedSecret = {
      location: "args",
      value: "sk-test-value",
      index: 0,
      source: "betterleaks",
      suggestedEnvVar: "API_KEY",
    };

    substituteSecret(server, secret, "API_KEY");
    expect(server.args[0]).toBe("--api-key=${API_KEY}");
  });

  test("replaces inline command env with ${VAR}", () => {
    const server = {
      command: "API_KEY=sk-secret npx mcp-server",
      args: [],
    };
    const secret: DetectedSecret = {
      location: "command",
      key: "API_KEY",
      value: "sk-secret",
      source: "betterleaks",
      suggestedEnvVar: "API_KEY",
    };

    substituteSecret(server, secret, "API_KEY");
    expect(server.command).toBe("API_KEY=${API_KEY} npx mcp-server");
  });
});

// ── Display utilities ────────────────────────────────────────────────────

describe("redactSecret", () => {
  test("redacts long values showing first/last 4 chars", () => {
    expect(redactSecret("sk-abcdefghijklmnop")).toBe("sk-a...mnop");
  });

  test("fully redacts short values", () => {
    expect(redactSecret("short")).toBe("****");
    expect(redactSecret("123456789012")).toBe("****");
  });

  test("handles 13-char boundary", () => {
    expect(redactSecret("1234567890123")).toBe("1234...0123");
  });
});

describe("formatScanReport", () => {
  test("formats results as table", () => {
    const report = formatScanReport([
      {
        serverName: "my-server",
        secrets: [
          {
            location: "env",
            key: "API_KEY",
            value: "sk-abcdefghijklmnop12345678",
            source: "key-name",
            suggestedEnvVar: "API_KEY",
          },
        ],
      },
    ]);

    expect(report).toContain("my-server");
    expect(report).toContain("env.API_KEY");
    expect(report).toContain("key-name");
    expect(report).toContain("1 secret(s) found");
  });

  test("returns message for empty results", () => {
    expect(formatScanReport([])).toBe("No secrets detected.");
  });
});
