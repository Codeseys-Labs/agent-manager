---
status: proposed
date: 2026-05-05
amends: ADR-0042
---

# ADR-0046: Reject `team_passphrase` Field in Schema — Force Per-Recipient Identity

## Context

A natural-but-wrong way to share secrets across a team is for the team to
share one master passphrase. Every machine in the team derives the same
KEK from the same passphrase; the wrapped age identity in the repo
unlocks for everyone.

This appears in user requests as:

```toml
[settings.secrets]
team_passphrase = "$ARGON2_HASH"   # or in some derived form
```

It looks ergonomic. It is wrong. The reasons are concrete:

1. **No revocation.** When a team member leaves, the team must rotate
   the passphrase, every machine, and re-encrypt every secret.
   In practice this never happens; the ex-member retains decrypt
   capability.
2. **No audit trail.** Every machine looks identical from the secret
   store's perspective. No way to attribute "who decrypted X."
3. **Single-point-of-compromise.** One leaked passphrase = total
   compromise. Per-recipient X25519 identity (already shipped in
   ADR-0042) leaks one identity, not the whole team.
4. **No principle-of-least-access.** Granular per-secret recipient
   policies (e.g., "only ops can decrypt prod keys") become
   impossible when everyone shares the same KEK.

The 6-reviewer fan-out deliberation
(`docs/deliberations/2026-05-05-D-fanout/CONVERGENCE.md`) returned
**5/6 strong-A** on rejecting `team_passphrase` in the schema (the
single NUANCED vote came from deepseek with broadly-agreeing reasoning
about the same outcome via a different mechanism).

The synthesis memo
(`docs/design/2026-05-05-hosted-ux-secrets-synthesis.md` §Open Decision
4) had already flagged this as the recommended posture; this ADR
formalises it.

## Decision

The am config schema (`src/core/schema.ts`) **rejects** any
`[settings.secrets].team_passphrase` field with a Zod-level validator
error. The actual emitted message (subject to Zod's standard wrapping
into the host application's error format) is:

```
settings.secrets.team_passphrase is rejected by design (ADR-0046).
Single-passphrase team sharing has no revocation, no audit trail, and
single-point-of-compromise risk. Use per-recipient X25519 identities
instead: see `am secrets add-recipient <pubkey>` and ADR-0042.
```

The error message is actionable: it tells the user what to do instead.

`am secrets add-recipient` exists from ADR-0042 (already shipped in
`src/core/secrets-age.ts`). Multi-machine workflows go through it:

1. New team member generates their own age identity locally
   (`am secrets init`).
2. They publish their public X25519 recipient (`am secrets pubkey`).
3. An existing team member adds it as a recipient
   (`am secrets add-recipient <pubkey> --comment "alice@2026-05-05"`).
4. The existing member rewraps the secrets to include the new
   recipient (`am secrets rewrap`).
5. New member can now decrypt.

This is **more keystrokes** than a shared passphrase but it preserves
all four properties listed in §Context.

## Consequences

### Positive

- Schema enforces the right pattern. Users can't accidentally adopt
  the anti-pattern.
- Error message is actionable; redirects to the supported workflow.
- Ex-member revocation works: `am secrets remove-recipient <pubkey>` +
  `am secrets rewrap`.

### Negative

- Adoption friction: users coming from team-passphrase-style secret
  managers (some 1Password "shared vault" setups, dotenv-vault team
  features) will hit the wall.
- Per-recipient identity setup is more steps than a shared passphrase.

### Mitigation

- `am secrets pair` (deferred to a later ADR — synthesis Open Decision
  8) will streamline the "new team member onboarding" flow.
- Documentation explicitly addresses why team_passphrase is rejected
  with a worked example showing the recipient-add workflow.

## Verification gates (must hold before promoting to `accepted`)

1. **Zod schema rejects `team_passphrase`** with the documented error
   message. Test: a config file containing the field fails to load.
2. **Error message contains pointer to `am secrets add-recipient`.**
3. **`am doctor` proactively checks** for `team_passphrase` in legacy
   config formats (e.g., env-var-based legacy setups) and warns.
4. **Documentation updated** with the recipient-add workflow and the
   anti-pattern explanation.
5. **Migration helper:** `am secrets migrate-from-team-passphrase` is
   either implemented or explicitly documented as out-of-scope (we
   choose: out-of-scope; users need to manually re-encrypt with
   per-recipient identities).

## References

- [ADR-0042](0042-universal-secrets-strategy.md) — universal secrets
  foundation (per-recipient identity, multi-recipient rewrap)
- `docs/design/2026-05-05-hosted-ux-secrets-synthesis.md` Open
  Decision 4
- `docs/deliberations/2026-05-05-D-fanout/CONVERGENCE.md` — 5/6
  reviewers in favor of schema-level rejection
- `docs/research/2026-05-05-B-followup/lens-a-universal-secrets.md`
  §"KEY RECOMMENDATIONS FOR AM" — explicitly rejects shared-passphrase
- agenix, SOPS — both use per-recipient X25519/PGP, neither offers a
  shared-passphrase shortcut as a primary mode (intentional)
