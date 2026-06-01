# Adapter Layer Audit — agent-manager (`am`)

**Dimension:** adapter-layer (13 IDE adapters + 3 platform adapters + community JSON-RPC subprocess loading)
**Date:** 2026-05-31
**Auditor bar:** Is this layer architected to ship as a downloadable CLI with a first-run wizard that gets a stranger to value without reading source?

---

## 1. What actually exists

### 1.1 The interface

`src/adapters/types.ts:208-216` defines the `Adapter` contract:

```ts
export interface Adapter {
  meta: AdapterMeta;
  detect(): DetectResult | Promise<DetectResult>;
  import(options: ImportOptions): ImportResult | Promise<ImportResult>;
  export(config: ResolvedConfig, options: ExportOptions): ExportResult | Promise<ExportResult>;
  diff(config: ResolvedConfig): DiffResult | Promise<DiffResult>;
  sessionReader?: SessionReader;
  scanMarketplace?(): MarketplaceResult;
}
```

This is a clean, serializable, sync-or-async contract. The `schema` field was deleted 2026-05-05 per ADR-0041 (`types.ts:165-171`) — that cleanup is real and complete in the code.

### 1.2 The registry

`src/adapters/registry.ts:21-74` is a lazy factory map: 13 built-in adapters, each a `() => import("./<name>/index.ts")` thunk, cached after first instantiation (`registry.ts:76, 96-102`). Community adapters are resolved only after the built-in fast path misses (`registry.ts:104-117`), and built-ins always shadow community names with the same key (`registry.ts:89`). This matches ADR-0011 and ADR-0027 exactly.

`getDetectedAdapters()` (`registry.ts:125-136`) iterates **only built-in adapters** (`listAdapters()`), not community ones. So community adapters never auto-apply — they require `am apply --target <name>`. This is intentional per ADR-0027's trust model but is undocumented at the CLI surface and surprising.

### 1.3 The per-adapter file layout — NOT the documented 6-file pattern

CLAUDE.md and `docs/adapter-development-guide.md` both claim a 6-file pattern ending in `schema.ts`. **No adapter has `schema.ts`** (verified: `ls src/adapters/*/schema.ts` → none). The real layout is variable:

| Adapter | index | detect | import | export | diff | identity | session | other |
|---|---|---|---|---|---|---|---|---|
| claude-code | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | marketplace.ts |
| cursor | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | — |
| windsurf | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| kilo-code | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | jsonc.ts |
| continue | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | yaml.ts |
| forgecode | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| amazon-q | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| codex-cli, cline, copilot, roo-code, gemini-cli | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | — |

`identity.ts` appears in 6 adapters; `session.ts` in 8; `scanMarketplace` wiring in 5 (`claude-code, copilot, cursor, kiro, windsurf`). The optional capabilities are genuinely optional — that's fine — but the **documented canonical shape is wrong**, which is a direct trap for a 14th-adapter contributor (see §4).

---

## 2. Strengths

1. **Clean, IPC-friendly interface.** Every method takes/returns plain serializable data, which is exactly why the community subprocess proxy (`community/proxy.ts:186-204`) can implement `Adapter` by forwarding JSON-RPC calls with no special-casing. ADR-0011's "designed but deferred" escape hatch was realized faithfully in ADR-0027.

2. **Strong test coverage.** 84 adapter test files; one `roundtrip.test.ts` per IDE adapter (12 total, verifying import→export symmetry); dedicated community tests (`loader.test.ts`, `loader-checksum.test.ts`, `proxy.test.ts`, `proxy.env.test.ts`, `registry-integration.test.ts`, plus per-fork variant tests). `bun test test/adapters/cursor test/adapters/community` → 185 pass / 0 fail.

3. **Community-adapter security is serious and tested.** Checksum TOFU pinning on install (`commands/adapter.ts:200-214`, `567-571`), refusal to spawn unchecksummed non-local adapters (`community/loader.ts:44-55`), tamper detection on every load (`loader.ts:78-82`), `--ignore-scripts` on npm/git install and update (`commands/adapter.ts:167, 332, 550`), and env scrubbing of the child subprocess so `AM_ENCRYPTION_KEY`/tokens don't leak (`community/proxy.ts:66-77` via `sandboxEnv`). Adapter-name validation blocks path traversal before any FS/spawn (`commands/adapter.ts:471-496`).

4. **Real shared helpers that are widely adopted for diff.** `compareServerFields` (`shared/utils.ts:51-109`) is used by 12 of 13 adapters' `diff.ts`. `shared/vscode-paths.ts` correctly centralizes the VS Code fork storage maze (Code/Insiders/VSCodium/Cursor/Windsurf, case-sensitivity notes at `vscode-paths.ts:9-19`) and is the right level of abstraction.

5. **Apply pipeline is safe and observable.** `core/controller.ts:213-343` serializes apply under a mutex, scans for URL-embedded credentials before any write (`controller.ts:239-242`), supports `--diff` drift-gating that refuses to overwrite drifted configs without `--force` (`controller.ts:273-308`), and treats per-adapter failures as isolated (`controller.ts:321-330`). `apply.ts:89-99` even gives a novice a recovery path when nothing is detected.

---

## 3. Weaknesses

### 3.1 CRITICAL — Doc drift will mislead the first contributor and the first user

- CLAUDE.md "How to Add a New IDE Adapter" lists `schema.ts` as a required file (CLAUDE.md:288); `docs/adapter-development-guide.md:178,215` walks through implementing `schema.ts` and importing `exampleSchema`. The field and file no longer exist (ADR-0041). A contributor following the guide writes a file that is never loaded and never referenced.
- CLAUDE.md repeatedly asserts the "6-file pattern" as the architecture's spine; the real layout is a 5-file core + optional add-ons. The audit prompt itself inherited this false premise.

**Recommendation:** Rewrite the adapter-authoring guide and CLAUDE.md's adapter section to the actual 5-file shape (index/detect/import/export/diff) plus the optional `identity.ts`/`session.ts`/`marketplace.ts`/format-helper files. Delete every `schema.ts` mention.

### 3.2 HIGH — Shared instruction generators exist, are unit-tested, and are dead

`src/core/instructions.ts` exports `generateCursorMdc` (line 213), `generateWindsurfRule` (line 258), `generateCopilotInstruction` (line 276), and `generateKiroSteering` (line 307). **None of the four is called anywhere in `src/`** — only by `test/core/instructions.test.ts`. Meanwhile:

- `cursor/export.ts:159-182` reimplements `.mdc` generation inline (`generateMdc`).
- `windsurf/export.ts:127-184` reimplements rule-file + trigger-mapping logic inline (`scopeToTrigger`, `generateRuleFiles`).
- copilot and kiro adapters likewise hand-roll their instruction output.

So the project already wrote the de-duplicated version, tested it, then shipped the duplicated version anyway. This is half-finished refactoring: it inflates maintenance surface (a bug fix in `.mdc` frontmatter must land in two places) and presents tested-but-unreachable code that will rot.

**Recommendation:** Wire the adapters to the shared generators (or delete the dead exports and stop testing them). Pick one source of truth per format.

### 3.3 HIGH — Every adapter rolls its own `generateMcp*` and file-write loop

There are nine distinct `generateMcp{Json,Config,Settings}` functions (`amazon-q/export.ts:57`, `claude-code/export.ts:150`, `cline/export.ts:58`, `copilot/export.ts:146`, `cursor/export.ts:94`, `forgecode/export.ts:107`, `kiro/export.ts:86`, `roo-code/export.ts:89`, `windsurf/export.ts:90`), each independently:
- reading the existing JSON file and merging `{...existing, mcpServers}`,
- partitioning stdio vs URL servers,
- passing through adapter-specific extras while skipping `scope`/`url`/`headers`.

Identically, all 13 `export.ts` files contain the same `if (!options.dryRun) { for (const file of files) { mkdirSync; atomicWriteFileSync; file.written = true } catch { warnings.push(...) } }` loop (e.g. `cursor/export.ts:74-88`, `windsurf/export.ts:70-84`). `shared/utils.ts` has `compareServerFields` and `spliceMarkerBlock` but **no** `buildMcpServersObject` or `writeFiles` helper — the two most-duplicated operations in the layer are the ones with no shared abstraction.

**Recommendation:** Add `shared/export-utils.ts` with `buildMcpServersJson(servers, existingPath, opts)` and `writeExportFiles(files, {dryRun})`. This removes ~30-50 duplicated lines per adapter and makes adapter #14 a half-page file.

### 3.4 MEDIUM — Diff coverage is inconsistent across adapters

`compareServerFields` (server drift) is adopted broadly, but `compareInstructions` from `shared/diff-utils.ts` is imported by only **3** adapters (`claude-code/diff.ts`, `cursor/diff.ts`, `kilo-code/diff.ts`). The header comment of `diff-utils.ts:4-7` openly states the other 10 adapters "only detected server drift" and this was meant to be added "incrementally." That increment never completed. Result: `am apply --diff` will report "in-sync" for, say, gemini-cli even when the user hand-edited `GEMINI.md` instructions, because that adapter's `diff()` never inspects instruction content. This silently undermines the drift-gating safety in `controller.ts:277-308` for most tools.

**Recommendation:** Either finish instruction/skill/agent diff for all adapters or document the partial coverage explicitly and downgrade the drift gate's promises.

### 3.5 MEDIUM — `apply` writes to global home-dir paths for every installed tool, gated only at adapter granularity

`cursor/export.ts:48-52` writes `~/.cursor/mcp.json` whenever any global server exists; `windsurf/export.ts:33-36` unconditionally writes `~/.codeium/windsurf/mcp_config.json`. Detection (`getDetectedAdapters` → `detect()`) gates the whole adapter, but once an adapter is "detected" (often just because `~/.cursor/` exists), a plain `am apply` mutates global config files across every installed AI tool on the machine. For a first-run user who installed `am` to try it, this is a surprising blast radius with no per-target confirmation. A wizard must make this explicit.

### 3.6 LOW — Detection spawns external CLIs synchronously during every `apply`

7 adapters' `detect.ts` shell out via `Bun.spawnSync` for a version string (`claude-code, codex-cli, cursor, forgecode, gemini-cli, kilo-code, kiro`; e.g. `cursor/detect.ts:64`). `getDetectedAdapters()` runs detect on all 13 serially (`registry.ts:126-134`), so a no-op `am apply` pays N synchronous process spawns. Version is cosmetic; gate it behind `--verbose` or make it lazy.

### 3.7 LOW — Community checksum pins only the entrypoint file

`computeChecksum` (`commands/adapter.ts:567-571`) and `verifyChecksum` (`community/loader.ts:66-82`) hash only `config.command` (the bin entry). For an npm/git adapter whose entry `require()`s files in `node_modules`, tampering with a dependency after install is not detected. The threat model in ADR-0027 implies content integrity; the implementation pins one file. Worth documenting as a known limitation or hashing the install tree.

### 3.8 LOW — Placeholder versions and unused `version` plumbing

All 13 adapters report `meta.version: "0.1.0"` (uniform placeholder). The community `InitializeResult` type carries `adapterVersion` (`community/types.ts:57-60`) but the proxy ignores it and reads version from `adapter/meta` instead (`proxy.ts:175`). Minor, but it signals the versioning story was never thought through — there is no `minAmVersion` enforcement in `loader.ts` despite ADR-0027 promising it (the manifest type has the field at `types.ts:28`, nothing checks it).

---

## 4. Is adding a 14th adapter genuinely easy?

**Mostly yes, with caveats.** The mechanics are light: create a directory, implement 5 methods, add one factory line to `registry.ts:21-74`. The interface is small and the existing adapters are good copy-paste templates. ADR-0011's "PR → release" model is honest about the tradeoff.

**But** the on-ramp is sabotaged by:
- a wrong authoring guide that tells you to write a non-existent `schema.ts` (§3.1);
- no shared helper for the two things every adapter actually does (build the MCP JSON, write the files — §3.3), so "easy" means "copy 200 lines from cursor/export.ts and tweak";
- existing-but-dead shared generators (§3.2) that a careful author would (correctly) try to use and find unwired, leaving them unsure which path is canonical.

Net: a 14th adapter is ~250 lines of mostly-duplicated code today. It could be ~80 lines if the shared layer were finished.

---

## 5. Platform adapters (brief)

Three tiny adapters: `github.ts` (95 LOC), `gitlab.ts` (99), `bare.ts` (10), with a 20-line ordered registry (`platforms/registry.ts`). This is appropriately minimal and clean — detection by URL specificity, GitHub > GitLab > bare. No concerns; not a wizard risk. The asymmetry with IDE adapters (these have no import/export/diff) is correct — different problem.

---

## 6. Wizard implications

A first-run wizard built on this layer can lean on real primitives — `getDetectedAdapters()` already enumerates installed tools, `detect()` returns config paths, and `apply --dry-run --json` (`apply.ts:189-226`, ADR-0038 envelope) produces a clean preview of exactly which files would be written. That is a solid foundation.

What the wizard must add that does not exist today:
1. **Explicit per-target opt-in before writing global files.** Today `am apply` fans out to every detected tool's home-dir config (§3.5). The wizard must show the file list and let the user check/uncheck targets — the dry-run JSON gives it the data, but no interactive selection surface exists.
2. **Surface the auto-detection result honestly.** Detection is pure file-presence (e.g. `~/.cursor/` exists ⇒ "Cursor installed"), which over-reports. The wizard should distinguish "config dir exists" from "tool actually present" and let the user correct it.
3. **Explain the community-adapter boundary.** Community adapters never auto-apply (`registry.ts:127`); a wizard that lists "available adapters" must not imply parity with built-ins.
4. **Not rely on the docs.** Any wizard copy generated from the authoring guide will reference `schema.ts` and mislead. Fix §3.1 first.

---

## 7. Verdict

The adapter **architecture** is sound: a clean serializable interface, a correct lazy registry, a genuinely well-secured community subprocess model, and strong tests. The **implementation discipline** has drifted: a shared-utility layer was started, tested, and left half-wired, so the codebase carries both the deduplicated and the duplicated versions of instruction generation, plus per-adapter copy-paste of MCP-JSON building and file-writing. None of this blocks shipping, but it inflates the cost of every future adapter and the docs actively mislead new contributors. This is **refactor-in-place**, not rearchitect: finish the shared layer, wire the dead generators or delete them, fix the authoring docs.
