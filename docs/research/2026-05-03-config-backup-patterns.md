# Config Backup-Before-Overwrite Patterns

**Date:** 2026-05-03
**Author:** research agent
**Status:** research — input to ADR/issue #1 remediation, not a decision yet
**Scope:** what "snapshot before overwrite" looks like in terraform /
ansible / chezmoi / stow / dotter / kubectl, and a concrete recommendation
for agent-manager's `am apply` given issue #1 (global MCP config wiped by
a re-apply that ignored user-made edits).

> **Sandbox caveat.** External research tooling (tavily, exa, context7,
> WebFetch, fetch) was denied permission in the environment this doc was
> produced in. The prior-art analysis below is drawn from model training
> knowledge and is tagged **\[unverified\]** wherever a decision record
> citing it would want a doc-page URL. The *grounded* portion — what
> agent-manager's write path looks like today, and where a backup hook
> should sit — is drawn directly from
> `src/core/atomic-write.ts`, `src/commands/apply.ts`, and
> `src/adapters/*/export.ts`, which were read directly.

---

## 0. Why this matters for agent-manager

Issue #1 ("global MCP config wiped") is the *inverse* of the drift problem
covered by ADR-0006. Drift detection protects against us silently clobbering
user-made edits **when we can see them**. Issue #1 is about the case where
we ran `am apply` anyway — via `--force`, via an incorrect drift classifier,
via a concurrency race, or (most commonly) because the user did not realize
their IDE had already mutated the native config since the last apply.
Once we `rename(tmp, ~/.claude.json)`, the old bytes are gone. That is a
one-way door — a `.backup/` snapshot is the "get out of jail" card.

Agent-manager already has the right choke point: **every adapter writes
via `atomicWriteFile` / `atomicWriteFileSync` in
`src/core/atomic-write.ts`**. Any backup policy lives there, not in 13
separate exporters.

---

## 1. Prior art

### 1.1 Terraform — single rolling backup, local-backend default **\[unverified — training knowledge\]**

The `local` backend (the default when no remote backend is configured)
writes state to `terraform.tfstate` and, immediately before overwriting
it during `apply`, copies the prior contents to `terraform.tfstate.backup`
in the same directory. Key traits:

- **Count = 1.** Only the most recent prior state is retained. Older
  backups are discarded.
- **Co-located.** Backup sits next to the live file, not in a central
  snapshot vault.
- **Same filesystem.** Copy-then-rename semantics keep the backup on the
  same device so disk-full failures don't leave torn state.
- **No timestamp.** Name is fixed. Users who want history use version
  control (or a remote backend with versioning, e.g. S3 + versioning).

Takeaway: Terraform deliberately trades retention for simplicity. It
assumes durable history is "someone else's problem" (git, S3 versioning).

### 1.2 Ansible `backup=yes` — timestamp-per-edit, same directory **\[unverified\]**

Modules like `copy`, `template`, `lineinfile`, `blockinfile` accept a
`backup: yes` parameter. When set, Ansible writes the prior file to a
sibling with a timestamp suffix, e.g.
`/etc/nginx/nginx.conf.12345.2026-05-03@14:22:07~`. Traits:

- **Count = unbounded.** Every `backup=yes` run leaves a new file. No
  automatic rotation — operators are expected to age them out with
  `find -mtime` or a housekeeping playbook.
- **Same directory as target.** Permissions and ownership are preserved
  so the backup is readable by the same people as the original.
- **Timestamp + PID.** Filename includes both a unix epoch (PID-ish
  integer) and a human-readable date, precisely to avoid collisions on
  rapid re-runs within the same second.
- **Opt-in.** Default is off — the expectation is that playbook authors
  who want backups ask for them.

Takeaway: Ansible's model scales poorly on a laptop (clutters the
target directory), but the collision-safe timestamp+PID naming is
battle-tested.

### 1.3 chezmoi — no byte-level backup, but "diff before apply" + source-repo history **\[unverified\]**

chezmoi doesn't ship a `--backup` flag. Its argument is structural:

- The **source state** lives in a git repo (`~/.local/share/chezmoi`),
  so "what I intended to write" is always recoverable via `git log`.
- **`chezmoi apply --dry-run`** and **`chezmoi diff`** let you preview
  before writing, reducing the need for a post-hoc rescue.
- For the destination side, chezmoi assumes the user owns the machine
  and edits flow back via `chezmoi add` / `chezmoi re-add`.

Takeaway: this works when the user owns both ends. Agent-manager does
*not* — Claude Code, Cursor, etc. mutate the native configs under us,
so "dry-run preview" is insufficient by itself: the race is real.

### 1.4 GNU Stow / dotter — conflict detection, not backup **\[unverified\]**

Symlink-based managers don't typically back up: they refuse to overwrite.

- **Stow:** if a target file exists and is *not* a symlink into the
  package, stow aborts. The user is expected to move the file aside
  ("adopt"), then re-stow.
- **Dotter:** similar; has a `force` flag but does not snapshot first.

Takeaway: this is a viable design *if* you're willing to make every
conflict a user-facing prompt. Agent-manager ran with "write and hope"
so far; adding backup is a weaker-but-friendlier alternative to
full stow-style refusal. Both can coexist: drift detected → prompt;
drift overridden (`--force`) → snapshot first.

### 1.5 kubectl apply --dry-run, `helm --atomic` — declarative rollback via the server **\[unverified\]**

Cluster tooling doesn't back up files on disk; it pushes state to an
apiserver that keeps prior revisions (`ReplicaSet` history, Helm
release history). `helm rollback <release> <revision>` is the "undo
button". This model is unavailable to us — no central server owns the
native IDE configs.

### 1.6 Package managers (`dpkg`, `rpm`) — `.dpkg-old` / `.rpmsave` **\[unverified\]**

When a package upgrade ships a new default config and the user has
modified the on-disk copy, `dpkg` writes the upgraded version to
`foo.conf.dpkg-dist` and keeps the user's edits as `foo.conf` —
*or*, with different prompts, writes the old version to
`foo.conf.dpkg-old` and installs the new. Count = 1 rolling, suffix
naming, same directory. Very similar to Terraform's shape.

---

## 2. Synthesis: dimensions and the agent-manager-shaped answer

### 2.1 Where should backups live?

| Option | Pros | Cons |
|---|---|---|
| **Per-adapter** (`~/.cursor/.am-backup/`) | Local to the config; easy to find for that tool; survives moves of the adapter's home | 13 adapters = 13 scattered dirs; permissions vary per-tool; some tools scan their own dir and may warn about unknown subdirs |
| **Per-file sibling** (`~/.cursor/mcp.json.am-bak`) | Terraform/dpkg-style; trivially co-located; no new dir to manage | Pollutes every adapter directory; some adapters re-serialize and may be confused by siblings they didn't write |
| **Centralized** (`~/.config/agent-manager/backups/<adapter>/<relpath>/`) | Single place to inspect, prune, and exclude from backup tooling; agent-manager owns permissions; easier `am undo` UX; naturally survives per-adapter `rm -rf` | Requires mapping real paths back to a backup tree; one extra filesystem traversal per apply |
| **Per-project** (`<repo>/.agent-manager/backups/`) | Discoverable for project-scoped configs; co-lives with TOML | Useless for global configs (`~/.claude.json`); confuses the global/project split that ADR-0003 codifies |

**Recommendation: centralized**, at
`$AM_CONFIG_DIR/backups/<adapter>/<hash-of-target-path>/<timestamp>.bak`,
with the real target path recorded in a sidecar `manifest.json` per
session. Rationale:

1. Agent-manager is the one writer, so it owns the one backup tree.
   This avoids polluting 13 third-party directories with files those
   tools didn't put there (some of them *will* complain; Claude
   Desktop, for instance, has rejected stray files in its settings
   dir historically **\[unverified\]**).
2. `am undo` (already a command) can list sessions from one place.
3. Pruning is one sweep, not 13.
4. It keeps the core tenet from CLAUDE.md honest: "Three UIs over one
   core" — the backups must be visible from TUI / web / CLI equally,
   which is easier with one canonical path.

### 2.2 Retention policy

Two axes exist in the wild:

- **Count-based**: "keep last N per target." Predictable, caps disk use.
- **Time-based**: "drop anything older than X days." Survives long
  gaps between `am apply` runs but doesn't cap size.

**Recommendation: hybrid, count-biased.**
- Keep the last **10 backups per target file** by default (covers "I
  did something and immediately did three more things and only then
  noticed the damage").
- Additionally keep anything newer than **7 days**, even past the 10-count
  cap (so a bursty session can't evict history that might still be
  relevant within a week).
- Expose `settings.apply.backup_retention_count` and
  `settings.apply.backup_retention_days` in `config.toml` for users
  who want tighter or looser policy.
- Default parallels Ansible-on-a-laptop reality: backups are cheap,
  users rarely clean them, so cap by count *and* by age.

One backup (Terraform-style) is tempting for its simplicity but fails
the actual failure mode in issue #1: apply-then-apply-again *before*
the user looks at the file wipes the only safety net. N=10 covers
that.

### 2.3 Filename scheme

Candidates:

1. **Timestamp only:** `20260503T142207Z.bak`. Collides under rapid
   re-apply in the same second.
2. **Timestamp + short hash of contents:** `20260503T142207Z-a3f2b1.bak`.
   Collision-safe; allows dedup ("this backup equals the last one, skip").
3. **Timestamp + session id:** `20260503T142207Z-sess_abc123.bak`.
   Groups backups from the same `am apply` invocation, useful for
   multi-file atomic rollback ("undo the whole session").

**Recommendation: (2) + (3) combined** —
`<ISO8601-basic>-<session8>-<sha8>.bak`, e.g.
`20260503T142207Z-a3f2b1c4-9e7d2208.bak`.
- ISO8601 basic form (`YYYYMMDDTHHMMSSZ`, UTC) avoids Windows-reserved
  characters (`:` is banned on NTFS) and sorts lexically.
- Session id groups per-invocation, enabling `am undo --session <id>`.
- Content hash makes dedup trivial and protects against clock skew
  collisions (NTP jumps, VM pausing).

### 2.4 Tools that don't back up — why?

- **Stow / dotter**: refuse-on-conflict is strictly safer than
  overwrite-then-save; they traded UX friction for simplicity.
- **Helm / kubectl**: central server owns revisions; local disk backup
  would be redundant.
- **chezmoi**: source-of-truth is in git, and it diffs aggressively
  before writing.

Agent-manager resembles none of these cleanly: the "source of truth"
(TOML catalog) is git-backed (good, ADR-0002), but the *destination*
(13 native configs) is not, and third-party tools mutate the destination
behind our back. That's the exact gap a local backup fills.

### 2.5 Windows considerations

- **Reserved characters in filenames.** `:` in ISO8601 extended form
  (`14:22:07`) is illegal on NTFS. Use basic form (`142207Z`).
- **Path length.** NTFS default MAX_PATH is 260 chars. A centralized
  `$AM_CONFIG_DIR/backups/<adapter>/<hash>/<filename>.bak` with the
  hashed target path keeps deep native paths from blowing the limit.
- **Filesystem locks.** Windows doesn't let you rename over an open
  file. Agent-manager already handles this in `atomicWriteFile` via
  tmp-then-rename, but the backup step needs to be resilient to
  "IDE has the file open for read" — a read-copy (`fs.copyFile`) is
  fine; only rename-over is blocked.
- **Junction vs symlink.** `resolveEffectiveTarget` already handles
  symlinks. Junctions on Windows appear as directories; non-issue for
  per-file backups.

---

## 3. Concrete proposal for agent-manager

1. **Hook point:** extend `atomicWriteFile` in
   `src/core/atomic-write.ts` to take an optional
   `{ backup?: { dir: string; sessionId: string; adapter: string } }`
   parameter. When provided, *before* the rename-over, copy the
   existing target (if any) to
   `${dir}/${adapter}/${hash(target)}/${ts}-${session8}-${sha8}.bak`
   and write a sidecar manifest.
2. **Call site:** `applyResolved` (in `src/core/controller.ts`,
   called by `src/commands/apply.ts`) generates the session id once
   and passes backup options into each adapter export. Adapters stay
   ignorant of the policy.
3. **Retention sweep:** run at the *end* of `applyResolved`, not
   on every write (keeps per-file write path hot). Simple readdir +
   sort + `unlink` beyond N / older than X.
4. **`am undo`:** already exists. Extend to consume the new session
   manifest so `am undo --session <id>` rolls back every file the
   last apply touched.
5. **`--no-backup` flag:** escape hatch for CI and for the tier-3
   "we're writing a brand-new file" path where there's nothing to
   back up anyway.
6. **Defaults live in `config.toml`:**
   ```toml
   [settings.apply]
   backup = true
   backup_retention_count = 10
   backup_retention_days = 7
   ```

## 4. Open questions (for the follow-up ADR)

- Should encrypted secrets in native configs be re-encrypted in the
  backup, or copied as-is? (As-is is simpler and matches "this was on
  disk"; re-encrypt protects against key rotation eviction.)
- Does the backup tree go inside the git-backed `$AM_CONFIG_DIR` or
  outside? Inside means it's pushed (bad — it's machine-specific and
  could exfiltrate tokens); outside means it doesn't sync (fine — a
  backup is a recovery aid, not a source of truth). Recommend
  `$AM_CONFIG_DIR/backups/` but add to the top-level `.gitignore`
  that `am init` writes.
- Interaction with `--dry-run`: dry-run must NOT create backups.
  Easy (don't enter the write path).
