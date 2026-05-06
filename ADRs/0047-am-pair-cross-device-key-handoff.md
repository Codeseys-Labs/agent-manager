---
status: accepted
date: 2026-05-05
accepted: 2026-05-05
amends: ADR-0042
---

# ADR-0047: `am pair` cross-device key handoff via git-native rendezvous

## Context

[ADR-0042](0042-universal-secrets-strategy.md) (Universal Secrets
Strategy) left the multi-machine bootstrap UX as an open verification
gate (gate 5: *"`am pair` command surface designed and documented"*).
ADR-0042 sketched four verbs (`pair add`, `pair accept`, `secrets
rewrap`, `secrets rotate`) but did not specify the rendezvous channel
by which a new machine announces its public key to an existing paired
machine.

The 2026-05-05 Lens A research
(`docs/research/2026-05-05-deep-loop/lens-browser-secrets.md`, §3)
surveyed three families of pairing mechanisms:

1. **PAKE rendezvous (Magic Wormhole, SPAKE2).** Requires a relay
   service and concurrent typing of a short phrase. Introduces a new
   network component and a new trust boundary.
2. **QR-bridge (Signal-CLI, Bitwarden).** Moves the identity between
   devices by encoding it in a QR code. Requires both devices
   co-present and a camera on the new device.
3. **Pairing token via clipboard.** A base64 token carries intent and
   optionally a one-time symmetric key. Violates ADR-0042's *"private
   keys never leave the machine they were generated on"* invariant if
   the token transports an identity.

The research landed on a fourth option: since `agent-manager` is
already git-native — every paired machine already has push/pull access
to the config repo, and that repo already stores
`recipients/<hostname>.pub` — the config repo itself is the natural
rendezvous channel. No relay, no QR, no out-of-band token.

This ADR promotes that recommendation to an accepted design. It is
**design-only**; no implementation gates. The corresponding
implementation lands under ADR-0042's broader acceptance criteria.

## Decision

Define two new CLI verbs that realize cross-device pairing over the
config repo:

```
am pair accept <name>      # new device: generate identity, publish .pub, push
am pair finalize           # existing device: pull, detect new .pub, rewrap, push
```

These replace ADR-0042's sketched `am pair add` / `am pair accept`
token flow. No pairing token is emitted; no symmetric key is
transported; no relay server is introduced. The config repo is the
sole rendezvous.

### Flow

**NEW DEVICE (e.g. a freshly-provisioned laptop-2):**

```
$ am pair accept laptop-2
? Enter your master passphrase: *****
```

1. Clones the config repo (user has already configured `origin`, or
   the command accepts `--repo <url>` as a convenience).
2. Generates a fresh age identity at
   `~/.config/agent-manager/identity.age`, encrypted to the
   passphrase per ADR-0042 §"Per-machine identity".
3. Writes the corresponding public key to
   `recipients/laptop-2.pub` in the repo.
4. Appends `"recipients/laptop-2.pub"` to the `[age].recipients`
   list in `.am-secrets.toml`.
5. Commits (`am: pair device laptop-2`) and pushes.

At this point the new device **cannot yet read existing secrets** —
nothing has been rewrapped to its public key. It can, however, read
any value written from this commit forward by other machines that
have since pulled its `.pub` and rewrapped.

**ORIGINAL DEVICE (the one that is already paired):**

```
$ am pair finalize
```

1. `git pull` from the config repo.
2. Compares the current `recipients/` directory against the set of
   recipients that existing ciphertexts are wrapped to. Any `.pub`
   not yet covered is surfaced:

   ```
   New recipient detected: laptop-2 (recipients/laptop-2.pub)
   Rewrap 17 encrypted values to include laptop-2? [Y/n]
   ```
3. On confirmation, invokes `am secrets rewrap` (the verb already
   defined by ADR-0042), which re-encrypts every `enc:v2:age:…` value
   to the full current recipient set.
4. Commits (`am: rewrap for laptop-2`) and pushes.

The new device then runs `git pull` (or any normal `am` command that
syncs) and has full read access.

### Collision handling

If `recipients/<name>.pub` already exists (e.g. two laptops both
called `laptop`), `am pair accept` appends a short random suffix
(`laptop-a3f9`) and warns. This matches ADR-0042 §"Per-machine
identity" collision rules.

### Why a separate `finalize` verb

`am pair finalize` is a thin convenience wrapper over `git pull` +
`am secrets rewrap`. It is called out as its own verb for two
reasons:

1. **Discoverability.** Users looking for "how do I add my new
   laptop?" find `am pair` in the help; they would not intuitively
   map the task to `am secrets rewrap`.
2. **Confirmation prompt.** Rewrap touches every encrypted value in
   the repo. The `finalize` wrapper shows the diff (which recipients
   are new) before the rewrap, so the original device's operator can
   refuse to grant a recipient they did not expect.

A user who prefers the lower-level verbs can always run `git pull &&
am secrets rewrap` directly; `finalize` is not load-bearing, only
ergonomic.

## Rationale

Git-native beats PAKE / QR / token for `agent-manager` specifically
because:

- **Trust boundary already exists.** Every paired device already
  trusts the config repo's push/pull channel (it's where the
  encrypted identity and ciphertexts live). Adding a pairing
  rendezvous over that same channel introduces **zero new attack
  surface**. A PAKE relay would introduce a new component that must
  be trusted to not MITM the exchange.
- **No co-presence requirement.** QR bridges require both devices
  physically together with a working camera. The git-native flow
  works across continents and time zones — the new device pushes,
  the original device pulls whenever it next comes online.
- **No token to mishandle.** A clipboard token is a secret that can
  be pasted into the wrong window, logged by a shell, or exfiltrated
  by a clipboard manager. The git-native flow has no such artifact.
- **Matches user mental model.** "Add a recipient by pushing a
  `.pub` file" is how age, agenix, and sops already work. The `am`
  wrapper is a UX layer, not a new protocol.
- **Stateless.** Consistent with ADR-0015 (stateless web UI) and
  ADR-0042's rejection of server-side state. The repo is the only
  state store; there is nothing to operate.

## Trade-offs

Honest accounting of what the git-native design gives up:

- **New device must already have push access to the config repo.**
  If a user provisions a laptop-2 that can only clone (read-only
  mirror, or deploy-key that is pull-only), `am pair accept` fails
  at the push step. Workaround: the user pastes the generated
  `.pub` content into an issue / chat, and a push-authorized device
  commits it on their behalf. This is clunkier than PAKE but
  acceptable as a fallback.
- **Does not work for CI-bot-only consumers.** A CI runner that only
  reads the repo to apply config cannot pair itself; its `.pub` must
  be committed by a human operator. This is by design — a CI bot
  should not be able to unilaterally add itself as a secrets
  recipient.
- **Requires one paired device to be online after the new device
  pushes.** Until an existing device runs `am pair finalize`, the
  new device cannot read existing secrets. For most single-user
  setups (one always-on machine, one laptop) this is not a burden;
  for users provisioning a new device while their primary is
  offline, there is a wait.
- **No authentication of the new `.pub`.** Anyone with push access
  can commit a `recipients/<name>.pub`. The `finalize` prompt
  surfaces the new recipient so the operator can refuse, but there
  is no cryptographic binding between the `.pub` file and the
  human who submitted it. This is out of scope (see below) and
  deferred to a future ADR if the threat model demands it.
- **`am pair accept` requires the user to re-enter the master
  passphrase** — on the new device the passphrase is a fresh input,
  never cached locally before. This is correct (the passphrase has
  to come from the user's head, not from the repo), but it does mean
  pairing is not fully unattended.

## Implementation sketch

File paths and commands for a concrete two-device example (original:
`laptop`; new: `laptop-2`).

**Step 1 — NEW DEVICE:** `am pair accept laptop-2`

Creates, in the repo:
- `recipients/laptop-2.pub` — the new device's age public key.
- Edit to `.am-secrets.toml`: append `"recipients/laptop-2.pub"` to
  `[age].recipients`.

Creates, locally (gitignored):
- `~/.config/agent-manager/identity.age` — the encrypted age
  identity for laptop-2.

Commits and pushes:
```
am: pair device laptop-2
```

**Step 2 — ORIGINAL DEVICE:** `am pair finalize`

Pulls. Detects `recipients/laptop-2.pub` as new (not covered by
existing ciphertext recipient sets). Prompts. Invokes `am secrets
rewrap` internally, which:
- Walks every `enc:v2:age:…` value in every config file under
  management.
- Decrypts with `laptop`'s identity, re-encrypts to the current
  `[age].recipients` set (now including `laptop-2`).
- Writes the updated ciphertexts in-place.

Commits and pushes:
```
am: rewrap for laptop-2
```

**Step 3 — NEW DEVICE:** any normal `am` command (e.g. `am apply`)

Pulls the rewrapped ciphertexts. Reads values normally, decrypting
with its local identity. Done.

**Failure modes surfaced to the user:**

- New device has no push access → `am pair accept` errors after
  generating the local identity; instructs the user to commit
  `recipients/laptop-2.pub` manually from another device or via the
  web UI.
- Original device's `am pair finalize` encounters a ciphertext it
  cannot decrypt (stale identity, corrupted file) → aborts the
  rewrap, leaves the repo state untouched, reports which file
  failed.
- Two devices run `am pair accept` concurrently with colliding
  hostnames → the second push is rejected by the remote; the user
  re-runs with a disambiguating suffix.

## Out of scope (deferred)

Explicitly deferred to future ADRs or future versions:

1. **Browser-only first device.** A user whose first paired device is
   the hosted web UI (no CLI anywhere) cannot use this flow as
   specified — `am pair accept` is a CLI verb. The web-UI bootstrap
   path is part of ADR-0043 (hosted UI auth) and is not addressed
   here.
2. **Hardware-token identities (YubiKey, Secure Enclave).** ADR-0042
   specifies age passphrase identities. A future ADR may introduce
   `recipients/<name>.ssh-ed25519.pub` (age's SSH recipient support)
   or a PIV / FIDO2 recipient backend. The pair flow in this ADR
   works unchanged for those cases: generate, publish `.pub`,
   rewrap. Only the identity generation step differs.
3. **Signature verification on the `.pub` file.** As noted in
   trade-offs, the current design trusts the repo's push ACL. A
   future ADR may add a signed commit requirement, or a detached
   signature in `recipients/<name>.pub.sig`, countersigned by an
   existing recipient at pair time. Not required for the single-user
   / small-team threat model ADR-0042 targets; revisit if
   multi-tenant teams adopt `am`.
4. **Revocation UX.** This ADR covers *adding* a recipient. Removal
   (`git rm recipients/laptop.pub && am secrets rewrap`) is covered
   by ADR-0042 directly and does not need a dedicated `am pair
   revoke` verb in this design. A future ergonomic pass may add one.

## Verification gates

This ADR is accepted as **design-only**; there are no implementation
gates to close on this ADR itself. It exists to close ADR-0042's gate
5:

- **ADR-0042 gate 5 (`am pair` command surface designed and
  documented):** **CLOSED by this ADR.** The verbs `am pair accept`
  and `am pair finalize` are specified above, with worked example,
  file paths, failure modes, and rationale. ADR-0042 gates 1 and 4
  remain open and are not affected by this ADR.

Implementation of `am pair accept` / `am pair finalize` lands under
ADR-0042's acceptance criteria and is tracked there.

## References

- [ADR-0042 Universal Secrets Strategy](0042-universal-secrets-strategy.md) — parent ADR, gate 5
- [ADR-0012 Application-level encryption](0012-application-level-encryption.md) — wire format
- [ADR-0015 Stateless web UI](0015-stateless-web-ui.md) — no server-side state constraint
- `docs/research/2026-05-05-deep-loop/lens-browser-secrets.md` §3 — pairing research
- age recipients model — <https://age-encryption.org/v1>
- agenix rekey flow — <https://github.com/ryantm/agenix#rekeying>
- Magic Wormhole (rejected alternative) — <https://magic-wormhole.readthedocs.io/>
