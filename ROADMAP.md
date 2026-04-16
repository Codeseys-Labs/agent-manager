# Roadmap

> agent-manager (`am`) — chezmoi for AI agent configs. Single source of truth
> for MCP servers, instructions, skills, and agent profiles across every AI tool.

This document tracks the project vision, implementation status, and future plans.

---

## Vision

agent-manager exists to solve one problem: AI tool configurations are fragmented.
Every tool has its own format, its own location, its own sync story. Developers
who use multiple tools — or even one tool across machines — waste time managing
configs that are fundamentally the same data in different shapes.

**Core thesis**: Define your AI tool config once in TOML. Sync via git. Generate
native configs for every tool. Let any agent manage its own configuration
programmatically. Keep secrets encrypted. Build knowledge from sessions.

**Design principles**:
- **Local-first**: Everything works offline. Git backend is optional.
- **Extensible**: New tools are new adapters, not new architectures.
- **Agent-native**: CLI, MCP server, A2A protocol — agents are first-class users.
- **Zero-friction security**: Secrets auto-detected and encrypted at import time.
- **Git is the sync protocol**: Every durable change is a commit. Push/pull for sync.

---

## Implementation Status

### Core Engine — Complete

| Feature | Status | ADR | Notes |
|---------|--------|-----|-------|
| TOML config format | Done | 0004 | @iarna/toml + Zod validation |
| 4-layer hierarchical merge | Done | 0003 | global → global.local → project → project.local |
| Profile-based subsets | Done | 0008 | Inheritance chains, tag activation |
| Two-phase Zod validation | Done | 0007 | Core strict, adapter passthrough |
| AES-256-GCM encryption | Done | 0012 | `enc:v1:nonce:ciphertext` format |
| `${VAR}` interpolation | Done | 0012 | Resolved at apply time from env + settings.env |
| Git-backed config repo | Done | 0002 | Auto-commit on add/import/install |
| 5 entity types | Done | 0001 | Servers, Instructions, Skills, Agents, Profiles |

### IDE Adapters (13) — Complete

| Adapter | Capabilities | ADR |
|---------|-------------|-----|
| Claude Code | mcp, instructions, permissions, models, skills, plugins, agents, hooks, sessions | 0005, 0011 |
| Codex CLI | mcp, instructions, permissions, agents, sessions | 0005, 0011 |
| Cursor | mcp, instructions, agents | 0005, 0011 |
| Copilot | mcp, instructions | 0005, 0011 |
| Windsurf | mcp, instructions | 0005, 0011 |
| ForgeCode | mcp, instructions, skills, agents, models | 0005, 0011 |
| Kilo Code | mcp, instructions, skills, agents, modes | 0005, 0011 |
| Kiro | mcp, instructions, skills, agents | 0005, 0011 |
| Gemini CLI | mcp, instructions | 0005, 0011 |
| Cline | mcp, instructions | 0005, 0011 |
| Roo Code | mcp, instructions, modes | 0005, 0011 |
| Amazon Q | mcp, instructions | 0005, 0011 |
| Continue | mcp, instructions | 0005, 0011 |

All adapters: detect, import, export, drift detection. 6-file pattern.

### Platform Adapters (3) — Complete

| Platform | Detection | ADR |
|----------|-----------|-----|
| GitHub | URL contains `github.com` | 0013 |
| GitLab | URL contains `gitlab` | 0013 |
| Bare git | Fallback for all others | 0013 |

Future candidates: Gitea, Codeberg, Forgejo, BitBucket (ADR-0013 updated).

### CLI (31 commands) — Complete

Config: init, add, list, use, apply, status, config, profile
Git: push, pull, undo, log
Registry: search, install, uninstall, update
Wiki: wiki (13 subcommands)
A2A: agents (5 subcommands)
ACP: run (agent orchestration + session subcommands)
Flows: flow (pipeline orchestration subcommands)
Marketplace: marketplace (7 subcommands)
Tools: import, adapter (5 subcommands), doctor, secret (6 subcommands), session, version
Interfaces: mcp-serve, tui, serve, completion (bash/zsh/fish)

### MCP Server (33 tools, 6 groups) — Complete

| Group | Tools | Default |
|-------|-------|---------|
| core (14) | servers, profiles, status, config, doctor, add/remove/update, undo, apply, import, push/pull | Yes |
| registry (3) | search, install, list_installed | No |
| a2a (4) | discover, list, delegate, task_status | No |
| wiki (5) | search, add, synthesize, briefing, harvest | No |
| session (3) | list, export, search | No |
| acp (4) | run_agent, list_agents, session_list, session_cancel | No |

Controlled via `settings.mcp_serve.tools` (ADR-0021).

### Secret Detection — Complete

| Tier | Engine | What it catches | Status |
|------|--------|----------------|--------|
| Tier 1 | Built-in key-name patterns | env vars named *API_KEY*, *TOKEN*, etc. | Done |
| Tier 2 | BetterLeaks shell-out | Inline secrets in args, commands, values | Done |

Auto-encrypt on import/add. Auto-generate encryption key. ADR-0023.

### MCP Registry — Complete

Search, install, uninstall, update with provenance tracking. ADR-0024.

### Knowledge Wiki — Complete (Phase 1)

| Component | Status | Notes |
|-----------|--------|-------|
| Markdown storage with YAML frontmatter | Done | Karpathy llm-wiki pattern |
| BM25 search (MiniSearch) | Done | Fuzzy, prefix, field boosting |
| Rule-based NER | Done | File paths, packages, functions, 38+ tool names |
| Knowledge graph | Done | JSON adjacency list, orphan detection |
| Dual location (global + project symlinks) | Done | ADR-0022 |
| Session harvesting | Done | Jaccard dedup, pattern extraction |
| Wiki CLI (13 subcommands) | Done | init, search, add, show, delete, harvest, ingest, lint, graph, synthesize, briefing, export, import |

### A2A Protocol — Complete (Phase 1+)

| Component | Status | Notes |
|-----------|--------|-------|
| A2A types (v0.3.0) | Done | AgentCard, Task, Message, Artifact |
| A2A client | Done | Discover, sendTask, getTask, cancelTask, pollTask, sendAndPoll |
| A2A server | Done | JSON-RPC endpoint, Agent Card, async tasks |
| Bearer token auth | Done | Optional auth_token for A2A server endpoints |
| TTL eviction | Done | Terminal tasks expire after 1hr, two-phase eviction |
| Auto-discovery | Done | settings.a2a.discovery_sources[] config-based discovery |
| Discovery (URL + local roster) | Done | TOML roster at ~/.config/agent-manager/ |
| CLI (5 subcommands) | Done | list, add, remove, ping, delegate |

### ACP Agent Orchestration — Complete (Phase 1)

| Component | Status | Notes |
|-----------|--------|-------|
| ACP types | Done | Agent definitions, session types, update events |
| ACP client | Done | Spawn, stream, cancel agents headlessly |
| ACP registry | Done | Agent resolution from config + auto-detection |
| CLI (am run) | Done | `am run <agent> "<prompt>"` + session subcommands |
| MCP tools (4) | Done | run_agent, list_agents, session_list, session_cancel |

### Distribution — Complete

| Component | Status |
|-----------|--------|
| CI workflow (test, lint, typecheck, build) | Done |
| Release workflow (5-platform binaries, checksums, npm) | Done |
| install.sh (POSIX, checksum-verified) | Done |
| Homebrew formula | Done |
| npm wrapper (bin/am.js) | Done |
| Version bump script | Done |

### Interfaces — Complete

| Interface | Status | Notes |
|-----------|--------|-------|
| CLI (citty + clack) | Done | 31 commands, --json/--quiet everywhere |
| MCP Server | Done | 33 tools, 3 permission tiers, 6 groups |
| TUI (Silvery + React) | Done | Dashboard, server management (D/E/I/P keys), status, profiles |
| Local Web (Hono + Bearer auth) | Done | REST API + SSE, server CRUD, wiki endpoints |
| Stateless Web (CF Workers) | Done | Multi-backend git auth (ADR-0025), wiki browsing, git-backed config |

---

## Planned — Next Sessions

### A2A-ACP Bridge — Complete

| Component | Status | Notes |
|-----------|--------|-------|
| Bridge message parsing | Done | Text + structured data formats |
| Bridge task handler | Done | A2A → ACP routing with fallthrough |
| Unified Agent Registry (ADR-0030) | Done | config > ACP built-in (16) > A2A roster |
| Wiki context injection | Done | Auto-inject at apply time via synthesizer |

### Phase 2: Knowledge Synthesis

- [ ] LLM-powered extraction (replace regex pattern matching with LLM calls)
- [ ] Embedding-based semantic search (cosine similarity on wiki entries)
- [ ] Obsidian-style graph visualization (HTML export from `am wiki graph`)
- [x] Context injection into generated AGENTS.md / CLAUDE.md at apply time — done in iteration 6
- [ ] Cross-project knowledge linking (global wiki as a meta-index)

### Phase 2: A2A Protocol

- [x] A2A agent authentication (Bearer tokens for roster entries) — done in iteration 3
- [x] Streaming task responses (SSE from A2A server) — done in iteration 6
- [ ] Multi-agent orchestration (agent chains / pipelines)
- [ ] mDNS/DNS-SD local agent discovery

### Community Adapter Loading — Complete

| Component | Status | Notes |
|-----------|--------|-------|
| JSON-RPC subprocess protocol | Done | `src/adapters/community/proxy.ts` |
| Adapter config (adapters.toml) | Done | `src/adapters/community/loader.ts` |
| CLI (install/remove/update/verify) | Done | `src/commands/adapter.ts` (ADR-0027) |

### Brownfield Import Merge — Complete

| Component | Status | Notes |
|-----------|--------|-------|
| Two-tier identity matching | Done | Name + command matching |
| Conflict resolution (--auto, --report) | Done | ADR-0028 |
| Marketplace scanning (--marketplace) | Done | Plugins + VS Code extensions |

### Git-Based Marketplace — Complete

| Component | Status | Notes |
|-----------|--------|-------|
| Marketplace client | Done | `src/marketplace/client.ts` |
| Plugin scanner | Done | `src/marketplace/scanner.ts` |
| Plugin installer | Done | `src/marketplace/installer.ts` |
| CLI (7 subcommands) | Done | `am marketplace add/remove/list/search/install/uninstall/update` |

### Phase 2: Adapters

- [ ] Full skill/agent drift detection across all 13 adapters
- [x] All adapters migrated to shared utils — done in iteration 9
- [ ] Adapter-specific instruction scope translation tests

### Infrastructure

- [x] Shell completions (bash/zsh/fish) — done in iteration 9
- [ ] Test coverage metrics (bun --coverage in CI, badge in README)
- [ ] npm package: split platform binaries into optionalDependencies
- [ ] Windows CI runner (verify junction point symlinks, path handling)

---

## Deferred — Future Sessions

### Git Backend Adapters — Partially Complete

- ~~Gitea (self-hosted, API-compatible with Codeberg/Forgejo)~~ — Worker `GitProvider` abstraction (ADR-0025)
- ~~Codeberg (largest Forgejo instance)~~ — Worker `GitProvider` abstraction (ADR-0025)
- Forgejo (Gitea fork) — planned, shares Gitea API
- BitBucket (Atlassian)

Worker multi-backend auth (ADR-0025) provides the `GitProvider` interface foundation. CLI platform adapters for push/pull still use `bare` for non-GitHub/GitLab. Dedicated CLI adapters would add CI key storage, repo creation, PR creation. See ADR-0013 future section.

### MCP Gateway Mode (Experimental)

am-cli as a runtime MCP proxy — accept tool calls, route to configured servers, translate responses. Documented in ADR-0021 as experimental. Not recommended until there's a proven use case beyond import/export.

### Enterprise Features

- RBAC for multi-user config repos
- Config.managed.toml for org-level policy enforcement
- Audit logging for compliance
- SSO integration for web UI

### Ecosystem

- VS Code extension (manage am config from IDE sidebar)
- GitHub Action (`am apply` in CI for repo-level config)
- Terraform/Pulumi provider (infrastructure-as-code for agent configs)

---

## ADR Index

30 architectural decisions.

| ADR | Title | Date |
|-----|-------|------|
| 0001 | Layered Core + Adapter Extensions | 2026-04-07 |
| 0002 | Git-Backed Everything | 2026-04-07 |
| 0003 | Hierarchical Config | 2026-04-07 |
| 0004 | TOML Config Format | 2026-04-07 |
| 0005 | Bidirectional Adapters | 2026-04-07 |
| 0006 | Drift Detection Over Overwrite | 2026-04-07 |
| 0007 | Two-Phase Zod Validation | 2026-04-07 |
| 0008 | Profile-Based Config Subsets | 2026-04-07 |
| 0009 | MCP Server Mode | 2026-04-07 |
| 0010 | BunTS Single Binary | 2026-04-07 |
| 0011 | Built-In Adapters | 2026-04-07 |
| 0012 | Application-Level Encryption | 2026-04-07 |
| 0013 | Git Platform Adapters | 2026-04-07 |
| 0014 | Workspace-to-Profile Import | 2026-04-07 |
| 0015 | Stateless Web UI | 2026-04-08 |
| 0016 | Session Harvest | 2026-04-08 |
| 0017 | A2A Protocol Integration | 2026-04-08 |
| 0018 | TUI Framework (Silvery) | 2026-04-08 |
| 0019 | Security Hardening | 2026-04-08 |
| 0020 | Session Knowledge Synthesis | 2026-04-08 |
| 0021 | MCP Tool Grouping + Gateway | 2026-04-10 |
| 0022 | Wiki Location Strategy | 2026-04-10 |
| 0023 | Tiered Secret Detection | 2026-04-10 |
| 0024 | MCP Registry Integration | 2026-04-10 |
| 0025 | Worker Multi-Backend Git Auth | 2026-04-13 |
| 0026 | ACP Runtime Integration via ACPX | 2026-04-15 |
| 0027 | Community Adapter Loading | 2026-04-15 |
| 0028 | Brownfield Import Merge | 2026-04-15 |
| 0029 | Command Grouping | 2026-04-15 |
| 0030 | Unified Agent Registry | 2026-04-16 |

---

## Stats

| Metric | Count |
|--------|-------|
| Source files | 182 |
| Test files | 151 |
| Tests | 1,864 |
| Assertions | 5,512 |
| IDE adapters | 13 (+community) |
| Platform adapters | 3 |
| CLI commands | 31 |
| MCP tools | 33 |
| ADRs | 30 |
| `as any` in src/ | 0 |
| `err: any` in src/ | 0 |
