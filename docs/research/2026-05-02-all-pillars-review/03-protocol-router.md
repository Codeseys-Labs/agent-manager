# 03 — Protocol router review

## 1. What’s GOOD today
- The registry tells the truth: built-ins are explicit native/shim/catalog tiers, and unenabled shims/catalog-only agents get distinct refusals instead of fake spawn commands (`src/core/agent-registry.ts:89-185`, `:509-519`).
- Local execution fails safer than before: ACP defaults to deny, bridge defaults to deny plus `cwd`-only file access, env is scrubbed, and argv parsing avoids shell expansion (`src/protocols/acp/client.ts:80-87`, `src/protocols/bridge.ts:128-135`, `src/protocols/acp/env-sandbox.ts:83-103`, `src/protocols/acp/registry.ts:80-88`).
- A2A is not a stub: task store, SSE, heartbeats, dual Agent Card URLs, and bearer auth exist (`src/protocols/a2a/server.ts:42-54`, `:769-795`, `:834-933`).
- The bridge loop is understandable: parse `run <agent>:`, validate names, resolve unified registry, spawn ACP, return A2A parts (`src/protocols/bridge.ts:31-72`, `:152-177`).
- MCP consumers get the same surface via `am_agent_list`/`am_agent_invoke`, including tier/runnable fields and ACP-first routing (`src/mcp/server.ts:1726-1754`, `:2120-2168`, `:2350-2362`).

## 2. What’s ROUGH for a new user
- `am run claude "..."` has no `--dry-run`/explain mode; the first visible step is spawning/connecting (`src/commands/run.ts:167-172`, args at `:417-458`).
- Missing binary/provider failures collapse to `Agent run failed: ...`; run does not preflight `detect` or print the install command (`src/commands/run.ts:237-240`).
- Detection can say “installed” from adapter-host presence while runtime still uses a separate ACP command (`src/core/agent-detection.ts:57-64`, `:258-269`).
- Default `am run` auto-approves; the safer mode is a negative flag, easy to miss on first run (`src/commands/run.ts:140-150`, `:445-448`).
- `--session name` is not a durable alias: if load fails, a server ID is created but no name→server mapping is saved (`src/commands/run.ts:178-193`).
- Prompt input is positional only; no `--prompt-file`/stdin path for large prompts (`src/commands/run.ts:423-431`, `:467-471`).

## 3. What’s ROUGH at scale / production
- A2A tasks are per-process memory; restarts lose task state and in-flight visibility (`src/protocols/a2a/server.ts:56-68`, `:757-758`).
- A2A cancel marks task state but does not propagate a signal into the handler/ACP subprocess (`src/protocols/a2a/server.ts:403-450`, `:622-658`; bridge prompt race at `src/protocols/bridge.ts:176-184`).
- No admission control/concurrency limits around bridge-spawned ACP agents; `startTask` fires async work immediately (`src/protocols/a2a/server.ts:403-450`).
- Flow state persists, but CLI has run/list/status only: no resume checkpoint, retry, or continue command (`src/protocols/acp/flows.ts:451-467`, `src/commands/flow.ts:230-239`).
- A2A client has timeouts and polling, but no retry/backoff or per-roster auth; roster stores only URL/description/time (`src/protocols/a2a/client.ts:155-179`, `src/protocols/a2a/discovery.ts:87-101`).
- MCP session status is mostly in-memory/ephemeral and returns `unknown` after cleanup (`src/mcp/server.ts:2220-2238`, `:2422-2424`).

## 4. Multi-provider / 1P-vs-3P
Today: not first-class. Users can hand-edit `agents.claude.acp.command`, but built-ins are single fixed commands for Claude/Codex (`src/core/agent-registry.ts:91-106`). Gaps: `AgentProfileSchema` and project schema allow only `model`, `acp.command`, `a2a.url` (`src/core/schema.ts:88-107`, `:178-190`); `AcpSettings`, `ConfigAgentEntry`, and `UnifiedAgent` are command/url-only (`src/protocols/acp/types.ts:133-140`, `src/core/agent-registry.ts:212-234`); `run`, MCP invoke, detection, and resolver have no `variant`, args, provider, auth, or env resolution (`src/commands/run.ts:83-93`, `src/mcp/server.ts:2120-2164`); sandbox strips AWS/OpenAI/Anthropic/Google unless explicit env is passed, and run never passes it (`src/protocols/acp/env-sandbox.ts:63-71`, `src/commands/run.ts:170-172`).

Proposed TOML:
```toml
[agents.claude]
default_variant = "anthropic"
[agents.claude.variants.bedrock]
protocol = "acp"
command = "npx -y @agentclientprotocol/claude-agent-acp@latest"
args = ["--model", "sonnet"]
env = { CLAUDE_CODE_USE_BEDROCK = "1", AWS_PROFILE = "work", AWS_REGION = "us-east-1" }
[agents.codex.variants.openai-api]
protocol = "acp"
command = "npx @zed-industries/codex-acp@latest"
env = { OPENAI_API_KEY = "${OPENAI_API_KEY}" }
```
`am run claude --variant bedrock "..."` should resolve agent→variant→command+args+env, interpolate secrets, call `sandboxEnv(env)`, and record the variant in session/MCP output.

## 5. Broader agent coverage
- auggie/auggiecli: tier-1 candidate after live ACP smoke; catalog-only until verified (`ADRs/0033-acp-agent-tiers-and-shim-wrapper.md:72-74`).
- opencode: tier-1 candidate after live smoke; not a first-party shim if native ACP exists.
- qwen/qoder/droid: tier-1 candidates only after verification; otherwise catalog-only.
- pi: community tier-2 at most; likely fails traffic/non-expressible gates.
- hermes: catalog-only/community until evidence; never first-party without ≥3/5.
- plandex: community tier-2 example, not first-party by default (`ADRs/0035-community-shim-registration.md:100-113`).
- openrouter-as-backend: never an agent/shim; make it a provider variant.
- goose: community/catalog until ACP direction is proven; avoid nominal built-ins.

## 6. Top 3 actionable improvements
1. Problem: first run is opaque; fix: add `am run --dry-run`/`am agent explain`; acceptance: JSON shows source, tier, command, args, env keys redacted, cwd, permission policy, and no process spawns.
2. Problem: provider routing is hand-edit-only; fix: add `variants` schema plus `--variant` for CLI/MCP; acceptance: Claude Bedrock and Codex OpenAI-API examples run with redacted env in output.
3. Problem: production cancellation is cosmetic; fix: pass AbortSignal through A2A task handlers to bridge/ACP and kill subprocesses; acceptance: `tasks/cancel` terminates a bridged long-running agent in tests.

## References
ADRs 0017, 0026, 0030, 0033, 0034, 0035; files cited inline.
