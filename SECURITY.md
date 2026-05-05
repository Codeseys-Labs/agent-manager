# Security

agent-manager is a local, single-user tool that stores AI tool configuration
(including encrypted secrets) in a git-backed directory. This document explains
the secrets storage model and its trust boundaries.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository or email the
maintainers directly rather than filing a public issue.

## Secrets: encryption at rest

Every value written via `am secret set` (and auto-encrypted values from
`am secret scan --fix` / `am add` / `am import`) is encrypted with **AES-256-GCM**
and stored as `enc:v1:<nonce_b64>:<ciphertext_b64>` in `config.toml`.

- Algorithm: AES-GCM, 256-bit key
- Nonce: 12 bytes, `crypto.getRandomValues` per encrypt
- Key format: raw 256-bit key, base64-encoded, stored in a single file
- Passphrase/KDF: not yet (tracked as a future hardening)

## Master key location

The AES master key is stored **outside** the agent-manager config directory
specifically because `config.toml`, `.gitignore`, and every other file in the
config dir is version-controlled and may be pushed to a user-owned git remote
(`am sync push`). Storing the key inside the config dir risked committing it
alongside the ciphertext it protects.

The key path is resolved by `resolveKeyPath()` in `src/core/secrets.ts`:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/agent-manager/key` |
| Linux | `$XDG_DATA_HOME/agent-manager/key` (default `~/.local/share/agent-manager/key`) |
| Windows | `%APPDATA%/agent-manager/key` |
| Override | `AM_KEY_PATH=/absolute/path` (takes precedence on every platform) |

The file is always written with mode `0600`. `saveKey` creates parent
directories as needed.

### Loading priority

`loadKey(configDir)` tries, in order:

1. `AM_ENCRYPTION_KEY` environment variable (base64).
2. Auto-migration of any legacy `configDir/.agent-manager/key.txt` into the
   OS data-dir path.
3. The OS data-dir path returned by `resolveKeyPath()`.

If none of those yield a key, `loadKey` returns `null` and `am secret`
operations tell the user to run `am secret generate-key`.

### Migration

On first `loadKey` call after upgrading:

- If `configDir/.agent-manager/key.txt` exists and the new path does not,
  the legacy file is moved to the new path (mode `0600`) and deleted.
  A one-line info message is printed to stderr.
- If **both** exist, the new path is used and the user is warned about the
  legacy file. This situation is only possible via manual copy or a
  downgraded install; the tool will never re-create the legacy file.

### Safety nets

- `src/core/git.ts` initializes every config dir with a `.gitignore` that
  excludes legacy key paths (`.agent-manager/key.txt`, `.agent-manager/key*`,
  `**/key.txt`). This protects users who restore an older setup or receive
  a config dir from another machine.
- `am doctor` reports the resolved key path, whether the key is present, and
  prints a high-visibility warning if a legacy key file is found inside the
  git-tracked config dir (indicating the user should delete it and rotate).
- `am mcp-serve` reports the same checks via the `am_doctor` MCP tool.

## Things this does NOT protect against

- An attacker with read access to the user account on the machine can read
  the key and decrypt all secrets. The key is unwrapped and not passphrase-
  protected.
- A hostile adapter or marketplace package registered by the user runs under
  the user's full privileges (see `docs/reviews/2026-04-16-multi-agent-deep-analysis/07-security.md`
  for the broader threat model).
- `am mcp-serve` write-tier tools require a bearer token (`AM_MCP_TOKEN`) or
  explicit `AM_MCP_ALLOW_UNSAFE_LOCAL=1`, but read-only tools remain open.

## Plaintext in downstream config files

`am`'s value-prop is generating native config files for ~13 IDEs from one
encrypted source of truth. At `am apply` time, secrets are necessarily
**decrypted** — `src/core/secrets.ts::interpolateEnvAsync` resolves
`${VAR}` and `enc:v1:` ciphertext into plaintext, then
`src/core/controller.ts::applyResolved` writes the result to native
files: `~/.claude.json`, `~/.codex/*`, `~/.config/Continue/*`, etc.
Those files are **plaintext on disk**. This is unavoidable; the IDE
itself reads them.

The encryption boundary is `config.toml` (the canonical store), NOT the
downstream files. Treat the downstream files as you would any plaintext
secret material:

- Do not commit them to git. Most IDE configs are already in your global
  `.gitignore`; verify before adding new tools.
- Do not sync them to a non-encrypted backup.
- Be aware that `git status` outside the `am` config repo may show them
  as untracked changes if they live inside a project.

The only `am`-side guard against accidental leakage is
`scanServersForUrlCredentials` in `src/core/url-credentials.ts`, which
refuses to write servers whose URL fields embed credentials (e.g.
`https://user:pass@host`). Other plaintext leak paths — env vars,
header secrets, command-line tokens — are written as-is, by design.

## Rotating the key

There is no in-place rotation command yet. The safe procedure is:

1. `am secret get` each secret and note the plaintext values.
2. Delete the key file at the path reported by `am doctor`.
3. `am secret generate-key` to create a fresh key.
4. `am secret set` each secret with the plaintext values from step 1.

Any committed ciphertext encrypted with the old key becomes undecryptable
after step 2, so step 1 must happen first.

## What to do if a key was committed

If you find that an older key file was committed to a remote:

1. **Assume every encrypted value in the history is compromised.** Rotate
   every upstream credential (API keys, tokens, etc.) at the source.
2. Delete the key file from the working tree and commit the removal.
3. Purge the file from git history (BFG Repo-Cleaner or `git filter-repo`)
   and force-push. Notify anyone with a clone that they need to re-clone.
4. Run `am secret generate-key` to create a fresh key and re-encrypt your
   secrets with the rotated credentials.
