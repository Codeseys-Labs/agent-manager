# OpenAI Codex CLI — Configuration Format Research

> Research date: 2026-04-07
> Sources: developers.openai.com/codex/*, github.com/openai/codex

## 1. Config File Locations

| Level | Path | Notes |
|-------|------|-------|
| System | `/etc/codex/config.toml` | Unix only, lowest precedence |
| User | `~/.codex/config.toml` | Primary personal config |
| Project | `.codex/config.toml` | Repo root or subdirectories; **trusted projects only** |
| CLI override | `--config key=value` | Highest precedence, per-invocation |
| Profile | `--profile <name>` | Activates a named profile block |
| Env override | `CODEX_HOME` | Overrides `~/.codex` base path |

**Loading order (highest to lowest precedence):**
1. CLI flags and `--config` overrides
2. Profile values (via `--profile <name>`)
3. Project `.codex/config.toml` (closest to CWD wins; trusted only)
4. User `~/.codex/config.toml`
5. System `/etc/codex/config.toml`
6. Built-in defaults

**Trust model:** Project configs only load for explicitly trusted projects. Untrusted
projects fall back to user/system/built-in defaults. Enterprise `requirements.toml`
can prohibit certain settings.

## 2. Config Format: TOML

Codex uses **TOML** exclusively for configuration. No JSON/YAML alternatives.

### Key Directories and Files

```
~/.codex/
  config.toml          # user config
  auth.json            # cached credentials (or OS keyring)
  history.jsonl        # session transcripts
  log/                 # log files
  agents/              # custom agent definitions (*.toml)
  AGENTS.md            # global instructions
  AGENTS.override.md   # global instruction override
  themes/              # custom .tmTheme files

.codex/                # project-scoped (in repo)
  config.toml          # project config
  agents/              # project-scoped agent defs (*.toml)
  hooks.json           # lifecycle hooks (experimental)
```

## 3. Core Config Schema

### Top-Level Keys

```toml
model = "gpt-5.4"
model_provider = "openai"              # references [model_providers.<id>]
approval_policy = "on-request"         # untrusted | on-request | never | { granular = {...} }
sandbox_mode = "workspace-write"       # read-only | workspace-write | danger-full-access
personality = "pragmatic"              # none | friendly | pragmatic
profile = "default"                    # default profile to activate
web_search = "cached"                  # disabled | cached | live
file_opener = "vscode"                 # vscode | cursor | windsurf | vscode-insiders | none
service_tier = "flex"                  # flex | fast
log_dir = "/path/to/logs"
```

### Model & Reasoning

```toml
model_reasoning_effort = "medium"         # minimal | low | medium | high | xhigh
model_reasoning_summary = "auto"          # auto | concise | detailed | none
model_verbosity = "medium"                # low | medium | high (GPT-5 only)
model_context_window = 128000
model_auto_compact_token_limit = 64000
model_supports_reasoning_summaries = true
review_model = "gpt-5.4"                  # model for /review command
plan_mode_reasoning_effort = "high"
```

### Instructions

```toml
developer_instructions = "Extra instructions injected into session"
model_instructions_file = "/path/to/instructions.txt"   # replaces built-in instructions
compact_prompt = "Override for history compaction prompt"
commit_attribution = "Name <email>"        # co-author trailer; "" disables
project_doc_max_bytes = 32768              # max bytes from AGENTS.md
project_doc_fallback_filenames = ["CLAUDE.md", "CURSOR_RULES.md"]  # fallbacks if no AGENTS.md
```

### Approval Policy (Granular)

```toml
approval_policy = { granular = {
  sandbox_approval = true,
  rules = true,
  mcp_elicitations = true,
  request_permissions = false,
  skill_approval = false
} }
```

## 4. MCP Server Configuration

MCP servers are configured under `[mcp_servers.<id>]` tables. Two transport types:

### STDIO Transport

```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env = { API_KEY = "value" }
env_vars = ["ANOTHER_SECRET"]        # forward from parent env
cwd = "/path/to/server"
enabled = true
required = false
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled_tools = ["search", "summarize"]
disabled_tools = ["slow-tool"]
scopes = ["read:docs"]               # OAuth scopes
oauth_resource = "https://docs.example.com/"
```

### Streamable HTTP Transport

```toml
[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
http_headers = { "X-Region" = "us-east-1" }
env_http_headers = { "X-Auth" = "AUTH_ENV" }
enabled = true
required = true
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled_tools = ["list_issues"]
disabled_tools = ["delete_issue"]
```

### MCP CLI Commands

```bash
codex mcp add <name> -- <command> [args]    # stdio
codex mcp add <name> --url https://...      # HTTP
codex mcp list [--json]
codex mcp get <name> [--json]
codex mcp login <name> [--scopes s1,s2]     # OAuth
codex mcp logout <name>
codex mcp remove <name>
```

### MCP OAuth Settings (top-level)

```toml
mcp_oauth_callback_port = 8080
mcp_oauth_callback_url = "https://devbox.example.com/callback"
mcp_oauth_credentials_store = "auto"   # auto | file | keyring
```

### All MCP Server Fields

| Field | Type | Transport | Default | Description |
|-------|------|-----------|---------|-------------|
| `command` | string | stdio | -- | Server launch command |
| `args` | string[] | stdio | -- | Command arguments |
| `env` | map | stdio | -- | Env vars for server process |
| `env_vars` | string[] | stdio | -- | Env vars to forward from host |
| `cwd` | string | stdio | -- | Working directory |
| `url` | string | HTTP | -- | Server endpoint URL |
| `bearer_token_env_var` | string | HTTP | -- | Bearer token env var |
| `http_headers` | map | HTTP | -- | Static HTTP headers |
| `env_http_headers` | map | HTTP | -- | Headers from env vars |
| `enabled` | bool | both | true | Enable/disable toggle |
| `required` | bool | both | false | Fail startup if unavailable |
| `enabled_tools` | string[] | both | -- | Tool allowlist |
| `disabled_tools` | string[] | both | -- | Tool denylist (after allowlist) |
| `startup_timeout_sec` | number | both | 10 | Startup timeout |
| `startup_timeout_ms` | number | both | -- | Startup timeout (ms alias) |
| `tool_timeout_sec` | number | both | 60 | Per-tool timeout |
| `scopes` | string[] | both | -- | OAuth scopes |
| `oauth_resource` | string | both | -- | RFC 8707 OAuth resource |

## 5. Instructions System (AGENTS.md)

### Discovery Order (per directory level)

1. `AGENTS.override.md` (if exists, used exclusively)
2. `AGENTS.md`
3. Fallback filenames from `project_doc_fallback_filenames`

At most one file per directory. Discovery walks from `~/.codex/` (global), then
project root down to CWD (project scope).

### How Instructions Are Injected

Each discovered file becomes a user-role message:
```
# AGENTS.md instructions for <directory>
<INSTRUCTIONS>
...file contents...
</INSTRUCTIONS>
```

Messages are injected near the top of conversation history, before the user prompt,
in root-to-leaf order (global first, then repo root, then deeper directories).

### AGENTS.md Best Practices

Free-form markdown. Recommended content:
- Repo layout and important directories
- Build, test, lint commands
- Engineering conventions and PR expectations
- Constraints and "do-not" rules
- Definition of "done" and verification steps

The `/init` slash command scaffolds a starter `AGENTS.md`.

## 6. Profiles

Defined under `[profiles.<name>]` in config.toml. Activated via `--profile <name>`
or `profile = "<name>"` at top level.

```toml
[profiles.deep-review]
model = "gpt-5-pro"
model_provider = "openai"
model_reasoning_effort = "high"
approval_policy = "never"
sandbox_mode = "read-only"
service_tier = "fast"
personality = "pragmatic"
web_search = "live"
model_instructions_file = "~/.codex/work-instructions.md"
model_catalog_json = "~/.codex/work-catalog.json"
oss_provider = "ollama"
plan_mode_reasoning_effort = "high"
tools_view_image = true

[profiles.deep-review.analytics]
enabled = false
```

Profiles can override most top-level keys. They are **experimental** and unsupported
in the IDE extension.

## 7. Custom Model Providers

```toml
[model_providers.my_provider]
name = "My Provider"
base_url = "https://api.example.com/v1"
env_key = "MY_PROVIDER_API_KEY"
env_key_instructions = "Set MY_PROVIDER_API_KEY"
wire_api = "responses"              # only "responses" supported
requires_openai_auth = false
supports_websockets = true
request_max_retries = 4
stream_max_retries = 5
stream_idle_timeout_ms = 300000
http_headers = { "X-Custom" = "value" }
env_http_headers = { "X-Org" = "ORG_ENV_VAR" }
query_params = { api-version = "2025-04-01-preview" }
```

Built-in providers: `openai`, `ollama`, `lmstudio`.

## 8. Agent / Subagent System

### Global Agent Settings

```toml
[agents]
max_threads = 6           # concurrent agent threads
max_depth = 1             # nesting depth (root = 0)
job_max_runtime_seconds = 1800
```

### Built-in Agents

- `default` — general-purpose fallback
- `worker` — execution/implementation focused
- `explorer` — read-heavy codebase exploration

### Custom Agent Definitions

Stored as `.toml` files in `~/.codex/agents/` (personal) or `.codex/agents/` (project).

```toml
# ~/.codex/agents/reviewer.toml
name = "reviewer"
description = "PR reviewer focused on correctness, security, and missing tests."
developer_instructions = """
Review code like an owner.
Prioritize correctness, security, behavior regressions, and missing test coverage.
"""
nickname_candidates = ["Atlas", "Delta", "Echo"]
# Optional overrides (inherit from parent if omitted):
# model = "gpt-5-pro"
# model_reasoning_effort = "high"
# sandbox_mode = "read-only"
# mcp_servers = ...
# skills.config = ...
```

### Agent Reference in config.toml

```toml
[agents.reviewer]
description = "Find correctness, security, and test risks in code."
config_file = "./agents/reviewer.toml"
nickname_candidates = ["Athena", "Ada"]
```

### Key Behaviors

- Codex only spawns subagents when explicitly asked
- Subagents inherit parent session's sandbox policy
- Custom agents override built-ins with the same name
- CSV batch processing via `spawn_agents_on_csv` (experimental)

## 9. Permissions System

```toml
default_permissions = "my_profile"   # top-level default

[permissions.my_profile]
[permissions.my_profile.filesystem]
"/home/user/project" = "write"
"/etc" = "read"

[permissions.my_profile.filesystem.":project_roots"]
"." = "write"
"dist" = "none"

[permissions.my_profile.network]
enabled = true
mode = "limited"                    # limited | full
allowed_domains = ["api.example.com"]
denied_domains = ["evil.com"]
allow_local_binding = false
```

## 10. Sandbox Configuration

```toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
writable_roots = ["/Users/me/.pyenv/shims"]
network_access = false
exclude_tmpdir_env_var = false
exclude_slash_tmp = false
```

Three modes: `read-only` (default), `workspace-write`, `danger-full-access`.

## 11. Other Sections

### Features

```toml
[features]
unified_exec = true       # PTY-backed exec tool
shell_tool = true          # default shell tool
multi_agent = true         # multi-agent collaboration
fast_mode = true           # fast mode / service_tier
personality = true         # personality selection
codex_hooks = false        # lifecycle hooks (experimental)
smart_approvals = false    # guardian reviewer subagent (experimental)
undo = false               # undo support
apps = false               # ChatGPT Apps/connectors (experimental)
```

### History

```toml
[history]
persistence = "save-all"   # save-all | none
max_bytes = 10485760
```

### Shell Environment Policy

```toml
[shell_environment_policy]
inherit = "core"           # all | core | none
include_only = ["PATH", "HOME"]
exclude = ["*SECRET*", "*TOKEN*"]
set = { MY_VAR = "value" }
```

### TUI

```toml
[tui]
theme = "catppuccin-mocha"
animations = true
notifications = true       # or ["agent-turn-complete", "approval-requested"]
alternate_screen = "auto"
```

### Skills

```toml
[[skills.config]]
path = "~/.codex/skills/my_skill"
enabled = true
```

### Projects Trust

```toml
[projects."/path/to/project"]
trust_level = "trusted"    # trusted | untrusted
```

### Notifications

```toml
notify = ["python3", "/path/to/notify.py"]
# Receives JSON: { type, thread-id, turn-id, cwd, input-messages, last-assistant-message }
```

### OpenTelemetry

```toml
[otel]
environment = "dev"
exporter = "none"          # none | otlp-http | otlp-grpc
log_user_prompt = false
```

## 12. Adapter Implications for agent-manager

### What the adapter needs to handle:

1. **Config format:** TOML read/write (not JSON like Claude Code or Kiro)
2. **Two config layers:** `~/.codex/config.toml` (user) and `.codex/config.toml` (project)
3. **MCP servers:** `[mcp_servers.<id>]` tables with two transport types (stdio, HTTP)
   - Shares most fields with Claude Code but adds: `env_vars`, `bearer_token_env_var`,
     `http_headers`, `env_http_headers`, `scopes`, `oauth_resource`, `required`,
     `enabled_tools`, `disabled_tools`, `startup_timeout_sec`, `tool_timeout_sec`
4. **Instructions:** AGENTS.md files (free-form markdown), plus `developer_instructions`
   and `model_instructions_file` in config.toml. Fallback to CLAUDE.md etc. via
   `project_doc_fallback_filenames`.
5. **Profiles:** `[profiles.<name>]` — named config presets that override top-level keys
6. **Custom agents:** Separate `.toml` files in `~/.codex/agents/` and `.codex/agents/`
7. **Permissions:** Granular filesystem + network policies in `[permissions.<name>]`
8. **Approval policy:** Three modes + granular object form
9. **Model providers:** `[model_providers.<id>]` with base_url, env_key, wire_api
10. **Trust model:** Project configs only load for trusted projects

### Key differences from Claude Code:

| Aspect | Claude Code | Codex CLI |
|--------|-------------|-----------|
| Format | JSON | TOML |
| Config file | `~/.claude/settings.json` + `.claude/settings.local.json` | `~/.codex/config.toml` + `.codex/config.toml` |
| MCP config | `mcpServers` in JSON | `[mcp_servers.<id>]` TOML tables |
| Instructions | `CLAUDE.md` | `AGENTS.md` (+ override, fallbacks) |
| Profiles | None (env vars) | `[profiles.<name>]` |
| Agents | Subagent via tool | Custom `.toml` agent definitions |
| Permissions | `.claude/settings.local.json` | `[permissions.<name>]` + `approval_policy` |
| Sandbox | Permission mode (ask/auto/bypass) | `sandbox_mode` (read-only/workspace-write/full-access) |
| HTTP MCP | Not native | `url` + `bearer_token_env_var` + headers |
| Tool filtering | Not native | `enabled_tools` / `disabled_tools` per server |
| Trust model | Permission prompts | `[projects]` trust_level + enterprise `requirements.toml` |

### MCP field mapping (Codex -> agent-manager canonical):

| Codex field | Canonical equivalent | Notes |
|-------------|---------------------|-------|
| `command` | `command` | Same |
| `args` | `args` | Same |
| `env` | `env` | Same |
| `env_vars` | -- | Codex-specific: forward from parent env |
| `cwd` | `cwd` | Same (not in Claude Code) |
| `url` | `url` | HTTP transport |
| `bearer_token_env_var` | -- | Codex-specific |
| `http_headers` | -- | Codex-specific |
| `env_http_headers` | -- | Codex-specific |
| `enabled` | `disabled` (inverted) | Same concept, opposite polarity |
| `required` | -- | Codex-specific |
| `enabled_tools` | -- | Codex-specific |
| `disabled_tools` | -- | Codex-specific |
| `startup_timeout_sec` | `timeout` | Similar |
| `tool_timeout_sec` | -- | Codex-specific |
| `scopes` | -- | OAuth |
| `oauth_resource` | -- | OAuth |
