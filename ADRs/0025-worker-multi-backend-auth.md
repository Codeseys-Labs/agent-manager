---
status: accepted
date: 2026-04-13
---

# ADR-0025: Stateless Web Worker Multi-Backend Git Authentication

## Context

The stateless web worker (ADR-0015) accesses the user's private AM config repo via
git provider APIs. The initial implementation only supports GitHub OAuth. Users may
host their AM config repo on GitLab, Codeberg, self-hosted Gitea, or other git
platforms.

The worker is fully stateless — it stores the OAuth access token in an encrypted
cookie, not server-side. Adding multi-backend support requires knowing which
provider the session belongs to without any server-side state.

## Decision

### Provider abstraction pattern

A `GitProvider` interface defines the full surface each backend must implement:
OAuth flow URLs, API endpoint construction, response parsing, auth header format,
and token exchange mechanics.

Each provider is a plain object implementing this interface. Providers are registered
in a runtime registry. Pre-built providers ship for GitHub, GitLab, and Codeberg.
Self-hosted Gitea instances can be registered dynamically via env var (`GITEA_URL`).

### Session cookie includes provider

The encrypted session cookie stores `{ token, provider, created }` instead of just
`{ token, created }`. The `provider` field identifies which git backend to route
API calls through. Sessions created before this change (no `provider` field) default
to `"github"` for backward compatibility.

### Provider-parameterized routes

OAuth routes become `GET /auth/:provider/login` and `GET /auth/:provider/callback`.
The CSRF state cookie also stores the provider name to prevent cross-provider
callback attacks.

A new `GET /auth/providers` endpoint returns which providers are available based on
which env vars are configured. The login page uses this to show buttons for each
configured backend.

### Credential configuration

Each provider needs its own OAuth client ID and secret:

| Provider | Env vars |
|----------|----------|
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| GitLab | `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` |
| Codeberg | `CODEBERG_CLIENT_ID`, `CODEBERG_CLIENT_SECRET` |
| Self-hosted Gitea | `GITEA_URL`, `GITEA_CLIENT_ID`, `GITEA_CLIENT_SECRET` |

Only providers with both client ID and secret configured appear in the available
providers list. If only `GITHUB_CLIENT_ID` is set, only GitHub login is available —
full backward compatibility.

### API normalization

All API routes (`/api/repos`, `/api/config/:owner/:repo`, `/api/wiki/*`) read the
provider from the session and delegate URL construction and response parsing to the
provider abstraction. The auth middleware extracts both `token` and `provider` from
the session and attaches them to the Hono context.

### Supported backends

| Backend | OAuth type | API style | Auth header |
|---------|-----------|-----------|-------------|
| GitHub | OAuth App | REST v3 | `Bearer <token>` |
| GitLab | OAuth2 | REST v4 | `Bearer <token>` |
| Codeberg | OAuth2 (Gitea) | Gitea API v1 | `token <token>` |
| Self-hosted Gitea | OAuth2 (Gitea) | Gitea API v1 | `token <token>` |

Gitea and Codeberg share the same API shape via `createGiteaProvider(baseUrl)`,
making it trivial to add new Gitea-compatible instances.

## Consequences

### Positive

- Users can host their AM config repo on any supported git platform
- Self-hosted Gitea/Forgejo instances supported via env var configuration
- Backward compatible: existing GitHub-only deployments work unchanged
- Provider abstraction makes adding new backends straightforward
- Session cookie is still stateless — no server-side storage changes

### Negative

- More env vars to configure for multi-provider deployments
- Each provider's OAuth app must be registered separately
- Token exchange format differs between providers (JSON vs form-encoded)
- API differences may surface edge cases (e.g., GitLab pagination, Gitea tree limits)

### Neutral

- The `GitProvider` interface is intentionally broad to cover all current operations;
  new operations may require extending it
- Provider registry is mutable at runtime (for self-hosted Gitea) but in practice
  is only modified once during worker initialization

## Alternatives Considered

- **Single generic OAuth2 provider with config:** Rejected — the API endpoints and
  response formats differ enough between GitHub, GitLab, and Gitea that a generic
  approach would require extensive configuration for each operation, not just auth.
- **Separate worker deployments per provider:** Rejected — defeats the purpose of
  a single web UI that can handle any git backend. Would complicate deployment.
- **Server-side provider routing via URL prefix (e.g., `/github/api/repos`):**
  Rejected — the session already knows the provider, so embedding it in every URL
  is redundant and breaks existing clients.

## References

- [ADR-0015](0015-stateless-web-ui.md) — Stateless web UI architecture
- [ADR-0013](0013-git-platform-adapters.md) — Git platform adapters (CLI-side)
- [GitHub OAuth documentation](https://docs.github.com/en/apps/oauth-apps)
- [GitLab OAuth2 documentation](https://docs.gitlab.com/ee/api/oauth2.html)
- [Gitea OAuth2 documentation](https://gitea.io/en-us/)
