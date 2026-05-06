[reviewer: deepseek/deepseek-v4-pro]

# Fan-out vote — 2026-05-05

## Track A — Hosted-UX

A1: CHOICE NUANCED
- CM6 default for hosted UI on CF Workers (~250KB vs Monaco's ~2-3MB), Monaco as opt-in for `am serve` local. Synthesis §3.3 + Lens B's bundle-size argument is airtight; forcing Monaco onto the Worker path is self-inflicted latency. ADR-0043's Monaco mention should be amended.

A2: CHOICE NUANCED
- Detect missing `op` CLI, show the exact install command (`brew install 1password-cli` / `scoop install 1password-cli`), but never auto-execute. Synthesis open decision #2 says document-as-prereq; I think the middle ground costs nothing and saves the user a search. Auto-install is a trust boundary violation.

A3: CHOICE NUANCED
- Reject `[settings.secrets].team_passphrase` in schema by default; allow via `--unsafe-shared-passphrase` flag with prominent warning. Synthesis open decision #4 and Lens A both reject the anti-pattern. But power users who understand the risk shouldn't be locked out — the flag makes the trade-off explicit.

A4: CHOICE NUANCED
- Ship `config_template` behind `--unsafe-config-template` opt-in flag. Synthesis §4.5 correctly notes the plaintext-on-disk window persists despite SIGTERM+sweeper. Some MCP servers genuinely need it (e.g., those reading config files), but shipping it gated forces users to acknowledge the risk. Deferring entirely to v2 punishes early adopters with those servers.

## Track B — LLM-wiki

B1: CHOICE A
- Rename to `.am-wiki/`. Wiki vision §2.1 rationale is sound: shorter, memorable, unambiguously distinct from `.agent-manager.toml`. The `.am-wiki/AGENTS.md` linchpin works better with a short, guessable path. Deprecation period cost is real but one-time; confusing naming is forever.

B2: CHOICE A
- Copy materialised files. Wiki vision §2.2's four reasons are individually sufficient; combined they're overwhelming. Windows symlink perm is a showstopper for a cross-platform tool. Agent visibility of the wiki without `am` installed (§2.2 point 4) is the killer feature — symlink-to-missing-target hides everything on a fresh clone.

B3: CHOICE NUANCED
- Push-only for MVP with explicit `am wiki pull` for opt-in down-sync. Full bidirectional is the right end-state (wiki vision §2.3) but ships with conflict-resolution risk that benefits from real-world testing on push-only first. `am wiki pull` gives users the down-sync path without making it automatic.

B4: CHOICE NUANCED
- Gitignored until ADR-0042 secrets integration is live, then committed-by-default. Wiki vision §2.5 explicitly flags this precondition: harvester output contains raw session text with potential secrets. Committing before envelope encryption exists is a leak path. The transition to committed-by-default post-ADR-0042 gives the best of both.

B5: CHOICE NUANCED
- Both: frontmatter `promote: true` declares intent, `am wiki publish <slug>` executes the actual move. Wiki vision §2.3 assumes both. Frontmatter alone is too magical (auto-promote on commit could leak half-baked entries); command-only is too much friction for a common operation.

B6: CHOICE NUANCED
- Hardcoded template with version pin for MVP; customisable extension point in v2. Wiki vision §2.1 + open decision #6 already lean this way. The schema doc is load-bearing convention — version-pinning it prevents fragmentation during adoption. Customisation is a clean extension, not a rewrite.

B7: CHOICE B
- Build two-tier in parallel with adapter expansion. Wiki vision §3 answers this directly: the tier split gives the 2/13 adapters a better home and makes remaining 11 a growth curve, not a blocker. Blocking on 4/13 would delay the structural improvement for no structural reason.

B8: CHOICE NUANCED
- Two-tier MVP with layout compatible with workspace tier added later. Wiki vision §6 open decision #8 explicitly states the storage layout does not preclude `wiki/workspaces/<name>/`. Three-tier-now is premature without user demand signals; two-tier-extensible costs nothing extra.

## Closing — strongest convictions

HIGH confidence: A1 (CM6 bundle advantage is objective), B2 (copy-over-symlink is cross-platform table stakes), B7 (parallel track avoids artificial blocker), B8 (extensible-by-default costs nothing).

LOW confidence: A4 (needs real MCP-server-ecosystem data on how many servers actually require config_file vs env), B1 (rename is cosmetic — could go either way without user data), B5 (both-vs-command-only depends on actual usage patterns we can't observe yet).
