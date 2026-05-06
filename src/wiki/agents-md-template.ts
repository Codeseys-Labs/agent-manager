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
\`promote: true\` in frontmatter are intended for promotion to the global
wiki via \`am wiki publish <slug>\`. Local edits are kept local until
explicitly promoted.

## How to read entries

Each \`.md\` file is self-contained. Read it as you would any markdown
document. The frontmatter at the top of each file holds metadata (slug,
title, tags, type, confidence, sources); the body is the content.
Cross-references between entries use \`[[slug]]\` syntax. Entries may link
to source code (file paths) or external URLs. A search index is maintained
in the global store and queried via \`am wiki search\`.

## How to add entries

The easiest way is to ask am: \`am wiki add <type> <slug>\` scaffolds an
entry with the correct frontmatter. To add one manually, drop a \`.md\`
file with proper frontmatter under the correct subdirectory. To promote a
local entry to the global wiki, set \`promote: true\` in the entry's
frontmatter and run \`am wiki publish <slug>\`. You can also run
\`am wiki publish <slug>\` directly without the frontmatter flag.

## Schema version

This file is version-pinned at \`schema_version: 1.0\`. Future versions of
am may upgrade the schema; run \`am wiki upgrade-schema\` to migrate.
Custom edits to AGENTS.md are preserved; only the schema_version pin gets
updated by the upgrade command.

## Reference

- ADR-0020: LLM Wiki concept and three-layer knowledge model
- ADR-0044: Wiki two-tier copy materialisation (amend to ADR-0022)
`;
