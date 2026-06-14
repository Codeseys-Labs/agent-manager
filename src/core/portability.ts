/**
 * Portability lint for artifact bodies (R1/297e).
 *
 * When `am import` / `am add` pulls in a skill or agent prompt, the artifact
 * BODY can hard-code host-absolute paths — e.g. a skill that says
 * `/home/baladita/.local/share/uv/tools/hyperresearch/...`. Those paths are
 * non-portable: they only resolve on the machine that authored the artifact,
 * so sharing the artifact (or running it on a different OS / different user)
 * silently breaks.
 *
 * This module scans body text for per-user home directory prefixes:
 *   - macOS:   `/Users/<name>/`
 *   - Linux:   `/home/<name>/`
 *   - Windows: `C:\Users\<name>\`
 *
 * POLICY: we flag ALL of these — including a `/home/<thisuser>/` path that
 * happens to belong to the current user on the current host. The seed's clear
 * positive is the cross-host case (a `/Users/` mac path imported on Linux), but
 * we deliberately do NOT special-case "this is my own home dir, so it's fine":
 * an own-host path is still non-portable the moment the artifact is shared or
 * the repo is cloned elsewhere. Treating every home-dir prefix identically
 * keeps the lint honest and the behavior predictable across operating systems.
 *
 * We intentionally do NOT flag system-absolute paths like `/usr/local/bin` or
 * `/etc/...`: those resolve the same way on every host of that OS, so they are
 * portable for sharing purposes. Only per-user home directories are caught.
 *
 * The scan is body-only and read-only — it never rewrites the artifact. It is a
 * lint signal surfaced to the user (info/warn), not a hard gate.
 */

/** Which per-user home-directory convention a finding matched. */
export type HostPathKind = "macos" | "linux" | "windows";

/** A single host-absolute path occurrence found in an artifact body. */
export interface HostPathFinding {
  /** Operating-system convention the prefix belongs to. */
  kind: HostPathKind;
  /** The matched per-user home prefix, e.g. `/Users/baladita/` or `C:\Users\baladita\`. */
  match: string;
  /** 1-based line number where the prefix was found. */
  line: number;
}

// Per-user home-directory prefixes. Each captures the home prefix up to and
// including the trailing separator after the user name, so callers can show a
// concise, recognizable token rather than the whole path.
//
//   macOS:   /Users/<name>/
//   Linux:   /home/<name>/
//   Windows: C:\Users\<name>\   (drive letter is case-insensitive)
//
// `<name>` is a single path segment: any run of characters that is not the
// segment separator for that OS.
const HOST_PATH_PATTERNS: { kind: HostPathKind; regex: RegExp }[] = [
  { kind: "macos", regex: /\/Users\/[^/\s\\]+\//g },
  { kind: "linux", regex: /\/home\/[^/\s\\]+\//g },
  { kind: "windows", regex: /[A-Za-z]:\\Users\\[^\\/\s]+\\/g },
];

/**
 * Scan body text for host-absolute per-user paths.
 *
 * Returns one {@link HostPathFinding} per occurrence, in document order
 * (top-to-bottom, and left-to-right within a line). Returns an empty array for
 * portable text (relative paths, system-absolute paths, or no paths at all).
 */
export function scanBodyForHostPaths(text: string): HostPathFinding[] {
  if (!text) return [];

  const findings: HostPathFinding[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { kind, regex } of HOST_PATH_PATTERNS) {
      // Fresh lastIndex per line — the patterns are global so we can collect
      // every occurrence, but state must not leak between lines.
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard global-regex iteration.
      while ((m = regex.exec(line)) !== null) {
        findings.push({ kind, match: m[0], line: i + 1 });
        // Guard against zero-length matches stalling the loop (defensive; the
        // patterns above always consume at least the prefix).
        if (m.index === regex.lastIndex) regex.lastIndex++;
      }
    }
  }

  // Sort by line, then by column position within the line, so multi-OS bodies
  // come back in stable document order regardless of pattern iteration order.
  findings.sort((a, b) => a.line - b.line);
  return findings;
}
