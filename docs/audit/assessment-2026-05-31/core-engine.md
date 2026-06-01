# Core Engine Audit — agent-manager (`am`)

**Dimension:** core-engine (schema, hierarchical config merge, profile resolver, controller/concurrency, two-phase Zod validation)
**Date:** 2026-05-31
**Auditor scope:** `src/core/{schema,config,resolver,controller,locks,state}.ts` + ADRs 0001, 0007, 0040, 0041
**Overarching question:** is this core a clean, stable kernel a first-run wizard and a stranger-installs-it CLI can layer on?

---

## Verdict in one line

The core is a genuinely well-engineered kernel: small (~1,210 LOC across the five load-bearing files), heavily tested (519 `test()` calls under `test/core/`), and architecturally honest after ADR-0040/0041 closed the two biggest spec-hygiene gaps. It is **refactor-in-place**, not rearchitect. The defects that exist are localized: a leaky core↔adapters type dependency, raw-ZodError UX that will embarrass the project on the first malformed config, a union-only merge with no cross-layer subtraction, and a silent "default-profile-passes-everything" fallback that a wizard must understand.

---

## What I verified (not assumed)

### ADR-0041 (delete the adapter schema field) is actually done

The ADR claimed Phase 2 of ADR-0007 was dead and ordered its deletion. Verified against the working tree:

- No `src/adapters/*/schema.ts` files exist (`find src/adapters -name schema.ts` → empty).
- No `.schema.parse` / `.schema.safeParse` anywhere in `src/` (zero hits).
- No `AdapterSchema` interface — only a tombstone comment at `src/adapters/types.ts:165-171`.
- The `Adapter` interface (`src/adapters/types.ts:208-216`) is now exactly four behavioral methods (`detect`, `import`, `export`, `diff`) plus two optional hooks (`sessionReader`, `scanMarketplace`). The interface is honest: it matches what an adapter does.

This is a rare and commendable thing — an ADR that walked back a 13-month-"accepted" decision *and the codebase matches the ADR*. No drift. This is the single strongest signal that the core is maintained with discipline.

### ADR-0040 (withConfig + AsyncMutex) invariant holds

The ADR's load-bearing invariant is: "No caller of config mutations may bypass `withConfig`; raw `writeConfig(...)` is forbidden in `commands/`, `tui/`, `web/`, `mcp/`."

Verified: `grep writeConfig( src/` outside `config.ts`/`controller.ts` returns exactly one hit — `src/tui/index.tsx:52`, which is a *comment* explaining the rule, not a call. Every real mutation path (`add`, `install`, `uninstall`, `import`, `apply`, `init`, `profile`, `secret`, `update`, `agent-enable-shim`, plus `marketplace/installer.ts`, `mcp/server.ts`, `web/server.ts`) routes through `withConfig`/`applyResolved` (confirmed by `grep -l withConfig src/`).

The concurrency story is also *tested at the right layer*. `test/mcp/concurrency.test.ts` drives real MCP handlers with `Promise.all` and asserts both writers land (not last-writer-wins), with an explicit note that the same test fails against `HEAD^^` pre-controller (`test/mcp/concurrency.test.ts:9-16, 62-78`). That is exactly how you prove a concurrency fix.

The `AsyncMutex` itself (`src/core/locks.ts:24-72`) is correct: FIFO fairness, lock handed directly to next waiter without dropping `held` (line 62-71), exceptions don't poison the mutex (the `finally` release at line 36-39). Clean implementation.

---

## Strengths

1. **The merge/resolve pipeline is comprehensible and layered cleanly.** Four-layer hierarchy (`loadResolvedConfig`, `src/core/config.ts:168-198`) → profile inheritance flatten (`resolveProfile`, `src/core/resolver.ts:28-101`) → resolved-view materialization (`buildResolvedConfig`, `src/core/config.ts:206-339`). Each stage is a pure function of its inputs with a single documented merge rule. `resolveProfile` correctly does parent-first / child-last ordering by building the chain then reversing it (`resolver.ts:31-50`), with circular-inheritance detection (`resolver.ts:37-39`) and unknown-profile errors (`resolver.ts:41-43`). The dedup-on-union and tag-activation logic is straightforward and tag activation correctly skips `enabled: false` servers (`resolver.ts:115`).

2. **Test coverage is real, not theatrical.** `test/core/resolver.test.ts` (255 lines) covers inheritance union, tag activation, disabled-server exclusion, dedup, circular detection, unknown profile, and child-env-override. `test/core/config.test.ts` (610 lines) covers the full 4-layer hierarchy precedence (`config.test.ts:294-388`), `content_file` resolution, and the profile-filter behaviors. The two surprising fallback behaviors (below) are *both* explicitly tested (`config.test.ts:533-562`), meaning they're intentional, not accidental.

3. **Concurrency is documented, scoped, and honest about its limits.** ADR-0040 explicitly enumerates what the controller does NOT cover (reads, non-config logic, cross-process) rather than overclaiming. The "single global mutex over keyed-per-configDir" choice is justified (`controller.ts:39-48`) and the cross-process gap is named as an accepted limitation with a documented future fix (file lock). This is the kind of disciplined scoping a production tool needs.

4. **Schema is strict where it should be and tolerant where it must be.** Core entity fields are validated strictly; `[entity.adapters.<name>]` is `z.record(z.string(), z.unknown())` opaque passthrough (`schema.ts:4`), preserving forward-compat across machines with different adapters installed. Mutually-exclusive fields (`content`/`content_file`, `prompt`/`prompt_file`) are enforced with `superRefine`/`refine` (`schema.ts:59-72, 130-132`). The `team_passphrase` rejection (`schema.ts:235-243`) is a nice example of using the schema as a policy gate (ADR-0046).

5. **Atomic writes + auto-commit are funneled through one seam.** `withConfig` writes via `atomicWriteFile` and auto-commits with `isNothingToCommitError` swallowing only the benign git case, rethrowing real git errors (`controller.ts:131-138`). Deletion works correctly despite the union-merge (delete mutates the single `config.toml` object in place, then writes the whole object — see `uninstall.ts:67` and `profile.ts:238`).

---

## Weaknesses

### W1 (HIGH) — Core depends on the adapters package for its own resolved types

`src/core/config.ts:6-12` imports `ResolvedConfig`, `ResolvedAgent`, `ResolvedInstruction`, `ResolvedServer`, `ResolvedSkill` from `../adapters/types`. But these types are *produced by core* (`buildResolvedConfig` is the only producer) and merely *consumed by adapters*. The ownership is inverted: the kernel imports its own output contract from a downstream layer. Compounding it, `src/adapters/types.ts:1` imports `SessionReader` from `../core/session.ts` — so there is a literal bidirectional `core ↔ adapters` type cycle. Five other core modules also reach into adapters (`controller.ts`, `agent-detection.ts`, `merge.ts`, `instructions.ts`).

This is the leak the dimension question asks about. ADR-0001's diagram shows a clean one-way `Core → Adapters` arrow; the code is not that. It compiles (they're `type`-only imports, so no runtime cycle), but it means "the core" is not independently extractable, and a reader cannot tell where the kernel boundary is.

**Recommendation:** Move `ResolvedConfig` and the `Resolved*` family into `src/core/` (e.g. `src/core/resolved.ts`) and have `adapters/types.ts` import *from core*, making the dependency strictly `adapters → core`. This is a mechanical move (~6 import-path edits) that turns the architecture diagram into the truth.

### W2 (HIGH) — Malformed config surfaces a raw ZodError JSON blob to the user

`readConfig`/`readProjectConfig` call `ConfigSchema.parse(parsed)` (`config.ts:47, 54`) which throws a `ZodError`. `formatError` (`src/lib/errors.ts:76-94`) has **no `ZodError` branch** — it falls into the generic `err instanceof Error` path and prints `err.message`. For a Zod error, `.message` is the stringified JSON issue array. Reproduced live with a config missing a server `command`:

```
error: [
  {
    "code": "invalid_type",
    "expected": "string",
    "received": "undefined",
    "path": [ "servers", "foo", "command" ],
    "message": "Required"
  }
]
```

A stranger who hand-edits `config.toml` (or whose synced config has one bad field) gets a JSON dump prefixed with `error:`. This directly fails the "get value without reading the source" bar and is exactly the kind of thing that embarrasses a project in front of a first user. It also undermines the wizard: if the wizard writes a config the user later edits badly, the recovery message is unreadable.

**Recommendation:** Add a `ZodError` branch to `formatError` (or wrap `.parse` in `readConfig`/`readProjectConfig` to throw an `AmError` with a human path like `servers.foo.command: Required` and a suggestion). ~20 LOC. High leverage for first-run polish.

### W3 (MEDIUM) — Union-only merge means project/local layers can add or override but never *subtract*

`mergeConfigs` (`config.ts:124-135`) and `resolveProfile` (`resolver.ts:60-92`) are union/override-only. There is no way for a project layer or a profile to *remove* a server/skill/agent that a higher-priority (lower) layer defined. The only subtraction mechanism is the *profile allowlist* in `buildResolvedConfig` (`config.ts:288-336`) — and that only fires when the named profile exists AND lists ≥1 of that entity type. There is no `enabled: false`-style suppression at the project layer, no "exclude" list. CLAUDE.md documents the union rule but not the "you cannot un-inherit" consequence.

For the wizard/first-user this is a real ceiling: a user with a large global catalog cannot scope a project down by *removing* — they must either define a profile that re-lists everything they want to keep, or set `enabled = false` on the global server (which affects every project). It is a defensible v1 design, but it is an undocumented sharp edge.

**Recommendation:** Either document the constraint prominently ("layers are additive; to scope down, use a profile allowlist") or add a minimal subtraction primitive (e.g. a profile `exclude_servers` / per-layer `disabled` list). At minimum the wizard should steer users toward profiles when they want narrowing.

### W4 (MEDIUM) — The "default" profile fallback silently passes the entire catalog through

`applyResolved` falls back to the profile name `"default"` (`controller.ts:221-225`). `buildResolvedConfig` only applies filtering "when the named profile exists" (`config.ts:289-290`); if there is no `[profiles.default]`, **every** server/skill/agent/instruction in the catalog is exported to every detected tool (verified test: `config.test.ts:533-547` "returns all servers when profile does not exist"). So a fresh user who runs `am init` then `am apply` without ever defining a profile gets their *entire* catalog blasted into Claude Code / Cursor / etc.

This is correct as designed (fail-open is friendlier than fail-empty for a single-profile user), but it is surprising and unsignposted. A wizard that helps a user "configure everything needed to get value" must make this explicit, because the difference between "no default profile" (everything) and "empty default profile" (also everything — `config.test.ts:549`) and "default profile lists 2 servers" (only those 2) is invisible from the command surface.

**Recommendation:** Have the wizard either create an explicit `default` profile or warn on first `am apply` when no profile filters the catalog ("applying all N servers to M tools — define a profile to scope this"). Consider an info-level line in `apply` output when the resolved profile didn't filter.

### W5 (LOW) — `__resetControllerLocksForTests` is a no-op kept as documentation

`controller.ts:51-56` exports a function whose body is empty and whose comment explains it can't actually reset the mutex. It's harmless but it's dead surface area that reads like a real reset hook. Either implement it (swap `configMutex` for a fresh instance behind a getter) or delete it and the export.

### W6 (LOW) — Settings schema is `.passthrough()` while entity schemas are strict

`SettingsSchema` is `.passthrough()` (`schema.ts:154, 247`) and the nested `secrets` block is also `.passthrough()` (`schema.ts:234`). This means typos in `[settings]` keys are silently preserved rather than flagged — inconsistent with the strict treatment of entity fields, and contrary to ADR-0007's stated "unknown field in core section → warn (likely typo)". A user who writes `default_profle = "work"` gets no signal. Minor, but it's a small honesty gap between the ADR and the schema.

---

## Coupling assessment (the core question)

Is the core a clean kernel? **Mostly yes, with one structural leak (W1).** The merge/resolve/validate logic is self-contained, pure, and free of adapter-specific knowledge — `resolver.ts` and `schema.ts` have zero adapter imports, and `config.ts`'s only adapter dependency is the type-import inversion in W1. `controller.ts` legitimately depends on the adapter *registry* because apply is by definition the seam where core meets adapters (ADR-0040 calls it "the seam at the layered-core boundary" — accurate). The `adapters.*` opaque-passthrough discipline is consistently applied (`schema.ts:4`, cast-through at `config.ts:223,244,256,274,284`). The post-ADR-0041 deletion removed the one genuinely leaky abstraction (adapter-owned Zod schemas the core never used). So the leak is type-organizational (W1), not behavioral.

---

## Production-readiness scoring rationale

The *logic* is production-grade: tested, concurrency-safe within a process, schema-validated, atomic, git-backed. What keeps it from a higher score against the "stranger installs it" bar is the error-surface (W2 — raw ZodError is a genuine first-contact failure) and the two unsignposted semantic sharp edges (W3 union-only, W4 default-passthrough) that a self-service user will hit and not understand. None of these are rearchitecture; all are bounded fixes.

---

## What a first-run setup wizard must do given this subsystem

1. **Write a valid `config.toml` that round-trips through `ConfigSchema`** — the wizard is the one writer that can guarantee the schema is satisfied, so it must own field defaults (transport, enabled) so the user never sees W2's raw ZodError on first read.
2. **Create an explicit `default` profile (even if empty-with-intent) and explain the passthrough semantics (W4)** — otherwise the user's first `am apply` exports the whole catalog to every detected tool. The wizard should ask "scope to these tools/servers?" and materialize a profile rather than relying on the fail-open default.
3. **Steer narrowing toward profiles, not deletion (W3)** — because layers are additive-only, the wizard should teach "make a profile to scope down" the moment the user wants fewer servers in a project.
4. **Seed `state.toml` active profile via `writeActiveProfile`** (`state.ts:24-39`) so `am apply` resolves a deterministic profile rather than the `"default"` fallback.

**Missing today:** there is no first-run wizard in the core sense — `am init` (`src/commands/init.ts`, 182 LOC) sets up the git repo, optional encryption key, and optional remote, but does **not** populate any catalog entries, create a starter profile, or run detection-to-import. A new user lands on an empty config and must learn `am add` / `am import` / `am use` from docs. The core engine fully supports a wizard (all the primitives exist: `withConfig`, `buildResolvedConfig`, profile allowlists, `writeActiveProfile`), but the wizard layer that turns those primitives into a guided "configure everything to get value" flow does not exist yet. The W2/W4 fixes are prerequisites for that wizard to feel trustworthy.
