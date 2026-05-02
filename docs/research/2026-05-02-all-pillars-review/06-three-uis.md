# Pillar 6 — Three UIs over one core

Starting point: the Wave 1 adversarial review said Pillar 6 got zero recent attention. My read: some deferral was wise while Pillars 1-5 hardened, but Pillar 6 is now real user-facing debt.

## 1. What’s good today
- The shared admission layer is real for local surfaces: `withConfig` and `applyResolved` serialize RMW/apply and replaced parallel pipelines (`src/core/controller.ts:1-14`, `src/core/controller.ts:178-191`); the TUI routes delete/import/apply through it (`src/tui/index.tsx:51-60`, `src/tui/index.tsx:175-182`).
- TUI data is not fake: it loads resolved config, active profile, git status, and adapter drift (`src/tui/data.ts:44-123`).
- Local web has useful APIs: config/servers/status/apply/pull/push/SSE/wiki endpoints are present (`src/web/server.ts:141-166`, `src/web/server.ts:376-427`, `src/web/server.ts:498-543`, `src/web/server.ts:603-670`).
- Cloudflare stateless design mostly lands: encrypted cookie session, provider registry, and GitHub/GitLab/Codeberg/Gitea abstraction (`src/web/worker.ts:1-8`, `src/web/worker.ts:178-187`, `src/web/git-providers.ts:15-88`).
- The web page has dark mode, responsive wiki bits, and safe DOM-based wiki rendering (`src/web/public/index.html:20-31`, `src/web/public/index.html:296-306`, `src/web/public/index.html:1072-1163`).

## 2. Rough for a new TUI user
1. Help/status can trap users: global input is active only on dashboard, while HelpView/StatusView print `[q/Esc] back` but have no input handler (`src/tui/App.tsx:128-176`, `src/tui/HelpView.tsx:63-65`, `src/tui/StatusView.tsx:145-147`).
2. Shortcuts are dense, case-sensitive, and footer-only (`src/tui/Dashboard.tsx:269-274`).
3. Add/edit are CLI escapes, not flows (`src/tui/index.tsx:47-49`, `src/tui/Dashboard.tsx:140-145`).
4. Feedback is ephemeral: toasts vanish after 3s, no action log/progress/cancel (`src/tui/App.tsx:43-76`).
5. Tab semantics are inconsistent: Tab/1-3 handling only works from dashboard (`src/tui/App.tsx:163-176`).
6. After import/sync/apply, data is mostly not reloaded, so the dashboard can feel stale.

## 3. Rough for web users
1. Local web is effectively broken for first contact: APIs require Bearer auth, the browser fetches without it, and `am serve` prints only the URL (`src/web/server.ts:91-116`, `src/web/public/index.html:460-463`, `src/commands/serve.ts:36-42`).
2. Cloud login UI is hardcoded to GitHub despite multi-provider backend support (`src/web/public/index.html:317-320`, `src/web/worker.ts:178-187`).
3. Users cannot tell clearly whether they are local, Worker, which provider, or why Apply is local-only (`src/web/public/index.html:768-771`; `ADRs/0015-stateless-web-ui.md:66-83`).
4. Server create/update/delete APIs exist, but the UI exposes only apply/pull/push (`src/web/server.ts:168-289`, `src/web/public/index.html:383-390`).
5. Cloud wiki likely misses its own adapter state: `cloudMode`/`selectedRepo` are local variables, but WikiAPI reads `window.cloudMode/window.selectedRepo` (`src/web/public/index.html:670-671`, `src/web/public/index.html:823-835`).
6. Mobile effort mostly covers wiki columns, not core server/status tables (`src/web/public/index.html:296-306`, `src/web/public/index.html:367-381`).

## 4. Zero-attention question
Pillar 6 is half-baked, with local web bordering on stub-ware because the static UI cannot authenticate to its own API. TUI is usable for viewing but not delightful for editing. Cloudflare has serious backend scaffolding, but the skin is thin and conflict/error UX is absent. The parked wiki browser doc explicitly lists the missing/fragile surfaces: cloud has minimal metadata, client-only search, no graph (`docs/designs/2026-04-16-wiki-browser/wiki-browser-design.md:127-140`), plus planned sort/history/editing gaps (`docs/designs/2026-04-16-wiki-browser/wiki-browser-design.md:96-99`, `docs/designs/2026-04-16-wiki-browser/wiki-browser-design.md:317-333`, `docs/designs/2026-04-16-wiki-browser/wiki-browser-design.md:440-445`).

## 5. Multi-device / multi-user
Two local users can share the catalog via git if they pull/apply on each machine. Cloudflare can let a team of 5 log in to the same repo, but it writes directly to `main` by reading file metadata then PUTing `config.toml`; conflicts return raw “Commit failed” 500 with no merge/retry UX (`src/web/worker.ts:490-517`). So: possible for a disciplined team, not delightful or team-safe.

## 6. Top 3 improvements
1. **Local web auth boot.** Problem: blank/misleading dashboard. Fix: one-time tokenized URL or HttpOnly local cookie seeded by `am serve`. Acceptance: fresh `am serve` opens and loads servers without manual headers.
2. **TUI navigation/feedback pass.** Problem: traps and vanishing feedback. Fix: central key router, action log, reload-after-mutating-action. Acceptance: q/Esc works from every view; tests cover help/status exits.
3. **Cloud onboarding/conflicts.** Problem: GitHub-only UI and unsafe team edits. Fix: provider buttons from `/auth/providers`, persistent repo banner, branch/SHA conflict retry UI. Acceptance: GitHub/GitLab/Codeberg buttons render; concurrent edit shows actionable conflict, not 500.

## References
ADRs: `ADRs/0015-stateless-web-ui.md`, `ADRs/0018-tui-framework-silvery.md`, `ADRs/0025-worker-multi-backend-auth.md`. Code/design paths cited inline.
