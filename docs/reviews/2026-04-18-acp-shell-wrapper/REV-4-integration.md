---
status: active
date: 2026-04-18
---

# REV-4 — Integration Audit (post-landing)

**Date:** 2026-04-18
**Scope:** commits d195721..HEAD (the 5 ADR-0033 landing commits)
**Method:** Diff read + targeted grep + test inspection.
**Reviewer:** Agent (code-reviewer subagent).

---

## Summary

**Health score: 5.5 / 10.**

**CRITICAL: The entire Tier-2 enable-shim opt-in flow is silently broken.** `am agent enable-shim aider --yes` writes the shim command to `[agents.aider].adapters.acp.command`, but `resolveAgent()` reads `[agents.aider].acp.command`. After opting in, `am run aider` still fails with the tier-3 refusal message as if `enable-shim` was never run. The test suite validates the config *write path* but not the *resolution path*, so this passes all existing tests. Every user who follows the documented workflow hits this wall.

The three security gates (env sandbox, progress redaction, acp-shell wrapper) are wired correctly and integrate cleanly. The tier-2 *infrastructure* is sound. What is broken is the single config-path join between `enable-shim` and `resolveAgent`, which makes Phase B functionally dead on arrival despite the correctness of everything around it.

---

## Findings by severity

### CRITICAL

#### CRIT-1 — `enable-shim` writes to wrong config path; `resolveAgent` never sees it

**Severity:** CRITICAL
**Files:** `src/commands/agent-enable-shim.ts:101-108`, `src/core/agent-registry.ts:328-334`

`agent-enable-shim.ts` builds the config entry as follows:

```typescript
adapters.acp = { command: `am-acp-shell ${name}` };
entry.adapters = adapters;
agentsBlock[name] = entry;
```

This writes the ACP command to `config.agents.<name>.adapters.acp.command`. However `resolveAgent()` in `agent-registry.ts` reads config overrides like this:

```typescript
const configAgent = config?.agents?.[name];
if (configAgent && (configAgent.acp || configAgent.a2a)) {
  return { ..., acp: { command: configAgent.acp.command }, ... };
}
```

`configAgent.acp` is the `ConfigAgentEntry.acp` field — a direct property of the agent entry, not nested under `adapters`. There is no code path in `resolveAgent`, `listAllAgents`, or anywhere in the registry that reads `configAgent.adapters?.acp?.command`. After `enable-shim` runs, the entry that `resolveAgent` sees is still the built-in `BUILT_IN_AGENTS["aider"]` spec, which has `command: ""` and `runnable: false`. The tier-3 refusal fires as if the user never opted in.

The code comment in `src/core/agent-registry.ts` lines 120-126 describes the intended flow correctly ("Once enabled, `resolveAgent()` sees the config override and routes `am run <name>` through the shim") but the implementation of `enable-shim` uses an `adapters` intermediate table that nothing reads.

The `agent-enable-shim.test.ts` test validates `aider?.adapters?.acp?.command === "am-acp-shell aider"` (line 85) — it checks that the config was *written* to the path `enable-shim` uses, but never calls `resolveAgent` or `am run` to verify the written config is actually *read*. The test passes even though the resolved route is broken.

**Fix:** Change `enable-shim.ts` to write to `agents.<name>.acp.command` directly (matching `ConfigAgentEntry`), not `agents.<name>.adapters.acp.command`:

```typescript
entry.acp = { command: `am-acp-shell ${name}` };
agentsBlock[name] = entry;
```

And update the test to call `resolveAgent(name, config)` after writing and assert `result.acp.command === "am-acp-shell aider"`.

---

### HIGH

#### HIGH-1 — `tierRefusalMessage` text is factually wrong for tier-2 unregistered agents

**Severity:** HIGH
**Files:** `src/core/agent-registry.ts:484-492, 498-500`

`isCatalogOnly()` returns `true` when `runnable === false || tier === "tier-3-catalog-only"`. Tier-2-shim agents before `enable-shim` have `runnable: false` (from `builtInToUnified` line 278-282), so they trigger `isCatalogOnly`. The refusal they receive is:

> "aider" is a catalog-only (tier-3) integration. am writes its config via `am apply` but cannot spawn it — it has no standalone ACP runtime (VSCode extensions, IDE-only products). Use it from its native UI...

Every clause of this message is factually wrong for aider: aider is not tier-3, it is not a VSCode extension, and there is a clear path to making it runnable (`am agent enable-shim aider`). The hint tells users to "Use it from its native UI" when the correct next step is to run `enable-shim`.

This is compounded by CRIT-1 — even when a user runs `enable-shim`, the resolution path breaks, so they would then also see this wrong message after a successful enable.

**Fix:** Add a separate tier-2 refusal path. `isCatalogOnly` should only return true for explicit tier-3. Add a `isShimNotEnabled(agent)` guard that fires before `isCatalogOnly` and emits a tier-2-specific message:

```typescript
export function shimNotEnabledMessage(agentName: string): string {
  return (
    `"${agentName}" is a Tier-2 wrapped agent that requires opt-in before use. ` +
    `Run: am agent enable-shim ${agentName} --yes\n` +
    `This will configure the acp-shell wrapper. See ADR-0033 Phase B.`
  );
}
export function isShimNotEnabled(agent: Pick<UnifiedAgent, "runnable" | "tier">): boolean {
  return agent.tier === "tier-2-shim" && agent.runnable === false;
}
```

#### HIGH-2 — `am_agent_list` MCP tool omits `tier` and `runnable` from response

**Severity:** HIGH
**File:** `src/mcp/server.ts:1696-1703`

The `am_agent_list` MCP tool handler maps each agent as:

```typescript
agents: agents.map((a) => ({
  name: a.name,
  description: a.description ?? null,
  source: a.source,
  protocol: ...,
  acp: a.acp ?? null,
  a2a: a.a2a ?? null,
}))
```

Neither `tier` nor `runnable` is included. Any MCP client (LLM agent, script) calling `am_agent_list` gets no signal that aider is Tier-2-shim or that cline is catalog-only. The CLI `am agent list --json` correctly includes both fields (lines 109-110 of `src/commands/agents.ts`). The two surfaces disagree.

This is directly relevant to ADR-0033's goal of "users discover truth." An LLM deciding which agent to invoke via `am_agent_invoke` has no way to know that `cline` will be refused with a tier-3 error until it tries and fails.

**Fix:** Add `tier: a.tier ?? null` and `runnable: a.runnable ?? true` to the `am_agent_list` response mapping.

#### HIGH-3 — `agent-enable-shim` uses raw `writeConfig`, bypassing `withConfig` mutex

**Severity:** HIGH
**File:** `src/commands/agent-enable-shim.ts:91-115`

The REV-1 MEDIUM-2 fix in commit `401544a` routed `install`, `uninstall`, and `update` through `withConfig` to serialize config read-modify-writes. The new `agent-enable-shim` command bypasses this: it calls `tryReadConfig` directly (line 93) then `writeConfig` (line 115) without the `configMutex` lock. A concurrent `am_add_server` via MCP or `am install` on the same session can interleave and lose the shim entry. This is precisely the hazard class REV-1 MEDIUM-2 was built to close.

**Fix:** Wrap lines 91-115 in `withConfig(configDir, async (existing) => { ... return { changed: true, updated: next, commitMessage: ... }; })`.

---

### MEDIUM

#### MED-1 — `am agent list` Endpoint column shows `(catalog-only)` for tier-2-shim entries

**Severity:** MEDIUM
**File:** `src/commands/agents.ts:136-139`

The endpoint display logic is:

```typescript
const endpoint = agent.runnable === false
  ? "(catalog-only)"
  : (agent.acp?.command ?? agent.a2a?.url ?? "—");
```

Since tier-2-shim agents have `runnable: false` before `enable-shim`, they show `(catalog-only)` in the Endpoint column. The Tier column correctly shows "shim" (via `renderTier`), but the Endpoint column contradicts it. A user sees "shim | (catalog-only)" which communicates that this agent is shimmed but also catalog-only — confusing, and inconsistent with the intent.

**Fix:** Branch on `tier`:

```typescript
const endpoint =
  agent.tier === "tier-2-shim" && agent.runnable === false
    ? "(shim: run `am agent enable-shim <name>` to activate)"
    : agent.runnable === false
      ? "(catalog-only)"
      : (agent.acp?.command ?? agent.a2a?.url ?? "—");
```

#### MED-2 — `NODE_OPTIONS` on the sandbox allow-list can propagate parent-process injection

**Severity:** MEDIUM
**File:** `src/protocols/acp/env-sandbox.ts:27, 41`

`NODE_OPTIONS` is allowed through `sandboxEnv()` so that Node-based tier-1 ACP agents (e.g. `@agentclientprotocol/claude-agent-acp`) inherit it. However, this also means any value in `NODE_OPTIONS` from the parent process — including `--require /path/to/shim.js`, `--inspect`, or `--env-file=...` — propagates into tier-2-shim subprocesses (aider, cody) that are themselves Node-based. An attacker who can set `NODE_OPTIONS` in the am parent process environment can inject code into every shim subprocess.

The threat model comment at line 7-18 of `env-sandbox.ts` does not discuss this. Given that tier-2 wrappers are intentionally running untrusted CLIs, forwarding `NODE_OPTIONS` into them is the higher concern. For tier-1 native ACP agents where we want `NODE_OPTIONS` to be forwarded, the `extra` parameter in `ShimConfig.env` (or an explicit per-shim allow) is a narrower path.

**Fix:** Remove `NODE_OPTIONS` from `DEFAULT_ALLOW_LIST`. Document that tier-1 agents that need `NODE_OPTIONS` must pass it explicitly via `ShimConfig.env`.

#### MED-3 — `arg-named` is aliased to `arg-last` but the comment and type naming suggest future discrimination

**Severity:** MEDIUM
**File:** `src/protocols/acp/shell-wrapper.ts:26-28, 293-295`

The code comment says `arg-named` is "reserved for future use; currently same as arg-last." The `runPrompt` dispatch treats them identically:

```typescript
if (template === "arg-last" || template === "arg-named") {
  argv.push(promptText);
}
```

The `PromptTemplate` type exports `arg-named` as a valid variant. Any caller in-tree that writes `promptTemplate: "arg-named"` thinking it's distinct behaviour (e.g. a future community adapter that ships before Phase C) will silently get `arg-last` semantics. There is no runtime warning when `arg-named` is used.

**Fix:** Either remove `arg-named` from the union type until it is implemented, or emit a `console.warn` when it is used.

#### MED-4 — Summary counter in `am agent list` text output omits shim count

**Severity:** MEDIUM
**File:** `src/commands/agents.ts:129-135, 160`

The list footer reads `N registered (N native / N catalog-only), N discovered`. Tier-2-shim entries are not counted in either bucket, so they silently inflate the `N registered` number without appearing in the breakdown. After enabling three shims, a user would see `10 registered (4 native / 7 catalog-only)` — the numbers don't add up (4+7=11, not 10+3 shims).

**Fix:** Add `let shimCount = 0` alongside `nativeCount` and `catalogOnlyCount`, increment for `tier === "tier-2-shim"`, and include it in the footer string.

---

### LOW

#### LOW-1 — `test/helpers/tmp.ts` `write()` still uses `lastIndexOf("/")` (pre-existing, now touched by new tests)

**Severity:** LOW (Windows portability)
**File:** `test/helpers/tmp.ts:19`

REV-3 flagged this: `write()` uses `filePath.substring(0, filePath.lastIndexOf("/"))` to extract the directory, which is POSIX-only. The new test `agent-enable-shim.test.ts` calls `createTestDir` (and implicitly inherits the `write()` helper) — it doesn't call `write()` directly, but any future test that creates nested files via this helper will fail on Windows.

#### LOW-2 — Second live-probe test in `env-sandbox.test.ts` has tautological assertion

**Severity:** LOW (test quality)
**File:** `test/protocols/acp/env-sandbox.test.ts:206-213`

The test "AmAcpClient.connect spawn path uses sandboxed env" ends with `expect(true).toBe(true)`. The comment explains that the real assertion is structural (static import path, not runtime), and the actual leak check is in the previous test. This is documented and defensible, but the tautology means this test will always green regardless of what `connect()` does.

#### LOW-3 — `am agent list` text-mode endpoint label is "(catalog-only)" for tier-2-shim but `am agent list --json` uses `runnable: false`

**Severity:** LOW (surface inconsistency, related to MED-1)
**Files:** `src/commands/agents.ts:98-113, 136-139`

The JSON output path correctly includes `runnable` per agent. The text output path uses the string "(catalog-only)" as the endpoint label for any `runnable === false` agent — the two surfaces are inconsistent in how they communicate "not yet enabled for tier-2." Minor, subordinate to MED-1.

---

## Positive observations

**Gate wiring is correct.** All three ADR-0033 prelaunch gates integrate cleanly across module boundaries:
- Gate 1 (`sandboxEnv`): imported and called in `client.ts:139`, `shell-wrapper.ts:307`, and `flows.ts:528-533`. No new `Bun.spawn` call in the diff passes `process.env` directly.
- Gate 2 (`redactProgressMessage`): correctly sits on the `emitProgress` hot path in `server.ts:2882-2883`. Both ACP and A2A progress events pass through the same walker before emission.
- Gate 3 (`ShimAcpServer`): imports `sandboxEnv` from Gate 1 (line 36 of `shell-wrapper.ts`). The dependency chain is explicit and not circular.

**`--tier shim` filter works correctly.** The `normalizeTierFilter` function maps `"shim"`, `"tier-2"`, and `"tier-2-shim"` to `"tier-2-shim"`. The list filter `a.tier !== tierFilter` will correctly return tier-2 entries. The Tier column correctly renders "shim" via `renderTier`.

**`am-acp-shell` advertises `loadSession: false`.** `shell-wrapper.ts:178` returns `agentCapabilities: { loadSession: false }` from `initialize`. `session/load` returns `-32601` (lines 207-215). This matches the spec requirement from R-A §1.3 and the ADR.

**REV-1 MEDIUM-2 fix landed correctly for install/uninstall/update.** All three commands now import and use `withConfig` with the mutex.

**Security caveat is prominent.** The `SECURITY_CAVEAT` constant is shown both before the `--yes` prompt and after successful enable, ensuring users see it on both the non-interactive and success paths.

**Phase A catalog truth pass is accurate.** The `BUILT_IN_AGENTS` dict correctly reflects the audit — 4 tier-1-native, 3 tier-2-shim, 7 tier-3-catalog-only. devin and amp are removed. No new nominal entries.

---

## Recommendations, ordered

1. **[CRITICAL] Fix enable-shim config write path** (30 min).
2. **[HIGH] Add tier-2-specific refusal message** (30 min).
3. **[HIGH] Add `tier` and `runnable` to `am_agent_list` MCP response** (15 min).
4. **[HIGH] Route `agent-enable-shim` through `withConfig`** (20 min).
5. **[MEDIUM] Fix Endpoint column label for tier-2-shim** (15 min).
6. **[MEDIUM] Remove or deprecate `arg-named` from `PromptTemplate`** (10 min).
7. **[MEDIUM] Add shim count to `am agent list` summary footer** (10 min).
8. **[MEDIUM] Evaluate `NODE_OPTIONS` on sandbox allow-list** (1 hour).
9. **[LOW] Fix `test/helpers/tmp.ts` POSIX path split** (10 min).
10. **[LOW] Replace tautological `expect(true)` in env-sandbox live-probe** (10 min).

---

## References

- `src/commands/agent-enable-shim.ts` — critical CRIT-1 write path
- `src/core/agent-registry.ts` — `resolveAgent`, `ConfigAgentEntry`, `isCatalogOnly`, `tierRefusalMessage`
- `src/protocols/acp/env-sandbox.ts` — Gate 1 allow-list
- `src/protocols/acp/shell-wrapper.ts` — Gate 3 implementation
- `src/mcp/server.ts:1690-1706` — `am_agent_list` tool handler
- `src/mcp/server.ts:2267-2274` — `invokeAgentImpl` tier-refusal path
- `src/commands/agents.ts:129-163` — list output / tier counters
- `src/commands/run.ts:111-117` — `am run` tier-refusal path
- `test/commands/agent-enable-shim.test.ts` — test validates write path, not resolution path
- `test/protocols/acp/env-sandbox.test.ts` — tautological assertion at line 212
- `test/protocols/acp/shell-wrapper.test.ts` — otherwise solid in-process coverage
- `test/helpers/tmp.ts:19` — POSIX `lastIndexOf("/")` not fixed
- ADR-0033: `ADRs/0033-acp-agent-tiers-and-shim-wrapper.md`
- Prior reviews: REV-1 (structural), REV-2 (security), REV-3 (test/CI)
