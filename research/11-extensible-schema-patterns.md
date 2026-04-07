---
tags: [research/agent-manager, patterns/schema, architecture]
created: 2026-04-07
updated: 2026-04-07
status: active
---

# Extensible Schema Design Patterns

> **How to design a "superset core schema" that allows adapter-specific extensions
> without polluting the core.** For agent-manager, the core defines universal AI
> agent config entities (servers, skills, plugins, profiles), and adapters handle
> IDE-specific features (Claude Code hooks, Cursor rules, Windsurf settings).
>
> Cross-references: [[04-agent-ide-config-format-survey]], [[05-toml-profile-configuration-design]], [[08-agent-manager-architecture-design]]

---

## Table of Contents

1. [JSON Schema + Extensions (OpenAPI x- Pattern)](#1-json-schema--extensions-openapi-x--pattern)
2. [TOML Schema Extension Patterns](#2-toml-schema-extension-patterns)
3. [TypeScript Discriminated Unions + Zod](#3-typescript-discriminated-unions--zod)
4. [Protocol Buffers Extensions / Any / OneOf](#4-protocol-buffers-extensions--any--oneof)
5. [Kubernetes Custom Resource Definitions (CRDs)](#5-kubernetes-custom-resource-definitions-crds)
6. [GraphQL Schema Extensions + Directives](#6-graphql-schema-extensions--directives)
7. [VS Code package.json "contributes" Pattern](#7-vs-code-packagejson-contributes-pattern)
8. [Cargo package.metadata Pattern](#8-cargo-packagemetadata-pattern)
9. [The "Extras" / Passthrough Pattern](#9-the-extras--passthrough-pattern)
10. [Recommended Schema Design for agent-manager](#10-recommended-schema-design-for-agent-manager)

---

## 1. JSON Schema + Extensions (OpenAPI x- Pattern)

### How It Works

OpenAPI/Swagger defines a convention where custom properties prefixed with `x-` can
appear on most schema objects. These "vendor extensions" can hold any JSON value
(primitives, objects, arrays, null). The core spec ignores them, but specific tools
can consume them.

**Key rules:**
- Extension properties MUST start with `x-`
- They can appear on root, info, paths, operations, parameters, responses, tags, security schemes, and other objects
- When an extension value is an object, its internal property names need NOT be `x-` prefixed
- Vendors namespace after `x-` to avoid collisions: `x-amazon-apigateway-`, `x-kong-`, `x-ms-`

### JSON Schema Validation of Extensions

JSON Schema provides three mechanisms for handling extension fields:

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "command": { "type": "string" }
  },
  "patternProperties": {
    "^x-": { "type": "object" }
  },
  "additionalProperties": false
}
```

- **`additionalProperties`** (default: `true`) -- controls whether unknown fields are allowed
- **`patternProperties`** -- regex-based validation; `"^x-"` allows any `x-` prefixed key
- **`unevaluatedProperties`** (Draft 2020-12) -- accounts for properties evaluated across composition (`allOf`/`anyOf`)

The combination of `patternProperties: { "^x-": { ... } }` + `additionalProperties: false` creates a "known fields + extension fields only" policy.

### Composition with $defs + $ref

```json
{
  "$defs": {
    "ServerCore": {
      "type": "object",
      "properties": {
        "command": { "type": "string" },
        "args": { "type": "array", "items": { "type": "string" } },
        "env": { "type": "object" }
      }
    }
  },
  "allOf": [
    { "$ref": "#/$defs/ServerCore" },
    {
      "type": "object",
      "patternProperties": {
        "^x-": {}
      }
    }
  ]
}
```

> [!warning] Composition caveat
> Combining `$ref`/`allOf` with `additionalProperties: false` can produce unexpected
> "additional properties not allowed" errors. Some validators see vendor-extension
> properties as unexpected when attached to fragments involved in composition. Use
> `unevaluatedProperties` (Draft 2020-12) for safer composition.

### Tool Behavior Varies

| Tool | Behavior |
|------|----------|
| OpenAPI Generator | Preserves extensions, exposes via `vendorExtension` map to templates |
| Redocly/Redoc | Renders known `x-` keys (codeSamples, hideTryItPanel, badges, tagGroups) |
| AWS API Gateway | Consumes `x-amazon-apigateway-*`, ignores others; exports include extensions if requested |
| Azure API Management | Only accepts specific `x-ms-` extensions; drops arbitrary custom ones |
| Ajv (JSON Schema) | Follows JSON Schema semantics; configurable strict mode, `removeAdditional` option |
| Spectral (linter) | Configurable rulesets can validate or skip vendor extensions |

### Analysis for agent-manager

| Dimension | Assessment |
|-----------|------------|
| **Extension declaration** | Prefix convention (`x-`) -- simple, no registry needed |
| **Core ignoring extensions** | `additionalProperties: true` or `patternProperties` + `additionalProperties: false` |
| **Composition** | Two adapters can extend the same object (different `x-` prefixed keys) |
| **Type safety** | Weak -- `x-` fields are untyped blobs unless the consumer validates them |
| **Round-trip preservation** | Tool-dependent; most parsers preserve, some drop |
| **Migration** | Extensions are informally versioned; no built-in migration story |

**Verdict:** The `x-` convention is battle-tested for loose coupling. The prefix approach
maps well to TOML: `[servers.outlook.x-claude-code]` would let adapters store inline
extensions. However, the flat prefix convention provides no structural validation --
each consumer must validate its own extensions.

---

## 2. TOML Schema Extension Patterns

### The Challenge

TOML has no built-in schema language (unlike JSON Schema for JSON). Extension patterns
must be designed at the application level. Four approaches emerge from the ecosystem:

### Option A: Namespaced Tables (Cargo-style)

```toml
[servers.outlook]
command = "aws-outlook-mcp"
tags = ["email", "work"]

[servers.outlook.adapters.claude-code]
always_allow = ["read_email", "send_email"]
trust = "full"

[servers.outlook.adapters.cursor]
disabled = true
```

**Pros:** Clean separation, each adapter gets its own subtable, easy to validate per-adapter.
**Cons:** Verbose for simple flags; deep nesting in TOML can be unwieldy.

### Option B: Inline x- Extensions (OpenAPI-style)

```toml
[servers.outlook]
command = "aws-outlook-mcp"
tags = ["email", "work"]
x-claude-code = { always_allow = ["read_email"], trust = "full" }
x-cursor = { disabled = true }
```

**Pros:** Familiar to OpenAPI users, inline with the entity.
**Cons:** `x-` prefix feels foreign in TOML; inline tables can't span multiple lines
in TOML v1.0 (they can in TOML v1.1 draft).

### Option C: Separate Files Per Adapter

```
~/.config/agent-manager/
  config.toml              # core: servers, profiles, settings
  adapters/
    claude-code.toml       # Claude Code-specific overrides
    cursor.toml            # Cursor-specific overrides
    windsurf.toml          # Windsurf-specific overrides
```

```toml
# adapters/claude-code.toml
[servers.outlook]
always_allow = ["read_email", "send_email"]
trust = "full"

[hooks.post-tool-use]
command = "check-permissions.sh"
```

**Pros:** Perfect separation, adapters can't pollute core schema, each file can have
its own JSON Schema for validation, easy to add new adapters without touching core.
**Cons:** Merging logic needed, harder to see full picture of a server's config, more files.

### Option D: pyproject.toml / Cargo [tool.*] Pattern

The Python ecosystem standardized `[tool.<name>]` in `pyproject.toml` (PEP 518).
Cargo uses `[package.metadata.<name>]`. Both let third-party tools store config
in the same file without polluting the core schema.

```toml
# Hypothetical agent-manager equivalent
[servers.outlook]
command = "aws-outlook-mcp"
tags = ["email", "work"]

[servers.outlook.metadata.claude-code]
always_allow = ["read_email"]

[servers.outlook.metadata.cursor]
disabled = true
```

**Pros:** Established pattern, `metadata` table is explicitly "not our problem" for core.
**Cons:** The `.metadata.` segment adds verbosity; less discoverable than `.adapters.`.

### Comparison Matrix

| Criterion | A: Namespaced | B: Inline x- | C: Separate Files | D: metadata.* |
|-----------|:---:|:---:|:---:|:---:|
| Separation of concerns | Good | Medium | Excellent | Good |
| Verbosity | Medium | Low | Low (per file) | Medium |
| Validation story | Per-adapter subtable | Pattern-based | Per-file schema | Per-subtable |
| Discoverability | High | Medium | Low | Medium |
| Composition (2+ adapters) | Natural | Natural | Natural | Natural |
| Core schema pollution | None | x- prefix in core | None | None |
| Single-file convenience | Yes | Yes | No | Yes |

### Recommendation for agent-manager

**Option A (Namespaced `[adapters]` tables)** with **Option C (Separate files)** as
an advanced escape hatch. The `.adapters.<name>` convention is:
- TOML-idiomatic (subtables are TOML's strength)
- Self-documenting (adapter name is the key)
- Validator-friendly (each adapter section maps to a distinct Zod schema)
- Composable (multiple adapters coexist naturally)

---

## 3. TypeScript Discriminated Unions + Zod

### The Core Pattern

When each adapter has different configuration fields, TypeScript discriminated unions
provide compile-time type safety:

```typescript
// Core config shared by all adapters
interface ServerCore {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
  tags?: string[];
  enabled?: boolean;
}

// Adapter-specific extensions
interface ClaudeCodeAdapter {
  type: "claude-code";
  alwaysAllow?: string[];
  trust?: "full" | "limited";
  hooks?: Array<{ event: string; command: string }>;
}

interface CursorAdapter {
  type: "cursor";
  disabled?: boolean;
  rules?: string[];
}

interface WindsurfAdapter {
  type: "windsurf";
  serverUrl?: string;
}

// Discriminated union of all adapters
type AdapterConfig = ClaudeCodeAdapter | CursorAdapter | WindsurfAdapter;

// Full server config = core + optional adapter extensions
interface ServerConfig extends ServerCore {
  adapters?: Record<string, AdapterConfig>;
}
```

### Zod Implementation

#### z.discriminatedUnion() for adapter configs

```typescript
import { z } from "zod";

const ClaudeCodeAdapterSchema = z.object({
  type: z.literal("claude-code"),
  alwaysAllow: z.array(z.string()).optional(),
  trust: z.enum(["full", "limited"]).optional(),
  hooks: z.array(z.object({
    event: z.string(),
    command: z.string(),
  })).optional(),
});

const CursorAdapterSchema = z.object({
  type: z.literal("cursor"),
  disabled: z.boolean().optional(),
  rules: z.array(z.string()).optional(),
});

const WindsurfAdapterSchema = z.object({
  type: z.literal("windsurf"),
  serverUrl: z.string().url().optional(),
});

// Discriminated union -- Zod checks "type" field first for fast routing
const AdapterConfigSchema = z.discriminatedUnion("type", [
  ClaudeCodeAdapterSchema,
  CursorAdapterSchema,
  WindsurfAdapterSchema,
]);
```

**Benefits of `z.discriminatedUnion()`:**
- Checks the discriminator key first, then validates only the matching branch
- Produces clear error messages ("Expected 'claude-code', got 'unknown'")
- Much faster than `z.union()` which tests every branch

#### z.passthrough() for preserving unknown fields

```typescript
// Strict: strips unknown fields (default Zod behavior)
const StrictSchema = z.object({ name: z.string() });
StrictSchema.parse({ name: "foo", extra: true }); // => { name: "foo" }

// Passthrough: preserves unknown fields
const LooseSchema = z.object({ name: z.string() }).passthrough();
LooseSchema.parse({ name: "foo", extra: true }); // => { name: "foo", extra: true }

// Strict: throws on unknown fields
const StrictestSchema = z.strictObject({ name: z.string() });
StrictestSchema.parse({ name: "foo", extra: true }); // throws ZodError
```

For agent-manager, `passthrough()` on the core schema lets adapter fields survive
parsing even when the adapter validator hasn't been loaded yet -- crucial for
forward compatibility.

#### z.merge() and .extend() for core + adapter composition

```typescript
const ServerCoreSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
});

// Extend core with adapter-specific sections
const ServerWithAdaptersSchema = ServerCoreSchema.extend({
  adapters: z.record(z.string(), AdapterConfigSchema).optional(),
});

// Alternative: merge two schemas
const TimestampSchema = z.object({
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

const FullServerSchema = ServerCoreSchema.merge(TimestampSchema);
```

> [!tip] Prefer `.extend()` over `z.intersection()`
> `extend()` returns a new object schema with full access to `.pick()`, `.omit()`,
> `.partial()`. `z.intersection()` returns a `ZodIntersection` that lacks these methods.

#### z.record() for arbitrary extension maps

```typescript
// For adapter sections where the keys are adapter names
const AdaptersMapSchema = z.record(
  z.string(),                    // key: adapter name
  z.unknown().passthrough()      // value: adapter-specific config (validated per-adapter)
);

// For a "metadata" passthrough bag
const MetadataSchema = z.record(z.string(), z.unknown());
```

### The Validation Strategy: Core + Per-Adapter

```typescript
// Phase 1: Core validates core fields, passes through adapter sections
const coreResult = ServerCoreSchema
  .extend({ adapters: z.record(z.string(), z.unknown()).optional() })
  .passthrough()
  .parse(rawConfig);

// Phase 2: Each adapter validates its own section
if (coreResult.adapters?.["claude-code"]) {
  const ccResult = ClaudeCodeAdapterSchema.parse(
    coreResult.adapters["claude-code"]
  );
}
```

This two-phase approach means:
- Core validation always runs -- catches missing `command`, invalid types
- Adapter validation runs only when that adapter is active
- Unknown adapter sections are preserved (no data loss)
- New adapters can be added without changing core validation

---

## 4. Protocol Buffers Extensions / Any / OneOf

### Three Extensibility Mechanisms

Protocol Buffers offers three approaches to schema extensibility:

#### 1. Extensions (proto2 only, discouraged in proto3)

```protobuf
// Base message defines extension ranges
message ServerConfig {
  string command = 1;
  repeated string args = 2;
  extensions 100 to 199;  // reserved for extensions
}

// External file defines extensions
extend ServerConfig {
  optional string always_allow = 100;
}
```

Extensions are declining in proto3; the field number coordination problem makes them
fragile for large ecosystems.

#### 2. google.protobuf.Any (type-erased container)

```protobuf
import "google/protobuf/any.proto";

message ServerConfig {
  string command = 1;
  repeated string args = 2;
  map<string, google.protobuf.Any> adapter_configs = 10;
}
```

`Any` wraps a serialized message with a type URL (`type.googleapis.com/package.MessageName`).
The receiver must know the type to unpack. This is proto's equivalent of
`Record<string, unknown>` -- maximum flexibility, minimal type safety at the schema level.

**Proto best practices now recommend preferring extensions over `Any`** because `Any`
has design flaws: it defeats schema validation, bloats wire format with type URLs,
and makes debugging harder.

#### 3. OneOf (discriminated union)

```protobuf
message AdapterConfig {
  oneof config {
    ClaudeCodeConfig claude_code = 1;
    CursorConfig cursor = 2;
    WindsurfConfig windsurf = 3;
  }
}

message ClaudeCodeConfig {
  repeated string always_allow = 1;
  string trust = 2;
}

message CursorConfig {
  bool disabled = 1;
}
```

`oneof` enforces exactly one variant is set -- the proto equivalent of TypeScript
discriminated unions. Adding a new variant is wire-safe (old readers ignore unknown
field numbers).

### Analysis for agent-manager

| Dimension | Assessment |
|-----------|------------|
| **Extension declaration** | Extensions: field ranges. Any: type URLs. OneOf: enum of types. |
| **Core ignoring extensions** | Extensions: automatic. Any: the receiver decides. OneOf: old readers ignore new variants. |
| **Composition** | Extensions: fragile (number conflicts). Any: unlimited. OneOf: add variants freely. |
| **Type safety** | Extensions: typed at definition. Any: type-erased. OneOf: fully typed. |
| **Round-trip preservation** | Unknown fields are preserved by default in proto (since proto3 3.5+) |
| **Migration** | Field number management is critical; never reuse numbers. Wire-safe changes are additive. |

**Takeaway for agent-manager:** The OneOf pattern maps directly to TypeScript
discriminated unions. The "unknown fields preserved by default" behavior is exactly
what we want -- the core should round-trip adapter extensions it doesn't understand.

---

## 5. Kubernetes Custom Resource Definitions (CRDs)

### How CRDs Enable Extensibility

Kubernetes CRDs allow users to define custom API resources with OpenAPI v3 validation
schemas. This is extensibility at the infrastructure level -- the API server validates
resources against schemas while allowing controlled openness.

### Key Patterns

#### The spec / status Separation

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: agentconfigs.agent-manager.dev
spec:
  group: agent-manager.dev
  names:
    kind: AgentConfig
    plural: agentconfigs
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                command:
                  type: string
                args:
                  type: array
                  items:
                    type: string
            status:
              type: object
      subresources:
        status: {}
```

The `spec` / `status` split separates:
- **spec**: desired state, owned by users/operators
- **status**: observed state, owned by controllers

This maps to agent-manager as:
- **Core config**: the "spec" -- what the user declares
- **Generated output / state**: the "status" -- what `am apply` produces

#### x-kubernetes-preserve-unknown-fields (Passthrough)

```yaml
properties:
  spec:
    type: object
    properties:
      adapters:
        type: object
        x-kubernetes-preserve-unknown-fields: true
```

Setting `x-kubernetes-preserve-unknown-fields: true` tells the API server:
- Do NOT prune unknown keys in this subtree
- Persist arbitrary JSON here
- CEL validation cannot introspect these values

This is exactly the "adapter extensions bag" pattern -- the core schema says
"adapters is an object, and I won't validate or prune anything inside it."

#### Structural Schema Requirements (K8s 1.15+)

CRDs require structural schemas for server-side features (pruning, defaulting,
Server-Side Apply). This means:
- Every field must have a defined `type`
- Only one of `properties`, `additionalProperties`, or `items` per level
- `additionalProperties: false` is NOT allowed (use pruning instead)

**Implication:** K8s solved the "strict core + open extensions" problem by making
the core structural (validated, pruned) while marking extension points as
`preserve-unknown-fields` (unvalidated, unpruned).

#### Server-Side Apply + Field Managers

When multiple controllers operate on the same resource:
- Each controller uses Server-Side Apply with a unique `fieldManager` name
- Controllers only apply the fields they own
- Conflicts are detected and reported

This is analogous to agent-manager's adapter system: each adapter "manages" its own
fields within the config. Core manages core fields; claude-code adapter manages
`adapters.claude-code`; cursor adapter manages `adapters.cursor`.

### Analysis for agent-manager

| Dimension | Assessment |
|-----------|------------|
| **Extension declaration** | CRD schema + `preserve-unknown-fields` for extension zones |
| **Core ignoring extensions** | Pruning removes unknown fields EXCEPT in preserved zones |
| **Composition** | Multiple controllers via Server-Side Apply field ownership |
| **Type safety** | Structural schema for core; opaque blobs for extensions |
| **Round-trip preservation** | Preserved zones survive round-trips; non-preserved zones get pruned |
| **Migration** | Conversion webhooks for version changes; ratcheting for tightening validation |

**Takeaway:** The CRD model validates that our design of "strongly typed core +
opaque adapter sections" is production-proven at massive scale. The `preserve-unknown-fields`
concept maps directly to Zod's `.passthrough()` and TypeScript's `Record<string, unknown>`.

---

## 6. GraphQL Schema Extensions + Directives

### Type Extensions

GraphQL allows extending existing types with new fields using the `extend` keyword:

```graphql
# Original type (core)
type Server {
  name: String!
  command: String!
  args: [String!]
  tags: [String!]
}

# Extension (adapter adds fields)
extend type Server {
  alwaysAllow: [String!]     # Claude Code extension
  cursorDisabled: Boolean    # Cursor extension
}
```

Schema extensions are first-class in GraphQL -- they modify the schema at build time,
not at runtime. Used heavily in:
- **Schema stitching** -- combining subschemas from different services
- **Apollo Federation** -- extending types across microservices
- **Code generation** -- plugins add fields via `addToSchema`

### Custom Directives

Directives are metadata annotations that modify schema behavior:

```graphql
directive @adapterOnly(adapter: String!) on FIELD_DEFINITION

type Server {
  name: String!
  command: String!
  alwaysAllow: [String!] @adapterOnly(adapter: "claude-code")
  cursorDisabled: Boolean @adapterOnly(adapter: "cursor")
}
```

Directives can:
- Be placed on types, fields, arguments, enum values, etc.
- Accept arguments with default values
- Be repeatable or non-repeatable
- Modify resolver behavior at runtime (auth, logging, formatting)

### The extensions Field

GraphQL implementations store custom metadata in an `extensions` field on types:

```typescript
const serverType = schema.getType("Server");
serverType.extensions.adapterMeta = {
  "claude-code": { alwaysAllow: true },
  "cursor": { disabled: true },
};
```

The `extensions` object is an opaque bag -- the GraphQL runtime ignores it, but
libraries and tools can read/write it. This is GraphQL's version of `x-` extensions.

### Analysis for agent-manager

| Dimension | Assessment |
|-----------|------------|
| **Extension declaration** | `extend type` or custom directives with arguments |
| **Core ignoring extensions** | Extensions modify the schema; directives are metadata |
| **Composition** | Multiple services extend the same type (federation) |
| **Type safety** | Full -- extended fields are typed in the schema |
| **Round-trip preservation** | Schema-level; runtime values are always typed |
| **Migration** | Deprecation via `@deprecated` directive; additive-only schema changes |

**Takeaway:** The `extend type` pattern is powerful for build-time composition but
doesn't map well to TOML configuration. The `extensions` object pattern (opaque bag
on types) is analogous to our `adapters` table. The directive pattern (metadata
annotations that modify behavior) could inspire adapter-specific processing hints.

---

## 7. VS Code package.json "contributes" Pattern

### How It Works

VS Code extensions declare their capabilities via a `contributes` field in
`package.json`. This is a declarative manifest -- the extension says "I provide
these commands, menus, keybindings, languages, themes, etc." and VS Code's activation
system lazily loads the extension when its contributions are needed.

```json
{
  "name": "my-extension",
  "contributes": {
    "commands": [
      {
        "command": "extension.sayHello",
        "title": "Say Hello",
        "category": "My Extension",
        "icon": "$(rocket)"
      }
    ],
    "configuration": {
      "title": "My Extension Settings",
      "properties": {
        "myExtension.enableFeature": {
          "type": "boolean",
          "default": false,
          "description": "Enable experimental feature"
        }
      }
    },
    "menus": {
      "commandPalette": [
        {
          "command": "extension.sayHello",
          "when": "editorTextFocus"
        }
      ]
    },
    "keybindings": [
      {
        "command": "extension.sayHello",
        "key": "ctrl+f1",
        "when": "editorTextFocus"
      }
    ],
    "jsonValidation": [
      {
        "fileMatch": ".myconfig",
        "url": "./schemas/myconfig.schema.json"
      }
    ]
  }
}
```

### Key Design Properties

1. **Fixed contribution points:** VS Code defines a finite set of contribution
   categories (commands, menus, keybindings, languages, themes, snippets, views,
   etc.). Extensions choose which to populate.

2. **JSON Schema validation:** When contributing `configuration` keys, the extension
   provides a JSON Schema that VS Code uses for settings editor tooling.

3. **Lazy activation:** Extensions are loaded only when their contributions are
   triggered (via `onCommand:`, `onView:`, `onLanguage:`, etc.).

4. **No cross-extension field pollution:** Each extension has its own `contributes`
   block; they never write into each other's schemas.

5. **Namespace by convention:** Configuration keys use `extensionName.propertyName`
   dotted names to avoid collisions.

### Analysis for agent-manager

| Dimension | Assessment |
|-----------|------------|
| **Extension declaration** | Finite set of contribution points, each with its own schema |
| **Core ignoring extensions** | Core reads only known contribution points, ignores unknown keys |
| **Composition** | Each extension contributes independently; merged by VS Code at load |
| **Type safety** | JSON Schema for configuration contributions; TypeScript API for runtime |
| **Round-trip preservation** | N/A -- declarative manifest, not round-tripped |
| **Migration** | Semantic versioning of extension API; deprecated contributions warned |

**Takeaway:** The "contribution points" model is excellent for agent-manager's adapter
system. Each adapter declares what it "contributes" to the config generation process:

```toml
# The adapter says "I contribute these features to server configs"
[adapters.claude-code.contributes]
server_fields = ["alwaysAllow", "trust"]
hooks = true
instructions_format = "CLAUDE.md"
mcp_format = ".mcp.json"
```

This is more structured than an opaque `metadata` bag -- the adapter explicitly
declares its capabilities, and the core can validate the contribution structure.

---

## 8. Cargo [package.metadata] Pattern

### How It Works

Cargo.toml reserves `[package.metadata]` as an explicitly ignored area. Cargo never
reads, warns about, or processes keys under `package.metadata`. This is the designated
"third-party tools put your config here" zone.

```toml
[package]
name = "my-crate"
version = "0.1.0"

# Cargo reads and validates these:
[dependencies]
serde = "1.0"

# Cargo completely ignores these:
[package.metadata.deb]
maintainer = "Team <team@example.com>"
section = "utility"
assets = [["target/release/my-app", "usr/bin/", "755"]]

[package.metadata.release]
pre-release-commit-message = "Release {{version}}"
tag-name = "v{{version}}"

[package.metadata.dist]
ci = "github"
installers = ["shell"]
```

### Tool Examples

| Tool | Metadata Key | What It Stores |
|------|-------------|----------------|
| cargo-deb | `[package.metadata.deb]` | Debian package settings (maintainer, section, assets, depends) |
| cargo-dist | `[package.metadata.dist]` | Distribution config (CI, installers, npm-package) |
| cargo-release | `[package.metadata.release]` | Release workflow (commit messages, tag patterns, pre-release hooks) |
| cargo-deny | Separate `deny.toml` | License checks, advisories, bans (prefers its own file) |

### How Rust Handles This in Code (Serde Patterns)

#### Permissive parsing (capture unknown fields):

```rust
use serde::Deserialize;
use std::collections::HashMap;
use toml::Value;

#[derive(Deserialize, Debug)]
struct MyToolConfig {
    pub enabled: Option<bool>,
    pub timeout_secs: Option<u32>,

    // Capture any extra fields the tool doesn't recognize
    #[serde(flatten)]
    pub extras: HashMap<String, Value>,
}
```

#### Strict parsing (reject unknown fields):

```rust
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct StrictConfig {
    pub name: String,
    pub count: u32,
}
```

#### Advisory reporting (warn but don't fail):

The `serde_ignored` crate wraps a deserializer and calls a callback for every ignored
field -- allowing tools to emit "did you mean X?" suggestions without failing.

#### Staged parsing (the recommended pattern):

1. **Phase 1 (permissive):** Deserialize into a struct with `#[serde(flatten)]` to
   capture unknown keys
2. **Phase 2 (strict):** For critical sub-structures, deserialize with
   `#[serde(deny_unknown_fields)]`
3. **Phase 3 (report):** If unknown keys were found, emit warnings with migration hints

> [!warning] Serde limitation
> `#[serde(flatten)]` and `#[serde(deny_unknown_fields)]` CANNOT be combined on
> the same struct. Use staged parsing instead.

### Workspace-Level Metadata

Cargo also supports `[workspace.metadata]` for workspace-wide tool configuration.
Tools can check workspace metadata as a fallback when package-level metadata is absent.

cargo-release demonstrates precedence: `[package.metadata.release]` > `release.toml`.
This dual-source pattern allows both embedded and external configuration.

### Analysis for agent-manager

| Dimension | Assessment |
|-----------|------------|
| **Extension declaration** | Namespaced subtables under a designated "metadata" parent |
| **Core ignoring extensions** | By design -- Cargo never processes metadata content |
| **Composition** | Multiple tools coexist via unique subtable names |
| **Type safety** | Tool-level: each tool defines and validates its own struct |
| **Round-trip preservation** | Cargo preserves all metadata when rewriting Cargo.toml |
| **Migration** | Tools can support both old and new keys, emit deprecation warnings |

**Takeaway:** This is the strongest precedent for agent-manager's design. The pattern
maps directly:

| Cargo | agent-manager |
|-------|---------------|
| `[package.metadata.deb]` | `[servers.outlook.adapters.claude-code]` |
| `[workspace.metadata.dist]` | `[settings.adapters.claude-code]` (global adapter defaults) |
| Cargo ignores metadata | Core schema ignores adapter subtables |
| cargo-deb validates `[package.metadata.deb]` | claude-code adapter validates its section |

---

## 9. The "Extras" / Passthrough Pattern

### The Problem

When a system reads a configuration file, modifies some fields, and writes it back,
it must not lose fields it doesn't understand. This "round-trip preservation" is
critical for extensible schemas where multiple tools read/write the same file.

### Pattern Variants Across Languages

#### Go: json.RawMessage + overflow map

```go
type ServerConfig struct {
    Command string            `json:"command"`
    Args    []string          `json:"args"`
    // Capture unknown fields for round-trip
    Extras  map[string]json.RawMessage `json:"-"`
}

func (s *ServerConfig) UnmarshalJSON(data []byte) error {
    type Alias ServerConfig
    aux := &struct{ *Alias }{Alias: (*Alias)(s)}
    if err := json.Unmarshal(data, aux); err != nil {
        return err
    }
    // Capture everything else into Extras
    return json.Unmarshal(data, &s.Extras)
}
```

#### Java: Jackson @JsonAnySetter / @JsonAnyGetter

```java
public class ServerConfig {
    private String command;
    private List<String> args;

    // Overflow map for unknown fields
    private Map<String, Object> extras = new HashMap<>();

    @JsonAnySetter
    public void setExtra(String key, Object value) {
        extras.put(key, value);
    }

    @JsonAnyGetter
    public Map<String, Object> getExtras() {
        return extras;
    }
}
```

#### Rust: serde #[serde(flatten)] + serde_ignored_fields

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize, Serialize)]
struct ServerConfig {
    command: String,
    args: Option<Vec<String>>,

    #[serde(flatten)]
    extras: HashMap<String, toml::Value>,
}
```

The `serde_ignored_fields` crate goes further -- it preserves ignored fields through
a deserialize-modify-serialize cycle, maintaining the exact original values.

#### TypeScript/Zod: .passthrough()

```typescript
const CoreSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
}).passthrough(); // Preserves unknown fields

const parsed = CoreSchema.parse({
  command: "aws-outlook-mcp",
  args: [],
  alwaysAllow: ["read_email"],  // unknown to core
  trust: "full",                // unknown to core
});
// parsed = { command: "aws-outlook-mcp", args: [], alwaysAllow: ["read_email"], trust: "full" }
```

#### The Tolerant Reader Pattern

Named by Martin Fowler, the Tolerant Reader pattern says:
> "Be as tolerant as possible when reading data from another service. If the
> consumer doesn't understand a field, it should ignore it, not fail."

This is the philosophical foundation of all extras/passthrough patterns.

### Design Decisions

| Decision | Option A: Fail | Option B: Warn | Option C: Preserve Silently |
|----------|:---:|:---:|:---:|
| Unknown field in core section | Best for catching typos | Good for migration | Bad -- hides errors |
| Unknown field in adapter section | Bad -- blocks new adapters | Good | Best for forward compat |
| Unknown adapter name | Bad | Good | Best for forward compat |

**Recommended strategy for agent-manager:**
- **Core fields:** Warn on unknown (catch typos, suggest "did you mean X?")
- **Adapter sections:** Preserve silently (forward compatibility)
- **Unknown adapter names:** Preserve silently (the adapter might not be installed yet)

---

## 10. Recommended Schema Design for agent-manager

### Design Principles

Based on the nine patterns analyzed above, the recommended design follows these principles:

1. **Cargo-style metadata zones:** Adapter config lives in `[*.adapters.<name>]` subtables
   that the core explicitly ignores during validation (Pattern 8)
2. **Two-phase validation:** Core validates core, adapters validate their sections (Pattern 3, Zod)
3. **Tolerant core, strict adapters:** Core uses `.passthrough()` semantics for adapter
   zones; adapters use strict validation within their sections (Pattern 9)
4. **Discriminated types:** Each adapter config uses a `type` discriminator for Zod
   validation routing (Pattern 3)
5. **Preserve unknown fields:** Round-trip preservation of adapter data the core
   doesn't understand (Pattern 9)
6. **No core schema pollution:** Adapter fields never appear at the same level as core
   fields (Patterns 1, 2, 8)

### TOML Structure

#### Where adapter-specific config lives

```toml
# ~/.config/agent-manager/config.toml

# ==========================================================================
# Core schema -- validated by agent-manager core
# ==========================================================================

[settings]
default_profile = "work"
sync_remote = "https://github.com/user/agent-config.git"

# Global adapter defaults (optional)
[settings.adapters.claude-code]
model = "opus"
max_budget_usd = 5

[settings.adapters.cursor]
enable_yolo_mode = false

# --------------------------------------------------------------------------
# Server definitions -- core fields are universal
# --------------------------------------------------------------------------
[servers.outlook]
command = "aws-outlook-mcp"
description = "Outlook email and calendar"
tags = ["email", "calendar", "work"]
env = { MIDWAY_AUTH = "true" }

# Adapter-specific extensions for this server
[servers.outlook.adapters.claude-code]
always_allow = ["read_email", "calendar_view"]
trust = "full"

[servers.outlook.adapters.cursor]
disabled = true  # Don't include in Cursor configs

[servers.outlook.adapters.windsurf]
server_url = "http://localhost:3000/mcp"

# --------------------------------------------------------------------------
# Another server -- no adapter overrides needed
# --------------------------------------------------------------------------
[servers.tavily]
command = "bunx"
args = ["tavily-mcp@latest"]
description = "Web search and extraction"
tags = ["web", "search"]
env = { TAVILY_API_KEY = "${TAVILY_API_KEY}" }
# No [servers.tavily.adapters.*] -- core config is sufficient

# --------------------------------------------------------------------------
# Profiles -- core fields + optional adapter defaults
# --------------------------------------------------------------------------
[profiles.work]
description = "Full work environment"
inherits = "base"
servers = ["outlook", "slack", "exa"]

# Profile-level adapter overrides (applied to all servers in this profile)
[profiles.work.adapters.claude-code]
hooks = [
  { event = "PostToolUse", command = "scripts/write-guardian.sh" },
]
instructions = ["CLAUDE.md", ".claude/CLAUDE.md"]

[profiles.work.adapters.cursor]
rules_dir = ".cursor/rules"

# --------------------------------------------------------------------------
# Skills with adapter-specific config
# --------------------------------------------------------------------------
[skills.research-rabbithole]
path = "~/.claude/skills/research-rabbithole"
description = "Multi-agent parallel research"
tags = ["research"]

[skills.research-rabbithole.adapters.claude-code]
trigger = "/research-rabbithole"

# --------------------------------------------------------------------------
# Instructions with adapter-specific targeting
# --------------------------------------------------------------------------
[instructions.project-rules]
content_path = "CLAUDE.md"
scope = "always"

[instructions.project-rules.adapters.claude-code]
location = "CLAUDE.md"        # Written as CLAUDE.md

[instructions.project-rules.adapters.cursor]
location = ".cursor/rules/project.mdc"
format = "mdc"                # Cursor uses .mdc format with frontmatter

[instructions.project-rules.adapters.copilot]
location = ".github/copilot-instructions.md"
```

### TypeScript Types

```typescript
import { z } from "zod";

// =========================================================================
// Core schemas (validated by agent-manager core)
// =========================================================================

const ServerCoreSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  transport: z.enum(["stdio", "http", "sse"]).default("stdio"),
  // Adapter sections: core does NOT validate these -- just preserves them
  adapters: z.record(z.string(), z.unknown()).optional(),
});

const ProfileCoreSchema = z.object({
  description: z.string().optional(),
  inherits: z.string().optional(),
  servers: z.array(z.string()).optional(),
  server_tags: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
  settings: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
  adapters: z.record(z.string(), z.unknown()).optional(),
});

const SkillCoreSchema = z.object({
  path: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  adapters: z.record(z.string(), z.unknown()).optional(),
});

const InstructionCoreSchema = z.object({
  content_path: z.string().optional(),
  content: z.string().optional(),
  scope: z.enum(["always", "glob", "agent-decision", "manual"]).default("always"),
  globs: z.array(z.string()).optional(),
  adapters: z.record(z.string(), z.unknown()).optional(),
});

const ConfigCoreSchema = z.object({
  settings: z.object({
    default_profile: z.string().optional(),
    sync_remote: z.string().url().optional(),
    auto_sync: z.boolean().default(true),
    log_level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
    adapters: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  servers: z.record(z.string(), ServerCoreSchema).optional(),
  skills: z.record(z.string(), SkillCoreSchema).optional(),
  profiles: z.record(z.string(), ProfileCoreSchema).optional(),
  instructions: z.record(z.string(), InstructionCoreSchema).optional(),
});

// Inferred TypeScript types
type ServerCore = z.infer<typeof ServerCoreSchema>;
type ProfileCore = z.infer<typeof ProfileCoreSchema>;
type Config = z.infer<typeof ConfigCoreSchema>;

// =========================================================================
// Adapter schemas (validated by each adapter independently)
// =========================================================================

// -- Claude Code adapter --
const ClaudeCodeServerAdapterSchema = z.object({
  always_allow: z.array(z.string()).optional(),
  trust: z.enum(["full", "limited"]).optional(),
});

const ClaudeCodeProfileAdapterSchema = z.object({
  hooks: z.array(z.object({
    event: z.enum(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"]),
    command: z.string(),
    timeout_ms: z.number().optional(),
  })).optional(),
  instructions: z.array(z.string()).optional(),
  model: z.string().optional(),
  max_budget_usd: z.number().optional(),
});

const ClaudeCodeInstructionAdapterSchema = z.object({
  location: z.string(),
});

// -- Cursor adapter --
const CursorServerAdapterSchema = z.object({
  disabled: z.boolean().optional(),
});

const CursorProfileAdapterSchema = z.object({
  rules_dir: z.string().optional(),
});

const CursorInstructionAdapterSchema = z.object({
  location: z.string(),
  format: z.enum(["md", "mdc"]).default("md"),
});

// -- Windsurf adapter --
const WindsurfServerAdapterSchema = z.object({
  server_url: z.string().url().optional(),
});

// =========================================================================
// Adapter registry (maps adapter names to their schemas)
// =========================================================================

const ADAPTER_SCHEMAS = {
  "claude-code": {
    server: ClaudeCodeServerAdapterSchema,
    profile: ClaudeCodeProfileAdapterSchema,
    instruction: ClaudeCodeInstructionAdapterSchema,
  },
  "cursor": {
    server: CursorServerAdapterSchema,
    profile: CursorProfileAdapterSchema,
    instruction: CursorInstructionAdapterSchema,
  },
  "windsurf": {
    server: WindsurfServerAdapterSchema,
  },
} as const;
```

### Validation Strategy

```typescript
// =========================================================================
// Two-phase validation
// =========================================================================

function validateConfig(rawToml: unknown): ValidatedConfig {
  // Phase 1: Core validation (preserves adapter sections as unknown)
  const coreResult = ConfigCoreSchema.parse(rawToml);

  // Phase 2: Per-adapter validation (only for installed adapters)
  const warnings: string[] = [];

  for (const [serverName, server] of Object.entries(coreResult.servers ?? {})) {
    for (const [adapterName, adapterConfig] of Object.entries(server.adapters ?? {})) {
      const adapterSchemas = ADAPTER_SCHEMAS[adapterName as keyof typeof ADAPTER_SCHEMAS];

      if (!adapterSchemas) {
        // Unknown adapter -- preserve silently, warn optionally
        warnings.push(
          `Unknown adapter "${adapterName}" on server "${serverName}" -- ` +
          `config preserved but not validated`
        );
        continue;
      }

      if (adapterSchemas.server) {
        try {
          adapterSchemas.server.parse(adapterConfig);
        } catch (e) {
          warnings.push(
            `Invalid ${adapterName} config on server "${serverName}": ${e.message}`
          );
        }
      }
    }
  }

  return { config: coreResult, warnings };
}
```

### How This Composes

```
config.toml
  |
  |-- [servers.outlook]          <-- Core validates: command, args, env, tags
  |     |
  |     |-- [adapters.claude-code]  <-- Claude Code adapter validates: always_allow, trust
  |     |-- [adapters.cursor]       <-- Cursor adapter validates: disabled
  |     |-- [adapters.windsurf]     <-- Windsurf adapter validates: server_url
  |     |-- [adapters.future-tool]  <-- Unknown adapter: preserved, not validated
  |
  |-- [profiles.work]           <-- Core validates: servers, skills, inherits
  |     |
  |     |-- [adapters.claude-code]  <-- Claude Code: hooks, instructions, model
  |     |-- [adapters.cursor]       <-- Cursor: rules_dir
```

### Design Decision Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Where adapters live | `[entity.adapters.<name>]` subtable | Cargo-style metadata zone; TOML-idiomatic |
| Core validation of adapter sections | None (preserved as `z.unknown()`) | Tolerant Reader; forward compatibility |
| Adapter validation | Each adapter validates its own schema | VS Code contributes pattern |
| Unknown adapter names | Preserved with optional warning | Future adapters shouldn't break current configs |
| Unknown fields in core | Warn (suggest corrections) | Catch typos in `command`, `tags`, etc. |
| Unknown fields in adapter sections | Adapter decides (strict by default) | Each adapter owns its schema strictness |
| Global adapter defaults | `[settings.adapters.<name>]` | Cargo workspace.metadata pattern |
| Per-entity adapter overrides | `[servers.X.adapters.<name>]` | Most specific wins |
| Separate adapter files | Optional escape hatch via `adapters/` dir | For complex adapter configs (Pattern 2, Option C) |
| Migration strategy | Staged parsing + deprecation warnings | Cargo-release precedent |

### How `am apply` Uses This

```
am apply --profile work --target claude-code

1. Load config.toml (core validation)
2. Resolve profile "work" (merge inherited servers, skills)
3. For each server in profile:
   a. Start with core fields (command, args, env)
   b. Merge adapter-specific overrides from [servers.X.adapters.claude-code]
   c. Merge profile-level adapter overrides from [profiles.work.adapters.claude-code]
   d. Merge global adapter defaults from [settings.adapters.claude-code]
4. Claude Code adapter transforms merged config into:
   - ~/.claude.json (mcpServers section)
   - .mcp.json (project-scoped servers)
   - CLAUDE.md (instructions)
   - .claude/settings.json (hooks, permissions)
```

The adapter is a pure function:
`(coreConfig + adapterOverrides) => IDE-specific output files`

---

## Cross-Pattern Synthesis

| Pattern | Core Ignores Extensions? | Extensions Typed? | Multiple Adapters? | Round-Trip Safe? | Best For |
|---------|:---:|:---:|:---:|:---:|---------|
| OpenAPI x- | Yes (prefix convention) | No | Yes | Tool-dependent | Loose metadata |
| TOML namespaced tables | Yes (by design) | Per-adapter | Yes | Yes | Configuration files |
| Zod discriminated unions | N/A (validation layer) | Yes | Yes | Via passthrough | TypeScript validation |
| Protobuf OneOf/Any | Yes (wire format) | OneOf: yes; Any: no | OneOf: enum; Any: unlimited | Yes (since proto3.5) | Serialization |
| K8s CRDs | Yes (pruning + preserve) | Core: yes; Extensions: no | Via field managers | Preserved zones only | API resources |
| GraphQL extend type | Modifies schema | Yes | Via federation | N/A | API schemas |
| VS Code contributes | Yes (fixed points) | Yes (JSON Schema) | Each extension independent | N/A | Plugin systems |
| Cargo metadata | Yes (explicit ignore) | Tool-level | Yes (unique subtables) | Yes | Build tool config |
| Extras/passthrough | Yes (catch-all map) | No | Flat bag | Yes | Round-trip preservation |

The recommended agent-manager design combines:
- **Cargo metadata** for the structural pattern (`[entity.adapters.<name>]`)
- **Zod discriminated unions** for type-safe TypeScript validation
- **K8s preserve-unknown-fields** for forward compatibility semantics
- **VS Code contributes** for adapter capability declaration
- **Tolerant Reader** for graceful handling of unknown adapters

This synthesis provides strong typing where it matters (core fields, known adapter
fields), forward compatibility where flexibility matters (unknown adapters, future
adapter fields), and clean separation of concerns (core validates core, adapters
validate their sections).
