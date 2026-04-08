---
status: proposed
date: 2026-04-08
---

# ADR-0016: Session Harvest — Cross-Tool Conversation Export and Analysis

## Context

AI coding tools (Claude Code, Kilo Code/Roo Code, Codex, Kiro CLI) each store conversation sessions in incompatible formats and locations:

| Tool | Format | Location |
|------|--------|----------|
| Claude Code | JSONL (typed records: `progress`, `user`, `assistant`) | `~/.claude/projects/<encoded-path>/*.jsonl` |
| Kilo Code | JSON arrays (OpenAI-style content blocks) | `~/Library/Application Support/Code/.../kilocode.kilo-code/tasks/<UUIDv7>/` |
| Codex | JSONL (typed records: `session_meta`, `event_msg`, `response_item`) | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` |
| Kiro CLI | No persistence found | TBD |

Users working across multiple tools have no way to:
1. **List sessions** across tools in a unified view
2. **Export conversations** with consistent formatting and content selectors
3. **Search** session content across tool boundaries
4. **Audit** what an agent did across a project's history (all tools combined)
5. **Share** session transcripts in a portable format for team review or archival

This problem compounds in multi-agent workflows (e.g., Overstory swarm orchestration) where a single project may have sessions spanning Claude Code (orchestrator), Kilo Code (sub-agents), and Codex (quick edits) — all for the same codebase.

`agent-manager` already manages configuration synchronization across these tools. Session harvest is the natural read-side complement: config sync writes tool settings, session harvest reads tool outputs.

## Decision

Add a `session` command group to `agent-manager` that discovers, lists, filters, exports, and searches AI coding session data across all supported adapters.

### New CLI Commands

```bash
# Discovery and listing
am session list                              # All tools, current project
am session list --adapter kilo-code          # Specific tool
am session list --sort cost --reverse        # Sort by estimated cost
am session list --json                       # Machine-readable output

# Export with selectors
am session export <id>                       # Full markdown export
am session export <id> --role user           # User messages only
am session export <id> --role assistant      # AI responses only
am session export <id> --no-tools            # Strip tool_use / tool_result noise
am session export <id> --no-system           # Strip system/init messages
am session export <id> --format json         # Structured JSON
am session export <id> --format raw          # Original format, no filtering

# Search
am session search "authentication"           # Across all tools
am session search "error" --role assistant   # AI responses mentioning errors

# Archival (future)
am session archive <id>                      # Git-commit session export to config repo
```

### Architecture

Extend the existing adapter interface. Each adapter already implements `detect()`, `import()`, `export()`, `diff()`. Add an optional `SessionReader` interface:

```typescript
interface SessionReader {
  /** Check if session storage exists for this tool */
  hasSessionStorage(): boolean;

  /** List sessions, optionally filtered by project path */
  listSessions(project?: string): SessionSummary[];

  /** Fully load a session with all messages */
  loadSession(id: string): Session | null;
}
```

Adapters that support session reading implement `SessionReader`. The core engine provides:

- **Unified model**: `Session` and `Message` types shared across all adapters
- **Selector pipeline**: Role filter → tool-call filter → system filter → dedup
- **Formatters**: Markdown, JSON, raw passthrough
- **Session index cache**: Last `list` result cached for O(1) `export` by row number

### Integration Points

- **Config-aware project resolution**: Use `agent-manager`'s existing project detection (git root, config file presence) to scope sessions to the active project
- **Adapter registry**: Session readers register alongside config adapters — no separate discovery mechanism
- **Profile filtering**: Sessions can be filtered by which profile was active (where the tool supports it)
- **Encryption (ADR-0012)**: Archived sessions inherit the config repo's encryption settings — sensitive session content is encrypted at rest when committed to the config repo

### Prototype

A Claude Code plugin prototype exists at [baladithyab/session-harvest](https://github.com/baladithyab/session-harvest) implementing the adapter pattern in Python (stdlib only). The `agent-manager` implementation will port this to TypeScript and integrate with the existing adapter infrastructure.

## Consequences

### Positive

- **Single tool for session inspection** across all AI coding assistants — no need to remember per-tool storage locations or formats
- **Portable exports** in markdown/JSON enable team sharing, archival, and post-mortem analysis
- **Selector system** reduces noise — export only what matters (e.g., user directives without 500 tool call blocks)
- **Natural extension** of agent-manager's existing adapter architecture — minimal new concepts
- **Search across tools** enables finding "that conversation where I solved X" regardless of which tool was used

### Negative

- **Session storage formats are undocumented** and may change without notice — adapters need defensive parsing and version tolerance
- **Large sessions** (1000+ messages, multi-MB) require streaming or lazy loading to avoid memory pressure
- **Kilo Code sessions lack project association** — sessions are global, requiring heuristic matching via file paths in metadata
- **Privacy surface area** — session content may contain secrets, credentials, or proprietary code; archive/export features must be audit-aware

### Neutral

- Session reading is strictly read-only — no write operations to tool storage, eliminating corruption risk
- Adding session support to a new adapter is optional (`SessionReader` is not required by the base adapter interface)
- Session format parsers are inherently tool-version-coupled; expect maintenance burden proportional to tool update frequency

## Alternatives Considered

### 1. Standalone CLI tool (not integrated into agent-manager)

The prototype (`session-harvest`) takes this approach. While it works, it duplicates adapter discovery logic, project resolution, and configuration that `agent-manager` already provides. Integration avoids this duplication and gives sessions access to profile-aware filtering.

**Rejected because**: duplication of existing infrastructure; fragmented user experience.

### 2. MCP server mode for session access

Expose sessions as MCP resources (`session://list`, `session://export/<id>`) through agent-manager's existing MCP server (ADR-0009). This would allow any MCP-aware tool to query sessions from other tools.

**Not rejected — complementary**: This should be a follow-up. The `read-only` MCP permission tier is a natural fit. But CLI access comes first as the primary interface.

### 3. Cloud-hosted session aggregation

Sync session data to a central service (alongside config sync) for cross-machine session access.

**Deferred**: Introduces significant privacy/compliance complexity. Local-first session reading is sufficient for the initial implementation. Cloud aggregation can be layered on top via the archive-to-git-repo mechanism.

### 4. Real-time session streaming / tailing

Live-tail an active session as it happens, rather than post-hoc export.

**Deferred**: Requires filesystem watchers and tool-specific protocols. The current tools don't expose streaming interfaces. Post-hoc export covers 95% of use cases.

## References

- Prototype implementation: [baladithyab/session-harvest](https://github.com/baladithyab/session-harvest)
- ADR-0001: Layered core + adapter extensions
- ADR-0009: MCP server mode (future integration point)
- ADR-0012: Application-level encryption (archive encryption)
- Claude Code session format: JSONL with `progress`, `user`, `assistant`, `last-prompt` record types
- Kilo Code session format: JSON arrays with OpenAI-style content blocks, UUIDv7 task IDs
- Codex session format: JSONL with `session_meta`, `event_msg`, `response_item`, `turn_context` record types
