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
});
