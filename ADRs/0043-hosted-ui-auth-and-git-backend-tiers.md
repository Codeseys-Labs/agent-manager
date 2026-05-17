---
status: proposed
date: 2026-05-05
amends: ADR-0025
amended_by: [ADR-0048, ADR-0050]
---

# ADR-0043: Hosted UI Auth + Git Backend Tiers

## Context

agent-manager's sixth pillar (ADR-0031, ADR-0031a) is three editing
surfaces — TUI, local web, and **hosted web** — sharing one config
repo as the source of truth. The hosted surface is a Cloudflare
Worker, constrained by ADR-0015: **stateless, no per-user server
state, no database**. Every request carries its own auth; the Worker
proxies git and renders TOML.

The question this ADR answers: *how does that Worker authenticate to
an arbitrary user's git backend?* The landscape is heterogeneous:

- **GitHub.com, GitLab.com, Bitbucket Cloud, Codeberg** ship OAuth2
  (or GitHub Apps) and CORS-enabled REST APIs — fast, browser-safe,
  no git protocol needed for per-file ops.
- **Self-hosted Gitea/Forgejo** each run their own IdP; a hosted UI
  cannot pre-register as an OAuth client with a million unknown
  instances.
- **Generic HTTPS git servers** (gitolite, cgit, plain
  `git-http-backend`, CodeCommit) expose only the git smart-HTTP
  wire protocol — no API, variable CORS.
- **SSH-only remotes** (`git@host:owner/repo`, Gitolite, sshd
  forges) are unreachable from any browser — browsers cannot open
  raw TCP sockets; isomorphic-git's FAQ confirms SSH is out of
  scope.

The existing [ADR-0013](0013-git-platform-adapters.md) defines a
platform-adapter interface for **CLI-side** git ops (GitHub via
`gh`, GitLab via `glab`, bare git). It does not address browser-side
auth or REST access. [ADR-0015](0015-stateless-web-ui.md) forbids
server-side per-user state. Neither resolves the federation problem:
**a single auth choice cannot work for all backends**, and picking
one excludes a user segment permanently.

The 2026-05-05 hosted-UX research
(`docs/research/2026-05-05-hosted-ui-auth-and-git-backends.md`) and
the accompanying design memo
(`docs/design/2026-05-05-hosted-ux-secrets-adapters.md`) worked
through the full matrix. This ADR formalizes the result as a
five-tier decision, bound by the statelessness constraint and
routable by URL inspection alone.

### Relationship to ADR-0025

ADR-0025 (`accepted` 2026-04-13) defined the original Worker
multi-backend authentication: a `GitProvider` interface, a runtime
provider registry, an encrypted session cookie carrying
`{ token, provider, created }`, and parameterized OAuth routes
`/auth/:provider/login` + `/auth/:provider/callback`.

This ADR amends ADR-0025 in three places:

1. **Per-tier auth flows** — ADR-0025's "OAuth everywhere" model is
   replaced by the 5-tier matrix below. GitHub specifically moves
   from OAuth App to GitHub App (per-repo install + per-request
   installation token mint). GitLab keeps OAuth2 with the explicit
   scope-bug workaround. Codeberg keeps OAuth2. Self-hosted Gitea
   moves from OAuth (which requires admin-side dynamic registration
   that many admins disable) to PAT-with-WebCrypto entry. Tier 4
   (generic) and Tier 5 (SSH-only) are net-new.
2. **Cookie payload** — extended from `{ token, provider, created }`
   to `{ token, refresh_token?, provider, tier, created, expires_at }`.
   Per-tier branching means the cookie now records which tier the
   session is on, not just which provider.
3. **CORS proxy** — net-new, not in ADR-0025. Required for Tier 4
   isomorphic-git fetches against generic HTTPS git remotes.

ADR-0025 retains its core: stateless Worker, encrypted session
cookie, per-tenant provider routing. The interface boundary moves
from `GitProvider` (one shape per backend) to `Route` (one shape per
tier) — the shapes overlap heavily; ADR-0025's `GitProvider` becomes
a per-tier helper inside the Tier 1/2 branches of the new `route()`
dispatcher.

If this ADR is promoted to `accepted`, ADR-0025 status becomes
`amended-by: 0043` and its §Decision is annotated with explicit
strikethroughs/replacements; ADR-0025 is not superseded outright
because its statelessness + provider-registry shape is still load-
bearing for Tier 1 and Tier 2.

## Decision

**Five tiers, auto-selected by URL. The tier is a property of the
backend, not a user preference.** This preserves the honest-refusal
principle: the UI never pretends to support an auth mode it can't
actually reach from a browser.

### Tier table

| Tier | Backend | Auth flow | Read API | Write API | Browser limitation |
|------|---------|-----------|----------|-----------|--------------------|
| 1 | GitHub.com | **GitHub App** (per-repo install; fine-grained `contents:write` + `metadata:read`; installation token minted per request from JWT signed by Worker's App private key) | REST `GET /repos/{o}/{r}/contents/{p}` | REST `PUT /repos/{o}/{r}/contents/{p}` | None |
| 1 | GitLab.com / self-hosted GitLab | **OAuth2 + PKCE**, scope `api` (NOT `write_repository` — gitlab#321359 documents push failures with the narrower scope); refresh token in AES-256-GCM-encrypted cookie | REST `GET /projects/:id/repository/files/:path` | REST `POST /projects/:id/repository/commits` (atomic multi-file) | None |
| 1 | Bitbucket Cloud | OAuth2 + PKCE, workspace+repo-scoped (`repository:write`) | REST `2.0/repositories/{ws}/{r}/src/{commit}/{path}` | REST `POST 2.0/repositories/{ws}/{r}/src` | None |
| 2 | Codeberg | OAuth2 via Codeberg's single known provider (one pre-registered app) | Forgejo REST `/api/v1/repos/{o}/{r}/contents/{p}` | Forgejo REST `PUT /api/v1/repos/{o}/{r}/contents/{p}` | None |
| 3 | Self-hosted Gitea / Forgejo | **PAT entry**, encrypted client-side via PBKDF2-derived (600k iterations) non-extractable WebCrypto key in IndexedDB; passphrase once per device | Same Forgejo REST as Tier 2 | Same Forgejo REST as Tier 2 | Admin-configured CORS may require Worker-hosted proxy |
| 4 | Generic HTTPS git (gitolite, cgit, CodeCommit, plain `git-http-backend`) | PAT + **isomorphic-git over OPFS**; Worker-hosted CORS proxy fallback gated by session cookie | iso-git smart-HTTP shallow clone | iso-git smart-HTTP commit + push | Slower; OPFS quota (~60% of free disk) |
| 5 | SSH-only (`ssh://`, `git@host:…`, Gitolite) | **Blocked with first-class banner** | n/a | n/a | Browsers cannot open TCP sockets. Refuse honestly. |

### Routing decision

**Prefer REST where it exists; fall back to isomorphic-git only when
it does not.** Per the research, REST is 5–50× faster than a shallow
clone for single-file reads (one round-trip vs. smart-HTTP
negotiation) and avoids the CORS-proxy question entirely. The
routing function runs once per repo connection:

```typescript
type Route =
  | { kind: 'github-app';     installationId: number; owner: string; repo: string }
  | { kind: 'gitlab-oauth';   projectId: number;      accessToken: string }
  | { kind: 'bitbucket-oauth';workspace: string; repo: string; accessToken: string }
  | { kind: 'gitea-rest';     baseUrl: string; owner: string; repo: string; pat: string }
  | { kind: 'iso-git';        url: string; pat?: string; corsProxy?: string }
  | { kind: 'ssh-blocked';    url: string };

async function route(url: string, creds: Creds): Promise<Route> {
  // Tier 5 fast-path: scp-style SSH URLs cannot be parsed by URL().
  // Match before any URL parse to avoid a throw.
  if (url.startsWith('git@') || url.startsWith('ssh://')) {
    return { kind: 'ssh-blocked', url };
  }
  const u = new URL(normalizeGitUrl(url));           // safe now: non-SSH only
  if (u.hostname === 'github.com')
    return { kind: 'github-app',   ...creds.github,    ...parseOwnerRepo(u) };
  if (u.hostname === 'gitlab.com' || await isGitlab(u))
    return { kind: 'gitlab-oauth', ...creds.gitlab,    projectId: await resolveGitlabId(u) };
  if (u.hostname === 'bitbucket.org')
    return { kind: 'bitbucket-oauth', ...creds.bitbucket, ...parseWorkspaceRepo(u) };
  if (await probeGitea(u))                            // GET /api/v1/version
    return { kind: 'gitea-rest',   baseUrl: u.origin, pat: creds.pat, ...parseOwnerRepo(u) };
  if (await corsAllows(u))                            // direct iso-git
    return { kind: 'iso-git', url: u.toString(), pat: creds.pat };
  return { kind: 'iso-git', url: u.toString(), pat: creds.pat,
           corsProxy: 'https://cors.am.workers.dev' };
}
```

### Storage model (per-tier, client-side)

- **OPFS (Origin Private File System)** — iso-git working trees for
  Tier 4. Browser-native, no 5-MB quota wall, proper FileSystemHandle.
  BrowserFS is deprecated; avoid.
- **IndexedDB + WebCrypto-encrypted PATs** — Tier 3 and Tier 4 tokens,
  wrapped with a key derived from a per-device passphrase (PBKDF2,
  600k iterations, `extractable: false`). Passphrase once per device;
  Worker never sees it.
- **HttpOnly cookies for OAuth2 tokens** — Tier 1 refresh tokens and
  Tier 2 access tokens. `Secure; SameSite=Strict; HttpOnly`; contents
  AES-256-GCM encrypted with HKDF-derived key from Worker's
  `SESSION_SECRET` (`wrangler secret`). GitHub App flow cookie holds
  **only `installation_id`** — the installation token is re-minted
  per request.
- **CORS proxy** — Worker-hosted fork of
  `@isomorphic-git/cors-proxy`, deployed on the same Cloudflare
  account, gated by the authenticated session cookie. Not a free
  open proxy; origin-limited per the iso-git blog guidance.

### Approaches explicitly refused

- **OIDC dynamic client registration (RFC 7591) across arbitrary
  self-hosted Gitea instances.** Technically possible; many admins
  disable DCR; adds state the Worker can't hold statelessly. PAT is
  the honest answer for Tier 3.
- **SSH-via-Worker tunnel / KMS-held SSH key.** Violates
  statelessness (the Worker would have to hold or proxy a long-lived
  identity), expands attack surface, and the UX on a dropped
  long-poll is worse than a banner. Refuse honestly.
- **A single OAuth provider as primary (e.g. GitHub-only).**
  Addressed in "Alternatives Considered" (Option B) — rejected
  because it cuts off the self-hosted segment forever and broadcasts
  the wrong product signal for a pillar-6 feature.
- **Pushing refresh tokens into the user's config repo as
  `.am/session.toml`.** Leaks credential scope into git history;
  couples auth state to the thing auth is protecting.

## Consequences

### Positive

- **Works for ~95% of real git backends** without forcing users to
  downgrade to a weaker auth mode. A GitHub user gets the
  fine-grained GitHub App story; a Forgejo user gets
  scope-restricted PATs; a gitolite user gets iso-git; an SSH-only
  user gets the truth.
- **Honest refusal on Tier 5.** The banner points to `am tui` and
  `am serve` — both already shipped local surfaces — rather than
  building a tunnel or pretending.
- **Per-tier UX is individually optimized.** Tier 1 is a click; Tier
  2 is a click; Tier 3 is a PAT-paste once; Tier 4 is PAT-paste plus
  a CORS warning. Each matches the ceiling of what the backend
  actually offers.
- **Statelessness preserved.** GitHub App installation tokens are
  minted per request; OAuth refresh lives in the cookie; PATs live
  in IndexedDB. The Worker's only long-term secret is the GitHub App
  private key (a `wrangler secret`).
- **Matches industry precedent** — github.dev and vscode.dev both
  use REST-first, not clone-first, for per-file browser ops.

### Negative

- **Five auth flows to maintain.** GitHub App (JWT signing +
  installation-token mint), GitLab OAuth2+PKCE (with rotating
  refresh), Bitbucket OAuth2+PKCE, Codeberg OAuth2, and two PAT
  paths (Tier 3 and Tier 4). Each has its own failure mode and
  provider-specific quirks (e.g. gitlab#321359).
- **The CORS proxy is operational surface.** It must be session-
  cookie-gated to avoid becoming a free open proxy, and abuse
  monitoring is a standing cost.
- **Tier 3 PAT-entry is friction users will complain about.** The
  honest response — "your self-host is its own IdP, we can't
  pre-register" — is correct but unsatisfying. Mitigated by the
  "Remember on this device" IndexedDB flow (passphrase once, not
  per-session).
- **Worker per-IP rate limits can hit power users** with many repos
  or aggressive save-cadence. Documented; no mitigation in this ADR.
- **GitLab refresh-token rotation can race.** Each refresh
  invalidates the previous token; two concurrent Worker requests
  can nuke each other's session. Mitigation belongs in the
  implementation (per-session refresh nonce, retry-once on 401).

### Neutral

- Matches github.dev / vscode.dev's "REST for per-file ops, clone
  only when unavoidable" precedent.
- Tier 4's iso-git path shares implementation with any future local
  browser-git feature.
- The `.agent-manager.toml` source of truth is untouched — only the
  transport layer varies by tier.

## Alternatives Considered

**Option A — Five-tier hybrid as specified (chosen).** Routes by
backend capability, preserves statelessness, refuses honestly on
SSH. Maintenance cost is five flows; the alternative is excluding
users.

**Option B — GitHub-only first, expand later.** Ship the GitHub App
story, stub every other tier. Rejected: this broadcasts "am is a
GitHub product" for the lifetime of that stub period, and pillar 4
(marketplace) plus pillar 1 (catalog+git sync) already work across
all backends at the CLI. Cutting off self-hosted users at the
hosted-UI layer contradicts the CLI's platform neutrality and
creates a segment that will never return.

**Option C — PAT-everywhere.** Use personal access tokens across
all tiers for implementation simplicity. Rejected: worse UX on
cloud providers (forces users to generate and paste a PAT instead
of clicking "Authorize"); cannot access GitHub's fine-grained
per-repo scopes; users reasonably distrust typing a GitHub PAT into
a third-party web UI when an App install exists. PAT-everywhere
trades a one-time implementation saving for permanent UX and trust
debt.

**Option D — Route everything through the user's local CLI via a
tunnel/agent.** Browser UI connects to a local `am agent` over
WebSocket or ngrok-style tunnel; the local process handles git.
Rejected: violates "hosted = works without a local install"
(pillar 6 amendment, ADR-0031a) — if you needed the local CLI
running, `am serve` already serves that need. Adds a persistent
process to manage on every device, and the tunnel itself is an
auth/attack-surface problem no smaller than the one it solves.

**Option E — OIDC with dynamic client registration everywhere.**
Register as an OAuth client per self-hosted instance on first use
via RFC 7591. Rejected: many Gitea admins disable DCR; the
registration itself needs somewhere to live (Worker has no
database); and the complexity budget is better spent on the Tier 3
PAT-encryption UX.

## Verification Gates

This ADR is `proposed`. Promotion to `accepted` requires **all** of
the following, explicitly checked off on the promotion PR:

1. **GitHub App registered** with the minimum-scope manifest
   (`contents:write` + `metadata:read`, no issues / actions /
   secrets / org scopes) and reviewed by a security-aware
   contributor. Manifest checked into the repo.
2. **GitLab OAuth flow validated** end-to-end with scope `api`
   (the `write_repository`-only path is known-broken per
   gitlab#321359; the ADR and the implementation must both cite
   and work around it). Refresh-token rotation race tested with
   two concurrent requests.
3. **CORS proxy origin/ACL spec written** as a separate doc and
   gated by the session cookie. Open-proxy abuse vector reviewed;
   rate limit set.
4. **Tier 5 SSH banner copy reviewed** by whoever owns UX on the
   project. The exact phrasing from the research doc is the
   minimum bar: *"This repo uses SSH. Browsers cannot speak SSH.
   Open `am tui` or `am serve` on your laptop instead — it's the
   same editor with the same TOML, running locally."*
5. **ADR-0042 (universal secrets: age + passphrase + OS keychain)
   landed** as `accepted`. This ADR's Tier 3/4 PAT-encryption
   story shares the passphrase-derived-KEK primitive with ADR-0042;
   they must not drift. Consistency of the browser's secret-
   decrypt story across OAuth cookies, IndexedDB PATs, and
   age-encrypted config values is a single security surface.

Until all five gates hold, Tier 1a (GitHub App) may be prototyped
behind a feature flag but no tier may be enabled by default.

## Promotion Audit (2026-05-16)

**Decision: stays `proposed`.**

ADR-0048 (`accepted` 2026-05-05) implements Phase 1 of this ADR
(GitHub App + GitLab OAuth2/PKCE) but explicitly defers the bulk of
the verification gates above to later phases. ADR-0050 (`accepted`
2026-05-05) ratifies the browser-decrypt path that this ADR's Tier
3/4 PAT-encryption story shares with ADR-0042. Together those two
amendments are *necessary* but not yet *sufficient* for promotion.

**Unmet verification gates:**

- **Gate 3 (CORS proxy origin/ACL spec).** Not written. ADR-0048
  defers Tier 4 (generic HTTPS git via isomorphic-git) to Phase 3
  alongside Codeberg / Gitea / Forgejo. Until the proxy spec ships
  and is reviewed for open-proxy abuse, Tier 4 is unbuilt and gate 3
  is open.
- **Gate 4 (Tier 5 SSH banner copy reviewed).** No record of UX-owner
  sign-off on the banner phrasing. Tier 5 is "block honestly" — the
  exact copy is the ship-able artifact.
- **Gate 2 (refresh-token rotation race tested).** ADR-0048 §"GitLab
  refresh-token rotation" describes the optimistic strategy but
  notes the concurrent-request race remains an implementation TODO;
  the integration test is not yet on the branch.

Gates 1 (GitHub App manifest + security review) and 5 (ADR-0042
landed) are satisfied: ADR-0048 ratifies the App manifest and ADR-0042
was promoted in this same audit.

**What would close this ADR:**

A follow-up ADR (or an explicit Phase-3 implementation plan, mirroring
the ADR-0048-for-Phase-1 pattern) covering Codeberg / Gitea / Forgejo
OAuth + Tier 4 iso-git + the CORS proxy spec. Once that lands as
`accepted` and the SSH banner copy is reviewed, ADR-0043 can be
promoted in a single follow-up audit.

**Tracking:** the gap is implicit in ADR-0048's "Phase 3 deferred"
scope; no separate seeds task has been opened for the missing
deliverables. Maintainers should file one before starting Phase 3
work so the deferral is durable rather than load-bearing on this
audit note.

## References

**Prior am ADRs:**

- [ADR-0013 Git platform adapters](0013-git-platform-adapters.md)
  — adapter interface this ADR extends for browser-side auth
- [ADR-0015 Stateless web UI](0015-stateless-web-ui.md) —
  no-server-state constraint this ADR operates under
- [ADR-0031 Product scope and pillars](0031-product-scope-and-pillars.md)
  and [ADR-0031a Pillar 6 amendment](0031a-pillar-6-amendment.md)
  — the hosted-UI pillar this ADR implements
- ADR-0042 (proposed) — universal secrets strategy; gating this
  ADR's verification

**Source material:**

- `docs/design/2026-05-05-hosted-ux-secrets-adapters.md` — design
  memo; "Answer to OIDC/SSO vs git credentials" section
- `docs/research/2026-05-05-hosted-ui-auth-and-git-backends.md` —
  research report with full citation list

**External references** (provider docs and prior art):

- GitHub Apps vs OAuth Apps:
  https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
- Deciding when to build a GitHub App:
  https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app
- GitHub `PUT /repos/{owner}/{repo}/contents/{path}`:
  https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents
- GitLab OAuth 2.0 + scopes:
  https://docs.gitlab.com/ee/api/oauth2.html
- gitlab#321359 — `write_repository` insufficient to push, `api`
  required: https://gitlab.com/gitlab-org/gitlab/-/issues/321359
- GitLab atomic multi-file commit API:
  https://docs.gitlab.com/ee/api/commits.html#create-a-commit-with-multiple-files-and-actions
- Bitbucket Cloud OAuth 2.0:
  https://developer.atlassian.com/cloud/bitbucket/oauth-2-connect/
- Gitea OAuth2 Provider (per-instance, not federated):
  https://docs.gitea.com/development/oauth2-provider
- Forgejo access token scopes (incl. "Specific repositories"
  filter): https://forgejo.org/docs/next/user/token-scope/
- Codeberg access tokens:
  https://docs.codeberg.org/advanced/access-token/
- isomorphic-git homepage + FAQ (no SSH support):
  https://isomorphic-git.org/docs/en/faq
- isomorphic-git `clone` (shallow, single-branch, CORS proxy):
  https://isomorphic-git.org/docs/en/clone.html
- isomorphic-git CORS proxy + origin-limiting:
  https://github.com/isomorphic-git/cors-proxy ·
  https://isomorphic-git.org/blog/2018/07/08/cors-proxy-origin-limited
- MDN — Origin Private File System (OPFS):
  https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
- VS Code for the Web / github.dev architecture (REST-first,
  not clone-first):
  https://code.visualstudio.com/docs/setup/vscode-web ·
  https://docs.github.com/en/codespaces/the-githubdev-web-based-editor
- Cloudflare API Shield — JWT validation on Workers (stateless
  session pattern):
  https://developers.cloudflare.com/api-shield/security/jwt-validation/jwt-worker/
- Clerk — Authentication for serverless and edge deployments
  (JWT-in-cookie pattern):
  https://clerk.com/articles/authentication-for-serverless-and-edge-deployments
