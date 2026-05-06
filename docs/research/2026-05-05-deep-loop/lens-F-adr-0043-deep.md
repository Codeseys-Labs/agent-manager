# Lens F: ADR-0043 deep implementation research — hosted UI auth OAuth recipes

Date: 2026-05-05
Scope: Cloudflare Worker hosted UI auth for ADR-0043, with exact OAuth/GitHub App recipes, stateless-cookie strategy, provider failure modes, and test plan. This report is research only; no source changes were made.

## Findings

1. ADR-0043's direction is correct, but the phase-1 implementation should be narrower than the full five-tier matrix. The current Worker implementation in `src/web/worker.ts` and `src/web/git-providers.ts` is ADR-0025-era OAuth-App style: `/auth/:provider/login`, `/auth/:provider/callback`, encrypted `am_session`, provider registry, GitHub OAuth App scopes, GitLab `read_repository write_repository`, and Codeberg/Gitea OAuth. ADR-0043 changes the load-bearing abstraction from "OAuth provider" to "repo capability route" and changes GitHub.com to a GitHub App. Phase 1 should therefore implement GitHub App + GitLab.com OAuth2 PKCE first, while keeping Codeberg/Gitea PAT paths behind flags.

2. GitHub App is preferable to GitHub OAuth App for hosted repo editing. GitHub's installation token endpoint returns a token plus `expires_at`, permissions, and repositories; GitHub states installation access tokens expire after 1 hour. The ADR's cookie model should store only `installation_id`, selected owner/repo, tier, and timestamps, then mint an installation token per API request. If user-to-server tokens are later needed, GitHub App expiring user tokens are 8 hours and refresh tokens are 6 months; using a refresh token invalidates the old refresh token and old access token. This is materially different from installation tokens and makes user-token storage less attractive for a stateless Worker. Relevant docs: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app and https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-to-server-access-tokens.

3. GitHub now supports PKCE parameters for OAuth Apps and strongly recommends state. The OAuth App authorization docs list `state` as a strongly recommended unguessable CSRF value, and list `code_challenge`, `code_challenge_method=S256`, and `code_verifier` as strongly recommended. They explicitly say the `code_verifier` can be stored in a cookie alongside state or in a session variable. The same page documents a limit of ten issued tokens per user/application/scope combination and ten tokens created per hour; if an app exceeds ten same-scope tokens, GitHub revokes the oldest tokens, while hourly rate-limit triggers a re-authorization prompt. This makes callback retry loops dangerous. Source: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps.

4. Library consensus for Workers: use provider-specific small code, not `simple-oauth2`; selectively use Octokit auth helpers only where they are proven Worker-compatible. `@octokit/auth-app` already caches GitHub installation tokens with a 59-minute TTL and deduplicates concurrent token requests, according to octokit/auth-app.js issue #724. That issue also notes app-level JWT generation is not cached and private key import may happen repeatedly; in a Worker, caching imported `CryptoKey` and a 9-minute app JWT in module scope is acceptable as an optimization, but correctness must not depend on it because isolates are disposable. The requested DeepWiki repo `octokit/oauth-app.js` was not indexed, so no wiki facts were available for that repo. For generic OAuth client libraries, `simple-oauth2` remains Node-oriented and does not solve GitHub App JWTs, GitLab refresh rotation, or provider API normalization. A 100-line Worker-native helper using Web Crypto, `fetch`, `URLSearchParams`, and typed endpoint descriptors is safer.

5. DeepWiki production example: `cloudflare/workers-oauth-provider` is an OAuth 2.1 provider framework for Workers, not an OAuth client, but its architecture is a useful reference. DeepWiki reports it supports authorization-code, refresh-token, and implicit flows, PKCE validation, KV-backed token/grant records, hashed token storage, and refresh-token rotation with a current and previous token. It leaves `state`/CSRF validation to the application's authorization UI. Exa found the repo active with latest release `v0.5.0` on 2026-05-05, 18 releases, and last push 2026-05-05. The original implementation commit is `cloudflare/workers-oauth-provider@3b2ae809e9256d292079bb15ea9fe49439a0779c` (2025-02-27). Release `v0.2.3` included PR #117 (`b2c5877617809107ea4759b22c4994f0711affe4`) adding `getOAuthApi`, PR #109 (`9f118f36c4f0aba8a56c9179844ca47d5b37387a`) for path-aware audience validation, and PR #120 (`155c4108c781ab767d048b75eae9e9afdb0eb4d9`) for RFC 8693 token exchange. Source: https://github.com/cloudflare/workers-oauth-provider.

6. GitLab.com OAuth2 + PKCE is a direct fit, but use scope `api` for the REST commit path. GitLab docs describe authorization-code with PKCE for public clients and say PKCE permits secure token exchange without access to the client secret, useful for SPAs and client-side apps. GitLab also says `STATE` should be unpredictable and used as a CSRF token. The OAuth provider docs state access tokens expire after 2 hours and integrations must generate new access tokens using `refresh_token`; the expiration setting is not configurable. ADR-0043's warning about `write_repository` remains valid for this UI because the Worker uses REST file/commit APIs, not only Git-over-HTTPS. For atomic writes, use `POST /api/v4/projects/:id/repository/commits` with `actions[]` rather than a per-file update loop. Docs: https://docs.gitlab.com/api/oauth2/, https://docs.gitlab.com/integration/oauth_provider/, https://docs.gitlab.com/api/commits/.

7. Self-hosted GitLab endpoint discovery should be deterministic but conservative. For a user-entered GitLab base URL, first normalize origin, then probe `GET {origin}/-/readiness?all=1` or unauthenticated `GET {origin}/api/v4/version` where available. OAuth endpoints are conventionally `{origin}/oauth/authorize` and `{origin}/oauth/token`; do not rely on OIDC discovery unless `/.well-known/openid-configuration` exists and returns endpoints under the same origin. A hosted public Worker cannot dynamically register with arbitrary GitLab instances unless the user/admin has created an OAuth application and supplied client credentials. Therefore self-hosted GitLab should be a configured provider, not auto-OAuth for every URL.

8. Refresh-token rotation is the main stateless risk. GitHub user-to-server token refresh and modern OAuth providers invalidate the old refresh token when used. GitLab's Doorkeeper-backed provider issues refresh tokens and access tokens with a fixed two-hour access-token lifetime; exact rotation behavior can vary by GitLab version/config, so implement for strict rotation. Cloudflare's `workers-oauth-provider` intentionally allows both current and previous refresh tokens for provider-side fault tolerance, but GitHub's docs do not. With only encrypted cookies, two parallel Worker requests can both refresh the same token; one response may set a valid new cookie and the other may set an invalid or older one. Without a Durable Object or D1 row, the right behavior is optimistic: refresh only when within a skew window, retry once on 401, and if refresh returns invalid_grant, clear session and force re-login.

9. Forgejo/Gitea/Codeberg OAuth is real but not globally federated. Gitea docs and Forgejo latest docs both support confidential and public clients, PKCE public clients, `/login/oauth/authorize`, `/login/oauth/access_token`, `expires_in: 3600`, and refresh tokens. Forgejo's docs include a Codeberg example where an OAuth2 application is created on Codeberg by a normal user and another Forgejo instance configures Codeberg as an OpenID Connect source. That means Codeberg can be a known pre-registered provider for this hosted UI only if agent-manager owns and operates a Codeberg OAuth application. It does not imply arbitrary Forgejo instances can be used without per-instance client registration. Docs: https://docs.gitea.com/development/oauth2-provider and https://forgejo.org/docs/latest/user/oauth2-provider.

10. Stateless encrypted cookies are still the best fit for ADR-0015, but use a Worker-native seal rather than assuming `iron-session` or Hono has landed the exact feature. `iron-session` is a mature stateless, signed/encrypted cookie model and supports password rotation with an object such as `{2: 'new', 1: 'old'}`; however, official Cloudflare Worker compatibility remains something to verify in the exact version. Exa surfaced iron-session v8.0.3 TypeScript/runtime compatibility issues in WorkOS discussions and an open PR #937 for cookie chunking over the 4096-byte browser limit. Hono's issue #4817 proposes AES-256-GCM encrypted cookies via Web Crypto, HKDF, random 12-byte IV, cookie-name AAD, and `__Secure-`/`__Host-` support, but it is an open feature request as of 2026-03-20, not a released Hono API. Therefore implement a tiny local Web Crypto envelope now and consider replacing it later.

11. Cookie and header limits bound the token strategy. Browsers generally limit individual cookies to about 4096 bytes; Cloudflare Workers itself allows 128 KB total request headers and 128 KB total response headers, and its `Headers.append('Set-Cookie', ...)` supports multiple Set-Cookie values. Do not use cookie chunking for OAuth tokens in phase 1: it increases attack surface and request overhead. Keep the session payload small: GitHub App session is tiny; GitLab/Codeberg OAuth sessions fit if only one provider token pair is stored. Never put PATs, repository file content, or per-repo caches in the cookie. Sources: https://developers.cloudflare.com/workers/platform/limits/ and https://developers.cloudflare.com/workers/runtime-apis/headers/.

12. KV, D1, and Durable Objects each solve a different problem, but strict ADR-0015 forbids them for per-user sessions. Cloudflare storage docs say Workers KV is eventually consistent and changes can take up to 60 seconds or more to be visible in other locations; it is good for high-read, low-write configuration/session data that does not need immediate consistency. D1 is managed SQLite with SQL semantics. Durable Objects give global uniqueness and strongly consistent transactional storage for one object ID. For OAuth refresh serialization, Durable Objects are the exact technical fit; for audit/queryable sessions, D1 is better; for allowlists/client configuration, KV is fine. For ADR-0043 phase 1, use none for per-user sessions. Use KV only for non-user config such as provider metadata/allowlists if needed. Sources: https://developers.cloudflare.com/kv/concepts/how-kv-works/ and https://developers.cloudflare.com/workers/platform/storage-options/.

## Concrete recipes

### Recipe A: Worker-native PKCE + state cookie

Use this for GitLab.com, Codeberg OAuth, and any configured OAuth provider. For GitHub OAuth App fallback only, also use it, but phase-1 GitHub should be GitHub App installation flow.

```ts
function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function pkcePair() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const code_verifier = b64url(verifierBytes); // 43 chars
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code_verifier));
  return { code_verifier, code_challenge: b64url(digest), code_challenge_method: 'S256' as const };
}

async function beginOAuth(req: Request, env: Env, provider: OAuthProvider) {
  const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const pkce = await pkcePair();
  const redirect_uri = new URL(`/auth/${provider.id}/callback`, req.url).toString();
  const loginState = await seal({ v: 1, typ: 'oauth-state', state, provider: provider.id,
    redirect_uri, code_verifier: pkce.code_verifier, ts: Date.now() }, env.SESSION_KEYS);
  const url = new URL(provider.authorizeUrl);
  url.search = new URLSearchParams({ response_type: 'code', client_id: provider.clientId,
    redirect_uri, scope: provider.scope, state, code_challenge: pkce.code_challenge,
    code_challenge_method: 'S256' }).toString();
  return new Response(null, { status: 302, headers: {
    Location: url.toString(),
    'Set-Cookie': `__Host-am_oauth_state=${loginState}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300`
  }});
}
```

Callback wire format for GitLab token exchange:

```ts
const body = new URLSearchParams({
  grant_type: 'authorization_code',
  client_id: env.GITLAB_CLIENT_ID,
  code,
  redirect_uri: stateCookie.redirect_uri,
  code_verifier: stateCookie.code_verifier,
});
// Include client_secret only for confidential app registrations.
if (env.GITLAB_CLIENT_SECRET) body.set('client_secret', env.GITLAB_CLIENT_SECRET);
const tokenRes = await fetch(`${gitlabOrigin}/oauth/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body
});
```

Session payload after success:

```json
{
  "v": 1,
  "kid": "2026-05-a",
  "tier": "gitlab-oauth",
  "provider": "gitlab.com",
  "access_token": "...",
  "refresh_token": "...",
  "expires_at": 1770000000000,
  "scope": "api",
  "refresh_nonce": "base64url-128-bit",
  "iat": 1769992800000
}
```

### Recipe B: GitHub App installation token minting in a Worker

Generate a short-lived app JWT using RS256. Use `iat=now-60` and `exp=now+540` to stay inside GitHub's 10-minute JWT max and tolerate clock skew. Then call `POST /app/installations/{installation_id}/access_tokens` with a Bearer JWT. The request body should downscope to repository and permissions where possible.

```ts
async function githubAppJwt(appId: string, pkcs8Pem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })));
  const data = `${header}.${payload}`;
  const der = pemToArrayBuffer(pkcs8Pem); // strip BEGIN/END PRIVATE KEY and base64-decode
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

async function installationToken(env: Env, installationId: number, owner: string, repo: string) {
  const jwt = await githubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'agent-manager' },
    body: JSON.stringify({ repositories: [repo], permissions: { contents: 'write', metadata: 'read' } })
  });
  if (!res.ok) throw new Error(`github_installation_token_failed:${res.status}`);
  return await res.json() as { token: string; expires_at: string };
}
```

Session payload for GitHub App must not contain a GitHub access token:

```json
{"v":1,"tier":"github-app","installation_id":123456,"owner":"octo","repo":"config","iat":1769992800000}
```

### Recipe C: sealed cookie with dual-key rotation

Use `__Host-am_session`; no Domain attribute; `Path=/`; `Secure`; `HttpOnly`; `SameSite=Strict`. Use AES-256-GCM with 12-byte IV and AAD set to the cookie name. Include `kid` in plaintext envelope, not the session body, so the decrypt path can try the named key and then previous keys.

```ts
// cookie value: base64url(JSON.stringify({ v:1, kid, iv, ct }))
// ct = AES-GCM(JSON session, aad='__Host-am_session')
```

Rotation recipe: deploy `SESSION_KEYS='{"2026-06":"new","2026-05":"old"}'`; encrypt new cookies with highest/current kid; decrypt with any listed key; wait max session TTL plus clock skew; remove old key. This avoids global logout. If a secret leaks, rotate immediately and accept forced logout by removing the compromised kid.

### Recipe D: provider write APIs

GitHub App write: `PUT /repos/{owner}/{repo}/contents/{path}` with `message`, base64 `content`, and current `sha`; auth header `Bearer <installation-token>`.

GitLab write: prefer `POST /projects/:id/repository/commits`:

```json
{
  "branch": "main",
  "commit_message": "Update config via agent-manager web UI",
  "actions": [{ "action": "update", "file_path": "config.toml", "content": "..." }]
}
```

Gitea/Forgejo write: `PUT /api/v1/repos/{owner}/{repo}/contents/{filepath}` with `message`, base64 `content`, and `sha`; auth header should be `Authorization: token <pat-or-oauth-token>` for Gitea-compatible APIs unless instance docs require Bearer.

## Risks

1. Refresh races under stateless cookies. This is unavoidable for strict ADR-0015. Mitigation: refresh only near expiry, use a per-cookie `refresh_nonce`, return `Set-Cookie` on every refresh, retry once on upstream 401, and force re-login on `invalid_grant` rather than attempting multi-refresh repair. If product requirements demand smooth multi-tab refresh, ADR-0015 must be amended to allow Durable Object session locks.

2. Cookie oversize. GitLab + Codeberg token pairs can fit today, but future providers may issue large JWT access tokens. Keep one provider session per cookie. Do not include repo lists, profile JSON, or PATs. Treat 3000 bytes as a warning threshold and 3800 bytes as a hard fail with a message to re-auth using server-side session mode if introduced later.

3. GitHub token loops and bad credentials. GitHub REST returns 401 for invalid credentials initially, and after several invalid requests can temporarily reject all auth for that user with 403. GitHub OAuth token creation has ten-token-per-hour and ten-active-token behaviors. Tests must assert that callback exchange is single-shot and that retry loops stop.

4. Key rotation mistakes. If key IDs are not implemented from day one, every secret rotation logs out all users. If old keys are retained forever, compromise window never closes. Implement current+previous only and document the rotation runbook.

5. Self-hosted OAuth overclaim. Gitea, Forgejo, and self-hosted GitLab support OAuth/PKCE, but a public hosted UI cannot assume registration on arbitrary instances. The UI must say "configured OAuth provider" or "paste PAT"; do not show a universal "Login with Forgejo" button for unknown hosts.

6. CORS proxy abuse. Tier 4 is out of phase-1 scope. If later built, block private IPs and metadata IPs, require same-origin authenticated session, restrict methods/headers, rate-limit, and never log Authorization headers.

## Test strategy

Use two layers. First, pure unit tests under Bun for URL routing, cookie seal/unseal, PKCE generation, state validation, and provider request-body construction. Second, Worker-runtime tests using `@cloudflare/vitest-pool-workers` once added. Exa found `@cloudflare/vitest-pool-workers@0.14.0` released 2026-03-31 with `wrangler@4.79.0` and `miniflare@4.20260329.0`; PR #11632 / commit `cloudflare/workers-sdk@a6ddbdb2b67978377dda1acda289fe21eb0892bd` added Vitest 4 support and removed `fetchMock` from `cloudflare:test`, recommending mocking `globalThis.fetch` or MSW. The project currently has `wrangler ^4.14.0`, `@cloudflare/workers-types ^4.20250401.0`, and no Vitest dependency, so adopting Worker tests is a discrete test-infra change.

Required test scenarios:

- OAuth state missing, mismatched, expired, or provider-mismatched returns 403 and clears `am_oauth_state`.
- PKCE challenge is 43-char base64url SHA-256 and callback sends exact `code_verifier`.
- GitLab callback stores `scope: api`, `expires_at = now + expires_in*1000`, and refresh token if returned.
- GitLab refresh success replaces both access and refresh tokens; refresh `invalid_grant` clears session.
- Two simulated concurrent refreshes: one succeeds, one returns invalid_grant; assert the invalid response does not overwrite a newer cookie if `refresh_nonce` differs, or forces re-login cleanly.
- GitHub App JWT has `iss`, `iat`, `exp`, RS256 header, and exp <= 10 minutes; installation-token request uses `Bearer <jwt>`, repository downscope, and `contents:write`/`metadata:read`.
- GitHub App session cookie never contains `ghs_`, `ghu_`, `ghr_`, or installation token strings.
- PAT vs OAuth distinction: PAT entered for Gitea/Tier 3 is never sealed into `am_session`; OAuth token may be sealed only for configured OAuth tiers.
- Provider-down fallback: token endpoint 500 returns a user-visible retry page and does not create a session.
- Revoked app/token: GitHub/GitLab 401 on API read clears or marks auth invalid; no infinite refresh loop.
- Cookie key rotation: old-key cookie decrypts and is re-sealed with current key; removed-key cookie fails closed.
- Cookie size: test warning/fail thresholds with synthetic large token response.

For local end-to-end smoke, use `wrangler dev` with fake provider endpoints served by an auxiliary Worker or MSW. Do not run tests against real GitHub/GitLab OAuth on every CI run; keep a manual nightly/smoke job behind secrets for actual callback registration drift.

## Recommended phase-1 scope

1. Implement a Worker-native session seal with key IDs, Strict `__Host-` cookies, PKCE login-state cookie, and tests. Replace current `SameSite=Lax` with `SameSite=Strict` for auth cookies unless a specific cross-site callback deployment requires otherwise.

2. Implement GitHub App for GitHub.com only: installation callback/selection UX, cookie with `installation_id`, per-request installation token mint, REST read/write contents. Defer GitHub user-to-server tokens.

3. Implement GitLab.com OAuth2 + PKCE with `api` scope, REST file read, and atomic commit API. Include refresh handling and explicit concurrent-refresh tests.

4. Keep Codeberg OAuth as experimental only after a real Codeberg OAuth application is registered and verified. Otherwise use the Gitea-compatible PAT route.

5. Defer arbitrary self-hosted GitLab OAuth, self-hosted Forgejo/Gitea OAuth, Bitbucket, and Tier 4 CORS proxy until phase 2. For self-hosted URLs in phase 1, show an honest PAT or unsupported message.

6. Add `@cloudflare/vitest-pool-workers` only as part of test-infra work and pin Wrangler/Miniflare versions together. Until then, keep most auth logic in pure functions that Bun can test.
