import { beforeAll, describe, expect, test } from "bun:test";
import { AesGcmLegacyBackend, generateKey, importKey } from "../../src/core/secrets";
import {
  type SecretsBackend,
  type SecretsBackendFactory,
  getBackend,
  listBackends,
  registerBackend,
} from "../../src/core/secrets-backend";

// Importing `../../src/core/secrets` above must have side-effect-registered
// the `aes-gcm-legacy` backend. The tests below assume that import order.

describe("secrets-backend registry", () => {
  test("registerBackend + getBackend + listBackends round-trip", () => {
    const fake: SecretsBackendFactory = {
      // Cast to a registered name — factory shape is what matters for
      // the registry contract, not the specific name.
      name: "vault",
      async load() {
        return {
          name: "vault",
          version: 0,
          async encrypt(pt) {
            return `enc:v1:${pt}`;
          },
          async decrypt(env) {
            return env.replace(/^enc:v1:/, "");
          },
        } satisfies SecretsBackend;
      },
    };
    registerBackend(fake);

    expect(getBackend("vault")).toBe(fake);
    expect(listBackends()).toContain("vault");
  });

  test("aes-gcm-legacy backend is auto-registered via core/secrets import", () => {
    const factory = getBackend("aes-gcm-legacy");
    expect(factory).toBeDefined();
    expect(factory?.name).toBe("aes-gcm-legacy");
  });

  test("getBackend returns undefined for an unknown name", () => {
    expect(getBackend("nonexistent-backend-xyz")).toBeUndefined();
  });
});

describe("AesGcmLegacyBackend contract", () => {
  let backend: AesGcmLegacyBackend;

  beforeAll(async () => {
    const base64 = await generateKey();
    const key = await importKey(base64);
    backend = new AesGcmLegacyBackend(key);
  });

  test("name and version are exposed as readonly const literals", () => {
    expect(backend.name).toBe("aes-gcm-legacy");
    expect(backend.version).toBe(1);
  });

  test("encrypt + decrypt round-trip a plaintext string", async () => {
    const plaintext = "hunter2-super-secret!";
    const envelope = await backend.encrypt(plaintext);

    expect(envelope).toStartWith("enc:v1:");
    expect(envelope).not.toBe(plaintext);

    const recovered = await backend.decrypt(envelope);
    expect(recovered).toBe(plaintext);
  });

  test("factory loads a backend instance from { key } config", async () => {
    const factory = getBackend("aes-gcm-legacy");
    expect(factory).toBeDefined();

    const base64 = await generateKey();
    const key = await importKey(base64);
    const loaded = await factory!.load({ key });

    expect(loaded.name).toBe("aes-gcm-legacy");
    const env = await loaded.encrypt("round-trip-via-factory");
    expect(await loaded.decrypt(env)).toBe("round-trip-via-factory");
  });

  test("optional recipient-management methods are undefined (single-key)", () => {
    // AES-GCM is a single-recipient backend; the optional interface
    // members MUST be absent so callers can branch on `if (b.addRecipient)`.
    expect(backend.rewrap).toBeUndefined();
    expect(backend.addRecipient).toBeUndefined();
    expect(backend.removeRecipient).toBeUndefined();
    expect(backend.listRecipients).toBeUndefined();
  });

  test("encrypt throws a descriptive error when no key is installed", async () => {
    const empty = new AesGcmLegacyBackend();
    expect(empty.hasKey()).toBe(false);
    await expect(empty.encrypt("x")).rejects.toThrow(/no key loaded/);
  });
});
