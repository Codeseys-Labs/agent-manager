[reviewer: google/gemini-3.1-pro-preview]
# Fan-out vote — 2026-05-05

## Track A — Hosted-UX

A1: CHOICE A
- CM6's tiny footprint (~250KB) is strictly required for the CF Worker static footprint, avoiding unnecessary Bloat for TOML. Monaco is an excellent fallback for `am serve` where local power is available.

A2: CHOICE B
- `am` shouldn't manage global system packages magically. Prompting user to install preserves control and is standard CLI maturity.

A3: CHOICE A
- A shared team passphrase breaks revocation (must rotate everywhere) and attribution. Reject it at schema level to enforce identity-based KMS/age policies from ADR-0042.

A4: CHOICE C (NUANCED)
- Defer to v2. The P0-3 fix (SIGTERM + sweeper) mitigates but doesn't eliminate the plaintext window; for MVP, security outweighs supporting every MCP server pattern.

## Track B — LLM-wiki

B1: CHOICE A
- `.am-wiki/` is crisp, memorable, and establishes the brand. It immediately separates the wiki artifact from config.

B2: CHOICE A
- Copying ensures true portability (Windows, pure git clones) without forcing `am` dependency on read, fulfilling Karpathy's "agent-visible" schema doctrine. Divergence risk is real but handled by `am wiki sync`.

B3: CHOICE B
- Push-only is simpler to ship for MVP and covers the primary use-case (local context gathering). Bidirectional introduces immediate conflict resolution UX complexity that is best deferred. 

B4: CHOICE A
- Gitignore-by-default is safest until ADR-0042 lands. Raw sessions leak secrets easily; defaulting to tracked is irresponsible before native encryption.

B5: CHOICE C (NUANCED)
- Both. Frontmatter `promote: true` allows async declarative intent (e.g. during offline coding), while `am wiki publish` acts as immediate execution. 

B6: CHOICE B
- Per-project customisation ensures teams can adapt the Karpathy pattern to their specific tech stacks without waiting for global template bumps.

B7: CHOICE B
- Build two-tier now so the structure is sound. The adapter gap (11 to go) is just execution logic; the structural split shouldn't wait on adapter completeness.

B8: CHOICE C (NUANCED)
- Two-tier layout MVP, layout-compatible for workspace. Keeps the mental model simple initially but sets up the inevitable monorepo support.

## Closing — strongest convictions

HIGH-confidence: A1, A3, B1, B2. Identity-based secrets (A3) and portable copy (B2) are structurally critical to AM's design.

LOW-confidence: A2, B4. If `op` adoption is hyper-critical for growth, `A2` might need an auto-installer. If ADR-0042 lands in Phase A, `B4` committed-by-default becomes highly desirable for knowledge sharing.