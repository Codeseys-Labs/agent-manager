# Hosted UI Auth & Multi-Backend Git Ops — Research

**Date:** 2026-05-05
**Context:** am's sixth pillar — the Cloudflare Worker editing surface (ADR-0015 / ADR-0031a).
Users today `git clone` their config repo to `~/.config/agent-manager/` and edit it via CLI,
TUI (`am tui`), or local web (`am serve`). We want to ship a hosted web UI that reads and
commits to the same repo from anywhere. Constraint: **no server-side state** — the Worker
holds no DB, every request carries its own auth.

The question is *how*, given a heterogeneous backend landscape: GitHub and GitLab ship
first-class OAuth, self-hosted Gitea/Forgejo instances each act as their own IdP, and some
users run plain `ssh://` git that the browser cannot touch at all.

---

## Decision matrix per backend type

| Backend | Auth flow | Read API | Write API | Browser limitation | Recommended UX |
|---|---|---|---|---|---|
| **GitHub.com** | GitHub App (per-repo install) → user-to-server token | REST `GET /repos/{o}/{r}/contents/{p}` | REST `PUT /repos/{o}/{r}/contents/{p}` (creates commit) | None — CORS-enabled API | GitHub App install button → pick one repo → done |
| **GitLab.com** | OAuth 2.0 PKCE, scopes `api` + `read_repository` + `write_repository` (note: git push requires `api`, see gitlab#321359) | REST `GET /projects/:id/repository/files/:path` | REST `POST /projects/:id/repository/commits` (multi-file atomic) | None | OAuth redirect → list projects → pick one |
| **Bitbucket Cloud** | OAuth 2.0, scope `repository:write` | REST `2.0/repositories/{ws}/{r}/src/{commit}/{path}` | REST `POST .../src` (form-encoded commits) | None | OAuth redirect → pick workspace+repo |
| **Codeberg** (shared Forgejo) | Single known instance — register one OAuth app on codeberg.org | Forgejo REST `/repos/{o}/{r}/contents/{p}` | Forgejo REST `PUT /repos/{o}/{r}/contents/{p}` | None (Codeberg speaks CORS) | OAuth redirect, same as GitLab |
| **Self-hosted Gitea / Forgejo** | **PAT pasted by user** (scopes `read:repository`, `write:repository`, + optional "specific repositories" filter — Forgejo supports this) | Same REST as Codeberg | Same REST as Codeberg | CORS depends on admin; most self-hosts don't allow `*.workers.dev` origin | Instance-URL + PAT form; store encrypted in IndexedDB |
| **Generic HTTPS git** (Gogs, cgit, CodeCommit, plain `git-http-backend`) | PAT / basic auth — no API, only git smart-HTTP | isomorphic-git `clone({depth:1, singleBranch:true})` | isomorphic-git `commit` + `push` with auth headers | CORS: the user's server must send `Access-Control-Allow-Origin`. If not, we need a Worker-hosted CORS proxy (`@isomorphic-git/cors-proxy`) | URL + PAT form; warn about CORS; offer "use local `am serve` instead" |
| **SSH-only** (`git@host:repo`, Gitolite, `sshd` forge) | SSH key | — | — | Browsers cannot open raw TCP; isomorphic-git explicitly does not support ssh:// per FAQ | **Refuse up-front** with a clear banner: "This repo is SSH-only — open `am tui` locally" |

Key asymmetry: cloud providers (top 4 rows) give us **OAuth + CORS-safe REST**, which is
fast and avoids cloning. Self-hosted instances (bottom 3) force us into **PAT + git
wire protocol**, which is slower, may need a proxy, and — for SSH — is impossible.

---

## Recommended hybrid auth model for am

Three tiers, auto-selected by URL inspection.

### Tier 1 — Cloud OAuth (GitHub / GitLab / Bitbucket / Codeberg)

**GitHub → use a GitHub App, not an OAuth App.**
GitHub's own docs say "In general, GitHub Apps are preferred over OAuth apps" because
they (a) are installed *per-repository* so the user picks exactly the am-config repo,
(b) use **fine-grained permissions** (`contents:write` + `metadata:read` only — no
access to issues, actions, secrets, org data), and (c) issue short-lived installation
tokens that expire in 1 hour, removing any long-term secret-storage liability. The flow:

1. User clicks "Connect GitHub" → redirect to `https://github.com/apps/am-config/installations/new`.
2. User picks one repo to grant access to (or "All repos" if they insist).
3. GitHub redirects back with `installation_id` + `setup_action=install`.
4. Worker exchanges its pre-baked JWT (signed with the app's private key, stored as a
   Worker secret) for an installation token via `POST /app/installations/{id}/access_tokens`.
5. Worker writes an **encrypted session cookie** containing `{installation_id, exp}`.
   **No token in the cookie** — we re-mint the installation token on every request, because
   that's literally what installation tokens are for.

This is the cleanest stateless story on the whole stack: the Worker's only long-term
secret is the GitHub App private key (a `wrangler secret`), and everything else is
derived on demand.

**GitLab / Bitbucket / Codeberg → OAuth 2.0 + PKCE with refresh tokens.**
No Apps equivalent exists. The wrinkle is **GitLab's `write_repository` scope does not
permit API commits** — issue gitlab#321359 documents that you need `api` scope to push.
Since we use `POST /projects/:id/repository/commits` (REST, not git-push), we can get away
with `api + read_repository`; but `api` is broad. Justify this in the consent screen.

Refresh token: GitLab access tokens are short-lived; we must store the refresh token
somewhere. Options:

- **(chosen)** Encrypted cookie: JWE/AES-256-GCM using a Worker secret. Cookie size stays
  under 4 KB comfortably (refresh + access token ≈ 200 bytes each).
- Reject option: push refresh token into the user's config repo as `.am/session.toml` —
  cute but leaks credential scope into the VCS log and couples auth to the thing the
  auth is protecting.
- Reject option: Cloudflare KV — violates the no-DB rule and adds a per-user object.

### Tier 2 — Self-hosted PAT (Gitea / Forgejo / private Gitea instance)

No federated OAuth exists across arbitrary Gitea instances. Each instance is its own
IdP; registering am as an OAuth client on every self-host doesn't scale. The pragmatic
answer is what Obtainium, Forgejo-Next, and most Gitea third-party apps do: **ask for a
PAT**.

UX:

1. User enters instance URL (`https://git.example.org`) + PAT.
2. Client pings `GET /api/v1/version` to validate, then `GET /api/v1/repos/search?uid=<me>`
   to let the user pick a repo.
3. PAT is encrypted **client-side** with AES-GCM using a key derived from a passphrase
   (PBKDF2, 600k iterations, non-extractable `CryptoKey`) and stored in IndexedDB.
   The passphrase is entered once per device; we never send it to the Worker.
4. Every request to the Worker carries `Authorization: Bearer <pat>` *in plaintext*
   over HTTPS — the Worker forwards it to the user's Gitea instance and discards it
   after the response.

Forgejo PATs support a "Specific repositories" filter that limits the token to a single
repo — we should tell users to use it.

### Tier 3 — Generic HTTPS git + isomorphic-git

URL doesn't match a known host pattern but resolves over HTTPS. Assume git smart-HTTP.
Same PAT entry, but the Worker can't use any REST API — it routes the browser to
isomorphic-git for clone/commit/push.

### Tier 4 — SSH-only

URL starts with `ssh://`, `git@`, or HTTPS returns no `info/refs?service=git-upload-pack`.
Render a **first-class banner**, not a buried error:

> This repo uses SSH. Browsers cannot speak SSH. Open `am tui` or `am serve` on your
> laptop instead — it's the same editor with the same TOML, running locally.

This is the honest answer. Pretending otherwise (a KMS-held SSH key? a tunnelled agent?)
would violate both the stateless constraint and am's security posture.

---

## Browser-side git operations: when to use API vs isomorphic-git

Rule: **prefer REST API wherever it exists. Fall back to isomorphic-git only when it
doesn't.** REST is 5–50× faster than a shallow clone for single-file reads (one HTTP
round-trip vs. the smart-HTTP negotiation), and we avoid the CORS-proxy question entirely.

```typescript
// Pseudocode — routing decision, runs once per repo connection.

type Route =
  | { kind: 'github-app';   installationId: number;  owner: string; repo: string }
  | { kind: 'gitlab-oauth'; projectId: number;       accessToken: string }
  | { kind: 'bitbucket-oauth'; workspace: string; repo: string; accessToken: string }
  | { kind: 'gitea-rest';   baseUrl: string; owner: string; repo: string; pat: string }
  | { kind: 'iso-git';      url: string; pat?: string; corsProxy?: string }
  | { kind: 'ssh-blocked';  url: string };

async function route(url: string, creds: Creds): Promise<Route> {
  const u = new URL(normalizeGitUrl(url));  // handles git@host:owner/repo form

  if (u.protocol === 'ssh:' || url.startsWith('git@'))
    return { kind: 'ssh-blocked', url };

  if (u.hostname === 'github.com')
    return { kind: 'github-app', ...creds.github, ...parseOwnerRepo(u) };

  if (u.hostname === 'gitlab.com' || await isGitlab(u))
    return { kind: 'gitlab-oauth', ...creds.gitlab, projectId: await resolveGitlabId(u) };

  if (u.hostname === 'bitbucket.org')
    return { kind: 'bitbucket-oauth', ...creds.bitbucket, ...parseWorkspaceRepo(u) };

  // Gitea/Forgejo detection: probe /api/v1/version
  if (await probeGitea(u))
    return { kind: 'gitea-rest', baseUrl: u.origin, pat: creds.pat, ...parseOwnerRepo(u) };

  // Fallback: try git smart-HTTP over HTTPS, with a CORS preflight first.
  if (await corsAllows(u))
    return { kind: 'iso-git', url: u.toString(), pat: creds.pat };

  // Last resort: Worker-hosted CORS proxy.
  return { kind: 'iso-git', url: u.toString(), pat: creds.pat,
           corsProxy: 'https://cors.am.workers.dev' };
}

// Read one file.
async function readFile(route: Route, path: string): Promise<string> {
  switch (route.kind) {
    case 'github-app':
      return gh.contents.get(route.owner, route.repo, path, await mintInstallationToken(route));
    case 'gitlab-oauth':
      return gl.files.get(route.projectId, path, route.accessToken);
    case 'bitbucket-oauth':
      return bb.src.get(route.workspace, route.repo, 'HEAD', path, route.accessToken);
    case 'gitea-rest':
      return gitea.contents.get(route.baseUrl, route.owner, route.repo, path, route.pat);
    case 'iso-git': {
      await ensureCloned(route);             // lazy shallow clone to OPFS on first use
      return opfs.readFile(`/repos/${hash(route.url)}/${path}`);
    }
    case 'ssh-blocked':
      throw new SshOnlyError(route.url);     // caller renders the banner
  }
}
```

**Storage for the iso-git path:** OPFS (Origin Private File System) — per MDN, it gives
us a proper FS handle, no 5-MB quota wall like localStorage, and isomorphic-git's `fs`
adapter can be written against it in ~80 lines. BrowserFS is the legacy alternative;
avoid it in 2026.

**CORS proxy:** we run our own fork of `@isomorphic-git/cors-proxy` on the same
Cloudflare account, restricted to authenticated session cookies so it's not a free open
proxy.

---

## Open UX questions for the maintainer

1. **Raw TOML vs structured forms.** The parallel-critique flagged the current worker
   as "raw file edit only." For am, entity types are well-typed (Server, Instruction,
   Skill, AgentProfile, Profile) and Zod schemas already exist (`src/core/schema.ts`).
   A structured form per entity is achievable and would be the killer feature vs
   "clone it locally and `$EDITOR`." Recommend: ship raw Monaco+TOML first (week 1),
   structured forms behind a toggle (week 3+), with the toggle defaulting to structured
   once the forms cover all five entity types.

2. **Commit cadence.** Every-keystroke commits pollute history; save-button commits are
   the GitHub.dev/vscode.dev model. Recommend save-button with an optional "working
   branch" mode: each session commits to `am-web/<device-id>` and a "Publish" button
   fast-forwards `main`. Uses PR flow for free when users want review; skips it when
   they don't.

3. **Parity with CLI.** Operations that touch the local FS (`am apply` writes to
   `~/.claude.json`, `~/.cursor/...`) are **impossible in the browser by definition**.
   The UI must (a) disable those buttons and (b) explain why inline: "Apply runs on
   your laptop because it writes files there. Run `am apply` after pushing, or open
   `am serve` locally." This is also the honest SSH answer.

4. **Passphrase fatigue for Tier 2 PATs.** Requiring a passphrase on every device is
   correct security but bad UX. Compromise: default to session-only (sessionStorage,
   forgotten on tab close); offer a "Remember on this device" toggle that triggers
   the passphrase + IndexedDB flow. Mirror 1Password's per-device trust model.

5. **Repo auto-detection.** For GitHub Apps, the installation targets the repo — so
   after install we already know which repo. For GitLab/Bitbucket/Gitea we list repos
   and let the user pick. Consider auto-picking if the user's account owns exactly one
   repo named `agent-manager-config` or has a `.agent-manager.toml` at root.

6. **Refresh-token rotation.** GitLab issues rotating refresh tokens (each use
   invalidates the old one). Two Worker requests in flight can race and nuke each
   other's session. Mitigation: serialize refresh via a per-session nonce in the
   cookie and retry-once on 401. Worth prototyping early — it bites production apps
   hard.

7. **Do we need GitHub OAuth App as a fallback?** A few users want to edit any random
   repo they have a PR-making relationship with but don't own. The GitHub App install
   requires repo admin. Optional second-tier "Connect with GitHub OAuth" button with
   `repo` scope covers that case, at the cost of a broader grant. Defer until someone
   asks.

---

## Sources

1. GitHub Docs — Differences between GitHub Apps and OAuth apps:
   https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
2. GitHub Docs — Deciding when to build a GitHub App:
   https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app
3. GitHub Docs — Best practices for creating a GitHub App (installation tokens):
   https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app
4. Nango blog — GitHub App vs. GitHub OAuth decision guide:
   https://nango.dev/blog/github-app-vs-github-oauth/
5. GitLab OAuth 2.0 API + scope catalogue:
   https://docs.gitlab.com/ee/api/oauth2.html
6. GitLab issue gitlab#321359 — `write_repository` insufficient to push, `api` required:
   https://gitlab.com/gitlab-org/gitlab/-/issues/321359
7. Bitbucket Cloud OAuth 2.0 + `repository:write` scope:
   https://developer.atlassian.com/cloud/bitbucket/oauth-2-connect/
8. Gitea OAuth2 Provider docs (per-instance, not federated):
   https://docs.gitea.com/development/oauth2-provider
9. Forgejo Access Token Scopes (incl. "Specific repositories" filter):
   https://forgejo.org/docs/next/user/token-scope/
10. Codeberg Access Token generation:
    https://docs.codeberg.org/advanced/access-token/
11. isomorphic-git homepage + FAQ (browser-only git, no SSH):
    https://isomorphic-git.org/docs/en/faq
12. isomorphic-git `clone` API (shallow, single-branch, CORS proxy):
    https://isomorphic-git.org/docs/en/clone.html
13. isomorphic-git CORS proxy service + blog post on origin-limiting:
    https://github.com/isomorphic-git/cors-proxy ·
    https://isomorphic-git.org/blog/2018/07/08/cors-proxy-origin-limited
14. VS Code for the Web architecture (github.dev / vscode.dev — REST API, not clone):
    https://code.visualstudio.com/docs/setup/vscode-web ·
    https://docs.github.com/en/codespaces/the-githubdev-web-based-editor
15. Cloudflare API Shield JWT validation on Workers (stateless session pattern):
    https://developers.cloudflare.com/api-shield/security/jwt-validation/jwt-worker/
16. Clerk — Authentication for serverless and edge deployments (JWT-in-cookie pattern):
    https://clerk.com/articles/authentication-for-serverless-and-edge-deployments
17. MDN — Origin Private File System (OPFS) for durable per-origin storage:
    https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
18. GitHub community discussion — PATs cannot be scoped to single repo (classic PATs;
    fine-grained PATs and GitHub App installations can):
    https://github.com/orgs/community/discussions/21999
19. GitHub `PUT /repos/{owner}/{repo}/contents/{path}` — create-or-update a file
    (single-commit REST write, used by github.dev):
    https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents
20. GitLab `POST /projects/:id/repository/commits` — atomic multi-file commit via REST:
    https://docs.gitlab.com/ee/api/commits.html#create-a-commit-with-multiple-files-and-actions
