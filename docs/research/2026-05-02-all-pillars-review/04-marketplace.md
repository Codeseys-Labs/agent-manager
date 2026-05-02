# Pillar 4 — Marketplace review

## 1. What's good today?
- The vocabulary is crisp: ADR-0024 scopes Registry to `am search/install/update` with package provenance, while Marketplace is plural/user-subscribed/git-backed/SHA-pinned (ADRs/0024-mcp-registry-integration.md:31-54; ADRs/0032-terminology-glossary.md:32-47).
- The security baseline is real: HTTPS/no-credentials/standard-port checks, clone size/time caps, TOFU, and SHA-change prompts exist in code (src/marketplace/security.ts:67-118,195-220,247-289); installs verify the pinned HEAD first (src/marketplace/installer.ts:62-66).
- The happy path is unified: one manifest can add servers, skills, agents, and a community adapter (src/marketplace/types.ts:68-78; src/marketplace/installer.ts:126-210).
- Community adapters implement ADR-0027’s JSON-RPC subprocess shape with checksum-before-spawn (ADRs/0027-community-adapter-loading.md:34-52; src/adapters/community/proxy.ts:151-174; src/adapters/community/loader.ts:23-83), and direct adapter installs use `--ignore-scripts` (src/commands/adapter.ts:163-168,547-550).

## 2. Rough for a new marketplace author
- There is no author guide; the only published instruction says “See `src/marketplace/`” (docs/community-adapter-authoring.md:297-303).
- No manifest validator/scaffold: scanner only checks `name` and `description`, then silently skips failures (src/marketplace/scanner.ts:22-34); CLI subcommands omit validate/init/pack (src/commands/marketplace.ts:341-349).
- Repo layout is implicit code knowledge: only immediate child dirs and `plugins/` are scanned, hidden dirs skipped (src/marketplace/scanner.ts:69-105).
- README promises “hooks,” but `PluginManifest` has no hooks field (README.md:167-170; src/marketplace/types.ts:68-78).
- Collision behavior is invisible: servers/skills/agents are assigned directly into config maps, so duplicate keys overwrite (src/marketplace/installer.ts:146-147,173-174,207-208).
- Adapter bundling is a footgun: marketplace install writes an adapter entry without checksum (src/marketplace/installer.ts:83-92), while the loader refuses non-local adapters without one (src/adapters/community/loader.ts:27-35,52-54).

## 3. Rough for a new marketplace subscriber
- Preview is too thin: list/search show name/description/counts only (src/commands/marketplace.ts:126-160,267-296); install has no dry-run and even `opts.yes` is reserved/unused (src/marketplace/installer.ts:70-73).
- Duplicate plugin names across marketplaces are first-match wins with no namespace or ambiguity prompt (src/marketplace/installer.ts:53-56).
- Revoking trust is unclear: `marketplace remove` deletes the source repo/index only (src/marketplace/client.ts:302-325); installed entities require separate `uninstall` (src/marketplace/installer.ts:219-287).
- The human CLI confuses this: README shows `marketplace remove my-plugin # uninstall`, but the command removes a marketplace, not a plugin (README.md:173-178; src/commands/marketplace.ts:235-253,304-329).
- Updates show old/new SHA but no manifest diff/changelog/added commands (src/marketplace/client.ts:268-285; src/commands/marketplace.ts:220-227).
- Local marketplaces are convenient but unpinned and not labeled as lower-trust in list output (src/marketplace/client.ts:127-146,348-350; src/commands/marketplace.ts:148-151).

## 4. Discoverability
Add a default “marketplace index” marketplace: `am marketplace discover/search`, backed by an official git repo of marketplace descriptors (owner, URL, categories, plugin count, last verified commit, risk labels). `am marketplace add verified/<name>` should still clone and pin the target repo; `am init` can offer the curated index. Today, an empty list only says to paste a Git URL (src/commands/marketplace.ts:119-123).

## 5. ADR-0035 community shims
Not yet. Current marketplace install only maps `PluginManifest.adapter` to `setCommunityAdapterConfig(...)`/`adapters.toml` (src/marketplace/installer.ts:83-92). ADR-0035 explicitly says `adapters.toml` is wrong for shims because adapter JSON-RPC configs and `ShimConfig` differ (ADRs/0035-community-shim-registration.md:54-71). The code-level mirror should be `PluginManifest.shims` -> `CommunityShimConfig` -> future `setCommunityShimConfig(...)` writing `shims.toml`, whose fields serialize `ShimConfig` (ADRs/0035-community-shim-registration.md:88-125,200-207,249-255).

## 6. Top 3 actionable improvements
1. **Authoring kit.** Problem: authors reverse-engineer code. Fix: `docs/marketplace-author-guide.md`, sample repo, Zod schema, `am marketplace validate <path>`. Acceptance: valid fixture passes; malformed manifests get field-level errors.
2. **Subscriber preview/conflicts.** Problem: installs are blind and overwriting. Fix: `am marketplace info <mp>/<plugin> --diff` and install refuses conflicts without `--replace`. Acceptance: duplicate plugin/server names are actionable prompts.
3. **Discover + trust management.** Problem: URL-only discovery and weak revocation. Fix: curated index plus `trust list/revoke` that offers to uninstall installed plugins. Acceptance: a new user can find, add, inspect, and revoke without reading docs.

## References
ADRs/0024-mcp-registry-integration.md; ADRs/0027-community-adapter-loading.md; ADRs/0032-terminology-glossary.md; ADRs/0035-community-shim-registration.md; src/marketplace/{client,security,scanner,installer,types}.ts; src/adapters/community/{loader,proxy}.ts; src/commands/{marketplace,adapter}.ts; README.md; docs/community-adapter-authoring.md.
