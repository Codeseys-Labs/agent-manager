/**
 * Wave 2.B: secret redaction in MCP error envelopes.
 *
 * The dispatcher catches handler exceptions and surfaces `err.message` back
 * to the client. Handlers sometimes interpolate sensitive values (bearer
 * tokens, decrypted API keys) into those messages. We run them through
 * `safeErrorMessage` before shipping them to the caller.
 */
import { describe, expect, test } from "bun:test";
import { redactSecretish, safeErrorMessage } from "../../src/lib/redact";

describe("redactSecretish", () => {
  test("redacts Bearer tokens", () => {
    const input = "Upstream returned 401. Authorization: Bearer sk_live_abcd1234efgh5678";
    const out = redactSecretish(input);
    expect(out).not.toContain("sk_live_abcd1234efgh5678");
    expect(out).toContain("Bearer [REDACTED]");
  });

  test("redacts lowercase bearer prefix", () => {
    const input = "bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxxxxxxx";
    const out = redactSecretish(input);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  test("redacts AWS access keys", () => {
    const input = "Failed to auth with AKIAIOSFODNN7EXAMPLE";
    const out = redactSecretish(input);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED_AWS_KEY]");
  });

  test("redacts Anthropic keys", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-api01-abcdefghijklmnopqrstuvwxyz";
    const out = redactSecretish(input);
    expect(out).not.toContain("sk-ant-api01-abcdefghijklmnopqrstuvwxyz");
  });

  test("redacts OpenAI-style keys", () => {
    const input = "Got 401 from provider with key sk-abcdefghijklmnopqrstuvwxyz123456";
    const out = redactSecretish(input);
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  test("redacts GitHub PATs", () => {
    const input = "git push failed: remote: ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const out = redactSecretish(input);
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).toContain("[REDACTED_GH_TOKEN]");
  });

  test("redacts Slack tokens", () => {
    const input = "slack auth failure: xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx";
    const out = redactSecretish(input);
    expect(out).not.toContain("xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx");
  });

  test("redacts key=value forms of api_key / password / token", () => {
    const input = "failed: api_key=sk_live_zz123456789012, password=hunter2longer";
    const out = redactSecretish(input);
    expect(out).not.toContain("sk_live_zz123456789012");
    expect(out).not.toContain("hunter2longer");
  });

  test("redacts enc:v1 sentinel values", () => {
    const input = "decryption failed for enc:v1:abcdefgh1234567890";
    const out = redactSecretish(input);
    expect(out).not.toContain("enc:v1:abcdefgh1234567890");
    expect(out).toContain("[encrypted]");
  });

  test("passes through benign messages unchanged", () => {
    const input = "server foo not found. Use am_list_servers to see available names.";
    expect(redactSecretish(input)).toBe(input);
  });

  test("safeErrorMessage handles Error objects", () => {
    const e = new Error("leaked: Bearer sk_live_very_secret_token_xyz123");
    const out = safeErrorMessage(e);
    expect(out).not.toContain("sk_live_very_secret_token_xyz123");
    expect(out).toContain("Bearer [REDACTED]");
  });

  test("safeErrorMessage handles non-Error values", () => {
    expect(safeErrorMessage("plain string")).toBe("plain string");
    expect(safeErrorMessage(42)).toBe("42");
    expect(safeErrorMessage(undefined)).toBe("undefined");
  });
});
