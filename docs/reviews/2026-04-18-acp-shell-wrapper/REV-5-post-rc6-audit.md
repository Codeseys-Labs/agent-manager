---
status: active
date: 2026-04-20
---

# REV-5 — Fresh-eyes Audit of rc6 (post-landing)

**Date:** 2026-04-20
**Scope:** rc6 (`v0.5.0-rc6`) at HEAD — fresh-eyes pass distinct from REV-1–4 scope.
**Method:** Documentation ↔ code drift checks, install-path lifecycle tracing,
bridge/TUI tier-refusal gaps, test quality sample audit, cross-surface
tier/runnable consistency.
**Reviewer:** Agent (Sonnet 4.6 1M). Read-only — no source modified.

Prior reviews covered: REV-1 (structural), REV-2 (security), REV-3 (test/CI),
REV-4 (integration post-landing). REV-4's CRITICAL (enable-shim dead-on-arrival)
was fixed in ee030ae; rc6 shipped. This review looks for what the previous
reviewers missed because they were focused on their assigned facet.

---

## Summary

**Health score: 8.0 / 10.**

No new CRITICALs. rc6 is shippable. The REV-4 CRITICAL regression was correctly
fixed and the test now validates both the write path and the resolution path. All
three tier-refusal surfaces (`am run`, `am flow run`, `am_agent_invoke`) emit the
right tier-2 vs tier-3 message. REV-2 HIGH-3 env-scrubbing is wired. REV-2 HIGH-1
progress-redaction is wired and tested.

What holds the score below 9:

1. **`install.sh` and Homebrew formula do not install `am-acp-shell`.** Any user
   who installs via either path, runs `am agent enable-shim aider --yes`, then
   `am run aider` will hit ENOENT on the shim. The binary is in the release
   artifacts but neither install path pulls it.
2. **`am agent detect <tier-2-name>` emits the tier-3 "catalog-only" refusal.**
   `am agent detect aider` says aider is "a catalog-only (tier-3) integration"
   — the same wrong message REV-4 HIGH-1 fixed everywhere else. `am agent
   detect` was missed in that pass.
3. **Two stale comments describe the pre-fix broken config path** (`adapters.acp.command`
   instead of the correct `acp.command`). These are the exact artifacts that
   would lead a future debugger back into the CRIT-1 trap.
4. **A2A bridge passes `registryConfig: undefined`** — shim-enabled agents are
   invisible to the bridge even after `enable-shim`.

---

## Findings by severity

### HIGH

#### HIGH-1 — `install.sh` and Homebrew formula don't install `am-acp-shell`

**Severity:** HIGH (Tier-2 feature dead-on-arrival for primary install paths).
**Files:** `install.sh:142-210`, `Formula/am.rb:29-31`,
           `.github/workflows/release.yml:139-186`.

`install.sh` downloads only `am-${OS}-${ARCH}` and installs it as `am`.
There is no download or install step for the matching `am-acp-shell-${OS}-${ARCH}`.
The Homebrew formula's `install` block (`bin.install binary_name => "am"`) installs
only the single binary determined from the URL path.

The enable-shim flow at `src/commands/agent-enable-shim.ts:112` writes:
```
entry.acp = { command: `am-acp-shell ${name}` };
```

When `am run aider` subsequently resolves this command, `client.connect("am-acp-shell aider")`
is called, `parseCommand` yields `executable: "am-acp-shell"`, and
`Bun.spawn(["am-acp-shell", "aider"])` fails with ENOENT because the binary was
never installed.

The build script (`scripts/build.ts:31-34`) does produce `am-acp-shell-*` for every
target, and the release workflow uploads `dist/am-*` (line 63) which correctly
includes both binary families. The binaries reach the GitHub Release. They are just
not downloaded by either primary install path.

The Homebrew formula regeneration in `release.yml:139-186` also only installs `am`:
```ruby
def install
  binary_name = stable.url.split("/").last
  bin.install binary_name => "am"
end
```

**Fix:**
1. `install.sh`: after installing `am`, download and install the matching
   `am-acp-shell-${OS}-${ARCH}` artifact from the same release tag. ~15 lines
   mirroring the existing download block. Install as `am-acp-shell` (no rename).
2. `Formula/am.rb` template in `release.yml:139-186`: add a second URL + sha256
   block for `am-acp-shell-*` per platform, and add a second `bin.install` line
   in `def install`.

**Note on npm path:** users who install via `npm install -g agent-manager` get the
`bin/am-acp-shell.js` shim which falls back to `bun run src/acp-shell-cli.ts`. If
they have bun installed this works; if they don't, the shim prints a clear error.
The npm path is not broken. Only the binary-download paths are.

---

#### HIGH-2 — `am agent detect <tier-2-name>` emits the tier-3 "catalog-only" message

**Severity:** HIGH (user-visible wrong message; same class as REV-4 HIGH-1).
**File:** `src/commands/agents.ts:597-601`.

```typescript
if (spec.tier === "tier-3-catalog-only" || !spec.command) {
  error(tierRefusalMessage(name), opts);
  process.exitCode = 1;
  return;
}
```

Tier-2 shim entries have `command: ""`, so `!spec.command` is `true`. The condition
fires and emits `tierRefusalMessage` which says:

> `"aider" is a catalog-only (tier-3) integration. am writes its config via
> \`am apply\` but cannot spawn it — it has no standalone ACP runtime (VSCode
> extensions, IDE-only products). Use it from its native UI...`

Every clause is factually wrong for aider. REV-4 HIGH-1 fixed this exact pattern
in `am run` (lines 116-120), `am flow run` (lines 100-104), and `am_agent_invoke`
(lines 2281-2285) — but `am agent detect` was not part of that fix pass.

A user who runs `am agent detect aider` to check why `am run aider` fails will be
told aider is a VSCode extension with no path forward, when the correct next step
is `am agent enable-shim aider`.

**Fix:**
```typescript
if (spec.tier === "tier-3-catalog-only") {
  error(tierRefusalMessage(name), opts);
  process.exitCode = 1;
  return;
}
if (spec.tier === "tier-2-shim") {
  const { shimNotEnabledMessage } = await import("../core/agent-registry");
  error(shimNotEnabledMessage(name), opts);
  process.exitCode = 1;
  return;
}
```

---

### MEDIUM

#### MED-1 — Stale comments document the pre-fix broken config path

**Severity:** MEDIUM (misleading to future debuggers; creates re-regression risk).
**Files:** `src/core/agent-registry.ts:123`, `test/commands/agent-enable-shim.test.ts:6`.

**Location 1 — `agent-registry.ts:123`:**
```typescript
// The user must run `am agent enable-shim <name>` to opt in, which writes
// `[agents.<name>].adapters.acp.command = "am-acp-shell <name>"` to their
```
The actual post-fix write path is `agents.<name>.acp.command` (no `adapters`
intermediate). This comment describes the BROKEN path that REV-4 CRIT-1
identified.

**Location 2 — `test/commands/agent-enable-shim.test.ts:6`:**
```typescript
 *   - Happy path: `am agent enable-shim aider --yes` writes the shim command
 *     to config.toml under [agents.aider.adapters.acp.command].
```
Same stale path. The test body (line 98) correctly checks `aider?.acp?.command`
— only the docblock is wrong.

**Fix:** Two one-line changes updating the paths to `acp.command`.

---

#### MED-2 — A2A bridge ignores user config; shim-enabled agents are invisible

**Severity:** MEDIUM (shim feature works for direct CLI, silently fails via A2A bridge).
**Files:** `src/web/server.ts:548-561`, `src/protocols/bridge.ts:123-127, 152-165`.

`createA2ARoutes` is called with `enableBridge: true` but no `bridgeConfig`:
```typescript
const a2aApp = createA2ARoutes({
  config: bridgeResolved,
  cardOptions: { baseUrl: "http://localhost:3456" },
  enableBridge: true,
  auth_token: authToken,
  // bridgeConfig is absent
});
```

Inside `createBridgeTaskHandler`, `registryConfig = bridgeConfig?.registryConfig`
is `undefined`. The bridge's `resolveUnifiedAgent` skips the config-override branch
(which reads `config?.agents?.[name]`) and returns the tier-2 built-in spec with no
`acp` field. The bridge returns "not available locally."

After `am agent enable-shim aider --yes`, direct `am run aider` works because
`resolveAgentAsync` reads the config from disk. But A2A bridge does not read it.
The enable-shim opt-in is invisible to the bridge.

**Fix:** Pass the raw config into the bridge. ~5 line change in `src/web/server.ts`.

---

#### MED-3 — ADR-0031 pillar 6 claims "no parallel implementations" — still false

**Severity:** MEDIUM (documentation drift; ADR contains a false architectural claim).
**Files:** `ADRs/0031-product-scope-and-pillars.md:124-125`,
           `src/tui/index.tsx:157-177`.

ADR-0031 pillar 6 states: "All three are skins over the same core via
`core/controller.ts` (iter4 Wave B) — no parallel implementations."

REV-1 MEDIUM-1 documented that `src/tui/index.tsx:157-177` (`handleApply`) is a
fourth apply pipeline. This remains unchanged. Future auditors reading the ADR
will not realize there is a known divergence.

**Fix:** Update ADR-0031 §Pillar 6 to acknowledge the TUI divergence, OR route
TUI through `applyResolved` (IMPL-D workstream 2 targets this).

---

### LOW

#### LOW-1 — `--runnable` filter hides A2A-reachable agents that share a name with tier-3 built-in

**Severity:** LOW (edge-case filter semantics; no data loss).
**File:** `src/commands/agents.ts:84`, `src/core/agent-registry.ts:404-415`.

A roster agent whose name matches a tier-3 built-in gets a merged entry with
`runnable: false` even though it's reachable via A2A. Not a blocker.

---

#### LOW-2 — `/bin/echo -n` in shell-wrapper test may not be portable across Linux distros

**Severity:** LOW (latent CI noise; not a current blocker).
**File:** `test/protocols/acp/shell-wrapper.test.ts:85`.

`/bin/echo -n` suppresses trailing newline on macOS but may print `-n` literally on
some Linux distros. The test is `skipIf(win32)` but not Linux-guarded.

---

## Positive observations

**REV-4 CRIT-1 fix is thorough.** `agent-enable-shim.ts` correctly writes to
`entry.acp`, and the test asserts the resolution path (`resolveAgent("aider",
config)?.acp?.command === "am-acp-shell aider"`), not just the write.

**Tier-refusal unification complete on three surfaces.** `am run`, `am flow run`,
and `am_agent_invoke` all correctly check `isShimNotEnabled` before `isCatalogOnly`.

**`am_agent_list` MCP tool includes `tier`, `runnable`, `installed`.** CHANGELOG
claim matches code. REV-4 HIGH-2 closed.

**`am agent list --tier` filter fully implemented.** All three canonical aliases
per tier. Footer summary includes `N shim`.

**Env-scrubbing wired at both spawn sites.** `client.ts:139` (tier-1) and
`shell-wrapper.ts:307` (tier-2). Env-leak test asserts canary absence in child.

**Progress-redaction tests well-structured.** Covers `redactProgressMessage` walker
+ end-to-end emission path via `McpServer.setProgressSink`.

**`bin/am-acp-shell.js` and `scripts/build.ts` structurally correct.** Build
produces both binaries per target. Launcher uses `execFileSync` with argv array
(no shell eval). Release workflow uploads correct artifacts with codesigning.

---

## Recommendations ordered

1. **[HIGH] Fix `install.sh`** to download and install `am-acp-shell-${OS}-${ARCH}`
   alongside `am`. ~15 lines. Tier-2 is non-functional for binary-installed users
   without this.
2. **[HIGH] Fix `am agent detect`** at `src/commands/agents.ts:597-601` to use
   `shimNotEnabledMessage` for tier-2-shim entries instead of the tier-3 message.
3. **[MEDIUM] Correct the two stale `adapters.acp.command` comments** in
   `agent-registry.ts:123` and `agent-enable-shim.test.ts:6`.
4. **[MEDIUM] Pass `registryConfig` to the A2A bridge** in `src/web/server.ts` so
   shim-enabled agents are reachable via A2A delegation.
5. **[MEDIUM] Update ADR-0031 §Pillar 6** or land the TUI collapse onto
   `applyResolved`.
6. **[LOW] Update the Homebrew formula template** in `release.yml` to install
   `am-acp-shell` alongside `am`.
7. **[LOW] Replace `/bin/echo -n`** in `shell-wrapper.test.ts:85` with
   `/bin/bash -c 'printf "%s" "$1"' --` for cross-distro portability.

---

## References

- `install.sh:142-210` — only downloads and installs `am`
- `Formula/am.rb:29-31` — `def install` installs only `am`
- `.github/workflows/release.yml:59-64, 139-186` — builds both binaries correctly;
  formula template installs only `am`
- `src/commands/agents.ts:597-601` — wrong message for tier-2 in `detect`
- `src/core/agent-registry.ts:119-127` — stale comment: `adapters.acp.command`
- `test/commands/agent-enable-shim.test.ts:5-10` — stale docblock comment
- `src/web/server.ts:548-561` — bridge created without `bridgeConfig`
- `src/protocols/bridge.ts:123-127, 152-165` — `registryConfig` nil when no config passed
- `ADRs/0031-product-scope-and-pillars.md:122-125` — "no parallel implementations" claim
- `src/tui/index.tsx:157-177` — fourth apply pipeline (pre-existing divergence)
- `test/protocols/acp/shell-wrapper.test.ts:85` — `/bin/echo -n` portability
- Prior reviews: REV-1 MEDIUM-1 (TUI divergence), REV-4 HIGH-1 (tier-2 refusal),
  REV-4 CRIT-1 (enable-shim path fix)
