---
status: accepted
date: 2026-04-07
---

# ADR-0004: TOML as Configuration Format

## Context

Every existing AI tool uses JSON for configuration (`.claude.json`, `mcp.json`,
`.cursor/mcp.json`). JSON lacks comments, is verbose, and is hostile to human editing.
Users frequently break JSON syntax with trailing commas or missing quotes.

We evaluated JSON, YAML, TOML, and KDL as the source-of-truth config format.

## Decision

Use **TOML** for agent-manager's source-of-truth configuration files.

TOML provides:
- **Comments** — explain why a server exists, why a setting is set
- **Sections** — natural grouping (`[servers.outlook]`, `[profiles.work]`)
- **Inline tables** — compact env vars: `env = { KEY = "value" }`
- **Multi-line strings** — instruction content without escaping
- **No trailing comma issues** — common JSON editing mistake
- **Strong typing** — dates, booleans, integers are distinct (not all strings)

The generated output files remain JSON/YAML/Markdown per IDE requirements —
TOML is only the source-of-truth format that users edit.

**Independent validation:** OpenAI's Codex CLI independently chose TOML for its
configuration in 2025, using `[profiles.<name>]` tables — the same pattern we adopt.
This convergence validates the format choice.

## Consequences

### Positive
- Human-friendly editing with comments and clear structure
- Comments survive round-trips (unlike JSON)
- Natural fit for the `[entity.adapters.<name>]` extension pattern
- Taplo provides schema validation, formatting, and LSP support
- Codex precedent reduces learning curve for users familiar with that tool

### Negative
- Less ubiquitous than JSON — some users unfamiliar with TOML syntax
  (mitigation: TOML is simpler than YAML, most devs encounter it via Cargo/pyproject)
- TOML arrays of tables (`[[array]]`) syntax can be confusing
  (mitigation: we minimize use of this pattern)
- Tooling ecosystem smaller than JSON
  (mitigation: `@iarna/toml` for Bun, Taplo for validation)

### Neutral
- Generated IDE config files are still JSON — TOML is only the source format
- Schema validation via JSON Schema (Taplo) or Zod (runtime)

## Alternatives Considered

- **JSON:** Rejected — no comments, verbose, hostile to human editing.
- **YAML:** Rejected — indentation-sensitive, implicit typing causes bugs (the Norway
  problem), security concerns with arbitrary code execution in some parsers.
- **KDL:** Rejected — too unfamiliar, small ecosystem, unclear long-term adoption.

## References

- [05-toml-profile-configuration-design.md](../research/05-toml-profile-configuration-design.md) — Codex convergence, Cargo profiles, mise patterns
- [01-existing-mcp-sync-tools.md](../research/01-existing-mcp-sync-tools.md) — Gap #2: no tool uses TOML
