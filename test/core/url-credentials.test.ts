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
  buildSuggestedReplacementUrl,
  deriveBareEnvName,
  formatCredentialHits,
  rewriteUrlParam,
  rewriteUserinfoCredential,
  scanServersForUrlCredentials,
  scanUrlForCredentials,
} from "../../src/core/url-credentials";

describe("scanUrlForCredentials", () => {
  test("detects camelCase vendor-prefixed API keys (tavilyApiKey)", () => {
    const hits = scanUrlForCredentials(
      "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-FAKEFIXTURE1234567890",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].queryKey).toBe("tavilyApiKey");
    expect(hits[0].redactedValue).toBe("tvly-F…");
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

  test("skips short values under 8 chars on NON-credential-named keys", () => {
    // M7 update: the <8 length floor only bounds false positives on keys that
    // are NOT credential-named. A short value under a credential-named key
    // (e.g. apiKey=short) IS now flagged — see the M7 gap-2 test below.
    const hits = scanUrlForCredentials("https://example.com/mcp/?ref=short");
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

  test("REV-1: does NOT match compound-noun 'publickey'/'sandboxkey'/'proxykey'", () => {
    // Pre-REV-1 the `/^[a-z]+_?key$/i` pattern had optional `_` which
    // caused `publickey` (no separator) to be a false positive. Now the
    // pattern requires a separator ([_-]key).
    for (const key of ["publickey", "sandboxkey", "proxykey", "sshkey", "pubkey"]) {
      const hits = scanUrlForCredentials(`https://example.com/?${key}=testvalue1234`);
      expect(hits, `false positive on ${key}`).toHaveLength(0);
    }
  });

  test("REV-1: DOES still match separator-bearing compounds 'exa_key', 'tavily-key'", () => {
    for (const key of ["exa_key", "tavily-key", "my_access_key"]) {
      const hits = scanUrlForCredentials(`https://example.com/?${key}=longenoughvalue123`);
      expect(hits.length, `missed ${key}`).toBeGreaterThan(0);
    }
  });

  // ── M7 gap 2: short credential-NAMED values must still be flagged ──
  test("M7 gap-2: flags a SHORT credential-named query value (token=abc123)", () => {
    // The <8 length floor must NOT exempt a credential-NAMED key. A short
    // `token` value is still a leaked credential — fail closed.
    const hits = scanUrlForCredentials("https://example.com/mcp/?token=abc123");
    expect(hits).toHaveLength(1);
    expect(hits[0].queryKey).toBe("token");
    expect(hits[0].rawValue).toBe("abc123");
  });

  test("M7 gap-2 negative: a SHORT non-credential-named value (page=2) is NOT flagged", () => {
    // Bound false positives: the length floor still applies to keys that are
    // not credential-named, so short pagination/option params stay clean.
    const hits = scanUrlForCredentials("https://example.com/mcp/?page=2&limit=10");
    expect(hits).toHaveLength(0);
  });

  // ── M7 gap 3: userinfo credentials (https://user:s3cret@host) ──
  test("M7 gap-3: detects userinfo credential https://user:s3cret@host", () => {
    const hits = scanUrlForCredentials("https://user:s3cret@host.example.com/mcp/");
    expect(hits.length).toBeGreaterThan(0);
    // The raw password must be captured for the encrypt-on-ingest path…
    const userinfoHit = hits.find((h) => h.rawValue === "s3cret");
    expect(userinfoHit, "userinfo password not captured").toBeDefined();
    // …and the redacted preview must NOT leak the full secret.
    expect(userinfoHit?.redactedValue).not.toBe("s3cret");
  });

  test("M7 gap-3: a userinfo URL with no credentials is NOT flagged", () => {
    // No username/password → nothing to flag.
    const hits = scanUrlForCredentials("https://host.example.com/mcp/?page=2");
    expect(hits).toHaveLength(0);
  });
});

describe("scanServersForUrlCredentials", () => {
  test("walks server.command when it is an http URL", () => {
    const hits = scanServersForUrlCredentials({
      tavily: {
        command: "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-FAKEFIXTURE1234567890",
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

  test("REV-NB-2: walks server.args[] for URL-shaped tokens (Codex-CLI wrapper style)", () => {
    // Before REV-NB-2 a server like { command:'npx', args:['mcp-remote',
    // 'https://…?api_key=…'] } would pass the guard silently because the
    // credential was in args, not command. After: args[] URL-shaped
    // tokens are scanned too.
    const hits = scanServersForUrlCredentials({
      wrapped: {
        command: "npx",
        args: ["mcp-remote", "https://mcp.example.com/?api_key=abcdefghijklmnop1234"],
      },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].serverName).toBe("wrapped");
    expect(hits[0].queryKey).toBe("api_key");
  });

  // ── M7 gap 1: server.env values were never scanned ──
  test("M7 gap-1: detects a credential URL inside a server.env value", () => {
    // A credential URL stashed in env was undetected at apply/ingest because
    // the scan never iterated server.env. Now it must surface with
    // source:'env' and the originating envKey.
    const hits = scanServersForUrlCredentials({
      enved: {
        command: "npx",
        args: ["-y", "some-mcp"],
        env: {
          MCP_ENDPOINT: "https://mcp.example.com/?api_key=abcdefghijklmnop1234",
          UNRELATED: "plain-value",
        },
      },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].serverName).toBe("enved");
    expect(hits[0].queryKey).toBe("api_key");
    expect(hits[0].source).toBe("env");
    expect(hits[0].envKey).toBe("MCP_ENDPOINT");
  });

  test("M7 gap-1: env values that are not URLs are ignored", () => {
    const hits = scanServersForUrlCredentials({
      enved: {
        command: "npx",
        env: { TOKEN: "abcdef1234567890", REGION: "us-east-1" },
      },
    });
    expect(hits).toHaveLength(0);
  });
});

describe("formatCredentialHits", () => {
  test("never emits the raw secret value", () => {
    const msg = formatCredentialHits([
      {
        serverName: "tavily",
        url: "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-FAKEFIXTURE1234567890",
        queryKey: "tavilyApiKey",
        redactedValue: "tvly-F…",
        rawValue: "tvly-FAKEFIXTURE1234567890",
        suggestedEnvVar: "${TAVILYAPIKEY}",
        source: "command",
      },
    ]);
    expect(msg).not.toContain("tvly-FAKEFIXTURE1234567890");
    expect(msg).toContain("tvly-F…");
    expect(msg).toContain("tavily");
    expect(msg).toContain("${TAVILYAPIKEY}");
  });

  test("returns empty string when hits is empty", () => {
    expect(formatCredentialHits([])).toBe("");
  });

  test("REV-2: multi-param URLs never leak the second raw credential in suggested-fix", () => {
    // Pre-REV-2 the error message used /=([^&]+)/.replace which replaced
    // only the first `=…` match, leaving the second raw credential in the
    // displayed fix. Now the URL API's searchParams.set is used so only
    // the offending param is rewritten.
    const rawTwo = "other-raw-credential-value-xyz-1234";
    const msg = formatCredentialHits([
      {
        serverName: "twokeys",
        url: `https://example.com/?api_key=first-raw-credential&token=${rawTwo}`,
        queryKey: "api_key",
        redactedValue: "first-…",
        rawValue: "first-raw-credential",
        suggestedEnvVar: "${API_KEY}",
        source: "command",
      },
    ]);
    // api_key should be placeholdered.
    expect(msg).toContain("${API_KEY}");
    // The second raw credential (in a DIFFERENT param) must not leak
    // into the suggested-fix line.
    expect(msg).not.toContain(rawTwo);
  });

  test("M7 gap-3 regression: userinfo raw secret NEVER leaks in the suggested fix", () => {
    // searchParams.set would APPEND a query param and leave the raw
    // `user:s3cretLONGvalue@` in the authority — leaking plaintext in the
    // copy-paste fix. The userinfo-aware path rewrites/masks the authority.
    const rawPw = "s3cretLONGvalue123";
    const rawUser = "adminUSERvalue456";
    const url = `https://${rawUser}:${rawPw}@host.example.com/mcp/`;
    const hits = scanUrlForCredentials(url).map((h) => ({
      ...h,
      serverName: "u",
      source: "command" as const,
    }));
    const msg = formatCredentialHits(hits);
    // Neither raw userinfo secret may appear anywhere in the output.
    expect(msg, "raw password leaked").not.toContain(rawPw);
    expect(msg, "raw username leaked").not.toContain(rawUser);
    // The placeholder must be present.
    expect(msg).toContain("${PASSWORD}");
  });
});

// ── Obfuscate-on-ingest support: rawValue + deriveBareEnvName + rewriteUrlParam ──

describe("scanUrlForCredentials — rawValue (for the encrypt-on-ingest path)", () => {
  test("exposes the FULL raw credential value (not just the redacted preview)", () => {
    const hits = scanUrlForCredentials(
      "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-FAKEFIXTURE1234567890",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].rawValue).toBe("tvly-FAKEFIXTURE1234567890");
    // redactedValue stays truncated for display.
    expect(hits[0].redactedValue).toBe("tvly-F…");
    expect(hits[0].redactedValue).not.toBe(hits[0].rawValue);
  });
});

describe("deriveBareEnvName", () => {
  test("derives a bare POSIX env-var name from the query key", () => {
    expect(deriveBareEnvName("tavilyApiKey")).toBe("TAVILYAPIKEY");
    expect(deriveBareEnvName("api_key")).toBe("API_KEY");
    expect(deriveBareEnvName("my-access-key")).toBe("MY_ACCESS_KEY");
  });
  test("result is a valid POSIX env-var identifier", () => {
    for (const k of ["tavilyApiKey", "api_key", "exa_key", "x-token"]) {
      expect(deriveBareEnvName(k)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });
});

describe("rewriteUrlParam (write-path-safe, non-masking)", () => {
  test("rewrites ONLY the target param and leaves siblings (incl. credentials) intact", () => {
    const url = "https://example.com/mcp?api_key=SECRETONE12345&token=SECRETTWO67890&tools=x,y";
    const out = rewriteUrlParam(url, "api_key", "${API_KEY}");
    expect(out).toContain("api_key=${API_KEY}");
    // Sibling credential is NOT masked (the ingest loop encrypts it in its own pass).
    expect(out).toContain("token=SECRETTWO67890");
    expect(out).toContain("tools=x%2Cy"); // other params preserved (encoded)
  });
  test("emits a literal ${VAR} (de-percent-encoded), what the interpolator expects", () => {
    const out = rewriteUrlParam(
      "https://x/?tavilyApiKey=tvly-aaaaaaaa",
      "tavilyApiKey",
      "${TAVILYAPIKEY}",
    );
    expect(out).toContain("tavilyApiKey=${TAVILYAPIKEY}");
    expect(out).not.toContain("%24%7B");
  });
  test("contrast: buildSuggestedReplacementUrl DOES mask sibling creds (display-only)", () => {
    const url = "https://example.com/mcp?api_key=SECRETONE12345&token=SECRETTWO67890";
    const display = buildSuggestedReplacementUrl(url, "api_key", "${API_KEY}");
    expect(display).toContain("api_key=${API_KEY}");
    expect(display).not.toContain("SECRETTWO67890"); // masked for safe copy-paste
    expect(display).toContain("REDACTED");
  });

  test("seed 2ce0: does NOT append a bogus param when the key is not a query param", () => {
    // A userinfo "password" key is NOT a query param. The old code did
    // searchParams.set("password", …) which APPENDED `?password=${VAR}` while
    // leaving `user:s3cret@` PLAINTEXT in the authority. The guard now leaves the
    // URL untouched so the caller's post-check fails closed instead of emitting a
    // corrupted-yet-still-leaking URL.
    const url = "https://user:s3cret@host.example.com/mcp";
    const out = rewriteUrlParam(url, "password", "${HOST_PASSWORD}");
    expect(out).toBe(url); // unchanged — no bogus ?password=
    expect(out).not.toContain("?password=");
    expect(out).not.toContain("&password=");
  });
});

describe("rewriteUserinfoCredential (write-path-safe userinfo rewrite)", () => {
  test("rewrites the userinfo password to a literal ${VAR}, removing plaintext", () => {
    const out = rewriteUserinfoCredential(
      "https://user:s3cr3tpass@host.example.com/mcp",
      "password",
      "${HOST_PASSWORD}",
    );
    expect(out).not.toContain("s3cr3tpass");
    expect(out).toContain("${HOST_PASSWORD}");
    expect(out).not.toContain("%24%7B"); // literal, not percent-encoded
  });

  test("rewrites the userinfo username and leaves the password sibling intact", () => {
    // Unlike the display path, the write path must NOT mask the sibling — the
    // ingest loop encrypts each hit in its own pass.
    const out = rewriteUserinfoCredential(
      "https://adminUSER:s3cr3tpass@host.example.com/mcp",
      "username",
      "${HOST_USERNAME}",
    );
    expect(out).not.toContain("adminUSER");
    expect(out).toContain("${HOST_USERNAME}");
    expect(out).toContain("s3cr3tpass"); // sibling preserved for its own pass
  });

  test("returns the input unchanged for a non-URL string", () => {
    expect(rewriteUserinfoCredential("not-a-url", "password", "${X}")).toBe("not-a-url");
  });
});
