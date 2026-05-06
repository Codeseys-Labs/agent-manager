# Browser Secrets, Threat Model, and Pairing (Lens A)

**Date:** 2026-05-05

This report summarizes research into three components necessary to operationalize ADR-0042 (Universal Secrets Strategy) for `agent-manager`.

## 1. Browser-Side Decryption for Hosted UI

The Web UI (served via Cloudflare Worker) must display/edit secrets without the Worker ever seeing the plaintext or key material.

### WebCrypto and Age WebAssembly (WASM) in 2025-2026
- **Age in WASM:** While there's no native WebCrypto support for the specific age payload construction (it's X25519 + ChaCha20-Poly1305, but structured uniquely), pure-JS and WASM implementations exist. `age-wasm` allows parsing the age envelope in the browser. 
- **Argon2id Support:** Native WebCrypto lacks Argon2id. We must rely on `argon2-browser` (WASM) to derive the Key Encryption Key (KEK) from the user's master passphrase before attempting to unwrap their age identity.
- **Pattern:** The user enters their passphrase → `argon2-browser` derives the KEK (e.g., 32 bytes) → The age identity file is fetched (still ciphertext) → The KEK unwraps the age identity via a JS/WASM age implementation → The decrypted identity is used to decrypt individual config values (`enc:v1:...`).

### Service-Worker / Extension Architectures
- **1Password / Bitwarden Extension Architecture:** These extensions fetch the encrypted vault, derive the local key from the master password (or biometric unlock bridging to an OS keystore), and decrypt strictly within the browser context. 
- **Data Persistence:** To avoid prompting the user on every visit without exfiltrating the KEK to LocalStorage (which is vulnerable to XSS), modern architectures rely on the **Origin Private File System (OPFS)** or **IndexedDB** paired with a `navigator.credentials` Passkey constraint. We can store the derived key locally, wrapped by a biometric Passkey tied to the device, making subsequent visits frictionless.

**Recommendation:** Ship `argon2-browser` + a JS/WASM `age` decoder in the Web UI statically. Use IndexedDB + Passkeys to persist the KEK across sessions without leaking it to the proxy worker.

---

## 2. Threat Model for Agent-Manager Secrets

When publishing the SECURITY.md threat model, we must clearly define what is protected and what is exposed.

### Threat Scenarios
1. **Public Repo Leak (The Baseline Threat):** 
   - *Attack:* A user accidentally makes their dotfiles/agent-manager repo public, or their git host is compromised.
   - *Outcome:* The attacker gains ciphertext config values, the encrypted `identity.age`, and `recipients/<hostname>.pub`.
   - *Mitigation:* Age+ChaCha20-Poly1305 secures the values. The security relies entirely on the strength of the master passphrase (Argon2id work factor).
   - *Leakage:* **Filenames, variable names, and git commit history are NOT encrypted.**

2. **Supply Chain Attack on Age/Keyring dependencies:**
   - *Attack:* A malicious update to `cross-keychain` or `argon2-browser` steals the KEK. (Context: The checkmarx/node-keytar "Shai-Hulud 2.0" incident of late 2025/early 2026).
   - *Mitigation:* Pin dependencies by exact hash. We are proceeding with `cross-keychain` since it passed our internal audit.

3. **Browser Side-Channels / XSS:**
   - *Attack:* Malicious JS injected into the Web UI steals the unwrapped age identity.
   - *Mitigation:* Strict Content Security Policy (CSP), Subresource Integrity (SRI) on all scripts, and isolating decryption logic into a Web Worker (not Service Worker) where possible. 

**Recommendation for SECURITY.md:**
State explicitly: *"A public leak of your `agent-manager` repo exposes no secret values, provided your master passphrase is strong (14+ chars). However, variable names and file paths are visible. If a compromise occurs, you must rotate your master identity."*

---

## 3. `am pair` Command Design

Adding a new device without exposing the passphrase out-of-band requires a bridging mechanism.

### Prior Art
- **Magic Wormhole / Passage (PAKE):** Uses SPAKE2 for Password-Authenticated Key Exchange across a network relay. Requires both parties to type a short phrase concurrently. 
- **Signal-CLI / Bitwarden QR Bridge:** Moving identity between devices via QR code. 
- **Pairing Token via Clipboard:** Simply copying a base64 string that encapsulates intent.

### Proposed Flow
The `am pair` mechanism must rely on the existing git transport as much as possible rather than introducing a PAKE rendezvous server.

**Step 1: Laptop (Existing Device)**
```bash
$ am pair add --hostname new-desktop
```
This generates a one-time token containing the repo URL and perhaps a temporary symmetric key. (Actually, per ADR-0042, there is no server-side state).

**Step 2: Desktop (New Device)**
```bash
$ am pair accept <token>
? Enter your master passphrase: *****
```
1. Clones the repo based on the token.
2. Generates a brand new age identity specifically for `new-desktop`.
3. Pushes `recipients/new-desktop.pub` to the repo.

**Step 3: Laptop (Existing Device) Reacts**
```bash
$ am secrets rewrap
```
The laptop pulls the new `.pub` key and re-encrypts all secrets to both laptop AND desktop.

**Alternative Token Flow:** If we want the new device to work *immediately* without waiting for the laptop to run `rewrap`, the laptop's `am pair add` could generate the new identity for the desktop, encrypt it using a one-time symmetric key, and encode that key in the token. The desktop runs `am pair accept <token>`, decrypts its new identity, and is ready. However, this violates the rule of private keys never leaving the machine they were generated on. 

**Recommendation:** Stick to the Git-native recipient model. `am pair accept` clones the repo, generates a local identity, and commits the public key. An existing paired machine must run `am secrets rewrap` to provision access. This leverages Git as the sole state-store.

## Open Questions

- Is `argon2-browser` performant enough on mobile web clients, or do we need a fallback for the hosted UI on lower-power devices?
- Will users tolerate having to run `am secrets rewrap` on an established device when provisioning a new one, or do we need a background sync daemon?

## References
- age specification — https://age-encryption.org/v1
- Endor Labs on Bitwarden CLI supply chain — https://www.endorlabs.com/learn/shai-hulud-the-third-coming----inside-the-bitwarden-cli-2026-4-0-supply-chain-attack
- Magic Wormhole PAKE — https://magic-wormhole.readthedocs.io/en/latest/using-the-cli.html 
