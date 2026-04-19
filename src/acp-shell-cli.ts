#!/usr/bin/env bun
/**
 * am-acp-shell — Secondary binary that serves an ACP shim over stdio.
 *
 * Usage:
 *   am-acp-shell <agent-name>
 *
 * Agent names come from `BUILT_IN_SHIMS` in src/protocols/acp/shell-wrapper.ts.
 * A user configures an ACP consumer (am, claude-code, cursor, ...) to launch
 * `am-acp-shell aider` as the ACP endpoint; the shim speaks ACP upstream and
 * spawns `aider` downstream for each session/prompt.
 *
 * See ADR-0033 Phase B for scope and the security caveat (wrapped agents
 * inherit the trust posture of the underlying CLI).
 */

import { serveShimOnStdio } from "./protocols/acp/shell-wrapper";

async function main(): Promise<void> {
  const [, , agentName, ...rest] = process.argv;
  if (!agentName || agentName === "--help" || agentName === "-h") {
    process.stderr.write(
      "usage: am-acp-shell <agent-name>\n" +
        "\n" +
        "Serves an ACP shim on stdio that proxies prompts to the named agent's CLI.\n" +
        "Known agents: aider, amazon-q, cody (see ADR-0033 Phase B).\n" +
        "\n" +
        "Security: the wrapped CLI inherits the trust posture you configured\n" +
        "with `am agent enable-shim <agent-name>`. Shim wrappers auto-approve\n" +
        "tool use because the underlying CLI's --yes flag bypasses am's\n" +
        "permission UI. Only enable shims for agents you trust in your env.\n",
    );
    process.exit(agentName ? 0 : 1);
  }
  if (rest.length > 0) {
    process.stderr.write(`am-acp-shell: unexpected extra args: ${rest.join(" ")}\n`);
    process.exit(1);
  }
  const code = await serveShimOnStdio(agentName);
  process.exit(code);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `am-acp-shell: fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
