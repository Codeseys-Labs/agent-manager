/**
 * URL-credential detection tests (issue #3 problem 2).
 *
 * Wave-1 / 2026-05-03: HTTP MCP servers with API keys embedded as URL
 * query parameters must be detected and the whole apply pipeline must
 * refuse to write native configs that leak them. This test pins:
 *   - CREDENTIAL_QUERY_KEYS regex matching (tavilyApiKey, api_key, token,
 *     password, secret_key)
 *   - `${VAR}` / `{{VAR}}` / `<VAR>` placeholders are exempt (legitimate
 *     env interpolation)
 *   - short/unsuspicious values (< 8 chars) don't trigger
 *   - non-URL strings are skipped
 *   - scanServersForUrlCredentials walks both server.command and
 *     adapter.<name>.url
 *   - formatCredentialHits never echoes the raw secret
 */

import { describe, expect, test } from "bun:test";
import {
  formatCredentialHits,
  scanServersForUrlCredentials,
  scanUrlForCredentials,
} from "../../src/core/url-credentials";

describe("scanUrlForCredentials", () => {
  test("detects camelCase vendor-prefixed API keys (tavilyApiKey)", () => {
    const hits = scanUrlForCredentials(
      "https://mcp.tavily.com/mcp/?tavilyApiKey=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",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].queryKey).toBe("tavilyApiKey");
    expect(hits[0].redactedValue).toBe("tvly-b…");
    expect(hits[0].suggestedEnvVar).toBe("${TAVILYAPIKEY}");
  });

  test("detects api_key / token / secret / password", () => {
    const keys = ["api_key", "token", "secret", "password", "access_key", "auth_token"];
    for (const k of keys) {
      const hits = scanUrlForCredentials(`https://example.com/mcp/?${k}=abc1234567890xyz`);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].queryKey).toBe(k);
    }
  });

  test("skips ${VAR} placeholder values (legitimate interpolation)", () => {
    const hits = scanUrlForCredentials(
      "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}",
    );
    expect(hits).toHaveLength(0);
  });

  test("skips {{VAR}} placeholder values", () => {
    const hits = scanUrlForCredentials(
      "https://mcp.tavily.com/mcp/?tavilyApiKey={{TAVILY_API_KEY}}",
    );
    expect(hits).toHaveLength(0);
  });

  test("skips short values under 8 chars", () => {
    const hits = scanUrlForCredentials("https://example.com/mcp/?apiKey=short");
    expect(hits).toHaveLength(0);
  });

  test("returns [] for non-URL strings", () => {
    expect(scanUrlForCredentials("not-a-url")).toEqual([]);
    expect(scanUrlForCredentials("npx some-command")).toEqual([]);
  });

  test("doesn't flag non-credential query params", () => {
    const hits = scanUrlForCredentials("https://example.com/mcp/?session=abc123xyz456&timeout=30");
    expect(hits).toHaveLength(0);
  });
});

describe("scanServersForUrlCredentials", () => {
  test("walks server.command when it is an http URL", () => {
    const hits = scanServersForUrlCredentials({
      tavily: {
        command: "https://mcp.tavily.com/mcp/?tavilyApiKey=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",
      },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].serverName).toBe("tavily");
    expect(hits[0].queryKey).toBe("tavilyApiKey");
  });

  test("walks adapter-specific .url fields", () => {
    const hits = scanServersForUrlCredentials({
      exa: {
        command: "npx",
        args: ["-y", "exa-mcp"],
        adapters: {
          cursor: { url: "https://mcp.exa.ai/mcp/?exaApiKey=e1234567890abcdef1234" },
        },
      },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].serverName).toBe("exa");
  });

  test("ignores stdio-only servers", () => {
    const hits = scanServersForUrlCredentials({
      context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
      time: { command: "uvx", args: ["mcp-server-time"] },
    });
    expect(hits).toHaveLength(0);
  });

  test("handles empty map", () => {
    expect(scanServersForUrlCredentials({})).toEqual([]);
  });
});

describe("formatCredentialHits", () => {
  test("never emits the raw secret value", () => {
    const msg = formatCredentialHits([
      {
        serverName: "tavily",
        url: "https://mcp.tavily.com/mcp/?tavilyApiKey=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",
        queryKey: "tavilyApiKey",
        redactedValue: "tvly-b…",
        suggestedEnvVar: "${TAVILYAPIKEY}",
      },
    ]);
    expect(msg).not.toContain("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");
    expect(msg).toContain("tvly-b…");
    expect(msg).toContain("tavily");
    expect(msg).toContain("${TAVILYAPIKEY}");
  });

  test("returns empty string when hits is empty", () => {
    expect(formatCredentialHits([])).toBe("");
  });
});
