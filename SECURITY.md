# Security Policy

## Reporting a Vulnerability

Please report any security vulnerabilities to security@agent-manager.dev. We also accept reports via GitHub Private Vulnerability Reporting on this repository.

We aim to triage reports within 48 hours and typically operate under a 90-day disclosure window before making vulnerability details public. Please do not open public issues for security vulnerabilities.

## Supported Versions

We provide security updates for the current major version (1.x).
Security fixes will be backported to minor releases within the current major version as needed. Legacy major versions will not receive backported security fixes unless specifically announced.

## Threat Model

The `agent-manager` security architecture is designed to protect your secrets and AI agent configurations, treating your Git repository as the source of truth. We use a structured approach to understand and mitigate threats to this model.

### 1. Secret-at-Rest Compromise (Public Repo Leak)
**Defended Against:** Accidental or malicious exposure of your Git repository (e.g., making a private repo public, or a git host compromise).
**Not Defended Against:** Weak master passphrases. The confidentiality of your secrets relies entirely on the strength of your passphrase.
**Mechanisms:**
- Secrets are encrypted using an `age` envelope (X25519 + ChaCha20-Poly1305).
- The Key Encryption Key (KEK) is derived from your master passphrase using Argon2id (m=128 MiB, t=3, p=4 defaults; m=8 MiB hard floor for low-end devices).
- **Out of Scope:** Filenames, variable names, and Git commit history are NOT encrypted. These are considered metadata and are visible in a compromised or public repository.
**Detective Controls:** Keep an eye on your GitHub/GitLab "Public" repository lists and audit access logs if available.
**User Responsibilities:** Choose a strong master passphrase (14+ characters) and avoid reusing it.

### 2. Secret-in-Transit Interception
**Defended Against:** Network interception of secrets while syncing with remote Git repositories or fetching configurations.
**Not Defended Against:** Compromise of the TLS termination endpoints (e.g., malicious proxies if you ignore certificate warnings). TLS pinning is explicitly out of scope.
**Mechanisms:**
- All remote communication (git push/pull, fetch) mandates HTTPS.

### 3. Key-Leak via Repository Clone
**Defended Against:** An attacker obtaining your encrypted configuration repository without your master passphrase.
**Mechanisms:**
- The private age identity (`identity.age`) is stored in the repository but remains encrypted at rest, wrapped by the KEK derived from your passphrase.
- Public keys (`recipients/<hostname>.pub`) are stored in plaintext to allow other paired devices to encrypt secrets for you, but they cannot be used for decryption.

### 4. Key-Leak via Environment Variable Snapshot
**Defended Against:** Accidental inclusion of plaintext secrets in standard Git tracked files or process dumps.
**Mechanisms:**
- Secrets are not written to disk in plaintext within the repository workspace itself.
- However, `am apply` DOES write resolved (plaintext) values into native IDE config files at the user's request (e.g. `~/.claude/mcp.json`, `~/.codex/config.toml`). These files live OUTSIDE the repo and are the user's responsibility to protect with filesystem permissions. This is documented behaviour, not a leak — agents need plaintext credentials at runtime — but it means a user reading `am apply`'s output should not be surprised that decrypted material appears under their home directory.
- Process dumps (core files, ps -e env) of running CLI tools may contain plaintext credentials. Out of scope: hardening against memory-scraping attackers with host-level read access.

### 5. Browser Side-Channel / XSS (Hosted UI)
**Defended Against:** N/A (Deferred).
**Mechanisms:**
- Per ADR-0042 §3, browser-side decryption for the Web UI is currently deferred. If implemented in the future, it aims to rely on `age-wasm` and `argon2-browser` with IndexedDB/Passkeys to prevent KEK exfiltration to LocalStorage.
**Out of Scope:** Currently, the Web UI does not handle decrypted secrets directly. Full mitigation of browser side-channels is pending architectural implementation.

### 6. Supply-Chain Attack on Dependencies
**Defended Against:** Malicious updates to critical cryptographic dependencies (e.g., the Bitwarden "Shai-Hulud 2.0" incident).
**Mechanisms:**
- We audit transitive dependencies using `bun pm audit`.
- Git-installed packages are pinned by exact SHA hash.
- All new dependencies require a mandatory security review note during the PR process (see ADR-0042).
- We utilize audited packages like `cross-keychain` and plan for `argon2-browser` based on rigorous internal review.

### 7. MCP Server Impersonation
**Defended Against:** N/A in v1.
**Mechanisms:**
- Signed manifests for MCP servers are not supported in version 1.
- You must trust the MCP server URL or local path you configure.

### 8. Misconfigured Permissions on Shared Config
**Defended Against:** N/A.
**User Responsibilities:** `agent-manager` relies on the host OS file permissions and Git access controls. Ensure your repository permissions on your Git host and your local file system permissions are correctly configured.

## Cryptographic Posture

| State | Algorithms & Standards | Notes |
| :--- | :--- | :--- |
| **At-Rest** | `age` + Argon2id | Argon2id defaults: m=128 MiB, t=3, p=4. Hard floor: m=8 MiB. Configurable via `settings.secrets.argon2`. |
| **In-Transit** | HTTPS | TLS required for git/fetch operations. TLS pinning out of scope. |
| **Forward Secrecy** | NOT provided | Static X25519 recipients mean past ciphertext is compromised if a future identity leaks. Rotation protects future confidentiality only. See ADR-0051. |
| **Browser** | `age-wasm` + `argon2-browser` | Planned implementation per ADR-0042 §3. Currently deferred. |

## Dependency Hygiene

Securing the supply chain is critical, especially after incidents like the Bitwarden CLI "Shai-Hulud 2.0" attack in early 2026.
- We rely on `bun pm audit` to continuously monitor for known vulnerabilities in our dependency tree.
- Any package installed directly from a Git repository MUST be pinned to a specific commit SHA, not a branch or tag.
- Introducing a new dependency requires explicit justification and a security review note in the Pull Request. See ADR-0042 for our complete supply-chain strategy.

## Known Limitations

- **Git-Backed Marketplaces (Retired):** In v1, git-backed marketplaces (which have since been retired per ADR-0039) lacked signature verification mechanisms.
- **MCP Server Manifests:** Version 1 does not enforce or verify cryptographic signatures on MCP server manifests.
- **Metadata Visibility:** Important context (filenames, variable names, network connection destinations) remains plaintext in the repository.

## Cross-References

- [ADR-0042: Universal Secrets Strategy](ADRs/0042-universal-secrets-strategy.md) (Context on encryption at rest, in transit, and supply chain).
- [ADR-0046: Rejection of Team Passphrases](ADRs/0046-reject-team-passphrase-schema.md) (Rationale for explicit pairing vs shared keys).
- [ADR-0019: Security Hardening](ADRs/0019-security-hardening.md) (Broader security context and foundational decisions).
- [ADR-0039: Retirement of Git-Backed Marketplaces](ADRs/0039-marketplace-v1-scope-decision.md) (Context on legacy marketplace limitations).
- [ADR-0047: am pair Cross-Device Key Handoff](ADRs/0047-am-pair-cross-device-key-handoff.md) (Trust boundary + finalize hardening for adding new devices).
