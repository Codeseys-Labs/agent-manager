# Backlog Execution — State Marker

## Run start
- Date: 2026-05-31
- Start commit: 1b7bb9c (docs: AGENTS.md canonical, overstory removed)
- Baseline gates: 3064 tests pass, lint clean, src/ typecheck-clean (63 tsc errors = 52 @silvery vendor + 11 first-party test/scripts)

## Scope corrections applied (override the audit)
- Marketplace = DEFERRED to v2 (web-platform era), NOT deleted. Keep src/marketplace/*. Supersedes ADR-0039/0052 deletion.
- ACP/A2A protocol router (pillar 3) = IN v1 supported core (agent-usage enhancement is the CLI's thesis), NOT fenced as experimental.
- .mulch/.seeds/.canopy = intentional project tooling (keep). Only .overstory removed.

## Already done before this run
- P1-C committed meta-tooling: .overstory removed + gitignored.
- P0-4 (partial): AGENTS.md canonical + stats corrected; CLAUDE.md → pointer; marketplace contradiction resolved.
