[reviewer: google/gemini-3.1-pro-preview]

# Lens B: Web-Editing-a-Git-Repo User Experience

This research note explores how real-world tools handle the UX of editing Git-backed repositories directly from the browser, identifying essential patterns that `agent-manager` (am) should inherit, adapt, or avoid. Our focus is specifically on stateless architectural constraints, multi-platform abstractions (GitHub/GitLab/Gitea), auth strategies, and conflict resolution mechanisms.

## 1. Existing Browser-Edits-a-Repo UX in Production

The industry has bifurcated into two approaches: full Web IDEs (which often spin up containers) and Git-backed Headless CMSs (which interact directly with Git APIs or via `isomorphic-git`).

### Web IDEs / Cloud Environments
*   **github.dev & github.com codespaces:** 
    *   **Auth:** Integrated implicitly with the logged-in GitHub session (OIDC/internal tokens).
    *   **Commit UX:** Follows the VS Code Source Control paradigm. Users stage files, author a commit message, and hit 'Commit & Push'. 
    *   **Conflicts:** Surfaced beautifully via VS Code's standard 3-way merge editor. If a push is rejected, the user is prompted to pull, which triggers the merge visualizer.
*   **GitLab Web IDE:** Based on VS Code in the browser. Similar UX to `github.dev`.
*   **Gitpod / StackBlitz / CodeSandbox:**
    *   **Auth:** Requires OAuth linking to GitHub. 
    *   **Commit UX:** CodeSandbox and StackBlitz utilize environments heavily tied to specific branches. CodeSandbox provisions distinct VMs per branch, meaning conflicts often result in opening a PR rather than direct conflict resolution against `main`. StackBlitz leverages WebContainers, allowing `isomorphic-git` like behavior in the browser, but often pushes users toward the PR workflow on push failure.

### Git-backed Headless CMSs
*   **Decap CMS (formerly Netlify CMS):**
    *   **Auth:** OAuth via a dedicated backend (Netlify Identity or custom OAuth client) or PATs. It relies on GitHub/GitLab REST APIs.
    *   **Commit UX:** "Save" or "Publish". Under the hood, it creates a commit using the platform's API (e.g., GitHub Tree API) to bypass the need for a full clone.
    *   **Conflicts:** Decap CMS is notoriously poor here. Historically, if the base tree is out of date, it simply fails (or overwrites, depending on the backend implementation version). It lacks a UI for resolving merge conflicts, pushing users to use the 'Editorial Workflow' (drafts = PRs) to avoid direct-to-main conflicts altogether.
*   **TinaCMS:**
    *   **Auth:** TinaCloud (OAuth) or Local Mode (file system). For direct-to-GitHub in the browser without TinaCloud, it requires a PAT or OIDC setup.
    *   **Commit UX:** Auto-saves and commits (often configurable). 
    *   **Conflicts:** If the lockfile or tree is out of sync, the API rejects the write. The UX usually involves a generic error asking the user to refresh (losing work) or fallback to a separate UI. 
*   **Sveltia CMS:**
    *   **Auth:** Designed as a drop-in replacement for Decap using Svelte. Inherits similar API-driven GitHub/GitLab interactions.
    *   **Commit UX:** Similar to Decap—form submission triggers API commits.
    *   **Conflicts:** Largely mirrors Decap's limitations. Since these tools don't hold the full Git history client-side, 3-way merges are exceptionally difficult to build.

## 2. Hosted-CMS-on-Git Pattern: The API Abstraction

Tools like Decap CMS do not run `git push` over HTTPS in the browser. Instead, they abstract Git operations over the hosting platform's REST/GraphQL APIs.

*   **The Abstraction:** They implement a "Backend" interface (e.g., `GitHubBackend`, `GitLabBackend`). 
*   **The Write Flow:**
    1.  Get the SHA of the latest commit on the branch.
    2.  Get the SHA of the root tree.
    3.  Create Blobs (files) for the changed content via API.
    4.  Create a new Tree holding the new Blobs, based on the previous root tree.
    5.  Create a Commit pointing to the new Tree and the previous Commit as parent.
    6.  Update the Branch Ref to point to the new Commit.
*   **Conflict Resolution UX:** This API-driven approach breaks if step 6 fails (someone else updated the branch ref between steps 1 and 6). Because there is no local Git index, the CMS UX typically throws a fatal error: *"Failed to save: Branch has been updated."* The user must copy their text, refresh, and try again.

## 3. OAuth vs PAT vs GitHub-App for Browser-Side Write

For a stateless Cloudflare Worker hosting `am.example.com` that needs to write to an external Git provider:

*   **GitHub App OIDC:** **The Gold Standard for GitHub.** Assuming the user installs the App on their repo, the Worker can mint short-lived tokens. It provides granular permissions and avoids users handling tokens. UX: Highest (1-click auth).
*   **OAuth Apps:** Good, but requires a backend to handle the `client_secret` exchange securely. Since the Worker is stateless, it *must* act as a proxy for the OAuth flow, trading the code for a token and passing it back to the client (stored in memory/sessionStorage). UX: High (Standard login).
*   **Fine-Grained PATs:** Universally works across GitHub/GitLab without requiring App registration. However, the UX is terrible. Users must leave the app, navigate complex token creation UI, copy, and paste. UX: Low.
*   **SSH:** Irrelevant for browser environments as WebSockets/WebRTC don't map cleanly to raw SSH protocols without a stateful proxy.

## 4. Multi-Platform Abstraction & Transport

Where is the line between REST APIs and `isomorphic-git`?

*   **Platform REST APIs (GitHub/GitLab):** 
    *   *Pros:* Extremely fast for single-file edits. Bypasses CORS issues (usually). Capable of reading branch protection rules and opening PRs natively.
    *   *Cons:* Requires building a specific backend adapter for every supported platform.
*   **`isomorphic-git`:**
    *   *Pros:* A universal abstraction. Works with any standard Git server (Gitea, Codeberg, custom hosting).
    *   *Cons:* Slower (requires cloning/fetching objects client-side). Requires CORS-enabled proxies to communicate with standard Git servers. Cannot natively handle platform-specific features like "Require 1 reviewer".

**The Line:** CMSs use REST APIs because they assume a specific ecosystem. A tool like `am` that supports Gitea/Codeberg *must* rely on either `isomorphic-git` (with a CORS proxy) for the long-tail, or build a specific Gitea API adapter. 

## 5. Conflict UX in CMS-on-Git

The stale base problem: User A opens editor on at Commit X. User B pushes Commit Y. User A clicks Save. 

*   **Auto-rebase:** Dangerous for non-text files; brittle to implement in-browser without full `isomorphic-git`.
*   **Force Overwrite:** Unacceptable for configuration files; leads to silent data loss.
*   **Show Diff (The IDE way):** Difficult to generate without a local Git engine.

**The *Least Confusing* Pattern for a Stateless Web App:**
1.  Attempt the API commit.
2.  If rejected (409 Conflict / Ref updated): **Freeze the UI.**
3.  Display: *"The configuration has been updated by someone else since you started editing."*
4.  Option A: **"Open PR instead."** (Create a new branch with the user's changes and open a PR against main. Safest, handles conflicts via GitHub UI natively).
5.  Option B: **"Discard my changes and reload."**
6.  *Do not* attempt in-browser 3-way merges unless you are using `isomorphic-git` fully AND the files are strictly structured.

## 6. Editor Surface Choices for TOML

Editing a TOML configuration requires specific affordances:

*   **CodeMirror 6:** The sweet spot. Extremely lightweight bundle size compared to Monaco. Highly modular. Excellent for stateless environments. Building a TOML language server / schema validator integration is straightforward via Linter extensions.
*   **Monaco:** Massive bundle size. Overkill unless providing a 'full IDE' experience. Getting it to run smoothly on a CF Worker served site requires significant chunking effort.
*   **Lexical:** Built for rich-text (WYSIWYG). Completely inappropriate for raw TOML editing.

## 7. OIDC vs PAT for Self-Hosted Gitea/Codeberg

*   Gitea (1.20+) includes an OAuth2 provider. 
*   Codeberg and Forgejo inherit this.
*   *Are they sufficient?* Yes, if the administrator configures the OAuth app. However, in a SaaS model (`am.example.com`), configuring an OAuth App on *every user's* private Gitea instance is a UX nightmare (they have to register `am.example.com` as a client on their server, then give `am` the Client ID/Secret).
*   *Conclusion:* For self-hosted instances connected to a centralized SaaS, **PATs are virtually unavoidable** unless the user is willing to hand-configure OAuth clients.

## 8. Branch Protection / Required-Checks

If the `main` branch is protected (e.g., requires reviews), direct API commits will fail.

*   **Detection:** The tool must attempt the write, catch the specific HTTP 403/422 error related to branch protection, or pre-flight query the repository settings API.
*   **CMS Handling (e.g., Decap):** Relies on the "Editorial Workflow." If enabled, it never commits to `main`. It *always* creates a branch (e.g., `cms/feature-name`) and opens a PR.
*   **Auto-Switch UX:** If a direct push fails due to protection, the UI should instantly pivot: *"Direct push disabled on this branch. We will create a Pull Request instead."* 

---

## KEY RECOMMENDATIONS FOR AM

1. **Use Platform REST APIs over `isomorphic-git` where possible.** For GitHub (via App) and GitLab, the Tree APIs are vastly faster for small TOML edits than cloning via `isomorphic-git`. Reserve `isomorphic-git` strictly as a fallback for generic Gitea instances.
2. **Adopt the "Always Be PR-ing" fallback for conflicts.** Do not build an in-browser merge editor. If a write fails due to `stale base` (conflict) or `branch protection`, automatically offer to create a new branch and open a PR. Outsource the merge resolution to GitHub/GitLab's native UI.
3. **Select CodeMirror 6 with TOML Schema Validation.** Avoid Monaco's bundle bloat. CM6 provides sufficient syntax highlighting and schema validation (via a Web Worker linter mapping to `@iarna/toml` or similar) while keeping the Cloudflare static site lightning fast.
4. **Use GitHub App OIDC for GitHub, require PATs for Gitea/Codeberg.** Do not attempt to coordinate OAuth client registration across self-hosted Gitea instances. Allow users to paste a PAT for custom hosts, but use the seamless App flow for the primary platforms.
5. **Implement Pre-flight Checks for Branch Protection.** Before allowing the user to begin editing, query the REST API to see if the branch is protected. If yes, visually shift the UI to "Suggest Edit (PR Mode)" to prevent the user from expecting a direct save.
6. **Abstract the 'Save' Action.** The interface between the UI and the transport layer must be `async save(content) -> Result<CommitSHA, NeedsPR_Conflict | NeedsPR_Protection>`. The UI reacts to the error states by spawning the PR workflow.