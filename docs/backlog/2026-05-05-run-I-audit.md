# Run I — Backlog Audit (post Run H closure)

**Baseline HEAD:** `9980a31` (build(typecheck,h-1): ambient JSX intrinsics).
**Tree:** clean. **Test suite:** 2829/2829 pass (verified by user-run `bun test`).

This audit refreshes the backlog after Run H landed 8 ADR promotions
+ 6 reviewer-flagged fixes. What remains, in priority order:

## P0 / P1 — Tractable in this run

| ID | Title | Pri | Effort | Source |
|----|-------|-----|--------|--------|
| H-1b | Document tsc baseline + categorize 190 test errors as deferred | P1 | S | Run H finding |
| L-A1 | ADR-0042 §SECURITY.md threat model — extract to repo SECURITY.md | P1 | M | Lens A research |
| L-A2 | ADR-0042 §am-pair design ADR — promote design from Lens A to a new ADR | P1 | M | Lens A research |
| L-C1 | Argon2id parameter override (`argon2 = { memoryKiB, time, parallelism }` in config) + raise default floor to 128 MiB | P1 | M | Lens C OWASP 2025 |
| L-C2 | age key-rotation grace-period support (legacy-recipient retention) — design-only ADR | P2 | M | Lens C |
| INFRA-1 | ROADMAP coverage badge: bun --coverage in CI + README badge | P2 | S | ROADMAP infra |
| INFRA-2 | npm package: split platform binaries to optionalDependencies | P2 | M | ROADMAP infra |
| ADR-0036-cleanup | Remove `AM_VARIANTS=1` gate (rolling release) | P2 | S | ADR-0036 implementation note |

## P2 — Defer (XL or external blockers)

| ID | Title | Why defer |
|----|-------|-----------|
| ADR-0043 | Hosted UI auth tiers full implementation | XL — needs Lens B's 5-tier dispatcher, OAuth flows for 4 backends. Multi-week. |
| ADR-0045 | CodeMirror 6 editor | Blocked on hosted UI bundle pipeline (which itself blocks on ADR-0043). |
| ADR-0042 §browser-decryption | argon2-browser + age-encryption WASM bundle | XL — hosted UI bundle pipeline dependency. |
| H-1c | citty `Resolvable<>` test refactor (190 errors) | M but cosmetic — bun test passes. Worth a single-shot wave but better as separate PR. |
| H-1d | @silvery package shim to bypass node_modules tsc descent | Vendor-side issue; multiple workarounds possible, none clean. Document and move on. |
| INFRA-3 | Windows CI runner + junction-point symlinks | L — needs CI infra work. |

## Strategy for Run I

Wave M: 4 parallel impl items (L-C1, INFRA-1, ADR-0036-cleanup, H-1c).
Wave N: 2 design ADRs (L-A1 SECURITY.md, L-A2 am-pair) — sequential research → write.
Wave O: Concurrent review + Phase 8 cross-family verification.
