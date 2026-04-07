---
status: accepted
date: 2026-04-07
---

# ADR-0007: Two-Phase Zod Validation

## Context

The Layered Core + Adapter Extensions architecture (ADR-0001) creates a validation
challenge: the core schema knows about core fields, and adapter-specific fields live
in `[entity.adapters.<name>]` subtables that the core shouldn't validate.

We need a validation strategy that:
1. Catches typos and errors in core fields (strict)
2. Preserves adapter sections it doesn't understand (tolerant)
3. Lets each adapter validate its own section independently
4. Handles unknown adapter names gracefully (forward-compatible)

## Decision

Use **two-phase Zod validation**:

**Phase 1 — Core validation:** Parse the full TOML config through a core Zod schema
that validates all core fields strictly. Adapter sections (`adapters.*`) are declared
as `z.record(z.string(), z.unknown()).optional()` — preserved as opaque data, not
validated.

**Phase 2 — Adapter validation:** For each installed adapter, extract its section from
the parsed config and validate against the adapter's own Zod schema. Unknown adapter
names (adapters not installed) trigger an optional warning but are preserved — they
may belong to an adapter the user has on another machine.

```typescript
// Phase 1: Core
const CoreServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  transport: z.enum(["stdio", "streamable-http", "sse"]).default("stdio"),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  adapters: z.record(z.string(), z.unknown()).optional(), // opaque
});

// Phase 2: Claude Code adapter
const ClaudeCodeServerSchema = z.object({
  always_allow: z.array(z.string()).optional(),
  trust: z.boolean().optional(),
});
```

**Error behavior:**
- Unknown field in core section → **warn** (likely typo, suggest correction)
- Unknown adapter name → **preserve silently**, optional info-level message
- Invalid field in adapter section → **warn** (adapter schema validation failure)
- Missing required core field → **error** (fail validation)

## Consequences

### Positive
- Core fields are validated strictly — catches typos and type errors
- Adapter sections are future-proof — adding a new adapter doesn't require config changes
- Each adapter owns its validation — no central schema bottleneck
- Configs sync cleanly across machines with different adapters installed

### Negative
- Two-phase validation is more complex to implement than single-pass
- Adapter validation errors may be confusing — user must know which adapter owns which field
  (mitigation: clear error messages: "Invalid field 'always_alow' in [servers.X.adapters.claude-code] — did you mean 'always_allow'?")

### Neutral
- Zod is the de facto TypeScript validation library — well-supported, good error messages
- JSON Schema can be generated from Zod schemas for IDE autocompletion (Taplo, VS Code)

## Alternatives Considered

- **Single-pass validation with adapter schemas merged:** Rejected — requires all adapter
  schemas available at validation time, breaks when syncing across machines.
- **No validation (parse TOML as plain objects):** Rejected — typos in config would
  silently fail. Validation catches errors early.
- **JSON Schema only (no Zod):** Rejected — JSON Schema is less ergonomic for runtime
  validation in TypeScript. Zod provides better types and error messages.

## References

- [11-extensible-schema-patterns.md](../research/11-extensible-schema-patterns.md) — Zod passthrough, Cargo metadata, K8s preserve-unknown-fields
