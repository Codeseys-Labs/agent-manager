/**
 * Regression: GET /api/config must mask EVERY encrypted-secret envelope, not
 * just the legacy `enc:v1:` AES-GCM form.
 *
 * The web server used to carry a FORKED redactor that only matched the
 * `enc:v1:` prefix. After `am secrets migrate --to age`, stored secrets become
 * ADR-0042 `enc:v2:age:...` envelopes — which the fork ignored, so the FULL age
 * ciphertext body was returned to the client. This file seeds a config with
 * BOTH an `enc:v1:` and an `enc:v2:age:` value (in settings.env AND a server
 * env map) and asserts both render as the canonical "[encrypted]" placeholder
 * with NO ciphertext body surviving. The endpoint now reuses the canonical
 * `redactConfigSecrets` (src/lib/redact.ts), which matches the broad `enc:`
 * prefix.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { initRepo } from "../../src/core/git";
import { createApp, ensureAuthToken } from "../../src/web/server";

// Realistic-shaped ciphertext bodies (base64) — these must NOT leak.
const V1_CIPHERTEXT = "enc:v1:YWJjZGVmZ2hpamtsbW5vcA==:c2VjcmV0Y2lwaGVydGV4dGJvZHk=";
const V2_CIPHERTEXT = "enc:v2:age:YWdlLWVuY3J5cHRlZC1zZWNyZXQtY2lwaGVydGV4dC1ib2R5LWhlcmU=";
// Body fragments that prove no raw ciphertext escaped.
const V1_BODY_FRAGMENT = "c2VjcmV0Y2lwaGVydGV4dGJvZHk=";
const V2_BODY_FRAGMENT = "YWdlLWVuY3J5cHRlZC1zZWNyZXQtY2lwaGVydGV4dC1ib2R5LWhlcmU=";

let tmpDir: string;
let authToken: string;
const originalEnv = process.env.AM_CONFIG_DIR;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "am-web-redact-"));
  await initRepo(tmpDir);

  const config = {
    settings: {
      default_profile: "default",
      env: {
        // v1 legacy AES-GCM secret lives in settings.env
        LEGACY_API_KEY: V1_CIPHERTEXT,
      },
    },
    servers: {
      fetch: {
        command: "uvx",
        args: ["mcp-server-fetch"],
        transport: "stdio",
        enabled: true,
        env: {
          // v2 age secret lives in a server env map
          SLACK_TOKEN: V2_CIPHERTEXT,
        },
      },
    },
    profiles: {
      default: { description: "Default profile", servers: ["fetch"] },
    },
  };

  await writeFile(join(tmpDir, "config.toml"), TOML.stringify(config as TOML.JsonMap));
  process.env.AM_CONFIG_DIR = tmpDir;
  authToken = ensureAuthToken(tmpDir);
});

afterAll(async () => {
  if (originalEnv === undefined) Reflect.deleteProperty(process.env, "AM_CONFIG_DIR");
  else process.env.AM_CONFIG_DIR = originalEnv;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("GET /api/config — encrypted-secret redaction (enc:v1 AND enc:v2:age)", () => {
  it("masks BOTH enc:v1: and enc:v2:age: envelopes; no ciphertext leaks", async () => {
    const app = await createApp();
    const res = await app.request("/api/config", {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      config: {
        settings?: { env?: Record<string, string> };
        servers?: Record<string, { env?: Record<string, string> }>;
      };
    };

    // Both values masked with the canonical placeholder.
    expect(data.config.settings?.env?.LEGACY_API_KEY).toBe("[encrypted]");
    expect(data.config.servers?.fetch?.env?.SLACK_TOKEN).toBe("[encrypted]");

    // And — belt and suspenders — no ciphertext body survives anywhere in the
    // serialized response. This is the actual regression the v1-only fork shipped.
    const raw = JSON.stringify(data);
    expect(raw).not.toContain(V1_BODY_FRAGMENT);
    expect(raw).not.toContain(V2_BODY_FRAGMENT);
    expect(raw).not.toContain("enc:v1:");
    expect(raw).not.toContain("enc:v2:age:");
  });

  // R2-SEC2 / R2-SEC3: the envelope pass alone misses PLAINTEXT secrets. The
  // endpoint now runs the two-pass redactor, so plaintext env values, named
  // secret scalars (settings.a2a.auth_token), header tables, and credential
  // userinfo in URLs must all be masked.
  it("masks plaintext secrets the envelope pass misses (env, a2a.auth_token, headers, URL userinfo)", async () => {
    const plaintextDir = await mkdtemp(join(tmpdir(), "am-web-redact-plain-"));
    await initRepo(plaintextDir);
    const PLAIN_TOKEN = "tvly-plaintextkey0123456789";
    const A2A_TOKEN = "hunter2hunter2hunter2";
    const HEADER_KEY = "rawplaintextheaderkey";
    const CRED_URL = "https://alice:p4ssw0rdInUrl@remote.example.com/mcp";
    const config = {
      settings: {
        default_profile: "default",
        env: { TAVILY_API_KEY: PLAIN_TOKEN },
        a2a: { auth_token: A2A_TOKEN },
      },
      servers: {
        remote: {
          command: CRED_URL,
          transport: "streamable-http",
          enabled: true,
          headers: { Authorization: `Bearer ${HEADER_KEY}` },
        },
      },
      profiles: { default: { description: "Default profile" } },
    };
    await writeFile(join(plaintextDir, "config.toml"), TOML.stringify(config as TOML.JsonMap));
    process.env.AM_CONFIG_DIR = plaintextDir;
    const token = ensureAuthToken(plaintextDir);
    try {
      const app = await createApp();
      const res = await app.request("/api/config", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      // None of the raw secret values may survive anywhere in the response.
      expect(raw).not.toContain(PLAIN_TOKEN);
      expect(raw).not.toContain(A2A_TOKEN);
      expect(raw).not.toContain(HEADER_KEY);
      expect(raw).not.toContain("p4ssw0rdInUrl");
      // The host is still legible (diagnostics) but the credential is gone.
      expect(raw).toContain("remote.example.com");
    } finally {
      process.env.AM_CONFIG_DIR = tmpDir;
      await rm(plaintextDir, { recursive: true, force: true });
    }
  });
});
