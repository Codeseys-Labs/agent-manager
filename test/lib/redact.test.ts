/**
 * Redaction must recognise BOTH the legacy `enc:v1:` AES-GCM envelope and the
 * ADR-0042 `enc:v2:age:` envelope (P0-3 §3). Pre-fix, the redactors only knew
 * about `enc:v1:`, so MCP `config_show` and error envelopes would have leaked
 * v2 age ciphertext to untrusted clients — the exact leak class ADR-0019 §5
 * closed for v1.
 */

import { describe, expect, test } from "bun:test";
import { redactConfigSecrets, redactSecretish } from "../../src/lib/redact";

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
  test("redacts a v1 envelope substring", () => {
    const out = redactSecretish("token=enc:v1:aXY=:Y3Q= done");
    expect(out).toContain("[encrypted]");
    expect(out).not.toContain("enc:v1:aXY");
  });

  test("redacts a v2 age envelope substring (was leaking pre-fix)", () => {
    const out = redactSecretish("the value was enc:v2:age:QQQQQQ here");
    expect(out).toContain("[encrypted]");
    expect(out).not.toContain("enc:v2:age:QQQQQQ");
  });
});
