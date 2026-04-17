# ACP Agent Auto-Detection — Design Review

**Date:** 2026-04-17
**Reviewer:** Claude Opus 4.7 (agent sub-thread)
**Scope:** How `agent-manager` can auto-detect which of the 16 built-in ACP agents
are actually installed locally, so that `am agent list` reflects reality rather
than a static hard-coded catalog. Context: ADR-0026 (ACP runtime), ADR-0030
(Unified agent registry), ADR-0031 (Pillar 3 — agent orchestration).

## Summary

Today `BUILT_IN_ACP_AGENTS` in `src/core/agent-registry.ts` is a static dict of
16 names → spawn commands. `am agent list` prints all 16 regardless of whether
any can actually be launched. Running `am run claude "hi"` spawns
`npx -y @agentclientprotocol/claude-agent-acp@latest`, which downloads on
demand — convenient for ephemeral use, but misleading in the catalog, and
slow/unreliable offline.

The good news: of the 16 built-in ACP agents, **12 have a one-to-one or
one-to-many mapping onto an existing adapter** whose `detect()` already knows
how to find the host tool on disk. Only **6 ACP agents have no adapter
counterpart** (`aider`, `goose`, `amp`, `augment`, `devin`, `sourcegraph`),
and two of those overlap (`sourcegraph`/`cody` share one binary-check with
`cody`). Everything else — `claude`, `codex`, `gemini`, `cursor`, `copilot`,
`kiro`, `amazon-q`, `cline`, `roo-code`, `windsurf` — can reuse the adapter
detection result essentially for free.

Proposal:

1. Add `AGENT_INSTALLED_WHEN` — a map from ACP-agent-name → either an adapter
   key (reuse adapter `detect()`) or a binary name (simple PATH check via a
   new `detectBinary()` helper).
2. Extend `UnifiedAgent` with `installed?: boolean`, `version?: string`,
   `detectionMethod?: "adapter" | "binary" | "npx-ephemeral" | "unknown"`.
3. Make `listAllAgentsAsync()` optionally populate `installed` under a
   caller-controlled flag (default OFF so the hot path in `resolveAgentAsync`
   stays cheap), with a memoized per-invocation cache so the 16 lookups
   happen at most once per CLI run.
4. Add `am agent detect [name]` — a deeper probe that spawns the ACP runtime
   and runs `initialize` (ACP JSON-RPC) to verify the binary actually speaks
   ACP (not merely that it exists). Shares code with the existing
   `am agent ping` surface for A2A.
5. `am agent list` grows an "Installed" column fed from the cheap detector,
   with explicit `--probe` to trigger the deep detection.

Three ACP agents (`claude`, `codex`) are always reachable because their
registered command is `npx -y …@latest`. For those, "installed" is better
framed as "host tool installed" (Claude Code, Codex CLI) — the ACP
wrapper is a transient download. This is actually the correct signal for
end users: "do I have Claude Code / Codex installed?", not "do I have the
npm package cached?".

Six agents need net-new detection code, but all six are trivial PATH checks
(`which $BIN`). Total net-new surface area: ~50 LOC plus ~150 LOC of table
lookups and wiring. No shell interactivity required.

Biggest risk: **false-positive binary names** like `q`, `amp`, `cody` — all
three are common short names that may collide with unrelated local binaries
(macOS `q`uit alias, `amp` electronics CAD, `cody` older Sourcegraph CLI
without ACP support). Mitigation: treat cheap detection as "probably
installed" and defer the ACP-capability assertion to `am agent detect`
(deep probe), which sends an `initialize` JSON-RPC and confirms a valid
protocol response.

---

## Detection matrix

| ACP agent     | Registered command                                    | Adapter derivable?     | New code needed                    | Notes                                                                                     |
|---------------|-------------------------------------------------------|------------------------|------------------------------------|-------------------------------------------------------------------------------------------|
| `claude`      | `npx -y @agentclientprotocol/claude-agent-acp@latest` | Yes — `claude-code`    | No                                 | Adapter already checks `~/.claude/` + `~/.claude.json` + tries `claude --version`.        |
| `codex`       | `npx @zed-industries/codex-acp@latest`                | Yes — `codex-cli`      | No                                 | Adapter checks `~/.codex/` + tries `codex --version`.                                     |
| `gemini`      | `gemini --acp`                                        | Yes — `gemini-cli`     | No                                 | Adapter checks `~/.gemini/` + `gemini --version`. Binary-in-PATH is the true signal here. |
| `cursor`      | `cursor-agent acp`                                    | Yes — `cursor`         | Small — check `cursor-agent`       | Adapter checks `~/.cursor/` but the ACP binary is `cursor-agent`, not `cursor`.           |
| `copilot`     | `copilot --acp --stdio`                               | Partial — `copilot`    | Yes — check `copilot` in PATH      | Adapter detects VS Code Copilot extension; ACP needs the GitHub Copilot **CLI**.          |
| `kiro`        | `kiro-cli-chat acp`                                   | Yes — `kiro`           | Small — check `kiro-cli-chat`      | Adapter checks `~/.kiro/`; ACP binary is `kiro-cli-chat`, separate from `kiro` editor.    |
| `aider`       | `aider --acp`                                         | **No adapter**         | Yes — check `aider` in PATH        | Python CLI, no adapter in repo today.                                                     |
| `amazon-q`    | `q chat --acp`                                        | Yes — `amazon-q`       | Small — check `q` in PATH          | Adapter checks `~/.aws/amazonq/`; the `q` CLI is a separate binary install.               |
| `amp`         | `amp --acp`                                           | **No adapter**         | Yes — check `amp` in PATH          | Sourcegraph Amp CLI, no adapter.                                                          |
| `augment`     | `augment-cli --acp`                                   | **No adapter**         | Yes — check `augment-cli` in PATH  | Augment Code CLI, no adapter.                                                             |
| `cline`       | `cline --acp`                                         | Partial — `cline`      | Yes — check `cline` in PATH        | Adapter detects the **VS Code extension**; the `cline` ACP CLI is separate.               |
| `roo-code`    | `roo --acp`                                           | Partial — `roo-code`   | Yes — check `roo` in PATH          | Adapter detects the **VS Code extension**; `roo` CLI is separate.                         |
| `goose`       | `goose --acp`                                         | **No adapter**         | Yes — check `goose` in PATH        | Block's Goose, no adapter.                                                                |
| `windsurf`    | `windsurf-cli --acp`                                  | Yes — `windsurf`       | Small — check `windsurf-cli`       | Adapter checks `~/.codeium/windsurf/`; ACP binary is `windsurf-cli`, not the editor.      |
| `devin`       | `devin --acp`                                         | **No adapter**         | Yes — check `devin` in PATH        | Cognition Devin CLI, no adapter.                                                          |
| `sourcegraph` | `cody --acp`                                          | **No adapter**         | Yes — check `cody` in PATH         | Sourcegraph Cody CLI, no adapter.                                                         |

### Count summary

- **Fully adapter-derivable (adapter presence ≈ ACP available):** 4
  (`claude`, `codex`, `gemini`, `kiro`-ish, but see row — the ACP binary name differs).
- **Adapter-derivable as a *necessary* precondition, plus one extra PATH check:** 6
  (`cursor`, `copilot`, `kiro`, `amazon-q`, `cline`, `roo-code`, `windsurf`).
  These all have an adapter that tells us "the host tool is installed", and an ACP
  sub-binary that ships alongside but must exist in PATH. The pragmatic rule is:
  adapter-installed AND binary-in-PATH → true; adapter-installed alone → "host
  present, ACP runtime may need enabling"; neither → false.
- **Pure binary-in-PATH (no adapter at all):** 6
  (`aider`, `amp`, `augment`, `goose`, `devin`, `sourcegraph`).

So the honest total is:

- 0 agents we can detect *purely* from an adapter with zero new code
  (even `claude` benefits from checking that `npx` itself is on PATH).
- 10 agents where the adapter gives us a strong signal and we add a
  cheap PATH check for the actual ACP binary name.
- 6 agents where only a PATH check exists.

For the report line: **10 adapter-derivable with one-line cross-checks, 6
need fresh binary-only detection code**.

### Edge: `npx -y ...@latest` commands

`claude` and `codex` have `npx` in their command. Detection question: are we
asking "is Claude Code installed?" or "can `npx` download the ACP wrapper?"

For end users, the former is almost always what they mean. Recommendation:
for these two agents, detection = "adapter reports installed AND `npx` is
on PATH". That correctly flags a dev-laptop with Claude Code installed as
"claude ACP runtime ready", and correctly flags an airgapped box without
Claude Code as "not installed" even if `npx` itself is present.

---

## Proposed API

### 1. Data model

In `src/core/agent-registry.ts`:

```ts
export interface UnifiedAgent {
  name: string;
  description?: string;
  source: "config" | "acp-builtin" | "a2a-roster";
  acp?: { command: string };
  a2a?: { url: string };

  // NEW — populated only when listAllAgents is called with { detect: true }
  installed?: boolean;
  version?: string;
  detectionMethod?: "adapter" | "binary" | "npx-ephemeral" | "unknown";
  detectionHint?: string;   // e.g. "Claude Code found at ~/.claude"
                            // or   "cody not in PATH — install https://…"
}
```

The fields are optional. Existing callers that don't care about installation
status get identical behavior to today. Callers that *do* care set
`{ detect: true }` once and get the enriched shape.

### 2. The detection table

New file `src/core/agent-detection.ts`:

```ts
export type AgentDetectionStrategy =
  | { kind: "adapter"; adapter: string; extraBinary?: string }
  | { kind: "binary"; binary: string }
  | { kind: "npx-ephemeral"; adapter: string /* host-tool adapter */ };

export const AGENT_DETECTION: Record<string, AgentDetectionStrategy> = {
  // npx-wrapped commands: "installed" means the host tool is.
  "claude":      { kind: "npx-ephemeral", adapter: "claude-code" },
  "codex":       { kind: "npx-ephemeral", adapter: "codex-cli"   },

  // host-tool adapter + binary-in-PATH
  "gemini":      { kind: "adapter", adapter: "gemini-cli" /* gemini --acp */ },
  "cursor":      { kind: "adapter", adapter: "cursor",     extraBinary: "cursor-agent" },
  "copilot":     { kind: "adapter", adapter: "copilot",    extraBinary: "copilot" },
  "kiro":        { kind: "adapter", adapter: "kiro",       extraBinary: "kiro-cli-chat" },
  "amazon-q":    { kind: "adapter", adapter: "amazon-q",   extraBinary: "q" },
  "cline":       { kind: "adapter", adapter: "cline",      extraBinary: "cline" },
  "roo-code":    { kind: "adapter", adapter: "roo-code",   extraBinary: "roo" },
  "windsurf":    { kind: "adapter", adapter: "windsurf",   extraBinary: "windsurf-cli" },

  // binary-only
  "aider":       { kind: "binary", binary: "aider"       },
  "amp":         { kind: "binary", binary: "amp"         },
  "augment":     { kind: "binary", binary: "augment-cli" },
  "goose":       { kind: "binary", binary: "goose"       },
  "devin":       { kind: "binary", binary: "devin"       },
  "sourcegraph": { kind: "binary", binary: "cody"        },
};
```

This table lives next to `BUILT_IN_ACP_AGENTS` so the two stay aligned. Lint:
a unit test asserts `Object.keys(AGENT_DETECTION).sort() ==
Object.keys(BUILT_IN_ACP_AGENTS).sort()`.

### 3. `detectBinary()` helper

New `src/lib/detect-binary.ts`:

```ts
export interface BinaryDetectResult {
  installed: boolean;
  path?: string;
  version?: string;
}

/**
 * Cheap PATH check for an ACP runtime binary.
 *
 * Uses a cross-platform "which" equivalent — walks PATH, tries .exe on Windows,
 * returns absolute path on first hit. Does NOT spawn the binary. Version is
 * populated lazily only if the caller explicitly asks (separate function).
 */
export function detectBinary(name: string, opts?: { withVersion?: boolean }): BinaryDetectResult;
```

Implementation detail: use `Bun.which()` (built-in, portable, cheap — just walks
PATH without spawning). If a version is requested, do a single
`Bun.spawnSync([name, "--version"], {timeout: 1500})`; swallow timeouts and
treat as unknown. Cache both the `which` and the `--version` result in a
module-level `Map<string, BinaryDetectResult>` keyed by binary name, so repeated
calls within one process are free.

### 4. `detectAgent()` — orchestrator

```ts
export async function detectAgent(
  name: string,
  options?: { withVersion?: boolean; adapterDetectCache?: AdapterDetectCache }
): Promise<{
  installed: boolean;
  version?: string;
  method: "adapter" | "binary" | "npx-ephemeral" | "unknown";
  hint?: string;
}> { /* ... */ }
```

Logic:

1. Look up `AGENT_DETECTION[name]`. If absent, return `{ installed: false,
   method: "unknown" }` (e.g. config-only agents pointing at custom commands —
   we can't detect those without spawning, which is out of scope here).
2. For `{kind: "adapter"}`: call the adapter's `detect()` (via the registry,
   cached — see §5). If `!adapter.installed`, return early with
   `installed: false`. If the strategy also specifies `extraBinary`, run
   `detectBinary(extraBinary)`; combine results (both must be true for
   `installed: true`; give hint when one passes and the other fails).
3. For `{kind: "binary"}`: call `detectBinary(binary)`; return.
4. For `{kind: "npx-ephemeral"}`: call the adapter's `detect()`, AND check that
   `npx` (or `bunx`) is in PATH. Report `installed` = adapter installed AND
   runner present.

### 5. Per-invocation cache

```ts
export interface AdapterDetectCache {
  get(name: string): DetectResult | undefined;
  set(name: string, result: DetectResult): void;
}

export function createAdapterDetectCache(): AdapterDetectCache;
```

`listAllAgentsAsync({ detect: true })` creates one cache, passes it to every
`detectAgent()` call. Each adapter's `detect()` runs at most once per CLI
invocation regardless of how many ACP agents depend on it. Same cache is
shared with `am doctor` / `am adapter list --detect` if we want to be thorough.

### 6. `listAllAgents` extension

```ts
export async function listAllAgentsAsync(
  config?: UnifiedRegistryConfig,
  configDir?: string,
  options?: { detect?: boolean; withVersions?: boolean }
): Promise<UnifiedAgent[]>;
```

Behavior:

- `detect: false` (default) — zero I/O beyond today. No performance change.
- `detect: true` — one pass: build the agent list, then in parallel
  `Promise.all()` call `detectAgent()` for each name. Populate `installed`,
  `version`, `detectionMethod`, `detectionHint`.

### 7. CLI surface

#### `am agent list` — gains `--installed-only` and `--probe`

```text
am agent list                  # today's behavior (zero I/O agent probe)
am agent list --detect         # adds an "Installed" column (cheap PATH check)
am agent list --installed-only # filters to installed=true (implies --detect)
am agent list --probe          # deep probe: spawn each ACP agent, run
                               # initialize, mark truly-ACP-speaking ones.
                               # Slow (16 spawns). JSON output preferred.
```

Sample output with `--detect`:

```text
Name            Protocol  Source        Installed  Endpoint
──────────────  ────────  ────────────  ─────────  ────────────────────────
aider           ACP       acp-builtin   no         aider --acp
amazon-q        ACP       acp-builtin   yes        q chat --acp
amp             ACP       acp-builtin   no         amp --acp
augment         ACP       acp-builtin   no         augment-cli --acp
claude          ACP       acp-builtin   yes (npx)  npx -y @agentclientprotocol/...
cline           ACP       acp-builtin   host-only  cline --acp     ← extension installed, CLI missing
codex           ACP       acp-builtin   yes (npx)  npx @zed-industries/codex-acp@latest
copilot         ACP       acp-builtin   no         copilot --acp --stdio
cursor          ACP       acp-builtin   yes        cursor-agent acp
devin           ACP       acp-builtin   no         devin --acp
gemini          ACP       acp-builtin   yes        gemini --acp
goose           ACP       acp-builtin   no         goose --acp
kiro            ACP       acp-builtin   no         kiro-cli-chat acp
roo-code        ACP       acp-builtin   no         roo --acp
sourcegraph     ACP       acp-builtin   no         cody --acp
windsurf        ACP       acp-builtin   no         windsurf-cli --acp
```

The "host-only" marker is the important UX win: users learn that their Cline
VS Code extension is detected, but the separate CLI (`cline`) that speaks ACP
isn't on their PATH — with a one-line hint to install it.

#### `am agent detect [name]` — deep probe

```text
am agent detect                # probe all built-in ACP agents
am agent detect claude         # probe just one, verbose output
```

Deep probe = cheap detection PLUS a short-lived ACP handshake:

1. Spawn the ACP command with a 5 s timeout.
2. Send `initialize` JSON-RPC per ACP spec.
3. If a valid `InitializeResponse` comes back → "ACP-compatible".
4. Kill the child.

This is the authoritative check but it costs ~1–5 s per agent, so it's an
explicit subcommand, never on the hot path. Good fit for `am doctor` as a
"--deep" option and for CI smoke tests.

### 8. Data flow

```
                                          ┌───────────────────────────┐
am agent list [--detect]                  │  BUILT_IN_ACP_AGENTS      │
       │                                  │  (static spawn commands)  │
       ▼                                  └───────────────────────────┘
listAllAgentsAsync(cfg, configDir,                    │
                   { detect: true })                  │
       │                                              │
       ├─▶ resolve config / built-in / roster  ◀──────┘
       │
       ├─▶ for each agent name ──▶ detectAgent()
       │                                │
       │                                ├─▶ AGENT_DETECTION[name]
       │                                │         │
       │                                │         ├─▶ "adapter":
       │                                │         │     adapter.detect() (cached)
       │                                │         │     + optional detectBinary()
       │                                │         │
       │                                │         ├─▶ "binary":
       │                                │         │     Bun.which(name)
       │                                │         │
       │                                │         └─▶ "npx-ephemeral":
       │                                │               adapter.detect() + which("npx")
       │                                │
       │                                └─▶ { installed, version?, method, hint? }
       │
       ▼
 UnifiedAgent[]  (each entry optionally enriched with installed/version)
       │
       ▼
 render table / JSON
```

---

## Risks and mitigations

### R1. False positives — binary-in-PATH but doesn't speak ACP

**Scenarios:**
- `q` — clashes with many unrelated CLIs (Amazon Q Developer CLI is relatively
  new; older `q` binaries exist for different tools on many systems).
- `amp` — electronics/circuit simulators named `amp`, `amp-cli` packages, etc.
- `cody` — Sourcegraph ships multiple `cody` binaries; older ones don't have
  `--acp`.
- `devin` — unlikely to clash given vendor-specific marketing, but a user
  could have aliased it locally.

**Mitigation (tiered):**
1. Cheap detection (default) reports `installed: true` — accept the false
   positive rate. The downstream failure mode is a clean error from
   `am run <name>`: "Agent declined to speak ACP" → user knows to investigate.
2. `am agent detect <name>` does the ACP handshake and upgrades to
   `acp-verified`, `acp-unknown`, or `not-installed`. For the "am doctor"
   audience this is the authoritative answer.
3. Cache the deep-probe result in `~/.config/agent-manager/acp-detection.json`
   with a 7-day TTL keyed by `(name, binary-path, binary-mtime)`. Survives
   CLI invocations, invalidates on upgrade. Optional — not in phase 1.

### R2. False negatives — binary is a shell function or alias

**Scenario:** User has `goose` as a zsh function or a `~/.local/bin` shim that
only exists when their shell is sourced. `Bun.which()` (PATH walk) won't find
it.

**Mitigation:**
- Document: `am` detects binaries via PATH, not shell aliases. Ask users to
  install tools so they appear in PATH.
- For exact-miss cases, add `[agents.<name>.acp.command]` in TOML — the config
  override always wins in the resolver, so users can wire up a custom path
  explicitly.
- Don't try to spawn a login shell to resolve aliases. That's slow, platform-
  dependent, and introduces new failure modes.

### R3. Cross-platform PATH quirks

**Scenarios:**
- Windows: `.exe` / `.cmd` / `.ps1` extensions, PATHEXT semantics.
- macOS Gatekeeper: a binary in PATH may be quarantined and refuse to run.
  PATH check says yes, spawn says no.
- Permissions: a file may exist + be on PATH but lack +x.

**Mitigation:**
- `Bun.which()` already handles Windows PATHEXT correctly — reuse it.
- For Gatekeeper / permission edge cases, the cheap detector has no way to
  know. Again, the deep probe is the authoritative gate; cheap detection is
  a heuristic, not a contract. Document that.
- On Windows, compare case-insensitively; `Bun.which` does this right.

### R4. Performance — 16 PATH lookups on every CLI invocation

**Scenarios:**
- Hot path: `am run claude "..."` resolves one agent. Today: one registry
  lookup, no detection. Tomorrow if we auto-detect: we'd want to skip
  detection entirely (we don't need it to spawn). → Easy: `resolveAgentAsync`
  does NOT detect; `listAllAgentsAsync({ detect: true })` does.
- List path: `am agent list --detect` runs 16 detections. Even worst-case
  (all sixteen are binary-only), this is ~16× `Bun.which()` (<10 ms total
  cold) + ~0 spawn calls. Totally acceptable.
- Version fetch: if we ask for versions cheaply, we'd spawn each binary with
  a 1.5 s timeout. Worst case ~24 s for 16 agents. Therefore: `--detect` alone
  does NOT populate versions. Only `am agent detect` (or `--probe`) does.

**Mitigation:**
- Separate "is it installed" (fast, always OK to run) from "what version"
  (slow, only when asked).
- Module-level cache on `detectBinary` so repeated PATH lookups coalesce.
- Per-invocation `AdapterDetectCache` so adapter `detect()` functions are
  called at most once.
- Run the 16 detections in `Promise.all()` — they're independent fs-read and
  PATH-walk, naturally parallel.

### R5. Security surface — spawning arbitrary binaries found in PATH

**Scenario:** Deep probe spawns `cody --acp` to verify ACP support. If a
malicious `cody` sits early on PATH, we execute it.

**Mitigation:**
- Cheap detection never spawns, so the default path is safe.
- Deep probe is opt-in (`am agent detect` or `--probe`). Document that it
  launches the binary with a 5-second timeout.
- Consider honoring `AM_DENYLIST_BINARIES` env var for pathological cases.
- Align with ADR-0019 security hardening.

### R6. npx-ephemeral agents are always "fine" in principle

`npx -y foo@latest` always works if npm is reachable — first run pays a
download cost, second run is cached. So the UX question is "what does
`installed: true` mean for `claude`?" We chose: host-tool installed AND
`npx`/`bunx` in PATH. This aligns with user intuition: someone who has
`claude` (Claude Code) configured locally is "set up"; someone on an airgap
without Claude Code is not, even if npm itself works.

Document this explicitly in `--help` and in the docs.

### R7. Drift between `BUILT_IN_ACP_AGENTS` and `AGENT_DETECTION`

The two tables must stay aligned. If someone adds a new ACP agent to
`BUILT_IN_ACP_AGENTS` and forgets the detection entry, `am agent list --detect`
will happily report `method: "unknown"` for it.

**Mitigation:**
- Unit test: the key sets must be equal.
- Lint rule (simple grep in pre-commit or CI) — if `BUILT_IN_ACP_AGENTS` is
  edited, CI fails unless `AGENT_DETECTION` is also edited in the same PR.
- Type-level: if both dicts share a `AgentName` union, TS catches missing
  entries at compile time. Worth a follow-up once the list stabilizes.

### R8. Community-adapter interaction

Community adapters loaded via `src/adapters/community/loader.ts` also have
`detect()` functions. An enterprising user could ship an ACP agent via a
community adapter. Today `AGENT_DETECTION` is a static module-level const —
it doesn't know about community adapters.

**Mitigation (phase 3):**
- Allow community adapters to declare an `acpAgents: string[]` field in
  their `adapters.toml` entry. At load time, merge those into a mutable
  `agentDetection` map for the duration of the CLI invocation.
- Out of scope for phase 1; the 16 built-ins are the immediate need.

---

## Implementation plan (phased)

### Phase 1 — Cheap detection, opt-in (small, low-risk, 1–2 days)

**Goal:** `am agent list --detect` shows an accurate Installed column for
all 16 built-in ACP agents without network or spawn calls.

Deliverables:
1. `src/lib/detect-binary.ts` — `detectBinary(name)` using `Bun.which()` with
   a module-level cache. ~30 LOC + tests.
2. `src/core/agent-detection.ts` — `AGENT_DETECTION` table and
   `detectAgent(name, cache)`. ~80 LOC + tests.
3. Extend `src/core/agent-registry.ts`:
   - `UnifiedAgent` gains optional `installed`, `version`, `detectionMethod`,
     `detectionHint` fields.
   - `listAllAgentsAsync` accepts `{ detect?: boolean }`.
4. Extend `src/commands/agents.ts` list subcommand: `--detect`,
   `--installed-only` flags; new Installed column.
5. Unit tests:
   - Mocked adapter registry returning controlled `{installed, paths}`.
   - Mocked `Bun.which()` returning present/absent.
   - Verify each of 16 agents resolves correctly under each branch.
6. Doc: update ADR-0030 with a small "Agent installation detection" section
   pointing at the new table. Update `am agent list --help`.

Acceptance: on a clean test box with only `aider` and `gemini` in PATH, the
list prints exactly those two as `installed: yes` and the other 14 as `no`.

### Phase 2 — Deep probe (`am agent detect`) (2–3 days)

**Goal:** authoritative "does this binary actually speak ACP?" answer.

Deliverables:
1. New subcommand in `src/commands/agents.ts`: `am agent detect [name]`.
2. Reuse `AmAcpClient.connect()` with a short `initTimeout` and a 5 s upper
   bound; if `initialize` returns a valid `InitializeResponse`, mark the
   agent `acp-verified`. Catch ACP errors cleanly.
3. Output modes: human-readable table for multi-agent scans, detailed JSON
   for single-agent diagnostics.
4. Wire `--probe` flag on `am agent list` as a shortcut.
5. Update `am doctor` to include ACP probe as an optional `--deep` step.

Acceptance: `am agent detect claude` on a box with Claude Code installed
prints `acp-verified` plus the returned agent info (name + version) from the
initialize handshake. On the same box, `am agent detect devin` prints
`not-installed` with a clear install hint.

### Phase 3 — Persistence and community (2–4 days, optional)

**Goal:** make `--probe` results re-usable across invocations; open the
detection system to community adapters.

Deliverables:
1. `~/.config/agent-manager/acp-detection.json` — keyed by
   `(agent-name, binary-path, binary-mtime)`, TTL 7 days, used transparently
   by `detectAgent()` when available.
2. Community-adapter `acpAgents` field in `adapters.toml`; loader populates
   a runtime detection map; `listAllAgentsAsync` consults both.
3. `am agent install <name>` — bonus: when detection says "not installed",
   offer to run the upstream install command (e.g. `npm i -g @zed-industries/
   codex-acp` for codex, `brew install cody` for sourcegraph). Requires a
   curated `installHint` field in `AGENT_DETECTION`. Out-of-scope for
   phase 1–2 but a natural extension.

### Phase 4 — Enforce drift (30 min)

Add a TS compile-time check (shared union of agent names) or a runtime
invariant + CI unit test so that any future addition to
`BUILT_IN_ACP_AGENTS` requires a matching `AGENT_DETECTION` entry. Tiny, but
crucial for long-term hygiene.

---

## Open questions / follow-ups

1. **Should `am run <name>` auto-detect before spawning?** Pro: clearer error
   message if binary is missing. Con: slows the hot path by ~10 ms. Proposal:
   no auto-detect by default; on spawn failure, call `detectAgent()` and
   enrich the error message. That way we pay the detection cost only when
   something's wrong.

2. **Should `am agent list` default to `--detect`?** Probably yes in a future
   breaking release, once phase 1 is stable. The cost is ~10 ms parallel,
   which users won't notice, and the UX benefit is large. For now, opt-in
   via flag.

3. **Version strings — where to display?** Propose: only in `--verbose`
   list output and in `am agent detect` detailed output. Not in the default
   table (keeps it narrow).

4. **What about A2A agents in the roster?** They already have a "ping" that
   probes the URL. Mention in docs that ACP detection is local-binary-only;
   A2A detection is HTTP round-trip (existing `am agent ping`).

5. **ACP version negotiation.** If the deep probe returns a protocolVersion
   the client doesn't support, what do we report? Propose: `acp-verified`
   with a warning about version skew. Out-of-scope detail.

---

## Files that would change (phase 1 scope)

- `src/core/agent-registry.ts` — extend `UnifiedAgent` type; add `detect` option to `listAllAgentsAsync`.
- `src/core/agent-detection.ts` — **new**.
- `src/lib/detect-binary.ts` — **new**.
- `src/commands/agents.ts` — wire `--detect`, `--installed-only` flags; new column.
- `test/core/agent-detection.test.ts` — **new**.
- `test/commands/agents.test.ts` — extend for new flags.
- `ADRs/0030-unified-agent-registry.md` — append Phase-3 addendum on detection.
- `CLAUDE.md` or docs — document the detector behavior for users.

No changes to adapters. No changes to `BUILT_IN_ACP_AGENTS` itself. No changes
to `am run`. Minimal blast radius.
