/**
 * ADR-0044 task 4: AGENTS.md template for `.am-wiki/` directories.
 *
 * When `am wiki init` creates a new `.am-wiki/` directory, it writes this
 * AGENTS.md file so that ANY AI coding agent (am-aware or not) that walks
 * into the project's `.am-wiki/` directory is told what's there, how to
 * read it, and how to add to it.
 *
 * The template is version-pinned at schema_version: 1.0. Future versions
 * of am may upgrade the schema; run `am wiki upgrade-schema` to migrate.
 * Custom edits to AGENTS.md are preserved; only the schema_version pin
 * gets updated by the upgrade command.
 */

export const WIKI_AGENTS_MD_SCHEMA_VERSION = "1.0";

export const WIKI_AGENTS_MD_TEMPLATE: string = `---
schema_version: 1.0
managed_by: am wiki
---

# Wiki for this project

## What is this directory?

This is the project-local wiki, materialised from the global agent-manager
wiki store via \`am wiki init\` or \`am wiki pull\`. Each subdirectory groups
entries by type (entities, concepts, decisions, summaries, synthesis). Entries are
markdown files with YAML frontmatter (slug, title, tags, etc.). Entries with
\`promote: true\` in frontmatter are discovered by \`am wiki publish --auto\`
and pushed up a tier. Local edits are kept local until you explicitly publish.

## How to read entries

Each \`.md\` file is self-contained. Read it as you would any markdown
document. The frontmatter at the top of each file holds metadata (slug,
title, tags, type, confidence, sources); the body is the content.
Cross-references between entries use \`[[slug]]\` syntax. Entries may link
to source code (file paths) or external URLs. A search index is maintained
in the global store and queried via \`am wiki search\`.

## How to add entries

The easiest way is to ask am: \`am wiki add\` creates an entry with the
correct frontmatter. To add one manually, drop a \`.md\` file with proper
frontmatter under the correct subdirectory.

To publish a local entry, run \`am wiki publish <slug>\`. By default this
pushes the entry up to your per-project store. Add \`--promote\` to push it
all the way to the cross-project global wiki:
\`am wiki publish <slug> --promote\`. To publish every entry tagged
\`promote: true\` in frontmatter, run \`am wiki publish --auto\` (add
\`--promote\` to send them to the global wiki). A target that already holds a
differing entry reports a conflict; re-run with \`--force\` to overwrite.

## Schema version

This file is version-pinned at \`schema_version: 1.0\`. Future versions of
am may upgrade the schema; run \`am wiki upgrade-schema\` to migrate.
Custom edits to AGENTS.md are preserved; only the schema_version pin gets
updated by the upgrade command.

## Reference

- ADR-0020: LLM Wiki concept and three-layer knowledge model
- ADR-0044: Wiki two-tier copy materialisation (amend to ADR-0022)
`;
