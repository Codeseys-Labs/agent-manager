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
| [0012](0012-application-level-encryption.md) | Application-Level Encryption (AES-256-GCM) | Accepted | 2026-04-07 |
| [0013](0013-git-platform-adapters.md) | Git Platform Adapters (GitHub, GitLab, bare) | Accepted | 2026-04-07 |
| [0014](0014-workspace-profile-import.md) | Workspace-to-Profile Import | Accepted | 2026-04-07 |
| [0015](0015-stateless-web-ui.md) | Stateless Web UI — Git-Backed, Independently Deployable | Accepted | 2026-04-08 |
| [0016](0016-session-harvest.md) | Session Harvest — Cross-Tool Conversation Export | Accepted | 2026-04-08 |
| [0017](0017-agent-communication-protocol.md) | Multi-Protocol Agent Integration — MCP, A2A, ACP | Accepted | 2026-04-08 |
| [0018](0018-tui-framework-silvery.md) | Terminal UI Framework — Ink to Silvery Migration | Accepted | 2026-04-08 |
| [0019](0019-security-hardening.md) | Security Hardening — Threat Model and Fixes | Accepted | 2026-04-08 |
| [0020](0020-session-knowledge-synthesis.md) | Session Knowledge Synthesis — LLM Wiki | Accepted | 2026-04-08 |
| [0021](0021-mcp-tool-grouping-and-gateway.md) | MCP Tool Grouping and Gateway Mode | Accepted | 2026-04-10 |
| [0022](0022-wiki-location-strategy.md) | Wiki Location Strategy — Global Store with Project Symlinks | Accepted | 2026-04-10 |
| [0023](0023-tiered-secret-detection.md) | Tiered Secret Detection with BetterLeaks Integration | Accepted | 2026-04-10 |
| [0024](0024-mcp-registry-integration.md) | MCP Registry Integration | Accepted | 2026-04-10 |
| [0025](0025-worker-multi-backend-auth.md) | Worker Multi-Backend Git Authentication | Accepted | 2026-04-13 |
| [0026](0026-acpx-acp-runtime-integration.md) | ACP Runtime Integration via ACPX | Accepted | 2026-04-15 |
| [0027](0027-community-adapter-loading.md) | Community Adapter Loading | Accepted | 2026-04-16 |
| [0028](0028-brownfield-import-merge.md) | Brownfield Import Merge Strategy | Accepted | 2026-04-16 |
| [0029](0029-command-grouping.md) | Command Grouping — Grouped Help Output | Accepted | 2026-04-14 |
| [0030](0030-unified-agent-registry.md) | Unified Agent Registry | Accepted | 2026-04-16 |
| [0031](0031-product-scope-and-pillars.md) | Product Scope and Pillars — Six-Pillar Model | Accepted | 2026-04-16 |
| [0032](0032-terminology-glossary.md) | Terminology Glossary — Registry vs Marketplace | Accepted | 2026-04-17 |
| [0033](0033-acp-agent-tiers-and-shim-wrapper.md) | ACP Agent Tiers and Shim Wrapper | Accepted (pending amendment by [0034](0034-shim-scope-and-inclusion-criteria.md)) | 2026-04-18 |
| [0034](0034-shim-scope-and-inclusion-criteria.md) | Scope Fence for First-Party ACP Shims | Proposed | 2026-05-01 |
| [0035](0035-community-shim-registration.md) | Community Shim Registration Protocol | Proposed | 2026-05-02 |

## Template

See [template.md](template.md) for the ADR format.
