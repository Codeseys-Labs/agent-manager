# Pillar 1 — Catalog + git sync

## 1. What's GOOD today?
- The core catalog is well factored: servers/instructions/skills/agents/profiles are first-class Zod entities, while adapter data is preserved through passthroughs (`src/core/schema.ts:31-44`, `src/core/schema.ts:75-124`; ADR intent at `ADRs/0001-layered-core-plus-adapter-extensions.md:36-53`).
- Hierarchical config is real, not just documented: global/local/project/project-local merge in order (`src/core/config.ts:164-197`), with project env folded into `settings.env` (`src/core/config.ts:137-153`).
- Mutating commands go through a serialized, auto-committing controller (`src/core/controller.ts:111-140`), the right shape for git-backed config.
- Secret primitives are strong: keys live outside git (`src/core/secrets.ts:15-51`), values are version-prefixed (`src/core/secrets.ts:183-209`), and add/import auto-detect and encrypt secrets (`src/commands/add.ts:173-193`, `src/commands/import.ts:361-388`).
- Registry provenance is auditable: installed servers carry package/version/timestamp (`src/core/schema.ts:6-12`, `src/commands/install.ts:149-164`), with cache/retry/fallback (`src/registry/client.ts:47-133`).

## 2. What's MISSING / ROUGH for a new user?
- `am apply --diff` and `--force` are accepted but not passed into the apply pipeline (`src/commands/apply.ts:10-13`, `src/commands/apply.ts:24-30`), so ADR-0006's promised drift guard is absent (`ADRs/0006-drift-detection-over-overwrite.md:23-30`).
- `am status` reduces drift to counts (`src/commands/status.ts:52-63`, `src/commands/status.ts:104-114`) though adapter diffs carry field-level details (`src/adapters/types.ts:97-107`).
- TOML is sold as human-friendly/commentable, but writes parse objects and stringify from scratch (`src/core/config.ts:43-47`, `src/core/config.ts:81-94`; `src/lib/toml.ts:11-12`), so comments and hand formatting are not preserved.
- `am add --project` exists in the CLI surface (`src/commands/add.ts:84-88`) but add paths still write only global config via `resolveConfigDir()`/`withConfig()` (`src/commands/add.ts:125-143`, `src/commands/add.ts:459-480`).
- `.agent-manager.toml` has `profile`, but `projectToConfig()` drops it and apply chooses active/default profile instead (`src/core/schema.ts:177-192`, `src/core/config.ts:137-153`, `src/core/controller.ts:201-205`).
- Brownfield import is auto-only: `--auto` is a no-op (`src/commands/import.ts:98-102`, `src/commands/import.ts:167`), while ADR-0028 promised interactive/dry-run/strategy (`ADRs/0028-brownfield-import-merge.md:60-68`, `ADRs/0028-brownfield-import-merge.md:120-128`).
- `am install` can store prompted required env values in plaintext without a key (`src/commands/install.ts:113-133`), unlike add/import's auto-key path.

## 3. What's MISSING / ROUGH for a power user?
- Multi-project selection is brittle: project profile is ignored, project writes are missing, and profile `env` is resolved for display (`src/core/resolver.ts:86-100`) but not included in `ResolvedConfig` (`src/core/config.ts:278-285`).
- CI/reproducibility is weak: `--version` is declared but never used before `getPackage(pkgName)` (`src/commands/install.ts:16-18`, `src/commands/install.ts:55-59`).
- Applies are not transactional; adapter exports run sequentially and previous writes remain if a later adapter fails (`src/core/controller.ts:231-252`).
- Git provider UX is generic outside GitHub/GitLab: platform detection is GitHub, GitLab, then bare fallback (`src/platforms/registry.ts:1-15`; `src/platforms/bare.ts:3-10`).

## 4. Multi-provider / multi-account
This can be approximated with separate profiles, servers, and env vars, but first-class provider/account concepts are missing. `AgentProfile` has only `model: string` plus adapter passthroughs (`src/core/schema.ts:88-107`); there is no core `provider`, `base_url`, `account`, or `credential_ref`. `settings.env` is a single map (`src/core/schema.ts:133-161`), and profile env currently does not flow into exports, so Bedrock vs Anthropic or OpenRouter vs Anthropic must be encoded ad hoc per adapter/server name.

## 5. Top 3 ACTIONABLE IMPROVEMENTS
1. Problem: users cannot tell what apply will overwrite. Fix: wire `--diff/--force` through `applyResolved`, block drift by default, and print changed fields. Acceptance: a drifted Claude config makes plain `am apply` exit non-zero with import/force guidance, while `--diff` shows changed fields.
2. Problem: project workflows look supported but are inert. Fix: honor `.agent-manager.toml profile`, implement `am add --project`, and merge profile env into exports. Acceptance: in a repo with `profile = "work"`, `am apply` uses work without `am use`, and `am add --project server ...` edits only `.agent-manager.toml`.
3. Problem: registry installs are not reproducible or secret-safe. Fix: honor `--version`, auto-generate/encrypt keys like add/import, and show an env/security summary. Acceptance: `am install foo --version 1.2.3` records 1.2.3 and never commits prompted secret plaintext by default.

## References
ADRs/0001, 0006, 0028; src/core/schema.ts, config.ts, controller.ts, resolver.ts, secrets.ts; src/core/secret-detection.ts; src/commands/add.ts, import.ts, apply.ts, status.ts, install.ts; src/adapters/types.ts; src/registry/client.ts; src/platforms/registry.ts, bare.ts; src/lib/toml.ts.
