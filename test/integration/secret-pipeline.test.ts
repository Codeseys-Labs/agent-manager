import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../src/core/schema";
import {
  isSecretKeyName,
  pickEnvVarName,
  scanConfigEnvVars,
  scanServerEnvVars,
  scanServerForSecrets,
  substituteSecret,
} from "../../src/core/secret-detection";
import {
  decryptValue,
  encryptValue,
  generateKey,
  importKey,
  interpolateEnvAsync,
  isEncrypted,
  saveKey,
} from "../../src/core/secrets";
import { type TestDir, createTestDir } from "../helpers/tmp";

// ── Helpers ─────────────────────────────────────────────────────

/** Create a real CryptoKey pair for pipeline tests. */
async function makeEncryptionKey() {
  const base64 = await generateKey();
  const key = await importKey(base64);
  return { base64, key };
}

// ── Integration: Secret Detection → Encryption Pipeline ─────────

describe("secret pipeline integration", () => {
  let dir: TestDir;
  let keyDir: TestDir;
  const origKeyPath = process.env.AM_KEY_PATH;

  const origAgeIdentityDir = process.env.AM_AGE_IDENTITY_DIR;
  const origAgePassphrase = process.env.AM_AGE_PASSPHRASE;

  beforeEach(async () => {
    dir = await createTestDir("am-secret-pipeline-");
    keyDir = await createTestDir("am-secret-pipeline-keydir-");
    // Redirect master-key storage so tests never touch ~/.
    process.env.AM_KEY_PATH = join(keyDir.path, "key");
    // RC7 (xplat): isolate the age backend from process/OS-keychain state. bun
    // runs all test files in one process, and on Windows the age backend caches
    // a passphrase via the OS Credential Manager — a prior secrets/pair test can
    // leave state that lets default-backend resolution behave differently here,
    // breaking the "v2/unknown FAIL LOUD" assertion. Pin a fresh identity dir and
    // clear the passphrase so the fail-loud path is exercised hermetically.
    process.env.AM_AGE_IDENTITY_DIR = join(keyDir.path, "age-identities");
    Reflect.deleteProperty(process.env, "AM_AGE_PASSPHRASE");
  });

  afterEach(async () => {
    if (dir) await dir.cleanup();
    if (keyDir) await keyDir.cleanup();
    if (origKeyPath === undefined) Reflect.deleteProperty(process.env, "AM_KEY_PATH");
    else process.env.AM_KEY_PATH = origKeyPath;
    if (origAgeIdentityDir === undefined)
      Reflect.deleteProperty(process.env, "AM_AGE_IDENTITY_DIR");
    else process.env.AM_AGE_IDENTITY_DIR = origAgeIdentityDir;
    if (origAgePassphrase === undefined) Reflect.deleteProperty(process.env, "AM_AGE_PASSPHRASE");
    else process.env.AM_AGE_PASSPHRASE = origAgePassphrase;
  });

  // ── Test 1: Import with auto-encrypt ──────────────────────────

  describe("import with auto-encrypt", () => {
    test("detects secrets, substitutes with ${VAR}, and encrypts to settings.env", async () => {
      const { base64, key } = await makeEncryptionKey();

      // Simulate a server config with raw API keys (as would come from import)
      const serverEnv: Record<string, string> = {
        OPENAI_API_KEY: "sk-test1234567890abcdefghijklmnop",
        TAVILY_API_KEY: "tvly-abcdefghijklmnopqrstuvwxyz",
        NODE_ENV: "production", // not a secret
      };

      const server = {
        command: "npx",
        args: ["mcp-server"],
        env: { ...serverEnv },
      };

      // Step 1: Scan for secrets
      const scanResult = scanServerEnvVars("my-server", server);
      expect(scanResult.secrets.length).toBe(2);

      // Step 2: For each detected secret, substitute with ${VAR} and encrypt
      const settingsEnv: Record<string, string> = {};

      for (const secret of scanResult.secrets) {
        const envVarName = secret.suggestedEnvVar;

        // Encrypt the raw value
        const encrypted = await encryptValue(secret.value, key);
        settingsEnv[envVarName] = encrypted;

        // Replace server env value with ${VAR} reference
        substituteSecret(server, secret, envVarName);
      }

      // Step 3: Verify server env values are now ${VAR} references
      expect(server.env.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
      expect(server.env.TAVILY_API_KEY).toBe("${TAVILY_API_KEY}");
      expect(server.env.NODE_ENV).toBe("production"); // untouched

      // Step 4: Verify settings.env contains encrypted values
      expect(isEncrypted(settingsEnv.OPENAI_API_KEY)).toBe(true);
      expect(isEncrypted(settingsEnv.TAVILY_API_KEY)).toBe(true);

      // Step 5: Verify we can decrypt back to originals
      expect(await decryptValue(settingsEnv.OPENAI_API_KEY, key)).toBe(
        "sk-test1234567890abcdefghijklmnop",
      );
      expect(await decryptValue(settingsEnv.TAVILY_API_KEY, key)).toBe(
        "tvly-abcdefghijklmnopqrstuvwxyz",
      );
    });

    test("auto-generates encryption key and persists to OS data-dir path", async () => {
      // Simulate key generation + persistence — saveKey now writes to AM_KEY_PATH
      // (set in beforeEach) rather than inside the git-tracked config dir.
      const base64 = await generateKey();
      await saveKey(dir.path, base64);

      // Verify key file exists at the configured path and is valid
      const keyPath = process.env.AM_KEY_PATH!;
      const keyContents = await readFile(keyPath, "utf-8");
      expect(keyContents.trim()).toBe(base64);

      // Verify the saved key is usable
      const key = await importKey(keyContents.trim());
      const encrypted = await encryptValue("test-secret", key);
      expect(await decryptValue(encrypted, key)).toBe("test-secret");
    });
  });

  // ── Test 2: Add server with secret detection ──────────────────

  describe("add server with secret detection", () => {
    test("scanServerEnvVars detects OPENAI_API_KEY", () => {
      const result = scanServerEnvVars("test-server", {
        command: "npx",
        env: { OPENAI_API_KEY: "sk-test123456789012345" },
      });

      expect(result.secrets).toHaveLength(1);
      expect(result.secrets[0].key).toBe("OPENAI_API_KEY");
      expect(result.secrets[0].value).toBe("sk-test123456789012345");
      expect(result.secrets[0].source).toBe("key-name");
    });

    test("detects multiple provider keys in one server", () => {
      const result = scanServerEnvVars("multi-key-server", {
        command: "npx",
        env: {
          ANTHROPIC_API_KEY: "ant-key-abc123",
          GITHUB_TOKEN: "ghp_xxxxxxxxxxxxxxxxxxxx",
          STRIPE_SECRET_KEY: "sk_test_xxxxxxxxxxxxxxxx",
          DEBUG: "true",
          PORT: "3000",
        },
      });

      expect(result.secrets).toHaveLength(3);
      const detectedKeys = result.secrets.map((s) => s.key);
      expect(detectedKeys).toContain("ANTHROPIC_API_KEY");
      expect(detectedKeys).toContain("GITHUB_TOKEN");
      expect(detectedKeys).toContain("STRIPE_SECRET_KEY");
    });

    test("scanConfigEnvVars scans all servers", () => {
      const results = scanConfigEnvVars({
        server1: {
          command: "npx",
          env: { OPENAI_API_KEY: "sk-xxx" },
        },
        server2: {
          command: "npx",
          env: { TAVILY_API_KEY: "tvly-xxx" },
        },
        server3: {
          command: "npx",
          env: { PORT: "3000" }, // no secrets
        },
      });

      // server3 has no secrets, so only 2 results
      expect(results).toHaveLength(2);
      expect(results[0].serverName).toBe("server1");
      expect(results[1].serverName).toBe("server2");
    });
  });

  // ── Test 3: Already-encrypted values are skipped ──────────────

  describe("already-encrypted values are skipped", () => {
    test("enc:v1: values are not flagged as secrets", () => {
      const result = scanServerEnvVars("encrypted-server", {
        command: "npx",
        env: {
          API_KEY: "enc:v1:abc123base64nonce:ciphertext123base64",
        },
      });

      expect(result.secrets).toHaveLength(0);
    });

    test("enc:v1: values are skipped even with secret key names", () => {
      const result = scanServerEnvVars("encrypted-server", {
        command: "npx",
        env: {
          OPENAI_API_KEY: "enc:v1:nonce:cipher",
          ANTHROPIC_API_KEY: "enc:v1:nonce2:cipher2",
          GITHUB_TOKEN: "enc:v1:nonce3:cipher3",
        },
      });

      expect(result.secrets).toHaveLength(0);
    });
  });

  // ── Test 4: Already-templated values are skipped ──────────────

  describe("already-templated values are skipped", () => {
    test("${VAR} references are not flagged as secrets", () => {
      const result = scanServerEnvVars("templated-server", {
        command: "npx",
        env: {
          API_KEY: "${API_KEY}",
        },
      });

      expect(result.secrets).toHaveLength(0);
    });

    test("${VAR} references are skipped for known secret key names", () => {
      const result = scanServerEnvVars("templated-server", {
        command: "npx",
        env: {
          OPENAI_API_KEY: "${OPENAI_API_KEY}",
          TAVILY_API_KEY: "${TAVILY_API_KEY}",
          GITHUB_TOKEN: "${MY_GITHUB_TOKEN}",
        },
      });

      expect(result.secrets).toHaveLength(0);
    });

    test("mixed: only raw values are flagged, not templated or encrypted", () => {
      const result = scanServerEnvVars("mixed-server", {
        command: "npx",
        env: {
          OPENAI_API_KEY: "sk-raw-secret-value",
          TAVILY_API_KEY: "${TAVILY_API_KEY}",
          GITHUB_TOKEN: "enc:v1:n:c",
          PORT: "3000",
        },
      });

      expect(result.secrets).toHaveLength(1);
      expect(result.secrets[0].key).toBe("OPENAI_API_KEY");
      expect(result.secrets[0].value).toBe("sk-raw-secret-value");
    });
  });

  // ── Test 5: Apply decrypts correctly (full round-trip) ────────

  describe("apply decrypts correctly", () => {
    test("interpolateEnvAsync resolves ${VAR} from settings.env and decrypts", async () => {
      const { key } = await makeEncryptionKey();

      // Encrypt a real secret
      const originalSecret = "sk-live-realkey-abcdefg12345";
      const encrypted = await encryptValue(originalSecret, key);

      // Build a config that mirrors the post-import state:
      // - server env uses ${VAR} references
      // - settings.env has encrypted values
      const config: Config = {
        settings: {
          env: {
            OPENAI_API_KEY: encrypted,
          },
        },
        servers: {
          "my-server": {
            command: "npx",
            args: ["mcp-server"],
            transport: "stdio",
            enabled: true,
            env: {
              OPENAI_API_KEY: "${OPENAI_API_KEY}",
            },
          },
        },
      };

      // Run the async interpolation + decryption pipeline
      const { config: resolved, warnings } = await interpolateEnvAsync(config, {
        encryptionKey: key,
        extraEnv: {
          // settings.env values resolved first (simulating the apply pipeline)
          OPENAI_API_KEY: await decryptValue(encrypted, key),
        },
      });

      // The server env should have the decrypted original value
      expect(resolved.servers?.["my-server"]?.env?.OPENAI_API_KEY).toBe(originalSecret);
      expect(warnings).toHaveLength(0);
    });

    test("interpolateEnvAsync decrypts enc:v1: values nested in config", async () => {
      const { key } = await makeEncryptionKey();

      const secret1 = "my-api-key-123";
      const secret2 = "another-secret-456";
      const enc1 = await encryptValue(secret1, key);
      const enc2 = await encryptValue(secret2, key);

      const config: Config = {
        servers: {
          s1: {
            command: "server1",
            transport: "stdio",
            enabled: true,
            env: { KEY: enc1 },
          },
          s2: {
            command: "server2",
            transport: "stdio",
            enabled: true,
            env: { TOKEN: enc2 },
          },
        },
      };

      const { config: resolved } = await interpolateEnvAsync(config, {
        encryptionKey: key,
      });

      expect(resolved.servers?.s1?.env?.KEY).toBe(secret1);
      expect(resolved.servers?.s2?.env?.TOKEN).toBe(secret2);
    });

    test("without any key, enc:v1: passes through (ADR-0012) but enc:v2:/unknown FAIL LOUD (P0-3)", async () => {
      // The P0-3 leak was v2/unknown envelopes flowing to native configs as
      // ciphertext. For a LEGACY v1 envelope with NO key configured at all, the
      // documented ADR-0012 behavior is graceful passthrough (the user simply
      // hasn't set up secrets; the value is AES ciphertext, not plaintext). The
      // fail-loud guarantee applies to v2/unknown — those must never leak.
      const v1Config: Config = {
        servers: {
          s: {
            command: "server",
            transport: "stdio",
            enabled: true,
            env: { KEY: "enc:v1:fake:data" },
          },
        },
      };
      // v1 + no key → graceful passthrough (unchanged), not a throw.
      const { config: out } = await interpolateEnvAsync(v1Config);
      expect(out.servers?.s?.env?.KEY).toBe("enc:v1:fake:data");

      // v2 (age) with no age backend → FAILS LOUD (the real P0-3 leak class).
      const v2Config: Config = {
        servers: {
          s: {
            command: "server",
            transport: "stdio",
            enabled: true,
            env: { KEY: "enc:v2:age:ZmFrZQ" },
          },
        },
      };
      await expect(interpolateEnvAsync(v2Config)).rejects.toThrow(/age|backend|unlock/i);

      // Unknown enc: version → FAILS LOUD (never echoed verbatim).
      const unknownConfig: Config = {
        servers: {
          s: {
            command: "server",
            transport: "stdio",
            enabled: true,
            env: { KEY: "enc:v99:whatever" },
          },
        },
      };
      await expect(interpolateEnvAsync(unknownConfig)).rejects.toThrow(
        /unrecogni[sz]ed|unknown|envelope/i,
      );
    });
  });

  // ── Test 6: End-to-end pipeline: detect → substitute → encrypt → decrypt ──

  describe("full end-to-end pipeline", () => {
    test("detect → substitute → encrypt → config → interpolate → decrypt", async () => {
      const { base64, key } = await makeEncryptionKey();

      // 1. Start with raw server config (simulating imported config)
      const rawServer = {
        command: "bunx",
        args: ["tavily-mcp@latest"],
        env: {
          TAVILY_API_KEY: "tvly-realkey-abcdefghijklmnop",
          NODE_ENV: "production",
        },
      };

      // 2. Detect secrets
      const scan = scanServerEnvVars("tavily", rawServer);
      expect(scan.secrets).toHaveLength(1);

      // 3. For each detected secret: encrypt + substitute
      const settingsEnv: Record<string, string> = {};
      for (const secret of scan.secrets) {
        settingsEnv[secret.suggestedEnvVar] = await encryptValue(secret.value, key);
        substituteSecret(rawServer, secret, secret.suggestedEnvVar);
      }

      // 4. Build the final config (as it would be stored in TOML)
      const storedConfig: Config = {
        settings: { env: settingsEnv },
        servers: {
          tavily: {
            command: rawServer.command,
            args: rawServer.args,
            transport: "stdio",
            enabled: true,
            env: rawServer.env,
          },
        },
      };

      // Verify stored config structure
      expect(storedConfig.servers?.tavily?.env?.TAVILY_API_KEY).toBe("${TAVILY_API_KEY}");
      expect(isEncrypted(storedConfig.settings?.env?.TAVILY_API_KEY ?? "")).toBe(true);

      // 5. At apply time: decrypt settings.env, then interpolate
      const decryptedSettingsEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(storedConfig.settings?.env ?? {})) {
        decryptedSettingsEnv[k] = await decryptValue(v, key);
      }

      const { config: applied } = await interpolateEnvAsync(storedConfig, {
        encryptionKey: key,
        extraEnv: decryptedSettingsEnv,
      });

      // 6. Verify the final resolved value matches the original
      expect(applied.servers?.tavily?.env?.TAVILY_API_KEY).toBe("tvly-realkey-abcdefghijklmnop");
      // Non-secret env is untouched
      expect(applied.servers?.tavily?.env?.NODE_ENV).toBe("production");
    });
  });

  // ── Edge cases ────────────────────────────────────────────────

  describe("edge cases", () => {
    test("empty env object produces no secrets", () => {
      const result = scanServerEnvVars("empty", {
        command: "npx",
        env: {},
      });
      expect(result.secrets).toHaveLength(0);
    });

    test("server without env produces no secrets", () => {
      const result = scanServerEnvVars("no-env", {
        command: "npx",
      });
      expect(result.secrets).toHaveLength(0);
    });

    test("empty string values are skipped", () => {
      const result = scanServerEnvVars("empty-val", {
        command: "npx",
        env: { OPENAI_API_KEY: "" },
      });
      expect(result.secrets).toHaveLength(0);
    });

    test("boolean-like values are skipped", () => {
      const result = scanServerEnvVars("bool-val", {
        command: "npx",
        env: {
          AUTH: "true",
          SECRET: "false",
        },
      });
      expect(result.secrets).toHaveLength(0);
    });

    test("substituteSecret works for env location", () => {
      const server = {
        command: "npx",
        env: { OPENAI_API_KEY: "sk-raw-secret" },
      };

      substituteSecret(
        server,
        {
          location: "env" as const,
          key: "OPENAI_API_KEY",
          value: "sk-raw-secret",
          source: "key-name" as const,
          suggestedEnvVar: "OPENAI_API_KEY",
        },
        "OPENAI_API_KEY",
      );

      expect(server.env.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
    });
  });

  // ── URL-embedded credentials: same obfuscate→encrypt→decrypt lifecycle ──
  describe("URL-embedded credential round-trip", () => {
    test("detects a ?tavilyApiKey= in command, substitutes ${VAR}, encrypts, and decrypts at apply", async () => {
      const { key } = await makeEncryptionKey();
      const rawKey = "tvly-FAKEFIXTURE1234567890";
      const server = {
        command: `https://mcp.tavily.com/mcp/?tavilyApiKey=${rawKey}`,
      };

      // Step 1: the UNIFIED scanner surfaces the URL credential (Tier 1.5).
      const scan = await scanServerForSecrets("tavily", server);
      const urlSecret = scan.secrets.find((s) => s.source === "url-credential");
      expect(urlSecret).toBeDefined();
      expect(urlSecret?.location).toBe("command");
      expect(urlSecret?.key).toBe("tavilyApiKey");
      expect(urlSecret?.value).toBe(rawKey); // raw value, for encryption
      expect(urlSecret?.suggestedEnvVar).toBe("TAVILYAPIKEY"); // bare name

      // Step 2: obfuscate the command + encrypt the value into settings.env.
      if (!urlSecret) throw new Error("url secret not detected");
      const settingsEnv: Record<string, string> = {};
      const envVarName = pickEnvVarName(settingsEnv, urlSecret.suggestedEnvVar, "tavily");
      substituteSecret(server, urlSecret, envVarName);
      settingsEnv[envVarName] = await encryptValue(urlSecret.value, key);

      // Command now references ${VAR}; plaintext key is gone.
      expect(server.command).toBe("https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILYAPIKEY}");
      expect(server.command).not.toContain(rawKey);
      expect(isEncrypted(settingsEnv.TAVILYAPIKEY)).toBe(true);

      // Step 3: at APPLY, interpolateEnvAsync must decrypt settings.env and
      // resolve the ${VAR} INSIDE the command URL — the round-trip that was
      // broken before (extraEnv was never seeded from settings.env).
      const config: Config = {
        servers: { tavily: { ...server, transport: "stdio", enabled: true } },
        settings: { env: settingsEnv },
      };
      const { config: resolved } = await interpolateEnvAsync(config, { encryptionKey: key });
      expect(resolved.servers?.tavily.command).toBe(
        `https://mcp.tavily.com/mcp/?tavilyApiKey=${rawKey}`,
      );
    });

    test("collision-safe env var naming when two servers derive the same name", () => {
      // Two servers both with ?api_key= would both derive API_KEY; the second
      // must NOT clobber the first's encrypted value.
      const existing: Record<string, string> = { API_KEY: "enc:v1:firstserver" };
      const picked = pickEnvVarName(existing, "API_KEY", "second-server");
      expect(picked).toBe("SECOND_SERVER_API_KEY");
      expect(picked).not.toBe("API_KEY");
    });

    test("a properly-obfuscated ${VAR} URL is NOT re-flagged as a secret", async () => {
      const server = {
        command: "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILYAPIKEY}",
      };
      const scan = await scanServerForSecrets("tavily", server);
      // The ${VAR} placeholder is exempt — no url-credential finding.
      expect(scan.secrets.filter((s) => s.source === "url-credential")).toHaveLength(0);
    });

    // Review finding A: a credential in adapters.<x>.url must be SUBSTITUTED in
    // the adapter url (not the command), or the plaintext survives in config.toml.
    test("adapter.url credential is detected AND rewritten in the adapter url (finding A)", async () => {
      const raw = "tvly-ADAPTERURLLEAK1234567890";
      const server = {
        command: "npx",
        args: ["some-mcp"],
        adapters: { cursor: { url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${raw}` } },
      };
      const secrets = await scanServerForSecrets("tav", server).then((r) => r.secrets);
      const hit = secrets.find((s) => s.source === "url-credential");
      expect(hit?.urlSource).toBe("adapter");
      expect(hit?.adapterName).toBe("cursor");
      if (!hit) throw new Error("adapter url credential not detected");
      const removed = substituteSecret(server, hit, hit.suggestedEnvVar);
      expect(removed).toBe(true);
      expect(server.adapters.cursor.url as string).toBe(
        "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILYAPIKEY}",
      );
      expect(JSON.stringify(server)).not.toContain(raw); // no plaintext anywhere
    });

    // Review finding A+F: substituteSecret returns false when it CANNOT remove
    // the plaintext, so callers refuse instead of encrypting a decoy copy.
    test("substituteSecret returns false when it cannot rewrite the location (finding A+F)", () => {
      // url-credential pointing at an adapter that no longer exists.
      const server = { command: "npx", adapters: {} };
      const phantom = {
        location: "command" as const,
        key: "tavilyApiKey",
        value: "tvly-PHANTOM1234567890",
        source: "url-credential" as const,
        urlSource: "adapter" as const,
        adapterName: "cursor",
        suggestedEnvVar: "TAVILYAPIKEY",
      };
      expect(substituteSecret(server, phantom, "TAVILYAPIKEY")).toBe(false);
    });

    // Review finding E: missing key at apply must FAIL LOUD, never splice an
    // enc:v1: envelope into a command URL as if it were the plaintext key.
    test("apply with a missing key fails loud instead of leaking ciphertext into the URL (finding E)", async () => {
      const { key } = await makeEncryptionKey();
      const env = await encryptValue("tvly-REALSECRET1234567890", key);
      const config: Config = {
        servers: {
          tavily: {
            command: "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILYAPIKEY}",
            transport: "streamable-http",
            enabled: true,
          },
        },
        settings: { env: { TAVILYAPIKEY: env } },
      };
      // No encryptionKey supplied → the catalog decode must throw, not pass
      // the enc:v1: ciphertext through into the interpolated command.
      await expect(interpolateEnvAsync(config, { encryptionKey: undefined })).rejects.toThrow();
    });
  });
});
