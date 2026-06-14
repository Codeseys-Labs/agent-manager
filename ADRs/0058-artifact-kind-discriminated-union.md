---
status: accepted
date: 2026-06-14
---

# ADR-0058: Explicit artifact-kind discriminant for the `command` entity

## Context

The core engine owns five catalog entities today — Server, Instruction, Skill,
AgentProfile, and Profile (AGENTS.md "Architecture" five-entity table;
`src/core/schema.ts`). Each is a `z.record(z.string(), <Schema>)` hanging off
`ConfigSchema` / `ProjectConfigSchema`, and **for all five the TOML section name
IS the kind**:

| Entity | Config key | In-file `type:` field? |
|--------|------------|------------------------|
| Server | `[servers.<name>]` | no — kind = section name |
| Instruction | `[instructions.<name>]` | no — kind = section name |
| Skill | `[skills.<name>]` | no — kind = section name |
| Agent Profile | `[agents.<name>]` | no — kind = section name |
| Profile | `[profiles.<name>]` | no — kind = section name |

There is no `type:` discriminant on any of these schemas: a `SkillSchema` value
is known to be a skill purely because it was read out of the `skills` record.
That is fine when the parser already knows which record it is reading.

We now want to model `command` as the 6th catalog entity (seed
`agent-manager-cc7d`). The complicating requirement is `am add command --from
<file.md>`: a single markdown file is handed in and `am` must decide whether it
is genuinely a command. With the section-name-is-the-kind convention there is
nothing in the file to classify against, so the tool would have to **guess**
from the body or filename. Guessing the artifact type from an ambiguous file is
exactly the kind of silent misclassification this project refuses to ship.

ADR-0057 established the local precedent for making kind explicit and
machine-checkable: `ServerSchema` became a `z.discriminatedUnion("transport",
[Stdio, Remote])` so the transport variant is a declared literal, not an
inferred shape. The open question for `command` is whether to extend that
discriminated-union idea up one level — from a *field* discriminant (transport)
to a **top-level artifact KIND** discriminant — or to keep the existing
section-name-only convention for consistency with the other five entities.

## Decision

Add `command` as the 6th entity with an **explicit `type: z.literal("command")`
discriminant**, diverging deliberately from the section-name-only convention of
the other five:

```ts
export const CommandSchema = z.object({
  type: z.literal("command"),
  path: z.string(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
  _marketplace: MarketplaceProvenanceSchema.optional(),
  adapters: adaptersPassthrough,
});
```

wired as `commands: z.record(z.string(), CommandSchema).optional()` into BOTH
`ConfigSchema` and `ProjectConfigSchema` (`src/core/schema.ts`). This extends the
ADR-0057 `transport` discriminated-union precedent to the top-level artifact
kind: the literal is the same mechanism ADR-0057 used for transport variants,
applied to "what kind of artifact is this" rather than "what transport does this
server use".

The literal exists so `am add command --from <file.md>` can classify
**deterministically** from a declared `kind: command` frontmatter line rather
than guessing. If the file's frontmatter omits `kind:` or declares a different
kind, `am add command --from` **refuses** with a clear error instead of recording
a possibly-wrong artifact. `--path <file.md>` records the location verbatim
(parity with `am add skill --path`, which does not read the file to classify it).

**v1 scope is round-trip PERSISTENCE ONLY.** This ADR covers: the schema, the
`commands` record on both config schemas, the mandatory persistence wiring in
`src/core/config.ts` (`serializeConfig`, `writeProjectConfig`, `mergeConfigs`,
`projectToConfig` — without which the `commands` record is silently dropped on
the first write), `am add command`, and `am list commands`. It explicitly DEFERS
as follow-up work: any merge semantics beyond union persistence, resolver
support (`resolveProfile` / `buildResolvedConfig` do NOT see commands),
profile-selection (`ProfileSchema` gains no `commands` field), and adapter
export/diff wiring. Those are a separate ADR once the v1 shape has settled.

## Consequences

### Positive

- `am add command --from <file.md>` classifies deterministically off a declared
  `kind: command` frontmatter and refuses ambiguous files — no guessing.
- The discriminant makes a `command` value self-describing: a future reader
  (e.g. a marketplace bundle or a mixed-artifact stream) can tell a command from
  a skill without knowing which record it came from.
- Reuses the ADR-0057 discriminated-union mechanism, so the precedent is
  consistent within the codebase even though it is applied one level up.

### Negative

- The `type` literal **diverges** from the other five entities (which have no
  in-file `type:`). The five-entity table in AGENTS.md and the schema now have
  one entity that carries a redundant-looking `type:` field. This is intentional
  and justified here, but it is an asymmetry a reader must understand.
- The literal is partly redundant when the value is read straight out of the
  `commands` record (the section name already implies the kind); its payoff is
  only at the classification boundary (`--from`).

### Neutral

- A retrofit of `type:` onto the existing five entities is NOT proposed: they
  have no `--from`-style classification boundary today, so the cost (schema
  churn, fixture churn, an extra always-present field) buys nothing yet. If a
  general mixed-artifact import path appears later, that retrofit can be
  revisited in its own ADR.
- v1 stores commands but does not act on them at apply time; `am apply` is
  unaffected until the deferred resolver/adapter follow-up lands.

## Alternatives Considered

- **Kind = section name only, no `type:` field (consistency with the five).**
  Rejected for `command`: it leaves `am add command --from <file.md>` with
  nothing in-file to classify against, forcing a guess from body/filename. The
  whole point of the `--from` path is deterministic classification, so a
  no-discriminant `command` defeats the feature it is meant to enable.
- **Explicit `type: z.literal("command")` discriminant (chosen).** Accepts a
  one-entity divergence from the section-name convention in exchange for
  deterministic, self-describing classification at the `--from` boundary,
  reusing the ADR-0057 discriminated-union precedent.
- **Ship resolver + profile-selection + adapter-export wiring in v1.** Deferred:
  it multiplies the surface area (resolver.ts, ProfileSchema, 13 adapters) before
  the persisted shape of a command has been exercised. v1 proves round-trip
  persistence first; the wiring is a follow-up ADR.

## References

- ADR-0057 (`0057-serverschema-discriminated-union.md`) — the `transport`
  discriminated-union precedent this ADR extends to the top-level artifact kind.
- Seed `agent-manager-cc7d` (ws1-cc7d-command-entity).
- AGENTS.md "Architecture" — the five-entity table this entity extends.
- `src/core/schema.ts` (CommandSchema, ConfigSchema, ProjectConfigSchema),
  `src/core/config.ts` (persistence wiring), `src/commands/add.ts`
  (`am add command`), `src/commands/list.ts` (`am list commands`).
