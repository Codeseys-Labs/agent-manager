[reviewer: minimax/minimax-m2.7]

# Fan-out vote — 2026-05-05

## Track A — Hosted-UX

A1: CHOICE A
- CM6 at ~250KB vs Monaco at 2-3MB is not a close contest for a Cloudflare Worker deploy; the bundle-size delta is real and TOML validation needs no IntelliSense machinery. Synthesis §3.3 recommends CM6 for hosted UI; Monaco optional for `am serve` local is a sensible fallback.

A2: CHOICE A
- Detecting missing `op` and surfacing the install command is strictly better UX than a silent fail with docs reference. The user has TOML they want to work; guiding them to install takes 10 seconds and avoids a dead end.

A3: CHOICE A
- Shared team passphrase is a known anti-pattern per synthesis Lens A: it requires sharing plaintext across the team, weakening the per-recipient identity model of ADR-0042. Reject in schema with a clear message is the right default; opt-in via flag would be a NUANCED exception worth considering but simpler to just ban it.

A4: CHOICE NUANCED (ship behind --unsafe-config-template opt-in flag)
- The plaintext-on-disk window is real (brief but documented). SIGTERM + sweeper helps but does not eliminate the risk. For MVP, gate it behind an explicit opt-in flag so the default posture is conservative; ship the feature but don't enable it by default.

## Track B — LLM-wiki

B1: CHOICE A
- `.am-wiki/` is shorter, unambiguous, and distinct from the `.agent-manager/` config dir. The deprecation cost of a rename is one-time; the clarity gain is permanent. Wiki vision §2.1 argues this correctly.

B2: CHOICE A
- ADR-0022's symlink breaks on Windows without developer mode, serialises as a broken special file on clone, and hides the wiki from agents that don't know am. Copy solves all three. The drift risk is managed by `am wiki sync` as the single reconciler — same pattern used for config drift already.

B3: CHOICE NUANCED (push-only with explicit am wiki pull for opt-in down-sync)
- Bidirectional is richer but harder to ship reliably. A pragmatic middle path: push-only by default (project → global), with an explicit `am wiki pull` for users who want global → project materialisation. This is opt-in rather than always-on, reducing surprise.

B4: CHOICE A
- Gitignored-by-default avoids committing raw session text (prompts, error messages, embedded secrets) before ADR-0042 age-envelope encryption is integrated. Wiki vision §2.5 is explicit: committed-by-default before ADR-0042 lands creates a leak path that gitignore alone doesn't protect against (rebases, force-pushes, fork mirrors). Stick with gitignored until encryption is ready.

B5: CHOICE NUANCED (both — frontmatter declares intent, command actually moves)
- Both is the right balance. Frontmatter `promote: true` declares author intent without forcing automatic promotion; `am wiki publish <slug>` is the deliberate gesture that executes the copy-to-global step. This avoids accidental promotions while keeping the workflow intentional.

B6: CHOICE A
- Hardcoded template with version pin keeps MVP scope controlled. Per-project customisation is an easy extension point for v2. Customising the schema doc before the schema is stable creates maintenance burden with no upside at launch.

B7: CHOICE B
- Build two-tier in parallel with adapter expansion. The wiki architecture is the valuable part; the 2/13 adapters already have a better home in project-visible `.am-wiki/`. Blocking on adapter coverage delays the whole feature for an additive benefit curve rather than a blocker.

B8: CHOICE NUANCED (two-tier MVP, layout-compatible with workspace tier added later)
- Two-tier is sufficient for MVP. Monorepo users today map to one project for am purposes. Adding a workspace tier later is layout-compatible with the `wiki/workspaces/<name>/` structure alongside `wiki/projects/<name>/`. No need to block day-one shipping on a speculative third tier.

## Closing — strongest convictions

HIGH-confidence (would not change with new evidence):
- A1 (CM6 wins on bundle size alone — decisive), A3 (team passphrase is an anti-pattern, ban it), B1 (rename is right), B2 (copy is the correct reversal of symlink), B4 (gitignored is the only safe default until ADR-0042 encryption is live).

LOW-confidence (would change with new evidence):
- A4 (config_template risk is real; the opt-in flag nuance is a hedge — if the sweeper is more robust than I think, shipping it default-on might be fine), B3 (bidirectional vs push-only — the UX complexity argument is real but the "clone on new machine" use case for push-only is genuinely weak).