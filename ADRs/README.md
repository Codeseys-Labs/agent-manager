# Architectural Decision Records

This folder contains the architectural decisions for agent-manager.

## Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-layered-core-plus-adapter-extensions.md) | Layered Core + Adapter Extensions Architecture | Accepted | 2026-04-07 |
| [0002](0002-git-backed-everything.md) | Git-Backed Everything | Accepted | 2026-04-07 |
| [0003](0003-hierarchical-config.md) | Hierarchical Config — Global + Project Layers | Accepted | 2026-04-07 |
| [0004](0004-toml-config-format.md) | TOML as Configuration Format | Accepted | 2026-04-07 |
| [0005](0005-bidirectional-adapters.md) | Bidirectional Adapters — Import + Export + Diff | Accepted | 2026-04-07 |
| [0006](0006-drift-detection-over-overwrite.md) | Drift Detection Over Strict Overwrite | Accepted | 2026-04-07 |
| [0007](0007-two-phase-zod-validation.md) | Two-Phase Zod Validation | Accepted | 2026-04-07 |
| [0008](0008-profile-based-config-subsets.md) | Profile-Based Configuration Subsets | Accepted | 2026-04-07 |
| [0009](0009-mcp-server-mode.md) | agent-manager as an MCP Server | Accepted | 2026-04-07 |
| [0010](0010-bunts-single-binary.md) | BunTS Single Binary Distribution | Accepted | 2026-04-07 |
| [0011](0011-built-in-adapters.md) | Built-In Adapters with Subprocess Escape Hatch | Accepted | 2026-04-07 |
| [0012](0012-application-level-encryption.md) | Application-Level Encryption with Platform-Agnostic Key Storage | Accepted | 2026-04-07 |
| [0013](0013-git-platform-adapters.md) | Git Platform Adapters | Accepted | 2026-04-07 |
| [0014](0014-workspace-profile-import.md) | Workspace-to-Profile Import | Accepted | 2026-04-07 |
| [0015](0015-stateless-web-ui.md) | Stateless Web UI — Git-Backed, Independently Deployable | Accepted | 2026-04-08 |
| [0016](0016-session-harvest.md) | Session Harvest — Cross-Tool Conversation Export and Analysis | Accepted | 2026-04-08 |
| [0017](0017-agent-communication-protocol.md) | Multi-Protocol Agent Integration -- MCP, A2A, and ACP | Accepted | 2026-04-08 |
| [0018](0018-tui-framework-silvery.md) | Terminal UI Framework -- Ink to Silvery Migration | Accepted | 2026-04-08 |
| [0019](0019-security-hardening.md) | Security Hardening -- Threat Model and Fixes | Accepted | 2026-04-08 |
| [0020](0020-session-knowledge-synthesis.md) | Session Knowledge Synthesis — LLM Wiki from Agent Sessions | Accepted | 2026-04-09 |
| [0021](0021-mcp-tool-grouping-and-gateway.md) | MCP Tool Grouping via Profiles and Gateway Mode | Accepted | 2026-04-09 |
| [0022](0022-wiki-location-strategy.md) | Wiki Location Strategy — Global Store with Project Symlinks | Superseded in part by [0044](0044-wiki-two-tier-copy-materialisation.md) | 2026-04-09 |
| [0023](0023-tiered-secret-detection.md) | Tiered Secret Detection with BetterLeaks Integration | Accepted | 2026-04-10 |
| [0024](0024-mcp-registry-integration.md) | MCP Registry Integration | Accepted | 2026-04-10 |
| [0025](0025-worker-multi-backend-auth.md) | Stateless Web Worker Multi-Backend Git Authentication | Accepted | 2026-04-13 |
| [0026](0026-acpx-acp-runtime-integration.md) | ACP Runtime Integration via ACPX -- am as Agent Orchestrator | Accepted | 2026-04-16 |
| [0027](0027-community-adapter-loading.md) | Community Adapter Loading via Subprocess IPC | Accepted | 2026-04-16 |
| [0028](0028-brownfield-import-merge.md) | Brownfield Import Merge | Accepted | 2026-04-16 |
| [0029](0029-command-grouping.md) | Command Grouping in Help Output | Accepted | 2026-04-14 |
| [0030](0030-unified-agent-registry.md) | Unified Agent Registry and Protocol Routing | Accepted | 2026-04-16 |
| [0031](0031-product-scope-and-pillars.md) | Product Scope and Pillars | Accepted (amended by [0031a](0031a-pillar-6-amendment.md)) | 2026-04-16 |
| [0031a](0031a-pillar-6-amendment.md) | Pillar 6 — Local-Write-Path Scope Clarification | Accepted | 2026-05-05 |
| [0032](0032-terminology-glossary.md) | Terminology Glossary | Accepted | 2026-04-17 |
| [0033](0033-acp-agent-tiers-and-shim-wrapper.md) | ACP Agent Tiers and Shim-Wrapper Architecture | Accepted (pending amendment by [0034](0034-shim-scope-and-inclusion-criteria.md)) | 2026-04-18 |
| [0034](0034-shim-scope-and-inclusion-criteria.md) | Scope Fence for First-Party ACP Shims | Accepted | 2026-05-01 |
| [0035](0035-community-shim-registration.md) | Community Shim Registration Protocol | Accepted | 2026-05-02 |
| [0036](0036-agent-variants.md) | Per-Agent Variants for Multi-Provider / Multi-Account Routing | Accepted | 2026-05-02 |
| [0037](0037-per-tool-mcp-metadata.md) | Per-Tool MCP Metadata via `x-am.*` Namespace | Accepted | 2026-05-03 |
| [0038](0038-dry-run-explain-surface.md) | Dry-Run / Explain Surface Pattern | Accepted | 2026-05-02 |
| [0039](0039-marketplace-v1-scope-decision.md) | Marketplace v1 Scope Decision — Retire pillar 4 in favor of MCP Registry + git-subtree bundles | Accepted | 2026-05-05 |
| [0040](0040-controller-scope-and-concurrency.md) | Controller Scope & Concurrency Model (`withConfig` + AsyncMutex) | Accepted | 2026-05-05 |
| [0041](0041-adr-0007-phase-2-deferred.md) | ADR-0007 Phase 2 Resolution — Delete the Adapter Schema Field | Accepted | 2026-05-05 |
| [0042](0042-universal-secrets-strategy.md) | Universal Secrets Strategy — age envelope + Argon2id-passphrase + OS keychain cache | Accepted | 2026-05-05 |
| [0043](0043-hosted-ui-auth-and-git-backend-tiers.md) | Hosted UI Auth + Git Backend Tiers | Proposed | 2026-05-05 |
| [0044](0044-wiki-two-tier-copy-materialisation.md) | Wiki Two-Tier Materialisation — Copy Over Symlink, Project-Level + Global Store | Accepted | 2026-05-05 |
| [0045](0045-hosted-ui-editor-codemirror.md) | Hosted UI Editor — CodeMirror 6 Default, Monaco Optional for Local | Proposed | 2026-05-05 |
| [0046](0046-reject-team-passphrase-schema.md) | Reject `team_passphrase` Field in Schema — Force Per-Recipient Identity | Accepted | 2026-05-05 |
| [0047](0047-am-pair-cross-device-key-handoff.md) | `am pair` cross-device key handoff via git-native rendezvous | Accepted | 2026-05-05 |
| [0048](0048-hosted-ui-auth-implementation.md) | Hosted UI Auth Implementation Plan | Proposed | 2026-05-05 |
| [0049](0049-hosted-ui-editor-cm6-implementation.md) | Hosted UI Editor CodeMirror 6 Implementation Plan | Proposed | 2026-05-05 |
| [0050](0050-browser-secret-decryption-bundle.md) | Browser Secret Decryption Bundle (Synthesizes Lens H + Clarification) | Proposed | 2026-05-05 |
| [0051](0051-secrets-rotation-grace-period.md) | Secrets Rotation + Grace Period (Synthesizes Lens I) | Accepted | 2026-05-05 |
| [0052](0052-marketplace-v1-code-removal-target.md) | Marketplace v1 Code Removal Target (superseded — marketplace deferred to v2, not deleted) | Superseded | 2026-05-16 |

## Template

See [template.md](template.md) for the ADR format.
