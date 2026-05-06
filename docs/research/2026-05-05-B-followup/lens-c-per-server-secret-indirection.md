# Lens C: Per-MCP-Server Secret Indirection Across Git Backends

[reviewer: deepseek/deepseek-v4-pro]

**Date:** 2026-05-05
**Lens:** C — per-MCP-server secret-indirection patterns and abstraction across git backends
**Context:** `agent-manager` (am) catalogs MCP servers in TOML. Each server has `command`/`args`/`env`. Secrets (API keys) must never be plaintext in committed TOML. The `am secret set TAVILY_API_KEY <value>` UX stores secrets via a pluggable `SecretsBackend` and they are referenced in server env tables as `${TAVILY_API_KEY}`.

This lens answers: what is the right per-server secret indirection abstraction so that (a) secrets never go in the public repo, (b) the strategy can be optionally swapped per-server, and (c) it works regardless of which git backend (GitHub/GitLab/Gitea/Codeberg) hosts the config?

---

## 1. Existing Patterns for Env-Var Indirection in CLI Tools

The industry has converged on a small set of patterns for referring to secrets without inlining their values. Here is a survey, ordered by relevance to am:

### 1.1 Docker Compose: `env_file` + Secrets

Docker Compose provides two indirection mechanisms:
- **`env_file`**: A `.env` file sits next to `docker-compose.yml`. Values are `KEY=VALUE` pairs. The file is `.gitignore`'d. At `docker compose up`, values are injected as container environment variables. This is the simplest indirection: the config merely references the *name*; the value lives in a non-committed local file.
- **Secrets**: In Swarm mode (and via the `secrets:` top-level key with file-based secrets), secrets are mounted as files under `/run/secrets/<name>`. A wrapper script (like `with-secrets.sh`) reads `/run/secrets` filenames and exports them as env vars. This is the cleanest pattern: secrets never appear in process listings as env-vars (the file-read approach prevents `ps aux` leaks).

**Relevance to am:** The split between "committed config with placeholders" and "local file with values" maps exactly to am's TOML (committed) vs. secret store (local). The docker-compose pattern is a baseline for how am should handle secrets: `${VAR}` references in the committed config, resolved from a local store at spawn time.

### 1.2 Kubernetes: Secrets + Sealed Secrets + External Secrets

Kubernetes provides three escalation stages for secret indirection:

- **Native Secrets**: A `Secret` object stores base64-encoded values. Pods consume them either as env vars (`env[].valueFrom.secretKeyRef`) or volume mounts. The indirection is declarative: the Pod spec names the secret and key; the value is resolved by the kubelet at scheduling time. The Secret manifest itself is plaintext base64 (NOT encrypted at rest in etcd by default).

- **Sealed Secrets** (Bitnami): A `SealedSecret` CRD carries ciphertext encrypted to an in-cluster controller's public key. Anyone can create a `SealedSecret`; only the controller with the private key can decrypt it into a native `Secret`. The indirection model: committed ciphertext, decoupled from the decryption capability. Public key encrypts, private key decrypts in-cluster. This provides GitOps-safe secrets: the `SealedSecret` can be committed to git, but the plaintext never leaves the cluster.

- **External Secrets Operator**: References secrets from AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, HashiCorp Vault, etc. The indirection is a `ExternalSecret` CRD that says "fetch key X from store Y" and materializes it as a native `Secret`. This is the most advanced pattern: the indirection is a *reference to a secret store*, not the secret itself.

**Relevance to am:** The Sealed Secrets model (public-key-encrypt, private-key-decrypt, ciphertext in git) is structurally identical to am's age backend. The External Secrets model (reference to external store) is the pattern for am's future `1password`, `vault`, and `kms-aws` backends. Kubernetes demonstrates that a unified indirection syntax can support multiple backends polymorphically.

### 1.3 envsubst / gettext Pattern

The Unix `envsubst` tool (from gettext) replaces `${VAR}` in template files with environment variable values. This is the simplest programmatic indirection: a template file contains `${VAR}` references; `envsubst < template > output` produces a resolved file. Tools like `direnv` and shell profile scripts use this pattern to populate configs from environment at shell-init time.

**Relevance to am:** am already uses `${VAR}` syntax in TOML (`interpolateEnv` / `interpolateEnvAsync` in `src/core/secrets.ts`). This is the correct choice — it's the most widely understood indirection syntax in the Unix ecosystem. The question for this lens is: what *resolution strategies* sit behind the `${VAR}` syntax?

### 1.4 chezmoi: Pluggable Template Functions

chezmoi manages dotfiles in git. For secrets, it provides template functions that pull values from external stores at `apply` time:
- `{{ (onepassword "vault/item/field").password }}` — fetches from 1Password CLI
- `{{ (bitwarden "item").login.password }}` — fetches from Bitwarden CLI
- `{{ (vault "secret/path").data.key }}` — fetches from HashiCorp Vault
- `{{ (keyring "service" "user") }}` — fetches from OS keyring
- `{{ (keepassxc "entry").Password }}` — fetches from KeePassXC

The key insight: chezmoi's template functions are *lazily evaluated at apply time*. The committed dotfile template contains a function call; the function resolves at runtime on the target machine. Each template function points at a different backend, but the template syntax is uniform.

**Relevance to am:** This is the MOST RELEVANT prior art. am should adopt the same model: a uniform `${VAR}` reference in TOML, but with per-backend resolution strategies. chezmoi's per-machine identity model (each machine has its own age key) is already adopted by am's age backend. The next step is extending the indirection to arbitrary per-server backends.

### 1.5 Doppler CLI / Infisical CLI / dotenv-vault

Modern secrets-as-a-service tools provide:
- **Doppler**: `doppler run -- command` injects secrets from a Doppler project as env vars for the subprocess. Configs reference secret names, not values.
- **Infisical**: `infisical run -- command` does the same; also supports `infisical secrets` for CRUD operations. Secrets are structured into projects and environments.
- **dotenv-vault**: Encrypts `.env` files with a shared key. `npx dotenv-vault pull` decrypts locally. The `.env.vault` file can be committed; plaintext never hits git.

**Relevance to am:** These tools demonstrate that the "wrap the subprocess and inject env vars" pattern is industry standard. am's equivalent is: when spawning an MCP server subprocess (via gateway or apply-to-claude), am must resolve `${VAR}` references to plaintext and inject them as env vars for the spawned process. The resolution happens at spawn time, in memory only.

### 1.6 1Password CLI: `op://` Reference Scheme

1Password CLI provides secret references with the syntax:
```
op://<vault>/<item>[/<section>]/<field>
```

Example: `op://Private/Anthropic/credential`

The `op run` command scans environment variables for `op://` references, resolves them via the 1Password daemon, and runs the target command in a subprocess with resolved values. `op inject` performs static template substitution into config files.

This is significant because Anthropic's Claude Code has an open feature request (github.com/anthropics/claude-code/issues/23642) to support `op://` secret references in `.mcp.json` env sections. If Claude Code adopts this natively, it creates an ecosystem standard that am should interoperate with.

**Relevance to am:** Extremely high. am should consider supporting `op://` references as a first-class indirection scheme in TOML. The 1P CLI's `op run` model (resolve at subprocess boundary) maps directly to how am spawns MCP servers.

### 1.7 HashiCorp Vault: `vault://` and Agent-Sidecar Pattern

Vault's approach is two-fold:
- **Vault Agent**: Runs as a sidecar or init container. Injects secrets as env vars via a template that reads from `vault://` or path references. The agent handles authentication and token renewal.
- **Kubernetes mutation**: Vault's mutating webhook injects secrets directly into Pod env vars at admission time.

Vault does not define a single canonical URI scheme (like `vault://path/to/secret#key`), but several tools in the ecosystem do. The pattern is always: committed config has a reference; a local agent or sidecar resolves at runtime.

**Relevance to am:** Relevant for team/enterprise users who already run Vault. am's pluggable backend interface (`SecretsBackend`) should support a Vault backend that resolves `vault://` or similar references at spawn time. Less relevant for solo developers.

---

## 2. `ref://` URL Schemes as a Config DSL

### 2.1 Pros and Cons of URI Schemes in TOML

**Pros:**
- **Self-describing**: `op://Private/Anthropic/credential` carries both the backend and the path in a single string. No separate `backend` field needed.
- **Extensible**: New backends add new schemes (`vault://`, `aws-sm://`, `env://`). The TOML schema doesn't change.
- **Familiar**: `op://` is already an ecosystem standard. Developers understand URI-based indirection.
- **Composable**: URIs can carry query parameters for options (`vault://secret/path?version=2`).

**Cons:**
- **Parsing complexity**: Each scheme requires a resolver. URI parsing is non-trivial (percent-encoding, fragments, queries).
- **Namespace collision**: What if someone names their secret `op://something` literally? Ambiguity between literal string and reference.
- **Error locality**: `op://Private/WrongVault/credential` fails at runtime, not at config-parse time. Harder to validate statically.
- **Mixed schemes in one config**: A server's env might mix `op://`, `vault://`, and `env://` references. Resolution order becomes ambiguous.

### 2.2 How Would a `secret://NAME` Ref Resolve in am?

Given am's existing `${TAVILY_API_KEY}` syntax, the question is: should am support URI-based references in addition to or instead of `${VAR}`?

**Option A: Keep `${VAR}` and add backend routing behind it.**
```toml
[servers.tavily]
command = "tavily-mcp"
env = { TAVILY_API_KEY = "${TAVILY_API_KEY}" }

# Resolution: look up TAVILY_API_KEY in the secret store.
# Which store? Determined by server-level or global config.
```
This is the current model. Simple, well-understood, non-ambiguous.

**Option B: Allow URI refs in env values.**
```toml
[servers.tavily]
command = "tavily-mcp"
env = { TAVILY_API_KEY = "op://Personal/Tavily/credential" }
```
This requires am to recognize `op://`, `vault://`, `age://`, `env://` prefixes and route accordingly.

**Option C: Hybrid — `${VAR}` with optional backend-qualifier.**
```toml
[servers.tavily]
command = "tavily-mcp"
env = { TAVILY_API_KEY = "${secret://TAVILY_API_KEY}" }
```
This is the `secret://` prefix as a disambiguation from plain `env://NAME` which just reads `process.env.NAME`.

### 2.3 Resolution Timing

There are three possible resolution points:

1. **Config-load time (eager):** At `am apply` time, `interpolateEnvAsync` resolves all `${VAR}` and decrypts `enc:v1:` values. The resolved plaintext is written to native IDE configs (`~/.claude.json`, etc.). This is the current model. The downside: native IDE configs now contain plaintext secrets on disk. The upside: the IDE doesn't need to do any resolution.

2. **Lazy on each subprocess spawn:** At `am run` time (when spawning an MCP server), resolve `${VAR}` just before the `child_process.spawn()`. Plaintext only lives in the spawned process's memory. This requires am to act as a launcher — it can't just write config and exit. The spawned IDE itself handles resolution.

3. **Fan-out at apply-time into native adapter configs:** When `am apply` writes to an IDE adapter's native config, it can emit either plaintext or a *native indirection* the IDE understands. For example, if Cursor supports `.cursor/mcp.json` with `envFile`, am could emit `${VAR}` references to be resolved by the IDE's own env-file loader. This is ideal but requires per-adapter knowledge of what indirection syntax each IDE supports.

**Recommendation:** Resolution timing should be configurable per-adapter. Some IDEs (Claude Code) support `envFile` or `${VAR}`-in-.mcp.json patterns. For those, emit unresolved references. For IDEs that don't, resolve eagerly. The default should be eager resolution (current behavior) with opt-in lazy resolution per adapter.

---

## 3. Universal Secret Backend for am — The Candidate Set

### 3.1 am-builtin: Age Envelope In-Line (Current Default)

**Integration cost:** Already shipped. Zero additional cost. The `SecretsBackend` interface exists; the `AgeSecretsBackend` class is implemented; `getDefaultBackend` wires it up.

**Cross-platform support:** Excellent. The `age-encryption` npm package is pure JS and works on macOS, Linux, Windows, and in browsers (WASM path for the hosted UI). OS keychain caching via `cross-keychain` covers all three platforms.

**UX:** User runs `am init`, sets a master passphrase, done. Subsequent operations are zero-prompt (keychain-cached KEK). Adding a new machine: `am pair add`, passphrase once.

**Scope:** Per-machine identity, multi-recipient encryption, config-level scope (all servers share one backend).

### 3.2 System OS Keychain via cross-keychain

**Integration cost:** Already integrated as the *unlock cache* for the age backend. Using it as a primary secret store (not just a KEK cache) would require a new backend implementing `SecretsBackend`.

**Cross-platform support:** `cross-keychain` supports macOS Keychain, Linux libsecret (GNOME Keyring / KDE Wallet), and Windows Credential Manager. The npm package was audited (see `docs/audit/2026-05-05-cross-keychain-audit.md`).

**UX:** If the OS keychain is the primary store, `am secret set KEY value` writes to the keychain directly. Pro: no passphrase needed, OS handles security. Con: secrets don't sync across machines (the keychain is per-machine by design). This is a feature for some use cases (machine-specific credentials) and a bug for others (team-shared API keys).

**Scope:** Per-machine, per-server (keychain entries are keyed `service=agent-manager, account=<server>/<key>`).

### 3.3 Bun.secrets (Bun-Native Keyring)

**Integration cost:** Low if am runs on Bun. `Bun.secrets.get({ service, account })` / `Bun.secrets.set()` maps to the same OS keychain backends as `cross-keychain`. However, the Bun Secrets API is relatively new and may have subtle behavioral differences from `cross-keychain`.

**Cross-platform support:** Bun's native keyring support covers macOS Keychain, libsecret, and Windows Credential Manager. Same platform coverage as `cross-keychain`. The difference: `Bun.secrets` is a Bun runtime API; `cross-keychain` is an npm package callable from Node.js or Bun.

**UX:** Identical to cross-keychain. One fewer dependency if am is Bun-only.

**Scope:** Per-machine, per-server.

**Recommendation:** Defer. `cross-keychain` is already integrated and audited. `Bun.secrets` adds no new capability. Revisit if am goes Bun-only.

### 3.4 1Password CLI via `op://` Refs

**Integration cost:** Medium. Requires:
1. An `op://` reference parser (simple URI parsing).
2. A resolver that shells out to `op read op://Vault/Item/Field` (or uses the 1Password Connect SDK).
3. Integration with `interpolateEnvAsync` to recognize `op://` values and resolve them.

**Cross-platform support:** The `op` CLI is available on macOS, Linux, and Windows. It requires a 1Password account (paid). The CLI can be automated via `OP_SERVICE_ACCOUNT_TOKEN` for CI/CD.

**UX:** Excellent for existing 1Password users. They can reference secrets by their 1Password item paths. No need to duplicate secrets between 1Password and am's store. The `op://` syntax is already familiar to many developers.

**Scope:** Any scope — secrets are stored in 1Password vaults, which can be shared across teams.

**Recommendation:** This is a HIGH-PRIORITY backend. 1Password is widely used by developers, and the `op://` reference scheme is becoming an ecosystem standard (Claude Code is considering native support). am should support `op://` references in TOML env values.

### 3.5 HashiCorp Vault via vault:// Refs

**Integration cost:** High. Requires:
1. A `vault://` reference parser.
2. A Vault client (the `node-vault` npm package or direct HTTP to the Vault API).
3. Authentication management (token, AppRole, Kubernetes auth, etc.).
4. Token renewal and caching.

**Cross-platform support:** Vault server runs anywhere, but the client-side integration requires network access to the Vault server.

**UX:** High-friction for solo developers. Excellent for enterprises that already run Vault. The `vault://secret/path#key` reference pattern is well-understood.

**Scope:** Team/enterprise scope. Vault is designed for multi-tenant secret management.

**Recommendation:** Defer to post-MVP. Vault is important for enterprise adoption but adds significant complexity. The `SecretsBackend` interface is designed to accommodate it; implement when there's enterprise demand.

### 3.6 Just env: var (No Indirection, User Manages)

**Integration cost:** Zero. Already supported via `interpolateEnv` which reads `process.env.VAR`.

**Cross-platform support:** Universal. Environment variables exist everywhere.

**UX:** Simplest possible model. User sets `export TAVILY_API_KEY=sk-...` in their shell profile. am reads it at apply/run time. No encryption at rest, no multi-machine sync, no audit trail. But: zero setup friction.

**Scope:** Per-process, per-session.

**Recommendation:** Keep as the zero-config fallback. When no backend is configured and no encrypted store exists, `${VAR}` resolves from `process.env`. This is the current behavior and should remain.

### 3.7 gpg-agent + git-crypt

**Integration cost:** Medium. git-crypt encrypts entire files in the git repo using AES-CTR with a GPG-wrapped symmetric key. Adding a user: `git-crypt add-gpg-user`. This is transparent at the git level: files are decrypted on checkout, encrypted on commit.

**Cross-platform support:** git-crypt requires `git-crypt` binary and GPG. Available on macOS, Linux, Windows.

**UX:** Good for teams that already use GPG. Poor for revocation (can't remove a user's access once they have the symmetric key). Poor for web UI (browser can't run GPG natively). Filenames are not encrypted.

**Scope:** File-level (whole files are encrypted or not). Not granular to individual values.

**Recommendation:** Do NOT adopt. git-crypt is file-level, which destroys am's value-level granularity. The `enc:v1:` value-level encryption is strictly superior for am's use case. git-crypt also has no browser path (hosted UI can't use it).

### 3.8 sops-Encrypted TOML Fragments

**Integration cost:** High. sops encrypts individual values within structured files (JSON, YAML, TOML) while preserving the structure. A `config.toml` could have inline `encrypted: ENC[AES256_GCM,data:...]` values. sops supports age, AWS KMS, GCP KMS, Azure Key Vault, PGP, and HashiCorp Vault as key sources.

**Cross-platform support:** sops binary available on macOS, Linux, Windows. No browser path (pure CLI).

**UX:** The gold standard for GitOps secrets in structured configs. Multiple key sources, value-level encryption, structure-preserving. Used by Flux CD and many Kubernetes deployments.

**Scope:** Value-level, within individual config files.

**Recommendation:** Strong consideration as an alternative wire format. sops's `ENC[AES256_GCM,data:...]` envelope is not compatible with am's `enc:v1:` envelope. But sops supports *multiple key sources per file* (e.g., encrypt to both age and AWS KMS simultaneously). This is a capability am's current `enc:v1:` format lacks. If am wants multi-recipient encryption with heterogeneous key types (age + KMS), sops's model is worth adopting. However, the integration cost is high, and the sops binary must be installed. Defer to post-MVP.

---

## 4. Per-Server Backend Override Mechanism

### 4.1 Schema Design

The schema should support three levels of backend selection:

```
Level 1: Global default
  [settings.secrets]
  backend = "age"          # or "aes-gcm-legacy", "1password", etc.

Level 2: Per-server override
  [servers.tavily.secrets]
  backend = "1password"    # this server uses 1P instead of global age

Level 3: Per-env-var inline reference
  [servers.brave]
  env = { BRAVE_API_KEY = "op://Personal/Brave/credential" }
  # Inline URI overrides both global and per-server backend settings
```

### 4.2 Precedence Chain

```
1. Inline URI scheme (op://..., vault://..., env://NAME)
   └─ If the value starts with a recognized URI scheme, use that backend.
   └─ This is the most specific and wins over everything.

2. Per-server [servers.<name>.secrets] block
   └─ If the server has a secrets.backend field, use that backend
      for ALL env vars of this server (unless overridden inline).

3. AM_SECRETS_BACKEND env var
   └─ Runtime override for the whole process.

4. Global [settings.secrets] backend
   └─ The config file's default.

5. "aes-gcm-legacy" (hardcoded fallback)
   └─ When nothing is configured, use the legacy AES-GCM backend.
```

### 4.3 Implementation Approach

The `ServerSchema` in `src/core/schema.ts` should be extended:

```typescript
// In src/core/schema.ts:
export const ServerSecretsSchema = z.object({
  backend: z.enum(["age", "aes-gcm-legacy", "1password", "vault", "env", "keychain"]).optional(),
  // Per-backend options (e.g., 1P vault name, Vault path prefix)
  options: z.record(z.string(), z.string()).optional(),
});

export const ServerSchema = z.object({
  // ... existing fields ...
  secrets: ServerSecretsSchema.optional(),
});
```

The resolution function walks the precedence chain:
```typescript
function resolveBackendForServer(
  config: Config,
  serverName: string,
  envValue: string,
): SecretsBackend {
  // 1. Inline URI
  const uriBackend = parseUriBackend(envValue);
  if (uriBackend) return uriBackend;

  // 2. Per-server
  const serverBackend = config.servers?.[serverName]?.secrets?.backend;
  if (serverBackend) return loadBackend(serverBackend);

  // 3-5. Global fallback chain
  return getDefaultBackend(configDir);
}
```

### 4.4 Critical Design Decision

**Should `[servers.X.secrets]` redirect ALL env vars of that server to a single backend, or can individual env vars within the same server use different backends?**

Option A (Single-backend-per-server): Simpler to reason about. If `[servers.tavily.secrets] backend = "1password"`, then ALL env vars of tavily are resolved via 1Password.

Option B (Mixed-per-server): More flexible but confusing. The `TAVILY_API_KEY` env var uses 1Password while `LOG_LEVEL` uses `env://`.

**Recommendation:** Option A is cleaner. Preserve Option B only via inline URI references (the precedence chain above). So:
- Per-server `secrets.backend` sets the default for all env vars.
- Individual env vars can override via inline `op://` or `env://` references.
- This is the best of both worlds without creating a combinatorial explosion of configurations.

---

## 5. MCP Env-Var Population at Runtime

### 5.1 When Does Decrypt Happen?

There are two distinct code paths:

**Path A: `am apply` → IDE adapter export**
- `controller.ts` calls `interpolateEnvAsync(config, { encryptionKey })`.
- This decrypts all `enc:v1:` values and resolves all `${VAR}` references.
- The fully-resolved `ResolvedConfig` is passed to `adapter.export()`.
- Adapter writes plaintext env vars to native IDE config files.

**Path B: `am run <agent>` → ACP/A2A spawn**
- When spawning an MCP server subprocess (stdio transport), am must construct the env object.
- The env table in TOML (post-interpolation) contains resolved values.
- These are passed directly to `child_process.spawn(cmd, args, { env })`.
- Plaintext exists in the spawned process's memory.

### 5.2 Memory-Only vs. Disk

Current behavior: plaintext lands on disk (in `~/.claude.json` and other IDE configs). This is a security concern — anyone with disk access can read the API keys.

**Better approach:**
1. For adapters that support it (Claude Code's `.mcp.json` with `envFile`), emit `${VAR}` references and let the IDE resolve them from environment at its own spawn time.
2. For adapters that don't, emit plaintext (current behavior). Document this as a tradeoff.
3. In the future, am's own MCP gateway can resolve secrets at spawn time without writing them to disk. The gateway holds the resolved env in memory and passes it when spawning the MCP server subprocess.

### 5.3 Cleanup

- If plaintext is written to disk, there's no automatic cleanup. This is a fundamental limitation of the adapter model — once written to `~/.claude.json`, the user's IDE owns that file.
- The `enc:v1:` encryption provides defense-in-depth for the git repo but does NOT protect the native IDE configs on disk.
- For sensitive environments, recommend users use file-system encryption (FileVault, LUKS) for their home directories.

---

## 6. Bridging MCP Gateway Tools to Secret Backends

### 6.1 The Problem

Some MCP servers expect secrets via mechanisms other than environment variables:
- **stdin**: The server reads credentials from stdin at startup.
- **Config file**: The server reads a JSON/YAML config file with credentials embedded.
- **CLI flag**: `--api-key sk-...` passed as an argument.
- **OAuth token file**: A file at a known path containing a token.

### 6.2 How am Should Handle These

**For stdin-based secrets:**
am cannot pipe a secret through stdin while also using stdin for the MCP JSON-RPC protocol. This is a hard incompatibility. The user must configure the MCP server to use env vars or a config file instead.

**For config-file-based secrets:**
am should support file templating with the secret resolver:

```toml
[servers.my-tool]
command = "my-tool-mcp"
args = ["--config", "/tmp/am-my-tool-config.json"]
# am generates /tmp/am-my-tool-config.json before spawning
config_template = """
{
  "api_key": "${MY_TOOL_API_KEY}",
  "endpoint": "https://api.example.com"
}
"""
```

The `config_template` field (or a `config_template_file` pointing to a file in the repo) is processed by `interpolateEnvAsync` and written to a temp file before spawn. The temp file is deleted after the process exits.

**For CLI-flag-based secrets:**
This is already handled by `${VAR}` interpolation in `args`:
```toml
[servers.my-tool]
command = "my-tool-mcp"
args = ["--api-key", "${MY_TOOL_API_KEY}"]
```
At spawn time, `${MY_TOOL_API_KEY}` is resolved to plaintext. The plaintext appears in the process's command line — visible to `ps aux`. This is a known risk. If the MCP server supports reading the key from a file or env var, prefer those.

**Recommendation:** Add a `config_template` field to `ServerSchema` (optional string). At spawn time, if present, process it through the secret resolver, write to a temp file, pass the temp file path as an argument, and clean up after exit. This covers the config-file use case without requiring external templating tools.

---

## 7. Cross-Git-Backend Story

### 7.1 The Core Principle

The indirection abstraction MUST be entirely client-side and platform-agnostic. Secrets are encrypted/indirected BEFORE they touch the git backend. The git backend (GitHub, GitLab, Gitea, Codeberg, bare git) never sees plaintext.

This is am's current design and it is correct. The `enc:v1:` envelope, the `${VAR}` references, and any future `op://` references are resolved on the user's machine (or in the browser for the hosted UI). The git backend stores only ciphertext and references.

### 7.2 Platform-Specific Tricks: Should am Use Them?

**GitHub Actions Secrets API**: GitHub repositories have an Actions secrets API that encrypts secrets to the repo's public key. These secrets are only decryptable by GitHub Actions runners. This would NOT work for am because:
- am needs to decrypt secrets on the user's local machine, not in CI.
- The GitHub Actions encryption key is per-repo and only usable within Actions.

**GitLab CI Variables**: Same limitation — CI-only scope.

**Gitea Secrets**: Gitea has an Actions-like secrets system (similar to GitHub Actions). Same CI-only limitation.

**Conclusion:** Platform-specific secrets APIs are CI-scoped and do not help with am's client-side decryption needs. am should NOT integrate with them.

### 7.3 What Each Git Backend Does Provide

The git backend provides:
1. **Storage** for ciphertext and references (transparent across all backends).
2. **Access control** for the repo itself (who can see the ciphertext).
3. **Audit trail** via commit history.

For all supported backends, am's indirection is identical: commit `${TAVILY_API_KEY}` in TOML; store the encrypted value in am's secret store (age envelope, keychain, 1Password, etc.); resolve at spawn time. No backend-specific code paths needed for secret indirection.

### 7.4 One Exception: the Hosted UI

For the hosted UI (Cloudflare Worker), the browser must decrypt secrets. The Worker proxies git but never sees plaintext. The browser resolves secrets using:
- Age identity (unlocked via passphrase, cached as passkey in IndexedDB).
- 1Password CLI via `op://` (if the user has the 1Password browser extension).
- `env://` (if the user has environment variables set on their machine, which the browser can't access — so `env://` is CLI-only).

This is consistent across all git backends because the resolution happens in the browser, not in the git backend.

---

## 8. Interaction with the Config-Format Adapters

### 8.1 The 13 IDE Adapters

am has adapters for: claude-code, codex-cli, cursor, windsurf, copilot, gemini-cli, cline, roo-code, continue, kilo-code, amazon-q, kiro, forgecode.

Each adapter's `export()` method receives a `ResolvedConfig` with resolved env vars (post-`interpolateEnvAsync`). The adapter writes native config files.

### 8.2 Current Behavior: Plaintext Emission

All adapters currently emit plaintext env vars. For example, the Claude Code adapter writes:
```json
{
  "mcpServers": {
    "tavily": {
      "command": "tavily-mcp",
      "env": { "TAVILY_API_KEY": "tvly-sk-abc123..." }
    }
  }
}
```

This means API keys are stored in plaintext in `~/.claude.json`, `.mcp.json`, Cursor's config, etc.

### 8.3 The `${VAR}` Question for Adapters

Should adapters emit `${VAR}` for the IDE's env to resolve, or emit resolved plaintext?

**Common practice in the ecosystem:**
- Claude Code's `.mcp.json` supports `envFile` which loads a `.env` file. It also resolves `${VAR}` in env values from `process.env` at MCP server spawn time (see github.com/anthropics/claude-code/issues/28942).
- Cursor's `.cursor/mcp.json` similarly supports env vars to be resolved at spawn time.
- Most IDEs that support MCP use the same `.mcp.json` format or a close variant.

**This means:** For IDEs that support it, am can emit `${VAR}` references in the native config, and the IDE will resolve them from the shell environment at spawn time. For IDEs that don't, am must emit resolved plaintext.

### 8.4 Recommended Strategy

Each adapter should declare a capability: `"envRefResolution"` (boolean).
- If `true`: the adapter's `export()` emits `${VAR}` references. The IDE resolves them at spawn time. This is more secure (plaintext never touches the IDE config file).
- If `false`: the adapter's `export()` receives resolved plaintext from `ResolvedConfig` and writes it. Current behavior.

Implementation:
```typescript
export interface AdapterMeta {
  name: string;
  displayName: string;
  version: string;
  capabilities: Capability[];
  supportsEnvRefResolution?: boolean; // NEW: can the IDE resolve ${VAR} at spawn time?
}
```

Adapters that support it (Claude Code, Cursor, Windsurf — those using `.mcp.json` with `envFile` or `${VAR}` resolution) get `envRefResolution: true`. At apply time, am skips eager resolution for those adapters and emits `${VAR}` references instead.

This reduces the plaintext-on-disk surface by ~50% (Claude Code and Cursor are the most-used adapters).

---

## KEY RECOMMENDATIONS FOR AM

1. **Keep `${VAR}` as the canonical indirection syntax.** It is the most widely understood pattern in the Unix ecosystem and is already implemented in `interpolateEnv`. Do NOT replace it with a URI-scheme-based syntax. Instead, EXTEND it to support URI references as values within the `${VAR}` framework.

2. **Support `op://` references as a first-class backend.** Implement an `op://` resolver that shells out to the `op` CLI. This serves the large 1Password user base and aligns with the ecosystem direction (Claude Code considering native `op://` support). The `op://` value appears inside a `${VAR}`: `env = { TAVILY_API_KEY = "op://Personal/Tavily/credential" }`. am recognizes the `op://` prefix at resolution time.

3. **Add per-server `[servers.<name>.secrets]` override block.** Allow `backend = "1password"` or `backend = "env"` at the server level. Precedence: inline URI > per-server > `AM_SECRETS_BACKEND` env var > `settings.secrets.backend` > `aes-gcm-legacy`. This enables mixed-backend setups (e.g., personal API keys in 1Password, work keys in age).

4. **Defer Vault, KMS, and sops backends to post-MVP.** They are important for enterprise adoption but add significant complexity. The `SecretsBackend` interface is designed to accommodate them. Ship age + 1Password + env + keychain as the MVP backends. Vault and KMS can be added as community contributions or enterprise-tier features.

5. **Add `config_template` field to `ServerSchema`.** This enables file-based secret injection for MCP servers that read credentials from config files rather than env vars. Process the template through the secret resolver, write to a temp file, pass path as arg, clean up after process exit.

6. **Add `supportsEnvRefResolution` capability to the Adapter meta.** For IDEs that can resolve `${VAR}` at MCP server spawn time (Claude Code, Cursor), emit unresolved references instead of plaintext. This eliminates plaintext secrets from `~/.claude.json` and `.cursor/mcp.json` — the most impactful security improvement with the least code change.

7. **Keep the indirection layer entirely client-side and git-backend-agnostic.** Do NOT integrate with GitHub Actions secrets, GitLab CI variables, or Gitea secrets APIs. These are CI-scoped and provide no benefit for client-side decryption. The git backend's sole role is storing ciphertext; all resolution happens on the user's machine or in the browser.

8. **Resolution timing: eager by default, lazy opt-in.** At `am apply` time, resolve secrets eagerly for adapters without `envRefResolution`. For adapters with it, emit `${VAR}` for lazy IDE-side resolution. When spawning MCP servers directly (via am's gateway), always resolve in-memory at spawn time; never write plaintext to disk in this path.
