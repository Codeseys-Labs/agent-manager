/**
 * Security tests for the community adapter loader's checksum contract.
 *
 * Wave 2.A HIGH-5 fix: the loader must refuse to spawn an adapter without
 * a pinned checksum unless the source is `local:` (user's own code).
 *
 * These tests exercise `loadCommunityAdapters` end-to-end against a TOML
 * fixture so we catch regressions in the source-type branching too.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  killAllProxies,
  loadCommunityAdapters,
  verifyChecksum,
} from "../../../src/adapters/community/loader.ts";
import { type TestDir, createTestDir } from "../../helpers/tmp.ts";

const MOCK_ADAPTER = join(import.meta.dir, "mock-adapter.ts");

/**
 * Compute the sha256 of a file on disk and format as "sha256:<hex>".
 * Mirrors src/commands/adapter.ts::computeChecksum so test fixtures match.
 */
async function hashFile(path: string): Promise<string> {
  const data = await Bun.file(path).arrayBuffer();
  return `sha256:${createHash("sha256").update(Buffer.from(data)).digest("hex")}`;
}

describe("loadCommunityAdapters() checksum enforcement", () => {
  let dir: TestDir;

  beforeEach(async () => {
    dir = await createTestDir("am-loader-checksum-sec-");
    killAllProxies();
  });

  afterEach(async () => {
    killAllProxies();
    await dir.cleanup();
  });

  it("FAILS to load when checksum is absent and source is not local:", async () => {
    // No checksum field. Source is npm — a remote/untrusted origin.
    // Loader must refuse and surface a warning pointing the user at
    // `am adapter verify`.
    await dir.write(
      "adapters.toml",
      `[adapters.untrusted]
source = "npm:am-adapter-untrusted"
command = "/tmp/does-not-matter"
installed_at = "2026-04-16T10:00:00Z"
`,
    );

    const stderrSpy = spyOn(console, "error");
    const loaded = await loadCommunityAdapters(dir.path);

    expect(loaded.size).toBe(0);
    expect(stderrSpy).toHaveBeenCalled();
    const joined = stderrSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(joined).toContain("no checksum");
    expect(joined).toContain("am adapter verify");
    stderrSpy.mockRestore();
  });

  it("WARNS (and does not throw) from verifyChecksum when checksum is absent AND source is local:", async () => {
    // Local adapters are user-owned code under active development; re-pinning
    // the checksum on every edit would be noise. Calls verifyChecksum directly
    // to avoid the heavy proxy-spawn path.
    const stderrSpy = spyOn(console, "error");

    await verifyChecksum("mine", MOCK_ADAPTER, undefined, `local:${MOCK_ADAPTER}`);

    const joined = stderrSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(joined).toContain("local adapter");
    expect(joined).toContain("skipping integrity check");
    stderrSpy.mockRestore();
  });

  // These two tests call verifyChecksum() directly rather than going through
  // loadCommunityAdapters(), which would spawn a CommunityAdapterProxy and
  // wait 30s for the non-JSON-RPC shell script to time out. The full
  // end-to-end spawn chain is already covered by loader.test.ts::
  // loadCommunityAdapters() checksum integration.

  it("PASSES verifyChecksum when checksum matches the on-disk binary", async () => {
    const binaryPath = await dir.write("fake-adapter.sh", "#!/bin/sh\necho hi\n");
    const goodHash = await hashFile(binaryPath);

    // Should not throw.
    await verifyChecksum("pinned", binaryPath, goodHash, "npm:am-adapter-pinned");
  });

  it("THROWS from verifyChecksum when checksum does not match on-disk binary", async () => {
    const binaryPath = await dir.write("tampered-adapter.sh", "#!/bin/sh\necho tampered\n");
    const wrongHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    await expect(
      verifyChecksum("tampered", binaryPath, wrongHash, "npm:am-adapter-tampered"),
    ).rejects.toThrow(/checksum mismatch/);
  });
});
