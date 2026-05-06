/**
 * ADR-0038 — Dry-Run / Explain Surface Pattern
 *
 * Shared envelope type for every `am` command that emits structured
 * dry-run output. Centralizes the canonical shape so new commands cannot
 * silently drift away from the convention.
 *
 * The envelope mirrors §"Shared output shape" of ADR-0038 verbatim:
 *
 *   {
 *     "action": "run-agent" | "apply" | "import" | ...,
 *     "would_do": [<structured steps>],
 *     "reads_only": true,
 *     "mutations_prevented": [<what would have been written/spawned>],
 *     "warnings": [<advisory messages — exit code stays 0>],
 *     "explanation": { <action-specific fields> }
 *   }
 *
 * The `explanation` payload is action-specific and intentionally generic
 * so each command can carry its own resolved-state summary without
 * forcing a giant union type at the envelope level.
 *
 * Conformance is enforced by `test/commands/dry-run-envelope.test.ts`,
 * which parses the JSON emitted by every dry-run-capable command and
 * asserts the canonical fields are present and well-typed.
 */
export interface DryRunEnvelope<TExplanation = unknown> {
  /**
   * Stable action verb identifying which command produced the envelope.
   * Lowercase, kebab- or snake-cased. Examples: `"run-agent"`, `"apply"`,
   * `"import"`, `"wiki-sync"`. New emitters MUST register a unique value
   * here so consumers can dispatch on it.
   */
  action: string;

  /** Always `true` — this envelope describes a side-effect-free preview. */
  reads_only: true;

  /**
   * Ordered list of human-readable steps the live path would take. Should
   * be terse (one line per step) and ordered the same as the live execution.
   */
  would_do: string[];

  /**
   * What the dry-run mode is preventing — the side-effects that would
   * happen in a live run. Helps operators see *exactly* what was avoided.
   */
  mutations_prevented: string[];

  /**
   * Advisory messages. Dry-run still exits 0 even when warnings are
   * present (the goal is to EXPLAIN, not assert runnability). Examples:
   * binary not on PATH, declared permission policy not yet enforced,
   * adapter would refuse on drift unless --force is set.
   */
  warnings: string[];

  /**
   * Action-specific resolved-state summary. Per ADR-0038 §Shape this is
   * where each command embeds its own typed fields (agent + variant for
   * `am run`; profile + per-adapter results for `am apply`; …).
   */
  explanation: TExplanation;
}

/**
 * Type guard for runtime checks. Accepts an arbitrary value and narrows it
 * to a `DryRunEnvelope<unknown>` when the canonical fields are present and
 * well-typed. Used by the conformance test and by HTTP/MCP surfaces that
 * want to validate envelopes received from the CLI surface.
 */
export function isDryRunEnvelope(value: unknown): value is DryRunEnvelope<unknown> {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.action === "string" &&
    v.action.length > 0 &&
    v.reads_only === true &&
    Array.isArray(v.would_do) &&
    v.would_do.every((s) => typeof s === "string") &&
    Array.isArray(v.mutations_prevented) &&
    v.mutations_prevented.every((s) => typeof s === "string") &&
    Array.isArray(v.warnings) &&
    v.warnings.every((s) => typeof s === "string") &&
    typeof v.explanation === "object" &&
    v.explanation !== null
  );
}

/**
 * Helper: assert envelope conformance and throw a descriptive error
 * pointing at the offending field. Used inside the conformance test so
 * failures are debuggable at a glance.
 */
export function assertDryRunEnvelope(value: unknown): asserts value is DryRunEnvelope<unknown> {
  if (value === null || typeof value !== "object") {
    throw new Error("DryRunEnvelope: not an object");
  }
  const v = value as Record<string, unknown>;
  if (typeof v.action !== "string" || v.action.length === 0) {
    throw new Error(`DryRunEnvelope.action: expected non-empty string, got ${typeof v.action}`);
  }
  if (v.reads_only !== true) {
    throw new Error(`DryRunEnvelope.reads_only: expected true, got ${String(v.reads_only)}`);
  }
  if (!Array.isArray(v.would_do) || !v.would_do.every((s) => typeof s === "string")) {
    throw new Error("DryRunEnvelope.would_do: expected string[]");
  }
  if (
    !Array.isArray(v.mutations_prevented) ||
    !v.mutations_prevented.every((s) => typeof s === "string")
  ) {
    throw new Error("DryRunEnvelope.mutations_prevented: expected string[]");
  }
  if (!Array.isArray(v.warnings) || !v.warnings.every((s) => typeof s === "string")) {
    throw new Error("DryRunEnvelope.warnings: expected string[]");
  }
  if (typeof v.explanation !== "object" || v.explanation === null) {
    throw new Error("DryRunEnvelope.explanation: expected non-null object");
  }
}
