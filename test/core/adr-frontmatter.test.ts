/**
 * ADR-0033 ↔ ADR-0034 amendment-state regression lock.
 *
 * ADR-0033 (accepted) now carries `pending_amendment_by: ADR-0034` because
 * ADR-0034 is still `status: proposed`. An accepted ADR cannot defer
 * authoritatively to a non-accepted one — the pending_amendment pattern
 * forward-references the proposed change without treating it as settled.
 *
 * WHEN ADR-0034 IS PROMOTED TO ACCEPTED, flip this test: remove the
 * pending assertion and assert `amended_by: ADR-0034` instead. A failure
 * of this test IS the signal that ADR-0033's amendment state has
 * transitioned and the README index should be updated in the same PR.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function parseFrontmatter(path: string): Record<string, string> {
  const raw = readFileSync(path, "utf-8");
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`No frontmatter found in ${path}`);
  const map: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) map[kv[1]] = kv[2].trim();
  }
  return map;
}

describe("ADR-0033 amendment state (post-2026-05-02 CODEX-3 fix)", () => {
  const adr = join(import.meta.dir, "../../ADRs/0033-acp-agent-tiers-and-shim-wrapper.md");
  const fm = parseFrontmatter(adr);

  test("has pending_amendment_by: ADR-0034", () => {
    expect(fm.pending_amendment_by).toBe("ADR-0034");
  });

  test("amended_by does NOT reference ADR-0034 while it is proposed", () => {
    // Either absent entirely, or present but referencing something else.
    if (fm.amended_by !== undefined) {
      expect(fm.amended_by).not.toContain("ADR-0034");
    }
  });

  test("when ADR-0034 accepts, flip this test suite: see doc comment", () => {
    // No assertion here — this is a reminder-test.
    // Future maintainer: check ADRs/0034-shim-scope-and-inclusion-criteria.md
    // frontmatter. If its `status: accepted`, this whole suite must be
    // updated to assert amended_by instead of pending_amendment_by.
    expect(true).toBe(true);
  });
});
