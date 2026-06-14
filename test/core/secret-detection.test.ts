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
  scanServerForUrlCredentials,
  scanSettingsEnvForSecrets,
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

  test("matches underscore-suffixed generic secret key names (ws1: word-boundary gap)", () => {
    // `\b…\b` does NOT fire on `_`/`-` (both are word chars), so the old
    // name-only /\btoken\b/ / /\bauth\b/ patterns let these slip through as
    // plaintext while the scan reported clean (false negative → leaked
    // credential). The suffix-anchored generic pattern + /bearer/ close the gap.
    expect(isSecretKeyName("FOO_KEY")).toBe(true);
    expect(isSecretKeyName("MY_TOKEN")).toBe(true);
    expect(isSecretKeyName("GH_TOKEN")).toBe(true);
    expect(isSecretKeyName("FOO_PWD")).toBe(true);
    expect(isSecretKeyName("BEARER_TOKEN")).toBe(true);
    expect(isSecretKeyName("SESSION_KEY")).toBe(true);
    expect(isSecretKeyName("SIGNING_KEY")).toBe(true);
  });

  test("matches anchored bearer key names (ws5: free /bearer/i was unanchored)", () => {
    // The old free-floating /bearer/i fired on ANY substring `bearer`, so
    // config flags like BEARER_ENABLED were encrypted as if they were secrets.
    // The anchored form matches only a bearer-suffixed (or bare) key. AUTH_BEARER
    // and bare BEARER match via the bearer pattern; BEARER_TOKEN matches via the
    // suffix-anchored token$ group, so all three stay secrets.
    expect(isSecretKeyName("AUTH_BEARER")).toBe(true);
    expect(isSecretKeyName("BEARER")).toBe(true);
    expect(isSecretKeyName("BEARER_TOKEN")).toBe(true);
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
    // ws5: the old unanchored /bearer/i flagged these config flags as secrets
    // (false positives → harmless config encrypted as a credential). The
    // anchored /(^|[_-])bearer$/i only matches a bearer-suffixed/bare key.
    expect(isSecretKeyName("BEARER_ENABLED")).toBe(false);
    expect(isSecretKeyName("FORBEARER")).toBe(false);
    expect(isSecretKeyName("BEARERTOWN")).toBe(false);
    expect(isSecretKeyName("BEARER_TOKEN_TTL")).toBe(false);
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

  test("ignores already-encrypted enc:v2:age: values (P0-3: don't re-flag v2 as plaintext)", () => {
    const result = scanServerEnvVars("encrypted-v2", {
      command: "npx",
      env: {
        OPENAI_API_KEY: "enc:v2:age:Y2lwaGVydGV4dA==",
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

// ── settings.env scanning (M6: scan never looked at [settings.env]) ──────

describe("scanSettingsEnvForSecrets", () => {
  test("flags a plaintext secret stored in settings.env (key-name tier)", async () => {
    const result = await scanSettingsEnvForSecrets({
      GITHUB_TOKEN: "ghp_realtokenvalue1234567890",
      LOG_LEVEL: "info",
    });

    expect(result).not.toBeNull();
    expect(result!.serverName).toBe("settings");
    const tokenSecret = result!.secrets.find((s) => s.key === "GITHUB_TOKEN");
    expect(tokenSecret).toBeDefined();
    expect(tokenSecret!.location).toBe("env");
    expect(tokenSecret!.source).toBe("key-name");
    expect(tokenSecret!.value).toBe("ghp_realtokenvalue1234567890");
    // Non-secret key is not flagged.
    expect(result!.secrets.find((s) => s.key === "LOG_LEVEL")).toBeUndefined();
  });

  test("does not flag already-templated or encrypted settings.env values", async () => {
    const result = await scanSettingsEnvForSecrets({
      OPENAI_API_KEY: "${OPENAI_API_KEY}",
      ANTHROPIC_API_KEY: "enc:v2:age:Y2lwaGVydGV4dA==",
    });

    expect(result!.secrets).toHaveLength(0);
  });

  test("returns an empty result for undefined / empty settings.env", async () => {
    expect((await scanSettingsEnvForSecrets(undefined))!.secrets).toHaveLength(0);
    expect((await scanSettingsEnvForSecrets({}))!.secrets).toHaveLength(0);
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

  test("M7: env-sourced url-credential is DETECTED and SUBSTITUTED (no surviving plaintext)", () => {
    // Regression for the "detection > substitution = plaintext leak" hazard:
    // a credential URL stashed in an env value must be (a) detected with
    // urlSource:'env' + envKey, and (b) rewritten IN the env entry — not the
    // command. Before the fix substituteSecret fell through to the command
    // rewrite, returned false (or wrong field), and left the plaintext in env.
    const server = {
      command: "npx",
      args: ["-y", "some-mcp"],
      env: { MCP_ENDPOINT: "https://mcp.example.com/?api_key=abcdefghijklmnop1234" },
    };
    const secrets = scanServerForUrlCredentials("enved", server);
    const envHit = secrets.find((s) => s.urlSource === "env");
    expect(envHit, "env url-credential not detected").toBeDefined();
    expect(envHit?.envKey).toBe("MCP_ENDPOINT");
    expect(envHit?.key).toBe("api_key");

    const removed = substituteSecret(server, envHit as DetectedSecret, "MCP_ENDPOINT_API_KEY");
    // substitution MUST report success (plaintext provably removed)…
    expect(removed).toBe(true);
    // …the env value is rewritten to the placeholder…
    expect(server.env.MCP_ENDPOINT).toContain("api_key=${MCP_ENDPOINT_API_KEY}");
    // …the raw credential survives NOWHERE in the server.
    expect(server.env.MCP_ENDPOINT).not.toContain("abcdefghijklmnop1234");
    expect(server.command).toBe("npx");
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
