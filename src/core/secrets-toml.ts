/**
 * `.am-secrets.toml` round-trip helpers (ADR-0047 §"Flow" Step 2,
 * Wave T DWL-T4 deferred item #1).
 *
 * The repo-root `.am-secrets.toml` carries the per-repo secrets
 * backend declaration plus an `[age].recipients` array of paths like
 * `"recipients/laptop-2.pub"`. That array is the **covered set** —
 * the recipients every committed envelope is wrapped to. The on-disk
 * `recipients/*.pub` directory is the **seen set**. Their delta is
 * what `am pair finalize` (autodetect mode) acts on.
 *
 * Atomic writes via `core/atomic-write.ts`; parse failures surface as
 * `AmError` with code `PAIR_TOML_PARSE_FAILED` so callers can refuse
 * to mutate a corrupt file.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import { AmError } from "../lib/errors";
import { tomlStringify } from "../lib/toml";
import { atomicWriteFile } from "./atomic-write";

const SECRETS_TOML_FILENAME = ".am-secrets.toml";

/** Absolute path to `<configDir>/.am-secrets.toml`. */
export function resolveSecretsTomlPath(configDir: string): string {
  return join(configDir, SECRETS_TOML_FILENAME);
}

/**
 * Read and parse `.am-secrets.toml`. Returns an empty object when the
 * file does not exist (callers create it on first write). Throws an
 * `AmError(code=PAIR_TOML_PARSE_FAILED)` on syntax errors so the caller
 * can refuse to overwrite a partially-valid file.
 */
export async function readSecretsToml(configDir: string): Promise<Record<string, unknown>> {
  const p = resolveSecretsTomlPath(configDir);
  let raw: string;
  try {
    raw = await readFile(p, "utf-8");
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") return {};
    throw err;
  }
  try {
    return TOML.parse(raw) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AmError(
      `Failed to parse ${p}: ${msg}`,
      "Fix the TOML syntax or remove the file to recreate it.",
      "PAIR_TOML_PARSE_FAILED",
    );
  }
}

/** Read `[age].recipients` as a string array (ignores non-string entries). */
export function getAgeRecipients(doc: Record<string, unknown>): string[] {
  const age = doc.age as Record<string, unknown> | undefined;
  if (!age || typeof age !== "object") return [];
  const recipients = age.recipients;
  if (!Array.isArray(recipients)) return [];
  return recipients.filter((s): s is string => typeof s === "string");
}

/**
 * Append `recipientPath` to `[age].recipients` if not already present.
 * Mutates `doc` in place. Returns `true` when the array changed.
 *
 * Creates `[age]` and `[age].recipients` when absent. Order is
 * preserved (append-only); duplicates are silently collapsed.
 */
export function upsertAgeRecipient(doc: Record<string, unknown>, recipientPath: string): boolean {
  let age = doc.age as Record<string, unknown> | undefined;
  if (!age || typeof age !== "object") {
    age = {};
    doc.age = age;
  }
  let recipients = age.recipients;
  if (!Array.isArray(recipients)) {
    recipients = [];
    age.recipients = recipients;
  }
  const arr = recipients as unknown[];
  if (arr.some((v) => typeof v === "string" && v === recipientPath)) return false;
  arr.push(recipientPath);
  return true;
}

/** Atomically write `doc` back to `<configDir>/.am-secrets.toml`. */
export async function writeSecretsToml(
  configDir: string,
  doc: Record<string, unknown>,
): Promise<string> {
  const p = resolveSecretsTomlPath(configDir);
  await atomicWriteFile(p, tomlStringify(doc));
  return p;
}

/**
 * Idempotently append a `recipients/<name>.pub` path to
 * `[age].recipients`. Reads, upserts, atomic-writes only when the
 * array actually changed.
 *
 * Returns the absolute TOML path, whether the file was mutated, and
 * the resulting recipient list (post-mutation).
 */
export async function appendAgeRecipientPath(
  configDir: string,
  recipientPath: string,
): Promise<{ path: string; changed: boolean; recipients: string[] }> {
  const path = resolveSecretsTomlPath(configDir);
  const doc = await readSecretsToml(configDir);
  const changed = upsertAgeRecipient(doc, recipientPath);
  if (changed) {
    await atomicWriteFile(path, tomlStringify(doc));
  }
  return { path, changed, recipients: getAgeRecipients(doc) };
}

/**
 * Bulk variant: append several recipient paths in stable order. Used
 * by `am pair finalize` (autodetect) so a single TOML write covers
 * every newly-paired device. Returns the same shape as the single
 * append.
 */
export async function appendAgeRecipientPaths(
  configDir: string,
  recipientPaths: readonly string[],
): Promise<{ path: string; changed: boolean; recipients: string[] }> {
  const path = resolveSecretsTomlPath(configDir);
  const doc = await readSecretsToml(configDir);
  let changed = false;
  for (const rp of recipientPaths) {
    if (upsertAgeRecipient(doc, rp)) changed = true;
  }
  if (changed) {
    await atomicWriteFile(path, tomlStringify(doc));
  }
  return { path, changed, recipients: getAgeRecipients(doc) };
}
