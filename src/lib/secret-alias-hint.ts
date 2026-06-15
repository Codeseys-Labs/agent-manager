/**
 * Cross-pointer hints between the `am secret` (singular) and `am secrets`
 * (plural) command trees (ws4-6fd2 UX polish).
 *
 * The two trees are INTENTIONALLY separate (see the header comment in
 * `src/commands/secrets.ts`): `am secret` manages individual values
 * (set/get/list/scan/generate-key) and `am secrets` hosts the cross-cutting
 * backend operations (migrate/rewrap/rotate/revoke). Users routinely typo
 * across them (`am secret migrate`, `am secrets get`). citty would answer that
 * with a bare `Unknown command \`migrate\`` and exit 1 — no breadcrumb to the
 * sibling tree.
 *
 * This helper detects a cross-tree subcommand BEFORE citty dispatches and
 * returns a friendly "Did you mean …" hint. It does NOT merge the trees: it is
 * a pure, side-effect-free string mapper invoked by the CLI entrypoint. The
 * detection mirrors citty's own dispatch — the first non-flag token after the
 * group name is the subcommand.
 */

/** Verbs that live ONLY on the plural `am secrets` (backend) tree. */
const SECRETS_ONLY_VERBS = new Set(["migrate", "rewrap", "rotate", "revoke"]);

/** Verbs that live ONLY on the singular `am secret` (value) tree. */
const SECRET_ONLY_VERBS = new Set([
  "set",
  "get",
  "list",
  "scan",
  "install-scanner",
  "generate-key",
  "import-key",
]);

/** First non-flag token in `args`, or `undefined` if there is none. */
function firstNonFlag(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

/**
 * Given the raw CLI args (`process.argv.slice(2)`), return a cross-tree
 * "Did you mean …" hint, or `null` when no hint applies.
 *
 * - `am secret <secrets-verb>`  → `Did you mean \`am secrets <verb>\`?`
 * - `am secrets <secret-verb>`  → `Did you mean \`am secret <verb>\`?`
 *
 * Returns `null` for a real subcommand of the invoked tree, a flag-only
 * invocation, `--help`, or anything that is not a `secret`/`secrets` call —
 * so the normal citty path is unaffected.
 */
export function crossTreeSecretHint(rawArgs: string[]): string | null {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) return null;

  const group = rawArgs[0];
  if (group !== "secret" && group !== "secrets") return null;

  const sub = firstNonFlag(rawArgs.slice(1));
  if (!sub) return null;

  if (group === "secret" && SECRETS_ONLY_VERBS.has(sub)) {
    return `Did you mean \`am secrets ${sub}\`? (\`am secret\` manages individual values; \`am secrets\` runs backend operations.)`;
  }
  if (group === "secrets" && SECRET_ONLY_VERBS.has(sub)) {
    return `Did you mean \`am secret ${sub}\`? (\`am secrets\` runs backend operations; \`am secret\` manages individual values.)`;
  }
  return null;
}
