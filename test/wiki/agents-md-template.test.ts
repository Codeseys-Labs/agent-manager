/**
 * ADR-0044 task 4: AGENTS.md template tests.
 *
 * Tests the WIKI_AGENTS_MD_TEMPLATE and WIKI_AGENTS_MD_SCHEMA_VERSION
 * exports from src/wiki/agents-md-template.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  WIKI_AGENTS_MD_SCHEMA_VERSION,
  WIKI_AGENTS_MD_TEMPLATE,
} from "../../src/wiki/agents-md-template";

describe("WIKI_AGENTS_MD_SCHEMA_VERSION", () => {
  test("exports the literal string '1.0'", () => {
    expect(WIKI_AGENTS_MD_SCHEMA_VERSION).toBe("1.0");
  });
});

describe("WIKI_AGENTS_MD_TEMPLATE", () => {
  test("starts with YAML frontmatter containing schema_version: 1.0", () => {
    expect(WIKI_AGENTS_MD_TEMPLATE.startsWith("---\nschema_version: 1.0\n")).toBe(true);
  });

  test("frontmatter contains managed_by: am wiki", () => {
    expect(WIKI_AGENTS_MD_TEMPLATE).toMatch(/^---\n[\s\S]*?managed_by:\s*am wiki\n[\s\S]*?---/);
  });

  test('contains the title "# Wiki for this project"', () => {
    expect(WIKI_AGENTS_MD_TEMPLATE).toContain("# Wiki for this project");
  });

  test('contains section "What is this directory?"', () => {
    expect(WIKI_AGENTS_MD_TEMPLATE).toContain("What is this directory?");
  });

  test('contains section "How to read entries"', () => {
    expect(WIKI_AGENTS_MD_TEMPLATE).toContain("How to read entries");
  });

  test('contains section "How to add entries"', () => {
    expect(WIKI_AGENTS_MD_TEMPLATE).toContain("How to add entries");
  });

  test('contains section "Schema version"', () => {
    expect(WIKI_AGENTS_MD_TEMPLATE).toContain("Schema version");
  });

  test('contains section "Reference"', () => {
    expect(WIKI_AGENTS_MD_TEMPLATE).toContain("Reference");
  });

  test("references both ADR-0020 and ADR-0044", () => {
    expect(WIKI_AGENTS_MD_TEMPLATE).toContain("ADR-0020");
    expect(WIKI_AGENTS_MD_TEMPLATE).toContain("ADR-0044");
  });

  test("total length is less than 5 KB", () => {
    const byteLength = Buffer.byteLength(WIKI_AGENTS_MD_TEMPLATE, "utf-8");
    expect(byteLength).toBeLessThan(5 * 1024);
  });

  // ── WAVE G-WIKIREAD: publish / --promote accuracy (spec-vs-impl drift) ──
  // As-built (ADR-0054 R6): `am wiki publish <slug>` pushes to the per-project
  // store; `--promote` is the explicit gate to the cross-project GLOBAL wiki.
  // The old template told agents `am wiki publish <slug>` alone promotes to the
  // global wiki, which is false. These tests pin the corrected guidance.

  test("documents `am wiki publish <slug> --promote` as the path to the global wiki", () => {
    expect(WIKI_AGENTS_MD_TEMPLATE).toContain("am wiki publish <slug> --promote");
  });

  test("documents `--auto` discovery for `promote: true` entries", () => {
    expect(WIKI_AGENTS_MD_TEMPLATE).toContain("am wiki publish --auto");
  });

  test("does NOT claim a bare `am wiki publish <slug>` promotes to the global wiki", () => {
    // The corrected copy must not pair a plain publish with promotion to the
    // global wiki — that was the spec-vs-impl drift. A plain publish targets the
    // per-project store; promotion requires --promote.
    expect(WIKI_AGENTS_MD_TEMPLATE).toContain("per-project store");
    // The old, inaccurate sentence claimed a plain publish works "without the
    // frontmatter flag" — its removal proves the drift is gone.
    expect(WIKI_AGENTS_MD_TEMPLATE).not.toContain("without the frontmatter flag");
  });
});
