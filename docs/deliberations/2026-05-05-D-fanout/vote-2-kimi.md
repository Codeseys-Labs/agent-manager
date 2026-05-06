[reviewer: moonshotai/kimi-k2.6]

# Fan-out vote — 2026-05-05

## Track A — Hosted-UX

A1: CHOICE A
- CM6's ~250KB bundle vs Monaco's ~2-3MB is decisive for a Cloudflare Worker edge. TOML editing doesn't need IntelliSense's weight; Monaco can remain optional for local `am serve`.

A2: CHOICE B
- Am should not become a package manager. Detecting and suggesting the install command is fine, but auto-installing `op` across brew/scoop/apt invites supply-chain and permission issues. Clear error + exact install command in docs is the right boundary.

A3: CHOICE A
- Shared team passphrases replicate the "one key" vulnerability that ADR-0042's age multi-recipient model was designed to escape. The schema is the correct place to block this anti-pattern.

A4: NUANCED — ship behind `--unsafe-config-template` opt-in flag
- The plaintext-on-disk window is real even with SIGTERM + sweeper. It should not be the default behavior. Opt-in forces conscious acceptance of the risk.

## Track B — LLM-wiki

B1: CHOICE A
- `.am-wiki/` is shorter, unambiguous, and avoids nesting inside a config directory. Deprecation cost is a minor warning in `resolveWikiDir`; discoverability payoff is lasting.

B2: CHOICE A
- Windows developer-mode requirement, broken git symlinks on cross-machine clones, and "clone without am" failure are all blockers. Sync pipeline already manages drift; disk savings are minor for text files.

B3: NUANCED — push-only default with explicit `am wiki pull` for opt-in down-sync
- Bidirectional is the north star but conflict resolution adds MVP risk. Explicit pull gives users control and prevents accidental overwrites.

B4: CHOICE A
- Session harvest output may contain prompts and errors with embedded secrets. Until ADR-0042 age-envelope integration is active, committed-by-default creates a leak path that gitignore alone cannot fully protect (forks, history).

B5: NUANCED — both: frontmatter `promote: true` declares intent, `am wiki publish <slug>` actually moves
- Frontmatter enables batch/automated promotion; the command is explicit and discoverable. Both serve different workflows; neither should be dropped.

B6: CHOICE A
- The Karpathy schema convention only works if `.am-wiki/AGENTS.md` is predictable. Per-project customisation fragments the "agent-transparent" goal. Extension point can be added later, not in MVP.

B7: CHOICE B
- Two-tier is a storage/sync structure, not a content volume gate. Blocking the architecture because the shelf is empty delays a P5 feature. Each new adapter immediately benefits from an already-built structure.

B8: NUANCED — two-tier MVP with layout-compatible path for workspace tier later
- Three-tier from day one complicates MVP scope. Two-tier only might paint into a corner if monorepos demand per-package wikis. Reserving `wiki/workspaces/` is cheap insurance.

## Closing — strongest convictions

HIGH-confidence (would not change without major new evidence): A1, A3, B1, B2, B4, B6. These have a clear single-best answer.

LOW-confidence (may change with implementation feedback): A4, B3, B8. These depend on implementation pacing and user demand.
