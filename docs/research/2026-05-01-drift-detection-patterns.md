# Drift Detection Patterns Across Config-as-Code Tools

**Date:** 2026-05-01
**Author:** research agent
**Status:** research — input to design, not a decision yet
**Scope:** how chezmoi / home-manager / ansible / terraform model "declared state vs reality", what that implies for agent-manager's 13 heterogeneous IDE adapters, and a concrete layering proposal.

> **Sandbox caveat.** External research tools (tavily, exa, deepwiki, WebFetch)
> were all denied permission in the environment this doc was produced in, so the
> analysis of upstream tools below is written from model training knowledge plus
> the locally-available ADR references (notably ADR-0006, which already cites
> chezmoi's "diff before apply" pattern). Specific behaviors that would need a
> citation before a decision record cites them are tagged **\[unverified\]**.
> The *grounded* portion of this doc — current agent-manager adapter shape and
> the recommended layering — is drawn directly from
> `src/adapters/types.ts`, `src/adapters/shared/{utils,diff-utils}.ts`, and
> `src/adapters/{claude-code,cursor}/diff.ts`, which were read directly.

---

## 1. Prior art

### 1.1 chezmoi — diff = render + byte-compare **\[unverified — training knowledge\]**

chezmoi is a dotfile manager. Its mental model:

- **Source state** = the repo (`~/.local/share/chezmoi`). Template-driven: raw
  files, `dot_*` renames, `.tmpl` Go templates, `encrypted_*` secrets.
- **Target state** = what the source state *would produce* after rendering
  templates, applying renames, decrypting secrets, running `modify_` scripts.
- **Destination state** = what is actually on disk in `$HOME`.
- **`chezmoi diff`** renders the target state into a virtual filesystem,
  then performs a plain `diff -u` against the destination state. Modes
  supported: plain unified diff, `json`, or an external `diff.pager`/
  `diff.command`.
- **`chezmoi status`** outputs a two-character code per entry in a style
  modeled on `git status` (`M`, `A`, `D`, `R`). The first column is
  "target vs last-applied" (what chezmoi intends to do); the second is
  "destination vs last-applied" (what the user has changed underneath).
- **Abstraction:** a single `Entry` interface (file / directory / symlink /
  script) that produces bytes. Everything downstream of "produce bytes" is
  format-agnostic. There is **no semantic parsing of YAML/JSON/TOML** — a
  reformatted JSON file *will* show up as drift.

**Takeaway for us:** chezmoi gets away with byte-level because the user
*owns* both ends (their repo, their dotfiles). There is no third-party
tool mutating the destination. Agent-manager cannot make that assumption
— Claude Code, Cursor, etc. will re-serialize `~/.claude.json` whenever
they write to it, changing key order and whitespace.

### 1.2 Nix / home-manager — activation, not drift **\[unverified\]**

home-manager's model is closer to immutable infrastructure than to drift
detection:

- Each build produces a **generation** in `/nix/store` — an immutable
  closure of every managed file.
- **Activation** links `~/.config/foo` (and friends) to store paths.
  Files home-manager manages are **symlinks into `/nix/store`**, so
  "editing the managed file" fails at the filesystem level (the store
  path is read-only).
- Collisions with pre-existing real files are a **hard error** unless
  `home-manager.backupFileExtension` is set; then the existing file is
  renamed to `foo.backup` and the symlink is placed.
- `home-manager generations` lists past generations; `nix store diff-closures`
  shows what changed between them — but this is a diff of *declared*
  state across versions, not declared-vs-reality.
- `home-manager build` produces an out-of-tree result symlink; the user
  can inspect the closure, but there is no `home-manager diff-reality`.

**Takeaway:** home-manager sidesteps drift by making the destination
physically immutable. Agent-manager *cannot* do this — Cursor writing to
its own `mcp.json` is a legitimate and desirable workflow. ADR-0006
already rejects the overwrite model for this reason.

### 1.3 Ansible — per-module idempotency, `changed_when` **\[unverified\]**

Ansible does not have a single drift engine. Drift is a per-module
contract:

- Each module computes a **before-state** (reads the current file / queries
  the remote) and a **desired-state** (from task args), then decides
  `changed: true/false`.
- **`--check` (check mode)** tells modules to compute the would-be change
  *without applying it*; modules that cannot safely simulate set
  `supports_check_mode: False`. Structured-config modules
  (`ini_file`, `lineinfile`, `community.general.ini_file`,
  `ansible.builtin.template` with `diff=yes`) all implement check mode.
- **Structured modules parse-then-compare.** `ini_file` reads the section,
  mutates it in memory via `configparser`, and compares serialized bytes
  before deciding `changed`. `community.general.json_patch` applies a
  JSON-patch and semantic-compares the resulting tree.
- **`lineinfile` is line-level.** It regex-matches against destination
  lines — if the user reformats the file (re-indent, quote style), it
  does not notice.
- **`template`** renders the Jinja template and diffs rendered bytes against
  the destination, similar to chezmoi.
- The universally-used correctness test is: "run the playbook twice; the
  second run MUST report `changed=0`." This is the idempotency oracle —
  if a module can't satisfy it, its diff logic is buggy.

**Takeaway:** the "run twice → zero changes" oracle is cheap and powerful.
Agent-manager can adopt it as a test contract: "after `am apply`, the
next `am status` must report in-sync for every adapter."

### 1.4 Terraform / OpenTofu — typed state + `DiffSuppressFunc` **\[unverified\]**

Terraform has the most mature drift story because resources are *typed*:

- The state file stores a structured representation of every resource at
  last-apply.
- `terraform refresh` (now folded into `plan`) re-reads each resource from
  its provider and updates the state.
- `terraform plan` computes a diff between the resolved configuration
  (after interpolation) and the refreshed state, per-resource, per-attribute.
- **`DiffSuppressFunc(k, old, new, d)`** — a per-attribute hook that
  providers implement to declare "these two values are semantically
  equivalent, don't show a diff." Canonical use cases:
  - `aws_iam_policy_document` normalizes JSON (key order, whitespace)
    and compares ASTs.
  - `aws_lambda_function.environment` elides empty maps vs nil.
  - Case-insensitive ARNs, trailing slashes on URLs, etc.
- **`CustomizeDiff`** — a whole-resource hook for cross-attribute drift
  rules that cannot be expressed per-field.
- **Structural schema + normalization.** Providers own the Zod-equivalent
  schema of each resource; drift is diffed in the *parsed* domain, then
  rendered back for user display.

**Takeaway (most important for us):** the right layering is *parse →
normalize → compare in parsed domain → render for display*. The
per-attribute normalization hook is the piece agent-manager is missing.
Our current `compareServerFields` in `src/adapters/shared/utils.ts` is
the embryonic version of this — it already handles "missing args array
== empty args array" and deep-sorts objects before JSON-stringify.

### 1.5 Puppet / Chef — resource abstraction parallel **\[unverified\]**

Both use the same pattern as Terraform: a `Resource`/`Provider` abstraction
where each resource type defines `retrieve` (read current state),
`insync?` (compare), and `sync` (write). `insync?` is the per-property
normalization hook — Puppet explicitly warns against using `==` in it
because of whitespace/ordering hazards.

### 1.6 Prior art for agent-manager's exact niche — multi-IDE config sync

There is **no mature public prior art** for "one source of truth across
many AI coding tools". The closest analogues:

- **Roo Code / Cline** ship their own MCP settings UI but do not sync to
  other tools. They are *consumers* of config, not cross-tool sync.
- **Workspace managers** (VSCode settings sync, JetBrains settings
  sync) unify one vendor's own tools — not heterogeneous vendors.
- **MCP Registry** (modelcontextprotocol.io) is a package index, not a
  drift detector.

Agent-manager is **effectively pioneering this pattern** — which means
the design choices here will end up being copied by any tool that
follows. Getting the abstraction right matters more than getting every
adapter's detail right on day one.

---

## 2. The semantic-vs-textual tradeoff

| dimension | textual (byte/line diff) | semantic (parse + compare AST) |
|---|---|---|
| implementation cost | trivial | per-format parser + normalizer |
| false positives from reformat | many (key reorder, quotes, indent) | none |
| false negatives from equivalent forms | few | possible if normalizer is incomplete |
| can display diff to user | native (unified diff) | needs a renderer |
| handles partial files (managed block inside user-owned file) | only with markers | native (just compare the managed subtree) |
| encrypted / binary | only "same hash or not" | same |
| works when downstream tool rewrites on save | **broken** (tool re-orders keys) | works |

The third-from-bottom row is the decisive one for agent-manager: **every
one of our 13 target tools rewrites its own config on save**, usually
reordering keys and changing whitespace. Textual comparison of
`~/.claude.json` will show drift every time Claude Code is opened, even
if nothing meaningfully changed. This is why `compareServerFields`
already JSON-stringifies sorted-key normalized forms — it's doing
semantic comparison, just ad-hoc.

The corollary: **managed instruction blocks** (markdown wrapped in
`<!-- am:begin -->` / `<!-- am:end -->`) *can* be textually compared
because the wrapping file format is markdown, which is not auto-rewritten
by the IDE. The current `compareInstructions` in `shared/diff-utils.ts`
does exactly this — `nativeBlock.trim() !== expectedBlock.trim()`.
That's correct.

---

## 3. Current agent-manager state (grounded read)

From the codebase:

### 3.1 What exists

- **Typed diff model:** `DiffChange` with
  `entity: "server" | "instruction" | "skill" | "agent" | "setting"`,
  `type: "added-locally" | "removed-locally" | "modified" | "added-in-config"`
  (`src/adapters/types.ts:97-102`).
- **Server drift (all 13 adapters):** read native JSON → compare via
  `compareServerFields` → emit per-field `details`. Normalization handled
  (sort keys, default empty args/env, HTTP-vs-stdio discrimination).
- **Instruction drift (partial):**
  - Marker-based adapters (Claude Code, Codex, Gemini) use the shared
    `compareInstructions` helper — extract managed block, trim, compare.
  - Per-file adapters (Cursor `.mdc`, Windsurf, etc.) open inline in
    each adapter's `diff.ts` with a `nativeContent.includes(expected)`
    substring check — **this is fragile** (partial match, case-sensitive,
    no field-level diff output).
- **Skill drift:** not implemented anywhere.
- **Agent drift:** not implemented anywhere.
- **Settings drift:** `DiffChange.entity` has `"setting"` but no adapter
  emits it.

### 3.2 Gaps

1. Instruction drift is done inline-per-adapter for per-file formats; no
   shared helper exists for that shape.
2. Skills and agents have resolved types (`ResolvedSkill`, `ResolvedAgent`)
   but no diff helpers at all.
3. No contract forces an adapter to implement diff for every capability
   it declares — an adapter can claim `capabilities: ["skills"]` and emit
   nothing.
4. `DiffChange.details` is ad-hoc — each adapter hand-rolls which fields
   to emit, with no schema. Roundtrip (`am status --json` → machine
   consumer) has no stable contract.
5. No equivalent of Terraform's `DiffSuppressFunc` — if, say, Cursor
   re-formats `mcp.json` and inserts a `"_version": "2"` key, we will
   false-positive.

---

## 4. Recommended architecture for uniform drift

### 4.1 Layer the work: entity-type × transport, not adapter × adapter

Today, each of 13 adapters implements `diff()` directly. That's
13 × (servers + instructions + skills + agents) = 52 bespoke code paths.
Most of those paths are *nearly identical* — they differ by:

- **Transport:** where to read the native state from (global JSON /
  project JSON / `.mdc` file / VS Code globalStorage / .claude.json with
  project-keyed nesting / ...).
- **Entity type:** what semantic comparison to run once loaded.

The right factoring is **transport × entity-type**:

```
┌─────────────────────────────────────────────────┐
│ per-adapter diff.ts: ~30 lines, declarative     │
│   "use readJsonMap() at path X for servers"     │
│   "use readMarkedFile() at path Y for CLAUDE.md"│
│   "use readDirOfFiles() at dir Z for skills"    │
└───────────┬─────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────┐
│ shared transports (src/adapters/shared/)        │
│   readJsonMap(path, keyPath)                    │
│   readMarkedFile(path, beginMarker, endMarker)  │
│   readDirOfFiles(dir, pattern, keyFrom)         │
│   readYamlMap(path, keyPath)                    │
└───────────┬─────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────┐
│ shared comparators (src/adapters/shared/)       │
│   compareServer(expected, native, suppressors)  │
│   compareInstruction(expected, nativeContent)   │
│   compareSkill(expected, nativeDir)             │
│   compareAgent(expected, nativeAgent)           │
└─────────────────────────────────────────────────┘
```

With that factoring, a new adapter implements its diff by declaring
which transport reads which entity from which path — not by rewriting
the comparison logic.

### 4.2 Adopt `DiffSuppressFunc`-style normalization hooks

Add to `shared/utils.ts`:

```ts
type Suppressor = (expected: unknown, actual: unknown) => boolean;

const defaultSuppressors: Record<string, Suppressor> = {
  // Treat missing and empty-array as equal
  "args": (e, a) => JSON.stringify(e ?? []) === JSON.stringify(a ?? []),
  // Treat missing and empty-map as equal (env, adapterExtras)
  "env":  (e, a) => JSON.stringify(e ?? {}) === JSON.stringify(a ?? {}),
  // ${VAR} interpolation — accept "${FOO}" ≡ ""  in native if FOO unset
  // (agent-manager-specific)
  "env.*": …
};
```

Each adapter can extend with its own suppressors:

```ts
// cursor/diff.ts
import { diffWithSuppressors } from "../shared/diff-utils.ts";
const cursorSuppressors = {
  ...defaultSuppressors,
  // Cursor re-serializes with tab indent — ignore whitespace differences
  //  inside .mdc frontmatter
  "instruction.frontmatter": whitespaceInsensitive,
};
```

This directly mirrors Terraform's per-provider suppressor registry.

### 4.3 Capability-to-diff contract

Extend `Adapter.meta.capabilities` enforcement: if an adapter declares
`"skills"`, the registry demands its `diff()` emits `entity: "skill"`
DiffChange rows (or explicitly `{ status: "unmanaged" }` if skills
happen to be absent). Enforce with a test in
`test/adapters/contract.test.ts` that instantiates every adapter against
a fixture with all four entity kinds populated and asserts each capability
surfaces at least one change when reality diverges.

This is the same discipline Ansible enforces with `supports_check_mode`
declarations.

### 4.4 The "run twice" oracle (Ansible's idempotency test)

Add an integration test:

```ts
// test/integration/idempotency.test.ts
for (const adapterName of adapters) {
  test(`${adapterName}: am apply → am status reports in-sync`, async () => {
    await apply({ adapter: adapterName });
    const diff = await status({ adapter: adapterName });
    expect(diff.status).toBe("in-sync");
    expect(diff.changes).toHaveLength(0);
  });
}
```

If this fails for any adapter, either (a) `export` is non-deterministic
(writes a timestamp, say), or (b) `diff` is over-sensitive (false
positive on the adapter's own output). Both are bugs and both are worth
catching automatically.

### 4.5 Three-way awareness (chezmoi pattern)

chezmoi's status code has *two* columns — target-vs-last-applied and
destination-vs-last-applied. Agent-manager currently has one: resolved
config vs destination. The third leg ("what `am apply` last wrote") is
implicit in git (config.toml's last-apply commit), but we never compute it.

Adding it enables a crucial UX: distinguishing "user edited the IDE
config" (needs `am import`) from "user edited config.toml" (needs
`am apply`). Right now both show up as drift with identical copy.

Proposal:

- Store a **last-apply snapshot** per adapter in
  `.agent-manager/state/last-apply/<adapter>.json` (gitignored, machine-
  specific).
- `am status` computes three-way: resolved, snapshot, destination.
  - resolved ≠ snapshot, destination = snapshot → user edited config.toml;
    propose `am apply`.
  - resolved = snapshot, destination ≠ snapshot → user edited IDE;
    propose `am import`.
  - all three differ → conflict; propose interactive resolution
    (ADR-0028's brownfield merge logic already handles this case).

### 4.6 Semantic vs textual — the decision rule

| entity | file format | recommended diff strategy |
|---|---|---|
| server (MCP) | JSON map | **semantic** — parse, normalize keys, compare fields with suppressors |
| instruction (marker block) | Markdown with `am:begin`/`am:end` | **textual inside the block**, ignoring leading/trailing whitespace |
| instruction (per-file, `.mdc` / `.md`) | Markdown with YAML frontmatter | **two-phase:** parse frontmatter (semantic), compare body (textual trim) |
| skill | directory of files | **hash per file** + directory-tree structural comparison; treat binary identically |
| agent | TOML/YAML/JSON fragment | **semantic** — same as servers |
| settings | JSON/YAML map | **semantic** — same as servers |

Rationale: use semantic for anything the IDE will re-serialize; use
textual for anything the IDE treats as opaque content (markdown bodies,
skill script bodies).

---

## 5. Specific recommendations

**1. Extract a `DiffStrategy` type and wire all 13 adapters through it.**

```ts
interface DiffStrategy<Entity, Native> {
  load(paths: AdapterPaths): Native | null;
  enumerate(native: Native): Record<string, unknown>;
  compareOne(expected: Entity, actualRaw: unknown): FieldDiff[];
  suppressors?: Record<string, Suppressor>;
}
```

Move `readJsonFile` + `compareServerFields` into a `jsonMapStrategy`.
Move `compareInstructions` into a `markerBlockStrategy`. Add new
`perFileInstructionStrategy` (for Cursor/Windsurf), `skillDirStrategy`,
`agentFileStrategy`. Register per-adapter strategy bindings declaratively.

**2. Promote `DiffChange.details` from free-form to typed.**

Today `details: { field: string; expected: unknown; actual: unknown }[]`
— field names are strings chosen per-adapter. Make field a union type
(or at minimum, a namespaced convention: `server.command`, `server.args`,
`instruction.frontmatter.globs`) so the JSON output is stable for
machine consumers (web UI, MCP tools, `am_status`).

**3. Add the three-way model (last-apply snapshot).**

Detailed in §4.5. This is the highest-leverage change because it
eliminates the "which side do I run?" UX confusion that blocks users
today.

**4. Add the idempotency contract test.**

Detailed in §4.4. Catches entire classes of drift-detection bugs
automatically and gives adapter authors a cheap fitness function.

**5. Write a follow-up ADR ("Drift Detection Architecture: Per-Entity
Shared Strategies").**

ADR-0006 defines the *policy* (don't overwrite, surface drift); the new
ADR should define the *architecture* (strategies, suppressors,
three-way, idempotency oracle). Reference this research doc.

---

## 6. Open questions — flag before decision

- **Where do skill hashes live?** If we hash a skill directory, we need
  somewhere to store the expected hash. Options: derive on every diff
  (cheap; just recomputes), or cache per-apply in the last-apply snapshot
  (faster; requires snapshot invalidation rules).
- **Cross-adapter skill drift.** A skill in agent-manager may export to
  multiple adapters. If one adapter has it and another doesn't, is that
  drift for all four, for three, or just for one? Needs product decision.
- **How far to go with suppressors before a DSL?** Terraform's
  `DiffSuppressFunc` is arbitrary Go. We should avoid arbitrary TS for
  config-loaded suppressors (sandboxing cost). For built-in adapters,
  inline TS is fine.
- **Do we want a rendered unified-diff view?** Today `details` is
  structural. A `--format=unified` option that renders a conventional
  `+/-` diff for human consumption would be valuable for `am status`
  and especially for the web UI.

---

## 7. Sources (intended — unable to fetch in this run)

Would have wanted to cite, and should be pulled before an ADR lands:

- chezmoi docs: `chezmoi.io/reference/commands/diff/`,
  `chezmoi.io/reference/commands/status/`, `chezmoi.io/reference/target-types/`
- home-manager manual: `nix-community.github.io/home-manager` —
  activation and `backupFileExtension` sections
- Ansible docs: Check Mode ("Dry Run"), module development guide
  (`conventions.rst`, "Return values and changed"), `ini_file`,
  `lineinfile`, `template` source
- Terraform SDK: `developer.hashicorp.com/terraform/plugin/sdkv2/schemas/schema-behaviors`,
  `CustomizeDiff` guide, provider codebases for real-world normalizers
  (`terraform-provider-aws/internal/verify` for
  `SuppressEquivalentJSONDiffs`, etc.)
- Puppet: `Puppet::Type#insync?` documentation
- ADR-0006 (already cited) and `docs/research/02-git-as-backend-patterns.md`
  (referenced but not present in repo — worth locating)

---

## 8. TL;DR

1. **Layer by transport × entity-type, not by adapter.** 13 adapters × 4
   entity types should not be 52 bespoke code paths. Factor into a small
   set of shared `DiffStrategy` implementations + per-adapter declarative
   bindings.
2. **Use semantic (parse + normalized compare) for anything the IDE
   re-serializes; use textual for opaque content.** Add
   `DiffSuppressFunc`-style per-attribute normalization hooks for JSON
   edge cases (key order, empty vs missing, `${VAR}` interpolation).
3. **Make the model three-way (ADR-0006 is currently two-way).** Store a
   last-apply snapshot so `am status` can tell "user edited config.toml"
   from "user edited the IDE" — the difference determines whether to
   suggest `am apply` or `am import`. Pair with an Ansible-style "apply
   then status must be clean" idempotency test run against every adapter.
