---
status: accepted
date: 2026-04-10
---

# ADR-0023: Tiered Secret Detection with BetterLeaks Integration

## Context

MCP server configurations frequently contain API keys, tokens, and credentials
in their `env` fields, `args` arrays, or `command` strings. When users import
configs from native tools (`am import`) or add servers (`am add server`), these
secrets need to be detected and encrypted before being committed to the
git-backed config repo.

Two classes of secret detection exist:

1. **Structural**: the env var key name itself indicates a secret (`OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`). The value format doesn't matter.
2. **Value-based**: the value matches a known secret pattern (`sk-ant-api03-...`,
   `ghp_...`, `tvly-...`) but the key name may not be obvious.

Building a comprehensive value-based scanner requires maintaining 200+ regex
patterns, handling encoded secrets, BPE tokenization for entropy analysis,
and CEL-based validation against live APIs. This is the domain of dedicated
secret scanning tools like gitleaks and its successor BetterLeaks.

### Prior art

- **gitleaks**: 26M downloads, 200+ rules, TOML config. Author (Zach Rice)
  lost control of the repo.
- **BetterLeaks**: Successor by same author, MIT license, sponsored by Aikido
  Security. Drop-in replacement with BPE token efficiency scanning (98.6%
  recall vs 70.4% entropy), CEL validation, parallelized scanning. Designed
  for AI agent consumption (`--no-banner --report-format json`).
- **detect-secrets** (Yelp): Python, baseline management, less suitable for
  embedding in a Bun/TS CLI.

## Decision

### Two-tier architecture

**Tier 1 (built-in, always runs)**: Key-name-based detection.

If a server env var key matches known patterns (`/api[_-]?key/i`, `/secret/i`,
`/token/i`, `/password/i`, or 40+ provider-specific patterns like `/openai/i`,
`/anthropic/i`, `/tavily/i`), the value is treated as a secret regardless
of its format. This is implemented in `src/core/secret-detection.ts`.

This covers >90% of MCP server configs because MCP servers use named env vars
for credentials. The key name IS the signal.

**Tier 2 (BetterLeaks, when installed)**: Value-based + inline detection.

For secrets in `args` arrays, `command` strings, and env values where the
key name isn't a known pattern — delegate to BetterLeaks. It scans via
`betterleaks stdin --report-format json` and returns typed findings.

BetterLeaks is managed at `~/.config/agent-manager/bin/betterleaks` and
installed via `am secret install-scanner` (downloads from GitHub releases)
or `brew install betterleaks`.

### Auto-encrypt on import/add

Secrets are encrypted inline during `am import` and `am add server`:

1. Tier 1 scan detects env vars with secret key names
2. Tier 2 scan (if available) detects inline secrets
3. Encryption key is auto-generated if none exists
4. Each detected secret value is replaced with `${KEY_NAME}` reference
5. Original value is AES-256-GCM encrypted and stored in `settings.env`
6. Config is written and committed — git backend stays clean

Users can opt out with `--no-encrypt` on import.

### Scan-only mode

`am secret scan` shows detected secrets without modifying config.
`am secret scan --fix` applies the substitution + encryption.
`am doctor` reports both secret audit results and BetterLeaks availability.

## Consequences

### Positive

- Zero-friction security: secrets encrypted automatically on import, no extra steps
- Clean separation: am-cli handles structural detection, BetterLeaks handles value detection
- No new runtime dependencies: BetterLeaks is optional, Tier 1 is pure TypeScript
- Git backend never contains raw secrets (unless user explicitly opts out)
- BetterLeaks gets 200+ rules, BPE tokenization, and CEL validation without
  us maintaining any of it

### Negative

- Tier 1 can false-positive on env vars named `AUTH_MODE` or `SECRET_SCAN_ENABLED`
  that aren't actually credentials. Mitigation: short/trivial values are skipped.
- BetterLeaks is a Go binary (20MB). We can't embed it in the Bun single-binary.
  Mitigation: managed install to config dir, graceful fallback when absent.
- BetterLeaks is young (v1.x, 750 stars). Mitigation: we don't depend on it —
  it's an optional enhancement over the built-in Tier 1.

### Neutral

- The `--no-encrypt` flag is an escape hatch. Some users may want raw secrets
  in their config (local-only, no push). That's their choice.

## Alternatives Considered

### 1. Build comprehensive regex patterns in-house

Maintain our own 200+ pattern library like gitleaks.

**Rejected**: duplicating years of gitleaks/BetterLeaks work. Secret patterns
change constantly as providers update key formats. Maintenance burden is high
and our core competency is config management, not secret scanning.

### 2. Use gitleaks instead of BetterLeaks

Shell out to gitleaks (the established tool).

**Rejected**: BetterLeaks is the successor by the same author with better
detection (BPE vs entropy), active development, and AI-agent-optimized
output. gitleaks is effectively in maintenance mode.

### 3. Always require BetterLeaks

Make BetterLeaks mandatory for secret detection.

**Rejected**: violates our zero-external-dependency principle. Users should
be able to use am-cli without installing a Go binary. Tier 1 key-name
detection covers the common case.

### 4. Block on apply instead of encrypting on import

Detect secrets at apply time and refuse to write native configs.

**Rejected and reverted**: terrible UX. Users had to run a separate
`am secret scan --fix` step. Auto-encrypting on import is zero-friction.

## References

- [ADR-0012](0012-application-level-encryption.md) — AES-256-GCM encryption
- [ADR-0019](0019-security-hardening.md) — security hardening
- [BetterLeaks](https://github.com/betterleaks/betterleaks) — Go secret scanner
- [gitleaks](https://github.com/gitleaks/gitleaks) — predecessor
