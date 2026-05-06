[reviewer: openai/gpt-5.5]

# Fan-out vote — 2026-05-05

## Track A — Hosted-UX

A1: CHOICE A
- CM6 is the right hosted default: TOML editing does not justify Monaco's 2-3MB Worker/static bundle cost. Keeping Monaco optional for `am serve` preserves rich local UX without taxing hosted users.

A2: CHOICE NUANCED
- Detect missing `op` and show platform-specific install commands, but never auto-install or invoke package managers. This gives a better error than docs-only while avoiding supply-chain/privilege surprises.

A3: CHOICE A
- A shared team passphrase undermines ADR-0042's per-recipient revocation model and normalizes the exact collaboration anti-pattern the secrets design avoids. Rejecting at schema time is cleaner than accepting a footgun with warnings users will ignore.

A4: CHOICE NUANCED
- Ship `config_template` only behind an explicit unsafe opt-in per server/command, with tmpfs preference, 0600, SIGTERM cleanup, and startup sweeper. Some MCP servers need file secrets, but plaintext-on-disk should be impossible to enable accidentally.

## Track B — LLM-wiki

B1: CHOICE A
- `.am-wiki/` is shorter, discoverable, and decouples user-facing wiki content from `.agent-manager.toml` config naming. Deprecation cost is real but bounded because `resolveWikiDir()` already centralizes path handling.

B2: CHOICE A
- Copy/materialised files are necessary for Windows, normal git clones, and agents without `am`. Symlinks optimize disk and drift, but they fail the core goal: make the wiki visible as project files everywhere.

B3: CHOICE NUANCED
- MVP should be push-only plus explicit `am wiki pull` for down-sync. Full bidirectional sync has conflict and surprise-write risk; an explicit pull preserves the architecture without making v1 too magical.

B4: CHOICE A
- Gitignored-by-default is the safer MVP while harvested sessions may contain secrets and wiki encryption is not fully integrated. Users who want portability can opt in to committing after understanding the risk.

B5: CHOICE NUANCED
- Both, but frontmatter only declares intent and `am wiki publish <slug>` performs promotion. Auto-promote-on-commit is too implicit; command-only loses useful durable intent in the page metadata.

B6: CHOICE NUANCED
- Hardcoded versioned template for MVP, with a future extension point for customization. The schema doc is load-bearing for unknown agents, so early fragmentation would hurt interoperability.

B7: CHOICE B
- Build two-tier alongside adapter expansion. The two existing SessionReaders already benefit from a visible project tier, and blocking layout work on adapter coverage couples two independent delivery tracks.

B8: CHOICE NUANCED
- Two-tier MVP, but keep storage/layout compatible with a future workspace tier. Three tiers now adds complexity before there is user evidence, especially for monorepos that can initially map to one project.

## Closing — strongest convictions

HIGH-confidence: A1, A3, B2, B4, B6, B8. Medium: A2, A4, B1, B5, B7. LOW-confidence: B3; I would change with concrete sync-conflict UX evidence or strong user demand for automatic global→project materialisation.
