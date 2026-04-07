# Kiro Configuration Research

> Research date: 2026-04-07
> Sources: kiro.dev/docs, dev.to, datacamp.com, builder.aws.com, kiro.directory

## 1. What is Kiro?

Kiro is AWS's agentic AI IDE built on Code OSS (VS Code base). It also ships a CLI
(`kiro` command). The key differentiator is **spec-driven development** -- turning
ideas into structured requirements, design docs, and implementation task lists before
writing code.

- **IDE**: VS Code fork with AI agent panel, spec UI, hooks UI, MCP panel
- **CLI**: Terminal-based agent, same `.kiro/` config, same steering/MCP/agents
- **Pricing**: $19-39/mo (free tier available)
- **Models**: Amazon Nova Pro, Claude Sonnet 3.7, Claude Sonnet 4 (via Bedrock)
- **Tagline**: "Agentic AI development from prototype to production"

Key concepts:
- **Specs**: Structured requirements -> design -> tasks workflow
- **Steering**: Markdown files that guide AI behavior (like CLAUDE.md)
- **Hooks**: Event-driven automation (like Claude Code hooks)
- **Powers**: Bundled MCP + steering that activates contextually
- **Skills**: Portable instruction packages (agentskills.io standard)
- **Custom Agents**: JSON-configured agent profiles with scoped tools/MCP/hooks

## 2. Directory Structure

```
project-root/
  .kiro/
    settings/
      mcp.json              # MCP server configuration (workspace-level)
    steering/
      *.md                  # Steering files (project instructions)
    agents/
      *.json                # Custom agent configurations
    skills/
      <skill-name>/
        SKILL.md            # Skill definition (agentskills.io standard)
        scripts/            # Optional executable scripts
        references/         # Optional docs
        assets/             # Optional templates
    specs/
      <feature-name>/
        requirements.md     # EARS-format requirements
        design.md           # Technical architecture
        tasks.md            # Implementation checklist
    hooks/                  # Hook configurations (IDE format)
    prompts/
      *.md                  # Reusable prompts (invoked with @prompt-name)
    powers/                 # Installed powers
      <power-name>/
        POWER.md            # Power definition
        mcp.json            # Power's MCP config
        steering/           # Power-specific steering

~/.kiro/                    # User-level (global) config
  settings/
    mcp.json                # Global MCP servers
  steering/
    *.md                    # Global steering files
  agents/
    *.json                  # Global custom agents
  skills/
    <skill-name>/
      SKILL.md              # Global skills
```

## 3. MCP Server Configuration

### File Locations
- **Workspace**: `.kiro/settings/mcp.json`
- **User (global)**: `~/.kiro/settings/mcp.json`

### Format

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "string",        // Required (local) - command to run
      "args": ["string"],         // Required (local) - command arguments
      "env": { "KEY": "VALUE" },  // Optional - environment variables
      "disabled": false,          // Optional - disable without removing
      "autoApprove": ["*"],       // Optional - tools to auto-approve
      "disabledTools": ["tool"],  // Optional - tools to omit
      "timeout": 120000           // Optional - request timeout in ms

      // -- OR for remote servers --
      "url": "https://...",       // Required (remote) - HTTPS endpoint
      "headers": { "H": "V" },   // Optional - HTTP headers
      "oauth": {                  // Optional - OAuth config
        "redirectUri": "127.0.0.1:7778",
        "oauthScopes": ["read", "write"]
      }
    }
  }
}
```

### Comparison to Claude Code

| Feature | Kiro | Claude Code |
|---------|------|-------------|
| Config file | `.kiro/settings/mcp.json` | `.mcp.json` (project) or `~/.claude.json` |
| Format key | `mcpServers` | `mcpServers` |
| Server fields | command, args, env, disabled, autoApprove, disabledTools, timeout, oauth | command, args, env, disabled |
| Remote support | url + headers + oauth | Not native (use mcp-proxy) |
| Global location | `~/.kiro/settings/mcp.json` | `~/.claude.json` mcpServers |
| Auto-approve | `autoApprove: ["*"]` or tool list | Via settings.json allowedTools |
| Disable tools | `disabledTools: ["tool"]` | Not supported |

### Adapter Notes

The MCP format is very close to Claude Code's. Key differences:
1. Kiro adds `autoApprove`, `disabledTools`, `timeout` per server
2. Kiro supports remote/HTTP servers natively with `url` instead of `command`
3. Kiro supports OAuth configuration for remote servers
4. Config path is `.kiro/settings/mcp.json` vs `.mcp.json`

## 4. Steering (Project Instructions)

Steering files are Kiro's equivalent of Claude Code's `CLAUDE.md`. They are markdown
files in `.kiro/steering/` that shape agent behavior.

### File Location
- **Workspace**: `.kiro/steering/*.md`
- **Global**: `~/.kiro/steering/*.md`

### Inclusion Modes

Steering files support different loading strategies:

| Mode | Behavior |
|------|----------|
| `always` | Loaded in every interaction (like CLAUDE.md) |
| `auto` | Loaded when description matches user request |
| `fileMatch` | Loaded when matching file patterns are active |
| `manual` | Only loaded via slash command (`/steering-name`) |

Auto-inclusion steering files also appear as slash commands in chat.

### File References

Steering can reference live workspace files:
```markdown
# API Standards
See current API spec: #<path/to/openapi.yaml>
```

### AGENTS.md Support

Kiro also supports `AGENTS.md` files (the emerging cross-tool standard):
- Place at workspace root or in `~/.kiro/steering/`
- Always included (no inclusion mode selection)
- Markdown format, similar to steering files

### Comparison to Claude Code

| Feature | Kiro | Claude Code |
|---------|------|-------------|
| Instructions file | `.kiro/steering/*.md` (multiple) | `CLAUDE.md` (single + parent chain) |
| Global instructions | `~/.kiro/steering/*.md` | `~/.claude/CLAUDE.md` |
| Conditional loading | always, auto, fileMatch, manual | Always loaded |
| Cross-tool standard | AGENTS.md support | CLAUDE.md only |
| File references | `#<path>` syntax | Not supported |

### Adapter Notes

1. Claude Code has a single `CLAUDE.md` file; Kiro has multiple steering files with modes
2. An adapter must map between single-file and multi-file instruction models
3. Kiro's inclusion modes have no Claude Code equivalent -- they'd need to be flattened
4. AGENTS.md is a shared standard that could serve as a bridge

## 5. Custom Agents (Agent Profiles)

Kiro's most distinctive configuration feature. JSON files that define complete agent
personas with scoped tools, MCP servers, hooks, and resources.

### File Locations
- **Workspace**: `.kiro/agents/<name>.json`
- **Global**: `~/.kiro/agents/<name>.json`

Filename (without `.json`) becomes the agent name.

### Full Schema

```json
{
  "name": "string",                    // Optional (derived from filename)
  "description": "string",            // What the agent does
  "prompt": "string | file://path",   // System prompt (inline or file ref)
  "mcpServers": {                      // Agent-specific MCP servers
    "<name>": {
      "command": "string",
      "args": ["string"],
      "env": {},
      "timeout": 120000,
      "oauth": {}
    }
  },
  "tools": [                           // Available tools
    "read",                            // Built-in tool
    "write",
    "shell",
    "@git",                            // All tools from MCP server
    "@rust-analyzer/check_code",       // Specific MCP tool
    "*",                               // Wildcard: all tools
    "@builtin"                         // All built-in tools
  ],
  "toolAliases": {                     // Rename tools (resolve collisions)
    "@github-mcp/get_issues": "github_issues",
    "@gitlab-mcp/get_issues": "gitlab_issues"
  },
  "allowedTools": [                    // Auto-approved tools (no prompt)
    "read",
    "@git/git_status",
    "@server/read_*",                  // Glob patterns supported
    "@fetch"
  ],
  "toolsSettings": {                   // Per-tool config
    "write": {
      "allowedPaths": ["~/**"]
    }
  },
  "resources": [                       // Context resources
    "file://README.md",                // File loaded at startup
    "file://.kiro/steering/**/*.md",   // Glob patterns
    "skill://.kiro/skills/**/SKILL.md" // Skills (progressive loading)
  ],
  "hooks": {                           // Agent-specific hooks
    "agentSpawn": [
      { "command": "git status" }
    ],
    "userPromptSubmit": [
      { "command": "ls -la" }
    ],
    "preToolUse": [
      {
        "matcher": "execute_bash",
        "command": "echo audit >> /tmp/log"
      }
    ],
    "postToolUse": [
      {
        "matcher": "fs_write",
        "command": "cargo fmt --all"
      }
    ]
  },
  "includeMcpJson": true,             // Include workspace mcp.json servers
  "useLegacyMcpJson": true,           // Use legacy mcp.json format
  "model": "claude-sonnet-4",         // Model override
  "keyboardShortcut": "ctrl+r",       // Quick switch shortcut
  "welcomeMessage": "Ready to help!"  // Greeting on agent switch
}
```

### Agent Interaction
- Switch agents: `/agent swap <name>`
- Generate agent config: `/agent generate`
- List agents: `/agent list`

### Comparison to Claude Code

Claude Code has NO equivalent to custom agents. The closest concepts:
- **System prompt**: Claude Code uses `CLAUDE.md` (no per-agent profiles)
- **Model selection**: Claude Code has `model` in settings but no per-context model
- **Tool permissions**: Claude Code has `allowedTools` in settings.json
- **Hooks**: Claude Code has hooks in settings.json but not per-agent

### Adapter Notes

This is a major feature gap. An adapter would need to:
1. Store agent profiles as a Kiro-specific concept
2. Map `prompt` to steering/CLAUDE.md content
3. Map `mcpServers` to the MCP config
4. Map `tools`/`allowedTools` to permission settings
5. Map `hooks` to the hooks system
6. Map `resources` to context injection mechanisms
7. Handle `model` as a tool-specific override

## 6. Hooks System

### IDE Hooks

Created via the Kiro panel UI or natural language. Stored in `.kiro/hooks/`.

**Event Types (IDE):**
| Event | Trigger |
|-------|---------|
| File Save | When a file matching a pattern is saved |
| File Created | When a new file is created |
| File Deleted | When a file is deleted |
| Manual Trigger | On-demand via panel |
| Prompt Submit | When user submits a prompt |
| Agent Stop | When agent completes |
| Spec Task (Before/After) | Around spec task execution |

### CLI Hooks

Defined in agent configuration JSON (see Section 5).

**Hook Event Types (CLI):**
| Hook | Trigger | STDIN Event |
|------|---------|-------------|
| `agentSpawn` | Agent activated | `{ "hook_event_name": "agentSpawn", "cwd": "..." }` |
| `userPromptSubmit` | User submits prompt | `{ "hook_event_name": "userPromptSubmit", "cwd": "...", "prompt": "..." }` |
| `preToolUse` | Before tool execution | `{ "hook_event_name": "preToolUse", "cwd": "...", "tool_name": "...", "tool_input": {...} }` |
| `postToolUse` | After tool execution | `{ "hook_event_name": "postToolUse", "cwd": "...", "tool_name": "...", "tool_input": {...} }` |

**Hook Properties (CLI):**
```json
{
  "command": "string",     // Shell command to execute
  "matcher": "string"      // Tool name matcher (for pre/postToolUse)
}
```

**Matcher Patterns:**
- `"fs_write"` or `"write"` -- Match write tool
- `"fs_read"` or `"read"` -- Match read tool
- `"execute_bash"` or `"shell"` -- Match shell execution
- `"@git"` -- All tools from git MCP server
- `"@git/status"` -- Specific MCP tool
- `"*"` -- All tools (built-in and MCP)
- `"@builtin"` -- All built-in tools only
- No matcher -- Applies to all tools

**Exit Code Behavior:**
- `0`: Success, STDOUT added to agent context
- Non-zero: Show STDERR warning (preToolUse blocks the tool)

### Comparison to Claude Code

| Feature | Kiro (CLI) | Claude Code |
|---------|-----------|-------------|
| Hook config | In agent JSON | In `.claude/settings.local.json` |
| Events | agentSpawn, userPromptSubmit, preToolUse, postToolUse | PreToolUse, PostToolUse, Notification, Stop, UserPromptSubmit |
| Matcher | Tool name patterns with globs | Tool name match |
| STDIN | Full JSON event object | JSON event object |
| Scope | Per-agent | Global |

### Adapter Notes

Hook systems are very similar conceptually. Key differences:
1. Kiro hooks are per-agent; Claude Code hooks are global
2. Kiro CLI hooks are in agent JSON; Claude Code hooks in settings.json
3. Kiro IDE hooks are a separate UI-driven system
4. Event names differ slightly but map 1:1
5. Matcher patterns are compatible conceptually

## 7. Specs System

Kiro's unique feature -- no equivalent in Claude Code, Cursor, or other tools.

### Spec Types
1. **Feature Specs** -- For new features
2. **Bug Specs** -- For bug fixes

### Spec Files (per feature)

Located in `.kiro/specs/<feature-name>/`:

| File | Content |
|------|---------|
| `requirements.md` | User stories + acceptance criteria (EARS format) |
| `design.md` | System architecture, sequence diagrams, data models, error handling |
| `tasks.md` | Checklist of implementation tasks with status tracking |

### Workflow
1. User describes feature in natural language
2. Kiro generates `requirements.md` (EARS notation)
3. User reviews/edits requirements
4. Kiro generates `design.md` (architecture + diagrams)
5. User reviews/edits design
6. Kiro generates `tasks.md` (implementation checklist)
7. Tasks are executed individually with real-time status updates

### Adapter Notes

Specs are Kiro-specific and have no direct equivalent in other tools. An adapter would:
1. Store spec files as Kiro-specific artifacts
2. Not attempt to translate them to other tools
3. Potentially map `tasks.md` to a generic task list format

## 8. Skills

Skills follow the open [agentskills.io](https://agentskills.io) standard, making them
portable across tools (Claude Code also supports this format).

### File Structure
```
.kiro/skills/<skill-name>/
  SKILL.md            # Required
  scripts/            # Optional
  references/         # Optional
  assets/             # Optional
```

### SKILL.md Format
```markdown
---
name: pr-review
description: Review pull requests for code quality, security issues, and test coverage.
license: MIT
compatibility: requires git
metadata:
  author: team-name
  version: 1.0.0
---

## Review process
1. Check for security vulnerabilities
2. Verify error handling
...
```

### Frontmatter Fields
| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Must match folder name (lowercase, hyphens, max 64 chars) |
| `description` | Yes | When to activate (max 1024 chars) |
| `license` | No | License info |
| `compatibility` | No | Environment requirements |
| `metadata` | No | Key-value pairs (author, version) |

### Behavior
- **Discovery**: Name + description loaded at startup
- **Activation**: Full SKILL.md loaded when request matches description
- **Execution**: Scripts/references loaded on demand

### Comparison to Claude Code

Both support agentskills.io standard. Location differs:
- Kiro: `.kiro/skills/` (workspace) or `~/.kiro/skills/` (global)
- Claude Code: `.claude/skills/` (workspace) or `~/.claude/skills/` (global)

### Adapter Notes

Skills are highly portable between Kiro and Claude Code. The adapter mainly needs to
handle the different directory paths (`.kiro/skills/` vs `.claude/skills/`).

## 9. Powers

Powers are Kiro-unique bundles that combine MCP servers + steering + hooks into
contextually-activated packages. No equivalent in Claude Code.

### Structure
```
power-<name>/
  POWER.md              # Required - metadata + instructions
  mcp.json              # Optional - MCP server config
  steering/             # Optional - workflow guidance files
    *.md
```

### POWER.md Frontmatter
```yaml
---
name: "supabase"
displayName: "Supabase with local CLI"
description: "Build fullstack apps with Supabase's Postgres database..."
keywords: ["database", "postgres", "auth", "storage", "supabase"]
---
```

### Behavior
- Powers activate dynamically when conversation matches keywords
- MCP tools load on-demand (not all upfront)
- Steering files provide context-specific guidance
- One-click install from kiro.dev or GitHub URLs

### Adapter Notes

Powers are Kiro-specific. An adapter would:
1. Store power configs as Kiro-specific artifacts
2. Extract the `mcp.json` portion for cross-tool MCP management
3. Not attempt to translate the POWER.md/steering to other tools

## 10. Prompts

Reusable prompt templates stored as markdown files.

### File Location
- `.kiro/prompts/*.md`

### Usage
- Invoked with `@prompt-name` in chat
- Loaded as additional context alongside the conversation

### Comparison to Claude Code
Claude Code has no direct equivalent. The closest is slash-command skills.

## 11. AGENTS.md Standard

Kiro supports the emerging AGENTS.md standard (cross-tool):
- Place at workspace root or `~/.kiro/steering/`
- Always included in context
- Markdown format
- Works alongside Kiro-specific steering files

## 12. Complete Config Map for Adapter

### Files the Adapter Must Handle

| Config Type | Path | Format | Cross-Tool? |
|-------------|------|--------|-------------|
| MCP Servers | `.kiro/settings/mcp.json` | JSON | Yes (translate) |
| MCP Servers (global) | `~/.kiro/settings/mcp.json` | JSON | Yes (translate) |
| Steering | `.kiro/steering/*.md` | Markdown | Partial (AGENTS.md) |
| Steering (global) | `~/.kiro/steering/*.md` | Markdown | Partial |
| Custom Agents | `.kiro/agents/*.json` | JSON | No (Kiro-only) |
| Custom Agents (global) | `~/.kiro/agents/*.json` | JSON | No (Kiro-only) |
| Skills | `.kiro/skills/*/SKILL.md` | Markdown | Yes (agentskills.io) |
| Skills (global) | `~/.kiro/skills/*/SKILL.md` | Markdown | Yes |
| Powers | `.kiro/powers/*/POWER.md` | Markdown+JSON | No (Kiro-only) |
| Specs | `.kiro/specs/*/` | Markdown | No (Kiro-only) |
| Hooks (IDE) | `.kiro/hooks/` | UI-driven | Partial |
| Hooks (CLI) | In agent JSON | JSON | Partial (translate) |
| Prompts | `.kiro/prompts/*.md` | Markdown | No |
| AGENTS.md | `AGENTS.md` (root) | Markdown | Yes (standard) |

### Adapter Implementation Priority

**High Priority (cross-tool portable):**
1. MCP server config -- nearly identical format, path translation only
2. Skills -- agentskills.io standard, path translation only
3. AGENTS.md -- emerging cross-tool standard

**Medium Priority (translatable with loss):**
4. Steering -> CLAUDE.md -- multi-file to single-file, lose inclusion modes
5. Hooks -- similar concept, different config locations and event names
6. Tool permissions -- `allowedTools` maps to Claude Code settings

**Low Priority (Kiro-specific, store but don't translate):**
7. Custom Agents -- no equivalent in other tools
8. Powers -- Kiro-unique bundle format
9. Specs -- Kiro-unique development workflow
10. Prompts -- Kiro-specific feature

### MCP Config Translation

```
Kiro .kiro/settings/mcp.json        <-->  Claude .mcp.json
  mcpServers.<name>.command          <-->  mcpServers.<name>.command
  mcpServers.<name>.args             <-->  mcpServers.<name>.args
  mcpServers.<name>.env              <-->  mcpServers.<name>.env
  mcpServers.<name>.disabled         <-->  mcpServers.<name>.disabled
  mcpServers.<name>.autoApprove      <-->  (settings.json allowedTools)
  mcpServers.<name>.disabledTools    <-->  (no equivalent)
  mcpServers.<name>.timeout          <-->  (no equivalent)
  mcpServers.<name>.url              <-->  (use mcp-proxy wrapper)
  mcpServers.<name>.oauth            <-->  (no equivalent)
```

### Hook Event Translation

```
Kiro CLI Hook               <-->  Claude Code Hook
  agentSpawn                 <-->  (no equivalent)
  userPromptSubmit           <-->  UserPromptSubmit
  preToolUse                 <-->  PreToolUse
  postToolUse                <-->  PostToolUse
  (no equivalent)            <-->  Stop
  (no equivalent)            <-->  Notification
```

## 13. Key Takeaways for Adapter Design

1. **MCP is the easiest bridge** -- nearly identical format, just different file paths
2. **Skills are portable** -- agentskills.io standard works across both tools
3. **Steering vs CLAUDE.md** is the trickiest translation -- multi-file with modes vs single-file
4. **Custom Agents are Kiro's killer feature** -- no equivalent elsewhere, must be stored as-is
5. **Powers and Specs** are Kiro-only innovations -- store but don't translate
6. **Hooks are similar** but scoped differently (per-agent vs global)
7. **AGENTS.md** is an emerging standard both tools support -- good neutral format
8. **Detection**: Check for `.kiro/` directory to identify Kiro projects
9. **Global config**: `~/.kiro/` for user-level settings (parallel to `~/.claude/`)
