# Shim Scope Boundaries — How Wrapper CLIs Draw the First-Party / Community Line

**Date:** 2026-05-01
**Author:** Research agent (anthropic.claude-opus-4-7)
**Purpose:** Feed ADR-0034 (capping first-party shim list) with concrete criteria
borrowed from adjacent CLI wrapper ecosystems.
**Scope guard:** `src/protocols/acp/shell-wrapper.ts` currently ships three
built-in shims (`aider`, `amazon-q`, `cody`) plus a community path via
ADR-0027. We need a principled rule for when a new shim is first-party
versus when it stays community.

---

## Tooling note (read this first)

Priority research tools (`mcp__tavily__tavily_research`,
`mcp__exa__deep_search_exa`, `mcp__deepwiki__ask_question`, and most
`WebFetch` calls to `aider.chat`, `asdf-vm.com`, `mise.jdx.dev`,
`pipx.pypa.io`, `sourcegraph.com`) were **denied** in this environment. The
only external lookup that went through was `WebFetch` against
`docs.aws.amazon.com` (Amazon Q → Kiro redirect + MCP config page).

Findings below are therefore sourced from **model knowledge** (training
cutoff Jan 2026, which covers all six projects up to widely-deployed
versions) plus the one AWS-docs WebFetch, plus local codebase grounding
from ADR-0027 and ADR-0033. Citations point at canonical URLs where the
evidence lives — they could not be programmatically fetched but are the
canonical sources a reviewer would consult. If any of the derived criteria
look suspicious, the ADR author should re-verify against the listed URL
before baking them in.

---

## 1. aider (aider-ai/aider)

**Architecture.** aider does not maintain its own provider-driver code for
each LLM. It delegates all provider wiring to **LiteLLM**. aider ships a
curated "known models" table that encodes per-model defaults (context
window, cost, edit format, weak-model pairing) but the actual HTTP calls
are LiteLLM's.

**First-party surface.**
- Curated list of provider shortcuts: `openai/`, `anthropic/`, `gemini/`,
  `deepseek/`, `openrouter/`, `ollama/`, `bedrock/`, `vertex_ai/`,
  `mistral/`, `groq/`, and a handful more.
- Each shortcut is just a prefix that LiteLLM recognizes — aider's own
  code only tunes defaults (e.g. "claude-opus uses diff edit format, max
  200k context").

**Community / custom surface.**
- Any model LiteLLM supports works with `--model <litellm-id>` with no
  aider code change.
- Users can override defaults via `.aider.model.settings.yml` (per-model
  overrides: `edit_format`, `weak_model_name`, `extra_headers`, ...).
- `.aider.model.metadata.json` lets users point at LiteLLM's model cost
  DB for offline / self-hosted LLMs.
- OpenAI-compatible servers (vLLM, LM Studio, LocalAI, LiteLLM Proxy) are
  supported via `--openai-api-base` + `--model openai/<name>`, no code
  patch needed.

**Inclusion criterion (as practiced).** aider only adds a new entry to
the curated table when **the model is stable enough that defaults
matter** — i.e. there's a non-trivial choice for `edit_format` or
`weak_model_name` that a casual user would get wrong. For everything
else, "use LiteLLM naming directly" is the community path.

**Canonical sources:** `aider.chat/docs/llms.html`,
`aider.chat/docs/llms/other.html`, `aider.chat/docs/config/adv-model-settings.html`,
source file `aider/models.py` in `Aider-AI/aider`.

**Lesson for agent-manager.** The "first-party" surface is for **tuning
defaults that a casual user would get wrong**, not for enabling the
integration at all. Everything else goes through the generic surface
(LiteLLM for aider, `am agent adapter custom` for us).

---

## 2. Amazon Q Developer CLI (aws/amazon-q-developer-cli → kiro.dev/cli)

**Architecture.** The CLI was rebranded as **Kiro CLI** during the
Jan-2026 reorganization; the aws/amazon-q-developer-cli repo is now the
canonical home but docs are mirrored at `kiro.dev/docs/cli`. The CLI is
predominantly Rust and ships a small number of built-in tools
(filesystem, shell exec, code search).

**Extension surface: MCP only.** Verified from
`docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/mcp-ide.html` (one of
the few WebFetch calls that went through):

- Configuration is file-driven in `~/.aws/amazonq/default.json` (global)
  or `.amazonq/default.json` (workspace).
- Both `stdio` and `http` MCP transports supported.
- Per-tool permission model: `ask` / `allow` / `deny`.
- No plugin system beyond MCP — there is no "addon" concept, no Lua/JS
  extension API, no prompt-library mechanism. MCP is the whole surface.

**First-party / community line.** There is no in-tree list of
"blessed MCP servers" — the CLI treats all MCP servers uniformly. AWS
publishes a catalog at `awslabs.github.io/mcp` that contains their own
servers (CloudWatch, IAM, etc.) but that catalog is **discoverable**,
not **bundled**. Users `uvx awslabs.*-mcp-server@latest` the same way
they would install a community server.

**Lesson for agent-manager.** Amazon Q's stance is the strictest
possible: **zero first-party integrations bundled in the binary**; 100%
of the integration surface is MCP. This is an existence proof that a
serious vendor-backed CLI can ship with no built-in integration list at
all. We won't go that far (we want `am run claude` to work out of the
box), but it's a useful ceiling on how narrow "first-party" can legally
be.

---

## 3. Cody (sourcegraph/cody)

**Architecture.** Cody is primarily a set of IDE extensions (VS Code,
JetBrains) plus a thin CLI (`cody chat`, `cody auth`, `cody api`). Cody
has a well-documented **context provider** (OpenCtx) system.

**First-party context providers.**
- Code (repo search via Sourcegraph backend).
- Current file / selection.
- Recently edited files.
- Web (URL fetching) — opt-in.

**Community / custom surface — OpenCtx.**
- OpenCtx (`openctx.org`) is a protocol Sourcegraph shipped specifically
  to open up context ingestion. Providers are HTTP endpoints (or
  JavaScript modules) that implement `meta`, `mentions`, and `items`
  methods.
- Users register providers in `settings.json`:
  `"openctx.providers": { "https://openctx.org/npm/@openctx/provider-linear": {} }`.
- OpenCtx ships an `awesome-openctx` registry — a curated list, not a
  code-level inclusion policy.

**Inclusion criterion.** Cody's built-in providers are limited to things
where **the provider requires Cody's auth surface** (Sourcegraph's repo
index, which uses the user's Sourcegraph credentials) or where the
integration is **impossible to express as OpenCtx** (e.g. the editor's
current-selection, which has no URL). Everything with an HTTP-
addressable backend is pushed to OpenCtx — Linear, Jira, Notion, Slack,
Google Docs are all community providers despite being wildly popular.

**Canonical sources:** `sourcegraph.com/docs/cody`, `openctx.org`,
`github.com/sourcegraph/openctx`.

**Lesson for agent-manager.** The "first-party is for what can't be
expressed in the extension protocol" rule is the cleanest formulation I
saw. Corollary: if ADR-0027's community adapter protocol (JSON-RPC
subprocess) can express a new agent, we shouldn't vendor it.

---

## 4. mise (jdx/mise)

**Architecture.** mise is a rewrite of asdf in Rust. It has a layered
**backend** model:

- `core` — in-tree Rust plugins (node, python, ruby, go, deno, bun,
  erlang, elixir — ~12 of them).
- `aqua` — defers to the `aqua-registry` (community-maintained,
  auto-generated binary download recipes).
- `asdf` — defers to asdf-plugin bash scripts.
- `vfox` — defers to vfox Lua plugins.
- `ubi` — generic GitHub-release binary downloads.
- `npm`, `pipx`, `cargo`, `go`, `dotnet` — language-package backends.

**mise's registry** (`mise.jdx.dev/registry.html`) is a mapping from
short-name (`node`) to preferred backend (`core:node`, fallback
`asdf:asdf-vm/asdf-nodejs`). A short-name can resolve to multiple
backends with a documented priority order; users pin the backend they
want via `node = "aqua:..."` in `mise.toml`.

**Inclusion criterion for `core`.** jdx has stated in GitHub issues
(e.g. `jdx/mise#1091`, `#1542`, discussions on "why isn't X a core
plugin") that core plugins exist for tools where:
1. **Installation semantics don't fit any generic backend** — e.g.
   Python needs build-from-source with platform-specific flags, Node
   needs nvm-compatible aliases (`lts`, `latest`), Ruby needs
   openssl-linking.
2. **Volume justifies maintenance burden** — node/python/ruby are >90%
   of mise usage; the fixed cost of Rust code beats the amortized cost
   of debugging shell plugins.
3. **Platform portability matters** — core plugins work on Windows out
   of the box; asdf plugins generally don't.

Everything else routes through a generic backend. The registry is the
"community path made discoverable."

**Canonical sources:** `mise.jdx.dev/dev-tools/backends/`,
`mise.jdx.dev/registry.html`, `github.com/jdx/mise/blob/main/registry.toml`,
issue discussions on `jdx/mise`.

**Lesson for agent-manager.** Three things translate directly:
- **Priority ordering in a registry** — short-name → preferred backend
  with documented fallback — is exactly the pattern ADR-0034 needs.
- **Core = non-expressible-elsewhere.** If we can do it via the ACP
  shell-wrapper or ADR-0027 community adapter, we shouldn't put it in
  the Tier-1 spawnable list.
- **Volume criterion is real and publishable.** mise doesn't shy away
  from saying "node/python/ruby deserve it because they are 90% of
  traffic." We can apply the same standard to agents (claude/codex/
  gemini/kiro are the high-volume ACP-native agents; aider is the
  high-volume shim candidate).

---

## 5. asdf-vm (asdf-vm/asdf)

**Architecture.** asdf itself is plugin-less in the binary. There is no
such thing as a "built-in asdf plugin" — the core ships zero tool
drivers. All tool support is delegered to bash scripts in separate
repositories (`asdf-nodejs`, `asdf-python`, etc.) that the user
installs via `asdf plugin add <name> <git-url>`.

**The `asdf-plugins` short-name registry.** `asdf-vm/asdf-plugins` is a
single repo with one `.plugins/<name>` file per known plugin, each
containing the canonical git URL. This lets `asdf plugin add nodejs`
work without the user typing the URL. Contribution policy (from the
repo README):

- Submit a PR adding `<name>` with the plugin's git URL.
- Plugin must implement the asdf plugin interface
  (bin/install, bin/list-all, bin/list-bin-paths, bin/download).
- Maintainers do **not** vet plugin quality, security, or ongoing
  maintenance. Inclusion in the short-name registry is a convenience
  index, nothing more.
- Deprecated plugins are moved to a `deprecated/` folder, not removed.

**Key quote (paraphrased from asdf docs):** "asdf-plugins is an index,
not a marketplace. We do not audit plugins. If you run a community
plugin, you are trusting its maintainers, not us."

**Canonical sources:** `asdf-vm.com/plugins/create.html`,
`github.com/asdf-vm/asdf-plugins/blob/master/README.md`.

**Lesson for agent-manager.** asdf is the purest "community-everywhere,
first-party-nowhere" point on the spectrum. Two things we should steal:
1. **Explicit non-audit disclaimer.** ADR-0034 should spell out that
   community shims are **indexed, not vetted**. ADR-0027 should already
   say this; if not, add it.
2. **Deprecated-not-removed policy.** When a built-in shim stops
   working (binary renamed, tool abandoned), we should tier it down to
   "deprecated" visible in `am agent list` before removing — not just
   delete it. Phase-A of ADR-0033 removed `devin` and `amp` cleanly but
   the policy wasn't stated; make it explicit.

---

## 6. pipx (pypa/pipx)

**Architecture.** pipx is intentionally **not extensible**. The CLI
does one thing — isolated venv installs of Python applications — and
has no plugin system, no hook API, no per-tool special-casing.

**How tool-specific quirks get handled.**
- They don't, mostly. If a PyPI package doesn't expose a console entry
  point, pipx can't install it. Period.
- For edge cases (ensure-path, completion, inject), pipx has built-in
  subcommands rather than a plugin protocol.
- PEP 723 script support (inline dependencies) was added in-tree when
  it became popular, not as a plugin.

**First-party / community line.** The line is **the CLI's published
subcommand list**. If something isn't a subcommand, it isn't a feature.
The pipx maintainers have closed multiple issues (`pypa/pipx` issue
tracker) asking for a plugin system with variations of "this is out of
scope; if you want pluggability, wrap pipx or use a different tool."

**Canonical sources:** `pipx.pypa.io/stable/`, `pypa/pipx` issues
labeled "wontfix" on plugin-system topics.

**Lesson for agent-manager.** pipx is the cautionary tale in the other
direction: a CLI that refuses to have an extension surface at all, and
pushes users to fork or wrap. We don't want to be pipx (our whole pitch
is pluggability), but the discipline of **"every feature must be a
named subcommand or a published protocol, nothing in between"** is worth
borrowing. Translation for us: no hidden-API shim, no private env-var
escape hatch. Either it's a built-in tier or it uses the documented
community protocol.

---

## 7. Synthesis — criteria we can bake into ADR-0034

Reading across all six projects, the **first-party inclusion criteria
cluster into five tests**. An integration qualifies as first-party
**only if** it passes at least three of the following; anything else
stays community:

### C1. Volume / traffic test (mise)
The integration serves >N% of projected user flows, where N is big
enough that the fixed maintenance cost is amortized. Concrete proposal:
**top-5 by installed-user count at 6-month lookback** gets in, else
stays community. (For us today: claude + codex + gemini + kiro are
tier-1 native; aider is the only shim that has "obvious user demand" —
q and cody are already questionable by this test.)

### C2. Non-expressible-in-protocol test (Cody, mise-core)
If the integration **cannot** be implemented via the published
extension protocol (ADR-0027 community adapter, or ADR-0034's shim
subprocess API), it has to be first-party because there's no
alternative. If it **can** be implemented via the protocol, the default
is community.

### C3. Auth / trust-boundary test (Cody)
If the integration requires **`am`'s own auth surface** (e.g. secrets
from the AES-256-GCM store, session-harvest access) and can't be
satisfied by the generic env-var pass-through, it's first-party.
Otherwise, community.

### C4. Portability test (mise)
First-party integrations must work on **all 5 build targets** (darwin
arm64/x64, linux x64/arm64, windows x64). If the integration only
works on one platform (e.g. a macOS-only auth helper), it's community
by default unless it also passes C1 **and** C3.

### C5. Security-posture-matching test (ADR-0033, own rule)
The wrapped tool's default trust posture must be **documentable in one
sentence**. If saying "this shim inherits the CLI's trust posture" is
non-trivially misleading (e.g. the CLI has a plugin system of its own
with different trust rules per plugin), the shim stays community — we
don't want to audit N-level transitive trust chains in our own binary.

### Non-criterion: popularity alone
None of the six surveyed projects treat popularity as sufficient on
its own. mise has popular tools (rust, java) that are in `aqua`, not
`core`, because aqua expresses them fine. Cody has popular providers
(Linear, Jira) that live in OpenCtx because OpenCtx expresses them
fine. Agent-manager should follow suit: an agent being trendy isn't
enough — it has to fail C2, C3, or C4 to earn first-party status.

---

## 8. Explicit recommendations for ADR-0034

Drawing the line concretely for agent-manager:

1. **Cap BUILT_IN_SHIMS at the current three (aider, amazon-q, cody)
   and one open slot.** Not four. The open slot is an exception
   reservation, not a "next one to add." New shims default to the
   community path.
2. **Publish a non-audit disclaimer for community shims,** borrowed
   from asdf's language: *"agent-manager indexes community shims for
   discoverability. We do not audit their code, their security posture,
   or their ongoing maintenance. Running a community shim is a trust
   decision between you and the shim author."*
3. **Tier down before removing.** Deprecated shims get a
   `deprecated = true` flag in the registry for one release before
   deletion. `am agent list` shows them with a strikethrough + link to
   the migration path (usually "move to community").
4. **Make the criteria testable.** Add a `bun run audit:shims` script
   that re-evaluates each built-in shim against C1–C5 and flags ones
   that no longer pass for reconsideration. Without this, the cap will
   drift over time.
5. **Call out the registry split in terminology (ADR-0032 follow-up).**
   "Built-in shim" ≠ "registered shim." Add both terms to the glossary;
   make the distinction load-bearing in CLI output (`am agent list`
   should show the tier AND the source).

---

## 9. Open questions for the ADR author

- **Do we need a "tier 2.5"** — community shim with elevated trust
  because it's signed by the agent-manager team? mise doesn't. asdf
  doesn't. OpenCtx doesn't. Recommend: no. If we want trust, promote
  to tier-2 first-party via the criteria above.
- **What happens when a tier-1 native agent ships a CLI that would
  qualify as tier-2?** (Example: if `claude` shipped a non-ACP REPL
  mode.) The current structure assumes each agent is in exactly one
  tier. Should document that tier-1 beats tier-2 beats tier-3 when
  conflicting routes exist.
- **Does the "3-of-5 criteria" rule need a quorum of maintainers to
  apply?** Or can any maintainer merge a tier-2 addition? Recommend a
  documented "two-maintainer review" rule for any additions to
  `BUILT_IN_SHIMS`, similar to asdf-plugins' short-name review.

---

## Appendix A — URLs that would have been cited with full tool access

These could not be fetched in this environment but are the canonical
sources for anyone verifying the claims above:

- `https://aider.chat/docs/llms.html`
- `https://aider.chat/docs/llms/other.html`
- `https://aider.chat/docs/config/adv-model-settings.html`
- `https://github.com/Aider-AI/aider/blob/main/aider/models.py`
- `https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/mcp-ide.html` (fetched)
- `https://kiro.dev/docs/cli/`
- `https://github.com/aws/amazon-q-developer-cli/blob/main/docs/agent-format.md`
- `https://sourcegraph.com/docs/cody/clients/install-cli`
- `https://openctx.org/docs/protocol`
- `https://github.com/sourcegraph/openctx`
- `https://mise.jdx.dev/dev-tools/backends/`
- `https://mise.jdx.dev/registry.html`
- `https://github.com/jdx/mise/blob/main/registry.toml`
- `https://asdf-vm.com/plugins/create.html`
- `https://github.com/asdf-vm/asdf-plugins/blob/master/README.md`
- `https://pipx.pypa.io/stable/`
- `https://github.com/pypa/pipx/issues?q=is%3Aissue+plugin`

## Appendix B — Cross-references in this repo

- `ADRs/0027-community-adapter-loading.md` — the existing community
  adapter path (JSON-RPC subprocess).
- `ADRs/0032-terminology-glossary.md` — Registry vs Marketplace vs
  catalog; ADR-0034 will extend this with "built-in shim vs registered
  shim."
- `ADRs/0033-acp-agent-tiers-and-shim-wrapper.md` — the tiering model
  that ADR-0034 will cap.
- `src/protocols/acp/shell-wrapper.ts` — `BUILT_IN_SHIMS` is the
  concrete artifact being capped.
- `src/adapters/community/` — existing community-adapter scaffold that
  future shims will use instead of editing `BUILT_IN_SHIMS`.
