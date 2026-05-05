# agent-manager — Current Architecture Survey

**Date:** 2026-05-05 · **Scope:** inventory of IDE adapters, git-platform adapters, secret architecture, web/TUI auth, relevant ADRs. No recommendations.

Paths relative to repo root `/mnt/e/CS/github/agent-manager/`.

---

## 1. IDE adapters (13)

Under `src/adapters/<name>/`, all implement `Adapter` in `src/adapters/types.ts` (`detect | import | export | diff`, optional `sessionReader`, `scanMarketplace`). Lazy factory registry: `src/adapters/registry.ts` (ADR-0011). None encrypt values locally — `applyResolved` (`src/core/controller.ts:194`) hands them fully decrypted plaintext via `interpolateEnvAsync`.

| Adapter | Format(s) | Global path | Project path | Capabilities | SessionReader | Dest. secret handling |
|---|---|---|---|---|---|---|
| `claude-code` | JSON + MD | `~/.claude.json` | `.mcp.json`, `CLAUDE.md` (am:begin/end) | mcp, instr, perms, models, skills, plugins, agents, hooks, marketplace | ✅ `~/.claude/projects/<enc>/*.jsonl` | plaintext `env` |
| `codex-cli` | TOML + MD | `~/.codex/config.toml`, `AGENTS.md` | `.codex/config.toml` | mcp, instr, perms, agents | ✅ `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | plaintext TOML `env` |
| `cursor` | JSON + MDC + MD | `~/.cursor/mcp.json` | `.cursor/mcp.json`, `.cursor/rules/*.mdc`, `.cursor/agents/*.md` | mcp, instr, agents, marketplace | ❌ | plaintext |
| `copilot` | JSON + MD | VS Code user-scope `mcp.json` (via `src/adapters/vscode/paths.ts`, only if pre-existing) | `.vscode/mcp.json` (**`servers` key**, not `mcpServers`), `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` | mcp, instr, marketplace | ❌ | plaintext; VS Code `${input:…}` not used |
| `windsurf` | JSON + MD | `~/.codeium/windsurf/mcp_config.json` | `.windsurf/rules/*.md`, `AGENTS.md` (2.0.44+) | mcp, instr, skills, marketplace | ❌ | plaintext |
| `forgecode` | JSON + MD | — | `.mcp.json` (Claude-compatible), `AGENTS.md` | mcp, instr, skills, models | ❌ | plaintext |
| `kilo-code` | JSONC + MD | `~/.config/kilo/kilo.jsonc` + VS Code ext `mcp_settings.json` | project `kilo.jsonc`, `AGENTS.md` | mcp, instr, skills, modes | ❌ | plaintext |
| `kiro` | JSON + MD | `~/.kiro/settings/mcp.json` | `.kiro/settings/mcp.json`, `.kiro/steering/*.md`, `.kiro/agents/*.json` | mcp, instr, skills, agents, marketplace | ❌ | plaintext |
| `gemini-cli` | JSON + MD | `~/.gemini/settings.json`, `GEMINI.md` | `.gemini/settings.json` | mcp, instr | ❌ | plaintext |
| `cline` | JSON + MD | VS Code globalStorage `settings/cline_mcp_settings.json` | `.clinerules/*.md` | mcp, instr | ❌ | plaintext |
| `roo-code` | JSON + MD | VS Code globalStorage `settings/mcp_settings.json` | `.roo/mcp.json`, `.roo/rules/*.md` | mcp, instr, modes | ❌ | plaintext |
| `amazon-q` | JSON + MD | `~/.aws/amazonq/mcp.json` | `.amazonq/rules/*.md` | mcp, instr | ❌ | plaintext |
| `continue` | YAML (+JSON legacy) + MD | `~/.continue/config.yaml` (fallback `config.json`) | `.continue/rules/*.md` | mcp, instr | ❌ | plaintext |

**SessionReader coverage: 2/13** (claude-code, codex-cli). Wiki harvest (ADR-0016/0020) has no read side for the other 11.

**Shared infra:** `src/adapters/vscode/paths.ts` (VS Code variant paths), `src/adapters/shared/marketplace-vscode.ts` (VS-Code-family marketplace scanner: copilot/cursor/kiro/windsurf), `src/adapters/kilo-code/jsonc.ts`. No adapter emits native `${VAR}`/`${{secrets.*}}` substitution — `${VAR}` is fully expanded before `export`.

---

## 2. Git platform adapters (3)

`src/platforms/`. Interface `GitPlatformAdapter` in `types.ts`. Registry `registry.ts` = `[github, gitlab, bare]` ordered by specificity; `detectPlatform(url)` returns first match; bare = `() => true` fallback.

| Adapter | File | Detection | Operations | Auth | Transport |
|---|---|---|---|---|---|
| GitHub | `platforms/github.ts` | `url.includes("github.com")` | `login`, `isAuthenticated`, `storeKey` (→ `gh secret set AM_ENCRYPTION_KEY`), **`retrieveKey` returns `null` (API write-only)**, `createRepo` | Shells out to `gh` CLI; no in-adapter PAT/OAuth. | Platform ops = `gh` subprocess. Clone/push/pull = generic `src/core/git.ts` (isomorphic-git). |
| GitLab | `platforms/gitlab.ts` | `url.includes("gitlab")` | `login`, `isAuthenticated`, `storeKey` (→ `glab variable set`), **`retrieveKey` works** (`glab variable get`), `createRepo` | Shells out to `glab` CLI. | Same split — `glab` for platform, isomorphic-git for git. |
| bare | `platforms/bare.ts` | `() => true` | `meta` + `detect` only. No login/createRepo/key store. | None; SSH agent or URL creds handled by isomorphic-git. | isomorphic-git only. |

Git I/O (`src/core/git.ts`) is **platform-agnostic** via isomorphic-git. Platform adapters only wrap: identity probe, key distribution for CI, repo create. The Worker's REST provider abstraction is disjoint — see §4.3.

---

## 3. Secret architecture

### 3.1 At-rest (ADR-0012, `src/core/secrets.ts`)
AES-256-GCM via Web Crypto; no external binary. 12-byte random IV per `encryptValue`. Wire format: `enc:v1:<iv_b64>:<ciphertext_b64>` (auth tag embedded in ciphertext). Value-level — TOML structure stays readable. `decryptValue` passes non-`enc:v1:` through.

### 3.2 Master key (`resolveKeyPath`, `secrets.ts:30`)
Lives **outside** the git-tracked config dir so `commitAll` can't stage it. Mode `0600`, atomic writes.

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/agent-manager/key` |
| Linux | `$XDG_DATA_HOME/agent-manager/key` (default `~/.local/share/agent-manager/key`) |
| Windows | `%APPDATA%/agent-manager/key` |
| Any | `AM_KEY_PATH` env override |

**Load priority** (`loadKey`): `AM_ENCRYPTION_KEY` env → OS-data-dir file → legacy `<configDir>/.agent-manager/key.txt` (auto-migrated on first access; conflict = new wins + stderr warning).

### 3.3 Apply-time pipeline (`controller.ts::applyResolved`)
`loadResolvedConfig` → `loadKey` → **`interpolateEnvAsync`** (deep walk: `${VAR}` from `extraEnv`∪`process.env`, `$${VAR}` escapes; then `decryptValue` on every `enc:v1:` string) → **`scanServersForUrlCredentials`** (`src/core/url-credentials.ts`) refuses apply if any URL holds `user:pass@host` → per-adapter `export(resolved)` writes **plaintext** to native files.

SECURITY.md §“Plaintext in downstream config files” (L88-113): encryption boundary = `config.toml` only. URL-cred guard is the sole structural leak check; env-var/header/CLI-token leaks land plaintext by design. ADR-0041 deleted per-adapter Zod Phase-2, so adapter extras are unvalidated pass-through.

### 3.4 Detection (ADR-0023, `src/core/secret-detection.ts`)

| Tier | What | Runs | Dep |
|---|---|---|---|
| 1 key-name | Regex vs env-var *key name* (~35 patterns: `api_key`, `token`, `secret`, plus vendors: openai, anthropic, github, stripe, supabase, pinecone, redis/mongo URIs…). Match → value is secret. | Always, zero-dep (`scanServerEnvVars`). | none |
| 2 BetterLeaks | Shell-out to `betterleaks` binary (`src/core/betterleaks.ts`) for inline secrets in `command`, `args`, and env values Tier 1 missed. 200+ rules, BPE tokenization, CEL validation. | If binary available; `null` otherwise. | optional external |

Auto-substitution (`substituteSecret`): rewrites offending value to `${VAR}` and stores plaintext encrypted at `config.settings.env.<VAR>`. Wired in `POST /api/servers` and `POST /api/import/:adapter` (`src/web/server.ts:261,388`).

### 3.5 Not currently solved
- **Multi-machine key sync:** manual (password manager / env var / `gh secret set` — but GitHub API is write-only; only GitLab `retrieveKey` round-trips).
- **Web-UI (CF Worker) decryption:** Worker has no key and does not import `src/core/*` (ADR-0015/0031a). Ciphertext round-trips as-is; UI cannot show plaintext. Local server redacts `enc:v1:` as `"[encrypted]"` on `GET /api/config`.
- **Secrets outside `env`:** Tier 1 keys on env *names*. Values in `args[]` / `command` rely on optional Tier 2. Apply-time guard only catches URL `user:pass@host`.
- **Key rotation:** no in-place command; SECURITY.md L115-125 is manual `get→delete→generate→set`.
- **Per-user / team asymmetric:** symmetric only. ADR-0012 flags age/Phase-2 as future.
- **Pre-commit / push ciphertext scan:** none in repo.

---

## 4. Web / TUI surfaces

Three editing surfaces, pillar 6 (ADR-0031 + ADR-0031a amendment hard-splitting the Worker).

### 4.1 TUI — `src/tui/index.tsx`
Silvery + React (ADR-0018). All writes → `withConfig(configDir, …)` (controller mutex + auto-commit, ADR-0040). Apply → `applyResolved`. Git via `src/core/git.ts`. **Auth: none** (local process).

### 4.2 Local web — `src/web/server.ts` (`am serve`)
Hono on Bun. Writes & apply go through the same `withConfig` / `applyResolved` substrate. `GET /api/config` runs `redactSecrets` replacing every `enc:v1:` string with `"[encrypted]"` (`server.ts:93`).

**Auth (token, localhost-only):**
- Token file `<configDir>/web-token.txt`, mode `0600`, 32-byte random hex (`ensureAuthToken`).
- `am serve` may pass a session-bound `authToken` via `CreateAppOptions`; fresh URL each run invalidates prior.
- `POST /auth/session` trades `{token}` for cookie `am_session` (`HttpOnly; SameSite=Lax; Path=/`, no `Secure` — localhost HTTP, session-bound).
- Middleware: health + static unauth; `/api/*` needs cookie OR `Authorization: Bearer <token>` (both `timingSafeEqual`). `POST /auth/logout` clears.

`POST /api/servers` and `POST /api/import/:adapter` run Tier 1+2 scan inline, auto-generate key if missing, encrypt offenders into `config.settings.env.<VAR>`, rewrite server to `${VAR}`.

### 4.3 Cloudflare Worker — `src/web/worker.ts`
Hono on CF Workers. **Fully stateless** — no KV/D1/R2 (ADR-0015, ADR-0025). State = encrypted cookies only. **Does NOT import `src/core/*`.** Reads/writes `config.toml` via per-provider REST (`fileUrl`, `fileMetaUrl`, `updateFileUrl` in `src/web/git-providers.ts`). Cannot run `applyResolved`, cannot write native IDE files.

**Auth — OAuth per provider (ADR-0025):**
- Providers (`git-providers.ts`): `github`, `gitlab` (hardcoded), `codeberg` (Gitea-compatible), self-hosted `gitea` registered lazily from `GITEA_URL`/`GITEA_CLIENT_ID`/`GITEA_CLIENT_SECRET` bindings.
- `GET /auth/:provider/login` → redirect to `provider.authUrl(…)`; CSRF `state` in 5-min `am_oauth_state` encrypted cookie.
- `GET /auth/:provider/callback` verifies state, exchanges code, stores access token in `am_session` cookie (AES-GCM, HKDF-derived from `SESSION_SECRET` binding; `Secure; HttpOnly; SameSite=Lax; Max-Age=86400`).
- `/api/*` middleware decrypts cookie, attaches `{token, provider}`; `/api/repos`, `/api/config/:o/:r`, `/api/servers/:o/:r`, `POST /api/config/:o/:r` fan out to provider REST.
- **No PAT input, no anonymous access, no server-side sessions.**

Worker has no master AES key and no decryption path. `enc:v1:…` strings round-trip untouched — UI today cannot display plaintext.

### 4.4 Controller — `src/core/controller.ts`
Shared substrate for TUI, local web, MCP `am_apply`, all CLI (ADR-0040, ADR-0031a). Two entry points:
- `withConfig<T>(configDir, fn)` — AsyncMutex-serialized load→mutate→optional auto-commit.
- `applyResolved(configDir, opts)` — mutex-serialized load → `interpolateEnvAsync` → `buildResolvedConfig` → per-adapter `export`.

---

## 5. ADR map

Primary (hosted-UX + secrets): **0012** AES-GCM encryption · **0013** Git platform adapters · **0015** Stateless Web UI · **0023** Tiered secret detection · **0025** Worker multi-backend OAuth · **0031 / 0031a** Pillars + pillar-6 amendment (Worker hard-split from `src/core/*`) · **0040** Controller + AsyncMutex · **0041** Adapter extras untyped.

Contextual: 0001 layered core · 0002 git-backed · 0003 hierarchical config · 0005 bidirectional adapters · 0006 drift detection · 0011 built-in adapters · 0016 session harvest (only 2/13 readers) · 0019 security hardening · 0028 brownfield import · 0037 `x-am.*` metadata · 0039 marketplace retired for MCP Registry + git-subtree.

---

## 6. File-path index

```
src/core/secrets.ts             # AES-GCM, key paths, migration, interpolateEnvAsync
src/core/secret-detection.ts    # Tier 1 patterns + BetterLeaks merge
src/core/betterleaks.ts         # Tier 2 shell-out
src/core/controller.ts          # withConfig / applyResolved (single local write path)
src/core/url-credentials.ts     # apply-time URL creds guard
src/core/config.ts              # TOML, layered merge
src/core/git.ts                 # isomorphic-git
src/adapters/types.ts           # Adapter, ResolvedConfig
src/adapters/registry.ts        # 13 lazy factories
src/adapters/<name>/index.ts    # per-adapter meta + wiring
src/adapters/<name>/export.ts   # per-adapter plaintext write path
src/adapters/{claude-code,codex-cli}/session.ts   # only 2 readers
src/platforms/types.ts          # GitPlatformAdapter
src/platforms/{github,gitlab,bare}.ts
src/platforms/registry.ts       # detectPlatform(url)
src/web/server.ts               # local Hono, bearer+cookie auth
src/web/worker.ts               # CF Worker, OAuth, stateless
src/web/git-providers.ts        # GitHub / GitLab / Codeberg / self-hosted Gitea REST
src/tui/index.tsx               # TUI, routes writes through controller
ADRs/0012, 0013, 0015, 0023, 0025, 0031, 0031a, 0040, 0041
SECURITY.md                     # plaintext-downstream, rotation, threat model
AGENTS.md                       # repo overview (pillars, directory map)
```
