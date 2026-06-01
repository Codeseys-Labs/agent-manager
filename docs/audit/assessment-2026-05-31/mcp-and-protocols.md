# Audit — Dimension: MCP & Protocols (Pillars 2 & 3)

**Date:** 2026-05-31
**Scope:** Pillar 2 (MCP gateway, `am mcp-serve`) and Pillar 3 (protocol router — ACP local, A2A remote, A2A↔ACP bridge, tier-2 shim wrapper).
**Bar:** Is this architected to become a production-ready, downloadable CLI with a first-run setup wizard? Not abstract perfection — "a stranger can install it, run it, and get value without reading the source."

---

## Executive summary

The MCP server (Pillar 2) is the most production-grade subsystem in the project: 38 tools across 6 groups, three permission tiers, bearer-token auth with constant-time compare, runtime Zod validation per tool, MCP lifecycle/init gating, protocol-version negotiation, JSON-RPC batch ID dedup, secret redaction on errors and on streamed progress, and path-traversal guards on session IDs. It is backed by 605 passing tests across 23 MCP/protocol files. This is real, hardened engineering, not scaffolding.

The protocol router (Pillar 3) is genuinely wired end-to-end — `am run` → ACP subprocess, `am serve --bridge` → A2A server → bridge → ACP, `am agent discover/add` → A2A roster — and the security posture (secure-by-default `deny`, env scrubbing via `sandboxEnv`, FS path restriction, A2A-facing bridge defaults) reflects multiple adversarial review passes. The bridge test even spawns a real Claude ACP subprocess. This is not aspirational.

The dominant risk is **surface area vs. maintenance capacity for a small project**, compounded by **doc/ADR drift** and a few **half-wired or fragile edges**: the Flows engine loads user TypeScript via runtime `import()` (a real problem for a compiled single-binary), tier-2 shims ship `command: ""` and only 3 of ~7 promised candidates exist, tier-1 is only 4 agents (2 of which depend on `npx @latest` cold-start), and there is **zero first-run wizard coverage** — `am init` configures nothing about MCP serving, agents, A2A, or the auth token. A new user cannot discover or wire any of this without reading the README.

**Verdict for this dimension: refactor-in-place.** The MCP core is keep-as-is quality. The protocol router is over-broad for the team size and needs scope discipline (cut/quarantine Flows and the half-built shim/tier-1 expansion) plus a wizard, not a rewrite.

---

## What was read (grounding)

- `src/mcp/server.ts` (3245 lines — the whole file)
- `src/protocols/acp/client.ts`, `src/protocols/acp/registry.ts`, `src/protocols/acp/env-sandbox.ts`, `src/protocols/acp/shell-wrapper.ts`
- `src/protocols/a2a/server.ts`, `src/protocols/bridge.ts`
- `src/core/agent-registry.ts`
- `src/commands/mcp-serve.ts`, `src/commands/run.ts`, `src/commands/serve.ts`, `src/commands/flow.ts`
- `src/web/server.ts` (A2A mount section)
- ADRs 0009, 0021, 0026, 0033; README.md sections on MCP/ACP/A2A/tiers
- Test inventory + full run of `test/mcp/` and `test/protocols/` (605 pass / 0 fail)

---

## Strengths (with evidence)

### S1 — MCP server is hardened, spec-aware, and tested
`src/mcp/server.ts` is not a toy JSON-RPC loop. Concretely:
- **Lifecycle gating** — `initialize` must precede other methods; only `initialize`/`ping` allowed pre-init, returning `-32002` otherwise (`server.ts:71`, `:2906`).
- **Protocol-version negotiation** — echoes a supported version or returns `-32602` with the supported list (`server.ts:61`, `:2922-2954`).
- **Batch ID dedup** — duplicate JSON-RPC IDs in a batch rejected with `-32600` without dispatch (`server.ts:2814-2839`).
- **Per-tool runtime Zod validation** — every tool has a schema in `TOOL_SCHEMAS`; the dispatcher validates before handler (`server.ts:642-782`, `:3056-3069`).
- **Three permission tiers + opt-in for write-remote** (`server.ts:425-446`).
- **Bearer auth** with length-hiding constant-time compare (SHA-256 → `timingSafeEqual`) and write-tier tools hidden from `tools/list` when unauthenticated (`server.ts:316-320`, `:2992-2994`, `:3043-3053`).
- **Secret redaction** on error envelopes (`server.ts:3131-3151`) and a depth/cycle-guarded walker on streamed progress so an ACP agent echoing `sk-ant-...` can't exfiltrate via `notifications/progress` (`server.ts:207-246`, `:3090-3091`).
- **Path-traversal guard** on session IDs with regex + resolve-and-verify (`server.ts:469-498`).
- Test evidence: `test/mcp/` has auth-gate, protocol-conformance, zod-validation, progress-redaction, error-redaction, session-cancel-traversal, x-am-metadata, timing-safe-compare, concurrency suites — all green.

### S2 — ACP client lifecycle and security are carefully done
`src/protocols/acp/client.ts`: subprocess spawned with `sandboxEnv()` (not raw `process.env`), preventing `AM_MCP_TOKEN`/`AM_ENCRYPTION_KEY`/AWS/Anthropic creds leaking into the agent (`client.ts:146-151`, `env-sandbox.ts:40-71`); init wrapped in a timeout race that force-kills orphan subprocesses (`client.ts:216-245`); SIGTERM→SIGKILL grace-period kill (`client.ts:252-277`); permission policy **secure-by-default `deny`** with a defense-in-depth `cancelled` outcome when an agent omits a reject option (`client.ts:87`, `:480-505`); FS read/write restricted to allowed paths (`client.ts:515-541`); per-instance terminal store and drained-output cache (`client.ts:91-94`).

### S3 — Bridge is A2A-facing secure-by-default and actually wired
`src/protocols/bridge.ts` defaults `permissionPolicy: "deny"` and `allowedPaths: [cwd]` (`bridge.ts:130-134`), and **applies them before `connect()`** (a fixed HIGH-2 regression where the policy field was declared but never passed). Agent names are validated against a strict allowlist before any spawn (`bridge.ts:32-37`, `:55`, `:65`). It is wired into `am serve --bridge` → `createApp({enableBridge})` → `createA2ARoutes({enableBridge:true})` (`serve.ts:43`, `web/server.ts:615-639`). `serve.ts` passes only `registryConfig`, so the bridge inherits the safe `deny`/`[cwd]` defaults — correct.

### S4 — Unified agent registry tells the truth (ADR-0033)
`src/core/agent-registry.ts` replaced the old 16-entry "ACP list that lies" with tiered `BUILT_IN_AGENTS` (`agent-registry.ts:89-185`). Tier-3 catalog-only and unopted tier-2 entries carry `command: ""` and synthesize `runnable: false`; `am run`/`am flow`/`am_agent_invoke` all funnel through shared `isShimNotEnabled`/`isCatalogOnly` + `shimNotEnabledMessage`/`tierRefusalMessage` (`agent-registry.ts:509-539`; `run.ts:497-506`; `flow.ts:96-101`; `server.ts:2426-2433`). Single source of refusal truth — good consolidation.

### S5 — A2A server is more conformant than the spec floor
`src/protocols/a2a/server.ts` has TTL + capacity task eviction (`:125-158`), history caps (`:192-194`), SSE idle timeout + heartbeat frames to survive proxies (`:46-52`, `:854-883`), dual Agent-Card URLs for v0.2/v0.3 peers (`:776-783`), server-minted task IDs and idempotent cancel behind a `strictV03` toggle (`:461-510`, `:641-646`), and constant-time bearer compare (`:669-678`). `test/protocols/a2a/conformance.test.ts` exercises strict mode.

### S6 — Dry-run / preflight UX on `am run`
`am run --dry-run` emits a resolved spawn plan (command, args, env keys, redacted secrets, permission policy, allowed paths) without spawning (`run.ts:319-406`), and native/shim preflight translates an opaque ENOENT into an actionable "install X / reinstall am" message (`run.ts:227-301`). This is exactly the kind of first-contact friendliness the production bar wants.

---

## Weaknesses (with evidence, severity, recommendation)

### W1 — [HIGH] No first-run wizard touches any of this surface
`am init` / `am init-project` configure **nothing** about MCP serving, the auth token, agents, A2A, or tiers (grep of `init.ts`/`init-project.ts` for `mcp_serve`/`enable-shim`/`am_agent`/`AM_MCP_TOKEN` → none). A new user installs `am`, runs `am init`, and has no guided path to: (a) register `am mcp-serve` into their IDE's MCP config, (b) set `AM_MCP_TOKEN` (the secure mode), (c) discover which agents are runnable, or (d) enable a tier-2 shim. Everything is README-only. Against the "get value without reading the source" bar, this is the single biggest gap for the dimension.
**Recommendation:** Add a wizard step that detects MCP-capable IDEs and offers to write the `am mcp-serve` server entry (with a generated `AM_MCP_TOKEN`) into each, then runs `am agent detect` and prints the runnable agent list. The detection plumbing (`am_agent_detect`, `getDetectedAdapters`) already exists; only the wizard orchestration is missing.

### W2 — [HIGH] Flows engine loads user TypeScript via runtime `import()` — broken for a compiled binary
`src/commands/flow.ts:50` does `await import(flowName)` on a user-supplied positional, expecting a `.ts`/`.js` module exporting `defineFlow()`. In a `bun build --compile` single binary, arbitrary runtime import of external source files is not reliable (the bundler resolves imports at build time; runtime `import()` of an arbitrary path on the user's disk is fragile and platform-dependent), and it is also an arbitrary-code-execution surface. ADR-0026 Phase 3 promised both `am flow run` **and** an `am_flow_run` MCP tool; the MCP tool does not exist (`grep am_flow src/mcp/server.ts` → 0) and there is no `flows` tool group. The 18KB engine (`src/protocols/acp/flows.ts`) is reachable only via this fragile path.
**Recommendation:** Either (a) move flow definitions to a declarative format (TOML/JSON) that the binary parses — no code import — or (b) explicitly mark Flows experimental/unsupported-in-binary and gate it behind a dev-only flag. Do not ship a "downloadable binary" feature whose primary entry point is "import a TS file from disk."

### W3 — [MEDIUM] Surface is too big for a small project, with self-acknowledged churn
38 MCP tools incl. 9 ACP/agent tools (5 of them deprecated aliases — `server.ts:118-125`), an A2A server with strict/legacy dual semantics, a bridge, a shim wrapper sub-binary, a flows engine, agent variants (ADR-0036), per-tool `x-am` metadata (ADR-0037), and dry-run envelopes (ADR-0038). ADR-0021 even labels "MCP Gateway Mode" experimental/unbuilt. The code is littered with review-pass scars (`CODEX-11`, `REV-4 HIGH-1`, `HIGH-2 fix`, `CRITICAL-1 fix`) showing how much rework each edge needed. For a team maintaining a "control plane," every protocol the project speaks (MCP server, MCP client-via-ACP, A2A client, A2A server, ACP client, ACP shim server) is a moving upstream spec (`@agentclientprotocol/sdk` pinned `^0.19.0`, ACP pre-1.0; A2A v0.2→v0.3). That is at least 5 wire protocols to track.
**Recommendation:** Declare a tight supported core (MCP server + ACP `am run` for tier-1 + A2A discovery) and explicitly quarantine the rest (bridge, A2A *server*, flows, shims beyond tier-1) as experimental in README and `--help`, so maintenance debt is bounded and users aren't promised more than is durable.

### W4 — [MEDIUM] Tier rosters overstate readiness; tier-1 is thin and npx-dependent
Tier-1 native is only `claude`, `codex`, `gemini`, `kiro` (`agent-registry.ts:91-117`), and 2 of those (claude, codex) default to `npx ...@latest` cold-start (2–5s, and require network + node). Tier-2 shims `aider`/`amazon-q`/`cody` all ship `command: ""` (off until `enable-shim`) and `BUILT_IN_SHIMS` has only those 3 (`shell-wrapper.ts:90-109`) vs. ADR-0033's 6 ranked candidates. ADR-0033 lists `qwen/openhands/auggie/...` as "shipping-after-verification" — none present. README's tier matrix (`README.md:418-447`) presents tiers cleanly, but a first user with, say, Cursor or Copilot installed will find them tier-3 (not runnable). The truth-telling is honest, but the *runnable* surface a stranger actually gets is narrow.
**Recommendation:** Be explicit in the wizard output: "Of agents on your machine, these N are runnable via `am run` today." Don't let the 14-entry catalog imply 14 runnable agents.

### W5 — [MEDIUM] ADR/doc drift around tool counts and group migration
ADR-0009 still says "All 14 tools"; ADR-0021's body says 26, with an addendum reconciling to 38. Comments in `server.ts:407-413` and ADR-0021:152 promise a future "collapse acp+a2a into a unified `agents` group" that hasn't landed, so `am_agent_*` tools live under group `"acp"` (`server.ts:410-414`) — meaning a user setting `tools = ["a2a"]` does **not** get `am_agent_invoke`/`am_agent_list` even though those are the canonical replacements for the deprecated `am_agent_delegate` (which IS in `"a2a"`). This is a confusing grouping for an LLM-facing surface.
**Recommendation:** Land the `agents` group consolidation (or at least dual-home the unified tools) and sweep ADR-0009/0021 counts. Low effort, removes a real foot-gun.

### W6 — [LOW] Deprecated aliases bloat the LLM tool list and the maintenance surface
5 deprecated aliases (`am_agent_delegate`, `am_run_agent`, `am_acp_list_agents`, `am_acp_session_list`, `am_acp_session_cancel`) remain in `tools/list` (`server.ts:118-125`), each with its own schema and handler forwarding to the unified impl. They're scheduled for v0.4 removal but inflate the surface an LLM must reason over today.
**Recommendation:** Hide deprecated aliases from `tools/list` by default (keep them dispatchable) before v0.4, or ship the removal — the project is pre-1.0 and the churn budget is better spent than on alias upkeep.

### W7 — [LOW] `am_agent_status`/session tracking is in-memory and per-process
`activeSessions` is a module-level `Map` (`server.ts:540`); `am_agent_status` returns `state: "unknown"` for anything not currently in-process (`server.ts:2305-2324`), and `am_agent_session_list` only sees on-disk dirs otherwise (`server.ts:2599-2620`). Across separate `am mcp-serve` processes or after a restart, session state is effectively lost. ADR-0026 sold "session persistence + crash recovery"; that is not what's implemented.
**Recommendation:** Either implement persisted session metadata or downscope the ADR-0026 claim. For the production bar this is acceptable as a documented limitation, not a blocker.

---

## Is the A2A/ACP/bridge stack exercised end-to-end, or scaffolding?

**Exercised, not scaffolding.** Evidence:
- `am run <agent> <prompt>` resolves via the unified registry and drives a real ACP subprocess (`run.ts:564-677`).
- `am serve --bridge` mounts the A2A server with the bridge handler (`serve.ts:43`, `web/server.ts:615-639`); `test/protocols/bridge.test.ts` actually spawned a real `claude-agent-acp` subprocess during the run (the `-32603` "native binary … failed to launch" line in the test output is the real upstream binary failing in the sandbox, not a test failure — 605/605 still passed).
- `am agent discover/add/list` populate and read the A2A roster (`agents.toml`) via `discoverFromUrl`/`loadRoster`/`saveRoster` (`agents.ts:225-402`).
- `am_agent_invoke` routes ACP-first then A2A, with streaming via `notifications/progress` (`server.ts:2386-2571`).

The one genuinely under-wired piece is **Flows** (W2) and the **A2A *server*** is only reachable through `am serve --bridge` (no standalone "publish me as an A2A agent" daemon command) — so the "am IS an agent in the network" pillar-3 story is half-present.

---

## Wizard implications

A first-run setup wizard for this dimension MUST:
1. **Offer to register `am mcp-serve` into detected MCP-capable IDEs** (Claude Code, Cursor, Copilot, etc. — adapter detection already exists), writing the server entry with `args: ["mcp-serve"]` and a freshly generated `AM_MCP_TOKEN` in the env, and explain that without the token write-tier tools are disabled (the secure default). None of this exists today.
2. **Run `am agent detect` and show the user exactly which agents are runnable now** (tier-1 installed) vs. catalog-only, instead of letting the 14-entry catalog imply broad runnability (W4).
3. **Decide a default `settings.mcp_serve.tools` group set** (the default is `["core"]`; the wizard should ask whether to expose `acp`/`a2a`/`wiki`).
4. **Surface the tier-2 security caveat** if the user wants `enable-shim`, matching the ADR-0033 wording.
5. **NOT** advertise Flows as a ready feature until W2 is resolved.

What is missing today: literally all of the above. The wizard surface for Pillars 2 & 3 is greenfield — the *building blocks* (detection, auth-config loader, registry) are present and tested, but no orchestration ties them into a guided first run.

---

## Production-readiness scoring

- MCP server core: ~8/10 (ship-quality, hardened, tested).
- ACP `am run` + tier-1: ~7/10 (works; thin roster, npx dependency).
- A2A client + discovery: ~7/10.
- A2A server + bridge: ~6/10 (works, secure-by-default, but only via `serve --bridge`; no standalone publish).
- Flows: ~3/10 (fragile import path, no MCP tool, binary-hostile).
- First-run wizard coverage: ~1/10 (absent).

Weighted for the "downloadable CLI + wizard" bar, the dimension lands at **6/10**: the engine is strong, but the on-ramp and a couple of over-reaching features hold it back.
