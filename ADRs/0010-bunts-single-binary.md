---
status: accepted
date: 2026-04-07
---

# ADR-0010: BunTS Single Binary Distribution

## Context

Most existing MCP management tools require a Node.js or Python runtime to install
and run. This creates friction: version conflicts, global install pollution, PATH
issues. The "download and run" experience of tools like chezmoi (single Go binary)
or ripgrep (single Rust binary) is significantly better.

Bun provides `bun build --compile` which bundles TypeScript source + dependencies +
the Bun runtime into a single native executable. Cross-compilation from one machine
targets 5+ platforms.

## Decision

agent-manager is written in TypeScript and compiled to single-platform binaries via
`bun build --compile`. The binary includes:
- Application code (CLI, adapters, config engine)
- All npm dependencies (TOML parser, Zod, isomorphic-git, MiniSearch, citty, @clack/prompts)
- Bun runtime
- Embedded assets (schema files, adapter templates)

**Build targets:**
- `bun-darwin-arm64` (macOS Apple Silicon)
- `bun-darwin-x64` (macOS Intel)
- `bun-linux-x64` (Linux x64)
- `bun-linux-arm64` (Linux ARM64)
- `bun-windows-x64` (Windows x64)

**Distribution channels:**
- GitHub Releases (pre-compiled binaries)
- Homebrew tap (`brew install Codeseys-Labs/tap/agent-manager`)
- npm (`npx agent-manager` for users who prefer npm)

**Binary naming:** `agent-manager` with `am` as a symlink/alias.

## Consequences

### Positive
- Zero runtime dependencies — download and run
- Cross-compilation from a single CI runner (ubuntu-latest)
- TypeScript provides excellent developer ergonomics for the codebase
- Bun's bundler handles tree-shaking and minification
- SQLite embedded via `bun:sqlite` for local state
- Fast startup (~100ms for compiled Bun binaries)

### Negative
- Large binary size: 60-110 MB depending on platform (Bun runtime is the bulk)
  (mitigation: acceptable for a developer tool; Go/Rust would be 10-20 MB but
  require a different language)
- Bun compile is still maturing — edge cases in native module support
  (mitigation: all core dependencies are pure JS, no native addons)
- Cannot dynamically load TypeScript at runtime from compiled binary
  (see ADR-0011 for adapter packaging implications)

### Neutral
- npm distribution provides a fallback for users who prefer `npx`
- Homebrew tap is standard for macOS developer tools
- CI/CD uses `oven-sh/setup-bun@v2` GitHub Action

## Alternatives Considered

- **Node.js + npm only:** Rejected — runtime dependency, no single binary.
- **Deno compile:** Rejected — smaller binaries but worse npm compatibility
  and less mature compilation.
- **Go:** Rejected — tiny binaries but different language; TypeScript ecosystem
  is better for this tool (TOML parsing, MCP SDK, web frameworks).
- **Rust:** Rejected — same language concern. The adapter ecosystem benefits from
  JavaScript/TypeScript's ubiquity.

## References

- [03-bunts-cross-platform-compilation.md](../research/03-bunts-cross-platform-compilation.md) — Bun compile targets, binary sizes, CI/CD patterns
