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

  test("preserves enc: envelopes and [redacted]/[encrypted] markers", () => {
    const out = redactConfigPlaintextSecrets({
      settings: { env: { K: "enc:v2:age:QQQ" } },
      other: "[encrypted]",
    }) as { settings: { env: Record<string, string> }; other: string };
    expect(out.settings.env.K).toBe("enc:v2:age:QQQ");
    expect(out.other).toBe("[encrypted]");
  });
});
