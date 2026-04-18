# R-A: ACP Shell Wrapper — Feasibility Study

**Date:** 2026-04-18
**Scope:** Can we build an `acp-shell` wrapper that lets a non-ACP-native CLI agent (aider, forge, kilo-code, etc.) appear to speak the Agent Client Protocol to any ACP client, including `am run`?
**Verdict:** **Yes, feasible** for the CLI subset. Single-chunk non-streaming wrapper is spec-legal and enough to make `am run <agent> "prompt"` work end-to-end. TUI/PTY wrapping is fragile and recommended only as a last resort.

Related review (do not duplicate): R-B covers openclaw/acpx specifically.

---

## 1. ACP minimum surface

Extracted from the authoritative spec pages:

- <https://agentclientprotocol.com/protocol/overview.md>
- <https://agentclientprotocol.com/protocol/initialization.md>
- <https://agentclientprotocol.com/protocol/session-setup.md>
- <https://agentclientprotocol.com/protocol/prompt-turn.md>
- Schema: <https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/schema.json>
  (repo redirects from `zed-industries/agent-client-protocol`)

### 1.1 Methods the wrapper MUST implement (client → agent)

| Method | MUST / SHOULD / MAY | Wrappable with a dumb CLI? | Notes |
|---|---|---|---|
| `initialize` | **MUST** | Yes (static response) | Return `protocolVersion: 1`, advertise `agentCapabilities.loadSession: false`, empty `authMethods: []`, empty `promptCapabilities`. Advertise what you can *honestly* deliver — nothing more. |
| `session/new` | **MUST** | Yes (generate UUID) | Params: `cwd` (absolute), `mcpServers` (array). Returns `{ sessionId }`. State can be an in-memory `Map<sessionId, { cwd, history[] }>`. |
| `session/prompt` | **MUST** | Yes (spawn CLI, capture stdout) | Params: `{ sessionId, prompt: ContentBlock[] }`. Returns `{ stopReason }`. Between request and response the wrapper MAY (not MUST) emit `session/update` notifications. |
| `session/cancel` | MAY (notification, no response) | Partial | Kill the spawned subprocess. If the CLI is already blocked on the LLM call, kill is best-effort. |
| `session/load` | MAY (capability-gated) | Skip | Advertise `loadSession: false` and the client MUST NOT call it. No need to implement. |
| `session/set_mode` | MAY | Skip | Not in baseline. |
| `authenticate` | SHOULD if needed | Skip | Advertise `authMethods: []`. |

### 1.2 Client-side methods the wrapper MAY need to call (agent → client)

| Method | MUST / SHOULD / MAY | Wrapper behaviour |
|---|---|---|
| `session/update` (notification) | **MUST** (baseline notification) | Emit **one** `agent_message_chunk` at end of turn with the CLI's collected stdout. Spec-legal per `prompt-turn.md`: ordering is required, granularity is not. |
| `session/request_permission` | MUST if the wrapper performs tool calls | **Skip**. Wrapper never emits `tool_call` updates, so it never needs permission. |
| `fs/read_text_file` | MAY | Skip. Only if `clientCapabilities.fs.readTextFile` is true AND the wrapper decides to use it. Wrapper does neither. |
| `fs/write_text_file` | MAY | Skip. Same reasoning. |
| `terminal/*` | MAY | Skip. |

### 1.3 Minimum viable handshake

```
Client → initialize { protocolVersion: 1, clientCapabilities: {...} }
Agent  ← { protocolVersion: 1, agentCapabilities: { loadSession: false,
           promptCapabilities: {}, mcpCapabilities: {} },
           authMethods: [], agentInfo: { name: "acp-shell", version: "..." } }
Client → session/new { cwd, mcpServers: [] }
Agent  ← { sessionId: "shell-<uuid>" }
Client → session/prompt { sessionId, prompt: [{ type:"text", text:"..." }] }
  (0..N) Agent → session/update { sessionId, update: { sessionUpdate: "agent_message_chunk",
                                                        content: { type:"text", text: "..." } } }
Agent  ← { stopReason: "end_turn" }     ← required stop reasons per prompt-turn.md:
                                          end_turn | max_tokens | max_turn_requests |
                                          refusal | cancelled
```

**Critical finding:** Spec says agents "MAY send session/update notifications" during execution. The only hard ordering rule is that *all updates must be sent before the prompt response*. So a wrapper can legally emit **zero intermediate updates** and then **one final `agent_message_chunk` + response** without violating ACP. agent-manager's own `am run` client explicitly handles this path at `src/protocols/acp/client.ts:404`.

---

## 2. Wrapper archetype matrix

Three archetypes × candidate agents × viability. Viability scored 1–5 (5 = trivial, 1 = not worth it).

| Target agent | Has `--message`-style one-shot? | HTTP API? | Interactive-only? | Best archetype | Viability |
|---|---|---|---|---|---|
| **aider** | Yes: `--message`/`-m` "processes reply then exits" (`aider.chat/docs/scripting.html`). `--yes --no-auto-commits --no-pretty --no-stream` for clean stdout. | No | No (scriptable) | **(a) Headless-CLI** | **5 / 5** |
| **forge** (forgecode) | Partial: `forge run` subcommand reported; not fully documented publicly. | No documented | Mostly interactive | (a) Headless-CLI if `forge run` exists, else (c) PTY | 3 / 5 |
| **kilo-code** | No (VSCode extension; no standalone binary) | No | Yes (extension UI only) | None of the three — needs VSCode-extension reverse proxy | 1 / 5 |
| **sourcegraph cody** | Yes: `cody chat -m "..."` | Yes (Sourcegraph API) | No | (a) or (b) | 4 / 5 |
| **continue** | No (IDE plugin) | Limited | Yes | None | 1 / 5 |
| **roo-code** | No (VSCode extension) | No | Yes | None | 1 / 5 |
| **cline** | No (VSCode extension) | No | Yes | None | 1 / 5 |
| **amazon-q CLI** | Yes: `q chat --trust-all-tools --no-interactive` | No | No | (a) | 4 / 5 |
| **windsurf** | No (IDE) | No | Yes | None | 1 / 5 |
| **copilot CLI** | Yes: `gh copilot suggest` (single-shot) | GitHub API | No | (a) or (b) | 4 / 5 |
| **cursor CLI** | Yes: `cursor-agent -p "..."` | No | No | (a) | 4 / 5 — already native ACP in am |

### 2.1 Archetype verdicts

- **(a) Headless-CLI wrapper — RECOMMENDED.** Covers aider, q-CLI, cody CLI, cursor-agent, copilot. Simple, stateless, robust across version bumps because it only depends on stable user-facing flags (`--message`, `chat`, `-p`, `--yes`). Every new turn = fresh spawn; session history is serialized back into the next prompt as context. Works today with `am run`.
- **(b) REST/API wrapper — VIABLE for a few.** Cody/Copilot have public APIs. Higher fidelity (streaming SSE maps 1:1 to `agent_message_chunk`), but auth adds per-tool complexity (PATs, OAuth). Good archetype for a *future* v2.
- **(c) TUI-emulation (PTY) wrapper — NOT RECOMMENDED.** The `aws-samples/sample-acp-bridge` uses PTY for Codex and explicitly notes that "context retention and structured event streaming are degraded." PTY scraping breaks whenever the TUI repaints, updates ANSI codes, or adds a new banner. For IDE-extension agents (kilo-code, cline, roo-code, continue) PTY still won't help because there's no standalone binary to drive.

**Archetype (a) handles the most agents with the least fragility.** Recommend shipping that first; treat (b) as an upgrade path for high-value agents where fidelity matters.

---

## 3. What wrappers lose

A headless-CLI wrapper consciously sacrifices:

1. **Mid-stream streaming UX.** The CLI prints its final answer and exits. Wrapper emits one big `agent_message_chunk` at the end. For `am run` (which just concatenates chunks and prints) this is invisible. For a Zed-like TUI showing tokens as they arrive, the user sees a long pause then a wall of text. Spec-legal but degrades perceived latency.

2. **Tool-call fidelity.** Native ACP agents emit `tool_call` + `tool_call_update` so the client can render "Editing file X…" and even gate dangerous operations through `session/request_permission`. The wrapper sees only the CLI's stdout, which may or may not mention the file edits it did. Downstream:
   - No `tool_call` updates → no structured "what did the agent touch?" view.
   - No `session/request_permission` → auto-approve config is a no-op. The wrapped CLI makes its own decisions (`aider --yes`, `q --trust-all-tools`), which bypasses `am`'s permission model entirely. **Security note:** this means `am run aider` is only as safe as `aider --yes` — document prominently.

3. **Session continuity across prompts.** Each ACP `session/prompt` becomes a fresh CLI invocation. To simulate continuity, the wrapper must either:
   - Feed full conversation history back on each invocation (token cost scales linearly), or
   - Use the CLI's own session feature if present (aider has `--restore-chat-history`, cursor-agent has `--resume`). This pushes state management into the wrapped tool but requires per-tool glue.
   - Contrast with `aws-samples/sample-acp-bridge`, which keeps a long-lived subprocess per session — feasible only if the tool has a REPL (aider does, via stdin left open; forge does; most CLIs don't).

4. **Plan updates, thought chunks, mode switches.** No `plan`, no `session/set_mode`, no reasoning stream. Pure final-text answer.

5. **Cancellation precision.** `session/cancel` → kill(subprocess) — but the LLM call in-flight may have already been billed. Best-effort only.

---

## 4. Prior art

Active, relevant projects (not counting R-B's openclaw/acpx):

| Repo | Approach | Stars | Notes |
|---|---|---|---|
| [cola-io/codex-acp](https://github.com/cola-io/codex-acp) | Library-level integration — compiles Codex's Rust workspace directly, doesn't spawn a CLI | 135 | Highest-fidelity approach: full streaming, tool calls via an in-process `acp_fs` MCP server. Not applicable to closed-source CLIs. |
| [aws-samples/sample-acp-bridge](https://github.com/aws-samples/sample-acp-bridge) | HTTP → stdio bridge. Persistent subprocess pool keyed by `(agent, sessionId)`. PTY mode for Codex. | 20 | Aider marked "⚪ No ACP support yet" in its matrix. Explicitly mentions PTY as the fallback for non-ACP CLIs, with caveats. |
| [xiwan/acp-bridge](https://github.com/xiwan/acp-bridge) | Any-CLI + any-model shim | 47 | Generic. Design doc in Chinese; README claims broad CLI support. Worth a closer look for design patterns. |
| [allvegetable/acp-bridge](https://github.com/allvegetable/acp-bridge) | Multi-agent orchestrator (Codex, Claude, Gemini, OpenCode via ACP) | 21 | Assumes wrapped agents already speak ACP. Not a shim for non-ACP tools. |
| [AstraBert/workflows-acp](https://github.com/AstraBert/workflows-acp) | LlamaIndex AgentWorkflows → ACP | 47 | Wraps a Python framework, not a CLI. Pattern reference only. |
| [Open-ACP/OpenACP](https://github.com/Open-ACP/OpenACP) | ACP ↔ messaging platforms (Slack etc.) | 83 | Opposite direction (surface ACP agents in chat apps). Not relevant. |
| [GongRzhe/ACP-MCP-Server](https://github.com/GongRzhe/ACP-MCP-Server) | ACP ↔ MCP bridge | 21 | Cross-protocol, not a CLI shim. |

**NPM:** No hits for `@agentclientprotocol/shim-*`. The official SDK (`@agentclientprotocol/sdk`, already a dep in agent-manager) gives us the schema types and a JSON-RPC harness; it does not provide a CLI shim.

**Gap in the ecosystem:** every bridge above either (a) wraps tools that *already* speak ACP or (b) targets Codex specifically via PTY. A clean, generic "give me a CLI + args and I'll give you an ACP stdio endpoint" tool does not exist as a published binary.

---

## 5. Recommended architecture

### 5.1 Scope

A new sub-binary, `am-acp-shell`, shipped inside agent-manager. It is invoked by an `am` adapter (or any external ACP client) and exposes ACP stdio upstream while spawning a wrapped CLI downstream.

### 5.2 Invocation

```
am-acp-shell \
  --cmd "aider" \
  --arg "--message-file={{PROMPT_FILE}}" \
  --arg "--yes" \
  --arg "--no-auto-commits" \
  --arg "--no-pretty" \
  --arg "--no-stream" \
  --history-mode=concat     # or: none | tool-native
  --stop-on-exit-code=0
```

Registered in agent-manager's registry as a wrapped agent:

```toml
[agents.aider]
transport = "acp-shell"
command   = "aider"
args      = ["--message-file={{PROMPT_FILE}}", "--yes", "--no-auto-commits", "--no-pretty", "--no-stream"]
history_mode = "concat"
```

`am run aider "..."` would then internally resolve to `am-acp-shell` with the aider flags. No changes required in the existing ACP client at `src/protocols/acp/client.ts` — it keeps talking to a stdio ACP peer and doesn't care that the peer is a shim.

### 5.3 Session state

In-memory map, optionally persisted as JSON:

```
sessions: Map<SessionId, {
  cwd: string
  history: Array<{ role: "user"|"assistant", text: string }>
  lastPromptAt: number
}>
```

Persistence file (opt-in): `~/.config/agent-manager/acp-shell/sessions/<sessionId>.json`, evicted after TTL.

### 5.4 Prompt turn flow

1. Receive `session/prompt`, look up session state.
2. Build the final prompt file by concatenating history + current user turn (history_mode=concat) or just the current turn (history_mode=none) or hand off to the CLI's own resume flag (history_mode=tool-native).
3. Spawn `{cmd} {args…}` with `cwd` from the session, passing `{{PROMPT_FILE}}` as a temp file.
4. Collect stdout/stderr until exit.
5. Emit **one** `session/update` notification with `sessionUpdate: "agent_message_chunk"` and `content: { type: "text", text: <stdout> }`.
6. Respond to `session/prompt` with `{ stopReason: exitCode===0 ? "end_turn" : "refusal" }`.
7. Append `{ role: "assistant", text: <stdout> }` to history.

### 5.5 Cancellation

Register the spawned pid against `sessionId`. On `session/cancel`, `kill(-pid, SIGTERM)` then `SIGKILL` after 2s. Respond to the in-flight `session/prompt` with `stopReason: "cancelled"`.

### 5.6 Capabilities advertisement

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": false,
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false },
    "mcpCapabilities": { "http": false, "sse": false }
  },
  "authMethods": [],
  "agentInfo": { "name": "am-acp-shell", "title": "ACP Shell (wraps <cmd>)", "version": "0.1.0" }
}
```

Only baseline `ContentBlock::Text` is accepted in prompts. If the client sends an image/resource block, respond with a clear error inside `session/update` and stop with `refusal`.

### 5.7 What it unlocks

Immediately: **aider, amazon-q CLI (when not already supported), cody CLI, gh copilot, any future one-shot CLI**. Roughly 5–8 agents.

Not unlocked: kilo-code, cline, roo-code, continue, windsurf (all IDE-extension-only; no standalone binary to drive).

### 5.8 Trade-offs (explicit)

| Dimension | Native ACP | ACP shell wrapper |
|---|---|---|
| Streaming UX | Token-by-token | Final block only |
| Tool-call rendering | Structured `tool_call` updates | None (opaque stdout) |
| Permission gating | `session/request_permission` → user auto-approve | Bypassed (CLI decides) |
| Session continuity | Native | Concat history each turn (token cost) |
| Cancellation | Precise | `kill(pid)`, best-effort |
| Spec conformance | Full | Minimal-but-valid |
| Fragility | Low (tied to protocol) | Medium (tied to CLI's `--message` surface staying stable) |

---

## 6. Recommended to pursue — with caveats

**Ship `am-acp-shell` as archetype (a) only, scoped to CLIs with documented one-shot flags.**

Concretely:
1. v0.1: aider (`--message-file`, `--yes`, `--no-auto-commits`, `--no-pretty`, `--no-stream`). Validate end-to-end with `am run aider "fix X"`.
2. v0.2: Add cody CLI + gh copilot + amazon-q CLI. Pattern is identical — just a flag template per tool in the registry.
3. v0.3: Opt-in persistent-session mode for tools with a documented resume flag (`aider --restore-chat-history`, `cursor-agent --resume`). This recovers cheap session continuity.
4. v0.4 (optional): Archetype (b) REST wrapper for Cody/Copilot where fidelity matters.

**Do NOT pursue:**
- PTY-based TUI scraping for interactive-only TUIs. Fragile, version-sensitive, and IDE-extension agents (kilo-code, cline, roo-code, continue, windsurf) have no standalone binary anyway. R-B's openclaw analysis should confirm.
- Advertising capabilities the wrapper can't deliver (images, tool calls, loadSession). Keep the handshake honest.
- Trying to synthesize `tool_call` updates by parsing CLI stdout — the stdout format changes frequently and the value is low (final answer already contains the info).

**Security note to document:** `am run aider` effectively runs `aider --yes` (or equivalent). The `am` permission model does not apply. Put this in the shell wrapper's `am run --help` output and in the adapter README.

---

## 7. Spec references

- ACP overview and method list: <https://agentclientprotocol.com/protocol/overview.md>
- Initialize: <https://agentclientprotocol.com/protocol/initialization.md>
- Session setup (new/load): <https://agentclientprotocol.com/protocol/session-setup.md>
- Prompt turn (update events + stop reasons): <https://agentclientprotocol.com/protocol/prompt-turn.md>
- Request cancellation RFD: <https://agentclientprotocol.com/rfds/request-cancellation.md>
- JSON schema: <https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/schema.json>
- SDK (already a dep in agent-manager): `@agentclientprotocol/sdk`
- aider scripting flags: <https://aider.chat/docs/scripting.html>
- sample-acp-bridge (prior art, PTY fallback discussion): <https://github.com/aws-samples/sample-acp-bridge>
- codex-acp (prior art, library-level integration): <https://github.com/cola-io/codex-acp>
