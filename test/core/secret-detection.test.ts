import { describe, expect, test } from "bun:test";
import {
  type DetectedSecret,
  redactSecret,
  scanConfigForSecrets,
  scanServerForSecrets,
  substituteSecret,
} from "../../src/core/secret-detection";

describe("scanServerForSecrets", () => {
  test("detects OpenAI API key in env", () => {
    const result = scanServerForSecrets("openai-server", {
      command: "npx",
      args: ["openai-mcp"],
      env: {
        OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
      },
    });

    expect(result.serverName).toBe("openai-server");
    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].location).toBe("env");
    expect(result.secrets[0].key).toBe("OPENAI_API_KEY");
    expect(result.secrets[0].patternName).toBe("OpenAI API key");
    expect(result.secrets[0].confidence).toBe("high");
    expect(result.secrets[0].suggestedEnvVar).toBe("OPENAI_API_KEY");
  });

  test("detects Anthropic API key in env", () => {
    const result = scanServerForSecrets("anthropic-server", {
      command: "npx",
      env: {
        ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890",
      },
    });

    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].patternName).toBe("Anthropic API key");
    expect(result.secrets[0].confidence).toBe("high");
  });

  test("detects Anthropic API key in args", () => {
    const result = scanServerForSecrets("anthropic-server", {
      command: "npx",
      args: ["mcp-server", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890"],
    });

    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].location).toBe("args");
    expect(result.secrets[0].index).toBe(1);
    expect(result.secrets[0].patternName).toBe("Anthropic API key");
    expect(result.secrets[0].confidence).toBe("high");
  });

  test("detects GitHub token in env", () => {
    const result = scanServerForSecrets("gh-server", {
      command: "npx",
      env: {
        GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",
      },
    });

    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].patternName).toBe("GitHub token");
    expect(result.secrets[0].suggestedEnvVar).toBe("GITHUB_TOKEN");
  });

  test("detects Tavily API key in env", () => {
    const result = scanServerForSecrets("tavily", {
      command: "npx",
      env: {
        TAVILY_API_KEY: "tvly-abcdefghijklmnopqrstuvwxyz",
      },
    });

    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].patternName).toBe("Tavily API key");
    expect(result.secrets[0].suggestedEnvVar).toBe("TAVILY_API_KEY");
  });

  test("detects inline env in command", () => {
    const result = scanServerForSecrets("inline-server", {
      command: "API_KEY=mysecretvalue12345678 npx mcp-server",
    });

    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].location).toBe("command");
    expect(result.secrets[0].key).toBe("API_KEY");
    expect(result.secrets[0].value).toBe("mysecretvalue12345678");
    expect(result.secrets[0].patternName).toBe("Inline env in command");
    expect(result.secrets[0].confidence).toBe("medium");
  });

  test("detects --api-key=value in args", () => {
    const result = scanServerForSecrets("cli-server", {
      command: "mcp-server",
      args: ["--port", "3000", "--api-key=my-super-secret-token"],
    });

    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].location).toBe("args");
    expect(result.secrets[0].index).toBe(2);
    expect(result.secrets[0].patternName).toBe("Inline CLI secret");
    expect(result.secrets[0].confidence).toBe("medium");
  });

  test("ignores already-templated values (${VAR})", () => {
    const result = scanServerForSecrets("templated-server", {
      command: "npx",
      args: ["mcp-server"],
      env: {
        OPENAI_API_KEY: "${OPENAI_API_KEY}",
        ANOTHER_SECRET: "prefix-${MY_TOKEN}-suffix",
      },
    });

    expect(result.secrets).toHaveLength(0);
  });

  test("ignores already-encrypted values (enc:v1:)", () => {
    const result = scanServerForSecrets("encrypted-server", {
      command: "npx",
      args: ["enc:v1:abc123:ciphertext"],
      env: {
        API_KEY: "enc:v1:nonce123:encryptedvalue456",
      },
    });

    expect(result.secrets).toHaveLength(0);
  });

  test("rates confidence correctly for generic long secret with secret key name", () => {
    const result = scanServerForSecrets("generic-server", {
      command: "npx",
      env: {
        // Key name matches SECRET_KEY_PATTERNS ("token"), value matches "Generic long secret"
        MY_AUTH_TOKEN: "abcdefghijklmnopqrstuvwxyz01234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890",
      },
    });

    // Should find it — key name matches "token" pattern, value is 40+ chars
    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].confidence).toBe("medium");
  });

  test("rates low confidence for generic long secret without secret key name", () => {
    const result = scanServerForSecrets("generic-server", {
      command: "npx",
      env: {
        // Key name does NOT match any secret patterns
        MY_DATA_VALUE: "abcdefghijklmnopqrstuvwxyz01234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890",
      },
    });

    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].confidence).toBe("low");
  });

  test("detects secret by key name pattern with long value", () => {
    const result = scanServerForSecrets("keyname-server", {
      command: "npx",
      env: {
        // Key matches "api_key" pattern, value is > 15 chars but doesn't match value patterns
        MY_API_KEY: "some-custom-format-key",
      },
    });

    expect(result.secrets).toHaveLength(1);
    expect(result.secrets[0].patternName).toBe("Secret env var name");
    expect(result.secrets[0].confidence).toBe("medium");
    expect(result.secrets[0].suggestedEnvVar).toBe("MY_API_KEY");
  });

  test("does not flag short env values even with secret key names", () => {
    const result = scanServerForSecrets("short-server", {
      command: "npx",
      env: {
        TOKEN: "short", // Only 5 chars, below the 15-char threshold
      },
    });

    expect(result.secrets).toHaveLength(0);
  });

  test("detects multiple secrets in one server", () => {
    const result = scanServerForSecrets("multi-server", {
      command: "npx",
      env: {
        OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
        GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB",
      },
    });

    expect(result.secrets).toHaveLength(2);
  });

  test("returns empty secrets for clean server", () => {
    const result = scanServerForSecrets("clean-server", {
      command: "npx",
      args: ["my-mcp-server", "--port", "3000"],
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
      },
    });

    expect(result.secrets).toHaveLength(0);
  });
});

describe("substituteSecret", () => {
  test("replaces env values with ${VAR}", () => {
    const server = {
      command: "npx",
      env: {
        API_KEY: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
      },
    };
    const secret: DetectedSecret = {
      location: "env",
      key: "API_KEY",
      value: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
      patternName: "OpenAI API key",
      suggestedEnvVar: "OPENAI_API_KEY",
      confidence: "high",
    };

    substituteSecret(server, secret, "OPENAI_API_KEY");
    expect(server.env.API_KEY).toBe("${OPENAI_API_KEY}");
  });

  test("replaces arg values with ${VAR}", () => {
    const server = {
      command: "npx",
      args: ["mcp-server", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
    };
    const secret: DetectedSecret = {
      location: "args",
      value: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      index: 1,
      patternName: "Anthropic API key",
      suggestedEnvVar: "ANTHROPIC_API_KEY",
      confidence: "high",
    };

    substituteSecret(server, secret, "ANTHROPIC_API_KEY");
    expect(server.args[1]).toBe("${ANTHROPIC_API_KEY}");
  });

  test("replaces inline env in command with ${VAR}", () => {
    const server = {
      command: "API_KEY=mysecretvalue12345678 npx mcp-server",
    };
    const secret: DetectedSecret = {
      location: "command",
      key: "API_KEY",
      value: "mysecretvalue12345678",
      patternName: "Inline env in command",
      suggestedEnvVar: "API_KEY",
      confidence: "medium",
    };

    substituteSecret(server, secret, "API_KEY");
    expect(server.command).toBe("API_KEY=${API_KEY} npx mcp-server");
  });

  test("replaces --key=value in args correctly", () => {
    const server = {
      command: "mcp-server",
      args: ["--api-key=my-super-secret-token"],
    };
    const secret: DetectedSecret = {
      location: "args",
      key: "api-key",
      value: "my-super-secret-token",
      index: 0,
      patternName: "Inline CLI secret",
      suggestedEnvVar: "API_KEY",
      confidence: "medium",
    };

    substituteSecret(server, secret, "API_KEY");
    expect(server.args[0]).toBe("--api-key=${API_KEY}");
  });
});

describe("redactSecret", () => {
  test("shows first/last 4 chars for long values", () => {
    expect(redactSecret("sk-abcdefghijklmnopqrstuvwxyz")).toBe("sk-a...wxyz");
  });

  test("returns **** for short values", () => {
    expect(redactSecret("short123")).toBe("****");
  });

  test("returns **** for values of exactly 12 chars", () => {
    expect(redactSecret("123456789012")).toBe("****");
  });

  test("shows first/last 4 for 13-char values", () => {
    expect(redactSecret("1234567890123")).toBe("1234...0123");
  });
});

describe("scanConfigForSecrets", () => {
  test("scans all servers and returns only those with secrets", () => {
    const servers = {
      clean: {
        command: "npx",
        args: ["clean-mcp"],
        env: { NODE_ENV: "production" },
      },
      leaky: {
        command: "npx",
        args: ["leaky-mcp"],
        env: { OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz1234567890" },
      },
      "also-clean": {
        command: "npx",
        args: ["another-mcp"],
      },
    };

    const results = scanConfigForSecrets(servers);
    expect(results).toHaveLength(1);
    expect(results[0].serverName).toBe("leaky");
    expect(results[0].secrets).toHaveLength(1);
  });

  test("returns empty array when no secrets found", () => {
    const servers = {
      clean: { command: "npx", env: { NODE_ENV: "production" } },
    };

    const results = scanConfigForSecrets(servers);
    expect(results).toHaveLength(0);
  });

  test("scans multiple servers with secrets", () => {
    const servers = {
      server1: {
        command: "npx",
        env: { API_KEY: "sk-abcdefghijklmnopqrstuvwxyz1234567890" },
      },
      server2: {
        command: "npx",
        env: { GH_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" },
      },
    };

    const results = scanConfigForSecrets(servers);
    expect(results).toHaveLength(2);
  });
});
