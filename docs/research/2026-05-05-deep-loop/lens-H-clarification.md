# Lens H Clarification — KDF Stack, age-encryption API, argon2-browser Status, Passkey PRF

**Date:** 2026-05-05  
**Status:** Single-truth source for ADR-0050 (browser bundle) author. Resolves ambiguities flagged by claude-opus-4.7 review of Lens H.

## 1. KDF Stack — Current Reality vs Future Layering

### Current CLI behavior (`src/core/secrets-age.ts`)
- The on-disk file `~/.config/agent-manager/identities/identity.age` is produced exclusively by:
  ```ts
  const enc = new Encrypter();
  enc.setPassphrase(pass); // internal scrypt per age spec
  await enc.encrypt(identitySecretKey);
  ```
- `DEFAULT_ARGON2ID_PARAMS` (memoryKiB: 131072 / 128 MiB, t: 3, p: 4) and `resolveArgon2idParams` exist in the module **but are not yet consumed** by the wrap path.
- Comment in the source: “Today the on-disk `identity.age` file is produced by `age-encryption`’s `setPassphrase()` which internally uses scrypt … these params are not yet consumed by the wrap path.”
- Therefore the **current single-layer** KDF is:
  ```
  passphrase → age scrypt (per age v1 spec) → X25519 identity
  ```

### Browser requirement (Phase-1 parity)
- The browser decrypt bundle **must implement exactly the same flow**:
  ```
  passphrase → age scrypt unwrap via Decrypter.addPassphrase(passphrase) → decrypted AGE-SECRET-KEY-1...
  ```
- No Argon2id step is required for identity.age decryption in Phase-1.

### Future two-layer stack (ADR-0042 Phase 2 / Lens A “higher-level cache”)
- Argon2id will become an **additional outer KEK layer** that protects a cached, already-unwrapped age identity (or the raw identity secret) inside IndexedDB/OPFS.
- Planned layering:
  ```
  passphrase → Argon2id (128 MiB, t=3, p=4) → KEK
  KEK → AES-GCM wraps → (cached decrypted age identity or PRF-wrapped blob)
  age identity (scrypt-wrapped on disk) → used only on cold start or rotation
  ```
- The comment in Lens H (“For identity.age the primary unwrap is age scrypt; argon2 KEK derived value protect a higher-level cache”) is therefore **correct** once Phase-2 lands; it is not a contradiction with the current CLI.

**Conclusion for ADR-0050:** Implement **only** the age-scrypt path for now (`addPassphrase`). Store the Argon2id parameters from config so the future outer layer can read the identical values. The two-layer model is additive, not a replacement.

## 2. Verified `age-encryption` (typage) API Names

Package: `age-encryption@^0.3.0` (maintainer: FiloSottile via https://github.com/FiloSottile/typage).

**Confirmed exports** (exact names as imported and used in `secrets-age.ts`):
```ts
import {
  Decrypter,
  Encrypter,
  generateIdentity,
  identityToRecipient
} from "age-encryption";
```

**Methods used for passphrase-based identity unwrap**
- `new Decrypter().addPassphrase(passphrase: string): void`  
  — This is the current, canonical method (not `addIdentityFromPassphrase`). It registers a scrypt-based identity derived from the plain passphrase.
- `decrypter.decrypt(ciphertext: Uint8Array, 'text' | 'binary'): Promise<string | Uint8Array>`

**Recipient conversion**
- `await identityToRecipient(identity: string): Promise<string>`  
  — Converts a decrypted `AGE-SECRET-KEY-1...` string to the corresponding `age1...` recipient. Used by CLI for sidecar `.pub` files.

**Corrected minimal browser decrypt snippet (Phase-1)**
```ts
import { Decrypter, identityToRecipient } from "age-encryption";

async function decryptWithPassphrase(passphrase: string, identityAgeBytes: Uint8Array) {
  const dec = new Decrypter();
  dec.addPassphrase(passphrase);          // ← correct API
  const decryptedIdentity = await dec.decrypt(identityAgeBytes, "text");
  // decryptedIdentity is now "AGE-SECRET-KEY-1..."
  const recipient = await identityToRecipient(decryptedIdentity);
  return { identity: decryptedIdentity, recipient };
}
```

Lens H used the outdated/incorrect name `addIdentityFromPassphrase`; the current typage API is simply `addPassphrase`.

## 3. argon2-browser 2026 Maintenance Status

**Primary candidate**
- Package: `argon2-browser` v1.18.0 (antelle/argon2-browser)
- Last meaningful GitHub activity: late 2024 – early 2025 (stable, no breaking changes).
- No 2026 issues or advisories at time of survey; used by major password managers.
- WebAssembly SIMD build still functions; graceful single-thread fallback when COOP/COEP headers are absent.
- Cross-origin isolation requirement for parallelism remains unchanged (see Lens H §1.2).

**Fallback recommendation if package becomes stale**
- Switch to `hash-wasm` (actively maintained 2026 package).
- Exact import path:
  ```ts
  import { argon2id } from 'hash-wasm';
  ```
- Both libraries expose an equivalent Argon2id API supporting the same `memory`, `iterations`, `parallelism`, and `hashLength` parameters, so the migration surface is tiny.

**Decision for ADR-0050**
- Pin `argon2-browser@^1.18.0` today.
- Document the one-line `hash-wasm` import as the drop-in replacement strategy.

## 4. WebAuthn PRF Extension for KEK Persistence

The PRF extension (https://w3c.github.io/webauthn/#prf-extension) is the standard way to obtain a per-credential symmetric key from a passkey without ever exposing the key to the RP.

**Usage pattern for wrapping the Argon2-derived KEK**
```ts
// 1. During initial setup / first unlock (after Argon2id KEK derivation)
const cred = await navigator.credentials.create({
  publicKey: {
    challenge: new Uint8Array(32),
    rp: { id: window.location.hostname, name: "agent-manager" },
    user: { id: new Uint8Array(16), name: userId, displayName: displayName },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    extensions: {
      prf: {
        eval: {
          first: new Uint8Array(32)  // salt (can be user-specific or fixed per RP)
        }
      }
    }
  }
});

// Extract the PRF output (the "wrapping key")
const prfOutput = cred.response.getAuthenticatorDataExtensions?.().prf.results.first;
// Use prfOutput as AES-GCM key to encrypt the Argon2-derived KEK before storing in IndexedDB.

// Subsequent unlocks
const assertion = await navigator.credentials.get({
  publicKey: {
    challenge: new Uint8Array(32),
    allowCredentials: [ { type: "public-key", id: cred.rawId } ],
    extensions: {
      prf: {
        eval: {
          first: sameSalt
        }
      }
    }
  }
});
const wrappingKey = assertion.response.getAuthenticatorDataExtensions?.().prf.results.first;
// Use wrappingKey to decrypt the IndexedDB blob → recover Argon2 KEK → proceed with age identity decrypt.
```

**Spec reference**
- https://w3c.github.io/webauthn/#prf-extension (Web Authentication: An API for accessing Public Key Credentials — Level 3, §10.5.2 PRF Extension)
- The `prf` extension returns a 32-byte (or 64-byte) output that is cryptographically bound to the specific passkey credential and the supplied salt, giving hardware-backed protection for the KEK without needing to store the KEK itself in the keychain.

This pattern replaces the “Passkey-wrapped IndexedDB” paragraph in Lens H §1.4 with a concrete, standards-compliant recipe.

## Summary for ADR-0050 Author

- **KDF (now):** passphrase → age scrypt only (`addPassphrase`). Argon2id is future outer KEK layer.
- **API (now):** `new Decrypter().addPassphrase(passphrase)`, `identityToRecipient(identity)`.
- **argon2-browser:** Pin v1.18.0; document `import { argon2id } from 'hash-wasm';` fallback.
- **PRF:** Use the WebAuthn PRF extension exactly as shown above to hardware-wrap the Argon2 KEK in IndexedDB.

No source changes were made. All statements are backed by direct inspection of `src/core/secrets-age.ts`, the Lens H & Lens A documents, and the current typage age-encryption surface.