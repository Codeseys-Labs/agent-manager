---
status: accepted
date: 2026-05-05
accepted: 2026-05-05
amends: ADR-0043
---

# ADR-0048: Hosted UI Auth Implementation Plan

## Context

ADR-0043 defines the hosted Web UI authentication model as a
capability-routed matrix rather than one OAuth flow for every backend.
That design ADR deliberately separates backend capability from user
preference: GitHub.com, GitLab.com, Codeberg, self-hosted Forgejo/Gitea,
generic HTTPS git, and SSH-only remotes do not have the same browser
surface.

ADR-0025 is the predecessor. It implemented a Worker-era
multi-backend auth plan centered on OAuth providers, provider-specific
routes, and an encrypted session cookie that stores the active provider.
That was enough for GitHub OAuth App, GitLab OAuth, Codeberg OAuth, and
configured Gitea OAuth, but it assumed OAuth was the universal answer.
ADR-0043 corrects that assumption.

ADR-0015 supplies the hard platform constraint: the hosted Web UI is a
stateless, independently deployable Worker surface. It may use sealed
request cookies and provider APIs, but it must not depend on per-user
server-side session rows. The same hosted UI can be redeployed or scaled
without a database migration or sticky session affinity.

Lens F, `docs/research/2026-05-05-deep-loop/lens-F-adr-0043-deep.md`,
turns ADR-0043's design into concrete Worker recipes. It verifies the
provider docs, names the token lifetimes, identifies Worker-compatible
implementation primitives, and lists the test cases needed before the
Phase-1 auth implementation is merged.

This ADR ratifies the implementation choices that are now ready to
execute. It is intentionally narrower than the full ADR-0043 matrix:
Phase 1 implements the path that is ready, keeps the stateless promise,
and avoids taking on per-instance OAuth registration or CORS-proxy
operations before they are needed.

The result is a design-plus-implementation ADR. It does not contain the
TypeScript implementation. It records which recipes are binding, which
backends are in scope for each phase, and which verification gates must
pass before each phase can merge.

## Decision

We will implement hosted UI auth in three phases, with Phase 1 accepted
as ready to execute now.

The chosen Phase-1 path is:

1. GitHub.com Phase 1 uses a GitHub App, not a GitHub OAuth App.
   The Worker stores only `installation_id`, selected owner/repo, tier,
   and timestamps in the sealed session cookie. It mints an installation
   access token per request using the GitHub App private key and downscopes
   the request to the selected repository and minimum permissions.

2. GitLab.com remains OAuth2 with PKCE, using the `api` scope.
   The Worker treats the GitLab access token as a two-hour token and
   stores the refresh token in the sealed cookie. Refresh-token rotation
   is handled optimistically because ADR-0015 does not allow a Durable
   Object or database row to serialize refreshes.

3. Codeberg, self-hosted Gitea, and self-hosted Forgejo are deferred to
   Phase 3. They are out of scope for Phase 1 because OAuth registration
   is per instance. A public hosted Worker cannot assume that every
   Forgejo/Gitea instance has registered agent-manager as an OAuth client.

4. Session cookies use a Worker-native sealed-cookie envelope implemented
   with WebCrypto AES-GCM. We will not use `iron-session` in Phase 1, and
   we will not store per-user sessions in KV, D1, or Durable Objects. The
   envelope includes a key id so current-plus-previous key rotation is
   supported from the first implementation.

The binding session-cookie properties are:

- cookie name: `__Host-am_session`
- attributes: `Path=/`, `Secure`, `HttpOnly`, `SameSite=Strict`
- no `Domain` attribute
- AES-GCM with random 12-byte IV
- additional authenticated data bound to the cookie name
- plaintext envelope includes version and key id
- ciphertext contains the session body
- new cookies are sealed with the current key id
- old cookies may be opened by any configured previous key id

The binding OAuth state-cookie properties are:

- cookie name: `__Host-am_oauth_state`
- attributes: `Path=/`, `Secure`, `HttpOnly`, `SameSite=Strict`
- short max age, target five minutes
- sealed with the same envelope family as the session cookie
- contains provider id, redirect URI, PKCE verifier, random state, and
  issued timestamp
- callback rejects missing, expired, provider-mismatched, or
  value-mismatched state and clears the state cookie

The GitHub App session body must not contain a GitHub access token.
The expected payload is conceptually:

```text
session:
  version: 1
  tier: github-app
  installation_id: number
  owner: string
  repo: string
  issued_at: unix milliseconds
```

The GitLab.com OAuth session body may contain OAuth credentials because
the cookie is sealed and ADR-0015 accepts encrypted cookie sessions:

```text
session:
  version: 1
  tier: gitlab-oauth
  provider: gitlab.com
  access_token: opaque token
  refresh_token: opaque token
  expires_at: unix milliseconds
  scope: api
  refresh_nonce: random base64url value
  issued_at: unix milliseconds
```

The GitHub installation-token flow follows Lens F Recipe B:

```text
on GitHub API request:
  read sealed session
  require tier github-app
  generate short-lived app JWT with RS256
  set iat to now minus clock-skew allowance
  set exp to now plus less than ten minutes
  call GitHub installation access-token endpoint
  request repository downscope for selected repo
  request contents:write and metadata:read only
  use returned installation token for this upstream request
  never write that token into the session cookie
```

The GitLab OAuth flow follows Lens F Recipe A:

```text
on login:
  create random state
  create random PKCE verifier
  derive S256 challenge
  seal state plus verifier into short-lived state cookie
  redirect to GitLab authorization endpoint with scope api

on callback:
  unseal state cookie
  compare callback state to sealed state
  reject mismatches with 403
  exchange code and verifier for token response
  store access token, refresh token, expiry, scope, and refresh nonce
  seal session cookie
```

The provider write APIs follow Lens F Recipe D:

- GitHub uses the repository contents API for single-file writes.
- GitLab uses the commits API with `actions[]` so multi-file saves can be
  atomic when the UI later needs them.
- Gitea/Forgejo contents writes are documented for later phases but are
  not part of Phase 1.

## Rationale

GitHub App is the right hosted-UI primitive for GitHub.com because it
matches the unit of permission the product needs: one installed app,
limited repositories, and narrow contents permissions. A GitHub OAuth App
would grant a user-scoped token and make the Worker hold a broader bearer
credential than necessary.

GitHub installation access tokens also fit the stateless Worker better
than user-to-server refresh tokens. Lens F cites GitHub's documentation
that installation access tokens expire after one hour and are minted from
a short-lived app JWT. The Worker can create them on demand from its app
private key, use them for one upstream request path, and discard them.

Storing only `installation_id` sharply reduces cookie blast radius. If a
GitHub session cookie leaks, the attacker still lacks the GitHub App
private key needed to mint an installation token. If the Worker secret
leaks, the key-rotation runbook is still required, but the cookie itself
is not a cache of live GitHub API credentials.

GitLab.com stays OAuth2 + PKCE because GitLab does not offer the same
installation-token model for arbitrary repositories. The documented
access-token lifetime is two hours, and the documented refresh-token path
is the intended way to continue a browser-based integration. PKCE keeps
the authorization-code exchange safe without relying on a client secret
in the browser path.

The `api` scope is chosen despite being broader than a write-only git
scope because the hosted UI writes through GitLab's REST commit APIs.
ADR-0043 and Lens F both cite gitlab-org/gitlab issue 321359: the narrower
`write_repository` scope is insufficient for the required operations and
has known push/API failure modes.

A Worker-native sealed cookie is chosen over KV, D1, or Durable Objects
because ADR-0015 is load-bearing. KV is eventually consistent and is a bad
fit for refresh serialization. D1 and Durable Objects can model sessions,
locks, and audit trails, but they are server-side per-user state. Using
them would be a new architecture decision, not an implementation detail.

A Worker-native sealed cookie is chosen over `iron-session` because Lens F
found that `iron-session` is a good precedent but not a dependency we
should assume for Phase 1. Version `iron-session` v8.0.3 had surfaced
runtime compatibility concerns in Worker-like environments, and cookie
chunking work was still open. The Phase-1 payload is small enough that a
local WebCrypto envelope is simpler and more auditable.

A Worker-native sealed cookie is also chosen over waiting for Hono's
proposed encrypted-cookie helper. Lens F found Hono issue 4817 describing
an AES-GCM WebCrypto design, but the feature was still a proposal as of
2026-03-20. We should not block the auth implementation on an unreleased
framework helper.

Self-hosted Forgejo/Gitea OAuth is deferred because it is real but not
federated. Each instance is its own identity provider. A public hosted UI
cannot pre-register itself on every instance, and dynamic client
registration is not a reliable assumption because many admins disable it.
Claiming universal "Login with Forgejo" would be misleading.

Codeberg is deferred with the same caution. Codeberg can become a known
provider only after agent-manager owns and operates a Codeberg OAuth
application and validates the exact scopes and token behavior. Until then,
Codeberg support is not part of Phase 1.

## Trade-offs

The accepted path has these costs:

- GitHub users must install a GitHub App on the repository owner before
  the hosted UI can edit the config repository. This is an extra step
  compared with OAuth App login.

- GitHub App implementation is more complex than OAuth App login. It
  requires app JWT signing, private-key import, installation callback or
  selection UX, repository downscoping, and installation-token mint tests.

- Codeberg users are cut out of Phase 1. The product should state this
  plainly rather than hiding the unsupported state behind a broken OAuth
  button.

- Self-hosted Forgejo and Gitea users are cut out of Phase 1 for hosted
  OAuth. They can continue using local surfaces, and later phases can add
  PAT or configured-provider paths, but this ADR does not pretend Phase 1
  solves per-instance OAuth registration.

- GitLab refresh-token rotation can race under stateless cookies. Two
  concurrent requests can both decide to refresh. One may win while the
  other receives `invalid_grant` or attempts to set an older cookie. The
  implementation must retry once on upstream 401, use a refresh nonce, and
  force re-login cleanly when rotation cannot be repaired statelessly.

- Key rotation adds operational complexity. Deployments must maintain a
  current key id and a bounded previous key id, wait at least the maximum
  session TTL before removing old keys, and perform forced logout when a
  key is suspected to be compromised.

- Cookie size becomes a real constraint for OAuth providers that return
  large access tokens. Phase 1 avoids chunking and stores only one provider
  session. The implementation must warn before approximately 3000 bytes
  and fail closed before the browser's practical 4096-byte per-cookie
  limit.

- A sealed cookie cannot provide server-side session revocation by itself.
  Logout clears the browser cookie, and key rotation can revoke classes of
  cookies, but there is no per-session denylist without amending ADR-0015.

- Worker isolate caching is an optimization only. Imported GitHub private
  keys and short-lived app JWTs may be cached in module scope for
  performance, but correctness must not depend on cache persistence.

- The plan intentionally leaves the CORS-proxy and generic HTTPS git path
  out of scope. That keeps Phase 1 secure and reviewable but postpones
  support for some non-cloud git servers.

## Implementation phases

### Phase 1: GitHub App hosted login and sealed cookie

Scope for this PR:

- replace the GitHub.com OAuth-App path with GitHub App login/install
  handling
- create Worker-native seal and unseal helpers for auth cookies
- create strict `__Host-` session and OAuth-state cookies
- store GitHub sessions as installation metadata only
- mint GitHub installation access tokens per request
- downscope installation-token requests to the selected repository
- use GitHub REST contents read/write APIs for the selected repo
- preserve a single-repo capability scope for the hosted UI
- keep auth logic factored into pure functions where possible so Bun unit
  tests can cover most behavior before Worker-runtime tests are added

Phase 1 explicitly excludes:

- GitHub OAuth App fallback
- GitHub user-to-server refresh tokens
- Codeberg OAuth
- self-hosted Forgejo/Gitea OAuth
- generic HTTPS git over isomorphic-git
- Worker CORS proxy
- KV, D1, or Durable Object per-user session storage
- cookie chunking

Phase 1 may include GitLab refresh tests if the test harness is shared,
but GitLab.com user-facing login is Phase 2.

### Phase 2: GitLab.com OAuth2 + PKCE

Scope for a future PR:

- implement GitLab.com OAuth2 authorization-code flow with PKCE
- request scope `api`
- use unpredictable state and a short-lived sealed state cookie
- store access token, refresh token, expiry, scope, and refresh nonce in
  the sealed session cookie
- refresh near expiry with skew, not on every request
- retry once on upstream 401
- clear session and force re-login on unrecoverable `invalid_grant`
- use GitLab REST file read APIs
- use GitLab commit API with `actions[]` for writes
- avoid self-hosted GitLab auto-discovery unless an instance is explicitly
  configured with valid OAuth client metadata

### Phase 3: Codeberg and self-hosted Forgejo/Gitea

Scope for a future PR:

- register and verify a real Codeberg OAuth application before exposing
  a Codeberg hosted-login button
- document exact Codeberg scopes and token lifetimes once verified
- add configured-provider support for known self-hosted Forgejo/Gitea
  instances where an admin has created an OAuth app
- add PAT-based fallback UX for instances where OAuth is unavailable or
  disabled
- keep PATs out of the Worker session cookie
- define whether PATs are browser-only encrypted storage, per-session
  entry, or another ADR-0042-aligned secret envelope
- revisit the generic HTTPS git and CORS-proxy path only after the REST
  provider phases are stable

## Verification gates

### Phase 1 gates

Phase 1 must satisfy all of the following before merge:

1. State-mismatch CSRF rejection test.
   Missing, expired, value-mismatched, and provider-mismatched OAuth state
   must return 403 and clear the state cookie.

2. Sealed-cookie roundtrip test.
   A current-key cookie must seal and unseal successfully with the cookie
   name as authenticated data, and tampered ciphertext or wrong AAD must
   fail closed.

3. Key-rotation test.
   An old-key cookie must open while the old key is configured and then be
   re-sealed with the current key. A removed-key cookie must fail closed.

4. GitHub installation-token mint test.
   The Worker must generate an RS256 app JWT with issuer, issued-at, and
   expiry inside GitHub's ten-minute maximum; call the installation-token
   endpoint with Bearer app JWT auth; and request only the selected repo
   plus `contents:write` and `metadata:read`.

5. GitHub token non-persistence test.
   The GitHub session cookie must not contain installation token strings
   or user token prefixes such as `ghs_`, `ghu_`, or `ghr_`.

6. Single-repo capability test.
   A session for one owner/repo must not be usable to read or write a
   different owner/repo unless the user completes a new installation or
   selection flow.

7. Expired-token-refresh test.
   The shared auth harness must prove that an expired or rejected upstream
   token path does not loop forever. For GitHub this means minting a fresh
   installation token per request; for the OAuth harness this means retry
   once and then clear or reject cleanly.

8. Cookie-size guard test.
   Synthetic large payloads must warn near the configured warning threshold
   and fail before the hard per-cookie threshold. Phase 1 must not add
   cookie chunking.

### Phase 2 gates

Phase 2 must satisfy all of the following before merge:

1. PKCE challenge and verifier test.
   The challenge must be S256 over the exact verifier later sent to the
   token endpoint.

2. GitLab scope test.
   The authorization URL and stored session must record `api`, not only
   `write_repository`.

3. GitLab token-expiry test.
   The callback must compute `expires_at` from the provider response and
   treat the access token as a two-hour token unless GitLab returns a
   different explicit lifetime.

4. Refresh-token rotation test.
   Refresh success must replace both access and refresh tokens when a new
   refresh token is returned.

5. Concurrent-refresh race test.
   Two simulated concurrent refreshes must not silently overwrite a newer
   cookie with an older invalid result. The acceptable outcomes are a valid
   newest cookie or a clean forced re-login.

6. GitLab atomic write test.
   Writes must use the commit API with `actions[]`, not a fragile per-file
   loop for multi-file changes.

### Phase 3 gates

Phase 3 must satisfy all of the following before merge:

1. Codeberg OAuth registration proof.
   The hosted deployment must have an owned and reviewed Codeberg OAuth app
   before the Codeberg button is enabled.

2. Per-instance OAuth truthfulness test.
   Unknown Forgejo/Gitea origins must not show a universal OAuth login
   claim. They must show configured-provider, PAT, or unsupported UX.

3. PAT storage boundary test.
   A Gitea/Forgejo PAT must not be sealed into `__Host-am_session` unless
   a later accepted ADR explicitly changes that boundary.

4. CORS-proxy abuse review, if Tier 4 is included.
   Any proxy must block private and metadata IPs, require an authenticated
   same-origin session, restrict methods and headers, rate-limit requests,
   and avoid logging Authorization headers.

## Cross-references

- ADR-0043: `ADRs/0043-hosted-ui-auth-and-git-backend-tiers.md`.
  This ADR amends ADR-0043 by ratifying the concrete Phase-1/2/3
  implementation plan and narrowing Phase 1 to the hosted paths that are
  ready to execute.

- ADR-0025: `ADRs/0025-worker-multi-backend-auth.md`.
  This ADR replaces the predecessor's "OAuth provider everywhere" shape
  for hosted GitHub.com with GitHub App installation-token minting, while
  preserving the stateless encrypted-cookie principle.

- ADR-0015: `ADRs/0015-stateless-web-ui.md`.
  The no per-user server-state constraint is the reason this ADR chooses
  sealed cookies instead of KV, D1, Durable Objects, or SQL sessions.

- ADR-0042: `ADRs/0042-universal-secrets-strategy.md`.
  Later PAT and browser-secret handling must stay aligned with the
  universal secrets strategy. This ADR does not decide a new PAT storage
  envelope for Phase 3.

- Lens F: `docs/research/2026-05-05-deep-loop/lens-F-adr-0043-deep.md`.
  Binding implementation recipes are Lens F Recipe A for PKCE and state,
  Recipe B for GitHub App installation-token minting, Recipe C for sealed
  cookies with key rotation, and Recipe D for provider write APIs.

- GitHub installation access tokens:
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app

- GitHub user-to-server token refresh, documented as a different and less
  attractive stateless-cookie fit for this Phase-1 design:
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-to-server-access-tokens

- GitHub OAuth App authorization and PKCE reference, relevant only as a
  refused GitHub Phase-1 path and for callback-loop cautions:
  https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps

- GitLab OAuth2 API docs:
  https://docs.gitlab.com/api/oauth2/

- GitLab OAuth provider docs, including two-hour access-token behavior:
  https://docs.gitlab.com/integration/oauth_provider/

- GitLab commit API for atomic writes:
  https://docs.gitlab.com/api/commits/

- GitLab issue 321359, documenting why `write_repository` is not enough
  for the required GitLab path:
  https://gitlab.com/gitlab-org/gitlab/-/issues/321359

- Gitea OAuth2 provider docs, cited for the Phase-3 per-instance OAuth
  burden:
  https://docs.gitea.com/development/oauth2-provider

- Forgejo OAuth2 provider docs, cited for the Phase-3 per-instance OAuth
  burden:
  https://forgejo.org/docs/latest/user/oauth2-provider

- Cloudflare Workers limits, cited for cookie/header-size constraints:
  https://developers.cloudflare.com/workers/platform/limits/

- Cloudflare Workers Headers API, cited for Set-Cookie behavior:
  https://developers.cloudflare.com/workers/runtime-apis/headers/

- Cloudflare KV consistency model, cited as a reason KV is not used for
  per-user refresh/session serialization:
  https://developers.cloudflare.com/kv/concepts/how-kv-works/

- Cloudflare storage-options docs, cited for the distinction between KV,
  D1, and Durable Objects:
  https://developers.cloudflare.com/workers/platform/storage-options/

- `cloudflare/workers-oauth-provider` is a reference implementation for
  OAuth-provider architecture on Workers, not the client implementation
  chosen here. Lens F cites release `v0.5.0` on 2026-05-05 and the
  original implementation commit
  `3b2ae809e9256d292079bb15ea9fe49439a0779c`:
  https://github.com/cloudflare/workers-oauth-provider

- Lens F test-infra pins for a later Worker-runtime test PR:
  `@cloudflare/vitest-pool-workers@0.14.0`, `wrangler@4.79.0`, and
  `miniflare@4.20260329.0`. The project should pin these together if it
  adopts Worker-runtime tests.

- Lens F notes the current project baseline at the time of research:
  `wrangler ^4.14.0`, `@cloudflare/workers-types ^4.20250401.0`, and no
  Vitest dependency. Adding Worker-runtime tests is therefore a discrete
  test-infrastructure change, not an incidental auth-code edit.
