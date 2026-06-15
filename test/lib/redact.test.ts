/**
 * Redaction must recognise BOTH the legacy `enc:v1:` AES-GCM envelope and the
 * ADR-0042 `enc:v2:age:` envelope (P0-3 §3). Pre-fix, the redactors only knew
 * about `enc:v1:`, so MCP `config_show` and error envelopes would have leaked
 * v2 age ciphertext to untrusted clients — the exact leak class ADR-0019 §5
 * closed for v1.
 */

import { describe, expect, test } from "bun:test";
import {
  redactConfigPlaintextSecrets,
  redactConfigSecrets,
  redactSecretish,
  stripUrlUserinfo,
} from "../../src/lib/redact";

describe("redactConfigSecrets — structural envelope redaction", () => {
  test("redacts a v1 AES-GCM envelope", () => {
    const out = redactConfigSecrets({ env: { KEY: "enc:v1:aXY=:Y3Q=" } });
    expect(out).toEqual({ env: { KEY: "[encrypted]" } });
  });

  test("redacts a v2 age envelope (was leaking pre-fix)", () => {
    const out = redactConfigSecrets({ env: { KEY: "enc:v2:age:QQQQQQ" } });
    expect(out).toEqual({ env: { KEY: "[encrypted]" } });
  });

  test("redacts an unknown enc: envelope by default (fail safe)", () => {
    const out = redactConfigSecrets({ env: { KEY: "enc:v99:future" } });
    expect(out).toEqual({ env: { KEY: "[encrypted]" } });
  });

  test("leaves plaintext and templated values untouched", () => {
    const out = redactConfigSecrets({ a: "plain", b: "${VAR}", c: 42 });
    expect(out).toEqual({ a: "plain", b: "${VAR}", c: 42 });
  });

  test("walks nested structures and arrays", () => {
    const out = redactConfigSecrets({
      servers: { s: { env: { K: "enc:v2:age:ZZZZ" } } },
      list: ["enc:v1:a:b", "keep-me"],
    });
    expect(out).toEqual({
      servers: { s: { env: { K: "[encrypted]" } } },
      list: ["[encrypted]", "keep-me"],
    });
  });
});

describe("redactSecretish — free-form envelope redaction", () => {
  test("redacts a v1 envelope substring — including the ciphertext body", () => {
    const out = redactSecretish("token=enc:v1:aXY=:Y3Q= done");
    expect(out).toContain("[encrypted]");
    expect(out).not.toContain("enc:v1:aXY");
    // The Wave 2 review caught that the iv:ct colon split left <ct_b64>
    // exposed. Assert the ciphertext segment is gone, not just the prefix.
    expect(out).not.toContain("Y3Q=");
    expect(out).toBe("token=[encrypted] done");
  });

  test("redacts a v2 age envelope substring (was leaking pre-fix)", () => {
    const out = redactSecretish("the value was enc:v2:age:QQQQQQ here");
    expect(out).toContain("[encrypted]");
    expect(out).not.toContain("enc:v2:age:QQQQQQ");
  });

  // Wave-4 review R3-SEC: error bodies (e.g. a failed git push) echoed a
  // credential-bearing remote URL verbatim. safeErrorMessage runs
  // redactSecretish, so the URL-userinfo pattern must scrub it.
  test("strips credential userinfo from a URL embedded in error text", () => {
    const out = redactSecretish(
      "fatal: unable to push to https://x-access-token:ghp_abcdEFGH1234567890ab@github.com/o/r.git",
    );
    expect(out).not.toContain("ghp_abcdEFGH1234567890ab");
    expect(out).not.toContain("x-access-token");
    expect(out).toContain("https://[redacted]@github.com/o/r.git");
  });
});

describe("redactSecretish — bare vendor tokens & connection strings (L6)", () => {
  // L6: SECRET_PATTERNS was a known-prefix allowlist with no rule for the
  // distinctive vendor token shapes already keyed by NAME in
  // src/core/secret-detection.ts (tvly-, r8_) nor for credential-less
  // connection strings. These passed verbatim into free-form error output.
  test("redacts a Tavily tvly- token embedded in an error message", () => {
    const out = redactSecretish("Request failed: invalid key tvly-FAKEFIXTURE1234567890 supplied");
    expect(out).not.toContain("tvly-FAKEFIXTURE1234567890");
    expect(out).toContain("[REDACTED_TAVILY_KEY]");
  });

  test("redacts a Replicate r8_ token embedded in an error message", () => {
    const out = redactSecretish(
      "auth error: token r8_abCDef0123456789ABCDef0123456789abcdef rejected",
    );
    expect(out).not.toContain("r8_abCDef0123456789ABCDef0123456789abcdef");
    expect(out).toContain("[REDACTED_REPLICATE_KEY]");
  });

  test("redacts a credential-less postgres:// connection string", () => {
    const out = redactSecretish(
      "could not connect to postgres://app_user@db.internal:5432/prod the host is down",
    );
    expect(out).not.toContain("app_user");
    expect(out).not.toContain("db.internal");
    expect(out).not.toContain("prod");
    expect(out).toContain("[REDACTED_CONNECTION_STRING]");
    // surrounding prose is preserved
    expect(out).toContain("could not connect to");
    expect(out).toContain("the host is down");
  });

  test("redacts mysql://, mongodb:// and redis:// connection strings (with creds)", () => {
    const out = redactSecretish(
      [
        "mysql://root:hunter2@10.0.0.1:3306/app",
        "mongodb://u:p4ss@cluster0.mongodb.net/db",
        "redis://default:s3cr3t@cache:6379/0",
      ].join(" | "),
    );
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("p4ss");
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("cluster0.mongodb.net");
    expect(out).not.toContain("10.0.0.1");
  });

  test("leaves an ordinary sentence unchanged", () => {
    const plain = "The server returned a 500 error while loading the dashboard.";
    expect(redactSecretish(plain)).toBe(plain);
  });

  test("does not redact a benign URL that merely resembles a scheme", () => {
    // https:// is not in the connection-string scheme set, so a plain web URL
    // with no credential must survive (no over-redaction).
    const plain = "see https://example.com/docs/postgres for setup help";
    expect(redactSecretish(plain)).toBe(plain);
  });
});

describe("stripUrlUserinfo", () => {
  test("removes user:token@ from a URL", () => {
    expect(stripUrlUserinfo("https://user:p4ss@host/repo.git")).toBe(
      "https://[redacted]@host/repo.git",
    );
  });
  test("leaves a credential-free URL untouched", () => {
    expect(stripUrlUserinfo("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });
  test("does not maul non-URL prose containing @", () => {
    expect(stripUrlUserinfo("ping me at alice@example.com")).toBe("ping me at alice@example.com");
  });

  // R4-SEC1: credential-bearing query params must be masked too.
  test("masks a camelCase ApiKey query param (?tavilyApiKey=)", () => {
    const out = stripUrlUserinfo("https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-realkey1234567890");
    expect(out).not.toContain("tvly-realkey1234567890");
    expect(out).toContain("tavilyApiKey=[redacted]");
    expect(out).toContain("mcp.tavily.com");
  });

  test("masks ?token= and ?api_key= query params, leaves benign params", () => {
    const out = stripUrlUserinfo("https://h/x?token=abc123&page=2&api_key=sk-zzz");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("sk-zzz");
    expect(out).toContain("page=2");
  });

  test("strips BOTH userinfo and a credential query param in one URL", () => {
    const out = stripUrlUserinfo("https://u:p4ss@host/mcp?accessToken=secretvalue123");
    expect(out).not.toContain("p4ss");
    expect(out).not.toContain("secretvalue123");
    expect(out).toContain("[redacted]@host");
    expect(out).toContain("accessToken=[redacted]");
  });
});

describe("redactConfigPlaintextSecrets — Wave-4 non-env secret coverage (R2-SEC3)", () => {
  test("masks env-map values by location regardless of shape", () => {
    const out = redactConfigPlaintextSecrets({
      settings: { env: { TAVILY_API_KEY: "tvly-plainvalue", DEBUG: "true" } },
    }) as { settings: { env: Record<string, string> } };
    expect(out.settings.env.TAVILY_API_KEY).toBe("[redacted]");
    // every env value is a secret slot by location, including non-secret-shaped
    expect(out.settings.env.DEBUG).toBe("[redacted]");
  });

  test("masks settings.a2a.auth_token (named secret outside an env map)", () => {
    const out = redactConfigPlaintextSecrets({
      settings: { a2a: { auth_token: "hunter2hunter2hunter2" } },
    }) as { settings: { a2a: { auth_token: string } } };
    expect(out.settings.a2a.auth_token).toBe("[redacted]");
  });

  test("masks values inside a headers table", () => {
    const out = redactConfigPlaintextSecrets({
      servers: { foo: { headers: { Authorization: "Bearer raw-plaintext-key" } } },
    }) as { servers: { foo: { headers: Record<string, string> } } };
    expect(out.servers.foo.headers.Authorization).toBe("[redacted]");
  });

  test("strips credential userinfo from a server URL value", () => {
    const out = redactConfigPlaintextSecrets({
      servers: { foo: { url: "https://user:p4ssw0rd@host/mcp" } },
    }) as { servers: { foo: { url: string } } };
    expect(out.servers.foo.url).not.toContain("p4ssw0rd");
    expect(out.servers.foo.url).toContain("[redacted]@host/mcp");
  });

  test("strips a credential query param from a server command/url (R4-SEC1)", () => {
    const out = redactConfigPlaintextSecrets({
      servers: {
        tavily: { command: "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-realkey1234567890" },
      },
    }) as { servers: { tavily: { command: string } } };
    expect(out.servers.tavily.command).not.toContain("tvly-realkey1234567890");
    expect(out.servers.tavily.command).toContain("tavilyApiKey=[redacted]");
  });

  test("masks opaque secrets under adapters/passthrough/partial-name keys (R4-MED1)", () => {
    const out = redactConfigPlaintextSecrets({
      servers: { foo: { adapters: { myAdapter: { apiToken: "opaque-no-shape-value-xyz" } } } },
      settings: {
        secrets: { customBackendCreds: "opaque-creds-abc" },
        my_auth_token: "partial-name-secret-123",
        clientSecret: "client-secret-456",
      },
    }) as {
      servers: { foo: { adapters: { myAdapter: { apiToken: string } } } };
      settings: {
        secrets: { customBackendCreds: string };
        my_auth_token: string;
        clientSecret: string;
      };
    };
    // adapters subtable → secret-by-location.
    expect(out.servers.foo.adapters.myAdapter.apiToken).toBe("[redacted]");
    // customBackendCreds (contains "cred") + my_auth_token ("token") +
    // clientSecret ("secret") → substring named-secret match.
    expect(out.settings.secrets.customBackendCreds).toBe("[redacted]");
    expect(out.settings.my_auth_token).toBe("[redacted]");
    expect(out.settings.clientSecret).toBe("[redacted]");
  });

  test("masks a secret-shaped value used as a TOML key NAME (R4-LOW)", () => {
    const out = redactConfigPlaintextSecrets({
      tokens: { ghp_REALTOKEN1234567890abcdefABCDEF12: "label" },
    }) as { tokens: Record<string, string> };
    // The ghp_ key must not survive verbatim.
    const keys = Object.keys(out.tokens);
    expect(keys.some((k) => k.includes("ghp_REALTOKEN"))).toBe(false);
  });

  test("does not over-redact benign keys/values", () => {
    const out = redactConfigPlaintextSecrets({
      settings: { default_profile: "dev", log_level: "info" },
      servers: { foo: { command: "uvx", transport: "stdio", description: "a fetch server" } },
    }) as {
      settings: { default_profile: string; log_level: string };
      servers: { foo: { command: string; description: string } };
    };
    expect(out.settings.default_profile).toBe("dev");
    expect(out.settings.log_level).toBe("info");
    expect(out.servers.foo.command).toBe("uvx");
    expect(out.servers.foo.description).toBe("a fetch server");
  });

  test("preserves enc: envelopes and [redacted]/[encrypted] markers", () => {
    const out = redactConfigPlaintextSecrets({
      settings: { env: { K: "enc:v2:age:QQQ" } },
      other: "[encrypted]",
    }) as { settings: { env: Record<string, string> }; other: string };
    expect(out.settings.env.K).toBe("enc:v2:age:QQQ");
    expect(out.other).toBe("[encrypted]");
  });
});
