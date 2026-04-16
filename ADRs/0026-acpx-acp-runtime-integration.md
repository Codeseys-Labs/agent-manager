---
status: proposed
date: 2026-04-15
---

# ADR-0026: ACP Runtime Integration via ACPX -- am as Agent Orchestrator

## Context

ADR-0017 established a protocol-appropriate integration strategy:
- **MCP:** am configures it AND implements it (done)
- **A2A:** am IS a participant in the agent network (Phase 1 done)
- **ACP:** am configures it but does NOT implement it

ADR-0017 explicitly deferred ACP runtime integration to Phase 4, noting:
> "am does not implement ACP; it configures ACP agent registrations in IDE adapters."

**What changed:** The ACPX project (openclaw/acpx, 2,146 stars, MIT license)
proves that ACP is NOT limited to IDEs. ACPX is a headless CLI client for
ACP that can drive any ACP-compatible coding agent (Claude Code, Codex,
Gemini CLI, Cursor, Copilot, Kiro, etc.) over JSON-RPC stdio. It provides:

- Session management with persistence and crash recovery
- A prompt queue with IPC between concurrent CLI invocations
- Structured NDJSON output format
- A Flows runtime for multi-step agent workflows
- A built-in registry of 16 ACP-compatible agents
- TypeScript SDK: `@agentclientprotocol/sdk` (official, 5 languages)

**The user story that motivated this (real incident, 2026-04-15):** Claude Code's
`migrationVersion: 11` silently wiped all global MCP server configs from
`~/.claude.json`. Recovery required an hour of manual forensics across 5
config formats. agent-manager would have prevented this (`am status` detects
drift, `am apply` restores from TOML source of truth). But the deeper insight
is: **am should be able to tell agents what to do, not just configure them.**

This ADR proposes adding ACP runtime capability to am using the official ACP
SDK (`@agentclientprotocol/sdk`), informed by ACPX's architecture but
implemented as a native am subsystem rather than shelling out to ACPX.

## Decision

### Role Revision: am as ACP Client

Update ADR-0017's assessment. am's three ACP roles become:

1. **ACP config manager** (done via adapters) -- generate ACP agent
   registrations in IDE configs
2. **ACP runtime client** (NEW, this ADR) -- drive coding agents headlessly
   via ACP protocol, orchestrate multi-agent workflows
3. **ACP-A2A bridge** (future) -- receive A2A task delegation requests, execute
   them by spawning ACP agent sessions

### Architecture

```
am-cli
  src/protocols/
    a2a/          # Existing A2A (discovery, delegation, server)
    acp/
      types.ts    # ACP type definitions (expand existing 32-line file)
      client.ts   # ACP client: initialize, session/new, session/prompt, session/update
      session.ts  # Session manager: persistence, queue, reconnect
      registry.ts # Agent registry: built-in + config override + ACP Registry lookup
      flows.ts    # Multi-step workflow engine (inspired by ACPX flows)
```

### Implementation: 4 Phases

#### Phase 1: ACP Client Core (~800 lines)

Add `@agentclientprotocol/sdk` as a dependency and build the client layer:

```typescript
// src/protocols/acp/client.ts
import { AcpClient } from "@agentclientprotocol/sdk";

interface AmAcpClient {
  // Spawn agent subprocess, negotiate capabilities
  connect(agentCommand: string, options?: ConnectOptions): Promise<AcpSession>;

  // Session operations (maps to ACP JSON-RPC methods)
  newSession(client: AcpSession, options: NewSessionOptions): Promise<string>;
  prompt(client: AcpSession, sessionId: string, prompt: PromptPart[]): Promise<PromptResult>;
  cancel(client: AcpSession, sessionId: string): Promise<void>;
  loadSession(client: AcpSession, sessionId: string): Promise<void>;

  // Lifecycle
  disconnect(client: AcpSession): Promise<void>;
}
```

```typescript
// src/protocols/acp/registry.ts
// Agent command resolution: name -> spawn command
// Sources: built-in registry, config overrides, ACP Registry API
const BUILT_IN_REGISTRY: Record<string, string> = {
  claude: "npx -y @agentclientprotocol/claude-agent-acp@latest",
  codex: "npx @zed-industries/codex-acp@latest",
  gemini: "gemini --acp",
  cursor: "cursor-agent acp",
  copilot: "copilot --acp --stdio",
  kiro: "kiro-cli-chat acp",
  // ... more from ACPX registry
};

// Config override in TOML:
// [settings.acp.agents.my-agent]
// command = "./my-custom-agent --acp"
```

New TOML config section:
```toml
[settings.acp]
session_dir = "~/.agent-manager/sessions"
queue_owner_ttl = 300  # seconds

[settings.acp.agents.claude]
command = "npx -y @agentclientprotocol/claude-agent-acp@latest"

[settings.acp.agents.custom]
command = "./my-agent --acp"
```

#### Phase 2: CLI Commands + MCP Tools (~500 lines)

New CLI commands:
```bash
am run claude "fix the failing tests"        # One-shot: spawn, prompt, wait, exit
am run codex "add error handling to api.ts"  # Different agent, same interface
am run --session backend claude "continue"   # Named session, resume previous work

am session list                              # Show active sessions
am session resume <id>                       # Resume a session
am session cancel <id>                       # Cancel active session
```

New MCP tools (in "acp" tool group):

| Tool | Tier | Description |
|------|------|-------------|
| `am_run_agent` | write-remote | Spawn ACP agent, send prompt, return result |
| `am_session_list` | read-only | List active ACP sessions |
| `am_session_resume` | write-remote | Resume a named session |
| `am_session_cancel` | write-remote | Cancel active session |

This enables **any agent using am as an MCP server to orchestrate other agents.**
Claude Code (via `am mcp-serve`) can delegate to Codex, Cursor, or any
ACP-compatible agent.

#### Phase 3: Flows Engine (~600 lines)

Multi-step workflows defined in TypeScript:

```typescript
// flows/code-review.ts
import { defineFlow, acp, compute, action } from "agent-manager/flows";

export default defineFlow({
  name: "code-review",
  nodes: {
    analyze: acp({
      agent: "claude",
      prompt: "Analyze the PR diff and list issues",
    }),
    categorize: compute({
      fn: (input) => ({
        critical: input.issues.filter(i => i.severity === "critical"),
        suggestions: input.issues.filter(i => i.severity === "suggestion"),
      }),
    }),
    fix: acp({
      agent: "codex",
      prompt: "Fix the critical issues: {{critical}}",
      condition: (input) => input.critical.length > 0,
    }),
    test: action({
      command: "npm test",
    }),
  },
  edges: [
    { from: "analyze", to: "categorize" },
    { from: "categorize", to: "fix" },
    { from: "fix", to: "test" },
  ],
});
```

CLI: `am flow run code-review --pr 42`
MCP tool: `am_flow_run` (in "flows" tool group)

#### Phase 4: A2A-ACP Bridge (~400 lines)

Close the loop: am receives A2A task requests and executes them via ACP.

```
External agent ──A2A──> am A2A server ──> route to agent profile
                                          ──> spawn ACP session
                                          ──> return result via A2A
```

This makes am a true **protocol bridge**: external agents discover am's
capabilities via A2A AgentCards, delegate tasks via A2A JSON-RPC, and am
fulfills them by driving coding agents via ACP.

### Why Native SDK, Not Shell Out to ACPX

Three options were evaluated:

1. **Shell out to `acpx` CLI** -- Simple but adds a runtime dependency,
   loses type safety, and ACPX's session management would conflict with am's.

2. **Import `acpx` as a library** -- ACPX doesn't export a clean library
   interface; it's a CLI-first project. Its internals (queue system, session
   routing by git root) are tightly coupled to CLI usage.

3. **Use `@agentclientprotocol/sdk` directly** (chosen) -- The official ACP
   TypeScript SDK is the same dependency ACPX uses internally. Building on
   the SDK gives am full control over session lifecycle, persistence, and
   integration with am's existing config/profile/git systems.

ACPX's architecture informs the design (session persistence, queue pattern,
crash recovery, agent registry), but the implementation is native to am.

## Consequences

### Positive

- am becomes a **runtime coordinator**, not just a config manager
- Any agent can orchestrate any other agent via am's MCP tools
- Multi-agent workflows become first-class (Flows engine)
- A2A-ACP bridge closes the protocol loop (discover via A2A, control via ACP,
  provide tools via MCP)
- Agent registry inherits from ACPX's proven registry + ACP Registry standard
- Session persistence enables long-running agent workflows with crash recovery

### Negative

- New dependency: `@agentclientprotocol/sdk` (npm package)
- ACP spec is pre-1.0 -- breaking changes possible
- Session management adds state beyond am's current "config is everything" model
- Flows engine is a significant new subsystem (~600 lines)
- Testing requires mocking ACP agent subprocesses

### Neutral

- ADR-0017 Phase 4 (ACP integration) is no longer "deferred" -- it has a
  concrete implementation path
- ACPX and am may overlap for users who want headless agent control -- am's
  value-add is the config management layer (profiles, drift detection, git sync)
  that ACPX doesn't have

## Alternatives Considered

### 1. Bundle ACPX as a dependency

Rejected because ACPX is CLI-first with tightly coupled internals. Its session
routing (git root walking), queue system (Unix sockets), and config format
(`.acpxrc.json`) would conflict with am's own systems.

### 2. Implement ACP server instead of client

Rejected because am is not a coding agent. ACP servers are agents that receive
prompts and edit code. am is a coordinator that should send prompts to agents,
not receive them. (MCP server mode already covers the "am as a tool" use case.)

### 3. Wait for ACP v1.0

Rejected because the SDK is stable enough for production use (ACPX, Zed, and
JetBrains all depend on it), and am can pin the SDK version. The core session
lifecycle (initialize, session/new, session/prompt, session/update) is unlikely
to change fundamentally.

## References

- ADR-0017: Multi-Protocol Agent Integration (A2A, ACP, MCP)
- ACPX: github.com/openclaw/acpx (MIT, 2,146 stars)
- ACP spec: agentclientprotocol.com
- ACP TypeScript SDK: @agentclientprotocol/sdk (v0.18.0+)
- ACP Registry: github.com/agentclientprotocol/registry
- User story: Codeseys-Labs/agent-manager#1 (config wipe incident)
