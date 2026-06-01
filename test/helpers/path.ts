/**
 * path.ts — portable path assertions for cross-platform tests.
 *
 * Source code builds paths with `node:path` `join`, which emits the native
 * separator (`\` on Windows, `/` on POSIX). Tests that assert a forward-slash
 * substring (`f.path.includes(".cursor/mcp.json")`) therefore fail on Windows
 * even though the source is correct. Normalize the actual path with `toPosix`
 * before substring-matching so the assertion is separator-agnostic.
 *
 * `toPosix` is a no-op on POSIX (where `sep === "/"`).
 */

import { sep } from "node:path";

/** Normalize a native path to POSIX (`/`) separators for portable asserts. */
export const toPosix = (p: string): string => p.split(sep).join("/");
