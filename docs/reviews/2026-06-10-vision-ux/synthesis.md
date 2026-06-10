# Vision + UX Review Synthesis — 2026-06-10

**Scope:** holistic review of agent-manager v0.5.0-rc.8 against its stated vision
(AGENTS.md north star, six pillars) plus hands-on UX testing and external research.

**Method:** 3 Codex facets (vision / CLI-UX / executive — independent cross-model
signal) + 2 research agents (dual-audience CLI-UX heuristics; competitive
landscape) + 2 audit agents (vision alignment; test quality) + **6 sandboxed UX
journey testers** who actually drove `bun run dev --` through real persona
journeys + **adversarial verifiers** who reproduced every HIGH claim in fresh
sandboxes (refute-by-default). All evidence is exact-command + observed-output.

**Executive verdict (Codex, cross-checked by journeys): 7/10.** Architecture,
safety posture, and the keystone's *enforcement engine* are excellent. The
failures cluster at the **edges and the last mile**: the first-touch journeys hit
verified-broken paths, and the keystone has "no door handle".

Journey scores: greenfield 6 · brownfield 6 · secrets 7 · **keystone 4** ·
scripting-agent 6.5 · recovery 6.

---

## CONFIRMED HIGH findings (all adversarially reproduced)

| # | Finding | Root cause | Verifier verdict |
|---|---------|-----------|------------------|
| H1 | **MCP scope fails OPEN on config schema error.** A one-char typo in `[profiles.X.scope]` (`"coer"`) silently exposes the FULL tool ceiling incl. explicitly-denied tools, no stderr warning. Control with valid scope correctly narrows. | `refreshSettings()` catch leaves `this.scope = undefined` = no boundary (`src/mcp/server.ts:3252`); the K-CRIT fail-closed in `resolveActiveScope` is bypassed because the throw happens at config load. | CONFIRMED HIGH (security) |
| H2 | **Brownfield wipe-out chain:** `init -y` never commits config.toml → `undo` after first import deletes the file entirely → `apply --yes --force` treats missing config as *empty catalog* and writes `{"mcpServers": {}}` over the user's native config. "precious" server destroyed, zero warning. | init commits only .gitignore; apply fails open on missing config (import fails closed — inconsistent). | CONFIRMED HIGH (data loss) |
| H3 | **The drift gate fires on the canonical add→apply loop, forever.** Every `add server` → `apply` is gated (exit 1, "re-run with --force"); even the FIRST apply against `{}` is gated. And `apply --dry-run` **claims success** in the same state. Trains users to reflexively `--force` — which is what makes H2 lethal. | `src/adapters/claude-code/diff.ts:67-76` counts catalog-ahead servers as `removed-locally` drift; no last-applied snapshot. | CONFIRMED HIGH |
| H4 | **`--args "-y,…"` (space form) silently dropped.** Exit 0, success message, no `args` key written. `-y` is the canonical first arg of every npx/bunx MCP server. `--args="-y,…"` works. | citty/mri dash-peek: next token starting `-` is never taken as the flag value; `add.ts:159` falsy-skips. Unknown flags also silently accepted. | CONFIRMED HIGH |
| H5 | **Remote servers cannot be added via CLI; `--transport` silently swallowed.** `add server linear --transport streamable-http --command https://…` → exit 0, writes `transport = "stdio"`. Schema fully supports remote (ADR-0057); only the `add` flag surface is missing. | `add.ts:156` hardcodes `transport: "stdio"`; non-strict parser swallows unknown flags. | CONFIRMED HIGH |
| H6 | **`am search` AND `am install` are dead against the default registry.** Client calls `/api/packages` on registry.modelcontextprotocol.io which 404s; the real API is `/v0/servers` (curl-verified: tavily exists there). install masks the 404 as "Package not found". | `src/registry/client.ts:56,178,198` — API shape the official registry never served. | CONFIRMED HIGH |
| H7 | **Unrecognized-name plaintext secret silently committed to git.** `FAKE_KEY=sk-test…` imported in plaintext, committed, AND `secret scan` reports "No secrets detected". Control: `OPENAI_API_KEY` same value → encrypted beautifully. Any `*_KEY` outside the provider allowlist leaks. | No generic `[_-]key$` Tier-1 pattern (`secret-detection.ts:28-90`); betterleaks misses low-entropy values. | CONFIRMED HIGH |
| H8 | **Keystone has no door handle** (journey scored 4/10): scope is TOML-hand-edit-only (no CLI/MCP/TUI/web write surface), no help text mentions `tool_groups`/scope, and `AM_MCP_PROFILE` (how a connection selects a profile) appears in ZERO user-facing docs — README count: 0; only AGENTS.md. `mcp-serve --help` has no profile flag, no config snippet. | profile.ts create takes only --inherits/--description; docs gap. | CONFIRMED (vision auditor + journey #4 + Codex independently) |
| H9 | **"Git IS the sync protocol" breaks on real git:** SSH unsupported by construction (no onAuth, isomorphic-git has no SSH transport) while `setup --from user/repo --ssh` is an advertised flag generating exactly the URL that throws; no auth path for private HTTPS except plaintext token in URL; `am pull` does NOT auto-apply (README says it does, twice); catalog merge conflicts = raw isomorphic-git error (wiki got a typed-conflict flow; the catalog didn't). | git.ts:70-91,441 — no onAuth anywhere in src/. | CONFIRMED (mechanics HIGH-impact; message clarity MED) |
| H10 | **`doctor --json` exits 0 while `healthy:false`** — the natural agent gate `am doctor --json || abort` never fires. Plain doctor exits 1 correctly. Also doctor reports "OK (with warnings)" when the encryption key is gone but encrypted envelopes exist (apply is hard-broken in that state; the warning even describes the wrong direction — "will not be encrypted" vs *cannot be decrypted*). | doctor.ts:406-409 early-returns before exitCode=1; key-check severity. | CONFIRMED (test auditor + journey #5 + Codex, three independent sightings) |

## Confirmed MED (selected, all evidence-backed)

- **"Config not found → run `am init`" lie:** every load failure (parse error,
  schema error) is masked as CONFIG_NOT_FOUND by list/status/profile/etc; the
  suggested `am init` then dies with a doubled raw stack trace. doctor has the
  correct humanized error — the catch-all swallows it. (journeys #1/#4/#5/#6 —
  four independent sightings)
- **Wrong-key decrypt error is raw WebCrypto noise** ("The operation failed for
  an operation-specific reason"), `--verbose` adds nothing, and the missing-key
  error recommends `generate-key` — which converts a recoverable state into
  permanently-cryptic (the right answer is `secret import-key`). (journey #3)
- **Drift is a count, never a name:** `status -v`/`--json` show "2 changes" but
  never which servers; the diff engine produces the detail and display drops it.
- **Drift-gate refusal omits the safe remedy** (`am import <tool>` then apply —
  verified to work) and only offers destructive `--force`.
- **`undo` silently discards uncommitted config.toml edits**; no dirty-tree
  guard. `undo --apply` is self-defeating (always drift-gated, no --force).
- **Circular profile inheritance passes `config validate` AND `doctor`**, `use`
  activates the broken profile silently; gateway then serves 0 tools with no
  stderr diagnostic.
- **`secret`/`secrets` top-level split** with zero cross-referencing — the
  clig.dev "update/upgrade" anti-pattern; `am secret rotate` → unknown-command
  help-dump with no pointer to `am secrets rotate`.
- **mcp-superset is pillar-orthogonal** (reads ~/.claude.json directly, bypasses
  the catalog entirely — the repo's own ADR-0031 "reconsider" flag applies).
- **Marketplace still advertised in root help** while docs say it's out of the
  v1 surface.
- Test-quality: README's init→import→apply never tested as a sequence with real
  engines; compiled binary never runs `apply`/`secret`/`setup`; macOS binary
  never executed; `mcp-serve` stdio loop never spoken to by any test;
  destructive non-TTY commands (uninstall/update) fail OPEN (skip confirm).

## What's genuinely good (verified, multiple independent sightings)

- **Keystone enforcement engine:** intersection semantics, deny-wins, double
  enforcement (list+call), fail-closed on circular inherit *at the gateway*,
  `profile show --tools` manifest is "the best artifact in the journey", agent-
  grade refusal messages, `x-am` tool metadata, `am_get_scope` introspection.
- **Secret pipeline ingest:** URL-credential + env obfuscate-on-ingest is
  seamless; plaintext provably absent from disk AND all git history; the
  "refusing to pass ciphertext through" message is security-UX gold.
- **One write path** (CLI/MCP/TUI/web through withConfig/applyResolved) is real;
  CF worker correctly shares zero core code.
- **JSON plumbing:** 7/7 happy-path commands emit pure parseable stdout JSON;
  NDJSON warnings on stderr; `{error, suggestion, code}` envelope; dry-run
  envelope (ADR-0038) is "best-in-class agent affordance".
- **Test infrastructure:** self-enforcing CLI-handler-coverage guard; compiled-
  binary CI smoke exists (Linux+Windows); error paths assert exit codes.
- **doctor as diagnostician** for config problems (row/col carets, humanized
  Zod); `log` glyph language; help is substantive at every depth tested.
- Wiki pipeline is real (8 session readers, graph-connected pages, FF-only sync
  with typed conflicts) — not scaffolding.

## Research take-aways

**CLI-UX (clig.dev / gh / 12-Factor / Ronacher):** the implications list lives in
the research output; the top items map 1:1 onto confirmed findings — exit codes
must mean health (H10), unknown-command should error-first with did-you-mean,
the `secret`/`secrets` split is the documented anti-pattern, `--json` is the
stable agent contract and CLI-over-MCP is how agents actually arrive (Ronacher).

**Competitive:** mcpm (profiles but install-time only), Smithery (zero-OAuth
credential UX — am's gap for remote servers), Docker MCP Toolkit (container
trust), Ruler/rulesync (`revert` / `convert --dry-run` — cleaner trial/exit UX),
agentgateway (validates the tool-level-authz thesis at enterprise scale).
**am's unique differentiation — no competitor has it:** *one profile object that
scopes both config AND runtime* — `am use work` rewrites 13 tools' configs and
narrows the live MCP surface, enforced at list+call, introspectable, versioned
in git. The 2026 table stakes am must meet: sub-2-minute first win; invisible
auth for remote servers; reversibility/dry-run everywhere (exactly the H2/H3
cluster).

## Priority order (recommended)

1. **P0 security/data-loss:** H1 (scope fail-open) · H2 (undo→apply wipe; init
   must commit config.toml; apply must fail closed on missing config) · H7
   (plaintext `*_KEY` leak + scan false-negative).
2. **P0 broken core loops:** H3 (drift gate on add→apply + dry-run lying) · H6
   (registry API) · H4/H5 (add-server arg parsing + transport).
3. **P1 keystone last-mile:** H8 (scope authoring + AM_MCP_PROFILE docs +
   mcp-serve --profile flag + config snippet) — this is the differentiator;
   Codex's "one action this week" and journey #4 agree.
4. **P1 agent contract:** H10 + the CONFIG_NOT_FOUND lie + error-envelope
   consistency.
5. **P2:** secret/secrets merge, drift naming, safe-remedy hints, undo guards,
   marketplace help visibility, mcp-superset reframing, test gaps (first-run
   sequence, mcp-serve stdio, binary apply).

## Reviewer framing (what nobody checked — for a human)

- Real second-machine sync over a real private remote (needs credentials).
- TUI and local-web UX were not journey-tested (CLI only).
- A2A/ACP flows against live agents.
- Windows-native UX (all journeys ran on Linux/WSL).
