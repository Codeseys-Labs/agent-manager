# Wave Q — ADR-0048 Phase-1 GitHub App OAuth Scaffold

**Status:** ready-to-execute (plan only; no code in this doc)
**Source ADRs:** [0048](../../ADRs/0048-hosted-ui-auth-implementation.md), [0043](../../ADRs/0043-hosted-ui-auth-and-git-backend-tiers.md), [0015](../../ADRs/0015-stateless-web-ui.md)
**Source research:** [Lens F](../research/2026-05-05-deep-loop/lens-F-adr-0043-deep.md)
**Estimated total:** 5 sub-tasks, ~2200 LOC, ~$8-12 OpenRouter cost at 3-way parallel

## Goal

Ship a working GitHub App OAuth flow on the Cloudflare Workers stateless web UI that authenticates the user against a single repository, mints installation tokens per request, and persists session state in a sealed encrypted cookie. No GitLab. No Codeberg/Forgejo. No browser secret-decryption. No editor.

After Wave Q, the user can:
1. Visit the hosted Worker URL.
2. Click "Sign in with GitHub" → GitHub OAuth consent → return.
3. See a list of files in their authorized repository.
4. Browser uses the sealed cookie for subsequent reads.
5. The Worker mints a fresh installation token on each git API call.

## Non-goals

- GitLab.com OAuth (Wave Q+1, separate plan)
- Codeberg / Gitea / Forgejo (Wave Q+2, deferred)
- Browser-side secret decryption (Wave S, blocks on this Wave Q for hosted UI bundle)
- CodeMirror editor (Wave R, blocks on this Wave Q for the route mount)
- Push capability — Phase-1 is read-only; write capability is Phase-2 within ADR-0048.
- Multi-installation accounts — Phase-1 scopes the cookie to ONE installation_id.

## Acceptance criteria (test-first, executable)

Each test names the file + describe + it. All must pass to call Wave Q done.

1. `test/web/auth/sealed-cookie.test.ts` `describe("sealedCookie")`:
   - `it("seal then unseal roundtrips a payload")`
   - `it("unseal returns null on tampered ciphertext")`
   - `it("unseal returns null on expired payload")`
   - `it("unseal accepts both old kid and new kid (rotation)")`
   - `it("seal output fits within 4 KB Cloudflare cookie cap")`

2. `test/web/auth/pkce.test.ts` `describe("pkce")`:
   - `it("generates verifier + challenge per RFC 7636")`
   - `it("state cookie carries verifier + nonce; mismatched state rejected")`

3. `test/web/auth/github-app.test.ts` `describe("githubApp")`:
   - `it("mints installation token via JWT-signed POST")` (mocks GitHub API)
   - `it("refreshes token when within 5 min of expiry")`
   - `it("treats 401 from GitHub as transient, retries once")`

4. `test/web/auth/login-flow.test.ts` `describe("login flow")`:
   - `it("GET /auth/github/login redirects to GitHub OAuth with state cookie")`
   - `it("GET /auth/github/callback rejects when state cookie mismatch")`
   - `it("GET /auth/github/callback exchanges code, sets sealed session cookie")`
   - `it("GET /auth/logout clears the cookie + redirects home")`

5. `test/web/api/files.test.ts` `describe("files API")`:
   - `it("GET /api/files/:path returns 401 without session cookie")`
   - `it("GET /api/files/:path with valid cookie returns repo file content")`
   - `it("rejects path-traversal payloads (../../etc/passwd)")`

Total: 14 acceptance tests across 5 test files.

## File-ownership map

Five sub-tasks, parallelizable. Q1 has no deps; Q2-Q5 depend on Q1's `sealedCookie` API existing. Run Q1 alone first, then Q2-Q5 in parallel.

### Q1 — Crypto + sealed cookie utilities (~430 LOC, no deps)

**Owns:**
- `src/web/auth/sealed-cookie.ts` (NEW, ~150 LOC)
  - `seal(payload, key, kid): string` — AES-GCM via WebCrypto, base64url output, envelope `{v, kid, iv, ct}`
  - `unseal(cookie, keys: Record<kid, key>): payload | null` — tries each kid, fails closed on tamper / expiry
  - Payload schema: `{ provider: "github", installation_id, repo, expires_at, kid }`
  - 4 KB size guard: throws if ciphertext > 3800 chars
- `src/web/auth/cookie-keys.ts` (NEW, ~80 LOC)
  - Loads signing keys from worker env (`SESSION_KEY_OLD`, `SESSION_KEY_NEW`)
  - Derives an AES-GCM `CryptoKey` from each via `importKey(raw, "AES-GCM")`
  - Returns `{ keys: { kid → CryptoKey }, primaryKid }`
- `test/web/auth/sealed-cookie.test.ts` (NEW, ~200 LOC) — 5 tests above

**Uses:** WebCrypto only (no npm deps). Compatible with CF Workers + Bun test runtime.

### Q2 — PKCE + state cookie (~280 LOC, deps: Q1)

**Owns:**
- `src/web/auth/pkce.ts` (NEW, ~120 LOC)
  - `generateVerifier(): string` — 43-128 char URL-safe random
  - `challengeFor(verifier): string` — base64url(SHA-256(verifier))
  - `buildAuthorizeUrl({ clientId, redirectUri, scope, state, codeChallenge })`
- `src/web/auth/state-cookie.ts` (NEW, ~80 LOC)
  - Short-lived sealed cookie for `verifier + nonce` (10 min TTL)
  - SameSite=Lax (per Lens F): Strict drops on cross-site OAuth callback
- `test/web/auth/pkce.test.ts` (NEW, ~80 LOC) — 2 tests above

### Q3 — GitHub App token minting (~480 LOC, deps: Q1)

**Owns:**
- `src/web/auth/github-app.ts` (NEW, ~280 LOC)
  - `signAppJwt(appId, privateKey): string` — RS256 via WebCrypto subtle
  - `getInstallationToken(appJwt, installationId): { token, expires_at }`
  - `getRepoFileContent(token, owner, repo, path): { content, sha }`
  - 5-minute pre-expiry refresh window
  - 401 retry logic (single retry; surfaces on second 401)
- `src/web/auth/github-types.ts` (NEW, ~60 LOC) — Zod schemas for GitHub API responses
- `test/web/auth/github-app.test.ts` (NEW, ~140 LOC) — 3 tests above; uses `globalThis.fetch` mock

### Q4 — Login flow handlers (~480 LOC, deps: Q1 + Q2 + Q3)

**Owns:**
- `src/web/routes/auth/github-login.ts` (NEW, ~80 LOC) — `GET /auth/github/login`
- `src/web/routes/auth/github-callback.ts` (NEW, ~150 LOC) — `GET /auth/github/callback`
  - Validates state cookie; rejects on mismatch
  - Exchanges code+verifier for OAuth token (then trades for installation token)
  - Sets sealed session cookie; redirects to `/`
- `src/web/routes/auth/logout.ts` (NEW, ~30 LOC) — `GET /auth/logout`
- Wire into `src/web/server.ts` and `src/web/worker.ts` Hono routers (~30 LOC across both).
- `test/web/auth/login-flow.test.ts` (NEW, ~190 LOC) — 4 tests above; uses Miniflare or Hono test client

### Q5 — Files API (~360 LOC, deps: Q1 + Q3)

**Owns:**
- `src/web/middleware/auth.ts` (NEW, ~80 LOC) — Hono middleware: read sealed cookie, populate `c.var.session`, return 401 on missing/invalid
- `src/web/routes/api/files.ts` (NEW, ~120 LOC) — `GET /api/files/:path*` reads via session.installation_id
  - Path-traversal guard
  - Calls Q3's `getRepoFileContent`
- `test/web/api/files.test.ts` (NEW, ~160 LOC) — 3 tests above

## Risks + rollback

| Risk | Likelihood | Impact | Mitigation / rollback |
|------|------------|--------|-----------------------|
| Cookie key rotation drops sessions | Med | All users re-login | Q1 supports dual-kid decrypt; document key-rotation runbook in Q4 |
| Refresh-token race in stateless Worker | Med | User sees intermittent 401 | Q3 retries once on 401; documented as Phase-1 acceptable; Phase-2 adds D1-backed refresh queue |
| GitHub App private key exfiltrated from env | Low | Critical | Worker env secrets only; no logging of key material; document key-rotation runbook |
| 4 KB cookie cap exceeded | Low | Cookie rejected by CF | Q1 size-guard throws at seal-time; tests exercise payload at boundary |
| GitHub OAuth callback `SameSite=Strict` drops state cookie | High at first | Login flow broken | Q2 uses `SameSite=Lax` for state cookie (10-min lifetime); session cookie is `Strict` |

**Rollback plan:** Single git revert of the Wave Q merge commit. No DB migrations. Existing Worker deployments without Wave Q routes continue to function (404s on `/auth/*`).

## Budget estimate

- Total LOC: ~2030 (impl) + ~770 (tests) = ~2800 LOC
- Estimated subagent cost: 5 sub-tasks × ~$1.5-2 each = ~$8-10 in OpenRouter spend
- Wall-clock at 3-way parallel: Q1 alone (~5min) → Q2/Q3/Q4/Q5 in 2 batches of 2 (4 batches at 600s timeout = ~40min worst case)

## Verification gates (Phase-1 done = ALL green)

Maps directly to ADR-0048 §Verification gates:

1. ✅ All 14 acceptance tests pass (`bun test test/web/auth/ test/web/api/`).
2. ✅ `bun run lint` clean.
3. ✅ `bun run typecheck 2>&1 | grep -c 'src/web/'` = 0 (no src-side type errors introduced).
4. ✅ Bundle size of `dist/web/worker.js` < 1 MB (CF free-tier limit).
5. ✅ No plaintext token logged in any worker log path (manual audit + grep test).
6. ✅ E2E manual verification: deploy to a staging Worker, complete login flow, fetch a file via UI.
7. ✅ Documentation: `docs/auth-setup.md` describes how to register a GitHub App for am self-hosters.

## Sequencing

```
Round 1 (sequential, 1 subagent): Q1 (crypto + sealed cookie)
Round 2 (parallel, 4 subagents):  Q2, Q3, Q4, Q5
                                  (Q4 depends on Q2+Q3 but can be authored
                                   in parallel using stub interfaces;
                                   integration test in Q4 runs last)
Round 3 (sequential, 1 subagent): Phase-8 cross-family review (3 reviewers)
Round 4 (sequential, 1 subagent): Documentation + final commit
```

Total: 4 subagent rounds, ~$10-12 cost, ~2-3 hours wall-clock at 3-way parallel.

## How to execute

In a future deep-work-loop run, invoke:

```
delegate_task(tasks=[
  { goal: "Wave Q sub-task Q1: sealed-cookie + crypto utilities",
    context: "<this plan + ADR-0048 + Lens F + acceptance tests for Q1>",
    model: "anthropic/claude-opus-4.7", provider: "openrouter",
    toolsets: ["file", "terminal"] },
])
```

Wait for Q1 to land + commit. Then dispatch Q2-Q5 in parallel.

Phase-8 review prompt template lives in the deep-work-loop skill's `references/PHASES.md`. Each reviewer model from a different family (suggested: anthropic + openai + deepseek).

## What this plan does NOT solve

- The user still needs a registered GitHub App in their org. `docs/auth-setup.md` (Q4 deliverable) walks through registration but doesn't automate it.
- ADR-0050 (browser secret decryption) is a separate Wave S, blocked on this Wave Q completing the bundle pipeline.
- ADR-0049 (CodeMirror editor) is Wave R, similarly blocked on Wave Q.

## When to invoke this plan

User says one of:
- "Start hosted UI"
- "Build the GitHub App OAuth"
- "Wave Q"
- "ADR-0048 Phase-1"

Do NOT execute partially. Either run all 5 sub-tasks to completion or revert the lot — partial Wave Q deployments are insecure (e.g., login route exists but token-mint doesn't, leaving users in a half-authenticated state).
