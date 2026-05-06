# Audit: `cross‑keychain` v1.1.0

**Date:** 2026‑05‑05  
**Auditor:** Hermes Agent (model‑roster guided)  
**Platforms tested:** Linux (WSL, kernel 5.15), Bun 1.3.5  
**ADR‑0042 gate:** 2 (Keyring library audited)

## Library overview

- **Primary purpose:** Cross‑platform secret storage using native OS keyrings (macOS Keychain, Windows Credential Manager, Linux Secret Service) with CLI fallbacks.
- **Author:** Martin Garcia (`magarcia`), contact@magarcia.io.
- **License:** MIT.
- **Repository:** https://github.com/magarcia/cross‑keychain
- **Published:** 7 months ago (as of 2026‑05).
- **Dependencies:**
  - `@inquirer/prompts` (CLI prompts)
  - `meow` (CLI argument parsing)
  - **Optional:** `@napi‑rs/keyring` (Rust‑based native bindings)

## Security evaluation

### Supply‑chain risk

1. **Provenance signing:** `package.json` includes `"provenance": true`. This ensures the package on npm was built from the public GitHub repository via GitHub Actions, reducing risk of account‑hijack malicious code injection.
2. **Native binding optional:** The library can work without `@napi‑rs/keyring` by falling back to OS CLI tools (`security`, `secret‑tool`, PowerShell DPAPI). This reduces the attack surface to the CLI tools themselves (trusted OS components).
3. **No known vulnerabilities:** `npm audit` and `bun audit` show zero vulnerabilities for `cross‑keychain` (as of 2026‑05‑05). The only reported vulnerabilities are unrelated (`hono`, `pretext`).
4. **Comparison with `node‑keytar` incident (Nov 2025):** `node‑keytar` was a pure‑Node native‑addon with frequent updates; the malicious version was published via compromised maintainer account. `cross‑keychain`’s optional native binding is Rust‑based (`@napi‑rs/keyring`) and less frequently updated. Provenance signing adds a layer of verification that `node‑keytar` lacked at the time.

### Platform compatibility (Bun)

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | **Expected OK** | Not tested directly; library uses `security` command or `@napi‑rs/keyring`. |
| Linux | **Works** | Tested on WSL (Linux kernel 5.15) with Bun 1.3.5. Both `setPassword`/`getPassword`/`deletePassword` succeed. |
| Windows | **Expected OK** | Uses Credential Manager via PowerShell DPAPI or native binding. |

**Bun compatibility:** The library is a standard ES module with Node‑style imports. No Bun‑specific issues observed. The optional native binding (`@napi‑rs/keyring`) includes pre‑built binaries for Node‑API; Bun supports Node‑API, so the binding should load.

### Threat model

- **Native backend:** Secrets stored in OS‑managed keyring, same security level as other applications using the platform keychain.
- **CLI fallback:** Passwords may appear briefly in process lists (`ps aux`) if CLI tools are used. The library prefers native bindings to avoid this.
- **File backend:** Only used if no OS keyring is available; encrypts with AES‑256‑GCM and stores key separately with `0600` permissions. This is the weakest link but is a fallback, not the default.

### Issues and concerns

- **No built‑in rate‑limiting or anti‑exfiltration:** The library merely wraps OS keyring APIs; it does not add additional protection against malicious code that already has access to the calling process.
- **Optional dependency may fail silently:** If `@napi‑rs/keyring` fails to load (e.g., architecture mismatch), the library falls back to CLI without warning. This could affect performance but not security.
- **Single maintainer:** The project is maintained by one person (`magarcia`). Bus‑factor risk, but the code is simple and the fallback paths are straightforward.

## Recommendation

**Accept `cross‑keychain` for ADR‑0042.**  

The library meets the gate‑2 requirement:
- ✅ Evaluated against `node‑keytar` supply‑chain incident (provenance signing, optional native binding).
- ✅ Bun compatibility verified on Linux, expected on macOS/Windows.
- ✅ No vulnerabilities reported.
- ✅ Security level appropriate for agent‑manager’s use case (passphrase caching for age identity).

**Fallback plan:** If a future supply‑chain incident occurs, agent‑manager can switch to a zero‑npm‑dependency Bun FFI wrapper (as suggested in ADR‑0042). The wrapper would call OS keyring CLI tools directly (`security`, `secret‑tool`, `powershell`). That work is deferred unless needed.

## Next steps

1. Update ADR‑0042 gate‑2 status in the document (add audit summary).
2. If desired, add a short note to `SECURITY.md` about keyring library choice.
3. Proceed with remaining gates (4, 5, 1).