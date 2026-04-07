---
tags: [research/agent-manager, config/toml, patterns/profiles]
created: 2026-04-07
updated: 2026-04-07
---

# TOML Profile & Subset Configuration Design for agent-manager

> Research into TOML-native and profile-based configuration systems, distilled into a
> proposed schema for agent-manager's global config, profile definitions, and project binding.
> Cross-references: [[04-agent-ide-config-format-survey]], [[08-agent-manager-architecture-design]].

---

## 1. Survey of Profile / Subset Configuration Systems

### 1.1 Cargo Profiles (Rust)

**Format:** TOML — `[profile.<name>]` tables in `Cargo.toml`

Cargo is the gold standard for TOML-native profile configuration. Profiles control
compiler settings (opt-level, debug info, LTO) and are selected per build command.

**Profile definition:**

```toml
[profile.dev]
opt-level = 0
debug = true
incremental = true

[profile.release]
opt-level = 3
debug = false
lto = true
```

**Custom profiles with inheritance:**

```toml
[profile.release-lto]
inherits = "release"    # ← explicit parent
lto = true
```

**Per-package overrides (scoped to dependency tree):**

```toml
[profile.dev.package.image]
opt-level = 3

[profile.dev.package."*"]    # all non-workspace deps
opt-level = 2

[profile.dev.build-override]  # build scripts only
opt-level = 3
```

**Selection:** CLI flag `--profile <name>` or shorthand `--release`. Each cargo
subcommand has a default profile (`build` → dev, `install` → release).

**Override precedence (first match wins):**
1. `[profile.dev.package.name]` — named package
2. `[profile.dev.package."*"]` — wildcard for non-workspace
3. `[profile.dev.build-override]` — build scripts
4. `[profile.dev]` — base profile
5. Built-in defaults

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| `inherits` keyword | Direct model for profile inheritance |
| Per-package overrides | Maps to per-MCP-server overrides |
| Workspace-root only | Config read from a single canonical location |
| CLI flag selection | `--profile <name>` pattern |
| Override precedence chain | Layered config resolution |

---

### 1.2 pyproject.toml (Python)

**Format:** TOML — standardized `[project]` table plus `[tool.*]` namespaces

pyproject.toml demonstrates how a single TOML file supports multiple tools, each with
their own configuration namespace and optional profile-like subsections.

**Named dependency groups (profile-like subsets):**

```toml
[project]
name = "myapp"
version = "1.0.0"
dependencies = ["flask>=3.0", "sqlalchemy"]

[project.optional-dependencies]
dev = ["pytest", "ruff", "mypy"]
docs = ["sphinx", "myst-parser"]
ml = ["torch", "transformers"]
```

Selection: `pip install myapp[dev,ml]` — composable, additive groups.

**Tool-specific namespaces:**

```toml
[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I"]

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-v --tb=short"

[tool.mypy]
strict = true
```

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| `[tool.*]` namespacing | Each agent tool gets its own config namespace |
| Optional dependency groups | Composable feature/plugin sets |
| Single file, multiple concerns | One config file serves many tools |
| Schema validation via PEP 621 | Standardized metadata fields |

---

### 1.3 mise (Tool Version Manager)

**Format:** TOML — `mise.toml` / `.mise.toml` with directory hierarchy

mise is the most directly relevant model for agent-manager. It manages tool versions,
environment variables, and tasks per directory with hierarchical override.

**Base config:**

```toml
[tools]
node = "22"
python = { version = "3.12", postinstall = "corepack enable" }

[env]
NODE_ENV = "development"
DATABASE_URL = "postgres://localhost/dev"

[tasks.dev]
run = "npm run dev"

[settings]
experimental = true
jobs = 4
```

**Environment-specific overlays:**

```
mise.toml                     # base config
mise.local.toml               # local overrides (gitignored)
mise.development.toml         # env-specific (MISE_ENV=development)
mise.development.local.toml   # env + local (gitignored)
~/.config/mise/config.toml    # global defaults
```

**Hierarchical directory inheritance (merge semantics):**

```
~/src/work/mise.toml            → python=3.11, node=20
~/src/work/project/mise.toml    → node=22, go=1.22
# In project/: python=3.11 (inherited), node=22 (overridden), go=1.22 (added)
```

| Section | Merge Behavior |
|---------|---------------|
| `[tools]` | Additive with override (key-level) |
| `[env]` | Additive with override (key-level) |
| `[tasks]` | Per-task full replacement |
| `[settings]` | Additive with override (key-level) |

**Selection:** `MISE_ENV` environment variable or `-E <env>` CLI flag.

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| Directory-tree inheritance | Project config inherits from global |
| `.local.toml` convention | Local overrides gitignored |
| `MISE_ENV` layering | Named environments as profiles |
| Merge-by-section semantics | Different merge rules per section type |
| File precedence chain | Clear, deterministic config resolution |
| JSON Schema at known URL | IDE validation support |

---

### 1.4 Dotter (Dotfile Manager)

**Format:** TOML — `.dotter/global.toml` and `.dotter/local.toml`

Dotter separates shared definitions from machine-specific selection.

**Global config (shared, version-controlled):**

```toml
# .dotter/global.toml
[files]
".bashrc" = "~/.bashrc"
".vimrc" = "~/.vimrc"
".gitconfig" = "~/.gitconfig"

[variables]
email = ""           # placeholder, overridden locally
editor = "vim"

# Packages group files and variables
[packages.shell]
files = [".bashrc", ".zshrc"]

[packages.editor]
files = [".vimrc"]
depends = ["shell"]  # dependency between packages
```

**Local config (machine-specific, gitignored):**

```toml
# .dotter/local.toml
packages = ["shell", "editor"]  # which packages to deploy

[variables]
email = "user@example.com"      # machine-specific override
```

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| Global definitions + local selection | Profiles defined globally, activated locally |
| Package grouping with dependencies | MCP server groups with interdependencies |
| Variable templating | Parameterized profile values |
| Separate files for shared vs. local | `config.toml` vs `.agent-manager.toml` |

---

### 1.5 Taplo (TOML Toolkit)

**Format:** TOML — `.taplo.toml` configuration

Taplo provides TOML formatting and validation, with per-file-glob rule overrides.

```toml
# .taplo.toml
[formatting]
column_width = 100
indent_string = "  "
reorder_keys = false

[[rule]]
include = ["Cargo.toml"]
keys = ["dependencies"]
formatting = { reorder_keys = true }

[[rule]]
include = ["pyproject.toml"]
formatting = { column_width = 120 }
```

**Schema association:**

```toml
[[schema]]
path = "config.toml"
url = "https://example.com/schema.json"
```

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| Per-glob rule overrides `[[rule]]` | Different validation per config file |
| Schema URL association | JSON Schema validation for agent-manager TOML |
| Array-of-tables `[[rule]]` | Clean pattern for multiple override rules |

---

### 1.6 Docker Compose Profiles

**Format:** YAML — `profiles` attribute on services

Docker Compose profiles tag services for conditional activation, modeling optional
components that only start when explicitly requested.

```yaml
services:
  web:
    image: nginx          # always starts (no profile)
  
  db:
    image: postgres       # always starts
  
  debug-tools:
    image: debug-toolkit
    profiles: [debug]     # only with --profile debug
  
  monitoring:
    image: grafana
    profiles: [debug, ops]  # either profile activates it
```

**Activation:** `docker compose --profile debug up` or `COMPOSE_PROFILES=debug,ops`.

**Key semantics:**
- Services without `profiles` always start (core services)
- Multiple profiles on a service = OR logic (any match activates)
- Multiple `--profile` flags = union of service sets
- Explicit service targeting bypasses profile check

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| Tag-based activation (OR logic) | MCP servers tagged with profiles |
| Untagged = always active | Core servers always enabled |
| Profile composition via multiple flags | `--profile work --profile debug` |
| Wildcard `--profile "*"` | Enable everything |

---

### 1.7 Terraform Workspaces

**Format:** HCL — workspace-aware state isolation

Terraform workspaces isolate state per named environment, with configuration
referencing the current workspace name for conditional behavior.

```hcl
resource "aws_instance" "example" {
  count = terraform.workspace == "production" ? 5 : 1
  
  tags = {
    Environment = terraform.workspace
  }
}

locals {
  instance_type = {
    dev     = "t3.micro"
    staging = "t3.small"
    prod    = "t3.large"
  }
}

resource "aws_instance" "app" {
  instance_type = local.instance_type[terraform.workspace]
}
```

**Selection:** `terraform workspace select <name>`, `terraform workspace new <name>`.

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| Named workspaces with state isolation | Profile = isolated agent configuration state |
| Workspace-conditional logic | Config values varying by profile name |
| Default workspace fallback | Always have a "default" profile |
| Workspace maps for values | Lookup tables keyed by profile |

---

### 1.8 AWS CLI Profiles

**Format:** INI — `~/.aws/config` and `~/.aws/credentials`

AWS CLI profiles demonstrate credential and configuration layering with
inheritance via `source_profile`.

```ini
# ~/.aws/config
[default]
region = us-west-2
output = json

[profile dev]
region = us-east-1
role_arn = arn:aws:iam::111111111111:role/dev-role
source_profile = default    # ← inherits credentials from default

[profile staging]
region = us-west-2
role_arn = arn:aws:iam::222222222222:role/staging-role
source_profile = default

[profile prod]
region = us-east-1
role_arn = arn:aws:iam::333333333333:role/prod-role
source_profile = default
mfa_serial = arn:aws:iam::333333333333:mfa/user
```

**Selection precedence:** `--profile` flag > `AWS_PROFILE` env var > `[default]`.

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| `source_profile` inheritance | Profile inherits settings from another |
| Separate files for sensitive data | Credentials vs. configuration split |
| Selection: flag > env > default | Three-tier precedence for profile selection |
| Role chaining (profile → profile) | Profile composition chains |

---

### 1.9 Kubernetes Contexts (kubeconfig)

**Format:** YAML — `~/.kube/config`

Kubeconfig binds three dimensions (cluster, user, namespace) into named contexts.

```yaml
apiVersion: v1
kind: Config
current-context: dev-frontend

clusters:
  - name: dev-cluster
    cluster:
      server: https://dev.k8s.example.com
  - name: prod-cluster
    cluster:
      server: https://prod.k8s.example.com

users:
  - name: developer
    user:
      token: dev-token-xxx
  - name: admin
    user:
      client-certificate: /path/to/cert

contexts:
  - name: dev-frontend
    context:
      cluster: dev-cluster
      user: developer
      namespace: frontend
  - name: prod-admin
    context:
      cluster: prod-cluster
      user: admin
      namespace: kube-system
```

**Selection:** `kubectl config use-context <name>`, `--context` flag, `KUBECONFIG` for
file merging (first file wins for conflicts).

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| Context = binding of orthogonal dimensions | Profile = binding of servers + skills + settings |
| `current-context` persistent state | Remember active profile |
| Multi-file merge via KUBECONFIG | Merge multiple config sources |
| First-file-wins conflict resolution | Deterministic merge semantics |

---

### 1.10 Nix Flakes

**Format:** Nix — `flake.nix` with typed outputs

Nix flakes define multiple configuration targets as typed outputs in a single file.

```nix
{
  description = "My project";
  
  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  
  outputs = { self, nixpkgs }: let
    pkgs = nixpkgs.legacyPackages.x86_64-linux;
  in {
    # Different "profiles" as output types
    packages.x86_64-linux.default = pkgs.hello;
    
    devShells.x86_64-linux = {
      default = pkgs.mkShell { buildInputs = [ pkgs.nodejs ]; };
      full    = pkgs.mkShell { buildInputs = [ pkgs.nodejs pkgs.python3 ]; };
      minimal = pkgs.mkShell { buildInputs = [ pkgs.nodejs ]; };
    };
    
    nixosConfigurations = {
      laptop  = nixpkgs.lib.nixosSystem { ... };
      server  = nixpkgs.lib.nixosSystem { ... };
    };
  };
}
```

**Selection:** `nix develop .#full`, `nix build .#default` — hash-fragment selects output.

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| Typed output categories | Different profile types (dev, deploy, research) |
| Named outputs within categories | Multiple profiles per type |
| Input pinning via lockfile | Plugin/server version pinning |
| Functional composition | Profiles as composable functions |

---

### 1.11 direnv (.envrc)

**Format:** Shell script — `.envrc` files with stdlib functions

direnv provides per-directory environment configuration with directory-tree inheritance.

```bash
# ~/projects/.envrc (parent)
export ORG_TOKEN="shared-token"
export DEFAULT_REGION="us-west-2"

# ~/projects/myapp/.envrc (child)
source_up                          # inherit parent
layout python python3.12
dotenv_if_exists .env
export APP_ENV="development"
```

**Inheritance:** `source_up` walks the directory tree. `source_env` loads specific files.
**Security:** `.envrc` must be `direnv allow`-ed before execution.

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| Directory-tree inheritance | Project inherits org-level config |
| Security allow/deny model | Trust model for project configs |
| `source_up` explicit inheritance | Opt-in parent config loading |
| Per-directory automatic activation | Auto-detect project config on `cd` |

---

### 1.12 chezmoi (Dotfile Manager with Templates)

**Format:** TOML (config) + Go templates (content) — `.chezmoi.toml.tmpl`

chezmoi is the most sophisticated dotfile manager, using Go's `text/template` engine
to generate per-machine configurations from a single source repository. It demonstrates
a template-driven profile system rather than explicit named profiles.

**Per-machine config generation via `.chezmoi.toml.tmpl`:**

```toml
{{- /* .chezmoi.toml.tmpl — executed at `chezmoi init` time */ -}}
{{- /* Only runtime variables available here, NOT .chezmoidata */ -}}

[data]
{{- if eq .chezmoi.hostname "work-laptop" }}
    email = "user@company.com"
    profile = "work"
    editor = "code"
{{- else if eq .chezmoi.hostname "personal-mbp" }}
    email = "user@gmail.com"
    profile = "personal"
    editor = "nvim"
{{- else }}
    email = "user@example.com"
    profile = "default"
    editor = "vim"
{{- end }}
```

**Conditional file content based on machine:**

```
{{- /* dot_gitconfig.tmpl */ -}}
[user]
    email = {{ .email | quote }}
    name = "User Name"
{{- if eq .profile "work" }}
[credential]
    helper = codecommit
{{- end }}
```

**`.chezmoiignore` for conditional file inclusion/exclusion:**

```
{{- /* .chezmoiignore — templated, controls which files are deployed */ -}}
{{- if ne .profile "work" }}
.config/work-tools/
.aws/config
{{- end }}
{{- if ne .chezmoi.os "linux" }}
.config/i3/
.Xresources
{{- end }}
```

**Data layering:**
- `.chezmoidata.toml` — repo-level defaults (merged lexicographically)
- `.chezmoi.toml` — generated per-machine config (from template at init time)
- Config `[data]` section — arbitrary template variables
- Runtime `.chezmoi.*` variables — hostname, OS, arch, username

**Key runtime variables:** `.chezmoi.hostname`, `.chezmoi.os` (darwin/linux/windows),
`.chezmoi.arch`, `.chezmoi.username`, `.chezmoi.homeDir`, `.chezmoi.sourceDir`.

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| Template-driven config generation | Generate IDE configs from profile templates |
| `.chezmoidata` for repo defaults | Default server/skill definitions |
| Runtime variable conditionals | OS/hostname-aware profile selection |
| `.chezmoiignore` templating | Conditional inclusion of config components |
| Encrypted secrets support | Secure credential storage in synced config |
| `promptOnce` for initial setup | Interactive profile setup on first run |

---

### 1.13 OpenAI Codex (AI Coding Agent)

**Format:** TOML — `~/.codex/config.toml` with `[profiles.<name>]` tables

> [!important] **Direct precedent.** OpenAI Codex (2025) uses TOML profiles with
> almost the identical pattern proposed in this document. This validates the design
> independently — two AI agent tools converging on the same configuration model.

Codex profiles save named sets of configuration values, switchable via CLI flag.

```toml
# ~/.codex/config.toml
model = "gpt-5-codex"
approval_policy = "on-request"
model_catalog_json = "/Users/me/.codex/model-catalogs/default.json"

# Default profile (optional)
profile = "deep-review"

[profiles.deep-review]
model = "gpt-5-pro"
model_reasoning_effort = "high"
approval_policy = "never"
model_catalog_json = "/Users/me/.codex/model-catalogs/deep-review.json"

[profiles.lightweight]
model = "gpt-4.1"
approval_policy = "untrusted"
```

**Selection:** `codex --profile <name>` or `profile = "deep-review"` in config for default.

**CLI overrides (TOML-valued):**

```bash
# Dedicated flag
codex --model gpt-5.4

# Generic key/value override (value is TOML, not JSON)
codex --config model='"gpt-5.4"'
codex --config sandbox_workspace_write.network_access=true
codex --config 'shell_environment_policy.include_only=["PATH","HOME"]'

# Dot notation for nested values
codex --config mcp_servers.context7.enabled=false
```

**Key behaviors:**
- Profile values override top-level values when the profile is selected
- `profile = "name"` at top level sets the default profile
- `--profile` CLI flag overrides the default
- `--config key=value` overrides anything (highest precedence)
- Dot notation supports nested key paths

| Pattern | Applicability to agent-manager |
|---------|-------------------------------|
| `[profiles.<name>]` tables | **Exact same pattern** as proposed schema |
| `profile = "name"` default | Default profile in top-level config |
| `--profile` CLI flag | Profile selection on command line |
| `--config key=value` overrides | Per-run configuration overrides |
| Dot notation for nested keys | `--config servers.outlook.enabled=false` |
| Profile overrides top-level | Clear precedence: profile > base config |

---

## 2. Pattern Comparison Matrix

| System | Format | Inheritance | Override Semantics | Selection Mechanism | Workspace Binding |
|--------|--------|------------|-------------------|--------------------|--------------------|
| **Cargo** | TOML | `inherits` keyword | Merge (first-match precedence) | `--profile` flag | Workspace root `Cargo.toml` |
| **pyproject.toml** | TOML | None (flat) | N/A (per-tool namespaces) | `pip install .[group]` | `pyproject.toml` in project root |
| **mise** | TOML | Directory hierarchy | Additive with key-level override | `MISE_ENV` / `-E` flag | Walk up directory tree |
| **Dotter** | TOML | Packages with `depends` | Local overrides global variables | `local.toml` package list | `.dotter/` directory |
| **Taplo** | TOML | None | Per-glob `[[rule]]` overrides | File glob patterns | `.taplo.toml` in project root |
| **Docker Compose** | YAML | None | OR-logic tag union | `--profile` / `COMPOSE_PROFILES` | `compose.yaml` in project root |
| **Terraform** | HCL | Default workspace | Workspace-conditional logic | `workspace select` | `.terraform/` state directory |
| **AWS CLI** | INI | `source_profile` | Credentials file > config file | `--profile` / `AWS_PROFILE` | `~/.aws/config` (global) |
| **Kubernetes** | YAML | None (flat contexts) | First-file-wins merge | `use-context` / `--context` | `~/.kube/config` or `KUBECONFIG` |
| **Nix Flakes** | Nix | Functional composition | Input `follows` dedup | Hash-fragment `#name` | `flake.nix` in project root |
| **direnv** | Shell | `source_up` chain | Last-write-wins (shell) | Automatic on directory entry | `.envrc` in project dir |
| **chezmoi** | TOML + Go templates | Template conditionals + `.chezmoidata` | Template rendering (last-write-wins) | Runtime variables (hostname, OS) | `.chezmoi.toml.tmpl` in source root |
| **OpenAI Codex** | TOML | `[profiles.<name>]` tables | Profile overrides top-level | `--profile` / `profile =` default | `~/.codex/config.toml` (global) |

---

## 3. Design Principles Extracted

From the survey, these principles emerge as consensus patterns:

### 3.1 Layered Resolution (Universal)

Every system implements some form of layered configuration:

```
CLI flag → env var → project file → user/global file → built-in defaults
```

This is the single most consistent pattern across all systems surveyed. agent-manager
must implement this.

### 3.2 Separation of Definition from Selection (Dotter, Docker Compose)

Define all possible configurations in one place, select active ones in another.
This separates "what exists" from "what's active right now."

- **Dotter:** `global.toml` (all packages) + `local.toml` (which to activate)
- **Docker Compose:** All services defined, `profiles` controls activation
- **agent-manager:** Define all MCP servers/skills globally, profiles select subsets

### 3.3 Explicit Inheritance (Cargo, AWS CLI)

When profiles extend other profiles, the inheritance must be explicit:
- Cargo: `inherits = "release"`
- AWS CLI: `source_profile = default`

Implicit inheritance (e.g., "all profiles inherit from default unless stated otherwise")
creates confusion. Explicit is better.

### 3.4 Merge Semantics Must Be Per-Section (mise)

Different configuration sections need different merge strategies:
- Tools/servers: additive with key-level override (adding a server doesn't remove others)
- Environment vars: additive with key-level override
- Settings: additive with key-level override
- Tasks/scripts: full replacement (partial merge creates confusion)

### 3.5 Project Binding Is a Thin Pointer (All Systems)

Project-level config should be minimal — it points to a profile, not redefines one:
- mise: just `mise.toml` with tool versions
- direnv: `.envrc` with `source_up`
- Kubernetes: `current-context` field
- agent-manager: `.agent-manager.toml` with `profile = "work"` and minimal overrides

### 3.6 Local Overrides Are Gitignored (mise, Dotter, direnv)

A `.local` variant allows per-machine customization without polluting version control:
- mise: `mise.local.toml`
- Dotter: `.dotter/local.toml`
- agent-manager: `.agent-manager.local.toml`

### 3.7 Schema Validation Is Essential (Taplo, mise)

TOML config must be validated. JSON Schema is the standard mechanism:
- Taplo associates JSON Schemas with TOML files
- mise publishes schema at a known URL
- IDE integration (VS Code, IntelliJ) requires published schemas

---

## 4. Proposed agent-manager TOML Schema

### 4.1 File Layout

```
~/.config/agent-manager/
  config.toml              # global config: profiles, servers, skills, settings
  config.local.toml        # local overrides (gitignored equivalent — never synced)

<project-root>/
  .agent-manager.toml      # project binding: profile selection + project overrides
  .agent-manager.local.toml # local project overrides (gitignored)
```

**Resolution order (highest to lowest precedence):**
1. CLI flags (`--profile`, `--server`, etc.)
2. Environment variables (`AGENT_MANAGER_PROFILE`, etc.)
3. `.agent-manager.local.toml` (project-local, gitignored)
4. `.agent-manager.toml` (project, version-controlled)
5. `~/.config/agent-manager/config.local.toml` (user-local)
6. `~/.config/agent-manager/config.toml` (user global)
7. Built-in defaults

### 4.2 Global Config: `~/.config/agent-manager/config.toml`

```toml
# =============================================================================
# agent-manager global configuration
# =============================================================================
# Schema: https://agent-manager.dev/schema/config.json
# Docs:   https://agent-manager.dev/docs/config

# ---------------------------------------------------------------------------
# [settings] — Global behavior settings
# ---------------------------------------------------------------------------
[settings]
# Default profile when none specified
default_profile = "personal"

# Where to sync config (git repo URL, empty = local only)
sync_remote = "https://github.com/user/agent-config.git"

# Auto-sync on profile switch
auto_sync = true

# Log level for agent-manager itself
log_level = "info"  # trace | debug | info | warn | error

# ---------------------------------------------------------------------------
# [servers.<name>] — MCP server definitions (the catalog)
# ---------------------------------------------------------------------------
# Each server is defined once, referenced by name in profiles.
# These are definitions, not activations — profiles control what's active.

[servers.outlook]
command = "aws-outlook-mcp"
description = "Outlook email and calendar via Midway"
tags = ["email", "calendar", "work"]
# Environment variables passed to the server process
env = { MIDWAY_AUTH = "true" }

[servers.slack]
command = "workplace-chat-mcp"
description = "Slack search, messages, AI, files"
tags = ["chat", "work"]

[servers.sentral]
command = "aws-sentral-mcp"
description = "AWSentral CRM/Salesforce data"
tags = ["crm", "work"]

[servers.fetch]
command = "uvx mcp-server-fetch"
description = "Raw URL fetching"
tags = ["web", "utility"]

[servers.tavily]
command = "bunx tavily-mcp@latest"
description = "Web search and extraction"
tags = ["web", "search"]

[servers.context7]
command = "bunx @upstash/context7-mcp@latest"
description = "Library documentation lookup"
tags = ["docs", "dev"]

[servers.code-search]
command = "code-search-mcp"
description = "Full code search — files, deps, repos"
tags = ["code", "dev", "work"]

[servers.exa]
command = "uvx mcp-proxy"
args = ["--transport", "streamablehttp", "--endpoint", "https://mcp.exa.ai/sse"]
description = "Exa web search, code context, deep research"
tags = ["web", "search", "research"]
env = { EXA_API_KEY = "${EXA_API_KEY}" }

# ---------------------------------------------------------------------------
# [skills.<name>] — Skill definitions (the catalog)
# ---------------------------------------------------------------------------

[skills.research-rabbithole]
path = "~/.claude/skills/research-rabbithole"
description = "Multi-agent parallel research"
tags = ["research"]

[skills.admin-lint]
path = "~/.claude/skills/admin-lint"
description = "Vault health check"
tags = ["ops", "administrivia"]

# ---------------------------------------------------------------------------
# [plugins.<name>] — Plugin definitions (the catalog)
# ---------------------------------------------------------------------------

[plugins.os-eco]
path = "~/.claude/plugins/os-eco"
description = "OS-eco workflow enforcement"
tags = ["workflow"]

# ---------------------------------------------------------------------------
# [profiles.<name>] — Profile definitions
# ---------------------------------------------------------------------------
# Profiles select subsets of servers, skills, and plugins.
# They can inherit from other profiles and override settings.

[profiles.base]
# The "base" profile — shared across all contexts.
# Other profiles inherit from this.
description = "Minimal baseline — always-on utilities"
servers = ["fetch", "tavily", "context7"]
skills = []
plugins = []

[profiles.base.settings]
# Profile-specific settings that override [settings]
log_level = "info"

[profiles.personal]
description = "Personal projects and learning"
inherits = "base"                              # ← explicit inheritance (Cargo pattern)
servers = ["exa"]                              # ← additive: base servers + exa
skills = ["research-rabbithole"]
plugins = ["os-eco"]

[profiles.work]
description = "Full Amazon work environment"
inherits = "base"
servers = [
    "outlook", "slack", "sentral",             # communication
    "code-search", "exa",                      # search & research
]
skills = ["research-rabbithole", "admin-lint"]
plugins = ["os-eco"]

[profiles.work.settings]
log_level = "warn"                             # less noise at work

[profiles.work.env]
# Environment variables set when this profile is active
AWS_PROFILE = "baladita+Bedrock-Admin"
MISE_ENV = "work"

[profiles.debug]
description = "Debugging and troubleshooting overlay"
inherits = "work"
servers = [
    "aws-support-troubleshooting",             # added on top of work
    "secureguide",
]

# ---------------------------------------------------------------------------
# [tags] — Tag-based activation (Docker Compose pattern)
# ---------------------------------------------------------------------------
# Alternative to explicit server lists: activate by tag.
# Profiles can use `server_tags` instead of or in addition to `servers`.

[profiles.research]
description = "Deep research mode"
inherits = "base"
server_tags = ["search", "research", "docs"]   # ← all servers matching these tags
skills = ["research-rabbithole"]

# ---------------------------------------------------------------------------
# [[overrides]] — Per-server overrides within a profile (Cargo package pattern)
# ---------------------------------------------------------------------------
# Override specific server settings when used in a specific profile.

[[profiles.work.server_overrides]]
server = "outlook"
env = { OUTLOOK_FOLDER = "Inbox/Priority" }

[[profiles.work.server_overrides]]
server = "slack"
env = { SLACK_CHANNELS = "team-general,oncall" }
```

### 4.3 Project Binding: `.agent-manager.toml`

```toml
# =============================================================================
# Project-level agent-manager configuration
# =============================================================================
# This file lives in the project root and is version-controlled.
# It selects a profile and can apply project-specific overrides.

# Profile to use for this project (thin pointer — the Dotter pattern)
profile = "work"

# Project metadata (used for display and search)
[project]
name = "ADMINISTRIVIA"
description = "Personal productivity vault"

# ---------------------------------------------------------------------------
# Additional servers for this project only (additive)
# ---------------------------------------------------------------------------
# These are added ON TOP of the profile's servers.

[project.servers.wiki]
command = "amazon-wiki-mcp"
description = "Amazon Wiki access (project-specific)"
tags = ["wiki", "work"]

[project.servers.tickety]
command = "tickety-aws-mcp"
description = "Ticket management"
tags = ["tickets", "work"]

# ---------------------------------------------------------------------------
# Server overrides for this project
# ---------------------------------------------------------------------------

[[project.server_overrides]]
server = "outlook"
env = { OUTLOOK_FILTER = "from:team@amazon.com" }

# ---------------------------------------------------------------------------
# Project-specific environment variables
# ---------------------------------------------------------------------------

[project.env]
VAULT_ROOT = "."
PROJECT_TYPE = "obsidian"

# ---------------------------------------------------------------------------
# Project-specific settings
# ---------------------------------------------------------------------------

[project.settings]
# Override global settings for this project
log_level = "debug"
```

### 4.4 Local Overrides: `.agent-manager.local.toml`

```toml
# =============================================================================
# Local project overrides (GITIGNORED — never committed)
# =============================================================================
# Machine-specific settings that override .agent-manager.toml

# Override the profile for local development
# profile = "debug"

# Local environment overrides
[env]
MIDWAY_COOKIE_PATH = "/Users/myuser/.midway/cookie"
LOCAL_DB_URL = "postgres://localhost:5432/dev"

# Disable a server locally (e.g., broken auth)
[server_overrides.outlook]
enabled = false
```

### 4.5 Inheritance & Merge Model

**Profile inheritance** follows Cargo's explicit `inherits` pattern:

```
profiles.debug
  └── inherits: profiles.work
        └── inherits: profiles.base
              └── (built-in defaults)
```

**Merge rules per section:**

| Section | Strategy | Example |
|---------|----------|---------|
| `servers` (list) | Union (additive) | base=[fetch,tavily] + work=[outlook,slack] → [fetch,tavily,outlook,slack] |
| `server_tags` (list) | Union (additive) | Tags from parent + child profiles |
| `skills` (list) | Union (additive) | Same as servers |
| `plugins` (list) | Union (additive) | Same as servers |
| `settings` (table) | Key-level override | Child key replaces parent key; unset keys inherited |
| `env` (table) | Key-level override | Child env var replaces parent; unset vars inherited |
| `server_overrides` | Deep merge by server name | Child override merges into parent override for same server |

**Cross-layer merge (resolution order):**

```
Built-in defaults
  ← config.toml [settings]
    ← config.local.toml [settings]
      ← profile [settings]
        ← .agent-manager.toml [project.settings]
          ← .agent-manager.local.toml [settings]
            ← ENV vars
              ← CLI flags
```

**Server activation (final computed set):**

```python
# Pseudocode for computing active servers
active = set()

# 1. Walk inheritance chain, union servers at each level
for profile in reversed(inheritance_chain):
    active |= set(profile.servers)
    active |= servers_matching_tags(profile.server_tags)

# 2. Add project-specific servers
active |= set(project.servers)

# 3. Apply enabled/disabled overrides
for override in all_overrides:
    if override.enabled == False:
        active.discard(override.server)

# 4. CLI --server/--no-server flags
active |= cli_add_servers
active -= cli_remove_servers
```

### 4.6 CLI Interface

```bash
# Profile selection
agent-manager --profile work          # explicit profile
agent-manager                         # uses default_profile from config
AGENT_MANAGER_PROFILE=debug agent-manager  # env var

# Profile management
agent-manager profile list            # show all profiles
agent-manager profile show work       # show computed config for profile
agent-manager profile active          # show current profile + resolution chain

# Server management within current profile
agent-manager server list             # all defined servers
agent-manager server active           # servers active in current profile
agent-manager server add outlook      # add server to current project config
agent-manager server remove outlook   # remove from current project config

# Temporary overrides (single session)
agent-manager --server outlook --server slack  # add servers
agent-manager --no-server tavily               # remove server for this session

# Per-run overrides (Codex pattern — values parsed as TOML)
agent-manager --config log_level='"debug"'
agent-manager --config servers.outlook.enabled=false
agent-manager --config 'settings.auto_sync=false'

# Config inspection
agent-manager config show             # show fully resolved config
agent-manager config show --raw       # show before merge resolution
agent-manager config validate         # validate against schema
agent-manager config edit             # open global config in $EDITOR
agent-manager config edit --project   # open project config
```

### 4.7 Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `AGENT_MANAGER_PROFILE` | Override active profile | `work` |
| `AGENT_MANAGER_CONFIG` | Override global config path | `~/.config/am/config.toml` |
| `AGENT_MANAGER_LOG_LEVEL` | Override log level | `debug` |
| `AGENT_MANAGER_NO_SYNC` | Disable config sync | `1` |
| `AGENT_MANAGER_SERVER_<NAME>` | Enable/disable specific server | `0` to disable |

---

## 5. Schema Validation

agent-manager should publish a JSON Schema at a stable URL for IDE integration:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-manager.dev/schema/config.json",
  "title": "agent-manager configuration",
  "type": "object",
  "properties": {
    "settings": {
      "type": "object",
      "properties": {
        "default_profile": { "type": "string" },
        "sync_remote": { "type": "string", "format": "uri" },
        "auto_sync": { "type": "boolean" },
        "log_level": { "enum": ["trace", "debug", "info", "warn", "error"] }
      }
    },
    "servers": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/server"
      }
    },
    "profiles": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/profile"
      }
    }
  }
}
```

Taplo integration via `.taplo.toml`:

```toml
[[schema]]
path = "config.toml"
url = "https://agent-manager.dev/schema/config.json"

[[schema]]
path = ".agent-manager.toml"
url = "https://agent-manager.dev/schema/project.json"
```

---

## 6. Comparison with Existing agent-manager Research

### Relation to [[04-agent-ide-config-format-survey]]

The IDE config format survey examines how different AI coding tools (Claude Code,
Cursor, Windsurf, etc.) structure their config files. This document complements
that by analyzing the *profile and subset* patterns those configs could adopt.

Key synthesis points:
- **Claude Code** uses `~/.claude.json` (JSON) with project-scoped overrides —
  agent-manager's TOML profiles would generate/manage these files
- **Cursor** uses `.cursor/` directory with `settings.json` and `rules/` —
  agent-manager profiles map to cursor rule sets
- **Windsurf** uses `.windsurfrules` — agent-manager can template these per profile

### Relation to [[08-agent-manager-architecture-design]]

The architecture design defines agent-manager's overall system. The TOML profile
system is its **configuration layer**:

- **Config Store** component reads and merges TOML files
- **Profile Resolver** implements the inheritance and merge logic
- **Sync Engine** pushes/pulls `config.toml` via git
- **Generator** converts resolved profiles into IDE-specific config files

---

## 7. Design Decisions & Rationale

| Decision | Rationale | Alternative Considered |
|----------|-----------|----------------------|
| TOML over JSON/YAML | Human-writable, comments, typed values, no gotchas (YAML Norway problem). Matches Cargo/mise/Codex ecosystem. | JSON (no comments), YAML (type coercion bugs) |
| `[profiles.<name>]` tables | Codex independently converged on this exact pattern. Proven in production. | Separate files per profile (scattered, hard to diff) |
| Explicit `inherits` | Cargo pattern — clear, debuggable inheritance chain. No surprise behaviors. | Implicit "all inherit from default" (AWS CLI pattern — less visible) |
| Union merge for server lists | Adding a server to a child profile should not require re-listing parent servers. | Replace semantics (Terraform — forces full redeclaration) |
| Key-level override for tables | Standard shallow merge — predictable, easy to reason about. | Deep merge (complex, surprising for nested structures) |
| Separate global catalog from profile selection | Dotter pattern — define once, select many times. Avoids duplication. | Inline server definitions per profile (duplicates config) |
| `.agent-manager.toml` in project root | Convention from mise, pyproject.toml, direnv. Auto-discoverable. | Subdirectory `.agent-manager/config.toml` (heavier) |
| `.local.toml` for gitignored overrides | mise convention — well-understood, keeps VCS clean. | `.env`-style files (lose TOML structure and typing) |
| Tag-based server selection | Docker Compose pattern — good for "give me everything research-related." | Only explicit lists (verbose for large server sets) |
| JSON Schema for validation | Taplo + IDE ecosystem standard. Enables autocomplete and error checking. | Custom validation (non-standard, no IDE support) |

---

## 8. Real-World Validation: Codex Convergence

OpenAI's Codex CLI (released 2025) independently adopted TOML with `[profiles.<name>]`
tables — nearly identical to the schema proposed in this document. This is strong
validation that the design is on the right track.

**What Codex does that agent-manager should adopt:**

| Codex Feature | agent-manager Equivalent | Status in Proposal |
|---------------|------------------------|--------------------|
| `[profiles.<name>]` in config.toml | `[profiles.<name>]` with servers/skills/plugins | Already proposed |
| `profile = "name"` top-level default | `default_profile = "name"` in `[settings]` | Already proposed |
| `--profile <name>` CLI flag | `--profile <name>` | Already proposed |
| `--config key=value` (TOML-valued) | Added to CLI design | Now included |
| Dot notation for nested keys | `--config servers.X.enabled=false` | Now included |
| Profile overrides base config | Merge with key-level override | Already proposed |

**What agent-manager adds beyond Codex:**

| agent-manager Feature | Why Codex Doesn't Need It |
|-----------------------|--------------------------|
| `inherits` (profile inheritance chains) | Codex profiles are flat; agent-manager needs composition for MCP server sets |
| Tag-based server activation | Codex has fewer servers; agent-manager manages 20+ MCP servers |
| Project binding (`.agent-manager.toml`) | Codex is global-only; agent-manager must vary per project |
| `.local.toml` gitignored overrides | Codex doesn't sync config via git |
| Server catalog separate from profiles | Codex defines everything inline; agent-manager avoids duplication |
| Multi-IDE generation | Codex only configures itself; agent-manager generates configs for Claude/Cursor/Windsurf |

**What chezmoi teaches that Codex doesn't cover:**

chezmoi's template-driven approach (Go templates in `.chezmoi.toml.tmpl`) shows how
config generation can be conditional on runtime variables (hostname, OS, arch). While
agent-manager's profile system is simpler than full template evaluation, the precedent
validates the idea of **generating** target configurations from a source-of-truth config:

- chezmoi generates dotfiles from templates → agent-manager generates IDE configs from profiles
- chezmoi's `.chezmoidata` for defaults → agent-manager's server catalog for definitions
- chezmoi's runtime conditionals → agent-manager's `[[auto_detect]]` path-prefix rules
- chezmoi's encrypted secrets → agent-manager should consider encrypted credential storage

---

## 9. Open Questions

1. **Circular inheritance** — Should `inherits` support multiple parents (diamond)?
   Cargo is single-parent. Multiple parents add complexity but enable composition
   (e.g., `inherits = ["base", "aws"]`). **Recommendation:** Start with single
   parent. Add multi-parent later if needed via `inherits = ["base", "aws"]` with
   left-to-right precedence.

2. **Profile composition vs. inheritance** — Should profiles be composed at runtime
   (`--profile base --profile work`) like Docker Compose, or pre-composed via
   `inherits`? **Recommendation:** Support both. `inherits` for static composition,
   `--profile a --profile b` for dynamic.

3. **Server version pinning** — Should server commands include version pins
   (`bunx tavily-mcp@1.2.3`) or rely on external version management (mise)?
   **Recommendation:** Allow optional `version` field but don't require it.

4. **Config migration** — How to migrate existing `~/.claude.json` and `.mcp.json`
   configurations into the TOML format? **Recommendation:** `agent-manager import`
   command that reads existing configs and generates equivalent TOML.

5. **Profile auto-detection** — Should agent-manager auto-select a profile based on
   directory (e.g., `~/work/` → "work" profile)? Like mise's directory hierarchy.
   **Recommendation:** Support optional `[auto_detect]` rules in global config:
   ```toml
   [[auto_detect]]
   path_prefix = "~/work/"
   profile = "work"
   ```
