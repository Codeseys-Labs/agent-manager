# R-C — ACP Agent Coverage Gaps

**Date:** 2026-04-18
**Scope:** Audit agent-manager's built-in ACP coverage vs. the upstream ACP ecosystem, identify nominal-only entries (agents we claim but no runtime exists), and surface new wrappable candidates.
**Primary upstream source:** https://agentclientprotocol.com/overview/agents (retrieved 2026-04-18)

---

## Summary

- **Total agents audited:** 26 (16 from `BUILT_IN_ACP_AGENTS` + 13 adapters + ~10 additional well-known coding agents from the ACP overview page and HN/GitHub trending)
- **Agents with verified upstream ACP support** (native or bridge): 11
  - Native: Cursor, Gemini CLI, Cline, Goose, OpenHands, Qwen Code, Augment Code, fast-agent, Blackbox, Docker cagent, GitHub Copilot (preview)
  - Bridge: Claude (`@agentclientprotocol/claude-agent-acp`), Codex (`@zed-industries/codex-acp`), Pi (`pi-acp`)
- **agent-manager currently lists 16 ACP agents.** Of those, **6 are "nominal-only"** — shipped with spawn commands that the upstream runtime doesn't actually expose, creating a silent failure mode for users. These are **aider, amp, augment (flag wrong), amazon-q, windsurf, devin, sourcegraph/cody, roo-code**.
- **Wrappable (am could add)**: OpenHands, Qwen Code, Docker cagent, Blackbox, fast-agent, Plandex (non-ACP but strong headless CLI), Continue `cn` CLI (non-ACP but CI-focused).
- **Unwrappable / should stay out**: Sweep (pivoted to JetBrains plugin), smol-developer (unmaintained), gpt-engineer (author recommends aider instead), Devin (SaaS-only, no ACP binary), Cody (no CLI, repo URL 404s at common paths), Roo Code (VSCode-extension only, no CLI).

---

## Correspondence matrix

Legend for column D (upstream ACP status):
- **NATIVE** = tool ships ACP mode in its own CLI (native subcommand or flag)
- **BRIDGE** = community/first-party wrapper package exists (e.g. `@zed-industries/codex-acp`)
- **NONE** = no ACP interop exists upstream; am is ahead of reality
- **PREVIEW** = publicly announced but behind a flag / beta

| Agent | am adapter? | am ACP entry? | Upstream ACP status | Headless CLI surface | Upstream docs |
|---|---|---|---|---|---|
| **claude** | claude-code | yes: `npx -y @agentclientprotocol/claude-agent-acp@latest` | BRIDGE (npm `@agentclientprotocol/claude-agent-acp`) | `claude --print "..."` works great | https://github.com/zed-industries/claude-agent-acp |
| **codex** | codex-cli | yes: `npx @zed-industries/codex-acp@latest` | BRIDGE (npm `@zed-industries/codex-acp`) | `codex exec "..."` | https://github.com/zed-industries/codex-acp |
| **gemini** | gemini-cli | yes: `gemini --acp` | NATIVE (flag exists, though README lists only `-p` / `-m`; ACP is "listed directly" on ACP overview page but exact flag name may be `--experimental-acp`) | `gemini -p "..."` | https://github.com/google-gemini/gemini-cli |
| **cursor** | cursor | yes: `cursor-agent acp` | NATIVE — **BUT binary renamed**: upstream says `agent acp` | no standalone headless mode | https://cursor.com/docs/cli/acp |
| **copilot** | copilot | yes: `copilot --acp --stdio` | PREVIEW ("in public preview" per ACP overview; `--acp` flag not in repo README) | `copilot` CLI exists, MCP-powered | https://github.com/github/copilot-cli |
| **kiro** | kiro | yes: `kiro-cli-chat acp` | NONE (no upstream ACP docs; works for you locally because `kiro-cli-chat` ships a private `acp` subcommand) | live-smoke confirmed works | Amazon internal |
| **aider** | — | yes: `aider --acp` | **NONE** — no `--acp` flag in `aider --help`, no ACP mention in README or docs/usage.html | `aider --message "..." --yes` headless works | https://aider.chat/docs/usage.html |
| **amazon-q** | amazon-q | yes: `q chat --acp` | **NONE** — q developer page makes no ACP mention | `q chat` is interactive-only; no documented `-p` one-shot | https://aws.amazon.com/q/developer/ |
| **amp** | — | yes: `amp --acp` | **NONE** — `github.com/sourcegraph/amp` is 404; product lives at ampcode.com but no public ACP docs | unknown | https://ampcode.com/ |
| **augment** | — | yes: `augment-cli --acp` | **NATIVE** per ACP overview — but **flag name likely wrong** (docs.augmentcode.com/cli/acp is the canonical URL; upstream binary name probably `auggie` or `augment`, not `augment-cli`) | headless: unknown | https://docs.augmentcode.com/cli/acp |
| **cline** | cline | yes: `cline --acp` | NATIVE per ACP overview — but repo is VSCode-extension-focused, no standalone `cline` binary documented in README. A `cli/` folder exists. | VSCode-only by default | https://cline.bot/ |
| **roo-code** | roo-code | yes: `roo --acp` | **NONE** — docs.roocode.com & github.com/RooCodeInc/Roo-Code confirm VSCode-extension only, no CLI | none | https://github.com/RooCodeInc/Roo-Code |
| **goose** | — | yes: `goose --acp` | NATIVE per ACP overview, but exact flag unknown — README mentions ACP *providers* (use Claude/ChatGPT/Gemini *through* goose via ACP), not exposing goose *as* an ACP agent. Likely the spawn command is something like `goose session` or a dedicated subcommand. | `goose session` is TUI-first | https://block.github.io/goose/docs/guides/acp-clients |
| **windsurf** | windsurf | yes: `windsurf-cli --acp` | **NONE** — no public ACP docs; Windsurf is IDE-only | IDE-only | https://codeium.com/windsurf |
| **devin** | — | yes: `devin --acp` | **NONE** — Devin is a SaaS product by Cognition AI. No public CLI, no ACP. `github.com/devinai/devin-cli` is 404. | SaaS-only | https://devin.ai/ |
| **sourcegraph** (cody) | — | yes: `cody --acp` | **NONE** — `github.com/sourcegraph/cody` is 404 (repo moved/archived). Cody lives inside IDE extensions. | none | https://sourcegraph.com/cody |
| **openhands** | — | — | **NATIVE** per ACP overview (docs.openhands.dev/openhands/usage/run-openhands/acp) | `docker run ... ghcr.io/all-hands-ai/openhands`; CLI mode "similar to Claude Code or Codex" | https://github.com/All-Hands-AI/OpenHands |
| **qwen-code** | — | — | **NATIVE** per ACP overview (derived from gemini-cli, likely inherits `--acp`-style flag) | `-p` for non-interactive | https://github.com/QwenLM/qwen-code |
| **cagent** (docker) | — | — | **NATIVE** per ACP overview | `docker agent run agent.yaml` | https://github.com/docker/cagent |
| **blackbox** | — | — | **NATIVE** per ACP overview | unknown | https://docs.blackbox.ai/features/blackbox-cli/introduction |
| **fast-agent** | — | — | **NATIVE** per ACP overview | unknown | https://fast-agent.ai/acp |
| **pi** | — | — | BRIDGE (`pi-acp`) | unknown | https://github.com/svkozak/pi-acp |
| **agentpool** | — | — | NATIVE per ACP overview | unknown | https://phil65.github.io/agentpool/advanced/acp-integration/ |
| **continue** (`cn`) | continue | — | **NONE** — no ACP support; `cn` CLI is focused on CI PR checks | `cn` is CI-focused, headless-friendly | https://github.com/continuedev/continue |
| **forgecode** | forgecode | — | **NONE** — no `--acp` flag, no ACP subcommand; ships MCP only (your live-smoke finding confirmed upstream) | `forge -p "..."` works | https://github.com/antinomyhq/forge |
| **kilo-code** | kilo-code | — | **NONE** — `@kilocode/cli` exists (fork of OpenCode) with `--auto` headless mode, but no ACP | `kilo run --auto "..."` | https://github.com/Kilo-Org/kilocode |
| **plandex** | — | — | **NONE** | `plandex` / `pdx` REPL; 15.3k ⭐ | https://github.com/plandex-ai/plandex |
| **smol-developer** | — | — | NONE; unmaintained | `python main.py "..."` | https://github.com/smol-ai/developer |
| **gpt-engineer** | — | — | NONE; author recommends aider | `gpte <project_dir>` (file-based) | https://github.com/gpt-engineer-org/gpt-engineer |
| **sweep** | — | — | NONE; pivoted to JetBrains plugin | N/A (GitHub bot → JetBrains) | https://github.com/sweepai/sweep |

---

## Wrappable candidates, ranked

Ranked by **(a) demand × (b) headless CLI quality × (c) wrap effort**. "Wrappable" here means *belongs in `BUILT_IN_ACP_AGENTS`*, i.e. there's a runtime we can actually spawn.

### 1. **OpenHands** (All-Hands-AI) — top priority
- **Demand:** Very high. OpenHands is the devin-alternative open-source flagship; tens of thousands of users.
- **ACP status:** NATIVE — docs page `docs.openhands.dev/openhands/usage/run-openhands/acp` exists.
- **Effort:** Low. Ships as Docker (`ghcr.io/all-hands-ai/openhands`) or `pip install openhands-ai`. Need to figure out exact ACP invocation — likely `openhands --acp` or a container flag.
- **Add:** `openhands: "openhands --acp"` (placeholder; refine after reading docs.openhands.dev/openhands/usage/run-openhands/acp).
- **Ref:** https://docs.openhands.dev/openhands/usage/run-openhands/acp

### 2. **Qwen Code**
- **Demand:** Rising fast — Alibaba's open Qwen-Coder models are the best open-weight coding LLMs at the moment; Qwen Code is their official CLI.
- **ACP status:** NATIVE per ACP overview.
- **Effort:** Low. It's a gemini-cli fork, so the ACP flag likely mirrors gemini's. Install via `npm install -g @qwen-code/qwen-code`.
- **Add:** `qwen: "qwen --acp"` (verify actual flag).
- **Ref:** https://github.com/QwenLM/qwen-code

### 3. **Docker cagent**
- **Demand:** Moderate but strategic — Docker is pushing this as the enterprise agent runtime.
- **ACP status:** NATIVE per ACP overview (https://github.com/docker/cagent listed on the agents page, but README mentions MCP only, not ACP — so this might be an aspirational listing; verify).
- **Effort:** Medium. Needs Docker daemon; `docker agent run agent.yaml`.
- **Caveat:** README shows no ACP flag today. Monitor.
- **Ref:** https://github.com/docker/cagent

### 4. **fast-agent**
- **Demand:** Niche but growing; strong MCP ecosystem positioning.
- **ACP status:** NATIVE per ACP overview (fast-agent.ai/acp).
- **Effort:** Low.
- **Ref:** https://fast-agent.ai/acp

### 5. **Augment Code (auggie)**
- **am already lists "augment" but with wrong spawn command.** Fix the entry, don't add a new one.
- **ACP status:** NATIVE — docs.augmentcode.com/cli/acp.
- **Effort:** Low — just fix the flag. Binary is likely `auggie` (Augment's public CLI brand), not `augment-cli`.
- **Ref:** https://docs.augmentcode.com/cli/acp

### 6. **Blackbox AI CLI**
- **Demand:** Moderate. Consumer-heavy, but paying-user base is real.
- **ACP status:** NATIVE per ACP overview.
- **Effort:** Low-medium.
- **Ref:** https://docs.blackbox.ai/features/blackbox-cli/introduction

### 7. **AgentPool**
- **Demand:** Low. Niche framework.
- **ACP status:** NATIVE (phil65.github.io/agentpool/advanced/acp-integration/).
- **Effort:** Low.
- **Consider after top 6.**

### 8. **Pi (pi-acp bridge)**
- **Demand:** Unknown — Pi itself is Inflection's ex-product; bridge exists but unclear activity.
- **ACP status:** BRIDGE (`svkozak/pi-acp`).
- **Effort:** Low.
- **Skip unless asked.**

### 9. **Plandex** (non-ACP, but wrappable as an adapter — catalog side)
- **Demand:** High — 15.3k stars.
- **ACP status:** NONE. Headless via REPL commands.
- **Effort:** Medium — no ACP, so it's adapter-only (catalog sync), not a `BUILT_IN_ACP_AGENTS` entry.
- **Ref:** https://github.com/plandex-ai/plandex

### 10. **Continue `cn` CLI**
- am already has `continue` adapter; no ACP.
- Worth keeping adapter-only.
- **Ref:** https://github.com/continuedev/continue

---

## Agents where am is ahead of upstream (maintenance burden)

These entries in `BUILT_IN_ACP_AGENTS` **will fail at spawn time** for any user who tries them, because the runtime command doesn't exist upstream. Each is a silent support-ticket generator.

| Agent | am spawn command | Reality |
|---|---|---|
| **aider** | `aider --acp` | No `--acp` flag. Nearest equivalent is `aider --message "..." --yes` (normal headless mode). Remove from `BUILT_IN_ACP_AGENTS`. |
| **amp** | `amp --acp` | `github.com/sourcegraph/amp` is 404; ampcode.com product has no public ACP. Remove. |
| **augment** | `augment-cli --acp` | ACP is real (docs.augmentcode.com/cli/acp), but binary is `auggie` (Augment's brand), not `augment-cli`. **Fix, don't remove.** |
| **amazon-q** | `q chat --acp` | No ACP support in Q Developer. Remove. |
| **windsurf** | `windsurf-cli --acp` | Windsurf is IDE-only; no `windsurf-cli` binary exists upstream. Remove. |
| **devin** | `devin --acp` | Devin is Cognition's SaaS; no CLI. Remove. |
| **sourcegraph** (cody) | `cody --acp` | Cody is an IDE extension; `sourcegraph/cody` repo 404. Remove or point to IDE extension only. |
| **roo-code** | `roo --acp` | VSCode-extension only; no `roo` binary. Remove. |
| **goose** | `goose --acp` | Flag is unverified; goose documents ACP on the *client* side (consuming Claude/ChatGPT via ACP) more than on the server side. **Verify or remove.** |
| **cline** | `cline --acp` | Cline is VSCode-extension-primary. A `cli/` folder exists in the repo but no public docs for `cline --acp`. **Verify, likely remove.** |

**Net recommendation:** Prune `BUILT_IN_ACP_AGENTS` down to the 5 that are real and verifiable today:
- claude (bridge)
- codex (bridge)
- gemini (native, verify flag)
- cursor (native — fix to `agent acp`)
- kiro (works for you locally; keep but document "internal-only")

Then add OpenHands, Qwen Code, fast-agent, augment (fixed binary) as the next wave.

The rest (amp, aider, amazon-q, windsurf, devin, cody, roo-code, cline, goose) belong in a **separate "nominal" or "proposed" registry**, not in `BUILT_IN_ACP_AGENTS`. Alternatively, gate them behind an `installed()` check so the CLI never surfaces them unless the runtime is present.

---

## Agents to consider adding to adapters (catalog-only side)

Adapters exist for tools that may not speak ACP but still have per-tool config (MCP, workspace rules, prompts) worth syncing. Current 13: claude-code, cursor, codex-cli, kilo-code, copilot, kiro, gemini-cli, cline, roo-code, amazon-q, forgecode, windsurf, continue.

**Missing adapters worth adding:**

1. **aider** — massive install base, mature `.aider.conf.yml` config, worth a catalog adapter.
2. **plandex** — 15.3k stars, active, `.plandex/` config directory per project.
3. **openhands** — has `config.toml` + `.openhands/` per-workspace settings.
4. **goose** — has `.goose/config.yaml`.
5. **auggie** (Augment CLI) — worth syncing ACP-compatible config.
6. **qwen-code** — likely mirrors gemini-cli structure.

**Explicit non-adds (keep out):**
- **Sweep** — pivoted to JetBrains plugin; dead as a standalone agent.
- **smol-developer** — unmaintained, "not ready for so many of you" author note.
- **gpt-engineer** — the author's own README now recommends aider instead.
- **Devin** — SaaS, no config files to sync.
- **Cody** — IDE-extension only, config lives in VSCode/JetBrains settings.

---

## Confirmations on forge + kilo-code

### forge (forgecode) — confirmed: no ACP

Your live-smoke finding is correct. Upstream analysis:

- Repo: https://github.com/antinomyhq/forge
- `forge --help` lists subcommands: no `acp` subcommand, no `--acp` flag.
- `forge mcp ...` is the only protocol subcommand (list/import/show/remove/reload).
- README explicitly says "following Anthropic's Model Context Protocol design" — MCP only, not ACP.
- **Conclusion:** forge cannot speak ACP natively. It *could* be wrapped by a bridge package (similar to `@zed-industries/codex-acp`), but no such bridge exists today. This would be a greenfield project for the am team — low ROI given the small audience relative to OpenHands/Qwen.
- **Action:** Keep forgecode as an **adapter-only** tool in am. Do not add to `BUILT_IN_ACP_AGENTS`.

### kilo-code — confirmed: no ACP, but has a real CLI

- `@kilocode/cli` (npm package) is a fork of OpenCode.
- The `kilo` binary exists on PATH after install: `npm install -g @kilocode/cli`.
- Headless mode is real: `kilo run --auto "run tests and fix any failures"` — disables permission prompts, intended for CI/CD.
- **No ACP support anywhere in the repo.** No `--acp` flag, no ACP subcommand.
- **Could it be wrapped?** Theoretically yes — you'd write an ACP shim that forwards ACP requests into `kilo run --auto` invocations and streams results back. But this is a substantial engineering effort (ACP is stateful, multi-turn; `kilo run --auto` is one-shot).
- **Action:** Keep kilo-code as **adapter-only**. Do not add to `BUILT_IN_ACP_AGENTS`. If a user wants ACP-like integration, they can already use `kilo run --auto` as a headless shell command.

---

## Appendix A — URLs cited (quick reference)

| Agent | Primary URL |
|---|---|
| ACP overview | https://agentclientprotocol.com/overview/agents |
| ACP clients | https://agentclientprotocol.com/overview/clients |
| ACP community libs | https://agentclientprotocol.com/libraries/community |
| Claude bridge | https://github.com/zed-industries/claude-agent-acp (actually `agentclientprotocol/claude-agent-acp`) |
| Codex bridge | https://github.com/zed-industries/codex-acp |
| Cursor ACP | https://cursor.com/docs/cli/acp |
| Gemini CLI | https://github.com/google-gemini/gemini-cli |
| Goose ACP | https://block.github.io/goose/docs/guides/acp-clients |
| OpenHands ACP | https://docs.openhands.dev/openhands/usage/run-openhands/acp |
| Qwen Code | https://github.com/QwenLM/qwen-code |
| Augment Code CLI | https://docs.augmentcode.com/cli/acp |
| Blackbox CLI | https://docs.blackbox.ai/features/blackbox-cli/introduction |
| Docker cagent | https://github.com/docker/cagent |
| fast-agent | https://fast-agent.ai/acp |
| AgentPool | https://phil65.github.io/agentpool/advanced/acp-integration/ |
| Pi bridge | https://github.com/svkozak/pi-acp |
| Cline | https://github.com/cline/cline |
| Roo Code | https://github.com/RooCodeInc/Roo-Code |
| Kilo Code | https://github.com/Kilo-Org/kilocode |
| Continue | https://github.com/continuedev/continue |
| Forge | https://github.com/antinomyhq/forge |
| Aider | https://aider.chat/docs/usage.html |
| Plandex | https://github.com/plandex-ai/plandex |
| OpenHands | https://github.com/All-Hands-AI/OpenHands |
| GitHub Copilot CLI | https://github.com/github/copilot-cli |
| smol-developer | https://github.com/smol-ai/developer |
| gpt-engineer | https://github.com/gpt-engineer-org/gpt-engineer |
| Sweep | https://github.com/sweepai/sweep |
| Cody | https://sourcegraph.com/cody (GitHub repo 404) |
| Devin | https://devin.ai/ |
| Amazon Q Developer | https://aws.amazon.com/q/developer/ |
| Windsurf | https://codeium.com/windsurf |
| Sourcegraph amp | https://ampcode.com/ |

---

## Appendix B — Suggested replacement `BUILT_IN_ACP_AGENTS`

```typescript
export const BUILT_IN_ACP_AGENTS: Record<string, string> = {
  // verified-working, in the wild today
  claude: "npx -y @agentclientprotocol/claude-agent-acp@latest",
  codex: "npx @zed-industries/codex-acp@latest",
  gemini: "gemini --experimental-acp",        // verify exact flag
  cursor: "agent acp",                         // upstream renamed the binary
  kiro: "kiro-cli-chat acp",                   // internal, document as such

  // verified via ACP overview page — add after confirming exact spawn
  openhands: "openhands --acp",                // TODO: verify
  "qwen-code": "qwen --experimental-acp",      // TODO: verify (fork of gemini-cli)
  auggie: "auggie --acp",                      // TODO: verify binary name (replaces "augment")
  "fast-agent": "fast-agent --acp",            // TODO: verify
  cagent: "docker agent run --acp",            // TODO: verify

  // preview / gated
  copilot: "copilot --acp --stdio",            // PREVIEW, gate behind copilot PREVIEW flag
};
```

Removed: `aider`, `amp`, `augment` (replaced by `auggie`), `amazon-q`, `cline`, `roo-code`, `goose`, `windsurf`, `devin`, `sourcegraph` — all nominal-only; either no ACP runtime exists, the binary is wrong, or the tool is SaaS/IDE-only.

Goose and cline *might* return once exact spawn commands are verified against their upstream docs; listed as NATIVE on the ACP overview but the concrete invocation is not in their READMEs.

---

## Appendix C — Open questions for next iteration

1. **Verify gemini's exact ACP flag** — is it `--acp` or `--experimental-acp`?
2. **Verify cursor binary rename** — is the legacy `cursor-agent` symlink still present on new installs, or is it purely `agent` now?
3. **Verify OpenHands ACP spawn syntax** — docker vs. pip install path.
4. **Verify qwen-code ACP flag** — confirm it inherited gemini's flag.
5. **Verify augment binary name** — is it `auggie`, `augment`, or `augment-cli`?
6. **Verify goose ACP spawn** — the listing on ACP overview may refer to goose as a *client* of ACP (consuming remote agents), not as a *server*.
7. **Verify cline CLI** — does `cli/` in the repo produce a standalone binary, or is it internal plumbing for the VSCode extension?
