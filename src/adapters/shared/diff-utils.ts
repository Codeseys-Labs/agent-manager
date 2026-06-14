/**
 * Shared diff utilities for instruction/skill/agent drift detection.
 *
 * All 13 adapters originally only detected server drift. These helpers
 * extend diff coverage to instructions, skills, and agents so each
 * adapter can add entity-level drift detection incrementally.
 */

import type { DiffChange, ResolvedInstruction } from "../types.ts";
import { AM_BEGIN, AM_END } from "./utils.ts";

// ── Instruction diff ────────────────────────────────────────────

/**
 * Compare expected instructions against native instruction file content.
 *
 * For marker-based adapters (CLAUDE.md, AGENTS.md, GEMINI.md), the native
 * content is the full file; we extract the managed block and compare against
 * the expected concatenated instruction content.
 *
 * @param expected  Instructions filtered for this adapter (by target)
 * @param nativeContent  Full content of the native instruction file, or null if missing
 * @param adapterName  Adapter name for filtering targets
 * @returns Array of DiffChange entries for instruction drift
 */
export function compareInstructions(
  expected: Record<string, ResolvedInstruction>,
  nativeContent: string | null,
  _adapterName: string,
): DiffChange[] {
  const changes: DiffChange[] = [];

  // Build expected managed block content
  const expectedParts: string[] = [];
  for (const [, instr] of Object.entries(expected)) {
    expectedParts.push(instr.content);
  }
  const expectedBlock = expectedParts.join("\n\n");

  // No instructions expected
  if (expectedParts.length === 0) {
    if (nativeContent !== null) {
      // Check if native file has a managed block (would be stale)
      const nativeBlock = extractManagedBlock(nativeContent);
      if (nativeBlock !== null && nativeBlock.trim().length > 0) {
        changes.push({
          entity: "instruction",
          name: "_managed_block",
          type: "added-locally",
        });
      }
    }
    return changes;
  }

  // Instructions expected but no native file. Catalog-ahead: a FORWARD delta
  // `am apply` resolves by writing the managed block, not a local removal.
  // (ws4-drift-relabel-catalog-ahead)
  if (nativeContent === null) {
    for (const name of Object.keys(expected)) {
      changes.push({
        entity: "instruction",
        name,
        type: "added-in-config",
      });
    }
    return changes;
  }

  // Both exist — compare managed block content
  const nativeBlock = extractManagedBlock(nativeContent);
  if (nativeBlock === null) {
    // Native file exists but has no managed block yet — the catalog's
    // instructions have not been written. Catalog-ahead FORWARD delta `am apply`
    // resolves by inserting the block, not a local removal.
    // (ws4-drift-relabel-catalog-ahead)
    for (const name of Object.keys(expected)) {
      changes.push({
        entity: "instruction",
        name,
        type: "added-in-config",
      });
    }
    return changes;
  }

  // Compare normalized content (trim whitespace differences)
  if (nativeBlock.trim() !== expectedBlock.trim()) {
    changes.push({
      entity: "instruction",
      name: "_managed_block",
      type: "modified",
      details: [
        {
          field: "content",
          expected: expectedBlock.slice(0, 200) + (expectedBlock.length > 200 ? "..." : ""),
          actual: nativeBlock.slice(0, 200) + (nativeBlock.length > 200 ? "..." : ""),
        },
      ],
    });
  }

  return changes;
}

// ── Helpers ─────────────────────────────────────────────────────

/** Extract the content between am:begin and am:end markers, or null if not found. */
function extractManagedBlock(content: string): string | null {
  const beginIdx = content.indexOf(AM_BEGIN);
  const endIdx = content.indexOf(AM_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return null;
  return content.slice(beginIdx + AM_BEGIN.length, endIdx);
}
