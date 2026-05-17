---
status: proposed
date: 2026-05-05
amends: ADR-0043
amended_by: [ADR-0049]
---

# ADR-0045: Hosted UI Editor — CodeMirror 6 Default, Monaco Optional for Local

## Context

ADR-0043 (proposed) lays out the hosted UI auth and git-backend tiers but
implies Monaco editor for the in-browser editing surface. Subsequent
research (`docs/research/2026-05-05-B-followup/lens-b-web-editing-ux.md`)
and the synthesis memo
(`docs/design/2026-05-05-hosted-ux-secrets-synthesis.md` §3.3) flagged
Monaco's bundle size as a hard constraint conflict with Cloudflare
Workers' cost/latency profile.

Bundle sizes (minified + gzipped, with TOML language support):

- **CodeMirror 6** (`@codemirror/state` + `@codemirror/view` +
  `@codemirror/lang-json` + tree-sitter-toml WASM): ~250 KB
- **Monaco** (full): ~2-3 MB

For a hosted UI served from Cloudflare Workers free tier (assets
served from edge), the 10× difference impacts:

- Worker free-tier asset budget (1 MB per response on free; paid tiers
  are higher but still cost-aware).
- Cold-load latency on mobile / slow connections.
- Cost per request for the hosted SaaS.

A 6-reviewer fan-out deliberation (`docs/deliberations/2026-05-05-D-fanout/CONVERGENCE.md`)
returned **5/6 in favor of CodeMirror 6 for the hosted UI**. The
single NUANCED vote (deepseek) said "CM6 is fine; consider lazy-load
Monaco behind a feature flag for power users on `am serve`," which is
compatible with the majority position.

TOML doesn't need IntelliSense's heavy machinery — schema validation
via a Web-Worker linter is sufficient. Users editing TOML in the
hosted UI are not editing TypeScript — they're editing config files
with constrained schema.

## Decision

We **amend ADR-0043** to specify:

### 1. Hosted UI (`am.example.com`, Cloudflare Workers): CodeMirror 6

The browser editor surface in the hosted UI is **CodeMirror 6 with the
TOML language pack**.

- Syntax highlighting via `@codemirror/lang-json` plus a tree-sitter-toml
  grammar (or `@codemirror/lang-toml` if one ships first-party in the
  CM6 ecosystem; otherwise a community pack).
- Schema-driven validation via a Web Worker linter that reads the am
  config schema (Zod-derived JSON schema) and reports errors inline.
- Keymap defaults to vim/emacs/standard via CM6 keymap extensions, user
  preference saved in localStorage.
- Bundle target: ≤ 300 KB minified + gzipped.

### 2. Local UI (`am serve`, Hono): CodeMirror 6 default, Monaco optional

`am serve` (the local web UI, not the hosted Worker) defaults to the
same CodeMirror 6 surface for consistency. Users who want full IDE
feel (IntelliSense, multi-cursor edit, Monaco's git diff view, etc.)
can opt in via `settings.serve.editor = "monaco"`. Monaco is
lazy-loaded on first use; bundle weight stays out of the default
serve experience.

This means:

- Documentation can describe a single editor (CM6) for 90%+ of users.
- Hosted UI vs local UI rendering is identical.
- Power users running `am serve` can upgrade in two-line config
  change.

### 3. TOML language pack provenance

The TOML language pack (whether `@codemirror/lang-toml` or community
fork) must be:

- **Subresource-integrity-pinned** to a hash in the static-asset
  build.
- **No dynamic imports** from third-party CDNs (would defeat ADR-0042
  §5.4.2 browser-as-TEE mitigation).
- **Audited against the Worker static-asset CSP** (no eval, no
  inline scripts).

If no first-party `@codemirror/lang-toml` exists with provenance
acceptable to the project, the project ships its own fork. ~150 LOC.

### 4. ADR-0043 changes

In ADR-0043, references to "Monaco editor" in the hosted UI tier
language are replaced with "CodeMirror 6 editor (per ADR-0045)."
ADR-0043 §2 (auth tiers) and §3 (transport) are unchanged.

## Consequences

### Positive

- 10× smaller bundle on the hosted UI's critical path.
- Mobile users get a usable experience.
- Worker asset budget consumed by app logic, not the editor.
- Single editor surface to test, document, and audit.

### Negative

- TOML language pack is not first-party — added supply-chain
  surface (mitigated by §3 above).
- Power users on `am serve` must opt in to Monaco (one config change;
  documented).
- CodeMirror 6 IntelliSense is weaker than Monaco's; for TOML schema
  validation that's fine, but if am ever ships a richer language
  surface (e.g. embedded YAML, embedded scripting) this decision may
  warrant revisit.

### Neutral

- Existing CM6-using projects (Decap CMS, Sveltia, the new
  `code.visualstudio.com` web variant for Codespaces) provide a
  large reference base for our integration.

## Verification gates (must hold before promoting to `accepted`)

1. **CM6 bundle measured** in CI on each PR; alert if > 350 KB
   minified + gzipped.
2. **TOML language pack provenance verified** — SRI pin, no
   dynamic imports, CSP-clean.
3. **Schema-validation-via-Web-Worker integration tested** end-to-end
   on the hosted UI fixture.
4. **`am serve` Monaco opt-in path tested** — config switch loads
   Monaco lazily; default remains CM6.
5. **ADR-0043 updated** to reference this ADR for the editor choice.

## Promotion Audit (2026-05-16)

**Decision: stays `proposed`.**

[ADR-0049](0049-hosted-ui-editor-cm6-implementation.md) (`accepted`
2026-05-05) ratifies the hosted-UI implementation mechanics (language
pack, mount route, lint Web Worker, SRI/CSP headers) and confirms the
CM6-over-Monaco direction. It does not, however, close every
verification gate this ADR set.

**Unmet verification gates:**

- **Gate 4 (`am serve` Monaco opt-in path).** ADR-0049 is scoped
  exclusively to the Cloudflare Worker hosted UI; it does not cover
  `am serve` (the local Hono surface). The `settings.serve.editor =
  "monaco"` opt-in path described in this ADR §2 has no
  implementation plan, no test, and no acceptance ADR. Until either
  (a) that opt-in is implemented and tested, or (b) a follow-up ADR
  retracts the local-Monaco escape hatch and consolidates on CM6
  everywhere, this gate is open.
- **Gate 5 (ADR-0043 updated to reference this ADR).** Inspection of
  ADR-0043's References section shows no link to ADR-0045. The
  cross-reference is one-way (this ADR → 0043) but not the reciprocal
  edit ADR-0045 §4 promised. A clerical fix on ADR-0043's body would
  close it; we are not making that edit in this audit because
  ADR-0043 is out of file scope and is itself staying `proposed`.

Gates 1–3 are addressed by ADR-0049 (bundle ≤ 300 KB enforced in CI,
language-pack provenance handled by `@codemirror/legacy-modes/mode/toml`
first-party, schema-via-Web-Worker integration tested at
`test/web/lint-worker.test.ts`).

**What would close this ADR:**

Either retract the `am serve` Monaco opt-in (simplest: make this ADR
hosted-only and let `am serve` inherit the same CM6 surface unchanged
— ADR-0049 already covers that case), OR ship the opt-in with a
test. Plus the one-line cross-link in ADR-0043's References. Both
deliverables are small; this is a "next pass" ADR, not a structural
re-evaluation.

**Tracking:** no seeds task currently filed; recommend opening one
under domain `docs` or `web` to capture the opt-in decision before
attempting promotion.

## References

- [ADR-0043](0043-hosted-ui-auth-and-git-backend-tiers.md) — auth +
  transport (this ADR amends the editor choice)
- `docs/research/2026-05-05-B-followup/lens-b-web-editing-ux.md` —
  research that flagged the bundle-size constraint
- `docs/design/2026-05-05-hosted-ux-secrets-synthesis.md` §3.3 —
  synthesis recommending CM6
- `docs/deliberations/2026-05-05-D-fanout/CONVERGENCE.md` — 5/6
  reviewers in favor of CM6
- CodeMirror 6 docs: https://codemirror.net/6/
- Decap CMS uses CodeMirror 6 in its Editorial Workflow editor.
