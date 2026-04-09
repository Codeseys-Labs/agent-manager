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
| [0012](0012-application-level-encryption.md) | Application-Level Encryption (AES-256-GCM, platform-agnostic) | Accepted | 2026-04-07 |
| [0013](0013-git-platform-adapters.md) | Git Platform Adapters (GitHub, GitLab, bare) | Accepted | 2026-04-07 |
| [0014](0014-workspace-profile-import.md) | Workspace-to-Profile Import | Accepted | 2026-04-07 |
| [0015](0015-stateless-web-ui.md) | Stateless Web UI — Git-Backed, Independently Deployable | Accepted | 2026-04-08 |
| [0016](0016-session-harvest.md) | Session Harvest — Cross-Tool Conversation Export and Analysis | Accepted | 2026-04-08 |
| [0017](0017-agent-communication-protocol.md) | Multi-Protocol Agent Integration — MCP, A2A, and ACP | Proposed | 2026-04-08 |
| [0018](0018-tui-framework-silvery.md) | Terminal UI Framework — Ink to Silvery Migration | Accepted | 2026-04-08 |
| [0019](0019-security-hardening.md) | Security Hardening — Threat Model and Fixes | Accepted | 2026-04-08 |

## Template

See [template.md](template.md) for the ADR format.
