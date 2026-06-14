import { describe, expect, test } from "bun:test";
import { scanBodyForHostPaths } from "@/core/portability.ts";

describe("scanBodyForHostPaths()", () => {
  test("flags a macOS /Users/<name>/ host-absolute path", () => {
    const findings = scanBodyForHostPaths("see /Users/baladita/.config/foo for details");
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("macos");
    expect(findings[0].match).toBe("/Users/baladita/");
  });

  test("flags a Linux /home/<name>/ host-absolute path", () => {
    const findings = scanBodyForHostPaths(
      "run /home/baladita/.local/share/uv/tools/hyperresearch/bin/hr",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("linux");
    expect(findings[0].match).toBe("/home/baladita/");
  });

  test("flags a Windows C:\\Users\\ host-absolute path", () => {
    const findings = scanBodyForHostPaths("located at C:\\Users\\baladita\\AppData\\foo");
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("windows");
    expect(findings[0].match).toBe("C:\\Users\\baladita\\");
  });

  test("records the 1-based line number of each finding", () => {
    const text = "line one\nline two\nrun /home/x/bin/tool\nline four";
    const findings = scanBodyForHostPaths(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);
  });

  test("returns empty for portable relative paths", () => {
    expect(scanBodyForHostPaths("use ./scripts/run.sh and ../shared/lib")).toEqual([]);
    expect(scanBodyForHostPaths("see docs/guide.md or src/core/foo.ts")).toEqual([]);
  });

  test("returns empty for a non-host /usr or /etc absolute path", () => {
    // System paths are portable across hosts; only per-user home dirs are flagged.
    expect(scanBodyForHostPaths("binary lives at /usr/local/bin/tool")).toEqual([]);
    expect(scanBodyForHostPaths("config at /etc/hosts")).toEqual([]);
  });

  test("returns empty for empty input", () => {
    expect(scanBodyForHostPaths("")).toEqual([]);
  });

  test("flags multiple distinct host paths in one body", () => {
    const text = "mac: /Users/alice/.config\nlinux: /home/bob/bin\nwin: C:\\Users\\carol\\Desktop";
    const findings = scanBodyForHostPaths(text);
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.kind).sort()).toEqual(["linux", "macos", "windows"]);
  });

  test("flags the real-world hyperresearch uv tools path on Linux", () => {
    const findings = scanBodyForHostPaths(
      "/home/baladita/.local/share/uv/tools/hyperresearch/lib/python3.12/site-packages/hr",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("linux");
    expect(findings[0].match).toBe("/home/baladita/");
  });
});
