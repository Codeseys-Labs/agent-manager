[reviewer: z-ai/glm-5.1]

# Cross-Family Critique: Hosted-UX + Universal-Secrets Synthesis

## CONFIRMED

- The 5-tier auth ladder (§Q2) is well-structured; PAT-avoidance per-tier is honest.
- "Always be PR-ing" conflict UX (§Q3.2) is a sound pattern — avoids unbounded browser-side merge logic.
- The "repo is always-public, append-only" posture (§5.1) is the correct threat-model baseline.
- URI-scheme dispatch for secrets (§4.1) is extensible and cleanly separates resolution from storage.
- Cross-git-backend uniformity via client-side-only resolution (§4.4) avoids a combinatorial platform-matrix.

## ISSUES

**HIGH — §5.3 keychain-cache timeout contradicts §Open-decision-5**
§5.3 specifies "8-12 hours idle, 24 hours hard cap." Open decision 5 specifies "15-minute idle, 12-hour hard cap, user-configurable." These are not the same policy — the synthesis body says one thing, the open-decision box says another, and neither acknowledges the conflict. A reader implementing from §5.3 will ship a drastically different cache than open-decision-5 intends.

**HIGH — §5.4 Tier 1 threat-model gap: passphrase unlock per-tab leaks KEK to XSS**
Tier 1 says "passphrase unlock per-tab" with "Worker sees encrypted bytes only." But once the user types their passphrase into a browser tab, the derived KEK lives in JS memory. Any XSS in the Worker-served static assets, a compromised CM6 extension, or a supply-chain attack on the TOML language pack gives the attacker the KEK and all ciphertext the tab can see. The memo treats the browser as a trusted execution environment without stating this assumption. For a zero-knowledge architecture, this is the central threat — and it is unaddressed.

**HIGH — §4.3 `supportsEnvRefResolution` capability=false fallback eagerly writes plaintext to disk**
The memo celebrates reduced plaintext-on-disk for capability=true adapters but is silent on the fact that capability=false adapters (the majority of the 13 listed in §Q1 — at least 10 have no known `envFile` support) will eagerly resolve and write plaintext. The "~50% reduction" claim in §Q1 is unsubstantiated and likely overstates the impact, since only 3 of 13 adapters are named as capability=true.

**MEDIUM — §5.3 keychain failure fallback to `AM_AGE_PASSPHRASE` env var is a security downgrade**
The memo documents this as an "escape hatch" but doesn't classify it: a passphrase in an environment variable is readable by any process under the same user, persists across child processes, and appears in `/proc/PID/environ` on Linux. This is strictly weaker than keychain storage. The memo should call this a known-downgrade mode and specify when it's acceptable (CI only? headless only?) vs. when it should be refused.

**MEDIUM — §4.5 `config_template` cleanup via `process.on('exit')` is unreliable**
Open decision 6 recommends `process.on('exit')` cleanup. This hook does NOT fire on `SIGKILL`, power loss, `OOM-kill`, or `SIGSEGV`. The plaintext config file persists on disk until next boot. A `pre-spawn` + `post-exit` cleanup with a stale-file sweeper on `am` startup would be more robust.

**MEDIUM — §Q2 Tier 4 PAT in "session memory only" (open decision 7) contradicts §Q2 table**
The §Q2 table row for Gitea/Codeberg says "PAT stored encrypted in browser (IndexedDB or in-config wrapped envelope)." Open decision 7 recommends "session memory only; user re-pastes per session." These are opposite decisions. The table text is still in the memo body.

**LOW — §3.3 CodeMirror 6 TOML language pack assumption**
CM6 does not ship a first-party TOML language pack. The memo assumes one exists ("with TOML language pack"). This is either a third-party dependency or something am must author and maintain. Not called out as a dependency.

**LOW — §4.1 `env://NAME` scheme is a no-op indirection**
Adding `env://NAME` as a URI scheme adds dispatch complexity for zero security benefit — it's equivalent to the existing `${VAR}` resolution. The only value is explicitness, but it increases the resolver surface without clear gain.

## QUESTIONS

1. §Q2 SSH is "blocked for hosted UI." But what about `am serve` (local web UI)? Can the local web UI use SSH? The memo never clarifies whether the SSH block is hosted-only or universal.
2. §5.2 "Calibrate scrypt parameters at install time so decryption takes ~1s." What happens when the user upgrades hardware or moves the identity to a faster machine? The 1s calibration becomes ~200ms and is under-calibrated. Is re-calibration prompted? Automated?
3. §4.4 "The hosted UI consequence: the browser must run the same resolver locally." Is there an age-encryption WASM build that runs in the browser? If not, this is an unstated dependency on a build that may not exist or may be too large for Worker-served static assets.
4. §5.5 Incident response step 2: "rotate provider credentials first if any plaintext was ever committed." How does am know whether plaintext was ever committed? There's no plaintext detection mechanism described.

## NEW BACKLOG

1. **Threat model addendum for browser-side KEK exposure** — XSS, supply-chain, dev-tools leakage. Tier 1 is not "zero-knowledge" against a compromised static-asset origin.
2. **Reconcile timeout numbers** — §5.3 vs open-decision-5 idle/hard-cap values; pin one set.
3. **Reconcile PAT storage** — §Q2 table vs open-decision-7 (IndexedDB vs session-memory). Remove one.
4. **Capability matrix audit** — actually enumerate which of the 13 IDE adapters support `envFile`/env-ref resolution today; validate the "~50%" claim.
5. **Stale-file sweeper for config_template** — startup scan for orphaned plaintext config files from crashed previous runs.
6. **Browser-side age WASM feasibility spike** — confirm a WASM build exists, measure bundle size, verify it runs under CF Worker static-site constraints.
7. **`AM_AGE_PASSPHRASE` security classification** — document as a CI-only downgrade mode; consider refusing it in interactive shells with a warning.
