# Prior Art: "Superset Invariant Enforcement" for MCP Config

**Date:** 2026-05-03
**Author:** research agent
**Status:** research — input to design of `am mcp superset check|apply` (GitHub issue #3), not a decision yet
**Scope:** How chezmoi, kustomize, terraform, helm, and ansible handle the
"declared-subset-must-be-contained-in-target" invariant, the three-way copy
classification (verbatim / transform / refuse), the security-refusal UX, and
machine-readable output contracts. Recommendations for the `am mcp superset`
command shape, verb terminology, and JSON schema.

> **Sandbox caveat.** External research tools (tavily, exa, context7, WebFetch)
> were all denied permission in the environment this doc was produced in, so
> the analysis below is written from model training knowledge plus
> [`2026-05-01-drift-detection-patterns.md`](./2026-05-01-drift-detection-patterns.md)
> which covered the neighbouring "drift" question. Specific claims that
> would need citation before a decision record cites them are tagged
> **\[unverified\]**. Recommendations anchored to the agent-manager codebase
> and to issue #3 are ungrounded-free.

> **Relationship to prior research.** The 2026-05-01 drift-patterns doc asked:
> *how do other tools detect that declared ≠ reality?* This doc asks the
> sister question: *how do other tools enforce that one declaration must be
> a subset of another, and what do they do when a required copy is
> security-unsafe?* The drift research found that semantic (parse + normalize +
> compare) wins over textual; this research finds the same, plus a distinctive
> "refuse" third classification that none of the drift tools surface because
> they never encounter the embedded-credential hazard.

---

## 1. Problem recap (from issue #3)

Global MCP catalog (`~/.claude.json`.`mcpServers`) must be a **subset** of the
project catalog (`.mcp.json`.`mcpServers`). Today violations are silent; the
user discovers them by trying to call an MCP tool and finding it absent.
Three copy classes are needed:

| Source shape                                      | Expected behaviour                                |
|---|---|
| stdio with `command`                              | copy verbatim                                     |
| HTTP with `Authorization: Bearer ${VAR}` in env   | copy verbatim (env is the credential boundary)   |
| HTTP with URL-embedded credential (`?apiKey=…`)   | **refuse**; suggest `${VAR}` rotation             |
| `disabled: true` in global                        | skip (not a superset requirement)                 |

Target: `am mcp superset check` (audit, nonzero exit on strict) and
`am mcp superset apply` (reconcile, writing to project with redaction).

---

## 2. Prior art by tool

### 2.1 chezmoi — `diff`, `verify`, `status` trio **\[unverified\]**

chezmoi's whole job is "source of truth here, render into target there, tell
me when they diverge." Its UX has three commands for three audiences:

- **`chezmoi diff`** — human-facing, renders target state into a virtual
  filesystem, then emits a plain unified diff vs destination. Supports
  `--format=json` as an alternative output. The UX convention: *show what
  `apply` would change*, in terms the user already understands from `git diff`.
- **`chezmoi verify`** — machine-facing, produces **no output** on success
  and exits **0**; on divergence, exits **1** (and suppresses diff body
  unless `-v`). This is the "CI gate" command. The deliberate silence on the
  happy path is the key UX property — consumers grep for exit code, not
  output.
- **`chezmoi status`** — a two-column status code per entry, style-modeled on
  `git status`: first column is *"source-of-truth vs last-applied"* (what
  chezmoi intends to do), second is *"destination vs last-applied"* (what the
  user has changed underneath). `M`, `A`, `D`, `R` for modified / added /
  deleted / script-to-run.

Key design lesson for `am mcp superset`:

1. **Split "audit" from "preview"** — `check` (CI-focused, quiet) and a
   separate verbose preview mode, rather than one command with a `--quiet`
   switch that users forget to set. Matches issue #3's `check --strict`
   suggestion.
2. **Exit-code protocol is the contract.** `0` = superset satisfied. `1` =
   drift. `2` = refusal (URL credential) — *distinguish from drift* so CI can
   route security findings differently. chezmoi uses `0/1`; we need a third
   code because we have a third class. Precedent: `grep` uses `0/1/2`,
   `rsync` uses distinct numeric families per error class.
3. **`--format=json` is additive, not replacement.** chezmoi keeps human diff
   as default, exposes JSON for machine consumers. Mirror this: default is
   human-readable per-server table; `--json` emits the schema in §5.

### 2.2 kustomize — strategic merge patch and list semantics **\[unverified\]**

Kustomize's `patchesStrategicMerge` inherits Kubernetes strategic-merge-patch
(SMP) rules, which are the most thought-through "how should a smaller doc merge
into a larger one" semantics in public tooling. The three list-merge strategies:

| Strategy                       | Activation                                 | Semantics                                     |
|---|---|---|
| **Replace**                    | `$patch: replace` directive on the list   | incoming list fully replaces target list       |
| **Merge by primary key**       | schema declares `x-kubernetes-patch-merge-key: "name"` | items matched by key; per-item merge   |
| **Positional replace** (default for untyped lists) | no declaration                    | entire list replaced (safest default)  |
| **Merge with delete**          | `$patch: delete` on matched item          | item removed from merged result                |

The important principle: **lists need a key function to merge semantically**;
without one, positional merge is unsafe because reordering breaks everything.
Kubernetes solved this by annotating every list in every resource schema with
its natural key (`name` for containers, `containerPort` for ports, etc.).

For `mcpServers`: the source documents (`~/.claude.json`, `.mcp.json`) are
**objects keyed by server name**, not arrays — so the merge key is trivially
the object key. This means `mcp superset` uses the **merge-by-key** strategy
implicitly: for each `key` in global, merge into project under the same key.

Key design lesson:

1. **Merge-by-object-key is the right model for MCP.** We never face the
   "is this list positional or keyed?" question because the data model is
   already a map. Don't accidentally introduce an array intermediate.
2. **Per-entry `$patch` directives have value.** A project can legitimately
   want to *override* a global server (not just receive it). Consider a
   future `"_superset": "override"` or `"_superset": "skip"` marker in the
   project TOML letting users opt out of a specific server's mirroring
   without disabling it globally. Not in the MVP, but the kustomize precedent
   says: if users will want per-entry overrides eventually, design the data
   model so they can be expressed, even if the command doesn't emit them yet.
3. **Declared merge semantics beat implicit ones.** Kubernetes documents
   merge behavior per-field in the OpenAPI schema. We should document the
   three copy classes in our Zod schema or at least in a top-of-file constant,
   not bury them in the command handler.

### 2.3 terraform — `plan` as the UX archetype, sensitive-value redaction **\[unverified\]**

Terraform's `plan` is the canonical "here's what `apply` would do, confirm
before I do it" UX. Three properties worth copying:

- **Tri-state summary line**: `Plan: N to add, M to change, K to destroy.`
  Human-scannable; CI-parseable. For `mcp superset`:
  `Plan: N to add, M to skip (disabled), K to refuse (URL-credential).`
- **`sensitive = true` attribute redaction.** Terraform marks values as
  sensitive in the schema; when the value appears in a `plan` diff, it's
  rendered as `(sensitive value)`. The value *is still compared* semantically
  — what's suppressed is the *display*. This is the model for how the
  superset preview should render HTTP-with-Authorization-env-var servers:
  don't print the `${TAVILY_API_KEY}` literal in the preview, just say "env
  `TAVILY_API_KEY` (sensitive)".
- **`terraform plan -out=planfile`** separates *what would happen* from
  *actually doing it*. `am mcp superset check --out=plan.json` →
  `am mcp superset apply --plan=plan.json` mirrors this pattern if we need
  it for high-stakes environments. Not day-1, but the shape should permit it.

**Refusal UX:** Terraform doesn't refuse writes on security grounds per se;
it has `precondition` / `postcondition` blocks (v1.2+) where a user-defined
check can fail a plan with an error message. The operator sees the error,
decides to fix the input or override. The pattern — **explicit failure with
actionable message, no silent skip** — is what we want for URL-credentials.

### 2.4 helm — three-way merge and `helm diff` plugin **\[unverified\]**

Helm's upgrade path is a genuine **three-way merge**: `old-manifest` vs
`new-manifest` vs `live-state`. The UX lesson is different from chezmoi's
two-column status:

- `helm diff upgrade` (community plugin, widely used) shows `+` / `-` lines
  in a `diff -u` format, grouped by resource kind and name.
- `helm template` renders what would be applied, without touching the cluster.
  The `check` / `preview` separation from chezmoi.
- Helm *does not* refuse to install on security grounds; this is a gap in its
  UX that the `helm-secrets` plugin patches. The fact that a plugin was
  needed suggests: **making "refuse on secrets" a first-class command is a
  better design than bolting it on.**

### 2.5 ansible — `--check` mode and `changed_when` **\[unverified\]**

- `ansible-playbook --check` runs tasks in simulation: modules compute the
  would-be state change without applying it. Output format is identical to
  normal run; CI distinguishes by exit code.
- `ansible-playbook --check --diff` adds unified-diff output per changed
  file — equivalent to our "verbose preview."
- **Strict idempotency oracle**: "run twice; second run must report
  `changed=0`." Usable here: `am mcp superset apply` followed by
  `am mcp superset check --strict` must exit 0.
- Ansible has **no first-class refusal for URL-embedded credentials** — it
  has secret management (`ansible-vault`) for the *input* side, not
  detection on the output side. This confirms: the refusal class is
  distinctive to config tools dealing with third-party APIs that have
  normalized-on-URL-tokens as an anti-pattern. chezmoi, helm, ansible,
  terraform all lack it.

### 2.6 dotfiles managers (stow, yadm, rcm) **\[unverified\]**

`stow` and `rcm` are pure symlink managers — no parse, no drift detection,
no refusal logic. Not relevant prior art for superset enforcement *except*
as a baseline: "do the naive thing and break on any semantic difference."
We know we need to be smarter than this.

### 2.7 Git itself — the paragon of refuse-with-remediation

`git push` refusing a non-fast-forward: "Updates were rejected because the
tip of your current branch is behind its remote counterpart. Integrate the
remote changes (e.g. 'git pull …') before pushing again." This is the
textbook refusal UX:

- **Refuse by default, force-available.** `--force-with-lease` exists but is
  documented as dangerous.
- **Actionable remediation in the error message.** Not just "can't do this"
  — *here's what to run*.
- **Distinct exit code from drift or normal error.**

---

## 3. The "three copy classes" — terminology review

No reviewed tool has a canonical term for "three kinds of copy." What each
does:

| Tool           | Verbatim class                       | Transform class                  | Refuse class                                |
|---|---|---|---|
| chezmoi        | `dot_*` file                         | `.tmpl` (Go template render)     | encrypted — auto-decrypts, won't expose plaintext at rest |
| kustomize      | passthrough resource                 | `patchesStrategicMerge` target   | (none — no security refusal)                |
| terraform      | unchanged attribute                  | `DiffSuppressFunc` normalize     | `precondition` failure                      |
| ansible        | `copy` module                        | `template` module                | (none — manual)                             |
| helm           | literal manifest                     | template-render                  | (none — via helm-secrets plugin)            |

Candidate verb triples for `am`:

| Triple                           | Pros                                                   | Cons                                       |
|---|---|---|
| **copy / transform / refuse**    | terraform-aligned ("refuse" is precedented)            | "transform" understates what we do (just rewrite URL with `${VAR}`) |
| **mirror / rewrite / refuse**    | matches issue #3 copy ("mirror global → project")      | "rewrite" conflates in-place + output-only |
| **copy / redact / refuse**       | "redact" is already in issue #3 ("URL-credential redactor") | implies we redact (today we refuse); collides with verb B |
| **copy / skip / refuse**         | shortest                                               | "skip" already used for `disabled: true`; overloads |
| **include / include-redacted / exclude-unsafe** | precise                                 | verbose                                    |
| **copy-verbatim / copy-redacted / refuse-unsafe** | explicit             | long                                       |

**Recommendation:** `copy` / `rewrite` / `refuse`.

- `copy` is the expected default — stdio and env-based HTTP. Matches the
  issue #3 wording ("copy verbatim").
- `rewrite` leaves room for a future behavior where we *do* transform a
  URL-credential into a `${VAR}` env-var automatically (out of MVP scope,
  but the verb supports it — today we `refuse`, tomorrow we can offer
  `--auto-rewrite`).
- `refuse` is the hard stop; matches git's "refused" terminology and
  terraform's "precondition failed" tone.

This also maps cleanly to exit codes (§4).

---

## 4. Exit-code protocol recommendation

Mirroring chezmoi verify + grep + rsync conventions:

| Code | Meaning                                                                              |
|---|---|
| 0    | superset satisfied; project ⊇ global(enabled)                                        |
| 1    | drift — at least one `copy` or `rewrite` class server is missing from project       |
| 2    | refusal — at least one `refuse` class server exists; user must rotate to `${VAR}`    |
| 3    | input error — global or project unparseable / missing                                |

`--strict` (from issue #3) maps to: treat code 2 as code 1 (any divergence is
a CI failure). Default behaviour is: code 2 is its own class so CI pipelines
can tag security findings separately from mere drift.

---

## 5. JSON output schema (recommended)

Aligned with chezmoi's `diff --format=json` shape, terraform's plan JSON, and
the existing `DiffChange` type in `src/adapters/types.ts:97-102`.

```jsonc
{
  "schema_version": 1,
  "command": "mcp superset check",
  "global_source": "/home/user/.claude.json",
  "project_target": "/abs/path/.mcp.json",
  "summary": {
    "total_global_enabled": 7,
    "in_project": 3,
    "to_copy": 3,
    "to_rewrite": 0,
    "to_refuse": 4,
    "skipped_disabled": 8
  },
  "entries": [
    {
      "name": "context7",
      "class": "copy",
      "source_shape": "stdio",
      "reason": "stdio-with-command; safe to mirror verbatim",
      "in_project": false,
      "action": "add",
      "details": {
        "command": "bunx",
        "args": ["-y", "@context7/mcp"],
        "env": {}
      }
    },
    {
      "name": "tavily-mcp",
      "class": "refuse",
      "source_shape": "http-url-credential",
      "reason": "URL query parameter tavilyApiKey= contains embedded credential",
      "in_project": false,
      "action": "refuse",
      "remediation": {
        "kind": "rotate-to-env-var",
        "suggested_env_var": "TAVILY_API_KEY",
        "rewrite_preview": "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}",
        "how": "Set TAVILY_API_KEY in both global and project env, then re-run."
      },
      "redacted_detected_pattern": "tavilyApiKey=tvly-****"
    },
    {
      "name": "strands",
      "class": "copy",
      "source_shape": "stdio",
      "reason": "stdio-with-command; safe to mirror verbatim",
      "in_project": true,
      "action": "none",
      "details": { "already_in_sync": true }
    },
    {
      "name": "aws-knowledge-mcp-server",
      "class": "refuse",
      "source_shape": "http-url-credential",
      "reason": "URL path contains embedded access key",
      "in_project": false,
      "action": "refuse",
      "remediation": {
        "kind": "rotate-to-env-var",
        "suggested_env_var": "AWS_KNOWLEDGE_MCP_TOKEN",
        "how": "Rotate to Authorization: Bearer ${AWS_KNOWLEDGE_MCP_TOKEN}"
      },
      "redacted_detected_pattern": "9391e****"
    },
    {
      "name": "old-internal-tool",
      "class": "skip",
      "source_shape": "disabled-in-global",
      "reason": "disabled: true in global; not a superset requirement",
      "in_project": false,
      "action": "none"
    }
  ],
  "exit_code": 2
}
```

Schema invariants:

1. `schema_version` is mandatory and increments on breaking changes.
2. `class` ∈ `"copy" | "rewrite" | "refuse" | "skip"` — four values (skip is
   not really a "copy class" but belongs here for completeness; alternative
   is to move skipped entries to a separate `skipped` array like chezmoi's
   ignored-files output).
3. `action` ∈ `"add" | "update" | "none" | "refuse"` — what `apply` would
   actually do if run now.
4. Never include raw credentials in any field. `redacted_detected_pattern`
   is always masked (first-four + `****`).
5. `remediation` is only present on `refuse` entries; it's the
   git-non-fast-forward-style "here's what to run" hint.
6. `summary.to_refuse > 0` ⇒ `exit_code == 2` unless `--strict` promotes to 1.

This schema is a **superset of** what issue #3 acceptance-criteria test cases
need (the fixture test should assert shape-stability across runs) and is
**machine-consumable from** the existing `am_mcp_*` MCP tool group in
`src/mcp/server.ts` with minimal adaptation.

---

## 6. Refusal-UX design checklist (drawing from git + terraform)

For the `refuse` class, the printed error (non-JSON mode) should:

1. **Lead with the refused item**, not with an abstract error.
   > `refused: mirroring "tavily-mcp" would leak credential from URL query`
2. **Show the detected pattern redacted**, so user can confirm which secret.
   > `  detected: ?tavilyApiKey=tvly-****`
3. **Offer one concrete remediation**, with the exact env-var name.
   > `  remediation: rotate to env-var via:`
   > `    am secret set TAVILY_API_KEY tvly-...`
   > `    # then in both global and project configs:`
   > `    "url": "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}"`
4. **Name the override if any exists** (parity with `--force-with-lease`).
   > `  to override (unsafe, commits credential to git): --allow-url-credential`
   > — **Recommendation: do NOT add `--allow-url-credential` in MVP.** The
   > whole point is to refuse. An override flag erodes the guarantee; instead
   > require the user to use `${VAR}` which is the correct fix. Can be added
   > later if users demand it.
5. **Exit 2, not 1.** Security findings are distinct from drift.

---

## 7. Recommendations summary

1. **Adopt `copy` / `rewrite` / `refuse` as the three copy-class verbs**, plus
   `skip` for disabled-in-global. (§3)
2. **Split `check` from `apply`** like chezmoi's diff/verify pair + ansible's
   `--check`. `check` exits 0/1/2/3 per §4; `apply` performs writes and
   *refuses to write* on any `refuse` class. (§2.1, §2.5)
3. **Model the merge as object-key merge** (§2.2) — `mcpServers` is already
   a map; don't introduce an array intermediate. Document the copy classes
   in the Zod schema or a top-of-file constant in the command handler.
4. **Copy terraform's `sensitive = true` display-suppression idea** (§2.3) for
   the `copy` class of HTTP-with-env — *display* the env var name, never the
   resolved value, in previews. Compare resolved values semantically under
   the hood so drift still surfaces.
5. **Emit a stable machine-readable schema** (§5) with `schema_version: 1`,
   never include raw credentials, always redact to `first-four + ****`.
6. **Refusal UX follows git push-rejection style** (§6) — named item,
   redacted pattern, one concrete remediation, distinct exit code, no
   casual `--force` override in MVP.
7. **No override flag in MVP.** `refuse` means refuse. The correct path is
   `${VAR}` rotation; providing an escape hatch invites exactly the
   credential-leak scenario the feature prevents.

---

## 8. Open questions — flag before decision

- **Should `rewrite` exist as a class in v1, or only `copy` + `refuse` + `skip`?**
  Issue #3 asks for refuse-only behavior. But reserving `rewrite` in the
  schema now costs nothing and lets a future `--auto-rewrite` feature slot in
  without a schema-version bump.
- **Should `skip` move to a sibling `skipped` array** (like chezmoi ignored-
  files) instead of living inside `entries`? Argument for separation: CI
  consumers iterating `entries` don't accidentally process disabled servers.
  Argument against: flat array is simpler to consume from shell/jq.
- **Override flag `--allow-url-credential` — yes or no?** Recommendation in
  §6 is no, but a strict team lead might want it for one-off local-only
  project configs that are already gitignored. The `--dry-run` default of
  `apply` plus explicit user consent could cover this — but then we're
  re-litigating git's `--force-with-lease`. Deferred decision.
- **Cross-scope merge direction only global→project, or symmetric?** Issue
  #3 names the invariant as unidirectional (project ⊇ global). But users may
  want the reverse ("I added something to project; propagate to global").
  Out of MVP scope per the issue text. Track as a follow-up.
- **How does this interact with tier-2-shim agents (ADR-0033)?** Shim agents
  inherit the wrapped CLI's trust posture; a tier-2-shim consuming an
  `.mcp.json` with an embedded URL-credential that `am` refused to write
  should never see that credential. Confirms: refusal at write-time is the
  right layer (not at read-time).

---

## 9. Sources (intended — unable to fetch in this run)

Would have wanted to cite directly; should be fetched before an ADR lands:

- chezmoi: `chezmoi.io/reference/commands/diff/`,
  `chezmoi.io/reference/commands/verify/`,
  `chezmoi.io/reference/commands/status/`
- kustomize: `kubectl.docs.kubernetes.io/references/kustomize/builtins/`,
  `kubernetes.io/docs/tasks/manage-kubernetes-objects/update-api-object-kubectl-patch/`
  (strategic merge patch spec),
  `kubernetes.io/docs/reference/using-api/server-side-apply/` (for managed
  fields conflict resolution — adjacent prior art to "who wrote this")
- terraform: `developer.hashicorp.com/terraform/language/expressions/custom-conditions`
  (precondition/postcondition),
  `developer.hashicorp.com/terraform/plugin/sdkv2/schemas/schema-behaviors#sensitive`,
  `developer.hashicorp.com/terraform/cli/commands/plan#json-format`
- helm: `helm.sh/docs/intro/using_helm/#three-way-strategic-merge-patches`,
  `github.com/databus23/helm-diff` (plugin README for diff UX)
- ansible: `docs.ansible.com/ansible/latest/user_guide/playbooks_checkmode.html`,
  `ansible-vault` docs (for the input-side secret model they chose instead)
- git: `git-scm.com/docs/git-push` non-fast-forward rejection wording,
  `git-scm.com/docs/git-push#Documentation/git-push.txt---force-with-lease`
- This repo: ADR-0006 (drift over overwrite), ADR-0012 (encryption),
  ADR-0019 (security hardening), ADR-0023 (tiered secret detection), and
  [`2026-05-01-drift-detection-patterns.md`](./2026-05-01-drift-detection-patterns.md).

---

## 10. TL;DR

1. **Copy classes: `copy` / `rewrite` / `refuse` (+`skip`).** `refuse` is the
   distinctive class no drift tool has because none of them hit the
   URL-embedded-credential hazard; closest analogue is git's non-fast-forward
   rejection UX — refuse by default, actionable remediation in the error,
   distinct exit code.
2. **Command shape: `check` (chezmoi-verify-style, quiet on success, exit-
   code-driven) paired with `apply` (ansible-playbook-style, performs writes,
   refuses on any `refuse`-class entry).** `--strict` promotes exit-2 to
   exit-1 for unified CI gating.
3. **JSON schema: `schema_version: 1`, merge-by-object-key (no array
   intermediate per kustomize's list-merge lessons), terraform-style
   `sensitive` display-suppression, never-include-raw-credentials,
   first-four+`****` redaction pattern.** Schema lives in §5 above; stable
   contract for the `am_mcp_*` MCP tool group to expose to agents.
