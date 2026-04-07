# Secrets Encryption Strategies for agent-manager

Research into how to securely store API keys and sensitive values in a git-backed
TOML configuration repository. agent-manager syncs AI agent configs (including MCP
server env vars with API keys) via git remotes (GitHub/GitLab/self-hosted).

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Git-Native Encryption](#1-git-native-encryption)
3. [SOPS (Mozilla)](#2-sops-mozilla)
4. [Age Encryption](#3-age-encryption)
5. [SOPS + Age Hybrid](#4-sops--age-hybrid)
6. [Git Platform Secrets](#5-git-platform-secrets)
7. [Password Manager Integration](#6-password-manager-integration)
8. [External Secret Managers](#7-external-secret-managers)
9. [Key Distribution for Teams](#8-key-distribution-for-teams)
10. [Evaluation Matrix](#evaluation-matrix)
11. [Recommendation](#recommendation)

---

## Problem Statement

agent-manager stores configuration in TOML files like:

```toml
[servers.tavily]
command = "bunx tavily-mcp@latest"
env = { TAVILY_API_KEY = "tvly-abc123secret" }

[profiles.work.env]
AWS_PROFILE = "work-sso"
ANTHROPIC_API_KEY = "sk-ant-secret-key"
```

**Requirements:**
- Encrypt sensitive values (API keys in `env` tables) while keeping structure readable
- Work with GitHub, GitLab, and self-hosted git remotes
- Support `am apply` workflow (decrypt on apply, encrypt on push)
- Minimal binary dependencies (ideally pure JS or single binary)
- Team key sharing for collaborative configs
- Graceful degradation when someone without the key clones the repo

---

## 1. Git-Native Encryption

### git-crypt

**How it works:** Uses Git's clean/smudge filter system and `.gitattributes` to
transparently encrypt entire files on commit and decrypt on checkout. Uses AES-256-CTR
with a synthetic IV derived from SHA-1 HMAC. A symmetric repository key is generated
at init and encrypted for each authorized user's GPG public key.

**Setup:**
```bash
git-crypt init
echo "config/*.toml filter=git-crypt diff=git-crypt" >> .gitattributes
git-crypt add-gpg-user user@example.com
```

**Granularity: WHOLE FILES ONLY.** git-crypt encrypts the entire file contents
selected by `.gitattributes` patterns. It cannot encrypt individual TOML values
while leaving keys/structure visible. The entire `.toml` file becomes an opaque
binary blob in git.

**Key management:**
- Symmetric repo key stored in `.git/git-crypt/keys/`, encrypted per GPG recipient
- Adding users: `git-crypt add-gpg-user <email>` (must be done by existing authorized user)
- Removing users: **No built-in revocation.** Requires deleting their key copy,
  generating a new symmetric key, re-encrypting all files, and force-pushing
  rewritten history. Operationally very expensive.
- No key rotation without history rewrite

**GitHub/GitLab compatibility:** Works on any git remote. Encrypted files appear as
binary blobs. CI/CD requires provisioning the GPG private key as a platform secret
and installing the `git-crypt` binary on the runner.

**Limitations:**
- Per-file only -- no structured/value-level encryption
- Metadata leakage: filenames, commit messages, file sizes visible
- Merge/rebase conflicts on encrypted files are problematic (conflict markers hidden)
- Submodule interactions can fail
- Requires `git-crypt` binary (C++, not available as npm package)
- Windows support is experimental

**Verdict for agent-manager: NOT SUITABLE.** We need value-level encryption within
TOML files, not whole-file encryption.

### git-secret

**How it works:** A bash tool that uses GPG to encrypt files. Unlike git-crypt, it is
NOT transparent -- you must explicitly run `git secret hide` (encrypt) and
`git secret reveal` (decrypt). Encrypted files are stored as separate `.secret` files
alongside the originals (e.g., `config.toml` -> `config.toml.secret`).

**Setup:**
```bash
git secret init                              # creates .gitsecret/ directory
git secret tell user@example.com             # add GPG key to keyring
git secret add config.toml                   # register file for encryption
git secret hide                              # encrypt (creates .toml.secret)
git secret reveal                            # decrypt (restores .toml)
```

**Granularity: WHOLE FILES ONLY.** Same limitation as git-crypt -- encrypts entire
file contents, not individual values.

**Key management:**
- Uses GPG keyring stored in `.gitsecret/keys/`
- Adding users: `git secret tell <email>` then `git secret hide` to re-encrypt
- Removing users: `git secret removeperson <email>` then `git secret hide`
  (simpler than git-crypt, but secrets in old commits remain accessible)
- Requires all team members to use compatible GPG versions

**Comparison to git-crypt:**
| Aspect | git-crypt | git-secret |
|--------|-----------|------------|
| Transparency | Automatic (clean/smudge) | Manual (hide/reveal) |
| Encrypted storage | Same filename (binary blob) | Separate `.secret` file |
| Revocation | No built-in support | `removeperson` + re-encrypt |
| Dependencies | C++ binary | Bash + GPG + gawk |
| Per-value encryption | No | No |

**Verdict for agent-manager: NOT SUITABLE.** Same whole-file limitation. Also adds
operational overhead with manual hide/reveal commands.

---

## 2. SOPS (Mozilla)

**SOPS (Secrets OPerationS)** is the most interesting option. It is an editor of
encrypted files that treats structured files as trees -- encrypting leaf VALUES while
leaving KEYS and structure in cleartext.

### How SOPS Works

SOPS supports YAML, JSON, ENV, INI, and BINARY formats. It encrypts with:
- **age** (recommended, modern)
- PGP/GPG
- AWS KMS
- GCP KMS
- Azure Key Vault
- HuaweiCloud KMS
- HashiCorp Vault Transit

**The key insight:** For structured formats, SOPS generates a random 256-bit data key,
encrypts each leaf value with AES-256-GCM (unique IV and authentication data per
value), then encrypts the data key with each configured master key. The encrypted
data key is stored in a `sops` metadata block within the file itself.

**Example encrypted YAML:**
```yaml
myapp:
  db_password: ENC[AES256_GCM,data:Tr7o=,iv:1=,aad:No=,tag:k=]
  db_host: ENC[AES256_GCM,data:v8jQ=,iv:HBE=,aad:21c=,tag:gA==]
sops:
  age:
    - recipient: age1ql3z7hjy54pw...
      enc: |
        -----BEGIN AGE ENCRYPTED FILE-----
        ...
  lastmodified: "2026-04-07T10:00:00Z"
  mac: ENC[AES256_GCM,data:...,tag:...,type:str]
  version: 3.12.2
```

Keys (`myapp`, `db_password`, `db_host`) remain visible. Values are encrypted.

### SOPS and TOML Support

**Current status: TOML is NOT yet officially supported in stable releases.**

- Issue #369 (opened Jul 2018, 41 thumbsup) tracks TOML support
- PR #533 (Sep 2019) implemented TOML via `BurntSushi/toml` -- was not merged
- PR #812 (Feb 2021) reimplemented with `go-toml` -- also not merged
- PR #2031 (Jan 2026) is the latest attempt -- currently on hold waiting for
  go-toml features

SOPS uses the file extension to decide the encryption method. YAML, JSON, ENV, and
INI are treated as trees. TOML would follow the same pattern once supported.

**Workaround options:**
1. Use a `.yaml` or `.json` sidecar file for secrets only (not the main config)
2. Store the encrypted secrets in a SOPS-encrypted YAML/JSON file and reference
   them from TOML config at apply time
3. Contribute TOML support to SOPS (or use a fork with TOML support)
4. Implement our own SOPS-compatible TOML encryption using the SOPS library

### Selective Encryption Controls

SOPS provides fine-grained control over which values get encrypted:

```yaml
# .sops.yaml (config file)
creation_rules:
  - path_regex: \.secrets\.yaml$
    age: age1ql3z7hjy54pw...
    encrypted_regex: '^(password|api_key|secret|token)$'
  - path_regex: \.yaml$
    age: age1ql3z7hjy54pw...
    unencrypted_suffix: "_plaintext"
```

Controls include:
- `encrypted_suffix` / `unencrypted_suffix` -- encrypt based on key suffix
- `encrypted_regex` / `unencrypted_regex` -- encrypt based on key pattern
- `encrypted_comment_regex` -- encrypt based on YAML comments
- `--mac-only-encrypted` -- only MAC encrypted values (allows safe cleartext changes)

### Audit Logging

SOPS is the only tool that provides an auditing feature. It can forward usage events
to an audit log, tracking who decrypted what and when.

### SOPS CLI Examples

```bash
# Install
brew install sops

# Encrypt a file
sops --encrypt --age age1ql3z7hjy54pw... secrets.yaml > secrets.enc.yaml

# Encrypt in-place
sops encrypt -i secrets.yaml

# Decrypt to stdout
sops decrypt secrets.enc.yaml

# Decrypt in-place
sops decrypt -i secrets.enc.yaml

# Edit encrypted file (decrypts -> opens editor -> re-encrypts)
sops edit secrets.enc.yaml

# Extract a single value
sops decrypt --extract '["myapp"]["db_password"]' secrets.enc.yaml

# Set a single value
sops set secrets.enc.yaml '["myapp"]["new_key"]' '"new_value"'
```

### Verdict for agent-manager

**SOPS is the best conceptual fit** -- value-level encryption, multiple key backends,
git-friendly, selective encryption controls. The lack of TOML support is the main
blocker. Workarounds exist (YAML/JSON sidecar for secrets).

---

## 3. Age Encryption

**age** is a simple, modern file encryption tool designed as a replacement for GPG.
Created by Filippo Valsorda (Go team at Google).

### How age Works

```bash
# Generate key pair
age-keygen -o key.txt
# Output:
# Public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
# AGE-SECRET-KEY-1GFPYYYYY...

# Encrypt to a recipient
age -r age1ql3z7hjy54pw... -o secret.enc secret.txt

# Encrypt to multiple recipients (team sharing)
age -r age1abc... -r age1def... -r age1ghi... -o secret.enc secret.txt

# Decrypt with identity
age -d -i key.txt secret.enc > secret.txt
```

### Key Properties

- **Small keys:** Public keys are ~62 chars (vs GPG's multi-KB keys)
- **No key server needed:** Keys are simple strings, shared via any channel
- **Multiple recipients:** File encrypted to N public keys; any one private key decrypts
- **SSH key support:** Can encrypt to `ssh-ed25519` and `ssh-rsa` keys (not recommended
  for new systems)
- **Plugins:** `age-plugin-yubikey` for hardware keys, `age-plugin-tpm` for TPM
- **Passphrase mode:** `age -p` for symmetric passphrase-based encryption
- **No config files:** Stateless, no keyring, no trust model

### age vs GPG

| Aspect | age | GPG |
|--------|-----|-----|
| Key size | ~62 chars | Multi-KB |
| Setup complexity | `age-keygen` (one command) | `gpg --gen-key` (interactive wizard) |
| Key server | None needed | Optional keyservers |
| Trust model | None (explicit keys) | Web of trust |
| Binary size | ~5MB | ~15MB+ |
| Maintained | Active (Filippo Valsorda) | Active but complex |
| JS implementation | None (Go only) | OpenPGP.js exists |

### How chezmoi Uses age

chezmoi (dotfile manager) integrates age natively:

```toml
# ~/.config/chezmoi/chezmoi.toml
encryption = "age"
[age]
    identity = "/home/user/key.txt"
    recipient = "age1ql3z7hjy54pw..."

# Multiple recipients for team sharing:
[age]
    identities = ["/home/user/key1.txt", "/home/user/key2.txt"]
    recipients = ["age1abc...", "age1def..."]
```

Files are encrypted on `chezmoi add --encrypt` and decrypted on `chezmoi apply`.
chezmoi also has a builtin age implementation (no external binary needed), though
it lacks passphrase/SSH key support.

### Verdict for agent-manager

age is excellent as a **key backend** but by itself only does whole-file encryption.
It needs to be combined with SOPS or a custom solution for value-level encryption.

---

## 4. SOPS + Age Hybrid

**This is the most promising approach for agent-manager.**

SOPS uses age as its recommended key backend. The combination gives:
- SOPS: value-level encryption, structured file support, selective encryption
- age: simple key management, multiple recipients, no GPG complexity

### Workflow

```bash
# 1. Generate age key (one-time per user)
age-keygen -o ~/.config/sops/age/keys.txt
chmod 600 ~/.config/sops/age/keys.txt
# Note the public key: age1ql3z7hjy54pw...

# 2. Create .sops.yaml in repo root
cat > .sops.yaml <<'EOF'
creation_rules:
  - path_regex: \.secrets\.yaml$
    age: >-
      age1ql3z7hjy54pw...,
      age1abc123teamm8...,
      age1def456teamm8...
EOF

# 3. Create secrets file
cat > secrets.yaml <<'EOF'
servers:
  tavily:
    TAVILY_API_KEY: "tvly-abc123secret"
  outlook:
    MIDWAY_AUTH: "true"
profiles:
  work:
    ANTHROPIC_API_KEY: "sk-ant-secret-key"
    AWS_PROFILE: "work-sso"
EOF

# 4. Encrypt
sops encrypt -i secrets.yaml

# 5. Commit encrypted file
git add secrets.yaml .sops.yaml
git commit -m "Add encrypted secrets"

# 6. Decrypt when needed
sops decrypt secrets.yaml
```

### SOPS Environment Variables for Key Location

```bash
# Point to age private key
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
# Or provide key directly
export SOPS_AGE_KEY="AGE-SECRET-KEY-1GFPYYYYY..."
# Or run a command to fetch the key
export SOPS_AGE_KEY_CMD="op read op://vault/sops-key/private-key"
```

### Adding a Team Member

```bash
# 1. Team member generates their key and shares public key
age-keygen -o ~/.config/sops/age/keys.txt
# Share: age1newuser...

# 2. Admin adds recipient to .sops.yaml
# Edit creation_rules to add the new public key

# 3. Re-encrypt all files with new recipient list
sops updatekeys secrets.yaml
```

### What Happens Without the Key

Someone who clones the repo without an age private key:
- Can read the file structure (keys are cleartext)
- Sees `ENC[AES256_GCM,data:...]` for all sensitive values
- Cannot decrypt values
- Can still work with non-secret parts of the config
- `sops decrypt` will fail with a clear error message

### GitHub Actions Integration

```yaml
# .github/workflows/deploy.yml
jobs:
  deploy:
    steps:
      - uses: actions/checkout@v4
      - name: Decrypt secrets
        env:
          SOPS_AGE_KEY: ${{ secrets.SOPS_AGE_KEY }}
        run: sops decrypt -i secrets.yaml
```

The age private key is stored as a GitHub Secret. CI can decrypt; local devs use
their own age key (listed as a recipient in `.sops.yaml`).

---

## 5. Git Platform Secrets

### GitHub Actions Secrets

**API:** Full REST API for creating, reading (metadata only), updating, and deleting
secrets at repository, environment, and organization levels.

```bash
# CLI (gh)
gh secret set SOPS_AGE_KEY < key.txt
gh secret set TAVILY_API_KEY --body "tvly-abc123"
gh secret list

# API
GET /repos/{owner}/{repo}/actions/secrets
PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}
```

**Limitations:**
- Secrets are ONLY available inside GitHub Actions workflows
- Cannot be read by external tools or `am apply` on a local machine
- 100 secrets per repo, 1000 per org, 100 per environment
- 48KB max size per secret
- Values are write-only -- you can never read back the plaintext via API
- Encrypted with repo-specific NaCl sealed box using a per-repo public key

**Can they be used outside CI/CD?** **No.** GitHub Actions secrets are injected as
environment variables only during workflow runs. There is no API to retrieve the
plaintext value. They are useful as a KEY STORE for storing the SOPS/age decryption
key, but not as a general secret store for application config.

### GitLab CI/CD Variables

```bash
# API
GET /projects/:id/variables
POST /projects/:id/variables
PUT /projects/:id/variables/:key
DELETE /projects/:id/variables/:key
```

**Key features:**
- Variables can be `protected` (only available on protected branches)
- Variables can be `masked` (hidden from job logs)
- Environment-scoped variables (different values per environment)
- Unlike GitHub, the API CAN return variable values (with proper auth)

**Limitations:**
- Primarily designed for CI/CD pipelines
- 200 variables per project, 150 per group
- 10,000 bytes max per variable value

### Platform Secrets as Key Store

The best use of platform secrets is as a **key store for decryption keys**:

| Scenario | How it works |
|----------|--------------|
| CI/CD | Store age private key as platform secret; CI decrypts SOPS files |
| Local dev | Each dev has their own age key; their public key is in `.sops.yaml` |
| New machine | Pull age key from password manager (1Password, Bitwarden) |

This is the pattern recommended by the SOPS + age community:
- Encrypted config lives in git (SOPS-encrypted)
- Decryption key lives in platform secrets (CI) or local keyfile (dev)
- `.sops.yaml` lists all authorized recipients (public keys)

---

## 6. Password Manager Integration

### 1Password CLI (`op://` references)

1Password provides `op://` secret reference URIs that can be embedded in config files:

```yaml
# config.yaml (checked into git)
servers:
  tavily:
    TAVILY_API_KEY: "op://Development/Tavily/api-key"
```

**Resolution methods:**
```bash
# Read a single secret
op read "op://Development/Tavily/api-key"

# Inject secrets into a running process
op run -- node app.js

# Inject secrets into a config file template
op inject -i config.tpl -o config.yaml
```

**Pros:**
- Zero-knowledge: secrets never touch disk in plaintext
- Team sharing via 1Password vaults
- Biometric auth support
- Service accounts for CI/CD (`OP_SERVICE_ACCOUNT_TOKEN`)

**Cons:**
- Requires 1Password subscription ($4-8/user/month)
- `op` binary required (~50MB)
- Config files contain references, not values -- runtime resolution needed
- Offline access depends on local 1Password cache

### chezmoi + 1Password Integration

chezmoi templates can pull from 1Password:
```
{{ onepasswordRead "op://app-prod/db/password" }}
```

### Bitwarden CLI

Similar pattern with `bw` CLI:
```bash
bw get password "Tavily API Key"
# or via Bitwarden Secrets Manager
bws get secret <secret-id>
```

### Verdict for agent-manager

Password manager integration is excellent as a **key distribution mechanism** for
the age private key, and as an optional **secret provider adapter** in Phase 2.
It should not be the primary encryption strategy because it requires a subscription
and specific vendor tooling.

---

## 7. External Secret Managers

### Doppler

Cloud-first SaaS for secrets. Developer-friendly CLI:
```bash
doppler setup                            # link directory to project
doppler run -- node app.js               # inject secrets as env vars
doppler secrets set API_KEY "value"      # store a secret
doppler secrets get API_KEY --plain      # retrieve a secret
```

**Pricing:** ~$15-30/month for small teams. No self-hosted option.

### Infisical

Open-source (MIT), self-hostable secrets manager:
```bash
infisical init                           # link to project
infisical run -- node app.js             # inject secrets
infisical scan git-history               # scan for leaked secrets
```

**Pricing:** Free (self-hosted). Cloud offering available.

### HashiCorp Vault

Enterprise-grade with dynamic secrets:
```bash
vault kv put secret/myapp api_key="value"
vault kv get -field=api_key secret/myapp
```

**Pricing:** Complex. HCP Vault ~$0.03/hour. Self-hosted is free but operationally heavy.

### Comparison

| Feature | Doppler | Infisical | Vault |
|---------|---------|-----------|-------|
| Self-hostable | No | Yes (MIT) | Yes (BSL) |
| Dynamic secrets | No | Limited | Yes |
| Ease of use | Very easy | Easy | Hard |
| Cost | ~$15/mo | Free self-hosted | High |
| Git integration | Env injection | Env injection | Sync to GitHub |

### Verdict for agent-manager

External secret managers are too heavy as a requirement for Phase 1. They could be
supported as optional adapters in Phase 2 (resolve `vault://`, `doppler://`, or
`infisical://` references at apply time).

---

## 8. Key Distribution for Teams

The fundamental challenge: how do teams share decryption keys?

### Pattern 1: age Multiple Recipients

Each team member generates their own age keypair. All public keys are listed in
`.sops.yaml`. SOPS encrypts the data key to ALL listed recipients.

```yaml
# .sops.yaml
creation_rules:
  - age: >-
      age1alice...,
      age1bob...,
      age1charlie...,
      age1ci-runner...
```

**Adding a member:** Add their public key to `.sops.yaml`, run `sops updatekeys`.
**Removing a member:** Remove their key, run `sops updatekeys`, rotate actual secrets.

**Pros:** No shared secrets. Each person has their own private key.
**Cons:** Must re-encrypt when team membership changes. Old commits still decryptable
with old keys (rotate actual secret values when removing members).

### Pattern 2: Shared Key via Password Manager

Store a single age private key in a shared 1Password/Bitwarden vault.
All team members access the same key.

**Pros:** Simple. No re-encryption needed when team changes.
**Cons:** Shared secret. Can't revoke individual access without rotating the key.

### Pattern 3: Platform Secrets as Key Store

Store the age key as a GitHub/GitLab secret for CI. Team members get the key
from a password manager or secure channel.

```
CI/CD  -->  GitHub Secret "SOPS_AGE_KEY"  -->  sops decrypt
Local  -->  ~/.config/sops/age/keys.txt   -->  sops decrypt
```

### Pattern 4: Sealed Secrets (Public Key Encrypt)

Anyone can encrypt with the public key (checked into repo). Only the holder
of the private key can decrypt. Useful for "encrypt and forget" contributions.

### Recommended Pattern for agent-manager

**Combine Patterns 1 + 3:**
- Each team member has their own age keypair (Pattern 1)
- CI uses a dedicated age keypair stored as platform secret (Pattern 3)
- `.sops.yaml` lists all authorized public keys
- Private keys distributed via password manager or secure channel
- `sops updatekeys` when team membership changes

---

## Evaluation Matrix

| Criteria | git-crypt | git-secret | SOPS+age | 1Password | Doppler/Infisical |
|----------|-----------|------------|----------|-----------|-------------------|
| **Value-level TOML encryption** | No (whole-file) | No (whole-file) | Yes* (YAML/JSON) | N/A (references) | N/A (external) |
| **GitHub/GitLab/self-hosted** | Yes | Yes | Yes | Yes | Yes |
| **Team key sharing** | GPG (complex) | GPG (complex) | age multi-recipient | Vault sharing | Built-in |
| **Binary dependency** | C++ binary | Bash+GPG | Go binary (sops+age) | `op` binary | CLI binary |
| **Pure JS available** | No | No | No** | No | SDK available |
| **`am apply` integration** | Transparent | Manual hide/reveal | Decrypt before apply | Resolve at runtime | Inject at runtime |
| **Graceful without key** | Binary blob | Missing files | Structure visible | References visible | Errors |
| **Key rotation** | History rewrite | Re-encrypt | `updatekeys` | Vault rotation | Built-in |
| **Audit logging** | No | No | Yes | Yes | Yes |
| **Selective encryption** | No | No | Yes (regex/suffix) | N/A | N/A |
| **Cost** | Free | Free | Free | $4-8/user/mo | $0-15/mo |

\* TOML not yet supported; YAML/JSON sidecar works today
\** No JS SOPS library exists; would need to shell out to `sops` binary or implement

---

## Recommendation

### Phase 1: Minimal Dependencies (Ship Now)

**Strategy: SOPS + age with a YAML/JSON secrets sidecar**

Since SOPS doesn't support TOML yet, use a companion secrets file:

```
myproject/
  am.toml                    # Main config (committed, cleartext)
  am.secrets.yaml            # Secrets only (committed, SOPS-encrypted)
  .sops.yaml                 # SOPS config with age recipients
```

**`am.toml`** references secrets by convention:
```toml
[servers.tavily]
command = "bunx tavily-mcp@latest"
env = { TAVILY_API_KEY = "$sops:servers.tavily.TAVILY_API_KEY" }
```

**`am.secrets.yaml`** (encrypted with SOPS):
```yaml
servers:
  tavily:
    TAVILY_API_KEY: ENC[AES256_GCM,data:...,tag:...]
```

**`am apply` workflow:**
1. Check for `am.secrets.yaml` (or `.json`)
2. If present, run `sops decrypt` to get plaintext values
3. Resolve `$sops:` references in env tables
4. Generate adapter config with resolved values
5. Never write plaintext secrets to the generated config files on disk --
   inject them via environment variables or platform-specific secure mechanisms

**Dependencies:** `sops` and `age` binaries (both installable via `brew`, `apt`, etc.)

**Key distribution:**
- Each user runs `age-keygen` and shares their public key
- Admin adds public key to `.sops.yaml` and runs `sops updatekeys`
- CI gets a dedicated age key stored as a platform secret

**Fallback for users without keys:**
- `am apply` works for all non-secret config (servers, skills, instructions, profiles)
- Secret-dependent env vars show a warning: "Encrypted value -- run `am secrets setup` to configure decryption"

### Phase 2: Team-Friendly, Multi-Provider

**Add secret provider adapters:**

```toml
[servers.tavily]
command = "bunx tavily-mcp@latest"
env = { TAVILY_API_KEY = "$secret:tavily-key" }

[secrets]
provider = "sops"   # or "1password", "doppler", "infisical", "env"

[secrets.sops]
file = "am.secrets.yaml"

[secrets.onepassword]
vault = "Development"

[secrets.doppler]
project = "agent-manager"
config = "dev"

[secrets.env]
# Resolve from environment variables directly
TAVILY_API_KEY = "TAVILY_API_KEY"
```

**`am secrets` subcommands:**
```bash
am secrets setup              # Interactive provider setup
am secrets set <key> <value>  # Encrypt and store a secret
am secrets get <key>           # Decrypt and print a secret
am secrets list                # List secret keys (not values)
am secrets rotate              # Re-encrypt with current key list
am secrets add-recipient <age-pubkey>  # Add team member
```

### Phase 3: The Ideal Solution

**Native TOML value-level encryption (SOPS-compatible or custom)**

When SOPS adds TOML support (PR #2031), or as a custom implementation:

```toml
[servers.tavily]
command = "bunx tavily-mcp@latest"

[servers.tavily.env]
TAVILY_API_KEY = "ENC[AES256_GCM,data:abc123,iv:def456,tag:ghi789,type:str]"

[profiles.work.env]
AWS_PROFILE = "work-sso"
ANTHROPIC_API_KEY = "ENC[AES256_GCM,data:xyz,iv:abc,tag:def,type:str]"

[sops]
age = [{recipient = "age1ql3z7hjy54pw...", enc = "..."}]
lastmodified = "2026-04-07T10:00:00Z"
mac = "ENC[AES256_GCM,data:...,tag:...,type:str]"
version = "3.12"
```

This is the dream state: a single `am.toml` file where:
- Structure and non-secret values are cleartext (readable, diffable, mergeable)
- Secret values are individually encrypted inline
- The `[sops]` metadata block enables decryption
- `am apply` transparently decrypts values using the user's age key
- `am push` ensures encrypted values are not accidentally committed in cleartext

**Implementation path:**
- If SOPS merges TOML support: use it directly
- If not: implement a TOML-aware encrypt/decrypt in TypeScript that follows the
  SOPS format (`ENC[AES256_GCM,...]`) for compatibility, using `@aspect-build/age`
  or a Node.js age binding for key operations

### Implementation Priority

| Priority | Feature | Dependencies | Effort |
|----------|---------|-------------|--------|
| P0 | YAML secrets sidecar with SOPS+age | sops, age binaries | 1-2 days |
| P0 | `$sops:` reference resolution in env tables | None (string parsing) | 1 day |
| P0 | `am secrets setup` (guided keygen + .sops.yaml) | sops, age | 1 day |
| P1 | `am secrets set/get/list` commands | sops binary | 1-2 days |
| P1 | Pre-push hook to prevent plaintext secret commits | None | 0.5 days |
| P2 | 1Password/Bitwarden provider adapter | op/bw CLI | 2-3 days |
| P2 | Doppler/Infisical provider adapter | doppler/infisical CLI | 2-3 days |
| P3 | Native TOML inline encryption | SOPS TOML support or custom | 3-5 days |
| P3 | `am secrets rotate` with re-encryption | sops | 1 day |

### Why SOPS + age Over Alternatives

1. **Value-level encryption** -- the only approach that keeps config structure readable
2. **age simplicity** -- no GPG keyring hell, 62-char public keys, easy team onboarding
3. **Multiple recipients** -- each team member has their own key, no shared secrets
4. **Platform-agnostic** -- works with GitHub, GitLab, self-hosted, any git remote
5. **Established ecosystem** -- 21K+ GitHub stars, active maintenance, wide CI/CD support
6. **Graceful degradation** -- without the key, you still see the config structure
7. **Future-proof** -- when SOPS adds TOML support, we get inline encryption for free
8. **Audit trail** -- SOPS tracks lastmodified and can log decrypt events
