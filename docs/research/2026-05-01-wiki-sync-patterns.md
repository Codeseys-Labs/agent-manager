---
date: 2026-05-01
status: draft
topic: wiki sync patterns for am wiki M5 upgrade
relates-to: ADR-0020, ADR-0022, src/commands/wiki.ts (syncSubcommand)
---

# Wiki sync patterns — how note-taking tools handle multi-repo git sync

## Source caveat

> **Important.** External research tooling (tavily, exa, deepwiki, context7,
> WebFetch, mcp-fetch, gemini-cli, and outbound curl/gh) was all denied in the
> session that produced this document. The research below is compiled from
> the model's prior training-data knowledge of these tools, cross-referenced
> against the local ADR-0022 design and `src/commands/wiki.ts:1009`. Every
> concrete claim about setting names, defaults, and behaviors SHOULD be
> re-verified against the linked upstream docs/repos before being committed
> to an ADR or a user-facing feature. Links are provided for that purpose.

## Design constraints (restated)

From ADR-0022 and `src/commands/wiki.ts`:

- **Single source of truth**: `~/.config/agent-manager/wiki/` is the only
  physical store. Per-project wikis are symlinks under
  `<project>/.agent-manager/wiki → <config>/wiki/projects/<name>`.
- **One git repo**: the entire AM config directory is a single git repo. The
  project-side symlink is gitignored in the project repo, so there is no
  second history to diverge.
- **Pillar overlap**: wiki sync sits on pillars 1 (catalog + git sync) and 5
  (LLM-wiki). It does **not** need to be a separate protocol; it rides the
  same `am push` / `am pull` machinery as the rest of the config — except
  today `am wiki sync` is a bespoke thin wrapper. The M5 question is whether
  wiki sync should collapse into `am push`/`am pull` or remain a distinct
  subcommand with wiki-specific defaults.

---

## 1. Obsidian Git (Vinzent03 / denolehov)

Canonical sources to verify:
- <https://github.com/Vinzent03/obsidian-git>
- <https://publish.obsidian.md/git-doc/>

### Sync model (as understood)

Obsidian Git runs entirely in-browser via **isomorphic-git** — the same
library agent-manager uses — so its constraints mirror ours.

Key settings (names as documented in the plugin's settings tab):

| Setting | Default | What it does |
|---|---|---|
| `Vault backup interval (minutes)` | `0` (off) | Periodic auto-commit timer. Users typically set 5–15 min. |
| `Auto pull interval (minutes)` | `0` (off) | Periodic auto-pull timer. |
| `Auto push interval (minutes)` | `0` (off) | Periodic auto-push timer. |
| `Commit-and-sync` (command) | manual | User-triggered: stage all → commit → pull → push, in that order. |
| `Commit message on auto backup` | `vault backup: {{date}}` | Template supports `{{date}}`, `{{hostname}}`, `{{numFiles}}`. |
| `Pull on startup` | `false` | Runs a pull immediately after Obsidian boots. |
| `Disable push` | `false` | For read-only mirrors. |
| `Line author` | `false` | Enables per-line blame hover; expensive on large vaults. |

### Auto-commit cadence

The plugin's timer is **wall-clock** (setInterval), not event-based. There is
no "commit on save" — that would thrash git. The documented trade-off is
between "commits are noisy but recent" (short interval) and "commits are
clean but risk losing edits on crash" (long interval). 5 minutes is the
community-recommended sweet spot.

### Pull-before-push

The `Commit-and-sync` command explicitly **pulls before pushing**. This is the
only place in the plugin where pull-before-push is guaranteed; the standalone
"push" command does not pull first. Users who only run periodic push without
periodic pull hit remote-is-ahead rejects routinely — one of the top three
issues in the repo tracker historically.

### Conflict UX

This is the weak spot, and it matters for us because we share the library:

- **isomorphic-git has no native 3-way merge for conflicting content.** It
  can fast-forward, it can auto-merge non-overlapping hunks, but on a real
  content conflict it throws `MergeNotSupportedError` (historically) or
  leaves the working tree untouched and fails the operation.
- Obsidian Git's response: surface a **notice** banner ("Merge conflict — see
  console") and refuse to continue. The user must resolve in a real git
  client (terminal, GitHub Desktop, VS Code) or inside Obsidian by manually
  reconciling the two versions, then run `Commit-and-sync` again.
- Recent versions ship an **in-app conflict view** listing conflicted files
  with a "open in diff" button, but the actual three-way merge is still
  offloaded — the plugin does not write conflict markers into the file.

### Known failure modes (from the repo's issue tracker patterns)

1. **Secrets committed accidentally.** If a user pastes an API key into a
   note and the auto-commit timer fires before they notice, the secret lands
   in the public GitHub mirror. The plugin has a `.gitignore` respecter but
   no secret-scanner pre-commit hook.
2. **Mid-type overwrites.** Auto-save + auto-commit race: Obsidian auto-saves
   on blur/idle; if the commit timer fires during a large edit, a
   half-written paragraph gets committed. Users notice only when pulling on
   another device reveals partial content.
3. **Line ending churn.** `core.autocrlf` interactions between Windows and
   macOS clients produce phantom diffs. isomorphic-git has limited
   normalization compared to git CLI.
4. **Binary files (PDFs, images).** Committed blindly; vaults bloat, and
   conflicts on binary files are unresolvable — plugin just fails.
5. **Submodule support is absent.** Vaults-in-vaults don't work.
6. **iOS/Android.** Mobile versions are even more constrained — no
   background tasks on iOS, so "auto-commit every 5 min" doesn't fire when
   the app is backgrounded.

### Takeaways for `am`

- Expose both an **interval** and a **manual `am wiki commit-and-sync`**
  command; do not try to "commit on every write" — that path leads to noisy
  history and partial-write commits.
- **Pull-before-push must be the default** in the combined command; separate
  `--pull-only`/`--push-only` remain for scripts.
- **We cannot rely on isomorphic-git to resolve conflicts.** On conflict,
  refuse the merge, surface the list of conflicted paths, point the user at
  `git -C <wikiDir>` or provide an `am wiki resolve` helper that opens
  `$EDITOR` on each side sequentially.
- **Pre-commit secret scan is a differentiator.** ADR-0023 already ships
  tiered secret detection; wiring it into auto-commit would avoid the
  top-1 failure mode the Obsidian Git community hits.

---

## 2. Foam (foambubble/foam)

Canonical source: <https://github.com/foambubble/foam>, docs at
<https://foambubble.github.io/foam/>.

### Sync model

**Foam ships no git sync of its own.** It is a VS Code extension over a
plain Markdown folder; users are expected to:

1. Open the folder as a VS Code workspace.
2. Use VS Code's built-in **Source Control** panel (which shells out to `git`
   CLI) to stage, commit, pull, push.
3. Optionally install the `GitLens` or `Git Graph` extensions for a richer UX.
4. Optionally install `Git Automator` / similar for auto-commit timers —
   **not Foam's job**.

### Why Foam punts on sync

The docs' "Recipes → Sync notes with git" page explicitly hands the problem
off. The reasoning (inferred from the project README and issue comments):

- VS Code's git UX is already excellent and well-understood.
- A bespoke extension-level sync would have to reimplement auth, diff viewer,
  conflict resolution, credential helpers — all things VS Code already has.
- Foam's value is in the linking graph, not the storage mechanism.
- Users span the full range from "I commit twice a year" to "commit per edit";
  forcing a policy alienates half of them.

### Takeaway for `am`

Foam's model is viable **only when a richer UI is always present**. For `am`,
the TUI/web UIs are optional; users will hit wiki sync from the CLI on
headless servers. So "punt to `git`" is not enough — `am wiki sync` must
exist and must do the right thing by default. But we **can** adopt Foam's
discipline of **not automating what the user hasn't asked for**: no auto-pull
on CLI start, no auto-commit on every file-write. Automation opt-in, not
opt-out.

---

## 3. Dendron (dendronhq/dendron)

Canonical source: <https://github.com/dendronhq/dendron>,
<https://wiki.dendron.so/>.

### Sync model

Dendron is a VS Code extension with a **multi-vault** workspace model — a
single workspace can reference many git repos (one per vault), plus remote
vaults (via git submodule-ish references). It ships a **`Dendron: Workspace
Sync`** command.

The command does (as documented):

1. For each vault, check if it has a remote.
2. Stage all changes in the vault.
3. Commit with a template message.
4. Pull with rebase.
5. Push.
6. If any vault fails, report which ones and stop.

It uses the `simple-git` npm package (shells to `git` CLI), **not**
isomorphic-git — so it inherits full three-way merge capability from the
system git. This is a capability `am` does **not** have today, because
ADR-0010 requires no system `git` dependency.

### Conflict UX

- Three-way merge delegated to system git's config (`rebase.autoStash`,
  merge drivers).
- On conflict, Dendron shows a VS Code notification with a "Open vault" link
  and leaves the files with `<<<<<<<` markers for the user to resolve in the
  built-in diff editor.
- There's a `dendron.workspace.autoPush` setting (default off) that pushes
  after each commit. The docs explicitly warn users to set it off if they
  commit secrets.

### Multi-vault model mapped to am

Dendron's multi-vault ↔ am's per-project wikis are conceptually similar, but
with a critical structural difference:

- **Dendron**: each vault is its own git repo; the workspace config lists
  them; sync iterates.
- **am / ADR-0022**: all project wikis are subdirectories of *one* git repo
  (the AM config dir). There is no per-project remote.

This means `am` **should not** copy Dendron's "iterate vaults" model — we
have one repo. But we can copy the **`Workspace Sync`** UX: one command that
stages, commits, pulls, pushes, with clear per-vault (per-project) failure
reporting. For us, "per-project" means "per sub-tree of the single repo"; we
can still show which project's pages had conflicts.

### Takeaway for `am`

Adopt the "one command, sequential phases, clear per-subtree reporting"
pattern. Reject "one repo per project" — it would fragment the single source
of truth that ADR-0022 depends on.

---

## 4. Logseq

Canonical source: <https://github.com/logseq/logseq>.

### Official Logseq Sync — not git

Logseq Sync is a **paid, hosted service** that uses the Logseq team's own
servers, not git. Architecturally:

- Blocks are the atomic unit, not files — Logseq's data model is block-based
  with each block owning a UUID.
- Sync is **CRDT-adjacent**: last-writer-wins per block by modification time,
  with server-side reconciliation; no user-visible merge step.
- End-to-end encrypted (age-based keys).
- Conflicts manifest as duplicated blocks or lost edits; the UX presents no
  explicit conflict dialog — users discover divergence via the graph or via
  two blocks with near-identical content.

### Git-plugin alternative

Community plugins (e.g. `logseq-plugin-git` and Logseq's built-in "git auto
commit" feature on the desktop app) offer a git overlay:

- Built-in desktop feature (in `Settings → Version control`): auto-commit
  every N seconds using the system git binary. Off by default.
- Plugin-level: adds "Commit / Pull / Push" buttons in the toolbar. No
  conflict UI — failures surface as plugin notices.

The upstream community has repeatedly asked for "real" git sync; the core
team's answer is that block-level CRDT sync is inherently more appropriate
for live-collaborative note-taking than file-level git. They consider git
sync a backup/archive tool rather than a primary sync mechanism — some issues
and ADR-ish design docs in the repo make this explicit.

### Takeaway for `am`

- We are not doing CRDT. Our wiki pages are files (TOML + Markdown), not
  blocks. Logseq's argument doesn't bind us.
- But their observation is useful: **for frequently-edited, multi-device
  note-taking, git sync is poor UX.** It is fine for our case (agent
  harvest writes infrequently; humans edit rarely) but if we ever offer a
  "live-edit the wiki in the web UI while an agent is harvesting to the
  same page" feature, we will need more than git.
- The "auto-commit every N seconds" toggle in the desktop app is exactly the
  pattern Obsidian Git uses, and exactly what we should offer — as an
  **opt-in** and with a minimum interval (≥60 s) to prevent accidental
  commit storms.

---

## 5. Syncthing / Resilio Sync as git alternatives

### Syncthing

Open-source peer-to-peer file sync. For notes:

- **Propagation**: bidirectional, LAN-first, NATed-through-relay fallback,
  no central server required.
- **Conflict handling**: when two devices edit the same file while
  disconnected, the later-seen write becomes the canonical file and the
  earlier write is renamed to
  `notes.sync-conflict-20260501-1423-DEVICEID.md`. The user must
  manually reconcile.
- **No history**: Syncthing keeps a configurable-size staging area of
  deleted files (`.stversions/`), but not a commit log.

### Resilio Sync

Proprietary BitTorrent-based peer-to-peer sync. Similar conflict semantics
(conflict files), similar lack of history. Has been used as an Obsidian
vault sync since Obsidian's launch.

### Tradeoffs vs git for a wiki

| Axis | Git | Syncthing / Resilio |
|---|---|---|
| History | Yes, immutable | No (only recent versions) |
| Works without network | Yes (local commits) | Peer must be reachable |
| Merge conflicts | Explicit, must resolve | Silent `.conflict` files |
| Auth / access control | SSH keys, tokens, OAuth | Folder-share keys |
| Large binaries | Poor without LFS | Fine |
| Multi-device live edit | Poor (merge churn) | Good |
| Disaster recovery | Excellent (remote repo) | Only as good as surviving peers |
| Secret hygiene | Can scan on commit | Propagates whatever is on disk |

### Why users pair them rather than pick one

A common pattern in the Obsidian community is: **Syncthing for real-time
device-to-device propagation (so edits on phone appear on desktop in
seconds) + git running in a cron or on save for history + off-site backup.**
The two systems then race — Syncthing can propagate mid-commit index files
(`.git/index.lock`) and cause git errors. Users work around this by adding
`.git/` to Syncthing's ignore list and relying on `git pull` to sync history,
while Syncthing propagates only the working tree.

### Takeaway for `am`

- Do not bundle Syncthing/Resilio. Git is the right choice for our usage
  pattern (infrequent writes, offline-first, audit trail required).
- **Do** document the "Syncthing + git" pattern as a supported
  advanced configuration, with explicit guidance to add `.git/` to the
  Syncthing ignore list. Users who want sub-second propagation will reach
  for this regardless; we should tell them how to do it safely.

---

## 6. Auto-commit-before-pull: failure modes catalog

Synthesized from the above, ordered by severity:

1. **Secret exposure (S1).** User pastes an API key into a wiki page; the
   next auto-commit captures it; auto-push ships it to a public mirror
   within the sync interval. *Mitigation*: pre-commit run of ADR-0023's
   secret detector on staged-for-auto-commit files; block auto-commit if
   any secret is found; surface as a notification. Interval-based commit
   loops SHOULD fall back to "commit but do not push" on detection.

2. **Mid-edit overwrite (S2).** Auto-commit fires during a large paste or
   multi-line edit; the half-state lands in history and then overwrites
   the other device on next pull. *Mitigation*: track wall-clock time of
   last file-modification and **skip auto-commit** on files modified in
   the last `N` seconds (idle debounce). Match Obsidian Git's undocumented
   60-second debounce.

3. **Commit-storm on rename / bulk-import (S3).** Harvester writes 200
   pages in a burst; auto-commit interval fires mid-way; two commits show
   half the bulk import each. *Mitigation*: harvest should wrap its own
   batch in an explicit commit boundary (already half-true in
   `harvester.ts`; should be made total by disabling the interval during
   harvest).

4. **Divergent histories (S4).** Machine A auto-commits + pushes; machine B
   auto-commits before pulling. Push fails on B; next pull requires merge;
   isomorphic-git refuses. User has a dirty working tree they didn't
   intentionally create. *Mitigation*: pull-before-push atomically; if the
   pull fails, roll back the auto-commit (`git reset --soft HEAD^` via
   isomorphic-git) and surface the conflict.

5. **Binary / large-file churn (S5).** Not a primary risk for us — wiki
   pages are TOML + Markdown. But `index.json` (MiniSearch) is a serialized
   binary-ish blob that regenerates on every harvest. *Mitigation*: either
   (a) `.gitignore` the index and rebuild on pull, or (b) commit a stable
   canonical serialization. Option (a) is simpler.

6. **Clock skew (S6).** Syncthing hybrid config or laptops with wrong
   system clocks produce commits with timestamps in the future; git log
   looks wrong but nothing actually breaks. Low priority.

---

## 7. Dual-store global + per-project: how to avoid divergent histories

The existing ADR-0022 answer is the correct one: **symlinks into one physical
tree and therefore one git repo**. Divergent histories only emerge if we
introduce a second physical location. Three failure scenarios to guard
against:

### 7a. Symlinks replaced by real directories on Windows / across rsync

If a user (or a backup tool) resolves the symlink and replaces it with a
real copy, we have two independent trees and future writes split. `am
doctor` already planned to check symlink targets (ADR-0022 Negative section);
**extend it to detect when `.agent-manager/wiki` is a directory rather than
a link and refuse to operate until reconciled**. Provide an `am wiki relink
--force` that merges the divergent copy back (copy newer files in, commit in
the central repo, then replace with a symlink).

### 7b. Per-project remotes

Users will ask for this: "I want project X's wiki to live in my work GitHub,
but the global wiki in my personal GitHub." ADR-0022 says no — one repo, one
remote. If we relent:

- The per-project directory would need its own `.git/` — breaks ADR-0022.
- OR we keep one repo but push subtrees via `git subtree split → push` on
  demand. This is **not** a sync, it's an export. Document it as such;
  `am wiki export --project X --to <remote>` one-way.

**Recommendation**: do not add per-project remotes. If a user needs it,
give them the subtree-export escape hatch and document that it is one-way.

### 7c. The web UI writing while the CLI is pulling

Stateless web UI (ADR-0015) commits via the GitHub API directly. If the
local CLI is mid-pull while the web UI commits, the local clone falls
behind but doesn't conflict (web UI wins because it committed on `origin`).
Next local pull picks it up. **Safe — no mitigation needed** as long as the
web UI never pushes local uncommitted state (it can't; it has none).

---

## 8. Recommended M5 upgrade sketch

Dropping in for `am wiki sync` (the TODO at
`src/commands/wiki.ts:1009`):

```
am wiki sync [--direction push|pull|both|commit-and-sync]
             [--auto-commit | --no-auto-commit]
             [--allow-dirty]
             [--scope global|project|all]
```

**Default behavior** (`am wiki sync` with no flags):

1. Resolve scope. Default `all` — we sync the entire wiki tree, not just
   one project's subdir, because it's one repo.
2. If working tree is dirty, **auto-commit unstaged wiki files** — but:
   - Skip files modified in the last 60 seconds (debounce).
   - Run ADR-0023 secret detector on staged set; abort if hits.
   - Commit message: `wiki: auto-sync N page(s) ({{hostname}} {{date}})`.
3. Pull with fast-forward-only (`ff: "only"` in isomorphic-git terms).
4. If pull fails with non-FF or merge required:
   - Do NOT attempt a 3-way merge (library can't).
   - Roll back the auto-commit (`git reset --soft HEAD^` equivalent).
   - Report "wiki: remote has diverged; resolve with `am wiki resolve`
     or `git -C <wikiDir>` and re-run."
5. Push. If push fails non-FF (race with another machine), pull again once
   and retry push; on second failure, bail.

**Explicit flags**:

- `--direction push` / `pull`: bypass auto-commit, run only the named step.
- `--no-auto-commit`: require the working tree to be clean; fail otherwise.
- `--allow-dirty`: pull/push with dirty tree (current behavior — warn).

**New subcommand `am wiki resolve`**: list conflicted paths from the last
failed sync; for each, open `$EDITOR` on the local version first, then the
incoming version (two-pass), then stage + commit. Do not try to produce
three-way conflict markers via isomorphic-git; instead provide a simple
"pick local / pick remote / edit each" TUI prompt, similar to how `git add
-p` works.

**Periodic auto-sync** (optional, follow-up): a `settings.wiki.auto_sync` in
`config.toml` that, when running `am serve`/`am mcp-serve`, fires
`am wiki sync` on an interval. Disabled by default. Minimum interval 60 s
enforced.

**Scope: dual-store integrity**:

- `am doctor` must detect if `.agent-manager/wiki` is a regular directory
  instead of a symlink (per 7a above).
- `am wiki sync` on the global-only scope is a no-op alias for the default
  sync; the message should explain that global and project wikis share one
  repo.

---

## 9. Open questions that external sources would help answer

The following questions were explicitly asked in the brief and **could not
be answered from training-data knowledge with the confidence level the
caller needs**. Each should be re-investigated with primary sources before
committing to an M5 design:

1. What does Obsidian Git 2.x specifically do on a conflict detected during
   `Commit-and-sync` — does it roll back the local commit, or leave it?
   Look at `src/commitAndSync.ts` in `Vinzent03/obsidian-git`.
2. Does Dendron's `Workspace Sync` use `pull --rebase` or `pull` (merge) by
   default? This changes the failure mode profile.
3. What is the current state of isomorphic-git's merge support as of its
   latest release? `merge()` has been iterated on since 1.0; the
   "no 3-way merge" claim may be outdated and worth verifying.
4. Has the Logseq desktop app's built-in git feature gained conflict
   resolution UI since late 2024? If yes, its pattern might be worth
   copying.
5. What npm packages exist today that wrap isomorphic-git with a real
   conflict-resolution front-end (beyond what the library provides)? We
   might be able to depend on one rather than build from scratch.

---

## 10. Summary — design constraints and recommended approach

**Constraints** (hard):

- One git repo, one remote (ADR-0022 stands). No per-project remotes.
- isomorphic-git only (ADR-0010). Cannot delegate to system git.
- Therefore: **no automatic three-way merge possible** — design around it.

**Recommended approach** (for the M5 upgrade):

- **Auto-commit policy**: opt-in timer (default off); ≥60 s debounce on
  per-file modification time; mandatory pre-commit secret scan via
  ADR-0023; auto-commit is **always** followed by a pull-before-push in the
  same operation, and is rolled back if the pull rejects.
- **Conflict strategy**: detect early (fast-forward-only pull), refuse to
  merge, list conflicted paths, offer `am wiki resolve` with a pick-side
  TUI. Never write three-way conflict markers we can't produce reliably.
- **Dual-store ordering**: the symlink guarantees a single physical tree, so
  sync is a single operation on the AM repo. Add an `am doctor` check that
  the project-side symlink has not been flattened into a real directory —
  that is the one way a second history could emerge, and it should be
  treated as a hard error.

## References

### Local
- `ADRs/0022-wiki-location-strategy.md` — dual-store with symlinks
- `ADRs/0020-session-knowledge-synthesis.md` — wiki storage layout
- `ADRs/0023-tiered-secret-detection.md` — secret scanner to wire in
- `ADRs/0010-bunts-single-binary.md` — why we're stuck with isomorphic-git
- `src/commands/wiki.ts:1009` — current sync (to replace)
- `src/core/git.ts` — isomorphic-git wrappers
- `src/core/secret-detection.ts` — ADR-0023 scanner

### External (to be re-verified)
- <https://github.com/Vinzent03/obsidian-git>
- <https://publish.obsidian.md/git-doc/>
- <https://github.com/foambubble/foam>
- <https://foambubble.github.io/foam/recipes/sync-notes-with-git>
- <https://github.com/dendronhq/dendron>
- <https://wiki.dendron.so/>
- <https://github.com/logseq/logseq>
- <https://docs.logseq.com/>
- <https://isomorphic-git.org/docs/en/merge>
- <https://docs.syncthing.net/users/syncing.html>
