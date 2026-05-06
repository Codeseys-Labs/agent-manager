[reviewer: x-ai/grok-4.3]

# Fan-out vote — 2026-05-05

## Track A — Hosted-UX

A1: CHOICE A
- Synthesis §3.3 + Lens B: CM6 ~250KB vs Monaco 2-3MB on CF Workers; TOML needs only schema linting, not full LS. Monaco optional for local `am serve`.

A2: CHOICE A
- Synthesis §4.1: `op://` already first-class in resolver; detection + prompt (brew/scoop) matches zero-prompt goal and CLI-only fencing for browser UI.

A3: CHOICE A
- Synthesis Lens A + ADR-0042 §Universal: shared team passphrase contradicts age multi-recipient + per-user revocation model. Reject in schema prevents foot-gun.

A4: CHOICE B
- Synthesis §4.5 + P0-3 sweep fix still leaves plaintext disk window; MVP risk outweighs popular-MCP-server convenience. Defer to v2 behind opt-in.

## Track B — LLM-wiki

B1: CHOICE A
- Wiki vision §2.1: `.am-wiki/` shorter, unambiguous, distinct from `.agent-manager.toml`. Rename cost offset by AGENTS.md discoverability for non-am agents.

B2: CHOICE A
- Wiki vision §2.2 + ADR-0022 reversal case: copy is Windows-safe, git-committable, clone-portable, agent-visible without am. ADR-0022 symlink fails on all four counts.

B3: CHOICE B
- Wiki vision two-tier + bidirectional sync is richer but adds conflict volume; push-only MVP keeps scope tight, explicit `am wiki pull` later.

B4: CHOICE A
- Wiki vision §2.4 + ADR-0042 maturity gap: gitignored-by-default until secrets integration proven; prevents accidental commit of `.am-wiki.json` sync state.

B5: CHOICE NUANCED (both)
- Vision §2.3: frontmatter `promote: true` declares intent declaratively; `am wiki publish` executes and gives audit trail. Both coexist cleanly.

B6: CHOICE A
- Vision §2.4 AGENTS.md: hardcoded Karpathy template with version pin ensures every agent sees identical schema on first clone; customisation deferred.

B7: CHOICE B
- Only 2/13 adapters harvest today; parallel expansion while shipping two-tier skeleton prevents blocking wiki value.

B8: CHOICE NUANCED (two-tier-extensible)
- Vision §2.1: two-tier MVP; layout (.am-wiki/, global/projects) already has namespacing for future workspace tier via subdirs.

## Closing — strongest convictions

HIGH: A1 (bundle size), A3 (passphrase anti-pattern), B2 (copy vs symlink). LOW: A4 (MCP config_template exact risk weighting), B3 (bidirectional timing). All other votes medium; new evidence on Windows symlink adoption or MCP secret survey could shift A4/B7.