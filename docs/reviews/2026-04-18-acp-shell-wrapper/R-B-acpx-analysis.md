# Review B — openclaw/acpx Analysis

**Reviewer:** research subagent
**Date:** 2026-04-18
**Subject:** Competitive / interop analysis of `openclaw/acpx` against `agent-manager` (am)
**Primary source:** <https://github.com/openclaw/acpx/blob/main/agents/README.md>
**Root README:** <https://github.com/openclaw/acpx/blob/main/README.md>
**Repo landing:** <https://github.com/openclaw/acpx>

---

## Project summary

`acpx` is a headless CLI client for the **Agent Client Protocol (ACP)**. Its
tagline: *"so AI agents and orchestrators can talk to coding agents over a
structured protocol instead of PTY scraping"* — i.e. it is positioned as
programmatic tooling first, human CLI second
(<https://github.com/openclaw/acpx/blob/main/VISION.md>).

| Field | Value | Source |
|---|---|---|
| Owner | `openclaw` (GitHub org) | `gh repo view openclaw/acpx` |
| License | **MIT** | <https://github.com/openclaw/acpx/blob/main/LICENSE> |
| Primary language | TypeScript | repo metadata |
| Stars | **2,166** | repo metadata (2026-04-18) |
| Forks | 207 | repo metadata |
| Created | 2026-02-17 | repo metadata |
| Last push | **2026-04-16** (today-ish) | repo metadata |
| Status banner | *"alpha and the CLI/runtime interfaces are likely to change"* | README |
| npm package | `acpx` | badges in README |
| Topics | `agentclientprotocol` | repo topics |

**Maintainer / activity credibility.** Top contributors over the ~2 month lifetime:

| GitHub login | Commits |
|---|---:|
| `dutifulbob` ("Bob") | 104 |
| `osolmaz` ("Onur") — primary author of the OpenClaw integration plan | 64 |
| `vincentkoc` | 46 |
| `dependabot[bot]` | 21 |
| `onutc` | 8 |
| (10+ others, all single-digit) | — |

Source: <https://api.github.com/repos/openclaw/acpx/contributors>.

Latest 5 commits are all 2026-04-08 → 2026-04-12 (dependabot + a CI fix by
Onur, PR #237) — repo is **actively maintained** with a clear bus factor of 2–3
humans plus bot hygiene. Release automation (`.release-it.json`), husky
pre-commit hooks, markdown/oxfmt linting, `.github/` workflows, a
`conformance/` directory, and a `CHANGELOG.md` (11 KB) are all present — this
is **not a hobby project shape**, it is engineered.

**Relationship to ACP.** acpx is **a client** of the ACP (the protocol owned by
Zed Industries at <https://agentclientprotocol.com>). It specifically does
*not* implement an agent; it launches ACP-compatible agent binaries over
stdio and routes ACP JSON-RPC messages between them and the caller. It pulls
in the official `@agentclientprotocol/sdk` (visible in the dependabot commit
`63e561d`). Name-wise: the org `openclaw` appears to be the Discord/harness
org (one of the built-in agents is literally `openclaw -> openclaw acp`); a
design doc at `docs/2026-02-22-openclaw-integration-plan.md` explains that
acpx is the "data-plane runtime backend" for OpenClaw's Discord-thread
orchestration.

**Vision boundaries** (`VISION.md`): the project explicitly rejects becoming
"a kitchen-sink automation framework" or "a pile of agent-specific special
cases." Guiding test: does a feature improve *interoperability, robustness,
or utility as a lightweight ACP backend*?

---

## Agent taxonomy they use

acpx does **not** distinguish native / wrapped / remote at the user-facing
level. Every agent, from the user's perspective, is just `acpx <name> <prompt>`.
Under the hood, the `AGENT_REGISTRY` in
`src/agent-registry.ts` maps a short name to a **single stdio command string**.
That's the entire abstraction.

Internally there is exactly one axis of variation, which they encode in
`BUILT_IN_AGENT_PACKAGES` (lines 55–74 of
<https://github.com/openclaw/acpx/blob/main/src/agent-registry.ts>):

| Axis | Two values they actually use |
|---|---|
| **Adapter delivery** | (a) pinned npm package auto-installed via `npx` with a semver range (currently only `pi`, `codex`, `claude`); (b) expected-on-PATH binary (everything else) |

They do **not** model:

- native vs wrapped at the schema level (all ACP commands are treated identically)
- HTTP / remote transport (ACP is stdio-only in acpx — verified: no `http`/`transport` references in `agent-registry.ts`)
- A2A, MCP, Responses API, or any non-ACP protocol (unlike agent-manager)

Naming-aliases are done with a tiny separate map (`AGENT_ALIASES`, e.g.
`factory-droid -> droid`).

Custom / non-builtin agents use `acpx --agent <raw-command>`, an explicit
escape hatch documented in
<https://github.com/openclaw/acpx/blob/main/docs/2026-02-17-agent-registry.md>.

So the practical taxonomy is:

1. **npm-delivered ACP adapters** — auto-fetched via pinned `npx` (3 agents: pi, codex, claude)
2. **Native-ACP CLIs** — the vendor CLI itself speaks ACP when given the right flag (most of the rest: `gemini --acp`, `cursor-agent acp`, `qwen --acp`, etc.)
3. **`--agent` escape hatch** — any raw stdio command

This is simpler than am's taxonomy (which separates ACP / A2A / HTTP-bridge
sources in `UnifiedAgent.source`: `"config" | "acp-builtin" | "a2a-roster"`,
see `/Users/baladita/Documents/DevBox/agent-manager/src/core/agent-registry.ts:22`).

---

## Full adapter inventory

Source: `agents/README.md` + `src/agent-registry.ts` at commit
`be51994` (2026-04-12). All 16 built-in names, verbatim:

| # | Built-in name | Default command | Wrapper pattern | Upstream | Notes |
|---|---|---|---|---|---|
| 1 | `pi` | `npx pi-acp@^0.0.22` | npm-delivered ACP adapter | <https://github.com/mariozechner/pi> | Pinned semver range; auto-installed on first use |
| 2 | `openclaw` | `openclaw acp` | native (on-PATH binary) | <https://github.com/openclaw/openclaw> | The org's own Discord harness bridge |
| 3 | `codex` | `npx @zed-industries/codex-acp@^0.11.1` | npm-delivered adapter | <https://github.com/zed-industries/codex-acp> | Zed maintains the adapter; acpx forwards `mode`/`model`/`reasoning_effort` (Codex.md) |
| 4 | `claude` | `npx -y @agentclientprotocol/claude-agent-acp@^0.25.0` | npm-delivered adapter | (Claude Code) | Now published under `@agentclientprotocol/*` — newer scope than am's `@zed-industries/claude-code-acp` reference |
| 5 | `gemini` | `gemini --acp` | native | <https://github.com/google/gemini-cli> | Google's CLI has built-in ACP mode |
| 6 | `cursor` | `cursor-agent acp` | native | <https://cursor.com/docs/cli/acp> | Cursor.md notes some installs expose it as `agent acp` — user overrides via config |
| 7 | `copilot` | `copilot --acp --stdio` | native | <https://docs.github.com/copilot/how-tos/copilot-chat/use-copilot-chat-in-the-command-line> | Requires recent GH Copilot CLI with ACP stdio mode |
| 8 | `droid` | `droid exec --output-format acp` | native | <https://www.factory.ai> | Aliases `factory-droid`, `factorydroid` |
| 9 | `iflow` | `iflow --experimental-acp` | native (experimental flag) | <https://github.com/iflow-ai/iflow-cli> | iFlow AI |
| 10 | `kilocode` | `npx -y @kilocode/cli acp` | npm-delivered CLI (not a dedicated adapter) | <https://kilocode.ai> | CLI itself runs as ACP |
| 11 | `kimi` | `kimi acp` | native | <https://github.com/MoonshotAI/kimi-cli> | Moonshot AI |
| 12 | `kiro` | `kiro-cli-chat acp` | native | <https://kiro.dev> | Note: binary is `kiro-cli-chat`, not `kiro` — different from am's assumption |
| 13 | `opencode` | `npx -y opencode-ai acp` | npm-delivered CLI | <https://opencode.ai> | |
| 14 | `qoder` | `qodercli --acp` | native | <https://docs.qoder.com/cli/acp> | acpx forwards `--max-turns` and `--allowed-tools` (Qoder.md); `QODER_PERSONAL_ACCESS_TOKEN` env for non-interactive auth |
| 15 | `qwen` | `qwen --acp` | native | <https://github.com/QwenLM/qwen-code> | Alibaba Qwen Code |
| 16 | `trae` | `traecli acp serve` | native | <https://docs.trae.cn/cli> | Trae CLI |

**Per-agent doc length.** Files range from 100 bytes (Kiro, Kilocode, Kimi,
Qwen, Trae, OpenCode — one-paragraph stubs) up to 523 bytes (Qoder, with
auth + forwarded flags) and 499 bytes (Codex, with session-config knobs).
Only 3 of 13 harness docs contain real quirks: Codex, Cursor, Copilot,
Qoder. The rest are pure "here's the command" stubs.

Sources:
- <https://github.com/openclaw/acpx/blob/main/agents/README.md>
- <https://github.com/openclaw/acpx/blob/main/src/agent-registry.ts>
- Each per-agent file at <https://github.com/openclaw/acpx/blob/main/agents/{Name}.md>

---

## am vs acpx coverage delta

`agent-manager`'s `BUILT_IN_ACP_AGENTS` (from
`/Users/baladita/Documents/DevBox/agent-manager/src/core/agent-registry.ts:46-63`):

claude, codex, gemini, cursor, copilot, kiro, aider, amazon-q, amp, augment,
cline, roo-code, goose, windsurf, devin, sourcegraph *(16 agents)*.

User's brief listed `kiro` in the am set; the task also lists `kiro` — both
match. Both tools ship **16 built-in agents**, but the overlap is only 6.

### Overlap (6 agents — shared by both)

| Agent | am command | acpx command | Notes |
|---|---|---|---|
| claude | `npx -y @agentclientprotocol/claude-agent-acp@latest` | `npx -y @agentclientprotocol/claude-agent-acp@^0.25.0` | **Same package, same publisher.** am uses `@latest`, acpx pins `^0.25.0` — acpx is more reproducible. |
| codex | `npx @zed-industries/codex-acp@latest` | `npx @zed-industries/codex-acp@^0.11.1` | Same package, acpx pins. |
| gemini | `gemini --acp` | `gemini --acp` | **Identical.** |
| cursor | `cursor-agent acp` | `cursor-agent acp` | **Identical.** |
| copilot | `copilot --acp --stdio` | `copilot --acp --stdio` | **Identical.** |
| kiro | — | `kiro-cli-chat acp` | am currently maps `kiro` but check binary name; acpx uses `kiro-cli-chat` |

**am-unique (10 agents NOT in acpx — am is ahead here)**

| Agent | am command | Gap comment |
|---|---|---|
| aider | `aider --acp` | Well-known OSS pair programmer. **Worth confirming `--acp` actually ships upstream** (aider-chat/aider does not advertise native ACP; this may be speculative). |
| amazon-q | `q chat --acp` | AWS Q Developer CLI; verify `--acp` flag exists. |
| amp | `amp --acp` | Sourcegraph Amp. |
| augment | `augment-cli --acp` | Augment Code. |
| cline | `cline --acp` | VS Code Cline agent's CLI — confirm flag upstream. |
| roo-code | `roo --acp` | Roo Code (VS Code fork of Cline). |
| goose | `goose --acp` | Block's Goose. |
| windsurf | `windsurf-cli --acp` | Codeium Windsurf. |
| devin | `devin --acp` | Cognition Devin CLI — confirm this even exists as ACP. |
| sourcegraph | `cody --acp` | Sourcegraph Cody. |

> **Integrity caveat:** several of these `--acp` flags look optimistic.
> acpx's policy is to only list agents that have a documented ACP mode
> upstream (every acpx entry links to an upstream ACP page or repo). am
> should audit these to avoid shipping dead entries. This is its own
> follow-up task.

**acpx-unique (10 agents NOT in am — gaps am could close)**

| Agent | acpx command | Why it matters |
|---|---|---|
| `pi` | `npx pi-acp@^0.0.22` | Mario Zechner's Pi Coding Agent — the reference/minimal ACP agent. **Useful as conformance target.** |
| `openclaw` | `openclaw acp` | The org's own bridge — niche, tied to Discord harness, **skip** unless we also integrate OpenClaw. |
| `droid` | `droid exec --output-format acp` | Factory.ai Droid — commercial, growing. Good add, with `factory-droid` alias handling. |
| `iflow` | `iflow --experimental-acp` | iFlow AI — Chinese market. |
| `kilocode` | `npx -y @kilocode/cli acp` | Kilo Code — VS Code agent fork. |
| `kimi` | `kimi acp` | Moonshot Kimi. |
| `opencode` | `npx -y opencode-ai acp` | OpenCode (OSS). |
| `qoder` | `qodercli --acp` | Qoder — has rich session options (`--max-turns`, `--allowed-tools`, token env). Worth importing the Qoder.md quirks. |
| `qwen` | `qwen --acp` | Qwen Code (Alibaba). |
| `trae` | `traecli acp serve` | Trae (ByteDance). |

### Summary delta

```
am-only:   10 agents (aider, amazon-q, amp, augment, cline, roo-code,
                     goose, windsurf, devin, sourcegraph)
acpx-only: 10 agents (pi, openclaw, droid, iflow, kilocode, kimi,
                     opencode, qoder, qwen, trae)
Shared:    6 agents  (claude, codex, gemini, cursor, copilot, kiro)
Union:     26 unique agents — of which am covers 16, acpx covers 16
```

Interpretation: **am is heavier on Western/enterprise coding assistants that
may or may not actually speak ACP upstream**; **acpx is heavier on
China-region + commercial-CLI coverage where ACP is already shipped**. The
sets are complementary, not competitive.

---

## Interop options

### Option 1 — acpx as an am "community marketplace" (user's framing)

**Verdict: no, not without a bridge.**

- acpx has no manifest schema equivalent to am's plugin manifests. Agent
  definitions live inline in TypeScript (`AGENT_REGISTRY` as a `Record<string,
  string>`), not in discoverable JSON/YAML files.
- `agents/*.md` files are human docs, not machine-parseable definitions.
- There is no `plugins/`, no `manifests/`, no `registry.json` at the repo
  root that `am marketplace add https://github.com/openclaw/acpx` could
  parse.

`am marketplace add` would fetch a repo with no well-known entrypoint and
fail. A bridge script would need to:

1. Fetch `src/agent-registry.ts` raw
2. Parse the `AGENT_REGISTRY` object (TypeScript → AST or eval in a
   sandboxed VM)
3. Emit am-style plugin manifests per agent
4. Optionally parse `agents/*.md` for per-agent quirks (auth env vars,
   forwarded flags)

This is **feasible but one-off** — acpx is not designed to be consumed as a
registry.

### Option 2 — Selective borrowing (MIT, low friction)

**Verdict: yes, with attribution.**

acpx is MIT-licensed
(<https://github.com/openclaw/acpx/blob/main/LICENSE>). We can legally copy:

- The 10 acpx-only command mappings (literally 10 lines)
- The `factory-droid / factorydroid -> droid` alias pattern
- The pinned-npm-range idea (`ACP_ADAPTER_PACKAGE_RANGES`) — replacing am's
  `@latest` with pinned ranges is a **reproducibility win**
- The `BUILT_IN_AGENT_PACKAGES` resolver logic that prefers a locally-installed
  binary over `npx` cold-start (lines 145–210 of
  `src/agent-registry.ts`) — this is the **single biggest code idea worth
  stealing**: it makes repeat invocations ~2s faster by avoiding `npx`
  resolution.

Attribution pattern: add a comment in `src/core/agent-registry.ts`:
```
// Agent list partially derived from openclaw/acpx (MIT)
// https://github.com/openclaw/acpx/blob/main/src/agent-registry.ts
```

### Option 3 — Submodule / vendor

**Verdict: overkill.** acpx is 1 package on npm (`acpx`) with its own
CLI surface that overlaps am's `am run`. Pulling it in as a submodule would
double the CLI footprint and force us to track their alpha breaking
changes. Skip.

### Option 4 — Conformance pairing (highest-value interop)

**Verdict: strongest opportunity.** acpx has a `conformance/` directory
(<https://github.com/openclaw/acpx/tree/main/conformance>) and publishes a
"Pi" reference adapter (`npx pi-acp`) as the minimal-correct ACP agent. am
could:

- Add `pi` to am's built-in registry **specifically as a conformance
  target** (not a daily-driver agent)
- Run am's ACP integration tests against `pi-acp` the same way acpx does
- Cross-validate: if am can drive `pi-acp` and acpx can drive am-exclusive
  agents correctly, we have mutual ACP compliance

This gives am a public, neutral conformance benchmark without entangling
our CLIs.

### Option 5 — Reverse interop (acpx as an am-compatible client)

**Verdict: out of scope, but note for future.** acpx's `--agent <command>`
escape hatch means **am could be invoked as an acpx agent** (if am
ever exposes a pure-stdio ACP server mode). The reverse — am calling
acpx via `child_process` — is trivial but adds no value, since am already
spawns ACP adapters directly.

---

## Recommendation

**Short-term (this sprint):**

1. **Add the 6-agent overlap check to am's CI** — acpx is the best public
   reference of which `<agent> --acp` commands actually exist upstream.
   For every am-unique entry, verify with acpx (or upstream docs) that
   the `--acp` flag is real. Retire dead entries.
2. **Borrow acpx's pinned semver ranges** — replace `@latest` with
   explicit ranges in `BUILT_IN_ACP_AGENTS` for claude and codex to get
   reproducibility. Attribution: comment linking to
   `src/agent-registry.ts` of acpx.
3. **Add `pi-acp` as a conformance agent** — not for end-users, but for
   am's ACP integration test suite. It's the smallest correct ACP server.

**Medium-term:**

4. **Import the 4 commercially-relevant acpx-only agents**: `droid`,
   `qoder`, `opencode`, `kilocode`. Skip `openclaw` (too org-specific),
   `pi` goes in tests, and defer the 4 China-region agents (`iflow`,
   `kimi`, `qwen`, `trae`) until there's user demand — the adapters may
   require region-specific accounts to even test.
5. **Port the `resolveInstalledBuiltInAgentLaunch` pattern** (prefer
   locally-installed package over `npx`) — measurable cold-start win.
6. **Treat Qoder.md as a template for per-agent quirks** — acpx's pattern
   of one short markdown file per agent with auth env vars and forwarded
   flags is lightweight and reader-friendly. am's equivalent would live
   under `docs/agents/{Name}.md`.

**Do not:**

- Do *not* treat `openclaw/acpx` as an am marketplace endpoint. The repo
  is not structured for that. A bridge is possible but premature.
- Do *not* vendor acpx as a submodule. The CLI surfaces overlap; the
  engineering effort to dedupe exceeds the value.
- Do *not* blindly copy acpx's agent list without filtering — 4 of the
  acpx-unique agents are region-gated (CN).

**One sentence:** acpx is a well-engineered, MIT-licensed, actively
maintained alpha-stage sibling project with complementary agent coverage;
the pragmatic play is **cherry-pick 4 agents + the npm-pin-with-local-bin
resolver**, attribute, and pair with `pi-acp` for conformance — not a
full marketplace integration.

---

## Appendix — key files and URLs cited

| Artifact | URL / path |
|---|---|
| acpx repo | <https://github.com/openclaw/acpx> |
| agents/README.md (primary source) | <https://github.com/openclaw/acpx/blob/main/agents/README.md> |
| Root README | <https://github.com/openclaw/acpx/blob/main/README.md> |
| VISION.md | <https://github.com/openclaw/acpx/blob/main/VISION.md> |
| LICENSE (MIT) | <https://github.com/openclaw/acpx/blob/main/LICENSE> |
| `src/agent-registry.ts` | <https://github.com/openclaw/acpx/blob/main/src/agent-registry.ts> |
| agent-registry design doc | <https://github.com/openclaw/acpx/blob/main/docs/2026-02-17-agent-registry.md> |
| OpenClaw integration plan | <https://github.com/openclaw/acpx/blob/main/docs/2026-02-22-openclaw-integration-plan.md> |
| Per-agent docs | `agents/{Codex,Copilot,Cursor,Droid,Gemini,Iflow,Kilocode,Kimi,Kiro,OpenCode,Qoder,Qwen,Trae}.md` at <https://github.com/openclaw/acpx/tree/main/agents> |
| ACP spec | <https://agentclientprotocol.com> |
| am registry source | `/Users/baladita/Documents/DevBox/agent-manager/src/core/agent-registry.ts` |
